import test from 'node:test';
import assert from 'node:assert/strict';
import { waterfall, settlementFee, projectOrder, settlementProjection, assertSettlement, withholdingAdjustment, nextAdjustmentPeriod } from '../evaluators/transfer/commercecommand/v2/oracles/economic-policy.mjs';

function financialState() {
  return { resources: {
    orders: [{ orderId: 'order', tenantId: 'tenant', currency: 'USD', orderTotalMinor: 2001, capturedMinor: 1500, refundedMinor: 700 }],
    orderLines: [
      { orderId: 'order', orderLineId: 'b', lineTotalMinor: 1000, quantity: 2, fulfillmentKind: 'DIGITAL' },
      { orderId: 'order', orderLineId: 'a', lineTotalMinor: 1001, quantity: 3, fulfillmentKind: 'DIGITAL' },
    ],
    sellerAllocations: [
      { orderId: 'order', orderLineId: 'a', sellerAllocationId: 'az', sellerId: 'z', tenantId: 'tenant', quantity: 1, amountMinor: 333 },
      { orderId: 'order', orderLineId: 'a', sellerAllocationId: 'aa', sellerId: 'a', tenantId: 'tenant', quantity: 2, amountMinor: 668 },
      { orderId: 'order', orderLineId: 'b', sellerAllocationId: 'by', sellerId: 'y', tenantId: 'tenant', quantity: 1, amountMinor: 500 },
      { orderId: 'order', orderLineId: 'b', sellerAllocationId: 'bx', sellerId: 'x', tenantId: 'tenant', quantity: 1, amountMinor: 500 },
    ],
    paymentAttempts: [{ paymentAttemptId: 'attempt', orderId: 'order' }],
    commerceDisputes: [
      { paymentAttemptId: 'attempt', providerDisputeId: '2', amountMinor: 150, state: 'LOST' },
      { paymentAttemptId: 'attempt', providerDisputeId: '1', amountMinor: 100, state: 'OPEN' },
      { paymentAttemptId: 'attempt', providerDisputeId: '0', amountMinor: 400, state: 'WON' },
    ],
    sellerSettlements: [], settlementAdjustments: [],
  } };
}
const proposal = (overrides = {}) => ({ sellerSettlementId: 'batch', tenantId: 'tenant', sellerId: 'z', currency: 'USD', state: 'OPEN',
  periodStart: '2030-01-01T00:00:00Z', periodEnd: '2030-02-01T00:00:00Z', allocationIds: [], ...overrides });

test('public 200bps fee uses exact half-up arithmetic including safe-integer boundary', () => {
  assert.equal(settlementFee(0), 0);
  assert.equal(settlementFee(24), 0);
  assert.equal(settlementFee(25), 1);
  assert.equal(settlementFee(1001), 20);
  assert.equal(settlementFee(Number.MAX_SAFE_INTEGER), Number((BigInt(Number.MAX_SAFE_INTEGER) * 200n + 5000n) / 10000n));
  assert.throws(() => settlementFee(1.5));
  assert.deepEqual(waterfall(7, [4, 5]), [4, 3]);
  assert.throws(() => waterfall(10, [4, 5]), /exceeds/);
});

test('cumulative capture/refund/dispute waterfall follows line then seller identity, not input order or request rounding', () => {
  const state = financialState(), result = projectOrder(state, 'order');
  assert.deepEqual(result.lines.map(item => [item.orderLineId, item.capturedMinor, item.refundedMinor, item.disputeReserveMinor, item.remainingLicensedQuantity]), [
    ['a', 1001, 700, 250, 1], ['b', 499, 0, 0, 2],
  ]);
  assert.deepEqual(result.allocations.map(item => [item.sellerAllocationId, item.capturedMinor, item.refundReserveMinor, item.disputeReserveMinor]), [
    ['aa', 668, 668, 0], ['az', 333, 32, 250], ['bx', 499, 0, 0], ['by', 0, 0, 0],
  ]);
  state.resources.orderLines.reverse();
  state.resources.sellerAllocations.reverse();
  assert.deepEqual(projectOrder(state, 'order'), result);
  state.resources.orders[0].refundedMinor = 1500;
  state.resources.commerceDisputes = [];
  assert(projectOrder(state, 'order').lines.every(item => item.remainingLicensedQuantity === 0));
});

