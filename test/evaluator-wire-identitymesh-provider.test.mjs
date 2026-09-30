import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import contract from '../contracts/learning/identitymesh.mjs';
import { validator, requestValidator, matchOperation } from '../templates/contract-first/runtime.mjs';
import { createFixtureFactory, identityCatalog, loginAttemptBody, providerCallback, v1Seed } from '../evaluators/learning/identitymesh/v2/lib/fixtures.mjs';
import { createCaseContext, decorateIdentityMeshContext } from '../evaluators/learning/identitymesh/v2/lib/runtime.mjs';
import { boot, createSuccessfulSession, createUnknownAttempt } from '../evaluators/learning/identitymesh/v2/cases/helpers.mjs';

const fixtures = createFixtureFactory({ evaluationSeed: 'author-provider-wire', caseId: 'A-01', baseTime: '2026-09-08T00:00:00.000Z' });
const catalog = identityCatalog(fixtures, 'wire');
const validRequest = requestValidator(contract);
function checkRequest(path, body, key = 'author-wire') {
  const { operation, params } = matchOperation(contract.operations, 'POST', path);
  const checked = validRequest(operation, { params, body, hasBody: true,
    headers: { 'content-type': 'application/json', 'idempotency-key': key } });
  assert.equal(checked.valid, true, JSON.stringify(checked));
}

test('IdentityMesh author fixtures use provisioned Users and the published login/callback wire', () => {
  const seed = v1Seed(fixtures, 'wire', { catalogs: [catalog] });
  const validSeed = validator(contract)(contract.seed.schema);
  assert.equal(validSeed(seed), true, JSON.stringify(validSeed.errors));
  const body = loginAttemptBody(catalog);
  checkRequest('/api/v1/login-attempts', body);
  assert.deepEqual(Object.keys(body).sort(), ['deviceId', 'password', 'tenantId', 'username']);
  checkRequest('/api/v1/provider/callbacks', providerCallback(fixtures, catalog, 'wire', 'SUCCEEDED', { providerRequestId: 'actual-returned-id' }));
  assert.equal(JSON.stringify(seed).includes(body.password), false);
});

test('IdentityMesh refresh helper retains each token generation through replay and later rotation', async t => {
  const ctx = await createCaseContext({ caseId: 'A-02', workspace: import.meta.dirname, evaluationSeed: 'author-provider-wire', manageDatabase: false });
  t.after(() => ctx.teardown());
  const sessionId = fixtures.uuid('session'), calls = [];
  let generation = 4;
  ctx.mutate = async (_url, path, key, body) => {
    checkRequest(path, body, key);
    calls.push({ path, body });
    return { status: 200, json: { session: { sessionId, refreshGeneration: generation++, requiredRevocationVersion: 93 }, tokens: { refreshToken: `token-${generation - 1}`, accessToken: 'access', expiresAt: fixtures.at({ seconds: 300 }) } } };
  };
  await ctx.reconcileLogin('http://author.invalid', fixtures.uuid('attempt'), {});
  await ctx.refreshSession('http://author.invalid', sessionId, 'token-4');
  await ctx.refreshSession('http://author.invalid', sessionId, 'token-4');
  await ctx.refreshSession('http://author.invalid', sessionId, 'token-5');
  assert.deepEqual(calls.slice(1).map(({ body }) => body.expectedGeneration), [4, 4, 5]);
  await assert.rejects(ctx.refreshSession('http://author.invalid', sessionId, 'unknown-token'), /actual issued token/);
  await assert.rejects(ctx.refreshSession('http://author.invalid', sessionId, 'token-4', { localRevocationVersion: 93 }), /no published request seam/);
});

async function directLogin(ctx, url, catalog) { return ctx.createLoginAttempt(url, ctx.loginBody(catalog)); }
for (const helper of [createSuccessfulSession, createUnknownAttempt, directLogin]) {
  test(`IdentityMesh ${helper.name} reports unobserved outbound login as candidate failure, not a provider control error`, async t => {
    const ctx = await createCaseContext({ caseId: 'A-01', workspace: import.meta.dirname,
      evaluationSeed: 'missing-outbound-regression', manageDatabase: false });
    t.after(() => ctx.teardown());
    await ctx.startProvider({ accounts: [catalog.account] });
    // Use the real polling/classification path with a short unit-test deadline.
    const wait = ctx.waitFor;
    ctx.waitFor = (read, options) => wait(read, { ...options, timeoutMs: 20, intervalMs: 1 });
    ctx.mutate = async () => ({ status: 200, json: { loginAttempt: {
      loginAttemptId: fixtures.uuid('unobserved-attempt'), providerRequestId: 'never-sent-to-provider', state: 'STARTED',
    } } });
    await assert.rejects(helper(ctx, 'http://candidate.invalid', catalog, 'missing', { ensureKey: false }),
      error => error.origin === 'candidate' && /outbound login/.test(error.message));
    assert.equal(ctx.provider.requests.length, 0);
    ctx.provider.assertHealthy();
  });
}

