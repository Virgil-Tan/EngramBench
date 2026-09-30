# ConfigRelay 项目设计说明

## 1. 定位

ConfigRelay 是一个从近空白 Git fixture 开始的高难度全栈 Coding Benchmark，主流程是
durable desired-configuration rollout to agents。这是 learning task，用于形成可迁移的工程经验。

本题只用一个主流程承载难度，重点测量：version authority、ordered delivery、ack fencing、offline recovery、rollout correctness。领域词汇以
[CONTEXT.md](./CONTEXT.md) 为准。

## 2. 可见性

Codex 初始只能看到 'workspace/README.md'、'workspace/AGENTS.md' 和独立 fixture Git 历史。
Manager 变更、Checklist、对话状态机、评测方案和实验 metadata 都在 workspace 外，不能在
开发回合、Session Evolution 或盲审前复制或透露。

## 3. 完整 V1

- Publish immutable Configuration revisions and create Deployments for a deterministic Agent selector snapshot.
- Deliver Assignments at least once in increasing command sequence and nondecreasing V1 revision order per Agent.
- Accept acknowledgements only for the current assignment token and preserve duplicate replay.
- Recover delivery after dispatcher death and reconcile Agents that reconnect with stale applied revisions.
- Expose fleet drift, assignment progress, failures, per-Agent history, and audit events in the UI.

核心状态：Deployment: PENDING -> DELIVERING -> APPLIED | FAILED | CANCELLED; Agent assignment: WAITING -> SENT -> ACKED | SUPERSEDED.

### 可计算不变量

1. For each Agent, the first accepted acknowledgement for a commandSequence is exactly the prior accepted sequence plus one and matches the current assignmentToken; an identical replay has no second effect, and no stale token or sequence can change desired or applied state.
2. One Deployment captures an immutable selector result and Configuration digest.
3. A stale assignment token cannot change current desired or applied state.
4. Every successful acknowledgement matches the exact delivered revision digest.
5. Repeated delivery preserves deliveryId, semantic body, and per-Agent command order.

## 4. Manager 固定变更

V1、真实 Browser E2E、双 API/双 Worker 并发与恢复完成后，T16 才发布
“staged cohort rollout with automatic rollback”。它改变核心基数、状态或一致性边界：

- A Deployment contains ordered Cohorts selected from one immutable target snapshot and starts only the first Cohort.
- Each Cohort declares minimum success basis points, maximum failure basis points, and an observation deadline. Both thresholds are integers 0..10000 and the denominator is immutable targetCount. Before the deadline, success and failure count APPLIED and REJECTED acknowledgements; at the deadline, success still counts APPLIED and failure is targetCount minus successCount, so every missing acknowledgement is a failure.
- Evaluate once when every target has acknowledged or when observationDeadlineAt is reached: the Cohort succeeds exactly when floor(successCount*10000/targetCount) >= minimumSuccessBasisPoints and floor(failureCount*10000/targetCount) <= maximumFailureBasisPoints; otherwise it fails. targetCount zero is invalid, and simultaneous acknowledgements or deadline workers produce one durable transition.
- A failed Cohort supersedes every still-pending APPLY command and starts one automatic Rollback for exactly the captured Agents in this and earlier Cohorts whose APPLY acknowledgement changed them to the Deployment revision.
- Rollback delivery uses new stable identities and a strictly increasing commandSequence; it may apply each affected Agent's captured lower prior revision and completes only after every captured rollback command is terminal.
- Legacy all-at-once Deployments behave as one Cohort and keep existing response fields; staged Deployments expose cohorts[] and rollback.

新增 wire schema：

- DeploymentCohort = {cohortId:uuid,deploymentId:uuid,ordinal:int,name:string,selector:{labels:{key:string,value:string}},targetCount:int,targetDigest:sha256,minimumSuccessBasisPoints:int,maximumFailureBasisPoints:int,observationSeconds:int,successCount:int,failureCount:int,pendingCount:int,state:WAITING|DELIVERING|OBSERVING|SUCCEEDED|FAILED|ROLLED_BACK,startedAt:timestamp|null,observationDeadlineAt:timestamp|null,completedAt:timestamp|null}; counts are non-negative and sum to targetCount, and deadline evaluation moves every missing acknowledgement from pendingCount to failureCount
- RolloutCommand = {commandId:uuid,deploymentId:uuid,cohortId:uuid,agentId:uuid,commandSequence:int,kind:APPLY|ROLLBACK,fromRevision:int,toRevision:int,toDigest:sha256,deliveryId:uuid,assignmentToken:string,state:WAITING|SENT|ACKED|FAILED|SUPERSEDED,createdAt:timestamp,ackedAt:timestamp|null}
- DeploymentRollback = {rollbackId:uuid,deploymentId:uuid,failedCohortId:uuid,state:PENDING|DELIVERING|COMPLETED|FAILED,commandCount:int,completedCount:int,startedAt:timestamp,completedAt:timestamp|null}; commandCount is the immutable affected-Agent count
- For staged Deployments, AgentPollResponse.command additionally permits RolloutCommand; status and nullability rules are unchanged
- Under the Manager schema a staged Deployment adds cohorts:[DeploymentCohort] and rollback:DeploymentRollback|null; cohorts sort by ordinal and rollback is null until a failed Cohort atomically creates it. A legacy all-at-once Deployment retains its exact V1 Deployment shape and omits both Manager-only fields

新增或变更的公开接口：

