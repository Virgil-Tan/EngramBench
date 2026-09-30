import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { D_CASES } from '../evaluators/transfer/creatorrightsexchange/v2/cases/d.mjs';
import { createFixtureFactory } from '../evaluators/transfer/creatorrightsexchange/v2/fixtures/index.mjs';
import contract from '../contracts/transfer/creatorrightsexchange.mjs';
import { requestValidator, matchOperation } from '../templates/contract-first/runtime.mjs';

// Exercise the registered cases through their first Upload response assertion, not
// the later media/Edition workflow, which is outside this input-format regression.
test('Creator D-02/D-06 honor the visible profile editor format before the real Upload assertion', {
  skip: !process.env.FRONTAL_TEST_CHROMIUM,
}, async t => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: process.env.FRONTAL_TEST_CHROMIUM, headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  for (const id of ['D-02', 'D-06']) for (const initial of ['[]', '']) for (const rejected of [false, true]) {
    await t.test(`${id} ${initial || 'single value'} ${rejected ? 'rejected' : 'accepted'}`, async () => {
      const fixtures = createFixtureFactory({ evaluationSeed: 'profile-editor', caseId: id, baseTime: '2030-01-01T00:00:00Z' });
      const family = fixtures.base(), received = [], problems = [];
      const reachedUploadAssertion = new Error('verified Upload assertion boundary');
      const checkRequest = requestValidator(contract);
      const server = createServer(async (request, reply) => {
        if (request.method === 'GET') {
          reply.setHeader('Content-Type', 'text/html');
          reply.end(`<form><label>Tenant ID<input name="tenantId" required></label><label>Work ID<input name="workId" required></label>
            <label>Chunk size<input name="chunkSize" type="number" value="65536" required></label>
            <label>Required profile IDs<textarea name="requiredProfileIds">${initial}</textarea></label>
            <label>File<input type="file" name="file" required></label><button>Upload and complete</button></form><output></output>
            <script>document.querySelector('form').onsubmit = async event => {
              event.preventDefault();
              try {
                const data = new FormData(event.currentTarget), file = data.get('file');
                const profiles = ${initial === '[]'} ? JSON.parse(data.get('requiredProfileIds')) : [data.get('requiredProfileIds')];
                const bytes = await file.arrayBuffer(), digest = await crypto.subtle.digest('SHA-256', bytes);
                const contentSha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
                const body = { tenantId: data.get('tenantId'), workId: data.get('workId'), fileName: file.name, mediaType: file.type,
                  totalBytes: file.size, chunkSize: Number(data.get('chunkSize')), contentSha256, requiredProfileIds: profiles };
                const response = await fetch('/api/v1/uploads', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'profile-editor-test' }, body: JSON.stringify(body) });
                document.querySelector('output').textContent = await response.text();
              } catch (error) { document.querySelector('output').textContent = error.message; }
            };</script>`);
          return;
        }
        let text = ''; for await (const chunk of request) text += chunk;
        try {
          assert.equal(request.url, '/api/v1/uploads');
          const body = JSON.parse(text); received.push(body);
          const route = matchOperation(contract.operations, 'POST', request.url);
          const checked = checkRequest(route.operation, { params: route.params, body, hasBody: true, headers: request.headers });
          assert(checked.valid, JSON.stringify(checked));
          assert.deepEqual(body.requiredProfileIds, [family.profiles[0].profileId]);
        } catch (error) { problems.push(error); }
        reply.statusCode = rejected ? 409 : 200;
        reply.setHeader('Content-Type', 'application/json');
        reply.end(JSON.stringify(rejected ? { error: { code: 'UPLOAD_CONFLICT', message: 'real rejection control' } } : { uploadSession: { uploadId: fixtures.uuid('created-upload') } }));
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      let page;
      const ctx = {
        fixtures, migrate: async () => {}, seed: async () => {}, startWorker: async () => ({}),
        startApi: async () => ({ baseUrl: `http://127.0.0.1:${server.address().port}` }), defer: () => {},
        ok: (value, label) => assert.ok(value, label),
        equal: (actual, expected, label) => { assert.deepEqual(actual, expected, label); throw reachedUploadAssertion; },
        loadChromium: async () => ({ launch: async () => ({ newPage: async options => {
          page = await browser.newPage(options); page.setDefaultTimeout(1500);
          const wait = page.waitForResponse.bind(page);
          page.waitForResponse = (predicate, options) => wait(predicate, { ...options, timeout: 1500 });
          return page;
        }, close: () => page?.context().close() }) }),
      };
      try {
        await assert.rejects(() => D_CASES.find(row => row.id === id).run(ctx), error => rejected
          ? error.code === 'ERR_ASSERTION' && /Upload accepted/.test(error.message)
          : error === reachedUploadAssertion);
        assert.equal(received.length, 1, 'one real POST observed');
        assert.deepEqual(problems, [], 'valid public request before exercising response rejection');
        assert.equal(await page.getByLabel(/profile/i).inputValue(), initial === '[]'
          ? JSON.stringify([family.profiles[0].profileId]) : family.profiles[0].profileId);
      } finally {
        await page?.context().close();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    });
  }
});
