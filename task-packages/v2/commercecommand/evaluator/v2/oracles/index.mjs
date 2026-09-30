import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { assertSnapshotSchema } from './openapi.mjs';

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");
}

export function exactKeys(value, keys, label = "value") {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} fields`);
}

export function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

export function resource(snapshot, key) {
  const value = snapshot?.resources?.[key] ?? snapshot?.managerResources?.[key];
  assert.ok(Array.isArray(value), `verification snapshot is missing ${key}`);
  return value;
}

export function stableSnapshot(snapshot) {
  const value = structuredClone(snapshot);
  delete value.asOf;
  for (const work of value.work ?? []) delete work.leaseExpiresAt;
  return canonicalJson(value);
}

export function quoteOracle(lines, offersByProduct) {
  return lines.map(({ productId, quantity }) => {
    assert.ok(Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= 1_000, "quote quantity boundary");
    const offer = offersByProduct.get(productId);
    assert.ok(offer, `missing frozen offer for ${productId}`);
    const lineTotalMinor = quantity * (offer.unitPriceMinor + offer.taxMinor);
    assert.ok(Number.isSafeInteger(lineTotalMinor), "line total must be a safe integer");
    return { productId, quantity, offerVersionId: offer.offerVersionId, unitPriceMinor: offer.unitPriceMinor, taxMinor: offer.taxMinor, lineTotalMinor };
  });
}

export function allocateByPriority(quantity, pools) {
  let remaining = quantity;
  const allocations = [];
  const ordered = [...pools].sort((left, right) => left.priority - right.priority || Buffer.from(left.inventoryPoolId).compare(Buffer.from(right.inventoryPoolId)));
  for (const pool of ordered) {
    const available = pool.onHand - pool.reserved;
    const selected = Math.min(remaining, available);
    if (selected > 0) allocations.push({ inventoryPoolId: pool.inventoryPoolId, quantity: selected });
    remaining -= selected;
    if (remaining === 0) break;
  }
  return remaining === 0 ? allocations : null;
}

export function assertAllocations(actual, expected) {
  const sort = rows => [...rows].sort((a, b) => a.inventoryPoolId.localeCompare(b.inventoryPoolId));
  assert.deepEqual(sort(actual), sort(expected), 'the selected pool quantities match priority allocation independently of snapshot hold-ID order');
}

export function assertPaymentPrecedence(outcomes) {
  const rank = { UNKNOWN: 0, DECLINED: 1, CAPTURED: 2 };
  return outcomes.reduce((winner, outcome) => rank[outcome] > rank[winner] ? outcome : winner, "UNKNOWN");
}

export function assertCoreInvariants(snapshot) {
  assertSnapshotSchema(snapshot);
  assert.ok(snapshot && typeof snapshot === "object", "verification snapshot object");
  assert.ok(Array.isArray(snapshot.events) && Array.isArray(snapshot.work), "snapshot events and work arrays");
  const pools = resource(snapshot, "inventoryPools");
  const holds = resource(snapshot, "inventoryHolds");
  const lines = resource(snapshot, "orderLines");
  const orders = resource(snapshot, "orders");
  const attempts = resource(snapshot, "paymentAttempts");
  const ledger = resource(snapshot, "ledgerEntries");
  const grants = resource(snapshot, "entitlementGrants");
  const notifications = resource(snapshot, "notificationDeliveries");

  for (const pool of pools) {
    assert.ok(Number.isSafeInteger(pool.onHand) && Number.isSafeInteger(pool.reserved), `pool ${pool.inventoryPoolId} integer stock`);
    assert.ok(pool.reserved >= 0 && pool.reserved <= pool.onHand, `pool ${pool.inventoryPoolId} capacity`);
    const held = holds.filter((item) => item.inventoryPoolId === pool.inventoryPoolId && item.state === "HELD").reduce((sum, item) => sum + item.quantity, 0);
    assert.equal(pool.reserved, held, `pool ${pool.inventoryPoolId} reserved equation`);
  }
  for (const hold of holds) {
    assert.ok(["HELD", "CONSUMED", "RELEASED", "EXPIRED"].includes(hold.state), `hold ${hold.inventoryHoldId ?? "unknown"} state`);
    assert.ok(Number.isSafeInteger(hold.quantity) && hold.quantity > 0, "hold positive integer quantity");
  }
  for (const line of lines) {
    const expected = line.quantity * (line.unitPriceMinor + line.taxMinor);
    assert.ok(Number.isSafeInteger(expected), `line ${line.orderLineId} safe total`);
    assert.equal(line.lineTotalMinor, expected, `line ${line.orderLineId} frozen total`);
  }
  for (const order of orders) {
    const selected = lines.filter((line) => line.orderId === order.orderId);
    assert.equal(order.orderTotalMinor, selected.reduce((sum, line) => sum + line.lineTotalMinor, 0), `order ${order.orderId} total`);
    assert.ok(Number.isSafeInteger(order.capturedMinor) && Number.isSafeInteger(order.refundedMinor), `order ${order.orderId} integer money`);
    assert.ok(order.refundedMinor >= 0 && order.refundedMinor <= order.capturedMinor && order.capturedMinor <= order.orderTotalMinor, `order ${order.orderId} payment bounds`);
    assert.ok(attempts.filter((attempt) => attempt.orderId === order.orderId && (attempt.state === "CAPTURED" || attempt.outcome === "CAPTURED")).length <= 1, `order ${order.orderId} one capture`);
  }

  const journals = new Map();
  for (const entry of ledger) {
    assert.ok(Number.isSafeInteger(entry.amountMinor) && entry.amountMinor > 0, `ledger ${entry.ledgerEntryId} positive integer`);
    assert.ok(["DEBIT", "CREDIT"].includes(entry.direction), `ledger ${entry.ledgerEntryId} direction`);
    const id = `${entry.tenantId}:${entry.journalId}:${entry.currency}`;
    const totals = journals.get(id) ?? { debit: 0, credit: 0 };
    totals[entry.direction.toLowerCase()] += entry.amountMinor;
    journals.set(id, totals);
  }
  for (const [id, totals] of journals) assert.equal(totals.debit, totals.credit, `journal ${id} balance`);

  for (const line of lines) {
    const order = orders.find((item) => item.orderId === line.orderId);
    if (order?.refundedMinor === order?.capturedMinor && line.fulfillmentKind === "DIGITAL") {
      assert.equal(grants.some((grant) => grant.orderLineId === line.orderLineId && grant.state === "ACTIVE"), false, `refunded digital line ${line.orderLineId} inactive`);
    }
  }

  const eventIds = new Set();
  for (const values of Map.groupBy(snapshot.events, (event) => `${event.tenantId ?? ""}:${event.aggregateId}`).values()) {
    const ordered = [...values].sort((left, right) => (left.aggregateSequence ?? left.sequence) - (right.aggregateSequence ?? right.sequence));
    for (let index = 0; index < ordered.length; index += 1) {
      const sequence = ordered[index].aggregateSequence ?? ordered[index].sequence;
      if (index > 0) assert.equal(sequence, (ordered[index - 1].aggregateSequence ?? ordered[index - 1].sequence) + 1, "Event sequence contiguous");
      assert.equal(eventIds.has(ordered[index].eventId), false, "Event identity unique");
      eventIds.add(ordered[index].eventId);
    }
  }
  assert.equal(new Set(snapshot.work.map(({ workId }) => workId)).size, snapshot.work.length, "Work identity unique");
  for (const work of snapshot.work) {
    assert.ok(["PENDING", "LEASED", "SUCCEEDED", "DEAD"].includes(work.state), `Work ${work.workId} state`);
    assert.ok(Number.isSafeInteger(work.attempts) && work.attempts >= 0, `Work ${work.workId} attempts`);
    assert.equal(typeof work.terminal, "boolean", `Work ${work.workId} terminal flag`);
    if (work.terminal) assert.ok(["SUCCEEDED", "DEAD"].includes(work.state), `Work ${work.workId} terminal state`);
  }
  assert.equal(new Set(notifications.map(({ notificationDeliveryId }) => notificationDeliveryId)).size, notifications.length, "notification identity unique");
  for (const values of Map.groupBy(notifications, ({ orderId }) => orderId).values()) {
    const sequences = values.map(({ aggregateSequence }) => aggregateSequence);
    assert.deepEqual(sequences, [...sequences].sort((left, right) => left - right), "per-Order notification sequence");
  }
  return true;
}

export function assertQuoteEffects(before, after, orderId, expectedLines) {
  const orders = resource(after, "orders").filter((item) => item.orderId === orderId);
  assert.equal(orders.length, 1, "one quoted Order");
  const lines = resource(after, "orderLines").filter((item) => item.orderId === orderId);
  assert.equal(lines.length, expectedLines.length, "complete quoted lines");
  for (const expected of expectedLines) {
    const line = lines.find((item) => item.productId === expected.productId);
    assert.ok(line, `quoted line ${expected.productId}`);
    for (const field of ["quantity", "offerVersionId", "unitPriceMinor", "taxMinor", "lineTotalMinor"]) assert.equal(line[field], expected[field], `quoted ${field}`);
    assert.equal(resource(after, "inventoryHolds").filter((hold) => hold.orderLineId === line.orderLineId).reduce((sum, hold) => sum + hold.quantity, 0), line.fulfillmentKind === "DIGITAL" ? 0 : line.quantity, "line hold conservation");
  }
  assert.equal(after.events.length, before.events.length + 1, "one OrderQuoted Event");
  assert.ok(after.work.some((work) => work.aggregateId === orderId && work.kind === "QUOTE_EXPIRY"), "QUOTE_EXPIRY Work");
  assert.ok(resource(after, "notificationDeliveries").some((delivery) => delivery.orderId === orderId), "quote notification");
}

export function assertNoSecrets(value, secrets = []) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of secrets.filter(Boolean)) assert.equal(text.includes(secret), false, "public evidence does not expose secret material");
  return true;
}
