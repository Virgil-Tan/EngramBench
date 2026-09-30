import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import contract from '../contracts/transfer/accesssentinel.mjs';
import { D_CASES } from '../evaluators/transfer/accesssentinel/v2/cases/d.mjs';
import { createFixtureFactory } from '../evaluators/transfer/accesssentinel/v2/fixtures/index.mjs';

const browserTest = { skip: !process.env.FRONTAL_TEST_CHROMIUM };
const fixture = caseId => createFixtureFactory({ evaluationSeed: 'ui-review-recovery-regression', caseId, baseTime: '2032-04-05T06:07:08Z' }).browser();
const snapshotFor = family => ({ schemaVersion: 1, asOf: family.at(), resources: Object.fromEntries(Object.keys(contract.schemas.Snapshot.properties.resources.properties).map(key => [key, structuredClone(family.seed[key] ?? [])])), work: [], events: [], metrics: { databaseBytes: 0 } });
async function serve(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
function context(t, browser, family, baseUrl, pages, responses = []) {
  return {
    fixtures: { browser: () => family }, migrate: async () => {}, npm: async () => {}, seed: async () => ({ exitCode: 0 }),
    startApi: async () => ({ baseUrl, logs: '' }), startWorker: async () => ({}), defer: cleanup => t.after(cleanup),
    snapshot: async () => (await fetch(`${baseUrl}/api/v1/verification-snapshot`)).json(),
    waitFor: async (fn, options) => { const value = await fn(); assert.ok(value, options.label); return value; },
    ok: (value, label) => assert.ok(value, label), equal: (a, b, label) => assert.deepEqual(a, b, label), assert: (_label, check) => check(), pass: value => ({ status: 'passed', ...value }),
    adminToken: 'test-administrator-sentinel', barrierToken: 'test-barrier-sentinel',
    loadChromium: async () => ({ launch: async () => ({
      newPage: async options => { const page = await browser.newPage(options); page.setDefaultTimeout(1500); page.setDefaultNavigationTimeout(5000); page.on('response', response => responses.push({ path: new URL(response.url()).pathname, status: response.status() })); pages.push(page); return page; },
      close: async () => { for (const page of pages) if (!page.isClosed()) await page.context().close(); },
    }) }),
  };
}
const reply = (res, value, status = 200) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };

