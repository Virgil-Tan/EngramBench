import assert from "node:assert/strict";
import test from "node:test";

import { createFixtureFactory } from "../fixtures/index.mjs";
import { canonicalJson, csvBytes, jsonlBytes, manifestBytes, planShards, rangeOracle, sha256 } from "../oracles/index.mjs";

const fixtures = createFixtureFactory({ evaluationSeed: "exportvault-test", caseId: "A-01", baseTime: "2035-06-01T12:00:00.000Z" });

test("fixtures are deterministic, task-local, and cover every frozen family", () => {
  const again = createFixtureFactory({ evaluationSeed: "exportvault-test", caseId: "A-01", baseTime: "2035-06-01T12:00:00.000Z" });
  assert.equal(fixtures.uuid("subject"), again.uuid("subject"));
  assert.match(fixtures.key("create"), /^ev-/u);
  assert.equal(fixtures.bytes().seed.schemaVersion, 1);
  assert.equal(fixtures.lifecycle().seed.exports.length >= 4, true);
  assert.equal(fixtures.grant().payload.length >= 64, true);
  assert.equal(fixtures.shard().workedExample.totalRecords, 100003);
  assert.equal(fixtures.recovery().seed.exports.length, 0);
  assert.deepEqual(fixtures.recovery().barriers, ["worker.claimed", "worker.effect-complete", "worker.before-commit", "dispatcher.response-received"]);
  assert.equal(fixtures.v1Final().seed.schemaVersion, 1);
  assert.deepEqual(fixtures.performance().scenarioIds, ["range-download", "five-million-record-generation", "expired-object-cleanup"]);
});

test("independent byte and shard oracles close digests", () => {
  const records = fixtures.bytes().records;
  const jsonl = jsonlBytes(records);
  const csv = csvBytes(records);
  assert.ok(jsonl.includes(Buffer.from("\n")) && csv.subarray(0, 14).toString() === "recordId,data\n");
  assert.equal(sha256(jsonl), sha256(Buffer.from(jsonl)));
  const range = rangeOracle(jsonl, "bytes=1-3");
  assert.equal(range.status, 206); assert.deepEqual(range.body, jsonl.subarray(1, 4));
  const planned = planShards(fixtures.shard().workedExample.sections, 100000);
  assert.deepEqual(planned.map(({ section, recordCount }) => [section, recordCount]), [["profile", 100000], ["profile", 1], ["activity", 2]]);
  const body = manifestBytes(planned.map((item, ordinal) => ({ shardId: fixtures.uuid(`shard-${ordinal}`), ordinal, section: item.section, range: item.range, recordCount: item.recordCount, sha256: "a".repeat(64), size: 1, mediaType: "application/x-ndjson" })));
  assert.equal(JSON.parse(body).length, 3); assert.equal(canonicalJson(JSON.parse(body)), body.toString());
});
