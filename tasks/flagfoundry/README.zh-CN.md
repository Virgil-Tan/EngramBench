# FlagFoundry 项目设计说明

## 1. 定位

FlagFoundry 是一个从近空白 Git fixture 开始的高难度全栈 Coding Benchmark，主流程是
versioned feature-flag rollout publication。这是 transfer task；正式 paired curriculum 为 `schemaharbor` learning -> `flagfoundry` transfer。

本题只用一个主流程承载难度，重点测量：immutable configuration、atomic activation、deterministic evaluation、stale publish prevention、compatible bundles。领域词汇以
[CONTEXT.md](./CONTEXT.md) 为准。

## 2. 可见性

Codex 初始只能看到 'workspace/README.md'、'workspace/AGENTS.md' 和独立 fixture Git 历史。
Manager 变更、Checklist、对话状态机、评测方案和实验 metadata 都在 workspace 外，不能在
开发回合、Session Evolution 或盲审前复制或透露。

## 3. 完整 V1

- Create typed Flags and Draft revisions with ordered targeting rules and integer basis-point allocations.
- Compile Drafts asynchronously into deterministic Snapshots and reject invalid or stale revisions.
- Activate one revision with expected-active compare-and-set semantics across API instances.
- Evaluate a captured Snapshot deterministically and expose an explanation trace without process-local authority.
- Deliver activation events at least once and show revisions, diffs, evaluations, and audit history in the UI.

核心状态：Flag Revision: COMPILING -> READY -> ACTIVE -> SUPERSEDED, or COMPILING -> REJECTED; activating READY supersedes the prior ACTIVE revision for that Flag and Environment.

### 可计算不变量

1. Exactly one Flag Revision is active for a Flag and Environment at an instant.
2. The same Snapshot digest and Evaluation Context always produce the same variant and reason.
3. Variant allocation basis points sum to exactly 10,000 for every percentage rule.
4. Activation succeeds only for the exact active revision and rule schema captured by Compilation Task.
5. An inactive, rejected, or stale revision cannot become observable through evaluation.

## 4. Manager 固定变更

V1、真实 Browser E2E、双 API/双 Worker 并发与恢复完成后，T16 才发布
“progressive cohort activation with automatic rollback”。它改变核心基数、状态或一致性边界：

- Activation may include 1-10 ordered Cohort Steps, each with candidateExposureBasisPoints, minimumEvaluationCount, maximumFailureBasisPoints, and observationSeconds.
- For every Step, the rollout bucket is SHA-256(UTF-8(flagKey) + NUL + UTF-8(environment) + NUL + UTF-8(subjectKey)), interpreted from its first eight bytes as an unsigned big-endian integer modulo 10000. The candidate is selected exactly when bucket < candidateExposureBasisPoints; otherwise the captured prior Snapshot is selected. The bucket is independent of snapshotDigest and remains stable across Steps, and every response names rolloutId and stepIndex.
- Clients submit idempotent Evaluation Outcome batches keyed by outcomeId with SUCCESS or FAILURE for the exact evaluation Snapshot and Step.
- For a Step, evaluationCount equals successCount plus failureCount; when evaluationCount is positive, failureBasisPoints is floor(failureCount * 10000 / evaluationCount). A Step with minimumEvaluationCount 0 passes immediately; otherwise it remains OBSERVING before its deadline while evaluationCount is below the minimum, then passes when failureBasisPoints <= maximumFailureBasisPoints or fails and atomically rolls all traffic back when failureBasisPoints is greater.
- The first Step starts at the activation transaction time and each later Step starts in the transaction that passes its predecessor. observationDeadlineAt equals startedAt plus observationSeconds. At database time >= observationDeadlineAt, deadline resolution precedes new Outcome acceptance: a still-OBSERVING Step passes only when evaluationCount >= minimumEvaluationCount and failureBasisPoints <= maximumFailureBasisPoints, otherwise it fails and rolls back.
- Concurrent immediate activation makes the rollout STALE and no later Outcome may advance it.
- Legacy activation is one Step at 10000 basis points with zero observation requirement and keeps the old response shape; progressive activations expose rollout and steps[].

新增 wire schema：

