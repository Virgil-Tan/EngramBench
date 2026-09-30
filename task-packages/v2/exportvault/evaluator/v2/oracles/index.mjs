import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("RFC 8785 rejects non-finite numbers");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  throw new TypeError(`value is not RFC 8785 serializable: ${typeof value}`);
}

function ordered(records) { return [...records].sort((left, right) => Buffer.from(left.recordId).compare(Buffer.from(right.recordId))); }
export function jsonlBytes(records) { return Buffer.from(ordered(records).map((record) => `${canonicalJson(record.data)}\n`).join(""), "utf8"); }
function csvCell(value) { const text = String(value); return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
export function csvBytes(records) { return Buffer.from(`recordId,data\n${ordered(records).map((record) => `${record.recordId},${csvCell(canonicalJson(record.data))}\n`).join("")}`, "utf8"); }

export function sectionOracle(scope, records) {
  return scope.map((name) => {
    const selected = ordered(records.filter((record) => record.scope === name));
    return {
      name,
      recordCount: selected.length,
      firstRecordId: selected[0]?.recordId ?? null,
      lastRecordId: selected.at(-1)?.recordId ?? null,
      digest: sha256(Buffer.from(selected.map((record) => canonicalJson(record)).join("\n") + (selected.length ? "\n" : ""))),
    };
  });
}

export function rangeOracle(bytes, header) {
  const value = Buffer.from(bytes);
  if (!header) return { status: 200, start: 0, end: value.length - 1, body: value };
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header);
  if (!match || (match[1] === "" && match[2] === "")) return { status: 416, body: Buffer.alloc(0) };
  let start; let end;
  if (match[1] === "") { const suffix = Number(match[2]); if (!Number.isSafeInteger(suffix) || suffix <= 0) return { status: 416, body: Buffer.alloc(0) }; start = Math.max(0, value.length - suffix); end = value.length - 1; }
  else { start = Number(match[1]); end = match[2] === "" ? value.length - 1 : Number(match[2]); }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= value.length || end < start) return { status: 416, body: Buffer.alloc(0) };
  end = Math.min(end, value.length - 1);
  return { status: 206, start, end, body: value.subarray(start, end + 1) };
}

export function planShards(sections, maximum = 100000) {
  const plan = [];
  for (const section of sections) {
    const ids = [...section.recordIds].sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
    let priorBoundary = null;
    for (let offset = 0; offset < ids.length; offset += maximum) {
      const slice = ids.slice(offset, offset + maximum);
      plan.push({
        ordinal: plan.length,
        section: section.name,
        range: { afterRecordId: priorBoundary, throughRecordId: slice.at(-1) ?? null },
        recordCount: slice.length,
      });
      priorBoundary = slice.at(-1) ?? priorBoundary;
    }
  }
  return plan;
}

export function manifestBytes(shards) { return Buffer.from(canonicalJson(shards), "utf8"); }
export function assertManifest(manifest, downloaded) {
  const bytes = Buffer.from(downloaded);
  assert.equal(manifest.canonicalDigest, sha256(bytes));
  assert.equal(manifest.object.sha256, sha256(bytes));
  assert.equal(manifest.object.size, bytes.length);
  assert.equal(manifest.object.mediaType, "application/json");
  assert.deepEqual(JSON.parse(bytes), manifest.shards);
  return manifest;
}

function scalarCompare(left, right) {
  if (left === right) return 0;
  if (left === null) return -1; if (right === null) return 1;
  if (typeof left === "boolean" && typeof right === "boolean") return left ? 1 : -1;
  if (Number.isSafeInteger(left) && Number.isSafeInteger(right)) return left - right;
  return Buffer.from(String(left)).compare(Buffer.from(String(right)));
}
export function compareBy(paths) { return (left, right) => { for (const path of paths) { const order = scalarCompare(left[path], right[path]); if (order) return order; } return Buffer.from(canonicalJson(left)).compare(Buffer.from(canonicalJson(right))); }; }
export function assertSorted(values, paths) { assert.deepEqual(values, [...values].sort(compareBy(paths)), `${paths.join(",")} canonical sort`); }
export function assertEventSequence(events) { const next = new Map(); for (const event of events) { const expected = (next.get(event.aggregateId) ?? 0) + 1; assert.equal(event.sequence, expected, `${event.aggregateId} event sequence`); next.set(event.aggregateId, event.sequence); } return true; }
export function percentile(values, fraction) { if (!values.length) return 0; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]; }
