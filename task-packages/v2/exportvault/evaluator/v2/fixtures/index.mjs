import { createHash } from "node:crypto";

import { canonicalJson, csvBytes, jsonlBytes, sha256 } from "../oracles/index.mjs";

function digest(...parts) { return createHash("sha256").update(parts.join("\0")).digest(); }
function uuidFrom(buffer) { const bytes = Buffer.from(buffer.subarray(0, 16)); bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80; const hex = bytes.toString("hex"); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`; }

export function createFixtureFactory({ evaluationSeed, caseId, baseTime }) {
  const namespace = `exportvault\0${evaluationSeed}\0${caseId}`;
  const uuid = (label) => uuidFrom(digest(namespace, "uuid", label));
  const key = (label) => `ev-${digest(namespace, "key", label).toString("hex").slice(0, 48)}`;
  const at = ({ seconds = 0, minutes = 0, hours = 0, days = 0 } = {}) => new Date(Date.parse(baseTime) + (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000).toISOString();

  const subject = (label = "main", currentDatasetRevision = 2) => ({ subjectId: uuid(`subject:${label}`), name: `Export Subject ${label}`, currentDatasetRevision });
  const record = (label, scope, data) => ({ recordId: uuid(`record:${label}`), scope, data });
  const recordsV1 = [record("profile-a", "profile", { name: "Ada, \"A\"", note: "line 1\nline 2", active: true }), record("activity-a", "activity", { action: "登入", value: 7 }), record("orders-a", "orders", { total: 12.5, currency: "USD" }), record("files-a", "files", { path: "safe/π.txt", size: 3 })];
  const recordsV2 = [...recordsV1, record("profile-b", "profile", { name: "Zoë", nested: { a: 1, b: 2 } }), record("activity-b", "activity", { action: "logout", value: 8 })];
  const revision = (owner, number, records) => ({ subjectId: owner.subjectId, revision: number, committedAt: at({ minutes: number }), records });
  const seed = (label, owner = subject(label), revisions = [revision(owner, 1, recordsV1), revision(owner, 2, recordsV2)], exports = []) => ({ schemaVersion: 1, seedVersion: `${caseId.toLowerCase()}-${label}`.slice(0, 64), subjects: [owner], datasetRevisions: revisions, exports });

  function bytes() {
    const owner = subject("bytes"); const seedValue = seed("bytes", owner, [revision(owner, 1, recordsV1), revision(owner, 2, recordsV2)]);
    return { fixtureFamily: "EV-F-BYTES", owner, records: recordsV2, seed: seedValue, jsonl: jsonlBytes(recordsV2), csv: csvBytes(recordsV2) };
  }
  function lifecycle() {
    const owner = subject("lifecycle", 1); const payload = jsonlBytes(recordsV1);
    const makeExport = (label, state, object = null, retentionUntil = "2040-01-01T00:00:00.000Z") => { const createdAt = new Date(Date.parse(retentionUntil) - 86_400_000).toISOString(); return { exportId: uuid(`export:${label}`), subjectId: owner.subjectId, scope: ["activity", "files", "orders", "profile"], format: "JSONL", datasetRevision: 1, state, object, retentionUntil, createdAt, readyAt: state === "READY" || state === "EXPIRED" ? new Date(Date.parse(createdAt) + 300_000).toISOString() : null, sequence: 1, ...(object ? { assetPath: `assets/${label}.jsonl` } : {}) }; };
    const readyObject = { sha256: sha256(payload), size: payload.length, mediaType: "application/x-ndjson" };
    const exports = [makeExport("ready", "READY", readyObject), makeExport("cleanup", "READY", readyObject, "2020-01-02T00:00:00.000Z"), makeExport("cancelled", "CANCELLED"), makeExport("failed", "FAILED")];
    const revisions = [{ subjectId: owner.subjectId, revision: 1, committedAt: "2019-01-01T00:00:00.000Z", records: recordsV1 }];
    return { fixtureFamily: "EV-F-LIFECYCLE", owner, payload, exports, assets: { "ready.jsonl": payload, "cleanup.jsonl": payload }, seed: seed("lifecycle", owner, revisions, exports) };
  }
  function grant() { const payload = Buffer.from(`${canonicalJson({ export: uuid("grant-export"), value: "0123456789abcdef" })}\n`.repeat(8)); return { fixtureFamily: "EV-F-GRANT", payload, digest: sha256(payload), ranges: [undefined, "bytes=0-0", "bytes=1-12", `bytes=${payload.length - 1}-${payload.length - 1}`, "bytes=999999-1000000"] }; }
  function shard() {
    const profileIds = Array.from({ length: 100001 }, (_, index) => uuid(`worked-profile:${String(index).padStart(6, "0")}`)).sort();
    const activityIds = [uuid("worked-activity:0"), uuid("worked-activity:1")].sort();
    return { fixtureFamily: "EV-F-SHARD", workedExample: { totalRecords: 100003, sections: [{ name: "profile", recordIds: profileIds }, { name: "activity", recordIds: activityIds }] }, thresholds: [100000, 100001, 200000] };
  }
  function recovery() { const owner = subject("recovery", 1); return { fixtureFamily: "EV-F-RECOVERY", owner, seed: seed("recovery", owner, [revision(owner, 1, recordsV1)]), barriers: ["worker.claimed", "worker.effect-complete", "worker.before-commit", "dispatcher.response-received"] }; }
  function v1Final() { const fixture = lifecycle(); return { fixtureFamily: "EV-F-V1-FINAL", ...fixture, savedReplayKey: key("v1-saved-replay") }; }
  function performance() { return { fixtureFamily: "EV-F-PERF-V1", scenarioIds: ["range-download", "five-million-record-generation", "expired-object-cleanup"], subjectCount: 100, revisionCount: 100, exportCount: 11000, recordCount: 5000000, expiredCount: 10000, liveCount: 1000, rangeClients: 100, rangeBytes: 1048576 }; }

  return Object.freeze({ uuid, key, at, bytes, lifecycle, grant, shard, recovery, v1Final, performance });
}