- ProgressiveRollout = {rolloutId:uuid,flagId:uuid,environment:string,priorRevisionId:uuid,candidateRevisionId:uuid,state:RUNNING|COMPLETED|ROLLED_BACK|STALE,currentStepIndex:int,steps:[{stepIndex:int,candidateExposureBasisPoints:int,minimumEvaluationCount:int,maximumFailureBasisPoints:int,observationSeconds:int,successCount:int,failureCount:int,state:PENDING|OBSERVING|PASSED|FAILED,startedAt:timestamp|null,observationDeadlineAt:timestamp|null,completedAt:timestamp|null}],createdAt:timestamp,terminalAt:timestamp|null}
- EvaluationOutcome = {outcomeId:string,rolloutId:uuid,stepIndex:int,subjectKey:string,snapshotDigest:sha256,outcome:SUCCESS|FAILURE,reportedAt:timestamp}

新增或变更的公开接口：

- POST /api/v1/flag-revisions/:revisionId/progressive-activate with {expectedActiveRevision,steps:[{candidateExposureBasisPoints,minimumEvaluationCount,maximumFailureBasisPoints,observationSeconds}]} returns 202 ProgressiveRollout; observationSeconds is an integer from 1 through 86400
- POST /api/v1/progressive-rollouts/:rolloutId/outcome-batches with {outcomes:[{outcomeId,stepIndex,subjectKey,snapshotDigest,outcome}]} atomically returns accepted and duplicate IDs
- GET /api/v1/progressive-rollouts/:rolloutId returns exact rollout counters; Evaluation adds rolloutId:uuid|null and stepIndex:int|null

新增稳定错误：

- 409 ROLLOUT_STALE: active revision changed or an Outcome targets another current Step
- 409 OUTCOME_WINDOW_CLOSED: the current Step reached observationDeadlineAt before this Outcome batch could commit
- 409 OUTCOME_ID_CONFLICT: an existing outcomeId has different semantics
- 400 INVALID_ROLLOUT_STEPS: exposure is not strictly increasing to 10000, thresholds are outside 0..10000, or observationSeconds is outside 1..86400

跨层规则：

- The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
- The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
- Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
- Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

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

迁移必须同时满足：

- Existing active revisions and Snapshot digests remain byte-identical and acquire no synthetic activation.
- Pending Compilation Tasks retain their captured active revision and complete or fail stale normally.
- Old evaluation and activation replay responses remain exactly valid; only newly progressive activations include rollout fields.

T16 只要求影响分析和分阶段修改计划，不允许立即实现。T17-T20 才依次处理迁移、后端、
API、UI、并发和恢复回归。

## 5. 评分结构

| Dimension | Weight |
| --- | ---: |
| Clean build, migration, seed, and operation | 5 |
| Contract, validation, and seed semantics | 5 |
| Complete V1 main flow | 10 |
| Atomicity and durable idempotency | 10 |
| Worker, outbox, and crash recovery | 15 |
| Multi-process consistency | 10 |
| Manager-compatible migration | 15 |
| Manager runtime, UI, and concurrency | 10 |
| Project-owned real tests | 8 |
| Sustained performance plus post-load correctness | 7 |
| Persona-fit explanation | 2 |
| Evidence and handoff | 3 |
| **Total** | **100** |

普通 CRUD 和页面数量不构成主要分值。并发、恢复、幂等、兼容迁移和负载后不变量失败会
触发对应高权重项失分；正式 hard cap 方案见 evaluator 文档。

## 6. 当前完成度

当前为 **D1 设计完成**：公开合同、固定 Manager 正文、22 阶段 Dialogue、100 分 Checklist、
环境设计、独立 fixture commit 和 H-01 至 H-13 黑盒方案已完成。当前**没有 hidden runner**、
'score-manifest.v1.json'、gold、mutant、逐题 project smoke 或 baseline，因此不能声称 D2/D3/D4/D5，
也不能把候选项目自己的 'test:all' 当作正式得分。

## 7. D2 以后仍需完成

- 验证共享 environment profile，并完成当前 task 的真实 project smoke；
- 实现 Harness-owned H-01 至 H-13 runner、中央 score manifest 和 Checklist 'testGates'；
- 冻结 V1/FINAL 双快照并接线 paired scripted curriculum；
- 用 gold、定向 mutants、重复 Control baseline 和 flake run 校准阈值。
