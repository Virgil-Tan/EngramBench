import { createHash } from "node:crypto";

function hash(seed, ...parts) {
  const digest = createHash("sha256").update(String(seed));
  for (const part of parts) digest.update("\0").update(String(part));
  return digest.digest();
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 30) || "value";
}

function milliseconds(offset = {}) {
  if (typeof offset === "number") return offset;
  return (offset.days ?? 0) * 86_400_000 + (offset.hours ?? 0) * 3_600_000
    + (offset.minutes ?? 0) * 60_000 + (offset.seconds ?? 0) * 1_000 + (offset.milliseconds ?? 0);
}

export function createFixtureFactory({ evaluationSeed, caseId, baseTime }) {
  if (!evaluationSeed || !caseId || !baseTime) throw new TypeError("evaluationSeed, caseId, and baseTime are required");
  const epoch = Date.parse(baseTime);
  if (!Number.isFinite(epoch)) throw new TypeError("baseTime must be an ISO timestamp");
  const namespace = `${evaluationSeed}\0${caseId}`;
  return Object.freeze({
    evaluationSeed: String(evaluationSeed),
    caseId: String(caseId),
    baseTime: new Date(epoch).toISOString(),
    uuid(label) {
      const bytes = hash(namespace, "uuid", label).subarray(0, 16);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const value = bytes.toString("hex");
      return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
    },
    at(offset = {}) { return new Date(epoch + milliseconds(offset)).toISOString(); },
    key(label) { return `qf-${slug(label)}-${hash(namespace, "key", label).toString("hex").slice(0, 24)}`; },
    seedVersion(label = "seed") { return `qf-${slug(caseId)}-${slug(label)}-${hash(namespace, "seed", label).toString("hex").slice(0, 12)}`.slice(0, 64); },
  });
}

export function emptySeed(fixtures, label = "empty") {
  return {
    schemaVersion: 1,
    seedVersion: fixtures.seedVersion(label),
    queues: [],
    jobDefinitions: [],
    runs: [],
    attempts: [],
    executionLeases: [],
  };
}

export function queue(fixtures, label, overrides = {}) {
  return { queueId: fixtures.uuid(`queue-${label}`), name: `queue-${slug(label)}`, capacity: 20, ...overrides };
}

export function jobDefinition(fixtures, label, overrides = {}) {
  return {
    jobDefinitionId: fixtures.uuid(`definition-${label}`), version: 1, operation: "ECHO",
    maxAttempts: 3, timeoutSeconds: 30, createdAt: fixtures.at({ days: -3 }), ...overrides,
  };
}

export function run(fixtures, label, definition, targetQueue, overrides = {}) {
  return {
    runId: fixtures.uuid(`run-${label}`), jobDefinitionId: definition.jobDefinitionId,
    jobVersion: definition.version, queueId: targetQueue.queueId, priority: 0,
    notBefore: fixtures.at({ days: -2 }), input: { value: label }, state: "QUEUED",
    attemptCount: 0, output: null, errorCode: null, createdAt: fixtures.at({ days: -2 }),
    startedAt: null, terminalAt: null, sequence: 1, ...overrides,
  };
}

export function attempt(fixtures, label, targetRun, overrides = {}) {
  return {
    runId: targetRun.runId, attempt: targetRun.attemptCount || 1, workerId: `worker-${slug(label)}`,
    startedAt: targetRun.startedAt ?? fixtures.at({ days: -2 }), finishedAt: null,
    outcome: null, outputDigest: null, ...overrides,
  };
}

export function executionLease(fixtures, label, targetRun, targetAttempt, overrides = {}) {
  return {
    runId: targetRun.runId, attempt: targetAttempt.attempt, workerId: targetAttempt.workerId,
    leaseToken: hash(fixtures.evaluationSeed, fixtures.caseId, "lease", label).toString("hex"),
    leasedAt: targetAttempt.startedAt, expiresAt: fixtures.at({ days: -1 }), ...overrides,
  };
}
