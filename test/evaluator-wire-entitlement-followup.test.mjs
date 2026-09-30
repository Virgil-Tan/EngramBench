import assert from 'node:assert/strict';
import test from 'node:test';
import { CASES } from '../evaluators/learning/entitlementhub/v2/cases/index.mjs';
import { createFixtureFactory } from '../evaluators/learning/entitlementhub/v2/fixtures/index.mjs';

for (const limit of [0, 1, null]) {
  test(`EntitlementHub DATA-01 compares the frozen Grant with the feature's scalar limit (${limit})`, async () => {
    const factory = createFixtureFactory({ evaluationSeed: 'entitlement-followup', caseId: 'DATA-01', baseTime: '2026-01-01T00:00:00.000Z' });
    const fixture = factory.contract();
    fixture.revisions.basicV1.features.reports.limit = limit;
    const data = factory.data();
    const active = { ...data.active, state: 'TRIALING', subjectId: 'one-trial-subject' };
    const captured = new Error('frozen grant assertion reached');
    let creates = 0;
    const ctx = { workspace: `entitlement-grant-limit-${limit}`, fixtures: { ...factory, contract: () => fixture }, key: factory.key,
      npm: async () => ({}), migrate: async () => ({}), seed: async () => ({}), mark: () => {},
      startApi: async () => ({ baseUrl: 'http://localhost' }), startWorker: async () => ({}), waitFor: (callback) => callback(),
      mutate: async () => ++creates === 1 ? { status: 200, json: active } : {
        status: 409, json: { error: { code: 'TRIAL_ALREADY_CONSUMED', message: 'Trial already consumed', details: [] } },
      },
      request: async () => ({ status: 200, json: active }),
      snapshot: async () => ({ resources: { subscriptions: [active], planRevisions: fixture.seed.planRevisions,
        entitlementGrants: [{ ...data.seed.entitlementGrants[0], limit }],
      } }),
      equal(actual, expected, label) {
        assert.deepEqual(actual, expected, label);
        if (label === 'Grant freezes winning revision feature limit') throw captured;
      },
    };
    ctx.forWorkspace = () => ctx;
    await assert.rejects(CASES.find(({ id }) => id === 'DATA-01').run(ctx), (error) => error === captured);
  });
}
