import assert from "node:assert/strict";
import test from "node:test";

import {
  createFixtureFactory,
  importSeed,
  schemaFixture,
  uploadWorkedExample,
  validationWorkedExample,
  rowsFixture,
} from "../lib/fixtures.mjs";
import {
  intervalState,
  modelNdjson,
  sha256,
} from "../lib/oracle.mjs";

const fixtures = createFixtureFactory({
  evaluationSeed: "fixture-seed",
  caseId: "A-01",
  baseTime: "2035-06-01T12:00:00.000Z",
});

test("ImportWorks fixtures freeze UUIDs, keys, time and exact seed members", () => {
  assert.equal(fixtures.uuid("tenant"), fixtures.uuid("tenant"));
  assert.notEqual(fixtures.uuid("tenant"), fixtures.uuid("schema"));
  assert.equal(fixtures.at({ seconds: 3 }), "2035-06-01T12:00:03.000Z");
  assert.match(fixtures.key("upload"), /^iw-upload-[a-f0-9]{24}$/u);
  const seed = importSeed(fixtures, "seed-v1");
  assert.deepEqual(Object.keys(seed), [
    "schemaVersion", "seedVersion", "tenants", "schemas", "schemaRevisions", "imports",
    "uploadChunks", "validationFindings", "committedRecords", "errorReports",
  ]);
});

test("IW-W1 uses half-open adjacent intervals and exact missing ranges", () => {
  const worked = uploadWorkedExample();
  assert.equal(worked.bytes.toString("utf8"), "abcdefghijkl");
  assert.deepEqual(worked.pieces.map(({ start, endExclusive }) => [start, endExclusive]), [[8, 12], [0, 4], [4, 8]]);
  assert.deepEqual(intervalState(12, worked.pieces.slice(0, 1)), { receivedBytes: 4, missing: [[0, 8]] });
  assert.deepEqual(intervalState(12, worked.pieces.slice(0, 2)), { receivedBytes: 8, missing: [[4, 8]] });
  assert.deepEqual(intervalState(12, worked.pieces), { receivedBytes: 12, missing: [] });
  assert.equal(sha256(worked.bytes), "d682ed4ca4d989c134ec94f1551e1ec580dd6d5a6ecde9f3d35e6e4a717fbde4");
});

test("independent NDJSON model freezes schema and duplicate external identity", () => {
  const schema = schemaFixture(fixtures, { revision: 1 });
  const worked = validationWorkedExample();
  const model = modelNdjson(worked.bytes, schema);
  assert.deepEqual(model.rows.map(({ rowNumber, valid, externalRowId }) => ({ rowNumber, valid, externalRowId })), [
    { rowNumber: 1, valid: true, externalRowId: "X" },
    { rowNumber: 2, valid: false, externalRowId: "Y" },
    { rowNumber: 3, valid: false, externalRowId: "X" },
  ]);
  assert.deepEqual(model.validRows.map(({ rowNumber }) => rowNumber), [1]);
  assert.deepEqual(model.invalidRows.map(({ rowNumber }) => rowNumber), [2, 3]);
  assert.deepEqual(model.issues.map(({ rowNumber, field, kind }) => [rowNumber, field, kind]), [
    [2, "age", "WRONG_TYPE"],
    [3, "externalId", "DUPLICATE_EXTERNAL_ID"],
  ]);
});

test("invalid UTF-8 and malformed JSON are modeled as redacted row findings", () => {
  const schema = schemaFixture(fixtures, { revision: 1 });
  const invalidUtf8 = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d, 0x0a]);
  assert.deepEqual(modelNdjson(invalidUtf8, schema).issues.map(({ kind }) => kind), ["INVALID_UTF8"]);
  assert.deepEqual(modelNdjson(Buffer.from('{"externalId":"broken"\n'), schema).issues.map(({ kind }) => kind), ["MALFORMED_JSON"]);
  const mixed = Buffer.concat([
    Buffer.from(`${JSON.stringify({ externalId: "before", email: "before@example.test" })}\n`),
    invalidUtf8,
    Buffer.from(`${JSON.stringify({ externalId: "after", email: "after@example.test" })}\n`),
  ]);
  assert.deepEqual(modelNdjson(mixed, schema).rows.map(({ rowNumber, valid }) => [rowNumber, valid]), [[1, true], [2, false], [3, true]]);
});

test("performance rows keep invalid identities unique to each import prefix", () => {
  const first = rowsFixture(100, { prefix: "load-1", invalidEvery: 10 });
  const second = rowsFixture(100, { prefix: "load-2", invalidEvery: 10 });
  assert.equal(first.filter(({ email }) => email === 42).length, 10);
  assert.equal(second.filter(({ email }) => email === 42).length, 10);
  assert.equal(new Set([...first, ...second].map(({ externalId }) => externalId)).size, 200);
  assert.deepEqual(
    (({ validRows, invalidRows }) => [validRows.length, invalidRows.length])(modelNdjson(Buffer.from(first.map(JSON.stringify).join("\n") + "\n"), schemaFixture(fixtures))),
    [90, 10],
  );
});
