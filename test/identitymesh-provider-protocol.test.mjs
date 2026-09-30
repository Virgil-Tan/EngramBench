import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import contract from '../contracts/learning/identitymesh.mjs';
import { applyFinalSystemPolicy } from '../contracts/learning/final-system-policy.mjs';

const historical = JSON.parse(await readFile(new URL('../reports/learning30-v2-hidden-20260907/frozen-packages/identitymesh/public-contract/contract.json', import.meta.url)));

async function provider(options = {}) {
  const { startIdentityMeshProvider } = await import('../templates/contract-first/identitymesh-provider.mjs');
  return startIdentityMeshProvider({ contract, ...options });
}

function loginBody(providerRequestId = 'public-request') {
  const account = contract.providerProtocol.accounts[0];
  return { providerRequestId, tenantId: account.tenantId, deviceId: contract.seed.example.devices[0].deviceId,
    username: account.username, password: account.password };
}

async function login(server, body) {
  const response = await fetch(`${server.baseUrl}/v1/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': body.providerRequestId }, body: JSON.stringify(body) });
  return { status: response.status, json: await response.json() };
}

test('IdentityMesh provider uses its own protocol revision under the final-system policy', async t => {
  const generated = JSON.parse(await readFile(new URL('../task-packages/v2/identitymesh/public-contract/contract.json', import.meta.url)));
  const revised = applyFinalSystemPolicy(structuredClone(contract));
  for (const current of [revised, generated]) {
    assert.notEqual(current.policyRevision, current.providerProtocol.policyRevision);
    const server = await provider({ contract: current });
    t.after(() => server.close());
    const response = await login(server, loginBody());
    assert.equal(response.status, 200);
    assert.equal(response.json.outcome, 'SUCCEEDED');
    server.assertHealthy();
  }
});

test('IdentityMesh provider rejects missing or unsupported protocol revisions as author errors', async () => {
  for (const revision of [undefined, 'unsupported-provider-revision']) {
    const invalid = structuredClone(contract);
    invalid.providerProtocol.policyRevision = revision;
    await assert.rejects(async () => {
      const server = await provider({ contract: invalid });
      await server.close();
    }, error =>
      error.origin === 'evaluator' && error.code === 'EVALUATOR_PROVIDER_PROTOCOL_UNSUPPORTED');
  }
});

test('IdentityMesh publishes a named, non-retroactive local provider protocol without changing incoming login endpoints', () => {
  assert.equal(contract.policyRevision, 'identitymesh-provider-2026-09-08.1');
  assert.equal(contract.providerProtocol.baseUrlEnvironment, 'PROVIDER_BASE_URL');
  assert.deepEqual([contract.providerProtocol.login.method, contract.providerProtocol.login.path], ['POST', '/v1/login']);
  assert.deepEqual([contract.providerProtocol.query.method, contract.providerProtocol.query.path], ['GET', '/v1/login-requests/:providerRequestId']);
  for (const [id, path] of [['create-login-attempt', '/api/v1/login-attempts'], ['provider-callback', '/api/v1/provider/callbacks'], ['reconcile-login-attempt', '/api/v1/login-attempts/:attemptId/reconcile']]) {
    const current = contract.operations.find(operation => operation.id === id);
    const original = historical.operations.find(operation => operation.id === id);
    assert.equal(current.path, path);
    for (const field of ['method', 'path', 'request', 'response', 'parameters', 'status', 'errors'])
      assert.deepEqual(current[field], original[field], `${id}: original incoming ${field} changed`);
  }
  assert(contract.notes.some(note => note.includes('not the unchanged historical benchmark')));
  assert(contract.notes.some(note => note.includes('Credentials are never persisted')));
  assert.equal(contract.providerProtocol.accounts[0].userId, contract.seed.example.users[0].userId);
});

test('IdentityMesh public double authenticates only explicit tenant-scoped credentials and preserves request identity', async t => {
  const server = await provider();
  t.after(() => server.close());
  const body = loginBody();
  const first = await login(server, body);
  assert.deepEqual(first, { status: 200, json: { providerRequestId: body.providerRequestId, outcome: 'SUCCEEDED', userId: contract.providerProtocol.accounts[0].userId } });
  assert.deepEqual(await login(server, body), first);
  assert.equal(server.requests.length, 1);
  assert.equal((await login(server, { ...body, password: 'different' })).status, 409);
  assert.equal((await login(server, { ...body, providerRequestId: 'invalid-credential', password: 'different' })).json.outcome, 'FAILED');
  assert.equal((await login(server, { ...body, providerRequestId: 'cross-tenant', tenantId: '00000000-0000-4000-8000-000000000099' })).json.outcome, 'FAILED');
  assert(!JSON.stringify(server.requests).includes(body.password));
  assert(!JSON.stringify(server.requests).includes('password'));
});

test('IdentityMesh UNKNOWN query and duplicate or delayed callbacks retain one stable provider identity', async t => {
  const server = await provider({ initialOutcome: 'UNKNOWN', reconcileOutcome: 'SUCCEEDED', responseDelayMs: 5 });
  t.after(() => server.close());
  const body = loginBody('unknown/request');
  assert.equal((await login(server, body)).json.outcome, 'UNKNOWN');
  const old = server.callback(body.providerRequestId, { providerCallbackId: 'earlier-unknown', occurredAt: '2026-01-01T00:00:00.000Z' });
  const response = await fetch(`${server.baseUrl}/v1/login-requests/${encodeURIComponent(body.providerRequestId)}`);
  const resolved = await response.json();
  assert.deepEqual(resolved, { providerRequestId: body.providerRequestId, outcome: 'SUCCEEDED', userId: contract.providerProtocol.accounts[0].userId });
  const terminal = server.callback(body.providerRequestId, { providerCallbackId: 'terminal-success', occurredAt: '2026-01-01T00:00:01.000Z' });
  assert.equal(old.outcome, 'UNKNOWN');
  assert.equal(old.userId, null);
  assert.equal(terminal.outcome, 'SUCCEEDED');
  assert.deepEqual(server.callback(body.providerRequestId, { providerCallbackId: 'terminal-success', occurredAt: terminal.occurredAt }), terminal);
  assert.throws(() => server.resolve(body.providerRequestId, 'FAILED'), /terminal/i);
  assert.equal(server.requests.length, 1);
  assert.equal((await fetch(`${server.baseUrl}/v1/login-requests/missing`)).status, 404);
});
