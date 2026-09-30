import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { createFixtureFactory } from "../fixtures/index.mjs";
import { canonicalJson } from "../oracles/index.mjs";
import { CaseFailure } from "./execution.mjs";

const sharedRoot = process.env.FRONTAL_V2_SHARED_ROOT_URL ?? new URL("../../../../../src/task-evaluator-v2/", import.meta.url).href;
const shared = await import(process.env.FRONTAL_V2_SHARED_RUNTIME_URL ?? new URL("runtime.mjs", sharedRoot).href);
const BARRIER_FIELDS = Object.freeze(["aggregateId", "attempt", "leaseTokenHash", "point", "processRole", "schemaVersion", "workId"]);
const PUBLIC_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/giu;
const EVIDENCE_LIMIT = 128;

function publicEvidencePath(path) {
  try { return new URL(path, "http://permitforge.invalid").pathname.replace(PUBLIC_UUID, "{uuid}").slice(0, 120); }
  catch { return "/invalid-path"; }
}

export function validateBarrierPayload(value) {
  const validPoint = value?.processRole === "worker"
    ? ["worker.claimed", "worker.effect-complete", "worker.before-commit"].includes(value.point)
    : value?.processRole === "dispatcher" && value.point === "dispatcher.response-received";
  return Boolean(
    value && typeof value === "object" && !Array.isArray(value)
      && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(BARRIER_FIELDS)
      && value.schemaVersion === 1 && validPoint
      && typeof value.workId === "string" && value.workId.length > 0
      && typeof value.aggregateId === "string" && value.aggregateId.length > 0
      && Number.isSafeInteger(value.attempt) && value.attempt > 0
      && /^[0-9a-f]{64}$/u.test(value.leaseTokenHash),
  );
}

const base = shared.createCaseRuntime({
  taskSlug: "permitforge",
  databasePrefix: "pf",
  snapshotPath: "/api/v1/verification-snapshot",
  createFixtureFactory,
  adaptCompatibilityResponse: (_adapter, response) => response.json,
  assertCompatibilityAdapter: (adapter) => {
    if (adapter !== undefined && adapter !== null) throw new TypeError("PermitForge forbids compatibility adapters");
  },
  validateBarrierPayload,
});

function attach(context) {
  context.evidence = [];
  const evidenceByKey = new Map();
  context.mark = (event, fields = {}) => {
    const kind = String(fields.kind ?? event).slice(0, 160);
    const key = `${event}\0${kind}`;
    const existing = evidenceByKey.get(key);
    if (existing) { existing.count += 1; return existing; }
    if (context.evidence.length >= EVIDENCE_LIMIT) return undefined;
    const entry = { ordinal: context.evidence.length + 1, event, kind, count: 1 };
    evidenceByKey.set(key, entry);
    context.evidence.push(entry);
    return entry;
  };
  context.pass = (fields = {}) => ({ status: "passed", ...fields, evidence: [...context.evidence, ...(fields.evidence ?? [])] });
  context.assert = (label, operation, options = {}) => {
    try { return operation(); } catch (cause) {
      throw new CaseFailure(`${label}: ${cause.message}`, { failureCodeSuffix: options.failureCodeSuffix, hardCapIds: options.hardCapIds });
    }
  };
  context.equal = (actual, expected, label, options = {}) => context.assert(label, () => assert.deepStrictEqual(actual, expected), options);
  context.ok = (condition, label, options = {}) => context.assert(label, () => assert.ok(condition), options);
  context.canonical = canonicalJson;
  context.sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  context.loadChromium = async () => createRequire(import.meta.url)("playwright-core").chromium;
  context.openApi = (baseUrl) => context.request(baseUrl, "/openapi.json");

  const request = context.request.bind(context);
  context.request = async (baseUrl, path, options = {}) => {
    const method = String(options.method ?? "GET").toUpperCase();
    try {
      const response = await request(baseUrl, path, options);
      const publicPath = publicEvidencePath(path);
      context.mark("HTTP", { kind: `${method} ${publicPath} ${response.status}` });
      if (publicPath === "/openapi.json" && response.status === 200) context.mark("OpenAPI", { kind: "GET /openapi.json 200" });
      return response;
    } catch (error) {
      context.mark("HTTP", { kind: `${method} ${publicEvidencePath(path)} transport-error` });
      throw error;
    }
  };

  const snapshot = context.snapshot.bind(context);
  context.snapshot = async (...args) => {
    const value = await snapshot(...args);
    const resourceCount = Object.values(value.resources ?? {}).reduce((sum, rows) => sum + (Array.isArray(rows) ? rows.length : 0), 0);
    context.mark("snapshot", { kind: `resources=${resourceCount};work=${value.work?.length ?? 0};events=${value.events?.length ?? 0}` });
    context.mark("PostgreSQL", { kind: "verification-snapshot transaction" });
    if ((value.work?.length ?? 0) > 0) context.mark("work", { kind: `snapshot Work rows=${value.work.length}` });
    if ((value.events?.length ?? 0) > 0) context.mark("event", { kind: `snapshot Event rows=${value.events.length}` });
    return value;
  };

  const command = context.command.bind(context);
  context.command = async (binary, args = [], options = {}) => {
    const result = await command(binary, args, options);
    context.mark("process", { kind: `${String(binary).slice(0, 48)} exit=${result.exitCode ?? "signal"}` });
    return result;
  };

  const npm = context.npm.bind(context);
  context.npm = async (script, args = [], options = {}) => {
    const result = await npm(script, args, options);
    if (script === "build" && result.exitCode === 0) context.mark("build", { kind: "npm run build exit=0" });
    return result;
  };

  const migrate = context.migrate.bind(context);
  context.migrate = async (options = {}) => {
    const result = await migrate(options);
    if (result.exitCode === 0) {
      context.mark("migration", { kind: "db:migrate exit=0" });
      context.mark("PostgreSQL", { kind: "migration transaction" });
    }
    return result;
  };

  const seed = context.seed.bind(context);
  context.seed = async (value, options = {}) => {
    const result = await seed(value, options);
    if (result.exitCode === 0) {
      context.mark("seed", { kind: "db:seed exit=0" });
      context.mark("PostgreSQL", { kind: "seed transaction" });
    }
    return result;
  };

  for (const [name, role] of [["startApi", "api"], ["startDev", "dev"], ["startWorker", "worker"], ["startDispatcher", "dispatcher"]]) {
    const start = context[name].bind(context);
    context[name] = async (...args) => {
      const record = await start(...args);
      context.mark("process", { kind: `${role} started` });
      return record;
    };
  }

  const receiver = context.receiver.bind(context);
  context.receiver = async (...args) => {
    const record = await receiver(...args);
    context.mark("receiver", { kind: "receiver started" });
    const push = record.ledger.push.bind(record.ledger);
    record.ledger.push = (...entries) => {
      for (const entry of entries) context.mark("receiver", { kind: `${entry.method ?? "POST"} ${entry.path ?? "/events"}` });
      return push(...entries);
    };
    return record;
  };
  return context;
}

export async function createCaseContext(options) {
  const context = attach(await base.createCaseContext(options));
  context.priorCaseOutcomes = Object.freeze((options.priorCaseOutcomes ?? []).map((outcome) => Object.freeze(structuredClone(outcome))));
  return context;
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
    try { await context.teardown(); } catch (cleanupError) {
      if (operationError && cleanupError && typeof cleanupError === "object" && cleanupError.cause === undefined) cleanupError.cause = operationError;
      throw cleanupError;
    }
  }
}

export const { CandidateResponseError, CommandError, EvaluationInfrastructureError, freePort, runCommand } = shared;