test('registered Access D-03 preserves LOW grant/revoke and selects the distinct REVIEW request, not retrospective review', browserTest, async t => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: process.env.FRONTAL_TEST_CHROMIUM, headless: true }); t.after(() => browser.close());
  for (const options of [{ label: 'Access Request' }, { label: 'Access request UUID' }, { label: 'Request' }, { label: 'Request', views: 'visible' }, { label: 'Request', views: 'collapsed' }, { label: 'Request', views: 'ambiguous' }, { label: 'Request', headingless: true }, { label: 'Request', ambiguous: true }, { label: 'Request', missingIdentity: true }, { label: 'Request', uncommittedReview: true }]) await t.test(JSON.stringify(options), async t => {
    const family = fixture('D-03'), state = snapshotFor(family), traffic = [], pages = [];
    const lowId = family.uuid('ui-low'), reviewId = family.uuid('ui-review'), decoyId = family.uuid('decoy'), grantId = family.uuid('grant');
    const requestSelect = () => `<label>${options.label}<select name=accessRequestId><option value="${decoyId}">Unrelated request</option>${state.resources.accessRequests.map(r => `<option value="${r.accessRequestId}">${r.accessRequestId}</option>`).join('')}</select></label>`;
    const form = (heading, action, fields, operation) => `<form data-operation="${operation}">${heading ? `<h2>${heading}</h2>` : ''}${fields}<button>${action}</button></form>`;
    const html = () => {
      const reviewForm = form(options.headingless ? '' : 'Review Access Request', 'Submit Review', `${options.missingIdentity ? '' : requestSelect()}<label>Reviewer<input name=reviewerId></label><label>Decision<select name=decision><option>REJECT</option><option>APPROVE</option></select></label><label>Comment<input name=comment></label>`, 'review');
      const requestState = `<p>${lowId} ${grantId} LOW 0</p>`;
      const requestView = `<details data-view=requests><summary>Access Requests</summary>${requestState}</details>`;
      const views = options.views ? `<details data-view=risk><summary>Risk Models</summary><p>Model thresholds</p></details>${requestView}${options.views === 'ambiguous' ? requestView : ''}` : '';
      return `<p>${reviewId} PENDING_REVIEW</p>${!options.views || options.views === 'visible' ? requestState : ''}${views}`
        + form('Create Access Request', 'Request', '<label>Request body<textarea>{}</textarea></label>', 'create')
        + form('Grant Request', 'Grant', `${requestSelect()}<label>Expected state<input name=expectedState></label>`, 'grant')
        + form('Revoke Grant', 'Revoke', '<label>Grant<input name=grantId></label><label>Reason<input name=reason></label>', 'revoke')
        + reviewForm + (options.ambiguous ? reviewForm : '')
        + form('Retrospective Review', 'Submit Review', '<label>Session<input name=breakGlassSessionId value="untouched"></label><label>Findings<input name=findings value="untouched"></label>', 'retrospective')
        + `<script>for (const form of document.querySelectorAll('form')) form.onsubmit = async event => {
          event.preventDefault(); const op = form.dataset.operation; const body = op === 'create' ? JSON.parse(form.querySelector('textarea').value) : Object.fromEntries(new FormData(form));
          let path = '/api/v1/access-requests';
          if (op === 'grant' || op === 'review') { path += '/' + body.accessRequestId + (op === 'grant' ? '/grant' : '/reviews'); delete body.accessRequestId; }
          if (op === 'revoke') { path = '/api/v1/grants/' + body.grantId + '/revoke'; delete body.grantId; }
          if (op === 'retrospective') path = '/api/v1/break-glass-sessions/unrelated/retrospective-reviews';
          await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        };</script>`;
    };
    const baseUrl = await serve(t, async (req, res) => {
      if (req.method === 'GET') { if (req.url.startsWith('/api/')) return reply(res, state); res.setHeader('content-type', 'text/html'); res.end(html()); return; }
      let text = ''; for await (const part of req) text += part;
      const body = JSON.parse(text); traffic.push({ path: req.url, body });
      if (req.url === '/api/v1/access-requests') {
        const isReview = body.region === 'us-west', accessRequestId = isReview ? reviewId : lowId;
        const row = { ...body, accessRequestId, state: isReview ? 'PENDING_REVIEW' : 'APPROVED', policyRevisionId: family.policyRevision.policyRevisionId, riskModelRevisionId: family.riskModelRevision.riskModelRevisionId, deviceTrustRevisionId: family.trust.deviceTrustRevisionId, sessionGeneration: 1, tenantRevocationEpoch: 0, principalRevocationEpoch: 0, locationWatermark: family.observation.observedAt, createdAt: family.at(), updatedAt: family.at() };
        state.resources.accessRequests.push(row); state.resources.riskDecisions.push({ accessRequestId, level: isReview ? 'REVIEW' : 'LOW', score: isReview ? 45 : 0 }); return reply(res, row);
      }
      if (req.url === `/api/v1/access-requests/${lowId}/grant`) { state.resources.accessRequests[0].state = 'GRANTED'; state.resources.accessGrants.push({ grantId, accessRequestId: lowId, state: 'ACTIVE' }); return reply(res, state.resources.accessGrants[0]); }
      if (req.url === `/api/v1/grants/${grantId}/revoke`) { state.resources.accessGrants[0].state = 'REVOKED'; return reply(res, state.resources.accessGrants[0]); }
      if (req.url === `/api/v1/access-requests/${reviewId}/reviews`) {
        const review = { accessReviewId: family.uuid('review'), accessRequestId: reviewId, tenantId: family.tenant.tenantId, ...body, createdAt: family.at() };
        if (!options.uncommittedReview) { state.resources.accessReviews.push(review); state.resources.accessRequests.find(r => r.accessRequestId === reviewId).state = 'APPROVED'; }
        return reply(res, review);
      }
      return reply(res, { error: { code: 'INVALID_REQUEST', message: 'wrong identity or operation', details: {} } }, 400);
    });
    const ctx = context(t, browser, family, baseUrl, pages), run = () => D_CASES.find(c => c.id === 'D-03').run(ctx);
    if (options.views === 'ambiguous') {
      await assert.rejects(run(), error => error.code === 'EVALUATOR_UI_TARGET_AMBIGUOUS');
      assert.deepEqual(traffic.map(x => x.path), ['/api/v1/access-requests'], 'ambiguous read views cannot trigger another mutation');
      assert.equal(await pages[0].locator('details[open]').count(), 0, 'neither ambiguous Request view is selected');
      return;
    }
    if (options.ambiguous) await assert.rejects(run(), error => error.code === 'EVALUATOR_UI_TARGET_AMBIGUOUS');
    else if (options.missingIdentity) await assert.rejects(run(), error => error.code === 'EVALUATOR_UI_TARGET_UNRESOLVED');
    else if (options.uncommittedReview) await assert.rejects(run(), /accessReviews\.accessReviewId/);
    else assert.equal((await run()).status, 'passed');
    assert.deepEqual(traffic.slice(0, 4).map(x => x.path), ['/api/v1/access-requests', `/api/v1/access-requests/${lowId}/grant`, `/api/v1/grants/${grantId}/revoke`, '/api/v1/access-requests']);
    assert.equal(state.resources.accessGrants[0].state, 'REVOKED');
    if (!options.ambiguous && !options.missingIdentity) assert.deepEqual(traffic[4], { path: `/api/v1/access-requests/${reviewId}/reviews`, body: { reviewerId: family.reviewerA.principalId, decision: 'APPROVE', comment: 'UI independent approval' } });
    else assert.equal(traffic.length, 4, 'unresolved review never sends a mutation');
    assert.equal(await pages[0].locator('[data-operation=retrospective] [name=findings]').inputValue(), 'untouched');
    if (options.views) assert.equal(await pages[0].locator('[data-view=risk]').getAttribute('open'), null, 'unrelated Risk Models is never opened');
  });
});

