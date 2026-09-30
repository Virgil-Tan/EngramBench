import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadAdapter } from "./adapters.mjs";
import { assertPerformanceScenarioIds, performanceMode } from "./performance-runtime.mjs";

const CASES = {
  "H-01": cleanBuildAndBoot,
  "H-02": contractAndBrowserBaseline,
  "H-13": projectGateAudit,
};

const PUBLISHED_PROJECT_GATES = [
  "test:unit",
  "test:integration",
  "test:e2e",
  "test:concurrency",
  "test:recovery",
  "test:all",
  "test:perf",
];

export async function runCase(options) {
  const adapter = options.adapter ?? await loadAdapter(options.task);
  const operation = CASES[options.case] ?? adapter.cases[options.case];
  if (!operation) throw new Error(`${options.task}/${options.case} has no Harness assertion`);
  if (options.case === "H-12") {
    const { nonScoring } = performanceMode();
    assert.ok(!nonScoring || options.allowNonScoring === true, "BENCH_PERF_SCALE must equal 1 for scoring runs");
  }
  const startedAt = Date.now();
  const assertions = [];
  let details;
  await withIsolatedDatabase({ ...options, adapter }, async (context) => {
    details = await operation(context, assertions);
  });
  if (options.case === "H-12") {
    details = validatePerformanceResult({
      details,
      adapter,
      contract: options.contract,
      allowNonScoring: options.allowNonScoring === true,
    });
  }
  return {
    schemaVersion: 1,
    taskId: options.task,
    caseId: options.case,
    status: "passed",
    durationMs: Date.now() - startedAt,
    assertions,
    ...(details ?? {}),
  };
}

export function validatePerformanceResult({ details, adapter, contract, allowNonScoring = false }) {
  const { scale, nonScoring } = performanceMode();
  assert.ok(!nonScoring || allowNonScoring, "BENCH_PERF_SCALE must equal 1 for scoring runs");

  const declared = assertPerformanceScenarioIds(adapter?.performanceScenarioIds, "adapter performanceScenarioIds");
  assert.ok(Array.isArray(contract?.perfScenarios), "contract perfScenarios must be an array");
  const contracted = assertPerformanceScenarioIds(
    contract.perfScenarios.map(({ id }) => id),
    "contract perfScenarios",
  );
  assert.deepEqual(declared, contracted, "adapter performance scenarios must exactly match the task contract");

  assert.ok(Array.isArray(details?.metrics), "H-12 must return metrics");
  const actual = assertPerformanceScenarioIds(
    details.metrics.map((metric) => metric?.scenarioId),
    "H-12 metric scenarioIds",
  );
  assert.deepEqual(actual, contracted, "H-12 metrics must exactly match the task contract");
  return { ...details, performanceScale: scale, nonScoring };
}

async function cleanBuildAndBoot(context, assertions) {
  const packageJson = await readPackage(context.workspace);
  requireScripts(packageJson, ["build", "db:migrate", "db:seed", "start:api", "start:worker", "start:dispatcher"]);
  assertions.push("published lifecycle scripts exist");
  await installDependencies(context);
  await command(context, "npm", ["run", "build"], { timeoutMs: 600_000 });
  await command(context, "npm", ["run", "db:migrate"]);
  await command(context, "npm", ["run", "db:migrate"]);
  assertions.push("clean install, build, and repeatable migration pass");

  const seedPath = join(context.temporary, "seed.json");
  await writeFile(seedPath, JSON.stringify(emptySeed(context.contract)));
  await command(context, "npm", ["run", "db:seed", "--", "--file", seedPath]);
  await command(context, "npm", ["run", "db:seed", "--", "--file", seedPath]);
  assertions.push("empty valid seed and exact replay are atomic");

  const invalidPath = join(context.temporary, "invalid-seed.json");
  await writeFile(invalidPath, JSON.stringify({ ...emptySeed(context.contract), hiddenUnknownMember: [] }));
  const invalid = await command(context, "npm", ["run", "db:seed", "--", "--file", invalidPath], { allowFailure: true });
  assert.notEqual(invalid.exitCode, 0, "seed with an unknown member must fail");
  assertions.push("strict seed rejects unknown members");

  const api = await startRole(context, "start:api", { PORT: "3100" });
  const worker = await startRole(context, "start:worker", {});
  const dispatcher = await startRole(context, "start:dispatcher", { WEBHOOK_URL: "http://127.0.0.1:1/events" });
  await waitForHealth(api, ["/healthz", "/api/health"]);
  assert.equal(worker.child.exitCode, null, `worker exited early: ${worker.logs}`);
  assert.equal(dispatcher.child.exitCode, null, `dispatcher exited early: ${dispatcher.logs}`);
  assertions.push("production API, worker, and dispatcher boot as independent processes");
}

