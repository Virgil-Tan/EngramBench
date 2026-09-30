import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  assertFleetInvariants,
  assertNoSecrets,
  canonicalJson,
  percentile,
} from "../oracles/index.mjs";

export const V1_KEYS = [
  "deviceCommands",
  "deviceModels",
  "deviceReports",
  "deviceUpdates",
  "devices",
  "firmwareCampaigns",
  "firmwareImages",
];
export const FINAL_KEYS = [...V1_KEYS, "upgradePlans"].sort();
export const IMAGE_KEYS = [
  "compatibleFromVersions",
  "createdAt",
  "downloadPath",
  "firmwareImageId",
  "modelId",
  "sha256",
  "size",
  "version",
];
export const CAMPAIGN_KEYS = [
  "campaignId",
  "completedAt",
  "createdAt",
  "firmwareImageId",
  "maxParallel",
  "reportTimeoutSeconds",
  "sequence",
  "state",
  "targetCount",
  "targetDigest",
];
export const UPDATE_KEYS = [
  "campaignId",
  "currentCommandSequence",
  "deviceId",
  "deviceUpdateId",
  "installedDigest",
  "priorVersion",
  "state",
  "targetVersion",
];
export const COMMAND_KEYS = [
  "commandId",
  "commandToken",
  "createdAt",
  "deviceUpdateId",
  "expiresAt",
  "imageDigest",
  "sequence",
  "type",
];
export const REPORT_KEYS = [
  "commandId",
  "commandToken",
  "deviceId",
  "deviceUpdateId",
  "installedDigest",
  "outcome",
  "reportedAt",
  "sequence",
];
export const PLAN_KEYS = [
  "createdAt",
  "currentHopIndex",
  "deviceUpdateId",
  "hops",
  "pathDigest",
  "sourceVersion",
  "targetVersion",
];
const META = {
  "A-01": [
    "FF-F-IMAGE",
    "Register valid and invalid Firmware Images through public HTTP",
    "Assert canonical version, bytes digest, size, path and immutable uniqueness",
  ],
  "A-02": [
    "FF-F-WAVE",
    "Create a selected Campaign then progress its captured Device wave",
    "Assert target digest, frozen membership, campaign state and Device-level capacity",
  ],
  "A-03": [
    "FF-F-REPORT",
    "Poll ordered commands and submit success, replay, gap, stale and failure reports",
    "Assert exact command token and digest gates plus one rollback",
  ],
  "A-04": [
    "FF-F-PATH",
    "Create direct, multi-hop, too-long and unavailable Upgrade Plans",
    "Recompute shortest deterministic path and RFC 8785 path digest independently",
  ],
  "A-05": [
    "FF-F-HOP-RETRY",
    "Fail a later hop, rollback locally and call explicit retry",
    "Assert earlier success remains, token is fresh and global sequence continues",
  ],
  "B-01": [
    "FF-F-CREATE-REPLAY",
    "Race Campaign creation through two APIs, loss and restart",
    "Assert one complete Campaign graph or no graph for an unavailable target",
  ],
  "B-02": [
    "FF-F-ACTIVE-RACE",
    "Race two Campaigns and the last maxParallel slot",
    "Assert one active Update and Command per Device with stable loser",
  ],
  "B-03": [
    "FF-F-REPORT-RACE",
    "Race replay, rewritten sequence, gap, stale token and wrong digest",
    "Assert exact validation precedence and one report effect",
  ],
  "B-04": [
    "FF-F-ROLLBACK-RACE",
    "Race explicit failure, timeout and cancellation at barriers",
    "Assert exactly one captured rollback and coherent member terminal states",
  ],
  "B-05": [
    "FF-F-AGGREGATE-RACE",
    "Submit forty final-hop and retry mutations across Devices",
    "Assert monotonic hop attempts and Campaign terminal only after all members",
  ],
  "C-01": [
    "FF-F-DELIVERY-CRASH",
    "SIGKILL delivery workers at claimed and before-commit",
    "Assert stable pollable Command identity and fenced lease recovery",
  ],
  "C-02": [
    "FF-F-ROLLBACK-CRASH",
    "SIGKILL timeout and rollback workers at effect-complete",
    "Assert late reports cannot install and rollback restores captured firmware once",
  ],
  "C-03": [
    "FF-F-HOP-CRASH",
    "Crash around VERIFY commit and next-hop publication",
    "Assert no repeated committed hop and contiguous global Command sequence",
  ],
  "C-04": [
    "FF-F-OUTBOX-ACK",
    "Lose event ACK and SIGKILL dispatcher after response",
    "Assert stable event identity, semantic body and aggregate order",
  ],
  "D-01": [
    "FF-F-V1-CHROMIUM",
    "Complete Image, Campaign, report, cancel and rollback through visible controls",
    "Assert browser state survives refresh and matches public snapshot",
  ],
  "D-02": [
    "FF-F-PATH-CHROMIUM",
    "Inspect multi-hop plan, fail a later attempt and retry visibly",
    "Assert UI path, hop, attempt and sequence agree with public API",
  ],
  "D-03": [
    "FF-F-OPENAPI-SNAPSHOT",
    "Compare OpenAPI exact paths with a FINAL point-in-time snapshot",
    "Assert UpgradePlan union and diagnose only unpublished DeviceUpdate extension",
  ],
  "D-04": [
    "FF-F-LINEAGE",
    "Trace Image through Plan, Commands, Reports, install and Events",
    "Assert all public identities, digests, versions and sequences close",
  ],
  "E-01": [
    "FF-F-V1-MIGRATION",
    "Upgrade a populated V1 checkpoint with leased Work and saved replay",
    "Assert one-hop Plans without changing any V1 identity or bytes",
  ],
  "E-02": [
    "FF-F-PERF-POLL",
    "Run fixed 64-client Command poll workload for 10s plus 60s",
    "Assert 50/50 response mix, throughput, p95 and post-load authority",
  ],
  "E-03": [
    "FF-F-PERF-REPORT",
    "Run fixed one-report fresh/replay workload for 10s plus 60s",
    "Assert exactly half replay, throughput, p95 and no second effect",
  ],
  "E-04": [
    "FF-F-PERF-RECOVERY",
    "Drain one hundred thousand pending Command Work after two kills",
    "Assert formal timer, unique pollable identities and maxParallel closure",
  ],
};
export function defineCase(id, run) {
  const [fixtureFamily, action, oracle] = META[id] ?? [];
  if (!fixtureFamily) throw new Error(`unknown ${id}`);
  return Object.freeze({
    id,
    taskId: "firmwarefleet",
    fixtureFamily,
    action,
    oracle,
    async run(ctx) {
      return run(ctx);
    },
  });
}
export function guardedCase(id, caps, run) {
  return defineCase(id, async (ctx) => {
    try {
      return await run(ctx);
    } catch (error) {
      error.hardCapIds = [...new Set([...(error.hardCapIds ?? []), ...caps])];
      throw error;
    }
  });
}
export async function importBundle(ctx, bundle, options = {}) {
  const directory = ctx.tempPath(`bundle-${ctx.key(options.label ?? "seed")}`);
  await mkdir(directory, { recursive: true });
  for (const asset of bundle.assets ?? []) {
    const path = join(directory, asset.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, asset.bytes);
  }
  const path = join(directory, "seed.json");
  await writeFile(path, JSON.stringify(bundle.seed));
  return ctx.seedFile(path, {
    timeoutMs: options.timeoutMs ?? 600_000,
    allowFailure: options.allowFailure ?? false,
    workspace: options.workspace,
  });
}
export async function prepare(
  ctx,
  bundle,
  { build = false, migrate = true } = {},
) {
  if (build) {
    await ctx.command("npm", ["ci", "--no-audit", "--no-fund"], {
      timeoutMs: 600_000,
    });
    await ctx.npm("build", [], { timeoutMs: 600_000 });
  }
  if (migrate) await ctx.migrate({ timeoutMs: 600_000 });
  if (bundle) {
    const result = await importBundle(ctx, bundle);
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  }
  return ctx.startApi();
}
export function requireStatus(response, expected, label = "request") {
  const statuses = Array.isArray(expected) ? expected : [expected];
  assert.ok(
    statuses.includes(response.status),
    `${label}: expected ${statuses}, got ${response.status}: ${response.text}`,
  );
  assert.notEqual(response.json, undefined, `${label}: non-JSON response`);
  return response.json;
}
export function exactKeys(value, keys, label) {
  assert.deepEqual(
    Object.keys(value).sort(),
    [...keys].sort(),
    `${label} shape`,
  );
}
export function assertError(response, status, code) {
  const body = requireStatus(response, status, code);
  exactKeys(body, ["error"], `${code} envelope`);
  exactKeys(body.error, ["code", "details", "message"], `${code} error`);
  assert.equal(body.error.code, code);
  assert.ok(
    body.error.details &&
      typeof body.error.details === "object" &&
      !Array.isArray(body.error.details),
  );
}
export function stableSnapshot(snapshot) {
  const { asOf: _asOf, ...stable } = snapshot;
  return stable;
}
export function byId(items, key, id, label = key) {
  const item = items.find((value) => value[key] === id);
  assert.ok(item, `${label} ${id} missing`);
  return item;
}
export function clone(value) {
  return structuredClone(value);
}
export function semantic(left, right) {
  assert.equal(left.status, right.status);
  assert.equal(canonicalJson(left.json), canonicalJson(right.json));
}
export function assertSnapshot(snapshot, { final = true } = {}) {
  exactKeys(snapshot, ["asOf", "events", "resources", "work"], "snapshot");
  assert.deepEqual(
    Object.keys(snapshot.resources).sort(),
    final ? FINAL_KEYS : [...V1_KEYS].sort(),
  );
  for (const value of Object.values(snapshot.resources))
    assert.ok(Array.isArray(value));
  assertFleetInvariants(snapshot);
  assertNoSecrets(snapshot);
  for (const work of snapshot.work) {
    assert.ok(
      ["COMMAND_DELIVERY", "REPORT_TIMEOUT", "ROLLBACK"].includes(work.kind),
    );
    assert.equal(
      work.terminal,
      ["SUCCEEDED", "FAILED", "CANCELLED"].includes(work.state),
    );
    assert.equal(
      work.state === "LEASED",
      work.leaseOwner !== null && work.leaseExpiresAt !== null,
    );
  }
  return snapshot;
}
export async function registerImage(ctx, api, key, body, expected = 201) {
  const response = await ctx.mutate(
    api.baseUrl,
    "/api/v1/firmware-images",
    ctx.key(key),
    body,
  );
  requireStatus(response, expected, key);
  return response;
}
export async function createCampaign(ctx, api, key, body, expected = 202) {
  const response = await ctx.mutate(
    api.baseUrl,
    "/api/v1/firmware-campaigns",
    ctx.key(key),
    body,
  );
  requireStatus(response, expected, key);
  return response;
}
export async function cancelCampaign(
  ctx,
  api,
  key,
  id,
  reason = "evaluator cancellation",
  expected = 200,
) {
  const response = await ctx.mutate(
    api.baseUrl,
    `/api/v1/firmware-campaigns/${id}/cancel`,
    ctx.key(key),
    { reason },
  );
  requireStatus(response, expected, key);
  return response;
}
export async function poll(
  ctx,
  api,
  key,
  deviceId,
  lastCommandSequence,
  expected = 200,
) {
  const response = await ctx.mutate(
    api.baseUrl,
    `/api/v1/devices/${deviceId}/commands/poll`,
    ctx.key(key),
    { lastCommandSequence },
  );
  requireStatus(response, expected, key);
  return response;
}
export async function report(ctx, api, key, deviceId, body, expected = 200) {
  const response = await ctx.mutate(
    api.baseUrl,
    `/api/v1/devices/${deviceId}/report-batches`,
    ctx.key(key),
    body,
  );
  requireStatus(response, expected, key);
  return response;
}
export async function plan(ctx, api, updateId) {
  const response = await ctx.request(
    api.baseUrl,
    `/api/v1/device-updates/${updateId}/upgrade-plan`,
  );
  return requireStatus(response, 200, "upgrade plan");
}
export async function retry(ctx, api, key, updateId, body, expected = 200) {
  const response = await ctx.mutate(
    api.baseUrl,
    `/api/v1/device-updates/${updateId}/retry`,
    ctx.key(key),
    body,
  );
  requireStatus(response, expected, key);
  return response;
}
export async function waitSnapshot(ctx, api, predicate, label, options = {}) {
  return ctx.waitFor(
    async () => {
      const snapshot = await ctx.snapshot(api.baseUrl, {
        timeoutMs: options.requestTimeoutMs,
      });
      return predicate(snapshot) ? snapshot : undefined;
    },
    {
      timeoutMs: options.timeoutMs ?? 45_000,
      intervalMs: options.intervalMs ?? 75,
      label,
      processes: options.processes ?? [],
    },
  );
}
export async function waitCommand(
  ctx,
  api,
  deviceId,
  lastSequence,
  label,
  options = {},
) {
  return ctx.waitFor(
    async () => {
      const response = await poll(
        ctx,
        api,
        `${label}-poll-${lastSequence}`,
        deviceId,
        lastSequence,
      );
      return response.json.status === "COMMAND"
        ? response.json.command
        : undefined;
    },
    {
      timeoutMs: options.timeoutMs ?? 30_000,
      intervalMs: 75,
      label: `${label} command`,
      processes: options.processes ?? [],
    },
  );
}
export async function submitCommand(
  ctx,
  api,
  deviceId,
  command,
  label,
  {
    outcome = "SUCCEEDED",
    installedDigest = command.type === "VERIFY" ? command.imageDigest : null,
    token = command.commandToken,
    sequence = command.sequence,
  } = {},
) {
  return report(ctx, api, `${label}-report-${sequence}`, deviceId, {
    firstSequence: sequence,
    reports: [
      {
        sequence,
        commandId: command.commandId,
        commandToken: token,
        outcome,
        installedDigest,
      },
    ],
  });
}
export async function completeForwardFlow(
  ctx,
  api,
  deviceId,
  label,
  { worker, failType } = {},
) {
  const commands = [];
  let last = 0;
  for (const type of ["DOWNLOAD", "INSTALL", "VERIFY"]) {
    const command = await waitCommand(
      ctx,
      api,
      deviceId,
      last,
      `${label}-${type}`,
      { processes: worker ? [worker] : [] },
    );
    assert.equal(command.type, type);
    commands.push(command);
    await submitCommand(ctx, api, deviceId, command, `${label}-${type}`, {
      outcome: failType === type ? "FAILED" : "SUCCEEDED",
    });
    last = command.sequence;
    if (failType === type) break;
  }
  return commands;
}
export async function visibleUi(ctx, api, operation) {
  const chromium = await ctx.loadChromium();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(api.baseUrl, { waitUntil: "networkidle" });
    await operation(page);
  } finally {
    await browser.close();
  }
}
export async function clickVisible(page, names) {
  for (const name of Array.isArray(names) ? names : [names]) {
    const control = page
      .getByRole("button", { name, exact: false })
      .or(page.getByRole("link", { name, exact: false }))
      .first();
    if (await control.count()) {
      await control.click();
      return;
    }
  }
  throw new Error("visible control missing");
}
export async function fillVisible(page, label, value) {
  const control = page.getByLabel(label, { exact: false }).first();
  assert.ok(await control.count(), `label missing ${label}`);
  await control.fill(String(value));
}
export async function closedLoop({
  clients,
  warmupMs,
  measureMs,
  operation,
  betweenWindows,
}) {
  const window = async (durationMs, collect) => {
    const deadline = performance.now() + durationMs,
      latencies = [];
    let completed = 0,
      unexpected5xx = 0,
      index = 0;
    await Promise.all(
      Array.from({ length: clients }, async (_, client) => {
        while (performance.now() < deadline) {
          const ordinal = index++,
            started = performance.now(),
            response = await operation({ client, index: ordinal, collect });
          if (collect) {
            completed += 1;
            latencies.push(performance.now() - started);
            if (response.status >= 500) unexpected5xx += 1;
          }
        }
      }),
    );
    return {
      completed,
      latencies,
      unexpected5xx,
      elapsedSeconds: durationMs / 1000,
    };
  };
  await window(warmupMs, false);
  await betweenWindows?.();
  const measured = await window(measureMs, true);
  return {
    ...measured,
    throughput: measured.completed / measured.elapsedSeconds,
    p95: percentile(measured.latencies, 0.95),
  };
}
export function result(...evidence) {
  return { evidence };
}
