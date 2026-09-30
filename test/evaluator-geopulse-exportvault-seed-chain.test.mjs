import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { E_CASES as geopulseCases } from '../evaluators/learning/geopulse/v2/cases/e.mjs';
import { createFixtureFactory as geopulseFixtures } from '../evaluators/learning/geopulse/v2/fixtures/index.mjs';
import { createFixtureFactory as exportvaultFixtures } from '../evaluators/learning/exportvault/v2/fixtures/index.mjs';

const root = resolve(import.meta.dirname, '..');

async function chain(t, taskId, createFixtureFactory) {
  await mkdir(join(root, '.tmp'), { recursive: true });
  const workspace = await mkdtemp(join(root, '.tmp', `${taskId}-seed-chain-`));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const publicRoot = join(workspace, 'contract');
  await mkdir(publicRoot);
  for (const name of ['contract.json', 'runtime.mjs', 'seed-reader.mjs', 'seed.mjs'])
    await cp(join(root, 'task-packages/v2', taskId, 'public-contract', name), join(publicRoot, name));
  await mkdir(join(workspace, 'dist'));
  // Stop at the business seam: author validation is exercised, no business pass is simulated.
  await writeFile(join(workspace, 'dist/lifecycle.js'), 'import {writeFileSync} from "node:fs"; writeFileSync("business-seed-reached.json",JSON.stringify(process.argv.slice(2)));');
  await writeFile(join(workspace, 'package.json'), JSON.stringify({ type: 'module', scripts: {
    build: 'node --version', 'db:migrate': 'node --version', 'db:seed': 'node contract/seed.mjs',
  } }));
  const previous = process.env.FRONTAL_PUBLIC_CONTRACT_ROOT;
  process.env.FRONTAL_PUBLIC_CONTRACT_ROOT = publicRoot;
  let runtime;
  try {
    runtime = await import(`${pathToFileURL(join(root, 'src/task-evaluator-v2/runtime.mjs')).href}?seedChain=${encodeURIComponent(workspace)}`);
  } finally {
    if (previous === undefined) delete process.env.FRONTAL_PUBLIC_CONTRACT_ROOT;
    else process.env.FRONTAL_PUBLIC_CONTRACT_ROOT = previous;
  }
  const { createCaseContext } = runtime.createCaseRuntime({
    taskSlug: taskId, databasePrefix: taskId, snapshotPath: '/api/v1/verification-snapshot', createFixtureFactory,
    adaptCompatibilityResponse: (_, response) => response.json,
    assertCompatibilityAdapter() {}, validateBarrierPayload() {},
  });
  const ctx = await createCaseContext({
    caseId: 'E-03', workspace, evaluationSeed: 'public-revision-seed-chain',
    baseTime: '2026-09-08T00:00:00.000Z', manageDatabase: false,
  });
  t.after(() => ctx.teardown());
  ctx.mark = () => {};
  return { ctx, workspace };
}

test('GeoPulse actual E-03 reaches API startup through the generated public seed CLI and evaluator gate', async t => {
  const { ctx, workspace } = await chain(t, 'geopulse', geopulseFixtures);
  const stop = new Error('author seed accepted; stop before business API');
  let reached = 0;
  ctx.startApi = async () => { reached += 1; throw stop; };
  await assert.rejects(geopulseCases.find(({ id }) => id === 'E-03').run(ctx), error => error === stop);
  assert.equal(reached, 1);
  const [command, flag, seedPath] = JSON.parse(await readFile(join(workspace, 'business-seed-reached.json')));
  assert.equal(command, 'db:seed');
  assert.equal(flag, '--file');
  const seed = JSON.parse(await readFile(seedPath));
  assert.equal(seed.devices.length, 2000);
  assert.equal(seed.regionVersions.length, 100);
  assert.equal(seed.regionVersions[1].polygon[1][0], -9.89);
});

test('ExportVault seedFile awaits the actual evaluator gate and generated public CLI before business import', async t => {
  const { ctx, workspace } = await chain(t, 'exportvault', exportvaultFixtures);
  const contract = JSON.parse(await readFile(join(workspace, 'contract/contract.json')));
  const file = join(workspace, 'seed.json');
  await writeFile(file, JSON.stringify(contract.seed.example));
  await ctx.seedFile(file);
  assert.deepEqual(JSON.parse(await readFile(join(workspace, 'business-seed-reached.json'))), ['db:seed', '--file', file]);
  const invalid = structuredClone(contract.seed.example);
  invalid.datasetRevisions[0].records[0].scope = 'unpublished';
  await writeFile(file, JSON.stringify(invalid));
  await assert.rejects(ctx.seedFile(file), error => error.code === 'EVALUATOR_PUBLIC_CONTRACT_MISMATCH');
  if (process.env.FRONTAL_LARGE_SEED_PATH) {
    await ctx.seedFile(process.env.FRONTAL_LARGE_SEED_PATH);
    assert.deepEqual(JSON.parse(await readFile(join(workspace, 'business-seed-reached.json'))), ['db:seed', '--file', process.env.FRONTAL_LARGE_SEED_PATH]);
  }
});