async function contractAndBrowserBaseline(context, assertions) {
  const packageJson = await readPackage(context.workspace);
  requireScripts(packageJson, ["build", "db:migrate", "start:api"]);
  await installDependencies(context);
  await command(context, "npm", ["run", "build"], { timeoutMs: 600_000 });
  await command(context, "npm", ["run", "db:migrate"]);
  const api = await startRole(context, "start:api", { PORT: "3101" });
  await waitForHealth(api, ["/healthz", "/api/health"]);

  const openapiResponse = await http(api.baseUrl, "/openapi.json");
  assert.equal(openapiResponse.status, 200);
  const openapi = JSON.parse(openapiResponse.body);
  assert.match(openapi.openapi, /^3\.1(?:\.|$)/u);
  for (const route of context.contract.publicPaths) {
    const openapiPath = route.replace(/\?.*$/u, "").replace(/:([A-Za-z][A-Za-z0-9_]*)/gu, "{$1}");
    assert.ok(openapi.paths?.[openapiPath], `OpenAPI is missing ${openapiPath}`);
  }
  assertions.push("OpenAPI 3.1 contains every published route");

  const browser = await command(context, "chromium", [
    "--headless", "--no-sandbox", "--disable-gpu", "--dump-dom", `${api.baseUrl}/`,
  ], { timeoutMs: 120_000 });
  assert.match(browser.stdout, /<html|<!doctype/iu);
  assert.doesNotMatch(browser.stdout, /id=["']root["']>\s*<\/div>/iu);
  assertions.push("production UI renders through system Chromium");
}

async function projectGateAudit(context, assertions) {
  const packageJson = await readPackage(context.workspace);
  const scripts = auditProjectGateScripts(packageJson);
  assertions.push("all published project gates are present and non-placeholder");

  await installDependencies(context);
  for (const name of scripts.filter((name) => name !== "test:perf")) {
    await command(context, "npm", ["run", name], { timeoutMs: 1_200_000 });
  }
  assertions.push("every non-performance project-owned gate passes from a clean install");
}

export function auditProjectGateScripts(packageJson) {
  requireScripts(packageJson, PUBLISHED_PROJECT_GATES);
  for (const name of PUBLISHED_PROJECT_GATES) {
    const value = packageJson.scripts[name];
    assert.doesNotMatch(value, /(?:^|[;&|]\s*)(?:true|exit\s+0)(?:\s|$)|placeholder|not implemented/iu, `${name} is a placeholder`);
  }
  return [...PUBLISHED_PROJECT_GATES];
}

async function withIsolatedDatabase(options, operation) {
  const database = `hb_${options.task.replaceAll("-", "_").slice(0, 24)}_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 6)}`;
  const temporary = await mkdtemp(join(tmpdir(), `hard-bench-${options.task}-`));
  const context = {
    ...options,
    database,
    databaseUrl: `postgresql://postgres@127.0.0.1:5432/${database}`,
    temporary,
    processes: [],
    servers: [],
  };
  attachScenarioMethods(context);
  try {
    await rawCommand(options.workspace, "createdb", ["-h", "127.0.0.1", "-U", "postgres", database], {}, 60_000);
    await operation(context);
  } finally {
    for (const processRecord of context.processes.reverse()) await stop(processRecord);
    for (const serverRecord of context.servers.reverse()) await closeServer(serverRecord);
    await rawCommand(options.workspace, "dropdb", ["-h", "127.0.0.1", "-U", "postgres", "--if-exists", "--force", database], {}, 60_000, true).catch(() => undefined);
    await rm(temporary, { recursive: true, force: true });
  }
}

function attachScenarioMethods(context) {
  context.prepare = async (workspace = context.workspace) => {
    await rawCommand(workspace, "npm", ["install", "--no-audit", "--no-fund"], environment(context), 600_000);
    await rawCommand(workspace, "npm", ["run", "build"], environment(context), 600_000);
    await rawCommand(workspace, "npm", ["run", "db:migrate"], environment(context), 300_000);
  };
  context.copyV1Workspace = async () => {
    const source = process.env.BENCH_V1_SNAPSHOT;
    assert.ok(source, "BENCH_V1_SNAPSHOT is required for H-09");
    const target = join(context.temporary, "v1-workspace");
    await cp(source, target, { recursive: true });
    return target;
  };
  context.seed = async (value, workspace = context.workspace) => {
    const path = join(context.temporary, `seed-${randomUUID()}.json`);
    await writeFile(path, JSON.stringify(value));
    return rawCommand(workspace, "npm", ["run", "db:seed", "--", "--file", path], environment(context), 600_000, true);
  };
  context.seedFile = (path, workspace = context.workspace) => rawCommand(
    workspace,
    "npm",
    ["run", "db:seed", "--", "--file", path],
    environment(context),
    1_200_000,
    true,
  );
  context.startApi = async (workspace = context.workspace) => {
    const port = await freePort();
    const api = await startRole(context, "start:api", { PORT: String(port) }, workspace);
    await waitForHealth(api, ["/healthz", "/api/health"]);
    return api;
  };
  context.startWorker = (extraEnv = {}, workspace = context.workspace) => startRole(context, "start:worker", extraEnv, workspace);
  context.startDispatcher = (webhookUrl, extraEnv = {}, workspace = context.workspace) => startRole(context, "start:dispatcher", { WEBHOOK_URL: webhookUrl, ...extraEnv }, workspace);
  context.stop = stop;
  context.request = async (baseUrl, path, options = {}) => {
    const headers = { ...(options.headers ?? {}) };
    let body = options.raw;
    if (Object.hasOwn(options, "json")) {
      headers["content-type"] ??= "application/json";
      body = JSON.stringify(options.json);
    }
    const startedAt = performance.now();
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
    const responseBody = options.binary ? Buffer.from(await response.arrayBuffer()) : await response.text();
    const text = options.binary ? undefined : responseBody;
    let json;
    try { json = JSON.parse(text); } catch {}
    return { status: response.status, headers: response.headers, text, body: options.binary ? responseBody : undefined, json, durationMs: performance.now() - startedAt };
  };
  context.mutate = (baseUrl, path, key, json = {}, method = "POST") => context.request(baseUrl, path, {
    method,
    headers: {
      "idempotency-key": key,
      ...(path.startsWith("/api/v1/admin/") ? { authorization: `Bearer ${context.task}-hidden-admin` } : {}),
    },
    json,
  });
  context.snapshot = async (baseUrl) => {
    const response = await context.request(baseUrl, "/api/v1/verification-snapshot", {
      headers: { authorization: `Bearer ${context.task}-hidden-admin` },
    });
    assert.equal(response.status, 200, `verification snapshot returned ${response.status}: ${response.text}`);
    return response.json;
  };
  context.waitFor = async (predicate, { timeoutMs = 30_000, intervalMs = 50, label = "condition", children = [] } = {}) => {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
      for (const child of children) {
        if (child.child.exitCode !== null) throw new Error(`${child.script} exited before ${label}: ${child.logs}`);
      }
      try {
        const result = await predicate();
        if (result) return result;
      } catch (error) { lastError = error; }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
  };
  context.concurrent = async (values, concurrency, operation) => {
    let next = 0;
    const results = new Array(values.length);
    await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (next < values.length) {
        const index = next++;
        results[index] = await operation(values[index], index);
      }
    }));
    return results;
  };
  context.receiver = (behavior) => startReceiver(context, behavior);
  context.responseShield = (upstream) => startResponseShield(context, upstream);
  context.resetDatabase = async () => {
    for (const processRecord of context.processes.reverse()) await stop(processRecord);
    context.processes.length = 0;
    for (const serverRecord of context.servers.reverse()) await closeServer(serverRecord);
    context.servers.length = 0;
    await rawCommand(context.workspace, "dropdb", ["-h", "127.0.0.1", "-U", "postgres", "--if-exists", "--force", context.database], {}, 60_000, true);
    context.database = `hb_${context.task.replaceAll("-", "_").slice(0, 24)}_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 6)}`;
    context.databaseUrl = `postgresql://postgres@127.0.0.1:5432/${context.database}`;
    await rm(join(context.temporary, "managed"), { recursive: true, force: true });
    await rawCommand(context.workspace, "createdb", ["-h", "127.0.0.1", "-U", "postgres", context.database], {}, 60_000);
  };
  context.equal = (actual, expected, label) => assert.deepEqual(actual, expected, label);
  context.ok = (condition, label) => assert.ok(condition, label);
  context.canonical = canonicalJson;
  context.rssBytes = async (processRecord) => {
    const status = await readFile(`/proc/${processRecord.pid}/status`, "utf8");
    const kib = Number(status.match(/^VmRSS:\s+(\d+)\s+kB$/mu)?.[1]);
    assert.ok(Number.isFinite(kib), `cannot read RSS for PID ${processRecord.pid}`);
    return kib * 1024;
  };
}

