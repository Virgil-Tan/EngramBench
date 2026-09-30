import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { evaluatorContract } from '../src/task-evaluator-v2/public-contract.mjs';
import { D_CASES } from '../evaluators/transfer/coldchaincontrol/v2/cases/d.mjs';
import { visibleText } from '../evaluators/transfer/coldchaincontrol/v2/cases/helpers.mjs';
import { createFixtureFactory } from '../evaluators/transfer/coldchaincontrol/v2/fixtures/index.mjs';

const adminToken = 'regression-only-admin-token';
const contract = await evaluatorContract(fileURLToPath(new URL('../task-packages/v2/coldchaincontrol/public-contract/', import.meta.url)));
const fixtures = createFixtureFactory({ evaluationSeed: 'ui-observation-regression', caseId: 'D-03', baseTime: '2030-01-01T00:00:00Z' });
const excursionId = fixtures.uuid('observed-excursion');
const json = (reply, value, status = 200) => { reply.writeHead(status, { 'content-type': 'application/json' }); reply.end(JSON.stringify(value)); };
const readBody = async request => { let body = ''; for await (const part of request) body += part; return JSON.parse(body); };

async function context(t, browser, options, caseId) {
  const family = caseId === 'D-03' ? fixtures.notification('http://unused.invalid/events') : fixtures.browser();
  let state;
  const ledger = [], posts = [], browserReads = [], problems = [], pages = [], received = [];
  const server = createServer(async (request, reply) => {
    try {
      received.push({ method: request.method, path: request.url });
      if (!request.url.startsWith('/api/v1/')) {
        reply.writeHead(200, { 'content-type': 'text/html' }); reply.end(uiPage(options, caseId, family)); return;
      }
      if (request.method === 'GET') {
        if (request.url === '/api/v1/verification-snapshot' && request.headers.authorization !== `Bearer ${adminToken}`)
          return json(reply, { error: { code: 'UNAUTHORIZED', message: 'Permission denied', details: {} } }, options.unauthorizedSuccess ? 200 : 401);
        if (request.headers['user-agent']?.includes('Chrome')) browserReads.push(request.url);
        if (request.url.startsWith('/api/v1/excursions?')) return json(reply, { items: state.resources.excursions, nextCursor: null });
        if (request.url === `/api/v1/shipments/${family.shipment.shipmentId}`) return json(reply, family.shipment);
        return json(reply, state);
      }
      const body = await readBody(request);
      if (request.url === '/api/v1/telemetry-readings') {
        const expected = family.readings.find(item => item.sequence === body.sequence);
        assert.deepEqual(body, expected, 'original telemetry values retained');
        if (body.sequence === 3) state.resources.excursions.push({ excursionId, shipmentId: family.shipment.shipmentId, kind: 'TEMPERATURE', state: 'OPEN', acknowledgedAt: null });
        if (body.sequence === 6) { state.resources.excursions[0].state = 'RESOLVED'; ledger.push({ acknowledged: true }); }
        return json(reply, { accepted: true });
      }
      posts.push({ path: request.url, body });
      if (caseId === 'D-03') {
        assert.deepEqual(body, {});
        if (request.url === `/api/v1/excursions/${excursionId}/acknowledge`) {
          state.resources.excursions[0].state = 'ACKNOWLEDGED'; state.resources.excursions[0].acknowledgedAt = fixtures.at();
        }
        return json(reply, { state: 'ACKNOWLEDGED' });
      }
      assert.equal(request.url, '/api/v1/shipments');
      assert.deepEqual(body, {
        tenant: family.tenant.tenantId, externalRef: family.shipment.externalRef, productLotCode: family.shipment.productLotCode,
        carrier: family.shipment.carrierId, device: family.shipment.deviceId, origin: family.shipment.originSiteId,
        destination: family.shipment.destinationSiteId, minimumTemperatureMilliC: String(family.shipment.minimumTemperatureMilliC),
        maximumTemperatureMilliC: String(family.shipment.maximumTemperatureMilliC),
      });
      return json(reply, { error: { code: 'STATE_CONFLICT', message: 'Shipment already exists', details: {} } }, 409);
    } catch (error) { problems.push(error); json(reply, { error: { message: error.message } }, 500); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = async (_, path, options = {}) => {
    contract.request(path, options);
    const response = await fetch(baseUrl + path, { method: options.method, headers: options.headers, body: options.json === undefined ? undefined : JSON.stringify(options.json) });
    const text = await response.text(); return { status: response.status, json: JSON.parse(text), text };
  };
  const ctx = {
    fixtures: { ...fixtures, browser: () => family, notification: () => family }, key: fixtures.key, adminToken,
    migrate: async () => {}, seed: async seed => {
      state = { schemaVersion: 1, asOf: fixtures.at(), resources: Object.fromEntries(Object.entries(seed).filter(([, value]) => Array.isArray(value))), managerResources: {}, work: [], events: [] };
    },
    npm: async () => {}, startApi: async () => ({ baseUrl }), startWorker: async () => ({}), startDispatcher: async () => ({}),
    receiver: async () => ({ url: 'http://unused.invalid/events', ledger }), defer: cleanup => t.after(cleanup),
    snapshot: () => request(baseUrl, '/api/v1/verification-snapshot', { headers: { authorization: `Bearer ${adminToken}` } }).then(value => value.json),
    request, waitFor: async predicate => { const result = await predicate(); assert.ok(result, 'independent committed-state predicate'); return result; },
    pass: () => ({ status: 'passed' }),
    loadChromium: async () => ({ launch: async () => ({
      newPage: async settings => {
        const page = await browser.newPage(settings); pages.push(page); page.setDefaultTimeout(1200);
        for (const name of ['waitForRequest', 'waitForResponse', 'waitForEvent']) {
          const original = page[name].bind(page);
          page[name] = (predicate, config) => original(predicate, typeof config === 'function' ? config : { ...config, timeout: 3000 });
        }
        return page;
      }, close: () => Promise.all(pages.map(page => page.context().close())),
    }) }),
  };
  return { ctx, posts, browserReads, problems, pages, received, state: () => state };
}

function uiPage(options, caseId, family) {
  const input = name => `<label>${name}<input name="${name}"></label>`;
  const shipment = !options.noForm ? `<form id="create">${['tenant', 'externalRef', 'productLotCode', 'carrier', 'device', 'origin', 'destination', 'minimumTemperatureMilliC', 'maximumTemperatureMilliC'].map(input).join('')}<button>Create shipment</button></form>` : '';
  return `<h1>Shipments</h1>${options.manual ? '<label>Admin token<input id="token" type="password"></label>' : ''}
    ${options.noRead || options.inputRead ? '' : '<button id="refresh">Refresh</button>'}<p role="status" id="status">Ready</p>
    <section><h2>Excursions</h2><div id="excursions"></div></section><h2>Notifications and audit</h2>
    ${caseId === 'D-03' && options.idForm && !options.noAction ? `<form id="ack">${input('excursion')}<button>Acknowledge</button></form>` : ''}
    ${caseId === 'D-05' ? shipment : ''}<script>
    const status = document.querySelector('#status'), view = document.querySelector('#excursions');
    async function refresh() {
      ${options.manual ? "if (!document.querySelector('#token').value) { status.textContent = 'Enter an admin token'; return; }" : ''}
      ${options.noLoading ? '' : "status.textContent = 'Loading';"}
      try {
        const response = await fetch('${options.manual && !options.resourceRead ? '/api/v1/verification-snapshot' : '/api/v1/excursions?tenantId=' + family.tenant.tenantId}', { headers: ${options.manual ? "{ Authorization: 'Bearer ' + document.querySelector('#token').value }" : '{}'} });
        const body = await response.json();
        if (!response.ok) throw Error(body.error.message);
        status.textContent = 'Loaded Shipments'; view.replaceChildren();
        for (const excursion of body.resources?.excursions ?? body.items) {
          const card = document.createElement('div');
          const visibleState = ${options.hideState ? "'unknown'" : 'excursion.state'};
          card.innerHTML = '<strong>' + (${options.titleCase ? "'Temperature'" : 'excursion.kind'}) + '</strong><span>' + visibleState + '</span><code>' + excursion.shipmentId + '</code>';
          if (${!options.idForm && !options.noAction} && excursion.state === 'OPEN') {
            const button = document.createElement('button'); button.textContent = 'Acknowledge';
            button.onclick = () => acknowledge(${options.wrongId ? "'wrong-excursion'" : 'excursion.excursionId'}); card.append(button);
          }
          view.append(card);
          if (${Boolean(options.ambiguous)}) view.append(card.cloneNode(true));
        }
      } catch (error) { ${options.hideError ? '' : 'status.textContent = error.message;'} }
    }
    async function acknowledge(id) { await fetch('/api/v1/excursions/' + id + '/acknowledge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); await refresh(); }
    document.querySelector('#refresh')?.addEventListener('click', refresh);
    ${options.inputRead ? "document.querySelector('#token').addEventListener('input', refresh);" : ''}
    document.querySelector('#ack')?.addEventListener('submit', event => { event.preventDefault(); acknowledge(new FormData(event.currentTarget).get('excursion')); });
    document.querySelector('#create')?.addEventListener('submit', async event => {
      event.preventDefault(); const response = await fetch('/api/v1/shipments', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
      const body = await response.json(); ${options.hideConflict ? '' : 'status.textContent = body.error.message;'}
    });
    ${options.bootstrap ? `fetch('/api/v1/shipments/${family.shipment.shipmentId}');` : ''}
    ${!options.manual && !options.noRead ? 'refresh();' : ''}
    </script>`;
}

test('registered ColdChain D03 reads committed excursions and acknowledges only the exact business target', { skip: !process.env.FRONTAL_TEST_CHROMIUM }, async t => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: process.env.FRONTAL_TEST_CHROMIUM, headless: true }); t.after(() => browser.close());
  for (const options of [{ idForm: true }, { manual: true, idForm: true }, { manual: true }, { manual: true, bootstrap: true, titleCase: true }, { manual: true, resourceRead: true }, { manual: true, inputRead: true }, { manual: true, noAction: true }, { manual: true, ambiguous: true }, { manual: true, wrongId: true }, { manual: true, hideState: true }]) await t.test(JSON.stringify(options), async t => {
    const result = await context(t, browser, options, 'D-03');
    const run = () => D_CASES.find(item => item.id === 'D-03').run(result.ctx);
    if (options.noAction || options.ambiguous || options.wrongId || options.hideState) {
      const reason = options.ambiguous ? /unambiguous visible excursion acknowledge/ : options.wrongId ? /acknowledge POST targets the exact/ : /visible excursion acknowledge action bound/;
      await assert.rejects(run(), reason);
      if (options.noAction || options.ambiguous || options.hideState) assert.equal(result.posts.length, 0);
    } else {
      assert.equal((await run()).status, 'passed');
      assert.deepEqual(result.posts, [{ path: `/api/v1/excursions/${excursionId}/acknowledge`, body: {} }]);
      assert.equal(result.state().resources.excursions[0].state, 'RESOLVED');
      assert.ok(result.state().resources.excursions[0].acknowledgedAt);
      assert.ok(result.browserReads.length >= 3, 'open, acknowledged and resolved views are read through the browser');
    }
    assert.deepEqual(result.problems, []);
  });
});

