import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { D_CASES } from '../evaluators/transfer/creatorrightsexchange/v2/cases/d.mjs';
import { FINAL_RESOURCE_KEYS } from '../evaluators/transfer/creatorrightsexchange/v2/cases/helpers.mjs';

const family = {
  tenant: { tenantId: 'tenant-test' }, edition: { editionId: 'edition-test', revision: 1 },
  creators: [{ creatorId: 'creator-test' }], license: { licenseId: 'license-test', buyerRef: 'buyer-test' },
  postingId: 'original-posting', royaltyPeriod: { royaltyPeriodId: 'closed-period', state: 'CLOSED' }, seed: {},
};
const fields = {
  dispute: [['tenantId', 'Tenant ID'], ['editionId', 'Edition ID'], ['claimantCreatorId', 'Claimant creator ID'], ['expectedEditionRevision', 'Expected edition revision', 'number'], ['licenseId', 'License ID'], ['reason', 'Reason'], ['evidenceRefs', 'Evidence refs']],
  hold: [['rightsDisputeId', 'Dispute ID'], ['scope', 'Scope'], ['licenseId', 'License ID'], ['reason', 'Reason']],
  resolve: [['rightsDisputeId', 'Dispute ID'], ['expectedRevision', 'Expected revision', 'number'], ['reason', 'Reason'], ['outcome', 'Outcome']],
  release: [['licenseHoldId', 'Hold ID'], ['expectedRevision', 'Expected revision', 'number'], ['reason', 'Reason']],
  adjustment: [['tenantId', 'Tenant ID'], ['originalPostingId', 'Original posting ID'], ['amountMinor', 'Amount minor', 'number'], ['currency', 'Currency'], ['targetPeriodStart', 'Target period start'], ['reason', 'Reason']],
};
const actions = { dispute: 'Create rights dispute', hold: 'Create license hold', resolve: 'Resolve dispute', release: 'Release hold', adjustment: 'Create adjustment' };

function html({ arrayEditor, container = 'form', consoleOnly = false, duplicate = false }, identities) {
  if (consoleOnly) return '<label>Endpoint<select><option>Create tenant</option><option>Create rights dispute</option></select></label><label>JSON body<textarea>{}</textarea></label><button>Send</button>';
  const form = (key, rows, title) => `<${container} data-operation="${key}">${rows.map(([name, label, type = 'text']) =>
    `<label>${label}<input name="${name}" type="${type}" value='${name === 'evidenceRefs' && arrayEditor ? '["visible-example"]' : ''}'></label>`).join('')}<button type="button">${title}</button></${container}>`;
  return form('decoy', fields.dispute, 'Unrelated action') + Object.entries(fields).map(([key, rows]) => form(key, rows, actions[key])).join('') +
    (duplicate ? form('dispute', fields.dispute, actions.dispute) : '') + `<output>${identities.join(' ')}</output><script>
    for (const group of document.querySelectorAll('[data-operation]')) group.querySelector('button').onclick = async () => {
      if (group.dataset.operation === 'decoy') throw Error('unrelated action used');
      const body = {};
      for (const input of group.querySelectorAll('input')) {
        if (!input.value) continue;
        body[input.name] = input.type === 'number' ? Number(input.value) : input.value;
        if (input.name === 'evidenceRefs') {
          if (${arrayEditor}) { try { body[input.name] = JSON.parse(input.value); } catch {} }
          else body[input.name] = [input.value];
        }
      }
      const routes = { dispute: '/api/v1/rights-disputes', hold: '/api/v1/license-holds',
        resolve: '/api/v1/rights-disputes/' + body.rightsDisputeId + '/resolve',
        release: '/api/v1/license-holds/' + body.licenseHoldId + '/release', adjustment: '/api/v1/royalty-adjustments' };
      if (group.dataset.operation === 'resolve') delete body.rightsDisputeId;
      if (group.dataset.operation === 'release') delete body.licenseHoldId;
      const result = await fetch(routes[group.dataset.operation], { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(response => response.json());
      document.querySelector('output').textContent += ' ' + JSON.stringify(result);
    };</script>`;
}

