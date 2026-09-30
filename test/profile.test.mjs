import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProfile } from '../scripts/run-v2.mjs';
import { LEARNING_TASK_ORDER, TRANSFER_TASK_ORDER, TASK_ORDER, resolveTaskOrder } from '../src/task-order.mjs';
test('V2 accepts exactly the canonical 30 Learning IDs and preserves their order', () => {
  const entries = [...LEARNING_TASK_ORDER.map(id => ({ id, phase: 'learning' })), ...TRANSFER_TASK_ORDER.map(id => ({ id, phase: 'transfer' }))];
  assert.equal(LEARNING_TASK_ORDER.length, 30);
  assert.equal(TRANSFER_TASK_ORDER.length, 13);
  assert.deepEqual(resolveTaskOrder(entries, ['firmwarefleet', 'launchpass']), ['launchpass', 'firmwarefleet']);
  assert.throws(() => resolveTaskOrder(entries.slice(1)), /missing/);
  assert.deepEqual(resolveTaskOrder(entries, ['capacitylease', 'metersettle']), ['metersettle', 'capacitylease']);
  assert.throws(() => resolveTaskOrder(entries, ['unknown-task']), /Unknown/);
});

test('all 13 Transfer tasks use the same runner without changing Learning labels or enabling evolution', () => {
  const profile = { benchmarkVersion: 2, runId: 'superhard-test', taskIds: ['coldchaincontrol'], arm: 'guide', ownerId: 'test', authFile: '/test/auth.json', agentImage: 'fixture', memoraxHomeSeed: '/frozen/bank', agent: { model: 'fixture', effort: 'medium' }, user: { model: 'fixture', baseUrlEnv: 'BASE', apiKeyEnv: 'KEY' }, evolution: false };
  for (const id of TRANSFER_TASK_ORDER) {
    const selected = { ...profile, taskIds: [id] };
    assert.equal(validateProfile(selected, TASK_ORDER).taskIds[0], id);
    assert.throws(() => validateProfile({ ...selected, evolution: true }, TASK_ORDER), /Transfer tasks are execution-only/);
  }
});

test('existing workspaces require explicit migration purpose and an exact source map', () => {
  const base = { benchmarkVersion: 2, runId: 'migration-fixture', taskIds: ['mediadock'], arm: 'baseline', ownerId: 'test', authFile: '/test/auth.json', agentImage: 'fixture', agent: { model: 'fixture', effort: 'medium' }, user: { model: 'fixture', baseUrlEnv: 'BASE', apiKeyEnv: 'KEY' } };
  const migration = { ...base, purpose: 'migration-repair', sourceWorkspaces: { mediadock: '/old/workspace' } };
  assert.equal(validateProfile(migration, LEARNING_TASK_ORDER).purpose, 'migration-repair');
  assert.equal(validateProfile({ ...migration, arm: 'guide', memoraxHomeSeed: '/frozen/bank' }, LEARNING_TASK_ORDER).arm, 'guide');
  assert.throws(() => validateProfile({ ...migration, purpose: 'benchmark' }, LEARNING_TASK_ORDER), /explicit migration/);
  assert.throws(() => validateProfile({ ...migration, sourceWorkspaces: {} }, LEARNING_TASK_ORDER), /one source/);
  assert.throws(() => validateProfile({ ...migration, sourceWorkspaces: { mediadock: '/a', geopulse: '/b' } }, LEARNING_TASK_ORDER), /one source/);
  assert.throws(() => validateProfile({ ...migration, arm: 'guide', memoraxHomeSeed: '/bank', evolution: true }, LEARNING_TASK_ORDER), /defers Evolution/);
  assert.equal(validateProfile({ ...base, codexConfigFile: '/isolated-api/config.toml' }, LEARNING_TASK_ORDER).codexConfigFile, '/isolated-api/config.toml');
  assert.throws(() => validateProfile({ ...base, codexConfigFile: '' }, LEARNING_TASK_ORDER), /independent provider configuration/);
});
test('profiles cannot silently mix versions, baseline plugins, or Guide without a bank', () => {
  const profile = { benchmarkVersion: 2, runId: 'test-v2', taskIds: ['mediadock'], arm: 'baseline', ownerId: 'test', authFile: '/test/auth.json', agentImage: 'fixture-image', agent: { model: 'fixture', effort: 'medium' }, user: { model: 'fixture', baseUrlEnv: 'BASE', apiKeyEnv: 'KEY' } };
  assert.equal(validateProfile(profile, LEARNING_TASK_ORDER).arm, 'baseline');
  assert.throws(() => validateProfile({ ...profile, benchmarkVersion: 1 }, LEARNING_TASK_ORDER), /benchmarkVersion/);
  assert.throws(() => validateProfile({ ...profile, arm: 'guide' }, LEARNING_TASK_ORDER), /seed/);
  assert.throws(() => validateProfile({ ...profile, arm: 'native' }, LEARNING_TASK_ORDER), /skills/);
  assert.throws(() => validateProfile({ ...profile, evolution: true }, LEARNING_TASK_ORDER), /Evolution/);
});

