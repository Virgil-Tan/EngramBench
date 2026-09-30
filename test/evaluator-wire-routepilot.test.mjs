import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { evaluatorContract } from '../src/task-evaluator-v2/public-contract.mjs';
import { validator } from '../templates/contract-first/runtime.mjs';
import { createFixtureFactory } from '../evaluators/learning/routepilot/v2/fixtures/index.mjs';
import { CASES } from '../evaluators/learning/routepilot/v2/cases/index.mjs';
import { createCaseContext } from '../evaluators/learning/routepilot/v2/lib/runtime.mjs';
import { validateCaseRegistry } from '../evaluators/learning/routepilot/v2/lib/execution.mjs';
import { validateManifest } from '../evaluators/learning/routepilot/v2/lib/scoring.mjs';
import { chooseRoute } from '../evaluators/learning/routepilot/v2/oracles/index.mjs';
import { createRelease, rollbackRelease, createRollout, getRollout, controlRollout, dispatch } from '../evaluators/learning/routepilot/v2/cases/helpers.mjs';
import { assertPublicationRequestRoutes } from '../evaluators/learning/routepilot/v2/cases/b.mjs';

const root = resolve(import.meta.dirname, '..');
const contractRoot = resolve(root, 'task-packages/v2/routepilot/public-contract');
const contract = JSON.parse(await readFile(resolve(contractRoot, 'contract.json')));
const boundary = await evaluatorContract(contractRoot), compile = validator(contract);
const manifest = JSON.parse(await readFile(resolve(root, 'evaluators/learning/routepilot/v2/manifest.v2.json')));
const map = JSON.parse(await readFile(resolve(root, 'evaluators/learning/routepilot/v2/contract-map.v2.json')));
const settings = { evaluationSeed: 'wire-review', baseTime: '2026-01-01T00:00:00.000Z' };

async function context(t, caseId = 'A-01') {
  const ctx = await createCaseContext({ ...settings, caseId, workspace: root, v1Workspace: root, manageDatabase: false });
  t.after(() => ctx.teardown());
  return ctx;
}

test('routepilot retains all 22 registered cases and weights without readiness placeholders', () => {
  assert.equal(CASES.length, 22);
  assert.equal(validateManifest(manifest, map), true);
  assert.doesNotThrow(() => validateCaseRegistry(manifest, CASES));
  assert.deepEqual(manifest.cases.filter(item => item.blockedAssertions).map(item => item.id), []);
});

test('all routepilot fixture families and each case first seed satisfy the fixed public schema', async t => {
  const fixtures = createFixtureFactory({ ...settings, caseId: 'A-01' });
  for (const family of ['contract', 'routing', 'rollout', 'recovery', 'layer', 'operate', 'v1Final']) {
    const fixture = fixtures[family]();
    boundary.seed(fixture.seed);
    for (const revision of fixture.seed.routeRevisions) assert.deepEqual(revision.headerMatches, {});
  }
  const rollout = fixtures.rollout();
  assert.equal(rollout.rate, rollout.seed.rateLimitPolicies[0], 'D-04 mutates the actual seeded rate policy');
  assert.equal(rollout.circuit, rollout.seed.circuitPolicies[0]);
  assert.ok(rollout.seed.tenants.includes(rollout.otherTenant));
  for (const item of CASES) {
    const ctx = await context(t, item.id), stop = new Error(`${item.id} author fixture captured`);
    let checked = false;
    ctx.migrate = async () => {};
    ctx.seed = async value => {
      boundary.seed(value);
      // Public foreign-key ownership is preserved in the performance tenant graph.
      const routes = new Map(value.routeDefinitions.map(row => [row.routeId, row]));
      const circuits = new Map(value.circuitPolicies.map(row => [row.circuitPolicyId, row]));
      for (const revision of value.routeRevisions) if (revision.circuitPolicyId !== null) assert.equal(circuits.get(revision.circuitPolicyId).tenantId, routes.get(revision.routeId).tenantId);
      checked = true; throw stop;
    };
    await assert.rejects(item.run(ctx), error => error === stop, item.id);
    assert.equal(checked, true, `${item.id} reaches a valid positive seed`);
  }
});

