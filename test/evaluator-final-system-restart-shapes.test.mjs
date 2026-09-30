import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSplitParent } from '../evaluators/learning/evidencechain/v2/cases/helpers.mjs';
import { createFixtureFactory } from '../evaluators/learning/evidencechain/v2/fixtures/index.mjs';
import evidenceContract from '../contracts/learning/evidencechain.mjs';
import { validator } from '../templates/contract-first/runtime.mjs';
import { assertCommittedResourcesPreserved, reconcileSnapshot } from '../evaluators/learning/configrelay/v2/lib/oracle.mjs';
import { agentCatalog, createFixtureFactory as configFixtures, seededAssignment, seededLegacyDeployment } from '../evaluators/learning/configrelay/v2/lib/fixtures.mjs';

function splitDetail() {
  const f = createFixtureFactory({ caseId: 'LAYER-01', evaluationSeed: 'split-parent-shape', baseTime: '2026-09-08T00:00:00Z' });
  const parent = {
    collectedItemId: f.uuid('parent'), caseId: f.uuid('case'), expectedLabel: 'SEALED-ITEM',
    expectedSealCode: 'PARENT-SEAL', quantity: 10, state: 'CONSUMED_BY_SPLIT',
    currentCustodianId: null, intakeScanId: null, revision: 3, sequence: 2,
    aliquots: [4, 6].map((quantity, index) => ({
      aliquotId: f.uuid(`child-${index}`), parentItemId: f.uuid('parent'), quantity,
      sealCode: `CHILD-SEAL-${index}`, state: 'EXPECTED', currentCustodianId: null,
      intakeScanId: null, revision: 0,
    })),
  };
  return {
    parent,
    split: { splitId: f.uuid('split'), parentItemId: parent.collectedItemId, totalQuantity: 10,
      aliquots: structuredClone(parent.aliquots), state: 'ACTIVE', createdAt: f.at(), reversedAt: null },
    parentTimeline: [], aliquotTimelines: parent.aliquots.map(({ aliquotId }) => ({ aliquotId, items: [] })),
  };
}

test('EvidenceChain LAYER-01 accepts the published consumed-parent shape with Aliquots', () => {
  const detail = splitDetail();
  const valid = validator(evidenceContract)(evidenceContract.schemas.ItemSplitDetail);
  assert.ok(valid(detail), JSON.stringify(valid.errors));
  assert.doesNotThrow(() => assertSplitParent(detail.parent, detail.split));
});

for (const [fault, mutate] of [
  ['missing Aliquots', parent => { delete parent.aliquots; }],
  ['unsplit state mixed with Aliquots', parent => { parent.state = 'VERIFIED'; }],
  ['old singular custody mixed with Aliquots', parent => { parent.currentCustodianId = parent.caseId; }],
  ['old singular scan mixed with Aliquots', parent => { parent.intakeScanId = parent.caseId; }],
  ['children disagree with ItemSplit', parent => { parent.aliquots[0].quantity = 5; }],
]) {
  test(`EvidenceChain LAYER-01 rejects ${fault}`, () => {
    const detail = splitDetail();
    mutate(detail.parent);
    assert.throws(() => assertSplitParent(detail.parent, detail.split), { code: 'ERR_ASSERTION' });
  });
}

function committedSnapshot() {
  const f = configFixtures({ caseId: 'E-04', evaluationSeed: 'committed-graph', baseTime: '2026-09-08T00:00:00Z' });
  const catalog = agentCatalog(f, { count: 3 });
  const deployment = seededLegacyDeployment(f, catalog, 'current', { state: 'DELIVERING' });
  const assignments = catalog.agents.map((agent, index) => {
    const { assignmentToken: _token, ...assignment } = seededAssignment(f, deployment, agent, index, {
      digest: catalog.configuration.canonicalDigest, state: index === 0 ? 'ACKED' : 'WAITING',
      sentAt: index === 0 ? f.at({ seconds: 2 }) : null, ackedAt: index === 0 ? f.at({ seconds: 3 }) : null,
    });
    return assignment;
  });
  const acked = assignments[0];
  const resources = {
    agents: catalog.agents.map((agent, index) => ({ ...agent, lastCommandSequence: 1,
      appliedRevision: index === 0 ? 1 : 0, appliedDigest: index === 0 ? catalog.configuration.canonicalDigest : null,
      desiredRevision: 1, desiredDigest: catalog.configuration.canonicalDigest, drift: index !== 0,
    })).sort((a, b) => a.agentId.localeCompare(b.agentId)),
    configurations: catalog.configurations, deployments: [deployment],
    assignments: assignments.sort((a, b) => a.assignmentId.localeCompare(b.assignmentId)),
    acknowledgements: [{ agentId: acked.agentId, deploymentId: acked.deploymentId,
      commandSequence: 1, revision: 1, digest: acked.digest, outcome: 'APPLIED', reportedAt: f.at({ seconds: 3 }) }],
    deploymentCohorts: [], rolloutCommands: [], deploymentRollbacks: [],
  };
  const snapshot = { asOf: f.at({ seconds: 4 }), resources, work: [], events: [] };
  reconcileSnapshot(snapshot);
  return snapshot;
}

test('ConfigRelay E-04 accepts the complete committed resource graph across restart', () => {
  const before = committedSnapshot(), after = structuredClone(before);
  after.asOf = '2026-09-08T00:00:05.000Z';
  assert.doesNotThrow(() => assertCommittedResourcesPreserved(before, after));
});

test('ConfigRelay E-04 rejects losing an Assignment that saved acknowledgement replay cannot detect', () => {
  const before = committedSnapshot(), after = structuredClone(before);
  const unacknowledged = after.resources.assignments.find(assignment =>
    !after.resources.acknowledgements.some(ack => ack.agentId === assignment.agentId));
  assert.equal(unacknowledged.state, 'WAITING');
  after.resources.assignments = after.resources.assignments.filter(({ assignmentId }) => assignmentId !== unacknowledged.assignmentId);
  assert.deepEqual(after.resources.acknowledgements, before.resources.acknowledgements);
  assert.doesNotThrow(() => reconcileSnapshot(after), 'shape checks alone do not detect a missing Assignment');
  assert.throws(() => assertCommittedResourcesPreserved(before, after), {
    code: 'ERR_ASSERTION', message: /complete committed resource graph/u,
  });
});
