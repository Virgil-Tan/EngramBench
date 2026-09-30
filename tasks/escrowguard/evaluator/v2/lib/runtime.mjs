import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import { createFixtureFactory } from "../fixtures/index.mjs";
import { CaseFailure } from "./execution.mjs";

const sharedRoot = process.env.FRONTAL_V2_SHARED_ROOT_URL ?? new URL("../../../../../src/task-evaluator-v2/", import.meta.url).href;
const shared = await import(process.env.FRONTAL_V2_SHARED_RUNTIME_URL ?? new URL("runtime.mjs", sharedRoot).href);
const BARRIER_FIELDS = ["aggregateId", "attempt", "leaseTokenHash", "point", "processRole", "schemaVersion", "workId"];
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/giu;
const MAX_LAYER_OBSERVATIONS_PER_LAYER = 6;
const MAX_HASHES_PER_KIND = 6;
const MAX_STREAMED_IDENTITIES = 8_192;
const MAX_STREAMED_NODES_PER_MARK = 32_768;

function identityHash(kind, value) {
  return createHash("sha256").update(`escrowguard-evidence-v2\0${kind}\0${String(value)}`).digest("hex");
}

function normalizedPath(path) {
  try {
    const url = new URL(path, "http://escrowguard.invalid");
    const pathname = url.pathname.replace(UUID, "{uuid}");
    const names = [...new Set(url.searchParams.keys())].sort();
    return `${pathname}${names.length ? `?${names.join("&")}` : ""}`.slice(0, 192);
  } catch {
    return String(path ?? "").replace(UUID, "{uuid}").slice(0, 192);
  }
}

function identityHashes(value) {
  const hashes = { identityHashes: new Set(), aggregateHashes: new Set(), workHashes: new Set(), eventHashes: new Set(), resourceHashes: new Set() };
  const pending = [{ key: "", value }];
  let visited = 0;
  while (pending.length && visited < 512) {
    const current = pending.pop(); visited += 1;
    if (Array.isArray(current.value)) {
      for (const item of current.value.slice(0, 128)) pending.push({ key: current.key, value: item });
      continue;
    }
    if (!current.value || typeof current.value !== "object") {
      if (typeof current.value !== "string" || !/Id$/u.test(current.key)) continue;
      hashes.identityHashes.add(identityHash("identity", current.value));
      const target = current.key === "workId" ? "workHashes" : current.key === "eventId" ? "eventHashes" : ["escrowId", "aggregateId"].includes(current.key) ? "aggregateHashes" : "resourceHashes";
      const identityKind = target === "aggregateHashes" ? "aggregate" : target === "workHashes" ? "work" : target === "eventHashes" ? "event" : current.key;
      hashes[target].add(identityHash(identityKind, current.value));
      continue;
    }
    for (const [key, child] of Object.entries(current.value)) pending.push({ key, value: child });
  }
  return Object.fromEntries(Object.entries(hashes).map(([kind, values]) => [kind, [...values].sort().slice(0, MAX_HASHES_PER_KIND)]));
}

function layerObservation(layer, fields) {
  const path = fields.path === undefined ? undefined : String(fields.path);
  const pathHashes = [...(path?.match(UUID) ?? [])].map((value) => identityHash("identity", value));
  const hashes = identityHashes(fields);
  hashes.identityHashes = [...new Set([...hashes.identityHashes, ...pathHashes])].sort().slice(0, MAX_HASHES_PER_KIND);
  return Object.freeze({
    layer,
    ...(fields.method ? { method: String(fields.method).toUpperCase().slice(0, 12) } : {}),
    ...(path !== undefined ? { path: normalizedPath(path) } : {}),
    ...(Number.isSafeInteger(fields.status) ? { status: fields.status } : {}),
    ...hashes,
  });
}

function recordLayerIdentities(bindings, layer, fields) {
  const record = (value) => {
    const hash = identityHash("identity", value);
    const layers = bindings.get(hash);
    if (layers) layers.add(layer);
    else if (bindings.size < MAX_STREAMED_IDENTITIES) bindings.set(hash, new Set([layer]));
  };
  for (const value of String(fields?.path ?? "").match(UUID) ?? []) record(value);
  const pending = [{ key: "", value: fields }];
  const seen = new WeakSet();
  let visited = 0;
  while (pending.length && visited < MAX_STREAMED_NODES_PER_MARK) {
    const current = pending.pop(); visited += 1;
    if (Array.isArray(current.value)) {
      if (seen.has(current.value)) continue;
      seen.add(current.value);
      for (const item of current.value) pending.push({ key: current.key, value: item });
      continue;
    }
    if (!current.value || typeof current.value !== "object") {
      if (typeof current.value === "string" && /Id$/u.test(current.key)) record(current.value);
      continue;
    }
    if (seen.has(current.value)) continue;
    seen.add(current.value);
    for (const [key, child] of Object.entries(current.value)) pending.push({ key, value: child });
  }
}

export function validateBarrierPayload(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(BARRIER_FIELDS)
    && value.schemaVersion === 1
    && ["worker", "dispatcher"].includes(value.processRole)
    && ["worker.claimed", "worker.effect-complete", "worker.before-commit", "dispatcher.response-received"].includes(value.point)
    && typeof value.workId === "string" && value.workId.length > 0
    && typeof value.aggregateId === "string" && value.aggregateId.length > 0
    && Number.isSafeInteger(value.attempt) && value.attempt > 0
    && /^[0-9a-f]{64}$/u.test(value.leaseTokenHash));
}