test('routepilot positive helpers use exact request schemas, including first release and duplicate region order', async t => {
  const ctx = await context(t), fixture = ctx.fixtures.rollout(), calls = [], url = 'http://127.0.0.1:1';
  ctx.snapshot = async () => ({ resources: fixture.seed, work: [], events: [] });
  ctx.request = async (_base, path, options = {}) => {
    boundary.request(path, options); calls.push({ path, options });
    return { status: 200, json: { regionalRollout: { regionalRolloutId: ctx.uuid('rollout') }, stages: [] } };
  };
  ctx.mutate = (base, path, key, json, options = {}) => ctx.request(base, path, { ...options, method: 'POST', headers: { 'Idempotency-Key': key }, json });
  await dispatch(ctx, url, fixture, 1);
  await createRelease(ctx, url, fixture, 'active');
  assert.equal(calls.at(-1).options.json.expectedActiveVersion, 1);
  await rollbackRelease(ctx, url, fixture.release.configReleaseId, 1);
  await createRollout(ctx, url, fixture, 'regions');
  assert.equal(calls.at(-1).options.json.stages.length, 4, 'first-occurrence deduplication remains a candidate business requirement');
  await getRollout(ctx, url, ctx.uuid('rollout'));
  for (const action of ['pause', 'resume', 'cancel', 'rollback']) await controlRollout(ctx, url, ctx.uuid('rollout'), action);
  for (const path of ['/api/v1/config-releases', '/api/v1/regional-rollouts']) await ctx.request(url, `${path}?tenantId=${fixture.tenant.tenantId}&limit=1`);
  ctx.snapshot = async () => ({ resources: { configReleases: [] }, work: [], events: [] });
  await createRelease(ctx, url, fixture, 'first');
  assert.equal(calls.at(-1).options.json.version, 1);
  assert.equal(calls.at(-1).options.json.expectedActiveVersion, 0);
  const { routeRevisionId: _id, createdAt: _at, ...revision } = fixture.seed.routeRevisions[0];
  await ctx.mutate(url, '/api/v1/route-revisions', ctx.key('revision'), { ...revision, headerMatches: { 'x-plan': 'gold' } });
  await assert.rejects(ctx.mutate(url, '/api/v1/route-revisions', ctx.key('legacy-header'), { ...revision, headerMatches: [] }), error => error.code === 'EVALUATOR_PUBLIC_CONTRACT_MISMATCH');
  await assert.rejects(ctx.request(url, '/api/v1/config-releases?limit=1'), error => error.code === 'EVALUATOR_PUBLIC_CONTRACT_MISMATCH');
});

test('routepilot header matching reads the public string map and backend output uses true redaction', () => {
  const fixture = createFixtureFactory({ ...settings, caseId: 'A-01' }).routing();
  const definition = fixture.definitions.find(item => item.name === 'orders-param');
  const route = { ...definition, ...definition.revision, headerMatches: { 'X-Plan': 'gold' } };
  const input = { method: 'POST', path: '/orders/42', headers: { 'x-plan': 'gold' } };
  assert.equal(chooseRoute([route], input).routeId, route.routeId);
  assert.equal(chooseRoute([route], { ...input, headers: { 'x-plan': 'silver' } }), null);
  assert.equal(chooseRoute([route], { ...input, headers: {} }), null);
  const valid = compile(contract.schemas.Backend), { origin: _origin, ...backend } = fixture.seed.backends[0];
  assert.equal(valid({ ...backend, originRedacted: true }), true, JSON.stringify(valid.errors));
  assert.equal(valid({ ...backend, originRedacted: '[REDACTED]' }), false);
});

test('routepilot seed helper executes only the published seed command after positive validation', async t => {
  const ctx = await context(t), calls = [], fixture = ctx.fixtures.contract();
  ctx.command = async (binary, args, options) => { await boundary.command(binary, args, options); calls.push({ binary, args }); return { exitCode: 0 }; };
  await ctx.seed(fixture.seed);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].binary, 'npm');
  assert.deepEqual(calls[0].args.slice(0, 4), ['run', 'db:seed', '--', '--file']);
  const bad = structuredClone(fixture.seed); bad.routeRevisions[0].headerMatches = [];
  await assert.rejects(ctx.seed(bad, { allowFailure: true }), error => error.code === 'EVALUATOR_PUBLIC_CONTRACT_MISMATCH');
  assert.equal(calls.length, 1, 'allowFailure never admits an invalid positive fixture');
});

test('routepilot publication accepts public null-route rejection but preserves frozen release and no-upstream assertions', () => {
  const release = contract.seed.example.configReleases[0];
  const request = { gatewayRequestId: '00000000-0000-4000-8000-000000000010', tenantId: release.tenantId, requestKey: 'b01-rejected', configReleaseId: release.configReleaseId, routeRevisionId: null, backendId: null, backendVersion: null, bucket: null, status: 'REJECTED', responseStatus: 404, createdAt: contract.seed.example.importedAt };
  const valid = compile(contract.schemas.GatewayRequest);
  assert.equal(valid(request), true, JSON.stringify(valid.errors));
  assert.doesNotThrow(() => assertPublicationRequestRoutes([request], [release], []));
  assert.throws(() => assertPublicationRequestRoutes([request], [], []), /known frozen release/);
  assert.throws(() => assertPublicationRequestRoutes([{ ...request, status: 'SUCCEEDED' }], [release], []), /without a route is rejected/);
  assert.throws(() => assertPublicationRequestRoutes([request], [release], [{ gatewayRequestId: request.gatewayRequestId }]), /no upstream attempt/);
  assert.throws(() => assertPublicationRequestRoutes([{ ...request, responseStatus: 429 }], [release], []), /ROUTE_NOT_FOUND/);
  const routed = { ...request, routeRevisionId: release.routeRevisionIds[0], status: 'SUCCEEDED', responseStatus: 200 };
  assert.doesNotThrow(() => assertPublicationRequestRoutes([routed], [release], []));
  assert.throws(() => assertPublicationRequestRoutes([{ ...routed, routeRevisionId: request.gatewayRequestId }], [release], []), /one complete frozen release/);
});
