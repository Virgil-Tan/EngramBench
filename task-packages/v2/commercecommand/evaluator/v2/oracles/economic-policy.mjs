import assert from 'node:assert/strict';
import { candidateAssert } from '../lib/execution.mjs';
import { resource } from './index.mjs';

// Independent oracle for the public 2026-09-07.1 policy. Never imports submission code.
function exact(value, label = 'minor units') {
  assert(Number.isSafeInteger(value), `${label} must be an exact safe integer`);
  return BigInt(value);
}
function number(value) {
  const result = Number(value);
  assert(Number.isSafeInteger(result) && BigInt(result) === value, 'projection exceeds public integer range');
  return result;
}
const sum = values => values.reduce((total, value) => total + exact(value), 0n);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function waterfall(amount, capacities) {
  let remaining = exact(amount);
  assert(remaining >= 0n, 'waterfall amount cannot be negative');
  const result = capacities.map(value => {
    const capacity = exact(value);
    assert(capacity >= 0n, 'waterfall capacity cannot be negative');
    const selected = remaining < capacity ? remaining : capacity;
    remaining -= selected;
    return number(selected);
  });
  assert.equal(remaining, 0n, 'waterfall amount exceeds conserved capacity');
  return result;
}

export function settlementFee(grossMinor) {
  const gross = exact(grossMinor);
  assert(gross >= 0n);
  return number((gross * 200n + 5000n) / 10000n);
}

export function projectOrder(snapshot, orderId) {
  const order = resource(snapshot, 'orders').find(item => item.orderId === orderId);
  assert(order, `missing order ${orderId}`);
  const lines = resource(snapshot, 'orderLines').filter(item => item.orderId === orderId)
    .sort((a, b) => compare(a.orderLineId, b.orderLineId));
  assert.equal(sum(lines.map(item => item.lineTotalMinor)), exact(order.orderTotalMinor), 'line totals conserve order');
  const captures = waterfall(order.capturedMinor, lines.map(item => item.lineTotalMinor));
  const refunds = waterfall(order.refundedMinor, captures);
  const attempts = new Set(resource(snapshot, 'paymentAttempts').filter(item => item.orderId === orderId).map(item => item.paymentAttemptId));
  const disputes = resource(snapshot, 'commerceDisputes').filter(item => attempts.has(item.paymentAttemptId) && ['OPEN', 'LOST'].includes(item.state))
    .sort((a, b) => compare(a.providerDisputeId, b.providerDisputeId));
  const retained = number(sum(disputes.map(item => item.amountMinor)));
  const disputeShares = waterfall(retained, captures.map((amount, index) => amount - refunds[index]));
  const allAllocations = resource(snapshot, 'sellerAllocations').filter(item => item.orderId === orderId);
  const projected = [], projectedLines = [];
  lines.forEach((line, index) => {
    const capturedMinor = captures[index], refundedMinor = refunds[index];
    projectedLines.push({ ...line, capturedMinor, refundedMinor, disputeReserveMinor: disputeShares[index],
      remainingLicensedQuantity: capturedMinor === 0 ? 0 : number(exact(line.quantity) - exact(line.quantity) * exact(refundedMinor) / exact(capturedMinor)) });
    if (!allAllocations.length) return;
    const allocations = allAllocations.filter(item => item.orderLineId === line.orderLineId)
      .sort((a, b) => compare(a.sellerId, b.sellerId) || compare(a.sellerAllocationId, b.sellerAllocationId));
    assert.equal(sum(allocations.map(item => item.quantity)), exact(line.quantity), 'seller quantities conserve each line');
    assert.equal(sum(allocations.map(item => item.amountMinor)), exact(line.lineTotalMinor), 'seller amounts conserve each line');
    assert(allocations.every(item => item.tenantId === order.tenantId), 'seller allocation tenant');
    const sellerCaptures = waterfall(capturedMinor, allocations.map(item => item.amountMinor));
    const sellerRefunds = waterfall(refundedMinor, sellerCaptures);
    const sellerDisputes = waterfall(disputeShares[index], sellerCaptures.map((value, i) => value - sellerRefunds[i]));
    allocations.forEach((allocation, i) => projected.push({ ...allocation, currency: order.currency,
      capturedMinor: sellerCaptures[i], refundReserveMinor: sellerRefunds[i], disputeReserveMinor: sellerDisputes[i] }));
  });
  return { lines: projectedLines, allocations: projected };
}