- POST /api/v1/deployments accepts optional cohorts:[{name,selector,minimumSuccessBasisPoints,maximumFailureBasisPoints,observationSeconds}]. A staged plan contains 1..20 Cohorts; each threshold is an integer 0..10000, observationSeconds is an integer 1..86400, and every Cohort has at least one target. Against the captured outer target set, every Agent must match exactly one Cohort; membership, order, prior revision, and digests commit atomically.
- GET /api/v1/deployments/:deploymentId returns the extended Deployment with cohorts[] in ordinal order and rollback:null|DeploymentRollback only for a staged Deployment; a legacy all-at-once Deployment returns the exact V1 Deployment shape with no cohorts or rollback fields.
- POST /api/v1/agents/:agentId/poll accepts optional lastCommandSequence and returns at most the next RolloutCommand. APPLY and ROLLBACK share one strictly increasing per-Agent commandSequence and retries preserve commandId, deliveryId, body, and assignmentToken.
- POST /api/v1/agents/:agentId/acknowledgements includes commandSequence for staged Deployments; only the current token at the next sequence can change state, while an identical replay returns its original result.
- The transaction that fails a Cohort freezes the affected-Agent set from successful APPLY acknowledgements, supersedes all other pending APPLY commands, creates exactly one ROLLBACK command per affected Agent, and never adds a later Agent to that Rollback.

新增稳定错误：

- 400 INVALID_COHORT_PLAN: cohort count, order, thresholds, observation duration, name, or selector is invalid
- 409 COHORT_TARGET_PARTITION_INVALID: a captured target Agent matches zero or multiple Cohorts
- 409 AGENT_COMMAND_SEQUENCE_CONFLICT: the command or acknowledgement is not the current next per-Agent sequence

跨层规则：

- The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
- The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
- Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
- Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

FINAL snapshot 与性能兼容合同：

The FINAL verification snapshot 'resources' object has exactly the union of these V1 and Manager resource specifications, with no other keys:

- 'agents' uses exact shape 'Agent' and sorts ascending by scalar field-path tuple 'agentId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'configurations' uses exact shape 'Configuration' and sorts ascending by scalar field-path tuple 'fleetId', 'revision', then by RFC 8785 canonical JSON as the tie-breaker.
- 'deployments' uses exact shape 'Deployment' and sorts ascending by scalar field-path tuple 'deploymentId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'assignments' uses exact shape 'Assignment' and sorts ascending by scalar field-path tuple 'assignmentId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'acknowledgements' uses exact shape 'Acknowledgement' and sorts ascending by scalar field-path tuple 'agentId', 'deploymentId', 'commandSequence', then by RFC 8785 canonical JSON as the tie-breaker.
- 'deploymentCohorts' uses exact shape 'DeploymentCohort' and sorts ascending by scalar field-path tuple 'deploymentId', 'ordinal', 'cohortId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'rolloutCommands' uses exact shape 'RolloutCommand' and sorts ascending by scalar field-path tuple 'deploymentId', 'agentId', 'commandSequence', then by RFC 8785 canonical JSON as the tie-breaker.
- 'deploymentRollbacks' uses exact shape 'DeploymentRollback' and sorts ascending by scalar field-path tuple 'deploymentId', then by RFC 8785 canonical JSON as the tie-breaker.

The Manager-added resource specifications are exactly:

- 'deploymentCohorts' uses exact shape 'DeploymentCohort' and sorts ascending by scalar field-path tuple 'deploymentId', 'ordinal', 'cohortId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'rolloutCommands' uses exact shape 'RolloutCommand' and sorts ascending by scalar field-path tuple 'deploymentId', 'agentId', 'commandSequence', then by RFC 8785 canonical JSON as the tie-breaker.
- 'deploymentRollbacks' uses exact shape 'DeploymentRollback' and sorts ascending by scalar field-path tuple 'deploymentId', then by RFC 8785 canonical JSON as the tie-breaker.

The FINAL Work kind enum is exactly the union 'ASSIGNMENT_DELIVERY', 'COHORT_DEADLINE', 'ROLLBACK_DELIVERY'. The Manager-added
Work kinds are exactly 'COHORT_DEADLINE', 'ROLLBACK_DELIVERY'. All V1 snapshot point-in-time,
recursive '*Token' omission, sorting, Work state/lease/retention/drain, and Domain Event rules remain
mandatory. The FINAL binary reruns exactly these three V1-compatible scenarios:

- 'agent-poll': serve 2,000 Agent polls/s with p95 <= 80 ms; threshold: At least 2,000 successful polls/s for 60 seconds and p95 <= 80 ms; token mix-up and unexpected 5xx = 0.
- 'acknowledgement-ingest': ingest 1,000 acknowledgements/s with p95 <= 180 ms; threshold: At least 1,000 successful responses/s for 60 seconds and p95 <= 180 ms with the exact 45% APPLIED, 5% REJECTED, 50% replay request mix.
- 'assignment-delivery-recovery': recover and deliver 50,000 pending Assignments within 120 s; threshold: All 50,000 Assignments reach SENT in <= 120 seconds after replacement spawn; stale commits and unexpected failures are zero.

Their published setup, selector, request, concurrency, warm-up, measurement, timer, success condition,
and threshold remain unchanged. This Manager change adds correctness, concurrency, and recovery
assertions only; it does not replace or relax a performance scenario.

迁移必须同时满足：

- Migrate V1 Deployments to one Cohort without changing targets, assignments, tokens, acknowledgements, or events.
- In-flight Delivery Tasks continue with identical delivery IDs and bodies.
- Existing Agents never receive a synthetic rollback or lower revision during migration.

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