test('registered ColdChain D05 drives actual read, loading, failure, retry, permission and duplicate-shipment UI', { skip: !process.env.FRONTAL_TEST_CHROMIUM }, async t => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: process.env.FRONTAL_TEST_CHROMIUM, headless: true }); t.after(() => browser.close());
  for (const options of [{}, { manual: true }, { manual: true, bootstrap: true }, { manual: true, inputRead: true }, { manual: true, resourceRead: true }, { manual: true, noLoading: true }, { manual: true, noRead: true }, { manual: true, noForm: true }, { manual: true, hideError: true }, { manual: true, hideConflict: true }, { manual: true, unauthorizedSuccess: true }]) await t.test(JSON.stringify(options), async t => {
    const result = await context(t, browser, options, 'D-05');
    const run = () => D_CASES.find(item => item.id === 'D-05').run(result.ctx);
    if (options.unauthorizedSuccess) {
      await assert.rejects(run(), error => error.origin === 'candidate' && error.actual === 200 && error.expected === 401);
      assert.equal(result.posts.length, 0);
    } else if (options.noLoading || options.noRead || options.noForm || options.hideError || options.hideConflict) {
      const reason = options.noLoading ? /visible text \/loading/ : options.noRead ? /visible UI action could not complete|matching request/i
        : options.noForm ? /visible control tenant/ : options.hideError ? /visible text \/offline/ : /visible text \/conflict/;
      await assert.rejects(run(), reason);
      assert.equal(result.posts.length, options.hideConflict ? 1 : 0);
    }
    else { assert.equal((await run()).status, 'passed'); assert.equal(result.posts.length, 1); assert.ok(result.browserReads.length >= 3); }
    assert.deepEqual(result.problems, []);
  });
});