test('IdentityMesh callback setup waits for delayed real outbound login and preserves provider faults', async t => {
  const ctx = await createCaseContext({ caseId: 'A-01', workspace: import.meta.dirname,
    evaluationSeed: 'delayed-outbound-regression', manageDatabase: false });
  t.after(() => ctx.teardown());
  await ctx.startProvider({ accounts: [catalog.account] });
  const id = 'delayed-provider-request', reachedCallback = new Error('reached actual callback');
  let sent;
  ctx.mutate = async () => {
    sent = (async () => {
      await new Promise(done => setTimeout(done, 15));
      const response = await fetch(`${ctx.provider.baseUrl}/v1/login`, { method: 'POST', headers: {
        'content-type': 'application/json', 'idempotency-key': id },
      body: JSON.stringify({ providerRequestId: id, ...loginAttemptBody(catalog) }) });
      assert.equal(response.status, 200);
      await response.json();
    })();
    return { status: 200, json: { loginAttempt: { loginAttemptId: fixtures.uuid(id), providerRequestId: id, state: 'STARTED' } } };
  };
  ctx.providerCallback = async (_url, body) => {
    assert.equal(body.providerRequestId, id);
    assert.equal(body.outcome, 'UNKNOWN');
    throw reachedCallback;
  };
  try { await assert.rejects(createUnknownAttempt(ctx, 'http://candidate.invalid', catalog), error => error === reachedCallback); }
  finally { await sent; }
  const fault = Object.assign(new Error('provider double failed'), { origin: 'evaluator', code: 'EVALUATOR_PROVIDER_DOUBLE_FAILED' });
  ctx.provider.assertHealthy = () => { throw fault; };
  ctx.mutate = async () => ({ status: 200, json: { loginAttempt: { loginAttemptId: fixtures.uuid(id), providerRequestId: id } } });
  await assert.rejects(createUnknownAttempt(ctx, 'http://candidate.invalid', catalog), error => error === fault);
});

