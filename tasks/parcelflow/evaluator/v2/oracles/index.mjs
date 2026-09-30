import assert from "node:assert/strict";

function canonicalUuid(value) {
  return String(value).toLowerCase().replaceAll("-", "");
}

function warehouseOrder(left, right) {
  return left.priority - right.priority || canonicalUuid(left.id).localeCompare(canonicalUuid(right.id));
}

function stockMap(stock) {
  return new Map(stock.map((item) => [`${item.warehouseId}:${item.skuId}`, item.available ?? item.onHand - (item.reserved ?? 0)]));
}

export function allocationPlan(warehouseInput, lineInput, stockInput, { allowSplit = false } = {}) {
  const warehouses = [...warehouseInput].sort(warehouseOrder);
  const lines = [...lineInput].sort((left, right) => canonicalUuid(left.skuId).localeCompare(canonicalUuid(right.skuId)));
  const available = stockMap(stockInput);
  const complete = warehouses.find((warehouse) => lines.every((line) => (available.get(`${warehouse.id}:${line.skuId}`) ?? 0) >= line.quantity));
  if (complete) {
    return {
      kind: "single",
      fulfillments: [{
        warehouseId: complete.id,
        allocations: lines.map(({ skuId, quantity }) => ({ skuId, quantity })),
      }],
    };
  }
  if (!allowSplit) return { kind: "rejected", code: "NO_SINGLE_WAREHOUSE_CAPACITY", fulfillments: [] };

  const remaining = new Map(available);
  const groups = new Map();
  for (const line of lines) {
    let needed = line.quantity;
    for (const warehouse of warehouses) {
      if (needed === 0) break;
      const key = `${warehouse.id}:${line.skuId}`;
      const quantity = Math.min(needed, remaining.get(key) ?? 0);
      if (quantity === 0) continue;
      remaining.set(key, (remaining.get(key) ?? 0) - quantity);
      if (!groups.has(warehouse.id)) groups.set(warehouse.id, []);
      groups.get(warehouse.id).push({ skuId: line.skuId, quantity });
      needed -= quantity;
    }
    if (needed > 0) return { kind: "rejected", code: "NO_SINGLE_WAREHOUSE_CAPACITY", fulfillments: [] };
  }
  return {
    kind: "split",
    fulfillments: warehouses.flatMap((warehouse) => groups.has(warehouse.id)
      ? [{ warehouseId: warehouse.id, allocations: groups.get(warehouse.id) }]
      : []),
  };
}

export function inventoryProjection(position, quantity, transition) {
  if (!Number.isSafeInteger(quantity) || quantity < 0) throw new TypeError("quantity must be a non-negative safe integer");
  let { onHand, reserved } = position;
  if (transition === "allocate") reserved += quantity;
  else if (transition === "cancel") reserved -= quantity;
  else if (transition === "ship") { reserved -= quantity; onHand -= quantity; }
  else throw new TypeError(`unknown inventory transition: ${transition}`);
  assert.ok(Number.isSafeInteger(onHand) && Number.isSafeInteger(reserved));
  assert.ok(reserved >= 0 && reserved <= onHand, `invalid inventory projection ${reserved}/${onHand}`);
  return { onHand, reserved, available: onHand - reserved };
}

export function assertInventoryInvariant(positions, unsettled = new Map()) {
  for (const position of positions) {
    assert.ok(Number.isSafeInteger(position.onHand));
    assert.ok(Number.isSafeInteger(position.reserved));
    assert.ok(position.reserved >= 0 && position.reserved <= position.onHand);
    assert.equal(position.available, position.onHand - position.reserved);
    const key = `${position.warehouseId}:${position.skuId}`;
    if (unsettled.has(key)) assert.equal(position.reserved, unsettled.get(key));
  }
  return true;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function canonicalJson(value) { return canonical(value); }

export function canonicalMutation(operation, input) {
  const normalized = structuredClone(input);
  if (operation === "create-order" && Array.isArray(normalized?.lines)) {
    normalized.lines.sort((left, right) => canonicalUuid(left.skuId).localeCompare(canonicalUuid(right.skuId)));
  }
  return canonical(normalized);
}

export function fulfillmentGroups(order) {
  if (Array.isArray(order?.fulfillments)) return order.fulfillments;
  return order?.fulfillment ? [order.fulfillment] : [];
}

export function assertOrderTerminal(order) {
  const groups = fulfillmentGroups(order);
  assert.ok(groups.length > 0);
  if (order.status === "CANCELLED") {
    assert.ok(groups.every(({ status, shipment }) => status === "CANCELLED" && shipment === null));
    return "cancelled";
  }
  if (order.status === "SHIPPED") {
    assert.ok(groups.every(({ status, shipment }) => status === "SHIPPED" && typeof shipment?.id === "string"));
    assert.equal(new Set(groups.map(({ shipment }) => shipment.id)).size, groups.length);
    return "shipped";
  }
  throw new Error(`order ${order.id ?? "<unknown>"} is not terminal`);
}

export function assertEventLedger(entries, expectedOrderIds = []) {
  const identities = new Map();
  const nextSequence = new Map();
  const successfulOrders = new Set();
  for (const entry of entries) {
    const event = entry.json;
    assert.ok(event && typeof event.eventId === "string", "invalid Event body");
    assert.equal(entry.headers["x-parcelflow-event-id"], event.eventId);
    assert.equal(entry.headers["x-parcelflow-event-type"], event.type);
    assert.equal(event.aggregateType, "order");
    assert.equal(event.aggregateId, event.data?.orderId);
    const body = canonical(event);
    if (identities.has(event.eventId)) assert.equal(identities.get(event.eventId), body, `Event ${event.eventId} changed across retry`);
    else identities.set(event.eventId, body);
    if (!entry.acknowledged || entry.responseStatus < 200 || entry.responseStatus >= 300) continue;
    successfulOrders.add(event.aggregateId);
    const current = nextSequence.get(event.aggregateId) ?? 1;
    if (event.sequence < current) continue;
    assert.equal(event.sequence, current, `Order ${event.aggregateId} successful Event sequence skipped`);
    nextSequence.set(event.aggregateId, current + 1);
  }
  for (const orderId of expectedOrderIds) assert.ok(successfulOrders.has(orderId), `Order ${orderId} has no successful Event`);
  return { uniqueEvents: identities.size, successfulOrders: successfulOrders.size };
}

export function percentile(values, fraction) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * fraction) - 1))];
}