const base = shared.createCaseRuntime({
  taskSlug: "escrowguard",
  databasePrefix: "eg",
  snapshotPath: "/api/v1/verification-snapshot",
  createFixtureFactory,
  adaptCompatibilityResponse: (_adapter, response) => response.json,
  assertCompatibilityAdapter(adapter) {
    if (adapter !== undefined && adapter !== null) throw new TypeError("EscrowGuard forbids compatibility adapters");
  },
  validateBarrierPayload,
});

function attach(context) {
  context.evidence = [];
  context.layerEvidenceCounts = Object.create(null);
  context.layerEvidence = [];
  context.layerIdentityBindings = new Map();
  context.mark = (event, fields = {}) => {
    const layer = /^layer\.([a-z]+)$/u.exec(event)?.[1];
    if (layer) {
      context.layerEvidenceCounts[layer] = (context.layerEvidenceCounts[layer] ?? 0) + 1;
      recordLayerIdentities(context.layerIdentityBindings, layer, fields);
      if (context.layerEvidenceCounts[layer] <= MAX_LAYER_OBSERVATIONS_PER_LAYER) context.layerEvidence.push(layerObservation(layer, fields));
      return;
    }
    if (context.evidence.length < 256) context.evidence.push({ ordinal: context.evidence.length + 1, event, ...fields });
  };
  context.pass = (fields = {}) => ({ status: "passed", ...fields, evidence: [...context.evidence, ...(fields.evidence ?? [])] });
  context.equal = (actual, expected, label, options = {}) => {
    try { assert.deepStrictEqual(actual, expected); }
    catch (cause) { throw new CaseFailure(`${label}: ${cause.message}`, { failureCodeSuffix: options.failureCodeSuffix, hardCapIds: options.hardCapIds }); }
  };
  context.ok = (condition, label, options = {}) => {
    try { assert.ok(condition); }
    catch (cause) { throw new CaseFailure(`${label}: ${cause.message}`, { failureCodeSuffix: options.failureCodeSuffix, hardCapIds: options.hardCapIds }); }
  };
  const request = context.request.bind(context);
  context.request = async (baseUrl, path, requestOptions = {}) => {
    const response = await request(baseUrl, path, requestOptions);
    const fields = { method: requestOptions.method ?? "GET", path, status: response.status, payload: response.json };
    context.mark("layer.http", fields);
    if (new URL(path, baseUrl).pathname === "/openapi.json") context.mark("layer.openapi", fields);
    if (new URL(path, baseUrl).pathname === "/api/v1/domain-events") context.mark("layer.event", fields);
    return response;
  };
  const snapshot = context.snapshot.bind(context);
  context.snapshot = async (...arguments_) => {
    const value = await snapshot(...arguments_);
    context.mark("layer.snapshot", { payload: value });
    if ((value?.work?.length ?? 0) > 0) context.mark("layer.work", { payload: { escrows: value.resources?.escrows, work: value.work } });
    if ((value?.events?.length ?? 0) > 0) context.mark("layer.event", { payload: { escrows: value.resources?.escrows, events: value.events } });
    return value;
  };
  context.loadChromium = async () => createRequire(import.meta.url)("playwright-core").chromium;
  return context;
}

export async function createCaseContext(options) {
  const context = attach(await base.createCaseContext(options));
  context.caseOutcomes = Object.freeze((options.caseOutcomes ?? []).map((outcome) => Object.freeze({
    id: outcome.id,
    status: outcome.status,
    evidenceDigest: outcome.evidenceDigest,
    ...(outcome.reason ? { reason: outcome.reason } : {}),
    ...(outcome.privateFailureCode ? { privateFailureCode: outcome.privateFailureCode } : {}),
    ...(outcome.evaluatorErrorCode ? { evaluatorErrorCode: outcome.evaluatorErrorCode } : {}),
  })));
  context.caseEvidenceSummaries = Object.freeze((options.caseEvidenceSummaries ?? []).map((summary) => Object.freeze({
    caseId: summary.caseId,
    layers: Object.freeze({ ...summary.layers }),
    evidenceKinds: Object.freeze([...(summary.evidenceKinds ?? [])]),
    observations: Object.freeze((summary.observations ?? []).map((item) => Object.freeze({ ...item,
      identityHashes: Object.freeze([...(item.identityHashes ?? [])]),
      aggregateHashes: Object.freeze([...(item.aggregateHashes ?? [])]),
      workHashes: Object.freeze([...(item.workHashes ?? [])]),
      eventHashes: Object.freeze([...(item.eventHashes ?? [])]),
      resourceHashes: Object.freeze([...(item.resourceHashes ?? [])]),
    }))),
    bindings: Object.freeze((summary.bindings ?? []).map((item) => Object.freeze({ ...item, layers: Object.freeze([...(item.layers ?? [])]) }))),
  })));
  return context;
}
export async function withCaseContext(options, operation) {
  const context = await createCaseContext(options);
  let operationError;
  try { await context.setup(); return await operation(context); }
  catch (error) { operationError = error; throw error; }
  finally {
    try { await context.teardown(); }
    catch (cleanupError) {
      if (operationError && cleanupError && typeof cleanupError === "object" && cleanupError.cause === undefined) cleanupError.cause = operationError;
      throw cleanupError;
    }
  }
}

export const { CandidateResponseError, CommandError, EvaluationInfrastructureError, freePort, runCommand } = shared;