for (const initialOutcome of ['UNKNOWN', 'SUCCEEDED']) test(`IdentityMesh actual setup/session helpers use the public provider with initial ${initialOutcome}`, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'identitymesh-author-wire-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const disposers = [], roles = [], calls = [];
  const state = { resources: { signingKeys: [], loginAttempts: [], sessions: [] } };
  const raw = {
    caseId: 'A-01', fixtures, key: fixtures.key, at: fixtures.at,
    defer: fn => disposers.push(fn), tempPath: name => join(temporary, name),
    request: async () => ({ status: 200 }),
    seedFile: async path => {
      const seed = JSON.parse(await readFile(path, 'utf8'));
      const valid = validator(contract)(contract.seed.schema);
      assert.equal(valid(seed), true, JSON.stringify(valid.errors));
      Object.assign(state.resources, seed);
      return { exitCode: 0 };
    },
    startApi: async options => { roles.push(options); return { baseUrl: 'http://candidate.invalid' }; },
    startWorker: async options => { roles.push(options); return {}; },
  };
  const ctx = await decorateIdentityMeshContext(raw);
  t.after(async () => { for (const dispose of disposers.reverse()) await dispose(); });
  ctx.snapshot = async () => state;
  ctx.waitFor = async predicate => { const result = await predicate(); assert.ok(result); return result; };
  const issued = new Map();
  const finish = attempt => {
    if (!issued.has(attempt.loginAttemptId)) {
      const session = { sessionId: fixtures.uuid(`session:${attempt.providerRequestId}`), tenantId: catalog.tenant.tenantId,
        userId: catalog.user.userId, deviceId: catalog.device.deviceId, tokenFamilyId: fixtures.uuid(`family:${attempt.providerRequestId}`),
        state: 'ACTIVE', refreshGeneration: 7, requiredRevocationVersion: 29, createdAt: fixtures.at(),
        expiresAt: fixtures.at({ seconds: 3600 }), revokedAt: null, sequence: 1 };
      state.resources.sessions.push(session);
      issued.set(attempt.loginAttemptId, { session, tokens: { accessToken: `access-${attempt.providerRequestId}`,
        refreshToken: `refresh-${attempt.providerRequestId}`, expiresAt: fixtures.at({ seconds: 300 }) } });
      Object.assign(attempt, { state: 'SUCCEEDED', userId: session.userId, sessionId: session.sessionId, resolvedAt: fixtures.at(), sequence: 1 });
    }
    return { loginAttempt: { ...attempt }, ...issued.get(attempt.loginAttemptId) };
  };
  ctx.mutate = async (_url, path, key, body) => {
    checkRequest(path, body, key);
    calls.push({ path, body });
    if (path === '/api/v1/signing-keys/rotate') {
      const key = { keyId: fixtures.uuid('signing-key'), tenantId: body.tenantId, state: 'ACTIVE' };
      state.resources.signingKeys.push(key);
      return { status: 200, json: key };
    }
    if (path === '/api/v1/login-attempts') {
      const providerRequestId = `actual/provider!${state.resources.loginAttempts.length}`;
      const response = await fetch(`${ctx.provider.baseUrl}/v1/login`, { method: 'POST', headers: {
        'content-type': 'application/json', 'idempotency-key': providerRequestId }, body: JSON.stringify({ providerRequestId, ...body }) });
      assert.equal(response.status, 200);
      const outcome = await response.json();
      const attempt = { loginAttemptId: fixtures.uuid(providerRequestId), tenantId: body.tenantId, deviceId: body.deviceId,
        providerRequestId: outcome.providerRequestId, state: outcome.outcome, userId: outcome.userId, sessionId: null,
        createdAt: fixtures.at(), resolvedAt: null, sequence: 0 };
      state.resources.loginAttempts.push(attempt);
      return { status: 200, json: outcome.outcome === 'SUCCEEDED' ? finish(attempt) : { loginAttempt: { ...attempt }, session: null, tokens: null } };
    }
    if (path === '/api/v1/provider/callbacks') {
      const attempt = state.resources.loginAttempts.find(attempt => attempt.providerRequestId === body.providerRequestId);
      assert.ok(attempt, 'callback references an actually returned provider identity');
      if (body.outcome === 'SUCCEEDED') finish(attempt);
      return { status: 200, json: { ...attempt } };
    }
    if (path.endsWith('/reconcile')) {
      assert.deepEqual(body, {});
      const attempt = state.resources.loginAttempts.find(attempt => path.includes(attempt.loginAttemptId));
      const response = await fetch(`${ctx.provider.baseUrl}/v1/login-requests/${encodeURIComponent(attempt.providerRequestId)}`);
      const outcome = await response.json();
      assert.equal(outcome.outcome, 'SUCCEEDED');
      return { status: 200, json: finish(attempt) };
    }
    throw new Error(`Unexpected author helper request ${path}`);
  };
  const { api } = await boot(ctx, { catalogs: [catalog], apiCount: 2, provider: { initialOutcome } });
  await ctx.startWorker({ env: { EXTRA: 'retained' } });
  assert.equal(roles.length, 3);
  assert.equal(disposers.length, 1, 'one provider is owned and closed by the case');
  assert(roles.every(role => role.env.PROVIDER_BASE_URL === ctx.provider.baseUrl));
  assert.equal(roles[2].env.EXTRA, 'retained');
  const login = await createSuccessfulSession(ctx, api.baseUrl, catalog, 'actual');
  assert.equal(login.providerRequestId, 'actual/provider!0');
  assert.equal(login.callback.userId, catalog.user.userId);
  assert.equal(login.callback.occurredAt, fixtures.at());
  assert.equal(login.callbackResponse.json.tokens, undefined);
  assert.equal(login.refreshToken, login.loginResponse.json.tokens.refreshToken);
  assert.equal(calls.filter(call => call.path.endsWith('/reconcile')).length, initialOutcome === 'UNKNOWN' ? 1 : 0);
  assert.equal(ctx.provider.requests.length, 1);
  assert.equal(JSON.stringify(ctx.provider.requests).includes(catalog.account.password), false);
  if (initialOutcome === 'UNKNOWN') {
    const unknown = await createUnknownAttempt(ctx, api.baseUrl, catalog, 'unresolved');
    assert.equal(unknown.providerRequestId, 'actual/provider!1');
    assert.equal(unknown.callback.userId, null);
    ctx.provider.resolve(unknown.providerRequestId, 'SUCCEEDED');
    const result = await ctx.reconcileLogin(api.baseUrl, unknown.attemptId, {});
    assert.equal(result.json.loginAttempt.providerRequestId, unknown.providerRequestId);
    assert.equal(state.resources.sessions.length, 2);
  }
  let closes = 0;
  const close = ctx.provider.close;
  ctx.provider.close = async () => { closes += 1; await close(); };
  await disposers.pop()();
  assert.equal(closes, 1, 'registered cleanup invokes the public helper close/fault check');
  await assert.rejects(fetch(`${ctx.provider.baseUrl}/v1/login-requests/closed`));
});
