import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import { createFixtureFactory } from "../fixtures/index.mjs";
import { CaseExcluded, CaseFailure } from "./execution.mjs";

const sharedRoot = process.env.FRONTAL_V2_SHARED_ROOT_URL
  ?? new URL("../../../../../src/task-evaluator-v2/", import.meta.url).href;
const shared = await import(new URL("runtime.mjs", sharedRoot));

const baseRuntime = shared.createCaseRuntime({
  taskSlug: "parcelflow",
  databasePrefix: "pf",
  snapshotPath: "/api/health",
  createFixtureFactory,
  adaptCompatibilityResponse: (_adapter, { json }) => json,
  assertCompatibilityAdapter: () => {},
  validateBarrierPayload: () => false,
});

function optionsObject(value) {
  if (typeof value === "string") return { workspace: value };
  return value ?? {};
}

function assertionOptions(value = {}) {
  return {
    failureCodeSuffix: value.failureCodeSuffix ?? "ASSERTION_FAILED",
    hardCapIds: value.hardCapIds ?? [],
  };
}

function failAssertion(label, error, options) {
  const failure = new CaseFailure(`${label}: ${error.message ?? String(error)}`, assertionOptions(options));
  failure.cause = error;
  throw failure;
}

function attachParcelFlowContext(context) {
  context.evidence = [];
  context.mark = (event, fields = {}) => {
    context.evidence.push({ ordinal: context.evidence.length + 1, event, ...fields });
  };
  context.pass = (details = {}) => ({
    ...details,
    status: "passed",
    evidence: [...context.evidence, ...(details.evidence ?? [])],
  });
  context.block = (reason) => { throw new CaseExcluded(reason); };
  context.fail = (message, failureCodeSuffix = "ASSERTION_FAILED", hardCapIds = []) => {
    throw new CaseFailure(message, { failureCodeSuffix, hardCapIds });
  };
  context.equal = (actual, expected, label = "values are equal", options = {}) => {
    try { assert.deepStrictEqual(actual, expected); }
    catch (error) { failAssertion(label, error, options); }
  };
  context.ok = (condition, label = "condition is truthy", options = {}) => {
    try { assert.ok(condition); }
    catch (error) { failAssertion(label, error, options); }
  };

  context.seedFile = (path, commandOptions = {}) => {
    const normalized = optionsObject(commandOptions);
    return context.npm("seed", ["--file", resolve(path)], {
      timeoutMs: 600_000,
      allowFailure: true,
      ...normalized,
    });
  };

  context.startApi = async (roleOptions = {}) => {
    const normalized = optionsObject(roleOptions);
    const port = normalized.port ?? await shared.freePort();
    const record = await context.startProcess("api", "start", {
      ...normalized,
      env: { PORT: port, ...(normalized.env ?? {}) },
    });
    record.port = port;
    record.baseUrl = `http://127.0.0.1:${port}`;
    try {
      await context.waitFor(async () => {
        const response = await context.request(record.baseUrl, normalized.healthPath ?? "/api/health", { timeoutMs: 1_000 }).catch(() => undefined);
        return response?.status === 200 && response.json?.status === "ok";
      }, {
        timeoutMs: normalized.healthTimeoutMs ?? 30_000,
        intervalMs: 50,
        label: "ParcelFlow API health",
        processes: [record],
      });
    } catch (cause) {
      throw new shared.CandidateResponseError(`ParcelFlow API did not become healthy; logs: ${record.logs}`, { cause, record });
    }
    return record;
  };

  context.startWorker = (roleOptions = {}) => {
    const normalized = optionsObject(roleOptions);
    return context.startProcess("worker", "worker", {
      ...normalized,
      env: {
        WORKER_POLL_INTERVAL_MS: "10",
        DISPATCH_TASK_TIMEOUT_SECONDS: "1",
        ...(normalized.env ?? {}),
      },
    });
  };

  context.startDispatcher = (webhookOrOptions = {}, roleOptions = {}) => {
    const normalized = typeof webhookOrOptions === "string"
      ? { ...optionsObject(roleOptions), webhookUrl: webhookOrOptions }
      : optionsObject(webhookOrOptions);
    return context.startProcess("dispatcher", "dispatcher", {
      ...normalized,
      env: {
        WEBHOOK_URL: normalized.webhookUrl,
        OUTBOX_POLL_INTERVAL_MS: "10",
        WEBHOOK_TIMEOUT_MS: "500",
        DISPATCH_TASK_TIMEOUT_SECONDS: "1",
        ...(normalized.env ?? {}),
      },
    });
  };

  context.adminRequest = (baseUrl, path, key, json, method = "POST") => context.request(baseUrl, path, {
    method,
    headers: { authorization: `Bearer ${context.adminToken}`, "idempotency-key": key },
    json,
  });
  context.orderRequest = (baseUrl, key, json) => context.request(baseUrl, "/api/orders", {
    method: "POST",
    headers: { "idempotency-key": key },
    json,
  });
  context.cancelRequest = (baseUrl, orderId, key) => context.request(baseUrl, `/api/orders/${orderId}/cancel`, {
    method: "POST",
    headers: { "idempotency-key": key },
  });
  context.paginate = async (baseUrl, path, parameters = {}, maximumPages = 10_000) => {
    const items = [];
    const cursors = new Set();
    let cursor;
    for (let page = 0; page < maximumPages; page += 1) {
      const query = new URLSearchParams(Object.entries(parameters).flatMap(([key, value]) => (
        value === undefined ? [] : [[key, String(value)]]
      )));
      if (cursor) query.set("cursor", cursor);
      const response = await context.request(baseUrl, `${path}?${query}`);
      context.equal(response.status, 200, `${path} page status`);
      context.ok(Array.isArray(response.json?.items), `${path} page shape`);
      items.push(...response.json.items);
      cursor = response.json.nextCursor;
      if (!cursor) return items;
      context.ok(!cursors.has(cursor), `${path} cursor does not repeat`);
      cursors.add(cursor);
    }
    context.fail(`${path} exceeded ${maximumPages} pages`, "PAGINATION_LIMIT");
  };
  context.readText = (path, options = {}) => readFile(resolve(options.workspace ?? context.workspace, path), "utf8");
  context.loadChromium = async () => createRequire(import.meta.url)("playwright-core").chromium;

  return context;
}

export async function createCaseContext(options) {
  return attachParcelFlowContext(await baseRuntime.createCaseContext(options));
}

export async function withCaseContext(options, operation) {
  const context = await createCaseContext(options);
  let operationError;
  try {
    await context.setup();
    return await operation(context);
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await context.teardown();
    } catch (cleanupError) {
      if (operationError && cleanupError && typeof cleanupError === "object" && cleanupError.cause === undefined) cleanupError.cause = operationError;
      throw cleanupError;
    }
  }
}

export const {
  CandidateResponseError,
  CommandError,
  EvaluationInfrastructureError,
  freePort,
  runCommand,
} = shared;
