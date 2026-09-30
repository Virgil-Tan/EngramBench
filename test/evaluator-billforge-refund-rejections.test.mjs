import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setImmediate as tick } from 'node:timers/promises';
import * as bill from '../evaluators/learning/billforge/v2/lib/fixtures.mjs';
import { COMPAT_CASES } from '../evaluators/learning/billforge/v2/cases/compat.mjs';

async function probe(mode) {
  const f = bill.createFixtureFactory({ evaluationSeed: 'refund-rejection-regression', caseId: 'COMPAT-03', baseTime: '2026-09-07T00:00:00.000Z' });
  const refundError = new Error('injected refund socket failure');
  let resources, invoice, seedCalls = 0, observations = 0;
  const requests = [];
  const ctx = {
    fixtures: f, uuid: f.uuid, key: f.key, at: f.at,
    command: async () => ({}), npm: async () => ({}), migrate: async () => {},
    startApi: async () => ({ baseUrl: 'http://author.invalid' }), startWorker: async () => ({}),
    waitFor: operation => operation(),
    seed: async value => {
      if (++seedCalls === 1) {
        const { schemaVersion, seedVersion, importedAt, ...initial } = structuredClone(value);
        resources = initial;
      }
      return { exitCode: seedCalls <= 2 ? 0 : 1, stdout: seedCalls === 3 ? 'SEED_VERSION_CONFLICT' : '', stderr: '' };
    },
    snapshot: async () => {
      const snapshot = structuredClone({ asOf: f.at(), resources, work: [], events: [] });
      if (requests.length) {
        assert.equal(requests.length, 8, 'all refunds must launch before observing snapshots');
        observations++;
        if (mode === 'snapshot-first') {
          const current = snapshot.resources.invoices.find(value => value.invoiceId === invoice.invoiceId);
          current.paidMinor--; current.outstandingMinor++;
        } else await tick();
      }
      return snapshot;
    },
    mutate: async (_url, path, key, body) => {
      if (path === '/api/v1/invoices') {
        invoice = bill.invoice(f, 'created', resources.tenants[0], resources.customers[0], resources.subscriptions[0], resources.exchangeRateSnapshots[0], { state: 'DRAFT', finalizedAt: null });
        resources.invoices.push(invoice);
        resources.invoices.sort((a, b) => Buffer.compare(Buffer.from(a.invoiceId), Buffer.from(b.invoiceId)));
        return { status: 200, json: invoice };
      }
      if (path.endsWith('/finalize')) { invoice.state = 'OPEN'; invoice.finalizedAt = f.at(); return { status: 200, json: invoice }; }
      if (path === '/api/v1/payment-intents') {
        const payment = bill.paymentIntent(f, 'captured', invoice, { state: 'SUCCEEDED', resolvedAt: f.at() });
        resources.paymentIntents.push(payment);
        resources.paymentIntents.sort((a, b) => Buffer.compare(Buffer.from(a.paymentIntentId), Buffer.from(b.paymentIntentId)));
        invoice.paidMinor = payment.amountMinor; invoice.outstandingMinor = 0;
        return { status: 200, json: payment };
      }
      assert(path.endsWith('/refunds'));
      requests.push({ key, body });
      if (mode === 'snapshot-first') await tick();
      if (['refund-first', 'snapshot-first'].includes(mode)) throw refundError;
      return { status: 409, json: { error: { code: mode === 'bad-response' ? 'WRONG_CODE' : 'REFUND_AMOUNT_EXCEEDED', message: 'refund bound', details: {} } } };
    },
  };
  const operation = COMPAT_CASES.find(c => c.id === 'COMPAT-03').run(ctx);
  if (mode === 'refund-first') await assert.rejects(operation, error => error === refundError);
  else if (mode === 'snapshot-first') await assert.rejects(operation, /Invoice paidMinor does not match successful payments/);
  else if (mode === 'bad-response') await assert.rejects(operation, /WRONG_CODE/);
  else {
    const result = await operation;
    assert.equal(result.evidence.acceptedRefunds, 0);
    assert.equal(result.evidence.rejectedRefunds, 8);
    assert.equal(result.evidence.observedSnapshots.length, 5);
  }
  await tick(); await tick();
  assert.equal(requests.length, 8);
  assert.equal(new Set(requests.map(value => value.key)).size, 8);
  assert(requests.every(value => value.body.amountMinor === 2000));
  assert.equal(observations, mode === 'snapshot-first' ? 1 : mode === 'valid' ? 6 : 5);
}

if (process.argv[2]) await probe(process.argv[2]);
else for (const [mode, description] of [
  ['refund-first', 'captures immediate refund rejection while snapshots yield, then rethrows the original failure'],
  ['snapshot-first', 'preserves an early accounting assertion without leaking later refund rejections'],
  ['bad-response', 'still rejects an incorrect refund error response'],
  ['valid', 'keeps all eight parallel requests and five accounting observations'],
]) test(`BillForge COMPAT-03 ${description}`, () => {
  execFileSync(process.execPath, ['--unhandled-rejections=strict', fileURLToPath(import.meta.url), mode], { encoding: 'utf8', stdio: 'pipe', timeout: 5000 });
});