test('ColdChain request guard rejects unstated auth omissions before HTTP and permits the intentional 401 probe', async t => {
  const result = await context(t, undefined, {}, 'D-05');
  await assert.rejects(result.ctx.request('', '/api/v1/verification-snapshot'), error => error.code === 'EVALUATOR_PUBLIC_CONTRACT_MISMATCH');
  assert.equal(result.received.length, 0, 'invalid positive request must not reach the server');
  const response = await result.ctx.request('', '/api/v1/verification-snapshot', { contractExpectation: 'invalid' });
  assert.equal(response.status, 401);
  assert.deepEqual(result.received, [{ method: 'GET', path: '/api/v1/verification-snapshot' }]);
});

test('ColdChain visible evidence waits for render, ignores casing and rejects hidden text', { skip: !process.env.FRONTAL_TEST_CHROMIUM }, async t => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: process.env.FRONTAL_TEST_CHROMIUM, headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); page.setDefaultTimeout(300);
  await page.setContent('<p hidden>Loading</p><script>setTimeout(() => { document.body.insertAdjacentHTML("beforeend", "<p>Loading</p>"); }, 50)</script>');
  assert.equal(await (await visibleText(page, /loading/u)).isVisible(), true);
  await page.setContent('<p hidden>Loading</p>');
  await assert.rejects(visibleText(page, /loading/u), /visible/i);
});
