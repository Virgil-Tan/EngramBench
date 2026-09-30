# FlagFoundry 多轮用户与 Manager Prompt 协议

## 可见性

本文件只属于 Benchmark Harness，不得复制进 workspace、传给 Codex、Session Evolution 或
盲审 Judge。DS 只根据 workspace 的公开合同、可见对话和当前 scene 推进。

## DS system role

你是一名使用 Codex 完成 FlagFoundry 的交付负责人。每轮只提出一个主要目标，用自然简短的中文推进真实开发。可以询问模块职责、接口、状态、数据流、设计取舍和实际验证证据，但绝不能提供代码、伪代码、SQL、命令、补丁、文件或函数定位、表结构、锁、事务、索引、缓存、队列、算法、性能方案、日志分析、Debug 根因或修复提示。Codex 报告失败时只要求其自行定位、修复并重新验证。只使用 README、AGENTS 和已经出现在可见对话中的 Manager 变更，不透露未来阶段或私有评测。

DS 每轮只能返回一个主要用户目标。不能写代码、SQL、命令、补丁、伪代码、文件/函数定位、
表结构、锁、事务、索引、缓存、队列、算法、性能方案或 Debug 提示。它不能透露 Checklist、
权重、hidden scenario、未来 Manager 需求、Control/Treatment 标签或 Frontal 状态。

## 状态协议

- scenes 严格按 T01 到 T22；DS 根据可见证据自行决定重复当前 scene 或前进一格；
- advanceGate 只提供判断依据，Harness 不执行中途硬 Gate；失败时只要求 Codex 自行定位、修复并重新验证；
- T16 第一次访问时由 Harness 原样注入 fixedMessage，后续访问由 DS 自然跟进；
- T16 之前不能出现 Manager-only requirement 或其可识别业务规则；
- 整个 Session 唯一的自动截止条件是 'hardMaxTurns = 60'；达到上限后直接结束，不强制推进 scene；
- 'safeMessage' 只用于 provider 失败后的已审核 fallback，不能据此强制推进。

## Scene map

| Scene | Title | Advance guidance |
| --- | --- | --- |
| T01 | Initial plan | A coherent plan covers deliverables, dependencies, risks, and verification without repository edits. |
| T02 | Module and process ownership | The response defines module dependencies, process boundaries, authority, and responsibilities that stay separate. |
| T03 | Success and failure flows | Both flows identify atomic effects, forbidden records, replay behavior, and visible outcomes. |
| T04 | Public contract first | Canonical public contracts cover every published input, output, state, error, command, and asynchronous result. |
| T05 | Test strategy | The strategy distinguishes unit, real integration, browser, multi-process, recovery, aggregate, and performance evidence. |
| T06 | Runnable skeleton | All public processes start with documented commands, expose health, and stop cleanly. |
| T07 | Migration and seed | Migrations replay safely; valid, replayed, conflicting, and invalid seeds have exact atomic outcomes. |
| T08 | Read model and UI data | Queries, cursors, ordering, states, and UI data come from real PostgreSQL through HTTP. |
| T09 | Atomic V1 mutation | Success, atomic rejection, replay, conflict, and concurrent requests preserve every V1 invariant. |
| T10 | Worker lifecycle and terminal races | Leases recover; stale ownership cannot commit; each effect and terminal state occurs at most once. |
| T11 | Transactional outbox and backend review | Events commit with state, retries preserve identity/body/order, dispatcher recovery passes, and concrete review findings are fixed. |
| T12 | Complete real frontend | The UI completes all V1 flows through visible controls and real API data with correct asynchronous and error states. |
| T13 | Real integration suite | Integration tests cover contract, seed, V1 state, idempotency, worker, outbox, and cleanup and pass repeatably. |
| T14 | Production browser E2E | Project-owned browser tests cover public V1 flows and asynchronous states and pass under one command. |
| T15 | Multi-process recovery and V1 review | Controlled races and crashes preserve all V1 invariants with no unresolved finding. |
| T16 | Harness-owned Manager change | Codex explains domain, schema, migration, API, worker, event, UI, compatibility, concurrency, recovery, and performance impact and gives a staged plan without implementing. |
| T17 | Compatible migration and backend | Populated V1 data and replay remain valid; changed domain/state/worker behavior passes focused tests. |
| T18 | Changed API and integration | New and old contracts agree; migration and replay evidence hold; real HTTP integration passes. |
| T19 | Changed frontend | The UI exposes changed and compatible flows, aggregate/member states, history, errors, accessibility, and responsive behavior. |
| T20 | Changed browser, concurrency, and recovery | Changed browser and crash races are automated and pass without compatibility or invariant failures. |
| T21 | Sustained performance and full regression | Evidence reports environment, scale, duration, throughput, errors, latency, drain, invariants, targets, and passing full regression. |
| T22 | Final review and handoff | No material finding remains; all required gates pass; documentation and handoff accurately state architecture, operation, compatibility, evidence, risks, and unrun checks. |

## Fixed Manager message

<!-- FIXED_MANAGER_MESSAGE_START -->
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
<!-- FIXED_MANAGER_MESSAGE_END -->

两份正文的唯一来源是 task generator；'dialogue-script.json' 的 'fixedMessage' 必须逐字相同。
T16 只做影响分析和计划，不能把“已开始实现”视为通过。

## Decision output

DS 决策输出必须是一个 JSON object：

~~~json
{"decision":"continue|accept|abort","sceneId":"T01","message":"one user message","state":{"turn":1,"lastScene":"T01","visits":{"T01":1}}}
~~~

只有 T22 advanceGate 已满足、'minimumTurns' 已达到且当前没有未解决失败时才能 'accept'。
达到 hard limit、公开合同不可完成或隔离被破坏时才能 'abort'。
