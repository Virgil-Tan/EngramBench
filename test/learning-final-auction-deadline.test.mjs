import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { BID_CASES } from '../evaluators/learning/auctionguard/v2/cases/bid.mjs';
import { createCaseContext } from '../evaluators/learning/auctionguard/v2/lib/runtime.mjs';

// Exercise the actual evaluator oracle against controlled responses; no candidate runs here.
async function deadlineOracle(t, wronglyAccept) {
  const ctx = await createCaseContext({ caseId: 'BID-04', workspace: resolve(import.meta.dirname, '..'), evaluationSeed: 'deadline-oracle', manageDatabase: false });
  t.after(() => ctx.teardown());
  let phase = 'OPEN', waited = false;
  const rejectedStates = [];
  ctx.seed = async seed => { phase = seed.auctions[0].state; };
  ctx.startApi = async () => ({ baseUrl: 'http://127.0.0.1:1' });
  ctx.resetDatabase = ctx.migrate = async () => {};
  ctx.createAuction = async () => ({ status: 201, json: { auctionId: ctx.uuid('short-auction') } });
  ctx.openAuction = async () => { phase = 'OPEN'; return { status: 200 }; };
  ctx.sleep = async milliseconds => { assert.ok(milliseconds > 0 && milliseconds < 4_000); waited = true; };
  ctx.cancelAuction = async () => { phase = 'CANCELLED'; return { status: 200 }; };
  ctx.placeBid = async () => {
    // An earlier accepted bid would activate anti-sniping and invalidate this fixture.
    assert.ok(waited, 'the deadline fixture must stay bid-free until expiry');
    const state = phase === 'OPEN' ? 'EXPIRED' : phase;
    rejectedStates.push(state);
    return { status: state === wronglyAccept ? 201 : 409, json: { error: { code: 'AUCTION_NOT_OPEN', message: 'Not open', details: {} } }, text: '' };
  };
  const result = await BID_CASES.find(({ id }) => id === 'BID-04').run(ctx);
  assert.deepEqual(rejectedStates, ['EXPIRED', 'SCHEDULED', 'CANCELLED']);
  assert.ok(result.evidence.length > 0);
}

test('deadline oracle uses a bid-free auction and all three public state fences', t => deadlineOracle(t));
for (const state of ['EXPIRED', 'SCHEDULED', 'CANCELLED']) {
  test(`deadline oracle rejects a candidate that accepts ${state} bids`, async t => {
    await assert.rejects(deadlineOracle(t, state), /409|rejected/);
  });
}
