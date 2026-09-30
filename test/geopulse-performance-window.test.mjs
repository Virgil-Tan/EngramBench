import assert from 'node:assert/strict';
import test from 'node:test';
import { E_CASES } from '../evaluators/learning/geopulse/v2/cases/e.mjs';
import { createFixtureFactory, performanceContract } from '../evaluators/learning/geopulse/v2/fixtures/index.mjs';
import { createCaseContext } from '../evaluators/learning/geopulse/v2/lib/runtime.mjs';
import { waitForDrain } from '../evaluators/learning/geopulse/v2/cases/helpers.mjs';

// Run the actual cases and load loop. Only the candidate/process boundary and
// monotonic clock are doubles; neither runWorkload nor ctx assertions are mocked.
function environment(t, caseId, options = {}) {
  let now = 0, pending = [], scheduled = false, count = 0, maxConcurrent = 0;
  const issuedAt = [], locations = [], assertions = [], revisions = [];
  const fixtures = createFixtureFactory({ evaluationSeed: t.name, caseId, baseTime: '2031-04-05T06:07:08.000Z' });
  t.mock.method(performance, 'now', () => now);
  const reply = (response) => {
    const ordinal = count++;
    issuedAt.push(now);
    return new Promise(resolve => {
      const latency = options.latency?.(ordinal) ?? (caseId === 'E-03' ? 160 : 100);
      pending.push({ at: now + latency, resolve, response: { ...response, status: ordinal === 0 ? options.status ?? 200 : 200 } });
      maxConcurrent = Math.max(maxConcurrent, pending.length);
      if (!scheduled) { scheduled = true; setImmediate(flush); }
    });
  };
  function flush() {
    scheduled = false;
    now = Math.min(...pending.map(item => item.at));
    const ready = pending.filter(item => item.at === now);
    pending = pending.filter(item => item.at !== now);
    ready.forEach(item => item.resolve(item.response));
    if (pending.length && !scheduled) { scheduled = true; setImmediate(flush); }
  }
  let seed, snapshotRead = false, snapshotReads = 0, passed = false;
  const workers = [];
  const bundle = { bundleId: fixtures.uuid('bundle'), tenantId: fixtures.uuid('tenant'), name: 'Window fixture', currentRevision: 0, currentBundleRevisionId: null, createdAt: fixtures.at() };
  const ctx = {
    ...fixtures, fixtures, workspace: `window-${t.name}`, forWorkspace: () => ctx,
    npm: async () => ({}), migrate: async () => {}, seed: async value => { seed = value; }, mark() {},
    startApi: async () => ({ baseUrl: 'http://candidate.invalid' }),
    startWorker: async () => { const worker = { child: { exitCode: null }, stopped: false, role: 'worker', logs: '' }; workers.push(worker); return worker; },
    receiver: async () => ({ url: 'http://receiver.invalid' }), startDispatcher: async () => ({}),
    equal(actual, expected, message) { assertions.push(message); assert.deepEqual(actual, expected, message); },
    ok(value, message) { assertions.push(message); assert.ok(value, message); },
    pass: value => { passed = true; return value; },
    waitFor: options.waitFor ?? (async predicate => { const result = await predicate(); assert.ok(result, 'test snapshot is drained'); return result; }),
    mutate(_url, path, _key, body) {
      if (path === '/api/v1/region-bundles') return Promise.resolve({ status: 200, json: { bundle } });
      if (path.endsWith('/publish')) {
        const revision = { bundleRevisionId: fixtures.uuid(`revision-${body.expectedRevision + 1}`), bundleId: bundle.bundleId, tenantId: bundle.tenantId, revision: body.expectedRevision + 1, regionVersionIds: body.regionVersionIds, effectiveFrom: body.effectiveFrom, createdAt: fixtures.at() };
        revisions.push(revision);
        return Promise.resolve({ status: 200, json: { bundle: { ...bundle, currentRevision: revision.revision, currentBundleRevisionId: revision.bundleRevisionId }, revision } });
      }
      assert.equal(path, '/api/v1/location-events');
      locations.push(body);
      return reply({ json: body });
    },
    request(_url, path, { json: body }) {
      assert.equal(path, '/api/v1/regions/query');
      assert.equal(body.points.length, 1_000);
      return reply({ json: { bundleRevisionId: revisions.at(-1).bundleRevisionId, items: body.points.map(({ queryId }) => ({ queryId, matches: [{ regionVersionId: seed.regionVersions[Number(queryId.slice(6)) % 10_000].regionVersionId }] })) } });
    },
    snapshot: async () => {
      snapshotRead = true;
      snapshotReads += 1;
      if (options.snapshotError) throw typeof options.snapshotError === 'function' ? options.snapshotError(snapshotReads) : options.snapshotError;
      let events = [...locations];
      if (options.corruption === 'missing') events.pop();
      if (options.corruption === 'duplicate-id') events[1] = { ...events[1], eventId: events[0].eventId };
      if (options.corruption === 'duplicate-sequence') events[1] = { ...events[1], deviceId: events[0].deviceId, deviceSequence: events[0].deviceSequence };
      const transition = { deviceId: fixtures.uuid('device'), regionId: fixtures.uuid('region'), sourceEventId: fixtures.uuid('event'), type: 'ENTER' };
      const transitions = options.corruption === 'exit' ? [{ ...transition, type: 'EXIT' }] : options.corruption === 'duplicate-transition' ? [transition, transition] : [];
      return { resources: { ...seed, locationEvents: events, memberships: [], transitions, regionBundleRevisions: revisions }, work: [{ terminal: snapshotReads > (options.nonterminalSnapshots ?? 0) }], events: [] };
    },
  };
  return {
    run: () => E_CASES.find(item => item.id === caseId).run(ctx),
    state: () => ({ count, now, maxConcurrent, pendingCount: pending.length, issuedAt, snapshotRead, snapshotReads, passed, workers, seed, assertions }),
  };
}

