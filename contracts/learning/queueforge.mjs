import { ref, obj, arr, one, nil, str, text, count, positive, range, uuid, time, sha, en, without, page, op, paging, manager, T, id, key, digest, environmentVariables, commands, commonSchemas, snapshot, seedSchema, infra, observe, basicSmoke, seedSmoke, commonNotes } from './helpers-a2.mjs';

const runState = en('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');
const operation = en('ECHO', 'SHA256', 'SUM_INTEGERS');
const schemas = {
  ...commonSchemas(['RUN_EXECUTION'], ['run.queued', 'run.started', 'run.retry-scheduled', 'run.succeeded', 'run.failed', 'run.cancelled']),
  Queue: obj({ queueId: uuid, name: text, capacity: range(1, 100) }),
  JobDefinition: obj({ jobDefinitionId: uuid, version: positive, operation, maxAttempts: range(1, 10), timeoutSeconds: range(1, 300), createdAt: time }),
  LegacyRun: obj({ runId: uuid, jobDefinitionId: uuid, jobVersion: positive, queueId: uuid, priority: range(-100, 100), notBefore: time, input: ref('JsonValue'), state: runState, attemptCount: count, output: ref('JsonValue'), errorCode: nil(text), createdAt: time, startedAt: nil(time), terminalAt: nil(time), sequence: count }),
  ExecutionLease: obj({ runId: uuid, attempt: positive, workerId: text, leaseToken: text, leasedAt: time, expiresAt: time }),
  Attempt: obj({ runId: uuid, attempt: positive, workerId: text, startedAt: time, finishedAt: nil(time), outcome: nil(en('SUCCEEDED', 'RETRYABLE_FAILURE', 'PERMANENT_FAILURE', 'TIMED_OUT', 'CANCELLED')), outputDigest: nil(sha) }),
  WorkflowNode: obj({ nodeKey: text, runId: uuid, dependsOn: arr(text, { uniqueItems: true }), state: en('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED') }),
  WorkflowRun: obj({ workflowRunId: uuid, state: runState, nodes: arr(ref('WorkflowNode'), { minItems: 1, maxItems: 50 }), createdAt: time, terminalAt: nil(time), sequence: count }),
};
schemas.GraphRun = obj({ ...schemas.LegacyRun.properties, state: en('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED'), workflowRunId: uuid, nodeKey: text });
schemas.Run = one(ref('LegacyRun'), ref('GraphRun'));
schemas.SnapshotRun = obj({ ...schemas.GraphRun.properties, workflowRunId: nil(uuid), nodeKey: nil(text) });
schemas.SnapshotExecutionLease = without(schemas.ExecutionLease, ['leaseToken']);
schemas.AttemptResult = obj({ run: ref('Run'), attempt: ref('Attempt') });
schemas.WorkerClaimResponse = obj({ items: arr(obj({ run: ref('Run'), executionLease: ref('ExecutionLease') }), { maxItems: 20 }) });
schemas.Seed = seedSchema({ queues: 'Queue', jobDefinitions: 'JobDefinition', runs: 'LegacyRun', attempts: 'Attempt', executionLeases: 'ExecutionLease' });
schemas.VerificationSnapshot = snapshot({ queues: 'Queue', jobDefinitions: 'JobDefinition', runs: 'SnapshotRun', executionLeases: 'SnapshotExecutionLease', attempts: 'Attempt', workflowRuns: 'WorkflowRun' });
const queueId = id(41), jobDefinitionId = id(42), runId = id(43), workflowRunId = id(44);
const input = { value: 'Public persisted run' };
const run = { runId, jobDefinitionId, jobVersion: 1, queueId, priority: 0, notBefore: T, input, state: 'SUCCEEDED', attemptCount: 1, output: input, errorCode: null, createdAt: T, startedAt: T, terminalAt: T, sequence: 3 };
const jobInput = { operation: 'ECHO', maxAttempts: 3, timeoutSeconds: 30 };
const jobSchema = obj({ operation, maxAttempts: range(1, 10), timeoutSeconds: range(1, 300) });
const createRun = { jobDefinitionId, jobVersion: 1, queueId, priority: 0, notBefore: T, input: { value: 'Independent run' } };
const nodeInput = obj({ nodeKey: text, jobDefinitionId: uuid, jobVersion: positive, queueId: uuid, priority: range(-100, 100), input: ref('JsonValue'), dependsOn: arr(text, { uniqueItems: true }) });
export default {
  taskId: 'queueforge', title: 'QueueForge', environmentVariables, commands,
  seed: { schema: schemas.Seed, example: { schemaVersion: 1, seedVersion: 'v2-public-queueforge-1', queues: [{ queueId, name: 'Public Queue', capacity: 2 }], jobDefinitions: [{ jobDefinitionId, version: 1, ...jobInput, createdAt: T }], runs: [run], attempts: [{ runId, attempt: 1, workerId: 'public-seed-worker', startedAt: T, finishedAt: T, outcome: 'SUCCEEDED', outputDigest: digest(input) }], executionLeases: [] } }, schemas,
  operations: [
    ...infra(),
    op('list-runs', 'GET', '/api/v1/runs', 200, page(ref('Run')), undefined, { query: { limit: 20 } }, { parameters: paging }),
    op('read-run', 'GET', '/api/v1/runs/:runId', 200, ref('Run'), undefined, { params: { runId } }),
    op('create-run', 'POST', '/api/v1/runs', 202, ref('LegacyRun'), obj({ jobDefinitionId: uuid, jobVersion: positive, queueId: uuid, priority: range(-100, 100), notBefore: time, input: ref('JsonValue') }), { body: createRun }),
    op('create-job-definition', 'POST', '/api/v1/job-definitions', 201, ref('JobDefinition'), jobSchema, { body: jobInput }),
    op('version-job-definition', 'POST', '/api/v1/job-definitions/:jobDefinitionId/versions', 200, ref('JobDefinition'), obj({ expectedLatestVersion: positive, ...jobSchema.properties }), { params: { jobDefinitionId }, body: { expectedLatestVersion: 1, operation: 'SHA256', maxAttempts: 3, timeoutSeconds: 30 } }),
    op('cancel-run', 'POST', '/api/v1/runs/:runId/cancel', 200, ref('Run'), obj({ reason: text }), { params: { runId }, body: { reason: 'Cancel requested execution' } }),
    op('claim-runs', 'POST', '/api/v1/workers/:workerId/claim', 200, ref('WorkerClaimResponse'), obj({ queueIds: arr(uuid, { minItems: 1, uniqueItems: true }), maxRuns: range(1, 20) }), { params: { workerId: 'public-worker' }, body: { queueIds: [queueId], maxRuns: 1 } }),
    op('complete-attempt', 'POST', '/api/v1/runs/:runId/attempt-result', 200, ref('AttemptResult'), one(
      obj({ attempt: positive, leaseToken: text, outcome: { const: 'SUCCEEDED' }, output: ref('JsonValue'), errorCode: { type: 'null' } }),
      obj({ attempt: positive, leaseToken: text, outcome: en('RETRYABLE_FAILURE', 'PERMANENT_FAILURE'), output: { type: 'null' }, errorCode: text }),
    ), { params: { runId }, body: { attempt: 1, leaseToken: 'example-token-from-claim-response', outcome: 'SUCCEEDED', output: input, errorCode: null } }),
    op('read-queue', 'GET', '/api/v1/queues/:queueId', 200, obj({ ...schemas.Queue.properties, activeLeaseCount: count, queuedCount: count }), undefined, { params: { queueId } }),
    op('run-attempts', 'GET', '/api/v1/runs/:runId/attempts', 200, obj({ items: arr(ref('Attempt')) }), undefined, { params: { runId } }),
    op('create-workflow-run', 'POST', '/api/v1/workflow-runs', 200, ref('WorkflowRun'), obj({ nodes: arr(nodeInput, { minItems: 1, maxItems: 50 }) }), { body: { nodes: [{ nodeKey: 'first', jobDefinitionId, jobVersion: 1, queueId, priority: 0, input, dependsOn: [] }, { nodeKey: 'next', jobDefinitionId, jobVersion: 1, queueId, priority: 0, input, dependsOn: ['first'] }] } }, { source: manager }),
    op('read-workflow-run', 'GET', '/api/v1/workflow-runs/:workflowRunId', 200, ref('WorkflowRun'), undefined, { params: { workflowRunId } }, { source: manager }),
    op('cancel-workflow-run', 'POST', '/api/v1/workflow-runs/:workflowRunId/cancel', 200, ref('WorkflowRun'), obj({ reason: text }), { params: { workflowRunId }, body: { reason: 'Cancel workflow' } }, { source: manager }),
    op('retry-workflow-node', 'POST', '/api/v1/workflow-runs/:workflowRunId/nodes/:nodeKey/retry', 200, ref('GraphRun'), obj({}), { params: { workflowRunId, nodeKey: 'first' }, body: {} }, { source: manager }),
    ...observe(),
  ],
  smoke: [
    ...basicSmoke,
    seedSmoke({ queues: [{ queueId, capacity: 2 }], jobDefinitions: [{ jobDefinitionId, version: 1, operation: 'ECHO' }], runs: [{ runId, state: 'SUCCEEDED', output: input, workflowRunId: null, nodeKey: null }], attempts: [{ runId, attempt: 1, outputDigest: digest(input) }] }),
    { operationId: 'read-run', params: { runId }, expectStatus: 200, expectBody: run },
    { operationId: 'create-job-definition', body: jobInput, headers: key('create-job-definition'), expectStatus: 201, expectBody: { version: 1, ...jobInput }, capture: { createdDefinition: ['jobDefinitionId'] } },
    seedSmoke({ jobDefinitions: [{ jobDefinitionId: '${createdDefinition}', version: 1, ...jobInput }] }),
  ],
  notes: [...commonNotes,
    'Original policy maxRuns is 1..20, but short-run-execution later sends maxRuns:25. V2 fixes request validation at the explicit business bound 1..20; the old performance scenario requires a public correction before it can be an acceptance gate. No maxRuns:25 example or performance pass is claimed.',
    'V2 wire clarification: fresh standalone Run HTTP responses retain the exact V1 fields; graph node HTTP responses add non-null workflowRunId and nodeKey. FINAL snapshot Run rows always contain the two nullable Manager fields, null for migrated standalone Runs. Snapshot ExecutionLease omits leaseToken, while the authenticated claim operation returns its token as explicitly required.',
    'V2 wire clarification: workflow creation/cancellation return WorkflowRun at 200 under the original default rule. Node retry returns the updated graph node Run at 200; related descendants and workflow state are observed using GET workflow-run. Node notBefore is the creation transaction timestamp since the graph create request does not accept notBefore.',
    'The example seed is a real Queue -> immutable ECHO JobDefinition -> SUCCEEDED Run -> finished Attempt graph. Its outputDigest is SHA-256 of canonical output. No live/expired lease is inserted merely to make a smoke request possible.',
    'Output semantics still require the captured ECHO/SHA256/SUM_INTEGERS operation. Lease ownership, DAG validity, ancestor failure and queue capacity cannot be validated by transport schemas alone. The documented claim route is not ADMIN_TOKEN protected in the original contract.',
  ],
};
