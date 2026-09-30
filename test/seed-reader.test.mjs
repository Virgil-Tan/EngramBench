import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { readSeedJsonFile } from '../templates/contract-first/seed-reader.mjs';
import { validator } from '../templates/contract-first/runtime.mjs';
import { evaluatorContract } from '../src/task-evaluator-v2/public-contract.mjs';
import contract from '../contracts/learning/exportvault.mjs';

const root = resolve(import.meta.dirname, '..');
async function fixture(t) {
  await mkdir(join(root, '.tmp'), { recursive: true });
  const directory = await mkdtemp(join(root, '.tmp/seed-reader-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('chunked seed JSON has JSON.parse semantics across UTF-8, escape, scalar and punctuation boundaries', async t => {
  const file = join(await fixture(t), 'seed.json');
  const inputs = [
    'null', 'true', 'false', '0', '-0', '-2.5e+12', '1e309', '"你好😀"',
    ' {"a":[null,true,false,{},[],1e-2],"b":{"c":"x\\\"\\\\\\b\\f\\n\\r\\t\\uD83D\\uDE00"}} \r\n',
    '{"a":false,"\\u0061":true,"__proto__":{"polluted":true},"constructor":42}',
    '{"rows":[{"invalid":1}],"rows":[]}',
    JSON.stringify({ boundary: 'x'.repeat(256 * 1024), end: ['last'] }),
  ];
  for (const input of inputs) {
    await writeFile(file, input);
    for (const highWaterMark of input.length > 10000 ? [4096, 65536] : [1, 2, 3, 7, 65536]) {
      const actual = await readSeedJsonFile(file, { highWaterMark });
      assert.deepStrictEqual(actual, JSON.parse(input));
      if (actual && Object.hasOwn(actual, '__proto__')) assert.equal(Object.getPrototypeOf(actual), Object.prototype);
    }
  }
});

test('chunked seed JSON rejects malformed structure and tokens including trailing and truncated input', async t => {
  const file = join(await fixture(t), 'seed.json');
  for (const input of ['', ' ', '\uFEFF{}', '{}[]', 'null true', '[1,]', '[,1]', '[1 2]', '{"a":}', '{"a":1,}', '{1:2}', '{"a" 1}', '{"a":1', '"unterminated', '"bad\\q"', '"bad\nline"', '01', '+1', '1.', '1e', 'undefined', 'NaN', '{]']) {
    await writeFile(file, input);
    assert.throws(() => JSON.parse(input), SyntaxError);
    for (const highWaterMark of [1, 7]) await assert.rejects(readSeedJsonFile(file, { highWaterMark }), SyntaxError);
  }
});

test('incremental seed parsing retains complete ExportVault schema validation and duplicate-key semantics', async t => {
  const file = join(await fixture(t), 'seed.json');
  const valid = validator(contract)(contract.seed.schema);
  const original = structuredClone(contract.seed.example);
  const cases = [
    seed => { seed.datasetRevisions[0].records.push({ ...seed.datasetRevisions[0].records[0], scope: 'unpublished' }); },
    seed => { delete seed.datasetRevisions[0].records[0].data; },
    seed => { seed.subjects[0].unexpected = true; },
    seed => { delete seed.datasetRevisions; },
    seed => { seed.extra = []; },
    seed => { seed.schemaVersion = 2; },
  ];
  for (const mutate of [() => {}, ...cases]) {
    const seed = structuredClone(original); mutate(seed);
    await writeFile(file, JSON.stringify(seed));
    assert.equal(valid(await readSeedJsonFile(file, { highWaterMark: 7 })), valid(seed));
  }
  const object = { sha256: 'a'.repeat(64), size: 1, mediaType: 'application/x-ndjson' };
  const exported = {
    exportId: '00000003-0000-4000-8000-000000000001', subjectId: original.subjects[0].subjectId,
    scope: ['profile'], format: 'JSONL', datasetRevision: 1, state: 'READY', object,
    retentionUntil: '2040-01-01T00:00:00.000Z', createdAt: '2030-01-01T00:00:00.000Z',
    readyAt: '2030-01-01T00:00:01.000Z', sequence: 1, assetPath: 'assets/ready.jsonl',
  };
  for (const mutate of [() => {}, value => { value.scope.push('profile'); }, value => { value.scope = []; }, value => { delete value.assetPath; }, value => { value.object = null; }]) {
    const value = structuredClone(exported); mutate(value);
    const seed = { ...original, exports: [value] };
    await writeFile(file, JSON.stringify(seed));
    assert.equal(valid(await readSeedJsonFile(file, { highWaterMark: 7 })), valid(seed));
  }
  const text = JSON.stringify(original).replace('"exports":[]', '"exports":[{"invalid":true}],"exports":[]');
  await writeFile(file, text);
  assert.equal(valid(await readSeedJsonFile(file, { highWaterMark: 7 })), true);
});

test('public seed --file validates before lifecycle and keeps the original command and file path', async t => {
  const directory = await fixture(t), publicRoot = join(directory, 'contract'), file = join(directory, 'seed.json');
  await mkdir(publicRoot); await mkdir(join(directory, 'dist'));
  for (const name of ['runtime.mjs', 'seed.mjs', 'seed-reader.mjs']) await cp(join(root, 'templates/contract-first', name), join(publicRoot, name));
  await writeFile(join(publicRoot, 'contract.json'), JSON.stringify(contract));
  await writeFile(join(directory, 'dist/lifecycle.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
  const boundary = await evaluatorContract(publicRoot);
  const command = ['run', 'db:seed', '--', '--file', file];
  await writeFile(file, JSON.stringify(contract.seed.example));
  await boundary.command('npm', command);
  assert.deepEqual(JSON.parse(execFileSync(process.execPath, [join(publicRoot, 'seed.mjs'), '--file', file], { encoding: 'utf8' })), ['db:seed', '--file', file]);
  const bad = structuredClone(contract.seed.example);
  bad.datasetRevisions[0].records.push({ recordId: 'not-a-uuid', scope: 'profile', data: {} });
  await writeFile(file, JSON.stringify(bad));
  await assert.rejects(boundary.command('npm', command), error => error.code === 'EVALUATOR_PUBLIC_CONTRACT_MISMATCH' && error.details.violations.length > 0);
  assert.throws(() => execFileSync(process.execPath, [join(publicRoot, 'seed.mjs'), '--file', file], { stdio: 'pipe' }), error => String(error.stderr).includes('INVALID_SEED') && error.stdout.length === 0);
  await writeFile(file, `${JSON.stringify(contract.seed.example)} trailing`);
  await assert.rejects(boundary.command('npm', command), error => error.code === 'EVALUATOR_PUBLIC_CONTRACT_MISMATCH');
  await boundary.command('npm', command, { contractExpectation: 'invalid' });
  assert.equal(await readFile(file, 'utf8'), `${JSON.stringify(contract.seed.example)} trailing`);
  if (process.env.FRONTAL_LARGE_SEED_PATH) {
    const largeFile = process.env.FRONTAL_LARGE_SEED_PATH;
    await boundary.command('npm', ['run', 'db:seed', '--', '--file', largeFile]);
    assert.deepEqual(JSON.parse(execFileSync(process.execPath, ['--max-old-space-size=6144', join(publicRoot, 'seed.mjs'), '--file', largeFile], { encoding: 'utf8' })), ['db:seed', '--file', largeFile]);
  }
});

test('full-size seed passes unchanged complete schema validation', { skip: !process.env.FRONTAL_LARGE_SEED_PATH }, async () => {
  const seed = await readSeedJsonFile(process.env.FRONTAL_LARGE_SEED_PATH);
  const valid = validator(contract)(contract.seed.schema);
  assert.equal(valid(seed), true, JSON.stringify(valid.errors));
  assert.equal(seed.subjects.length, 100);
  assert.equal(seed.datasetRevisions.length, 100);
  assert.equal(seed.datasetRevisions.reduce((count, revision) => count + revision.records.length, 0), 5000000);
  assert.equal(seed.exports.length, 11000);
});
