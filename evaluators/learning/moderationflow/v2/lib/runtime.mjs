import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { createFixtureFactory } from "../fixtures/index.mjs";
import { CaseFailure } from "./execution.mjs";

const sharedRoot = process.env.FRONTAL_V2_SHARED_ROOT_URL ?? new URL("../../../../../src/task-evaluator-v2/", import.meta.url).href;
const shared = await import(process.env.FRONTAL_V2_SHARED_RUNTIME_URL ?? new URL("runtime.mjs", sharedRoot).href);
const barrierKeys = ["aggregateId", "attempt", "leaseTokenHash", "point", "processRole", "schemaVersion", "workId"];

export function isModerationFlowBarrier(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...barrierKeys].sort())) return false;
  const seam = value.processRole === "worker" && ["worker.claimed", "worker.effect-complete", "worker.before-commit"].includes(value.point)
    || value.processRole === "dispatcher" && value.point === "dispatcher.response-received";
  return value.schemaVersion === 1 && seam && typeof value.workId === "string" && typeof value.aggregateId === "string"
    && Number.isSafeInteger(value.attempt) && value.attempt >= 1 && /^[a-f0-9]{64}$/u.test(value.leaseTokenHash);
}

const base = shared.createCaseRuntime({
  taskSlug: "moderationflow",
  databasePrefix: "mf",
  snapshotPath: "/api/v1/verification-snapshot",
  createFixtureFactory,
  adaptCompatibilityResponse: (_adapter, { json }) => json,
  assertCompatibilityAdapter: (value) => { if (value != null) throw new TypeError("ModerationFlow V2 forbids compatibility response adapters"); },
  validateBarrierPayload: isModerationFlowBarrier,
});

function decorate(ctx) {
  const assertions = []; const statuses = new Map(); const metrics = {};
  const request = ctx.request;
  ctx.request = async (baseUrl, path, options = {}) => {
    const response = await request(baseUrl, path, options);
    if (options.record !== false) statuses.set(String(response.status), (statuses.get(String(response.status)) ?? 0) + 1);
    return response;
  };
  ctx.check = (label, operation, options = {}) => {
    try { operation(); assertions.push({ label, status: "passed" }); }
    catch (cause) { assertions.push({ label, status: "failed" }); throw new CaseFailure(`${label}: ${cause?.message ?? cause}`, { ...options, cause }); }
  };
  ctx.equal = (actual, expected, label = "values are equal", options = {}) => ctx.check(label, () => assert.deepEqual(actual, expected), options);
  ctx.ok = (condition, label = "condition is truthy", options = {}) => ctx.check(label, () => assert.ok(condition), options);
  ctx.metric = (name, value) => { metrics[name] = value; };
  ctx.pass = (evidence = []) => ({ status: "passed", evidence: [{ kind: "moderationflow-assertions", assertions, statuses: Object.fromEntries(statuses), metrics }, ...evidence] });
  ctx.loadChromium = async () => {
    const module = await import("playwright-core");
    return module.chromium;
  };
  ctx.chromiumExecutable = async () => {
    for (const candidate of [process.env.CHROMIUM_PATH, "/usr/bin/chromium", "/usr/bin/chromium-browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter(Boolean)) {
      try { await access(candidate); return candidate; } catch {}
    }
    throw new shared.EvaluationInfrastructureError("EVALUATOR_CHROMIUM_UNAVAILABLE");
  };
  return ctx;
}

export async function createCaseContext(options) { return decorate(await base.createCaseContext(options)); }
export async function withCaseContext(options, operation) {
  return base.withCaseContext(options, async (raw) => {
    const ctx = decorate(raw);
    const outcome = await operation(ctx);
    return outcome;
  });
}

export const { CandidateResponseError, CommandError, EvaluationInfrastructureError, freePort, runCommand } = shared;