test('registered Creator D-04 uses its action controls and checks observed responses before identities', {
  skip: !process.env.FRONTAL_TEST_CHROMIUM,
}, async t => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: process.env.FRONTAL_TEST_CHROMIUM, headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  for (const options of [
    { arrayEditor: true }, { arrayEditor: false, container: 'div' },
    { arrayEditor: true, rejected: true }, { arrayEditor: true, missingIdentity: true },
    { consoleOnly: true }, { arrayEditor: true, duplicate: true },
  ]) await t.test(JSON.stringify(options), async t => {
    const traffic = [], identities = [], holds = [], failures = [];
    const state = { schemaVersion: 1, asOf: '2032-04-05T06:07:08Z', resources: Object.fromEntries(FINAL_RESOURCE_KEYS.map(key => [key, []])), work: [], events: [] };
    state.resources.royaltyPeriods.push(family.royaltyPeriod);
    const server = createServer(async (request, reply) => {
      if (request.method !== 'POST') { reply.setHeader('Content-Type', 'text/html'); reply.end(html(options, identities)); return; }
      let text = ''; for await (const chunk of request) text += chunk;
      const body = JSON.parse(text); traffic.push({ path: request.url, body });
      let json;
      try {
        if (request.url === '/api/v1/rights-disputes') {
          assert.deepEqual(body, { tenantId: family.tenant.tenantId, editionId: family.edition.editionId, claimantCreatorId: family.creators[0].creatorId,
            expectedEditionRevision: 1, licenseId: family.license.licenseId, reason: 'OWNERSHIP_CONFLICT', evidenceRefs: ['evidence:d04'] });
          if (options.rejected) { reply.statusCode = 409; json = { error: { code: 'EDITION_REVISION_CONFLICT', message: 'test business rejection' } }; }
          else { identities.push('dispute-test'); json = options.missingIdentity ? { rightsDispute: {} } : { rightsDispute: { rightsDisputeId: 'dispute-test', revision: 1 } }; }
        } else if (request.url === '/api/v1/license-holds') {
          const scope = holds.length ? 'EDITION' : 'LICENSE';
          assert.deepEqual(body, { rightsDisputeId: 'dispute-test', scope, ...(scope === 'LICENSE' ? { licenseId: family.license.licenseId } : {}), reason: `D04-${scope}` });
          const licenseHoldId = `hold-${holds.length + 1}`; holds.push(licenseHoldId); identities.push(licenseHoldId); json = { licenseHold: { licenseHoldId, revision: 1 } };
        } else if (request.url.endsWith('/resolve')) {
          assert.equal(request.url, '/api/v1/rights-disputes/dispute-test/resolve');
          assert.deepEqual(body, { expectedRevision: 1, reason: 'CLEARED', outcome: 'REJECTED' });
          json = { rightsDispute: { rightsDisputeId: 'dispute-test' } };
        } else if (request.url.endsWith('/release')) {
          const licenseHoldId = request.url.split('/')[4]; assert(holds.includes(licenseHoldId));
          assert.deepEqual(body, { expectedRevision: 1, reason: 'CLEARED' }); json = { licenseHold: { licenseHoldId } };
        } else {
          assert.equal(request.url, '/api/v1/royalty-adjustments');
          assert.deepEqual(body, { tenantId: family.tenant.tenantId, originalPostingId: family.postingId, amountMinor: 3335, currency: 'USD', targetPeriodStart: '2032-04-07T06:07:08Z', reason: 'RIGHTS_CORRECTION' });
          identities.push('adjustment-test'); json = { royaltyAdjustment: { royaltyAdjustmentId: 'adjustment-test' } };
          state.resources.royaltyPeriods.push({ royaltyPeriodId: 'open-period', state: 'OPEN' });
          state.resources.royaltyAdjustments.push({ royaltyAdjustmentId: 'adjustment-test', targetRoyaltyPeriodId: 'open-period', adjustmentPostingId: 'new-posting' });
          state.resources.royaltyEntries = ['DEBIT', 'CREDIT'].map((direction, i) => ({ royaltyEntryId: `entry-${i}`, postingId: 'new-posting', currency: 'USD', direction, amountMinor: 3335 }));
        }
      } catch (error) { failures.push(error); reply.statusCode = 400; json = { error: { code: 'INVALID_REQUEST', message: error.message } }; }
      reply.setHeader('Content-Type', 'application/json'); reply.end(JSON.stringify(json));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    let page;
    const ctx = {
      fixtures: { browser: () => family }, at: () => '2032-04-07T06:07:08Z', migrate: async () => {}, seed: async () => {},
      startApi: async () => ({ baseUrl: `http://127.0.0.1:${server.address().port}` }), snapshot: async () => structuredClone(state),
      request: async () => ({ status: 200, json: { allowed: false } }), defer: cleanup => t.after(cleanup),
      ok: (value, label) => assert.ok(value, label), equal: (actual, expected, label) => assert.deepEqual(actual, expected, label), assert: (_label, check) => check(),
      pass: value => ({ status: 'passed', ...value }),
      loadChromium: async () => ({ launch: async () => ({
        newPage: async settings => {
          page = await browser.newPage(settings); page.setDefaultTimeout(1000);
          const response = page.waitForResponse.bind(page); page.waitForResponse = (predicate, settings) => response(predicate, { ...settings, timeout: 1000 });
          const getByText = page.getByText.bind(page);
          page.getByText = (identity, settings) => { assert.notEqual(identity, 'undefined', 'D-04 must not wait for undefined after a rejected or malformed response'); return getByText(identity, settings); };
          return page;
        }, close: () => page?.context().close(),
      }) }),
    };
    const run = () => D_CASES.find(row => row.id === 'D-04').run(ctx);
    if (options.rejected) await assert.rejects(run(), /Create dispute expected 200, got 409/);
    else if (options.missingIdentity) await assert.rejects(run(), /Create dispute returns rightsDisputeId/);
    else if (options.consoleOnly || options.duplicate) { await assert.rejects(run(), /visible action|ambiguous action/); assert.equal(traffic.length, 0); }
    else { assert.equal((await run()).status, 'passed'); assert.equal(traffic.length, 7); }
    assert.deepEqual(failures, [], 'all observed request bodies must be valid before testing business responses');
    if (!options.consoleOnly && !options.duplicate) assert.equal(await page.locator('[data-operation="decoy"] input').first().inputValue(), '', 'unrelated form untouched');
  });
});