export function settlementProjection(snapshot, proposal, { consumedAdjustmentIds = [] } = {}) {
  assert(Date.parse(proposal.periodStart) < Date.parse(proposal.periodEnd), 'half-open settlement period');
  const closedElsewhere = new Set(resource(snapshot, 'sellerSettlements')
    .filter(item => item.state === 'CLOSED' && item.sellerSettlementId !== proposal.sellerSettlementId)
    .flatMap(item => item.allocationIds));
  const allocations = resource(snapshot, 'orders').filter(item => item.tenantId === proposal.tenantId && item.currency === proposal.currency)
    .flatMap(item => projectOrder(snapshot, item.orderId).allocations)
    .filter(item => item.sellerId === proposal.sellerId && item.capturedMinor > 0 && !closedElsewhere.has(item.sellerAllocationId));
  const consumed = new Set(consumedAdjustmentIds);
  const settlements = resource(snapshot, 'sellerSettlements');
  const adjustments = resource(snapshot, 'settlementAdjustments').filter(item => {
    const source = settlements.find(value => value.sellerSettlementId === item.sourceSettlementId);
    return item.tenantId === proposal.tenantId && item.sellerId === proposal.sellerId && source?.currency === proposal.currency
      && !consumed.has(item.settlementAdjustmentId) && Date.parse(item.targetPeriodStart) >= Date.parse(proposal.periodStart)
      && Date.parse(item.targetPeriodStart) < Date.parse(proposal.periodEnd);
  });
  const grossMinor = number(sum(allocations.map(item => item.capturedMinor)));
  const feeMinor = settlementFee(grossMinor);
  const refundReserveMinor = number(sum(allocations.map(item => item.refundReserveMinor)));
  const disputeReserveMinor = number(sum(allocations.map(item => item.disputeReserveMinor)));
  const includedAdjustmentMinor = number(sum(adjustments.map(item => item.amountMinor)));
  return { allocationIds: allocations.map(item => item.sellerAllocationId).sort(), grossMinor, feeMinor,
    refundReserveMinor, disputeReserveMinor,
    netMinor: number(exact(grossMinor) - exact(feeMinor) - exact(refundReserveMinor) - exact(disputeReserveMinor) + exact(includedAdjustmentMinor)),
    adjustmentIds: adjustments.map(item => item.settlementAdjustmentId).sort(), includedAdjustmentMinor };
}

export function assertSettlement(actual, expected) {
  candidateAssert.equal(actual.state, 'CLOSED', 'close returned a durable CLOSED settlement');
  for (const field of ['allocationIds', 'grossMinor', 'feeMinor', 'refundReserveMinor', 'disputeReserveMinor', 'netMinor']) {
    candidateAssert.deepEqual(actual[field], expected[field], `closed settlement ${field}`);
  }
}

export function withholdingAdjustment(atClose, current, alreadyAdjustedMinor = 0) {
  return number(exact(atClose.refundReserveMinor) + exact(atClose.disputeReserveMinor)
    - exact(current.refundReserveMinor) - exact(current.disputeReserveMinor) - exact(alreadyAdjustedMinor));
}

export function nextAdjustmentPeriod(snapshot, source) {
  const candidates = resource(snapshot, 'sellerSettlements').filter(item => item.state === 'OPEN' && item.tenantId === source.tenantId
    && item.sellerId === source.sellerId && item.currency === source.currency && Date.parse(item.periodStart) >= Date.parse(source.periodEnd))
    .sort((a, b) => Date.parse(a.periodStart) - Date.parse(b.periodStart) || compare(a.sellerSettlementId, b.sellerSettlementId));
  return candidates[0]?.periodStart ?? source.periodEnd;
}
