import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";

export function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

export function multipartRanges(size, partSize) {
  assert.ok(Number.isSafeInteger(size) && size > 0);
  assert.ok(Number.isSafeInteger(partSize) && partSize > 0);
  const result = [];
  for (let start = 0, partNumber = 1; start < size; start += partSize, partNumber += 1) {
    const end = Math.min(size - 1, start + partSize - 1);
    const length = end - start + 1;
    result.push({ partNumber, start, end, size: length });
  }
  return result;
}

export function partManifest(bytes, partSize) {
  return multipartRanges(bytes.length, partSize).map((range) => ({
    ...range,
    bytes: bytes.subarray(range.start, range.end + 1),
    sha256: sha256(bytes.subarray(range.start, range.end + 1)),
  }));
}

export function assertCoverage(parts, expectedSize) {
  const ordered = [...parts].sort((left, right) => left.start - right.start);
  let next = 0;
  for (const part of ordered) {
    assert.equal(part.start, next);
    assert.equal(part.size, part.end - part.start + 1);
    next = part.end + 1;
  }
  assert.equal(next, expectedSize);
  return true;
}

export function renditionBytes(source, profile) {
  if (profile.operation === "COPY") return Buffer.from(source);
  if (profile.operation === "PREFIX") return Buffer.concat([Buffer.from(profile.prefixBase64, "base64"), source]);
  throw new TypeError(`unsupported operation: ${profile.operation}`);
}

export function rangeOracle(bytes, rangeHeader) {
  if (!rangeHeader) return { status: 200, start: 0, end: bytes.length - 1, body: bytes };
  const match = /^bytes=(\d*)-(\d*)$/u.exec(rangeHeader);
  if (!match || (!match[1] && !match[2])) return { status: 416, body: Buffer.alloc(0) };
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { status: 416, body: Buffer.alloc(0) };
    start = Math.max(0, bytes.length - suffix);
    end = bytes.length - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : bytes.length - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= bytes.length || end < start) return { status: 416, body: Buffer.alloc(0) };
  end = Math.min(end, bytes.length - 1);
  return { status: 206, start, end, body: bytes.subarray(start, end + 1) };
}

export function capability(secret, grantId, expiresAt) {
  return createHmac("sha256", secret).update(`${grantId}\0${expiresAt}`).digest("base64url");
}

export function assertSortedUnique(items, key) {
  const values = items.map((item) => item[key]);
  assert.deepEqual(values, [...new Set(values)].sort((left, right) => Buffer.from(left).compare(Buffer.from(right))));
}

export function reachableBlobIds(snapshot) {
  const ids = new Set();
  for (const asset of snapshot.resources?.mediaAssets ?? []) if (!["INFECTED", "FAILED"].includes(asset.state)) ids.add(asset.sourceBlobId);
  for (const rendition of snapshot.resources?.renditions ?? []) if (rendition.state === "READY") ids.add(rendition.blobId);
  return ids;
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