test('GeoPulse performance fixtures retain README populations and explicit thresholds', () => {
  assert.deepEqual(performanceContract(), {
    ordered: { events: 500_000, devices: 100_000, clients: 64, seconds: 60, throughput: 500, p95Ms: 250 },
    jitter: { events: 100_000, devices: 2_000, regions: 100, clients: 64, seconds: 60, throughput: 300, p95Ms: 350 },
    query: { regions: 10_000, points: 1_000_000, batchSize: 1_000, seconds: 60, throughput: 20_000, p95Ms: 700 },
  });
});

async function drainEnvironment(t, caseId, options = {}) {
  const runtime = await createCaseContext({ caseId, workspace: import.meta.dirname, evaluationSeed: t.name, manageDatabase: false });
  t.after(() => runtime.teardown());
  let elapsed = 0, polls = 0, waitOptions;
  t.mock.method(Date, 'now', () => elapsed);
  t.mock.method(globalThis, 'setTimeout', callback => {
    elapsed += 61_000;
    polls += 1;
    if (polls === options.workerExitsAfterPoll) env.state().workers[0].child.exitCode = 1;
    queueMicrotask(callback);
  });
  const env = environment(t, caseId, {
    nonterminalSnapshots: 1, ...options,
    waitFor: (predicate, received) => { waitOptions = received; return runtime.waitFor(predicate, received); },
  });
  return { ...env, drainState: () => ({ elapsed, polls, waitOptions }) };
}

for (const caseId of ['E-02', 'E-03', 'E-04']) {
  test(`${caseId} waits for post-load drainage beyond 60 seconds without adding an unstated SLO`, async t => {
    const env = await drainEnvironment(t, caseId);
    await env.run();
    assert.equal(env.drainState().waitOptions.timeoutMs, Infinity);
    assert.equal(env.drainState().elapsed, 61_000);
    assert.equal(env.state().snapshotReads, 2, 'the first nonterminal snapshot cannot pass');
    assert.equal(env.state().passed, true);
  });
}

test('unbounded GeoPulse drainage still detects Worker exit and real snapshot failures', async t => {
  await t.test('nonterminal Work cannot pass; a subsequently dead Worker fails', async subtest => {
    const env = await drainEnvironment(subtest, 'E-03', { nonterminalSnapshots: Infinity, workerExitsAfterPoll: 2 });
    await assert.rejects(env.run(), /worker exited before GeoPulse Work drainage/);
    assert.equal(env.state().snapshotReads, 2);
    assert.equal(env.state().passed, false);
  });
  await t.test('a later terminal snapshot still fails when accepted events are missing', async subtest => {
    const env = await drainEnvironment(subtest, 'E-03', { corruption: 'missing' });
    await assert.rejects(env.run(), /durable/);
    assert.equal(env.state().snapshotReads, 2);
    assert.equal(env.state().passed, false);
  });
  await t.test('a snapshot infrastructure error is immediately propagated', async subtest => {
    const error = Object.assign(new Error('snapshot infrastructure failure'), { origin: 'infrastructure' });
    const env = await drainEnvironment(subtest, 'E-03', { snapshotError: error });
    await assert.rejects(env.run(), actual => actual === error);
    assert.equal(env.drainState().polls, 0);
    assert.equal(env.state().passed, false);
  });
  await t.test('a failed snapshot is propagated rather than retried indefinitely', async subtest => {
    const error = new Error('snapshot returned 500');
    const stop = Object.assign(new Error('test checkpoint: first snapshot error was swallowed'), { origin: 'infrastructure' });
    const env = await drainEnvironment(subtest, 'E-03', { snapshotError: attempt => attempt === 1 ? error : stop });
    await assert.rejects(env.run(), actual => actual === error);
    assert.equal(env.state().snapshotReads, 1);
    assert.equal(env.state().passed, false);
  });
  await t.test('waitForDrain preserves an error thrown by the outer Worker monitor', async () => {
    const error = new Error('worker exited');
    await assert.rejects(waitForDrain({ waitFor: async () => { throw error; } }, 'http://candidate.invalid', { timeoutMs: Infinity }), actual => actual === error);
  });
});

