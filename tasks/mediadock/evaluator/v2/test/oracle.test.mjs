import assert from "node:assert/strict";
import test from "node:test";

import { createFixtureFactory, profileFixture, uploadFixture } from "../lib/fixtures.mjs";
import { assertCoverage, capability, multipartRanges, partManifest, rangeOracle, renditionBytes, sha256 } from "../lib/oracle.mjs";

const fixtures = createFixtureFactory({ evaluationSeed: "test-seed", caseId: "A-01", baseTime: "2035-06-01T12:00:00.000Z" });

test("MD-W1 uses inclusive HTTP endpoints and complete half-open byte coverage", () => {
  const bytes = Buffer.alloc(20_000, 0x41);
  const parts = partManifest(bytes, 8_192);
  assert.deepEqual(parts.map(({ start, end, size }) => ({ start, end, size })), [
    { start: 0, end: 8191, size: 8192 },
    { start: 8192, end: 16383, size: 8192 },
    { start: 16384, end: 19999, size: 3616 },
  ]);
  assert.equal(assertCoverage(parts, bytes.length), true);
  assert.equal(parts.every((part) => part.sha256 === sha256(part.bytes)), true);
});

test("COPY and PREFIX rendition bytes are computed independently", () => {
  const source = Buffer.from("source");
  const copy = profileFixture(fixtures, "copy", "COPY");
  const prefix = profileFixture(fixtures, "prefix", "PREFIX", Buffer.from("ABC"));
  assert.deepEqual(renditionBytes(source, copy), source);
  assert.deepEqual(renditionBytes(source, prefix), Buffer.from("ABCsource"));
});

test("single RFC 7233 ranges and deterministic capability have exact boundaries", () => {
  const bytes = Buffer.from("0123456789");
  assert.deepEqual(rangeOracle(bytes, "bytes=2-5"), { status: 206, start: 2, end: 5, body: Buffer.from("2345") });
  assert.deepEqual(rangeOracle(bytes, "bytes=-3"), { status: 206, start: 7, end: 9, body: Buffer.from("789") });
  assert.equal(rangeOracle(bytes, "bytes=20-30").status, 416);
  assert.equal(capability("secret", "grant", "2035-01-01T00:00:00.000Z"), capability("secret", "grant", "2035-01-01T00:00:00.000Z"));
});

test("fixtures freeze bytes, ids, time, and whole digest", () => {
  const left = uploadFixture(fixtures, "same", { size: 25_000 });
  const right = uploadFixture(fixtures, "same", { size: 25_000 });
  assert.deepEqual(left, right);
  assert.equal(left.expectedSha256, sha256(left.bytes));
  assert.equal(multipartRanges(left.expectedSize, left.partSize).length, 4);
});
