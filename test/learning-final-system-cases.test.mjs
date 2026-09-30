import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { evaluatorContract } from '../src/task-evaluator-v2/public-contract.mjs';

const root = resolve(import.meta.dirname, '..');
const tasks = ['schemaharbor', 'importworks', 'rulebench', 'auctionguard', 'queueforge', 'ledgerbridge', 'geopulse', 'quotamesh', 'clinicgrid', 'dispatchboard', 'routeweave', 'edgetwin', 'reconcilehub', 'mergeboard', 'artifactvault', 'exportvault', 'firmwarefleet', 'configorbit', 'entitlementhub', 'moderationflow', 'fraudlens', 'seatreserve', 'routepilot', 'mediadock', 'identitymesh', 'launchpass', 'evidencechain', 'configrelay', 'billforge', 'notifyroute'];
const revision = 'learning-final-system-2026-09-08.1';
const json = async path => JSON.parse(await readFile(resolve(root, path), 'utf8'));

for (const taskId of tasks) {
  test(`${taskId}: final-system revision preserves scoring and every case implementation`, async () => {
    const base = `evaluators/learning/${taskId}/v2`;
    const manifest = await json(`${base}/manifest.v2.json`);
    const map = await json(`${base}/contract-map.v2.json`);
    const { CASES } = await import(`../${base}/cases/index.mjs`);
    const { validateManifest } = await import(`../${base}/lib/scoring.mjs`);
    const { parseArgs } = await import(`../${base}/run.mjs`);
    assert.equal(manifest.policyRevision, revision);
    assert.equal(manifest.evaluationScope, 'final-system');
    assert.equal(manifest.cases.length, 22);
    assert.equal(manifest.cases.reduce((sum, item) => sum + item.weight, 0), 100);
    assert.equal(validateManifest(manifest, map), true);
    assert.deepEqual(CASES.map(({ id }) => id).sort(), manifest.cases.map(({ id }) => id).sort());
    const command = ['--workspace', root, '--result', '/tmp/not-run-final-result.json', '--seed', 'cli-only'];
    assert.equal(parseArgs(command).workspace, root);
    assert.throws(() => parseArgs([...command, '--v1-workspace', root]), /argument/);
    for (const item of manifest.cases) {
      assert.equal(item.blockedAssertions, undefined, `${item.id} has no author placeholder`);
      assert.ok(!item.prerequisites.some(value => ['V1', 'V1_CHECKPOINT', 'frozen_v1_checkpoint'].includes(value)), item.id);
      if (item.policyRevision !== revision) continue;
      const implementation = CASES.find(({ id }) => id === item.id);
      assert.equal(typeof implementation.run, 'function');
      assert.doesNotMatch(implementation.run.toString(), /requireV1|v1Workspace|missing_v1_checkpoint/);
    }
  });

  test(`${taskId}: revised cases enter public FINAL setup without an intermediate workspace`, async t => {
    const base = `evaluators/learning/${taskId}/v2`;
    const manifest = await json(`${base}/manifest.v2.json`);
    const { CASES } = await import(`../${base}/cases/index.mjs`);
    const { createCaseContext } = await import(`../${base}/lib/runtime.mjs`);
    const publicBoundary = await evaluatorContract(resolve(root, `task-packages/v2/${taskId}/public-contract`));
    for (const definition of manifest.cases.filter(({ policyRevision }) => policyRevision === revision)) {
      const ctx = await createCaseContext({ caseId: definition.id, workspace: root, evaluationSeed: 'final-system-author-regression', baseTime: '2026-09-08T00:00:00.000Z', manageDatabase: false });
      t.after(() => ctx.teardown());
      if (typeof ctx.evidence?.finish === 'function') {
        assert.doesNotThrow(() => ctx.evidence.finish(), `${definition.id}: final evidence must not require a withdrawn diagnostic`);
      }
      const boundary = new Error(`public FINAL boundary: ${taskId}/${definition.id}`);
      const observed = [];
      ctx.forWorkspace = workspace => { assert.equal(resolve(workspace), root); return ctx; };
      ctx.command = ctx.npm = ctx.migrate = async () => ({ exitCode: 0, stdout: '', stderr: '' });
      ctx.resetDatabase = async () => {};
      ctx.seed = async value => { publicBoundary.seed(value); observed.push('seed'); throw boundary; };
      ctx.seedFile = async () => { observed.push('seed-file'); throw boundary; };
      ctx.startApi = async () => { observed.push('api'); throw boundary; };
      ctx.readOpenApi = async () => { observed.push('openapi-artifact'); throw boundary; };
      await assert.rejects(CASES.find(({ id }) => id === definition.id).run(ctx), error => error === boundary, definition.id);
      assert.equal(observed.length, 1, `${definition.id} reaches a real candidate-facing seed, API or artifact boundary`);
    }
  });

  test(`${taskId}: final-system changes retain the public API namespace`, async () => {
    const directory = resolve(root, `evaluators/learning/${taskId}/v2/cases`);
    for (const filename of await readdir(directory)) {
      if (!filename.endsWith('.mjs')) continue;
      const source = await readFile(resolve(directory, filename), 'utf8');
      assert.doesNotMatch(source, /\/api\/(?:initialRuntime|currentRuntime|finalRuntime|initialApi|oldApi|base-system)\//, filename);
    }
  });
}
