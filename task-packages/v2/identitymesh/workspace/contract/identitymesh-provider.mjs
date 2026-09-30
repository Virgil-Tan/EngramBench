// Public local test provider only; no IdentityMesh business state or token issuance.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { validator } from './runtime.mjs';

export async function startIdentityMeshProvider({ contract, accounts = contract.providerProtocol.accounts,
  initialOutcome = 'SUCCEEDED', reconcileOutcome, responseDelayMs = 0 } = {}) {
  assert.equal(contract?.providerProtocol?.policyRevision, 'identitymesh-provider-2026-09-08.1',
    Object.assign(new Error('IdentityMesh provider requires its published protocol revision'),
      { origin: 'evaluator', code: 'EVALUATOR_PROVIDER_PROTOCOL_UNSUPPORTED' }));
  const outcomes = new Set(['SUCCEEDED', 'FAILED', 'UNKNOWN']);
  assert(outcomes.has(initialOutcome), 'Invalid initial provider outcome');
  assert(reconcileOutcome === undefined || outcomes.has(reconcileOutcome), 'Invalid reconciled provider outcome');
  assert(Number.isSafeInteger(responseDelayMs) && responseDelayMs >= 0, 'Invalid provider response delay');
  const compile = validator(contract);
  const validLogin = compile(contract.providerProtocol.login.request);
  const validOutcome = compile(contract.providerProtocol.login.response);
  const validCallback = compile({ $ref: '#/$defs/ProviderCallback' });
  const validAccount = compile({ type: 'object', additionalProperties: false,
    required: ['tenantId', 'userId', 'username', 'password'], properties: {
      tenantId: contract.schemas.User.properties.tenantId, userId: contract.schemas.User.properties.userId,
      username: contract.schemas.User.properties.username, password: contract.schemas.ProviderLoginRequest.properties.password,
    } });
  const configured = new Map();
  const registerAccounts = additions => {
    const pending = new Map();
    for (const account of additions) {
      assert(validAccount(account), 'Invalid explicit provider account');
      const key = JSON.stringify([account.tenantId, account.username]);
      const previous = pending.get(key) ?? configured.get(key);
      assert(!previous || (previous.userId === account.userId && previous.password === account.password), 'Conflicting tenant/username provider account');
      pending.set(key, { ...account });
    }
    for (const [key, account] of pending) configured.set(key, account);
  };
  registerAccounts(accounts);
  const records = new Map();
  const outcome = record => ({ providerRequestId: record.providerRequestId, outcome: record.outcome,
    userId: record.outcome === 'SUCCEEDED' ? record.authenticatedUserId : null });
  const resolve = (id, next) => {
    const record = records.get(id);
    assert(record, 'Unknown provider request');
    assert(outcomes.has(next), 'Invalid provider outcome');
    assert(record.outcome === 'UNKNOWN' || record.outcome === next, 'Cannot reverse terminal provider truth');
    assert(next !== 'SUCCEEDED' || record.authenticatedUserId, 'Invalid credentials cannot resolve to success');
    record.outcome = next;
    return outcome(record);
  };
  const send = (response, status, body) => {
    if (response.destroyed) return;
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  const error = (response, status, code) => send(response, status, { error: { code, message: code, details: {} } });
  let internalFailure;
  const assertHealthy = () => {
    if (internalFailure) throw Object.assign(new Error('EVALUATOR_PROVIDER_DOUBLE_FAILED'), { origin: 'evaluator', code: 'EVALUATOR_PROVIDER_DOUBLE_FAILED' });
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'POST' && url.pathname === '/v1/login' && !url.search) {
        if ((request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') return error(response, 415, 'UNSUPPORTED_MEDIA_TYPE');
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { return error(response, 400, 'INVALID_PROVIDER_REQUEST'); }
        if (!validLogin(body) || request.headers['idempotency-key'] !== body.providerRequestId) return error(response, 400, 'INVALID_PROVIDER_REQUEST');
        const requestDigest = createHash('sha256').update(JSON.stringify([body.tenantId, body.deviceId, body.username, body.password])).digest('hex');
        let record = records.get(body.providerRequestId);
        if (record && record.requestDigest !== requestDigest) return error(response, 409, 'PROVIDER_REQUEST_CONFLICT');
        if (!record) {
          const account = configured.get(JSON.stringify([body.tenantId, body.username]));
          const userId = account?.password === body.password ? account.userId : null;
          record = { providerRequestId: body.providerRequestId, tenantId: body.tenantId, deviceId: body.deviceId,
            requestDigest, authenticatedUserId: userId, outcome: userId ? initialOutcome : 'FAILED' };
          records.set(body.providerRequestId, record);
        }
        const result = outcome(record);
        assert(validOutcome(result), 'Invalid test-provider result');
        if (responseDelayMs) await new Promise(done => setTimeout(done, responseDelayMs));
        return send(response, 200, result);
      }
      const match = /^\/v1\/login-requests\/([^/]+)$/.exec(url.pathname);
      if (request.method === 'GET' && match && !url.search) {
        if (request.headers['transfer-encoding'] || Number(request.headers['content-length'] ?? 0) > 0) return error(response, 400, 'INVALID_PROVIDER_REQUEST');
        let id;
        try { id = decodeURIComponent(match[1]); }
        catch { return error(response, 400, 'INVALID_PROVIDER_REQUEST'); }
        const record = records.get(id);
        if (!record) return error(response, 404, 'PROVIDER_REQUEST_NOT_FOUND');
        if (record.outcome === 'UNKNOWN' && reconcileOutcome !== undefined) resolve(id, reconcileOutcome);
        return send(response, 200, outcome(record));
      }
      return error(response, 404, 'NOT_FOUND');
    } catch (cause) {
      if (!request.aborted) internalFailure ??= cause;
      // Internal author faults are not malformed caller input; never expose their payload.
      response.destroy();
    }
  });
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    get requests() { return [...records.values()].map(record => ({ ...outcome(record), tenantId: record.tenantId, deviceId: record.deviceId })); },
    registerAccounts,
    assertHealthy,
    resolve,
    callback(id, { providerCallbackId, occurredAt } = {}) {
      const record = records.get(id);
      assert(record, 'Unknown provider request');
      const body = { providerCallbackId, ...outcome(record), occurredAt };
      assert(validCallback(body), 'Invalid provider callback metadata');
      return body;
    },
    async close() {
      await new Promise((done, fail) => { server.close(error => error ? fail(error) : done()); server.closeAllConnections(); });
      assertHealthy();
    },
  };
}
