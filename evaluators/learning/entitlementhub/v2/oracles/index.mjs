import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
export function canonicalJson(value) { if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value); if (typeof value === "number") { if (!Number.isFinite(value)) throw new TypeError("non-finite JSON number"); return Object.is(value, -0) ? "0" : JSON.stringify(value); } if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; if (typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`; throw new TypeError("value is not canonical JSON"); }

export function assertGrantIntervals(grants) {
  const groups = new Map(); for (const grant of grants) { const key = `${grant.subscriptionId}\0${grant.feature}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(grant); }
  for (const [key, values] of groups) { values.sort((a, b) => a.validFrom.localeCompare(b.validFrom) || a.grantRevision - b.grantRevision); const revisions = new Set(); for (let index = 0; index < values.length; index += 1) { const current = values[index]; assert.ok(!revisions.has(current.grantRevision), `${key} duplicate grantRevision`); revisions.add(current.grantRevision); if (index > 0) { const prior = values[index - 1]; assert.ok(prior.validUntil !== null, `${key} prior Grant remains open`); assert.equal(prior.validUntil, current.validFrom, `${key} Grant intervals must adjoin without gap or overlap`); } } }
  return true;
}

export function assertRefundConservation(subscriptions, revisions, refunds) {
  const revisionById = new Map(revisions.map((item) => [item.planRevisionId, item]));
  for (const subscription of subscriptions) { const charge = revisionById.get(subscription.planRevisionId)?.priceMinor; if (charge === undefined) continue; const reserved = refunds.filter((item) => item.subscriptionId === subscription.subscriptionId && ["SUCCEEDED", "REQUESTED", "UNKNOWN"].includes(item.state)).reduce((sum, item) => sum + item.amountMinor, 0); assert.ok(reserved <= charge, `${subscription.subscriptionId} refund reservation ${reserved} exceeds ${charge}`); }
  return true;
}

export function assertPoolClosure(pool, assignments) {
  assert.ok(Number.isSafeInteger(pool.seatLimit) && pool.seatLimit > 0); assert.ok(Number.isSafeInteger(pool.version) && pool.version >= 0); const active = assignments.filter(({ state }) => state === "ACTIVE"); assert.equal(new Set(assignments.map(({ subjectId }) => subjectId)).size, assignments.length, "Pool subject history duplicates identity"); if (pool.state === "ACTIVE") assert.ok(active.length <= pool.seatLimit, "ACTIVE Pool oversells capacity"); if (active.length > pool.seatLimit) assert.equal(pool.state, "OVER_LIMIT", "over-capacity Pool is not OVER_LIMIT"); if (["REVOKED", "EXPIRED"].includes(pool.state)) assert.equal(active.length, 0, "terminal Pool retains ACTIVE Seat"); return true;
}

export function assertFenceMonotonic(values) { const groups = new Map(); for (const item of values) { const key = `${item.tenantId}\0${item.subjectId}`; const previous = groups.get(key) ?? -1; assert.ok(item.revocationVersion >= previous, `${key} revocation fence regressed`); groups.set(key, item.revocationVersion); } return true; }
export function assertEventSequence(events) { const next = new Map(); for (const event of events) { const expected = (next.get(event.aggregateId) ?? 0) + 1; assert.equal(event.sequence, expected, `${event.aggregateId} event sequence`); next.set(event.aggregateId, event.sequence); } return true; }
function scalar(left, right) { if (left === right) return 0; if (left === null) return -1; if (right === null) return 1; if (typeof left === "boolean" && typeof right === "boolean") return left ? 1 : -1; if (Number.isSafeInteger(left) && Number.isSafeInteger(right)) return left - right; return Buffer.from(String(left)).compare(Buffer.from(String(right))); }
export function compareBy(paths) { return (left, right) => { for (const path of paths) { const value = scalar(left[path], right[path]); if (value) return value; } return Buffer.from(canonicalJson(left)).compare(Buffer.from(canonicalJson(right))); }; }
export function assertSorted(values, paths) {
  const compare = compareBy(paths);
  for (let index = 1; index < values.length; index += 1) {
    assert.ok(compare(values[index - 1], values[index]) <= 0, `${paths.join(",")} canonical order: inversion at index ${index}`);
  }
  return true;
}
export function percentile(values, fraction) { if (!values.length) return 0; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]; }