for (const [caseId, profile, regionCount] of [['E-02', 'ordered', 1], ['E-03', 'jitter', 100]]) {
  test(`${caseId} accepts a legal 60-second window without inventing a full-corpus throughput quota`, async t => {
    const env = environment(t, caseId);
    const result = await env.run(), state = env.state(), contract = performanceContract()[profile];
    assert(state.count < contract.events, 'regression requires a partial nominal corpus');
    assert(state.count / (state.now / 1_000) >= contract.throughput);
    assert(state.now > 60_000 && state.now <= 60_200, 'in-flight requests are drained beyond the window');
    assert.equal(state.pendingCount, 0);
    assert(state.issuedAt.every(at => at <= 60_000), 'no request is appended after the window');
    assert.equal(state.maxConcurrent, 64);
    assert.equal(state.seed.devices.length, contract.devices);
    assert.equal(state.seed.regionVersions.length, regionCount);
    assert.equal(state.snapshotRead, true, 'every issued request still reaches the post-load oracle');
    assert.equal(result.evidence[0][caseId === 'E-02' ? 'events' : 'observations'], state.count);
    assert.equal(result.evidence[0][caseId === 'E-02' ? 'corpusEvents' : 'corpusObservations'], contract.events);
    assert.equal(result.evidence[0].windowSeconds, 60);
    assert.equal(result.evidence[0].durationSeconds, state.now / 1_000);
    assert.equal(result.evidence[0].throughput, state.count / (state.now / 1_000));
  });

  test(`${caseId} keeps status, performance and issued-event correctness failures`, async t => {
    const variants = [
      [{ status: 400 }, /without 4xx or 5xx/],
      [{ status: 500 }, /without 4xx or 5xx/],
      [{ latency: () => 1_000 }, /throughput/],
      [{ latency: n => n % 10 === 0 ? 500 : 50 }, /p95/],
      [{ corruption: 'missing' }, /durable/],
      [{ corruption: 'duplicate-id' }, /eventId uniqueness/],
      [{ corruption: 'duplicate-sequence' }, /device sequence uniqueness/],
      ...(caseId === 'E-03' ? [[{ corruption: 'exit' }, /spurious EXIT/], [{ corruption: 'duplicate-transition' }, /transitions remain unique/]] : []),
    ];
    for (const [options, error] of variants) await t.test(JSON.stringify(options) + error.source, async subtest => {
      const env = environment(subtest, caseId, options);
      await assert.rejects(env.run(), error);
    });
  });
}

test('E-04 retains one million points and rejects partial-window load using the README throughput gate', async t => {
  await t.test('complete original query corpus and full region seed', async subtest => {
    const env = environment(subtest, 'E-04');
    const result = await env.run();
    const state = env.state();
    assert.equal(state.count * 1_000, 1_000_000);
    assert.equal(state.seed.regionVersions.length, 10_000);
    assert.equal(state.maxConcurrent, 64);
    assert.equal(state.snapshotRead, true);
    assert.equal(result.evidence[0].points, state.count * 1_000);
    assert.equal(result.evidence[0].corpusPoints, 1_000_000);
    assert.equal(result.evidence[0].windowSeconds, 60);
    assert.equal(result.evidence[0].durationSeconds, state.now / 1_000);
    assert.equal(result.evidence[0].pointThroughput, state.count / (state.now / 1_000) * 1_000);
  });
  await t.test('a partial corpus over 60 seconds necessarily misses 20,000 points/s', async subtest => {
    const env = environment(subtest, 'E-04', { latency: () => 10_000 });
    await assert.rejects(env.run(), /point throughput .* >= 20000/);
    const state = env.state();
    assert(state.count < 1_000);
    assert(state.issuedAt.every(at => at <= 60_000));
    assert.equal(state.snapshotRead, false);
  });
});