test('registered Access D-06 observes a real offline POST then restores exactly one Session through the original keyboard action', browserTest, async t => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: process.env.FRONTAL_TEST_CHROMIUM, headless: true }); t.after(() => browser.close());
  for (const mode of ['recovered', 'recovered-visible-load', 'recovered-with-read', 'no-first-request', 'no-error-feedback', 'no-retry-request', 'no-durable-recovery', 'rejected-retry', 'no-forbidden-request', 'no-forbidden-feedback']) await t.test(mode, async t => {
    const family = fixture('D-06'), state = snapshotFor(family), traffic = [], pages = [], responses = [];
    const manualLoad = mode === 'recovered-visible-load' || mode.startsWith('no-forbidden'); let visits = 0;
    const html = () => `<style>body{color:rgb(17,17,17);background:rgb(255,255,255)}</style><h1>AccessSentinel</h1>${manualLoad ? '<label>Admin Token<input type=password></label><button id=load>Load Snapshot</button>' : ''}<form><h2>Create Session</h2><label>Request body<textarea>{}</textarea></label><button>Create Session</button></form><p id=status></p><script>
      let attempts = 0;
      const load = async () => { if (${JSON.stringify(mode)} === 'no-forbidden-request' && ${visits} > 1) return; const r = await fetch('/api/v1/verification-snapshot'); if (!r.ok && ${JSON.stringify(mode)} !== 'no-forbidden-feedback') document.getElementById('status').textContent = 'Snapshot permission denied'; };
      ${manualLoad ? "document.getElementById('load').onclick = load;" : 'load();'}
      document.querySelector('form').onsubmit = async event => {
        event.preventDefault(); attempts++;
        if ((${JSON.stringify(mode)} === 'no-first-request' && attempts === 1) || (${JSON.stringify(mode)} === 'no-retry-request' && attempts === 2)) return;
        try { if (${JSON.stringify(mode)} === 'recovered-with-read' && attempts === 1) await fetch('/api/v1/sessions'); const response = await fetch('/api/v1/sessions', { method:'POST', headers:{'content-type':'application/json'}, body:document.querySelector('textarea').value }); document.getElementById('status').textContent = response.ok ? 'Created Session' : 'Server error'; }
        catch(error) { if (${JSON.stringify(mode)} !== 'no-error-feedback') document.getElementById('status').textContent = error.message; }
      };</script>`;
    const baseUrl = await serve(t, async (req, res) => {
      if (req.method === 'GET') { if (req.url === '/api/v1/sessions') return reply(res, { error: { code: 'NOT_FOUND', message: 'unpublished read', details: {} } }, 404); if (req.url.startsWith('/api/')) return reply(res, state); visits++; res.setHeader('content-type', 'text/html'); res.end(html()); return; }
      let text = ''; for await (const part of req) text += part;
      traffic.push({ path: req.url, body: JSON.parse(text) });
      const session = { ...family.session, sessionId: family.uuid('retry-session'), familyId: family.uuid('retry-family') };
      if (!['no-durable-recovery', 'rejected-retry'].includes(mode)) state.resources.sessions.push(session);
      reply(res, mode === 'rejected-retry' ? { error: { code: 'STATE_CONFLICT', message: 'retry rejected', details: {} } } : { session, refreshToken: 'test-response-not-rendered' }, mode === 'rejected-retry' ? 409 : 200);
    });
    const ctx = context(t, browser, family, baseUrl, pages, responses), run = () => D_CASES.find(c => c.id === 'D-06').run(ctx);
    if (mode.startsWith('recovered')) {
      assert.equal((await run()).status, 'passed');
      assert.deepEqual(traffic, [{ path: '/api/v1/sessions', body: family.sessionBody() }], 'the aborted attempt never reaches HTTP; retry uses the same business identity once');
      assert.equal(state.resources.sessions.length, 3);
      assert.equal(responses.filter(r => r.path === '/api/v1/verification-snapshot' && r.status === 403).length, 1, 'an actual forbidden snapshot response is observed, not the Access page title');
    } else {
      await assert.rejects(run(), error => error.name === 'TimeoutError' || /UI retry one Session|UI retry Session HTTP/.test(error.message));
      assert.equal(traffic.length, ['no-durable-recovery', 'rejected-retry'].includes(mode) || mode.startsWith('no-forbidden') ? 1 : 0);
      assert.equal(state.resources.sessions.length, mode.startsWith('no-forbidden') ? 3 : 2);
    }
  });
});
