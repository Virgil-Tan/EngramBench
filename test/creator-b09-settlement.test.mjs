import test from 'node:test';
import assert from 'node:assert/strict';
import { waitHoldPaymentRefund } from '../evaluators/transfer/creatorrightsexchange/v2/cases/b.mjs';

const ids = { holdId: 'hold', refundId: 'refund', purchaseOrderId: 'order' };
const frame = state => ({ resources: {
  licenseHolds: [{ licenseHoldId: 'hold', state: 'ACTIVE' }],
  refunds: [{ refundId: 'refund', state: 'SUCCEEDED' }],
  purchaseOrders: [{ purchaseOrderId: 'order', state }],
} });
async function replay(frames) {
  let reads = 0;
  const workers = [{}];
  const ctx = {
    snapshot: async () => frames[Math.min(reads++, frames.length - 1)],
    waitFor: async (poll, options) => {
      assert.equal(options.timeoutMs, 180_000);
      assert.equal(options.processes, workers);
      for (let n = 0; n < frames.length; n++) { const value = await poll(); if (value) return value; }
      throw new Error('bounded wait expired');
    },
  };
  const result = await waitHoldPaymentRefund(ctx, 'http://unused', ids, workers);
  return { result, reads };
}
test('B09 waits for its own payment even when Hold and refund have finished', async () => {
  const { result, reads } = await replay([frame('PAYMENT_PENDING'), frame('LICENSE_HELD')]);
  assert.equal(reads, 2);
  assert.equal(result.resources.purchaseOrders[0].state, 'LICENSE_HELD');
});
test('B09 never treats a permanently pending payment as success', async () => {
  await assert.rejects(replay([frame('PAYMENT_PENDING'), frame('PAYMENT_PENDING')]), /bounded wait expired/);
});
test('B09 returns wrong terminal outcomes to the unchanged business assertions', async () => {
  for (const state of ['FAILED', 'BLOCKED', 'REVIEW']) {
    const { result, reads } = await replay([frame(state), frame('LICENSE_HELD')]);
    assert.equal(reads, 1);
    assert.throws(() => assert(['LICENSE_HELD', 'LICENSED'].includes(result.resources.purchaseOrders[0].state)));
  }
});