test('in-place continuation explicitly binds absolute original paths and one external backup per task', () => {
  const profile = { benchmarkVersion: 2, purpose: 'migration-repair', runId: 'in-place-fixture', taskIds: ['coldchaincontrol'], arm: 'baseline', ownerId: 'test', authFile: '/test/auth.json', agentImage: 'fixture', agent: { model: 'fixture', effort: 'medium' }, user: { model: 'fixture', baseUrlEnv: 'BASE', apiKeyEnv: 'KEY' }, evolution: false, migrationMode: 'in-place', sourceWorkspaces: { coldchaincontrol: '/original/workspace' }, backupWorkspaces: { coldchaincontrol: '/private/original-backup' } };
  assert.equal(validateProfile(profile, TASK_ORDER).migrationMode, 'in-place');
  assert.throws(() => validateProfile({ ...profile, backupWorkspaces: undefined }, TASK_ORDER), /absolute source and backup/);
  assert.throws(() => validateProfile({ ...profile, sourceWorkspaces: { coldchaincontrol: './workspace' } }, TASK_ORDER), /absolute source and backup/);
  assert.throws(() => validateProfile({ ...profile, migrationMode: undefined }, TASK_ORDER), /explicit in-place/);
  assert.throws(() => validateProfile({ ...profile, migrationMode: 'surprise' }, TASK_ORDER), /migrationMode/);
  assert.throws(() => validateProfile({ ...profile, purpose: 'development' }, TASK_ORDER), /explicit migration/);
});

test('development starts from the public V2 starter and explicitly defers evaluation and evolution', () => {
  const profile = { benchmarkVersion: 2, purpose: 'development', runId: 'development-fixture', taskIds: ['dockchain'], arm: 'guide', ownerId: 'test', authFile: '/test/auth.json', agentImage: 'fixture', memoraxHomeSeed: '/independent/bank', agent: { model: 'gpt-5.5', effort: 'medium' }, user: { model: 'deepseek-v4-pro', baseUrlEnv: 'BASE', apiKeyEnv: 'KEY' }, evolution: false };
  assert.equal(validateProfile(profile, TASK_ORDER).purpose, 'development');
  assert.throws(() => validateProfile({ ...profile, evolution: undefined }, TASK_ORDER), /development.*evolution:false/i);
  assert.throws(() => validateProfile({ ...profile, sourceWorkspaces: { dockchain: '/prior/code' } }, TASK_ORDER), /explicit migration/);
});

test('component ablation is explicitly distinguished from Full Guide and cannot use another transport', () => {
  const profile = { benchmarkVersion: 2, purpose: 'development', runId: 'ablation-fixture', taskIds: ['dockchain'], arm: 'guide', ownerId: 'test', authFile: '/test/auth.json', agentImage: 'fixture', memoraxHomeSeed: '/independent/seed', agent: { model: 'gpt-5.5', effort: 'medium' }, user: { model: 'deepseek-v4-pro', baseUrlEnv: 'BASE', apiKeyEnv: 'KEY' }, evolution: false };
  for (const variant of ['selector_direct', 'generic_advisor']) {
    assert.equal(validateProfile({ ...profile, ablationVariant: variant }, TASK_ORDER).ablationVariant, variant);
    assert.throws(() => validateProfile({ ...profile, ablationVariant: variant, arm: 'baseline' }, TASK_ORDER), /guide transport/);
    assert.throws(() => validateProfile({ ...profile, ablationVariant: variant, arm: 'native', nativeSkillsRoot: '/native' }, TASK_ORDER), /guide transport/);
  }
  assert.throws(() => validateProfile({ ...profile, ablationVariant: 'full' }, TASK_ORDER), /ablationVariant/);
  assert.equal(validateProfile(profile, TASK_ORDER).ablationVariant, undefined);
});
