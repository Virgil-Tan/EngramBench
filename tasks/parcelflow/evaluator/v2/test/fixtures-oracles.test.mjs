import assert from "node:assert/strict";
import test from "node:test";

import {
  createFixtureFactory,
  makeAllocationFixture,
  makeSplitFixture,
} from "../fixtures/index.mjs";
import {
  allocationPlan,
  assertEventLedger,
  canonicalMutation,
  inventoryProjection,
} from "../oracles/index.mjs";

const options = {
  evaluationSeed: "parcel-flow-private-seed",
  caseId: "B-01",
  baseTime: "2035-06-01T12:00:00.000Z",
};

test("fixture factory is deterministic and case scoped", () => {
  const first = createFixtureFactory(options);
  const replay = createFixtureFactory(options);
  const other = createFixtureFactory({ ...options, caseId: "B-02" });
  assert.equal(first.uuid("warehouse"), replay.uuid("warehouse"));
  assert.notEqual(first.uuid("warehouse"), other.uuid("warehouse"));
  assert.equal(first.key("order"), replay.key("order"));
});

test("single-warehouse-first wins before split", () => {
  const fixture = makeAllocationFixture(options);
  const plan = allocationPlan(fixture.warehouses, fixture.lines, fixture.stock, { allowSplit: true });
  assert.equal(plan.kind, "single");
  assert.equal(plan.fulfillments.length, 1);
  assert.equal(plan.fulfillments[0].warehouseId, fixture.completeWarehouseId);
});

test("FINAL split oracle is stable by sku then warehouse and groups once", () => {
  const fixture = makeSplitFixture({ ...options, caseId: "B-03" });
  const forward = allocationPlan(fixture.warehouses, fixture.lines, fixture.stock, { allowSplit: true });
  const reverse = allocationPlan(fixture.warehouses, [...fixture.lines].reverse(), fixture.stock, { allowSplit: true });
  assert.deepEqual(forward, reverse);
  assert.equal(forward.kind, "split");
  assert.equal(new Set(forward.fulfillments.map(({ warehouseId }) => warehouseId)).size, forward.fulfillments.length);
});

test("inventory projection distinguishes reservation, cancellation, and shipment", () => {
  assert.deepEqual(inventoryProjection({ onHand: 10, reserved: 0 }, 4, "allocate"), { onHand: 10, reserved: 4, available: 6 });
  assert.deepEqual(inventoryProjection({ onHand: 10, reserved: 4 }, 4, "cancel"), { onHand: 10, reserved: 0, available: 10 });
  assert.deepEqual(inventoryProjection({ onHand: 10, reserved: 4 }, 4, "ship"), { onHand: 6, reserved: 0, available: 6 });
});

test("order-line order is semantically canonical but values are not", () => {
  const left = { customerReference: "c", lines: [{ skuId: "b", quantity: 2 }, { skuId: "a", quantity: 1 }] };
  const right = { lines: [{ quantity: 1, skuId: "a" }, { quantity: 2, skuId: "b" }], customerReference: "c" };
  assert.equal(canonicalMutation("create-order", left), canonicalMutation("create-order", right));
  assert.notEqual(canonicalMutation("create-order", left), canonicalMutation("create-order", { ...right, customerReference: "d" }));
});

test("event oracle requires stable identity/body and contiguous successful order sequence", () => {
  const event = {
    eventId: "11111111-1111-4111-8111-111111111111",
    type: "order.allocated",
    aggregateType: "order",
    aggregateId: "22222222-2222-4222-8222-222222222222",
    sequence: 1,
    occurredAt: "2035-06-01T12:00:00.000Z",
    data: { orderId: "22222222-2222-4222-8222-222222222222" },
  };
  const entry = {
    headers: { "x-parcelflow-event-id": event.eventId, "x-parcelflow-event-type": event.type },
    json: event,
    acknowledged: true,
    responseStatus: 204,
  };
  assert.deepEqual(assertEventLedger([entry], [event.aggregateId]), { uniqueEvents: 1, successfulOrders: 1 });
  assert.throws(() => assertEventLedger([{ ...entry, headers: { ...entry.headers, "x-parcelflow-event-id": "changed" } }], [event.aggregateId]));
});
