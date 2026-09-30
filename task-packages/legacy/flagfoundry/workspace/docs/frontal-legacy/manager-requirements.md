【Product Manager · Maya】

V1 已完成并通过基础验收。本期正式增加“progressive cohort activation with automatic rollback”。以下业务规则、wire schema、接口和错误全部是公开增量合同。

业务规则：

1. Activation may include 1-10 ordered Cohort Steps, each with candidateExposureBasisPoints, minimumEvaluationCount, maximumFailureBasisPoints, and observationSeconds.
2. For every Step, the rollout bucket is SHA-256(UTF-8(flagKey) + NUL + UTF-8(environment) + NUL + UTF-8(subjectKey)), interpreted from its first eight bytes as an unsigned big-endian integer modulo 10000. The candidate is selected exactly when bucket < candidateExposureBasisPoints; otherwise the captured prior Snapshot is selected. The bucket is independent of snapshotDigest and remains stable across Steps, and every response names rolloutId and stepIndex.
3. Clients submit idempotent Evaluation Outcome batches keyed by outcomeId with SUCCESS or FAILURE for the exact evaluation Snapshot and Step.
4. For a Step, evaluationCount equals successCount plus failureCount; when evaluationCount is positive, failureBasisPoints is floor(failureCount * 10000 / evaluationCount). A Step with minimumEvaluationCount 0 passes immediately; otherwise it remains OBSERVING before its deadline while evaluationCount is below the minimum, then passes when failureBasisPoints <= maximumFailureBasisPoints or fails and atomically rolls all traffic back when failureBasisPoints is greater.
5. The first Step starts at the activation transaction time and each later Step starts in the transaction that passes its predecessor. observationDeadlineAt equals startedAt plus observationSeconds. At database time >= observationDeadlineAt, deadline resolution precedes new Outcome acceptance: a still-OBSERVING Step passes only when evaluationCount >= minimumEvaluationCount and failureBasisPoints <= maximumFailureBasisPoints, otherwise it fails and rolls back.
6. Concurrent immediate activation makes the rollout STALE and no later Outcome may advance it.
7. Legacy activation is one Step at 10000 basis points with zero observation requirement and keeps the old response shape; progressive activations expose rollout and steps[].
8. Existing active revisions and Snapshot digests remain byte-identical and acquire no synthetic activation.
9. Pending Compilation Tasks retain their captured active revision and complete or fail stale normally.
10. Old evaluation and activation replay responses remain exactly valid; only newly progressive activations include rollout fields.
11. The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
12. The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
13. Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
14. Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

新增 wire schema：

- ProgressiveRollout = {rolloutId:uuid,flagId:uuid,environment:string,priorRevisionId:uuid,candidateRevisionId:uuid,state:RUNNING|COMPLETED|ROLLED_BACK|STALE,currentStepIndex:int,steps:[{stepIndex:int,candidateExposureBasisPoints:int,minimumEvaluationCount:int,maximumFailureBasisPoints:int,observationSeconds:int,successCount:int,failureCount:int,state:PENDING|OBSERVING|PASSED|FAILED,startedAt:timestamp|null,observationDeadlineAt:timestamp|null,completedAt:timestamp|null}],createdAt:timestamp,terminalAt:timestamp|null}
- EvaluationOutcome = {outcomeId:string,rolloutId:uuid,stepIndex:int,subjectKey:string,snapshotDigest:sha256,outcome:SUCCESS|FAILURE,reportedAt:timestamp}

新增或变更接口：

- POST /api/v1/flag-revisions/:revisionId/progressive-activate with {expectedActiveRevision,steps:[{candidateExposureBasisPoints,minimumEvaluationCount,maximumFailureBasisPoints,observationSeconds}]} returns 202 ProgressiveRollout; observationSeconds is an integer from 1 through 86400
- POST /api/v1/progressive-rollouts/:rolloutId/outcome-batches with {outcomes:[{outcomeId,stepIndex,subjectKey,snapshotDigest,outcome}]} atomically returns accepted and duplicate IDs
- GET /api/v1/progressive-rollouts/:rolloutId returns exact rollout counters; Evaluation adds rolloutId:uuid|null and stepIndex:int|null