async function command(context, executable, args, options = {}) {
  return rawCommand(context.workspace, executable, args, environment(context), options.timeoutMs ?? 300_000, options.allowFailure ?? false);
}

function installDependencies(context) {
  return command(context, "npm", ["install", "--no-audit", "--no-fund"], { timeoutMs: 600_000 });
}

async function rawCommand(cwd, executable, args, env, timeoutMs, allowFailure = false) {
  const child = spawn(executable, args, { cwd, env: { ...safeProcessEnvironment(), ...env }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-256_000); });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-256_000); });
  const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, timeoutMs);
  const [exitCode, signal] = await once(child, "exit");
  clearTimeout(timer);
  const result = { exitCode, signal, stdout, stderr };
  if (!allowFailure && exitCode !== 0) throw new Error(`${executable} exited ${exitCode ?? signal}: ${stderr || stdout}`);
  return result;
}

async function startRole(context, script, extraEnv, workspace = context.workspace) {
  const child = spawn("npm", ["run", script], {
    cwd: workspace,
    env: { ...safeProcessEnvironment(), ...environment(context), ...extraEnv },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const record = { child, pid: child.pid, script, logs: "", baseUrl: extraEnv.PORT ? `http://127.0.0.1:${extraEnv.PORT}` : undefined };
  const append = (chunk) => { record.logs = `${record.logs}${chunk}`.slice(-128_000); };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  context.processes.push(record);
  return record;
}

async function stop(record, signal = "SIGTERM") {
  if (record.child.exitCode !== null) return;
  try { process.kill(-record.pid, signal); } catch { return; }
  await Promise.race([once(record.child, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (record.child.exitCode === null) try { process.kill(-record.pid, "SIGKILL"); } catch {}
}

async function freePort() {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  assert.ok(port > 0);
  return port;
}

async function startReceiver(context, behavior = () => ({ status: 204 })) {
  const ledger = [];
  const sockets = new Set();
  const server = createServer(async (incoming, outgoing) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    let json;
    try { json = JSON.parse(raw); } catch {}
    const entry = { attempt: ledger.length + 1, headers: { ...incoming.headers }, raw, json, acknowledged: false };
    ledger.push(entry);
    const selected = await behavior(entry, ledger) ?? { status: 204 };
    entry.responseStatus = selected.status ?? 204;
    if (selected.delayMs) await new Promise((resolve) => setTimeout(resolve, selected.delayMs));
    if (!outgoing.destroyed) {
      outgoing.once("finish", () => { entry.acknowledged = true; });
      outgoing.writeHead(entry.responseStatus);
      outgoing.end();
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const record = { server, sockets, ledger, url: `http://127.0.0.1:${address.port}/events` };
  context.servers.push(record);
  return record;
}

async function startResponseShield(context, upstreamBaseUrl) {
  const captures = [];
  const sockets = new Set();
  let dropNext = false;
  const server = createServer((incoming, outgoing) => {
    const requestChunks = [];
    incoming.on("data", (chunk) => requestChunks.push(Buffer.from(chunk)));
    incoming.on("end", () => {
      const body = Buffer.concat(requestChunks);
      const upstream = new URL(incoming.url ?? "/", upstreamBaseUrl);
      const proxy = request(upstream, { method: incoming.method, headers: { ...incoming.headers, host: upstream.host } }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          const responseBody = Buffer.concat(chunks);
          captures.push({ status: response.statusCode, body: responseBody.toString("utf8") });
          if (dropNext && incoming.method !== "GET") {
            dropNext = false;
            outgoing.destroy();
          } else {
            outgoing.writeHead(response.statusCode ?? 502, response.headers);
            outgoing.end(responseBody);
          }
        });
      });
      proxy.on("error", () => outgoing.destroy());
      proxy.end(body);
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const record = {
    server,
    sockets,
    captures,
    baseUrl: `http://127.0.0.1:${address.port}`,
    dropNextMutation() { dropNext = true; },
  };
  context.servers.push(record);
  return record;
}

async function closeServer(record) {
  for (const socket of record.sockets) socket.destroy();
  serverClose(record.server);
  await Promise.race([once(record.server, "close"), new Promise((resolve) => setTimeout(resolve, 2_000))]);
}

function serverClose(server) {
  try { server.close(); } catch {}
}

async function waitForHealth(api, paths) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (api.child.exitCode !== null) throw new Error(`API exited before health: ${api.logs}`);
    for (const path of paths) {
      const response = await http(api.baseUrl, path).catch(() => undefined);
      if (response?.status === 200) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`API health timed out: ${api.logs}`);
}

function http(baseUrl, path) {
  return new Promise((resolve, reject) => {
    const target = new URL(path, baseUrl);
    const req = request(target, { method: "GET", timeout: 5_000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.end();
  });
}

function environment(context) {
  return {
    DATABASE_URL: context.databaseUrl,
    TEST_DATABASE_URL: context.databaseUrl,
    ADMIN_TOKEN: `${context.task}-hidden-admin`,
    MANAGED_DATA_ROOT: join(context.temporary, "managed"),
    WORK_LEASE_SECONDS: "3",
    TEST_BARRIER_URL: "",
    TEST_BARRIER_TOKEN: "",
  };
}

function safeProcessEnvironment() {
  const allowed = ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "TZ", "NODE_OPTIONS"];
  return Object.fromEntries(allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
}

async function readPackage(workspace) {
  return JSON.parse(await readFile(join(workspace, "package.json"), "utf8"));
}

function requireScripts(packageJson, scripts) {
  for (const script of scripts) assert.equal(typeof packageJson.scripts?.[script], "string", `missing npm script ${script}`);
}

function emptySeed(contract) {
  return Object.fromEntries([
    ["schemaVersion", 1],
    ["seedVersion", "hidden-empty-v1"],
    ...contract.seedKeys.map((key) => [key, []]),
  ]);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