test('oracle rejects nonconserving allocation and combined refund/dispute overcommit', () => {
  const bad = financialState();
  bad.resources.sellerAllocations[0].amountMinor -= 1;
  assert.throws(() => projectOrder(bad, 'order'), /seller amounts/);
  const over = financialState();
  over.resources.orders[0].refundedMinor = 1400;
  assert.throws(() => projectOrder(over, 'order'), /exceeds conserved capacity/);
});

test('close eligibility uses current capture, tenant/seller/currency and previously CLOSED membership, not batch capture date', () => {
  const state = financialState();
  const expected = settlementProjection(state, proposal());
  assert.deepEqual(expected, { allocationIds: ['az'], grossMinor: 333, feeMinor: 7, refundReserveMinor: 32, disputeReserveMinor: 250, netMinor: 44, adjustmentIds: [], includedAdjustmentMinor: 0 });
  assert.equal(settlementProjection(state, proposal({ sellerId: 'y' })).grossMinor, 0, 'uncaptured seller share ineligible');
  assert.equal(settlementProjection(state, proposal({ currency: 'EUR' })).grossMinor, 0);
  assert.equal(settlementProjection(state, proposal({ tenantId: 'other' })).grossMinor, 0);
  state.resources.sellerSettlements.push(proposal({ sellerSettlementId: 'prior', state: 'CLOSED', allocationIds: ['az'] }));
  assert.equal(settlementProjection(state, proposal()).grossMinor, 0);
  assert.doesNotThrow(() => assertSettlement({ ...expected, state: 'CLOSED' }, expected));
  assert.throws(() => assertSettlement({ ...expected, state: 'CLOSED', netMinor: 45 }, expected), /netMinor/);
});

test('adjustments are signed, half-open, same-currency, and consumed independently of allocation membership', () => {
  const state = financialState(), source = proposal({ sellerSettlementId: 'source', state: 'CLOSED', allocationIds: ['az'], periodStart: '2029-01-01T00:00:00Z', periodEnd: '2029-02-01T00:00:00Z' });
  state.resources.sellerSettlements.push(source);
  const adjustment = { settlementAdjustmentId: 'correction', tenantId: 'tenant', sellerId: 'z', sourceSettlementId: 'source', sourceAllocationId: 'az', targetPeriodStart: '2030-01-01T00:00:00Z', amountMinor: -7 };
  state.resources.settlementAdjustments.push(adjustment, { ...adjustment, settlementAdjustmentId: 'outside', targetPeriodStart: '2030-02-01T00:00:00Z', amountMinor: 100 });
  const expected = settlementProjection(state, proposal());
  assert.equal(expected.netMinor, -7);
  assert.deepEqual(expected.adjustmentIds, ['correction']);
  assert.equal(settlementProjection(state, proposal(), { consumedAdjustmentIds: ['correction'] }).netMinor, 0);
  assert.equal(nextAdjustmentPeriod(state, source), source.periodEnd, 'no open proposal uses source end');
  state.resources.sellerSettlements.push(proposal({ sellerSettlementId: 'later', periodStart: '2031-01-01T00:00:00Z', periodEnd: '2031-02-01T00:00:00Z' }), proposal());
  assert.equal(nextAdjustmentPeriod(state, source), proposal().periodStart);
});

test('late liabilities are deltas: reserved LOST zero, WON releases hold, unreserved loss debits once', () => {
  const reserved = { refundReserveMinor: 0, disputeReserveMinor: 100 }, clear = { refundReserveMinor: 0, disputeReserveMinor: 0 };
  assert.equal(withholdingAdjustment(reserved, reserved), 0);
  assert.equal(withholdingAdjustment(reserved, clear), 100);
  assert.equal(withholdingAdjustment(clear, reserved), -100);
  assert.equal(withholdingAdjustment(clear, { refundReserveMinor: 200, disputeReserveMinor: 150 }, -150), -200);
});