新增稳定错误：

- 409 ROLLOUT_STALE: active revision changed or an Outcome targets another current Step
- 409 OUTCOME_WINDOW_CLOSED: the current Step reached observationDeadlineAt before this Outcome batch could commit
- 409 OUTCOME_ID_CONFLICT: an existing outcomeId has different semantics
- 400 INVALID_ROLLOUT_STEPS: exposure is not strictly increasing to 10000, thresholds are outside 0..10000, or observationSeconds is outside 1..86400

FINAL snapshot 与性能兼容合同：

The FINAL verification snapshot 'resources' object has exactly the union of these V1 and Manager resource specifications, with no other keys:

- 'projects' uses exact shape 'Project = {projectId:uuid,name:string}' and sorts ascending by scalar field-path tuple 'projectId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'environments' uses exact shape 'Environment = {projectId:uuid,name:string,contextAttributes:[string],schemaRevision:int}' and sorts ascending by scalar field-path tuple 'projectId', 'name', then by RFC 8785 canonical JSON as the tie-breaker.
- 'flags' uses exact shape 'Flag' and sorts ascending by scalar field-path tuple 'flagId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'flagRevisions' uses exact shape 'FlagRevision' and sorts ascending by scalar field-path tuple 'flagId', 'environment', 'revision', then by RFC 8785 canonical JSON as the tie-breaker.
- 'flagSnapshots' uses exact shape 'FlagSnapshot' and sorts ascending by scalar field-path tuple 'projectId', 'flagId', 'environment', 'revision', then by RFC 8785 canonical JSON as the tie-breaker.
- 'progressiveRollouts' uses exact shape 'ProgressiveRollout' and sorts ascending by scalar field-path tuple 'rolloutId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'evaluationOutcomes' uses exact shape 'EvaluationOutcome' and sorts ascending by scalar field-path tuple 'rolloutId', 'stepIndex', 'outcomeId', then by RFC 8785 canonical JSON as the tie-breaker.

The Manager-added resource specifications are exactly:

- 'progressiveRollouts' uses exact shape 'ProgressiveRollout' and sorts ascending by scalar field-path tuple 'rolloutId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'evaluationOutcomes' uses exact shape 'EvaluationOutcome' and sorts ascending by scalar field-path tuple 'rolloutId', 'stepIndex', 'outcomeId', then by RFC 8785 canonical JSON as the tie-breaker.

The FINAL Work kind enum is exactly the union 'FLAG_COMPILATION', 'ROLLOUT_DEADLINE'. The Manager-added
Work kinds are exactly 'ROLLOUT_DEADLINE'. All V1 snapshot point-in-time,
recursive '*Token' omission, sorting, Work state/lease/retention/drain, and Domain Event rules remain
mandatory. The FINAL binary reruns exactly these three V1-compatible scenarios:

- 'flag-evaluation': evaluate 2,000 decisions/s with p95 <= 40 ms; threshold: At least 2,000 successful decisions/s for 60 seconds and p95 <= 40 ms; mixed-snapshot and unexpected 5xx counts are zero.
- 'revision-compilation': compile 100 revisions/s with p95 queue latency <= 2 s; threshold: At least 100 READY revisions/s for 60 seconds and creation-commit to READY-commit queue-latency p95 <= 2,000 ms.
- 'disjoint-activation': activate 500 disjoint revisions during 60 s with no mixed snapshot reads; threshold: Exactly 500 disjoint activations finish within 60 seconds; conflicts, mixed snapshots, gaps, and unexpected 5xx are zero.

Their published setup, selector, request, concurrency, warm-up, measurement, timer, success condition,
and threshold remain unchanged. This Manager change adds correctness, concurrency, and recovery
assertions only; it does not replace or relax a performance scenario.

本轮先不要实现。请先说明它会影响哪些领域关系、模块、schema、migration、接口、状态、成功与失败数据流、兼容性、Worker、事件、前端、并发、恢复和性能测试，然后给出分阶段修改计划。