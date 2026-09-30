# QueueForge 项目设计说明

## 1. 定位

QueueForge 是一个从近空白 Git fixture 开始的高难度全栈 Coding Benchmark，主流程是
lease-based asynchronous job execution。这是 learning task，用于形成可迁移的工程经验。

本题只用一个主流程承载难度，重点测量：durable leases、retry determinism、cancellation races、fair scheduling、crash recovery。领域词汇以
[CONTEXT.md](./CONTEXT.md) 为准。

## 2. 可见性

Codex 初始只能看到 'workspace/README.md'、'workspace/AGENTS.md' 和独立 fixture Git 历史。
Manager 变更、Checklist、对话状态机、评测方案和实验 metadata 都在 workspace 外，不能在
开发回合、Session Evolution 或盲审前复制或透露。

## 3. 完整 V1

- Create versioned Job Definitions and enqueue Runs with priority and notBefore.
- Let multiple workers lease Runs fairly while respecting per-Queue concurrency capacity.
- Retry published failure classes with deterministic backoff and recover expired leases after SIGKILL.
- Cancel queued or running Runs with one winner against completion and no duplicate terminal event.
- Expose queue depth, attempts, live state, histories, and at-least-once Run Event webhooks.

核心状态：Run: QUEUED -> RUNNING -> SUCCEEDED | FAILED | CANCELLED; expired RUNNING leases return to QUEUED until attempts are exhausted.

### 可计算不变量

1. A Run has at most one live Execution Lease and at most one terminal outcome.
2. Active leases in a Queue never exceed its configured capacity.
3. Each Attempt number is unique and strictly increasing for its Run.
4. A retry uses the immutable Job Definition version captured when the Run was created.
5. Priority, notBefore, createdAt, and ID produce a deterministic claim order among eligible Runs.

## 4. Manager 固定变更

V1、真实 Browser E2E、双 API/双 Worker 并发与恢复完成后，T16 才发布
“dependency-aware run graphs”。它改变核心基数、状态或一致性边界：

- A Workflow Run contains 1-50 node Runs connected by an acyclic dependency graph.
- Nodes become eligible only after all required predecessors succeed; independent nodes may execute concurrently.
- When a node becomes FAILED, every non-terminal transitive descendant with that failed ancestor becomes BLOCKED. A BLOCKED Run has no Execution Lease, consumes no Attempt, and cannot be claimed.
- Cancelling a Workflow Run cancels every non-terminal node atomically and never changes completed nodes.
- Retry is legal for any FAILED node below its captured maxAttempts, including a leaf node. The retry transaction changes that node to QUEUED and changes only BLOCKED descendants whose sole FAILED ancestor was that node to QUEUED without changing their attemptCount; other BLOCKED descendants remain unchanged. It changes a FAILED Workflow Run back to RUNNING with terminalAt null and leaves claim eligibility gated on all immediate predecessors being SUCCEEDED.
- Workflow Run is QUEUED before its first claim, RUNNING after that point while any node is QUEUED or RUNNING, SUCCEEDED when every node succeeds, FAILED when no node is QUEUED or RUNNING and at least one node is FAILED or BLOCKED, and CANCELLED after workflow cancellation.
- Legacy standalone Run endpoints and response bodies remain unchanged; graph nodes expose workflowRunId and nodeKey.

新增 wire schema：

- WorkflowNode = {nodeKey:string,runId:uuid,dependsOn:[string],state:QUEUED|RUNNING|SUCCEEDED|FAILED|BLOCKED|CANCELLED}; Run adds workflowRunId:uuid|null and nodeKey:string|null, and workflow node Runs additionally permit state BLOCKED
- WorkflowRun = {workflowRunId:uuid,state:QUEUED|RUNNING|SUCCEEDED|FAILED|CANCELLED,nodes:[WorkflowNode],createdAt:timestamp,terminalAt:timestamp|null,sequence:int}

新增或变更的公开接口：

- POST /api/v1/workflow-runs with {nodes:[{nodeKey,jobDefinitionId,jobVersion,queueId,priority,input,dependsOn:[nodeKey]}]} atomically creates 1..50 Runs after validating a DAG
- GET /api/v1/workflow-runs/:workflowRunId returns WorkflowRun in nodeKey order; POST /api/v1/workflow-runs/:workflowRunId/cancel with {reason} cancels all non-terminal nodes
- POST /api/v1/workflow-runs/:workflowRunId/nodes/:nodeKey/retry with {} performs the published FAILED/BLOCKED-to-QUEUED transaction; the next worker claim creates the next Attempt and Execution Lease

新增稳定错误：

- 400 WORKFLOW_GRAPH_CYCLE: dependsOn contains a cycle, missing key, duplicate key, or self-edge
- 409 WORKFLOW_NODE_NOT_RETRYABLE: node state or dependent state makes retry illegal

跨层规则：

- The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
- The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
- Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
- Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

FINAL snapshot 与性能兼容合同：

The FINAL verification snapshot 'resources' object has exactly the union of these V1 and Manager resource specifications, with no other keys:

- 'queues' uses exact shape 'Queue = {queueId:uuid,name:string,capacity:int}' and sorts ascending by scalar field-path tuple 'queueId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'jobDefinitions' uses exact shape 'JobDefinition' and sorts ascending by scalar field-path tuple 'jobDefinitionId', 'version', then by RFC 8785 canonical JSON as the tie-breaker.
- 'runs' uses exact shape 'Run' and sorts ascending by scalar field-path tuple 'runId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'executionLeases' uses exact shape 'ExecutionLease' and sorts ascending by scalar field-path tuple 'runId', 'attempt', then by RFC 8785 canonical JSON as the tie-breaker.
- 'attempts' uses exact shape 'Attempt' and sorts ascending by scalar field-path tuple 'runId', 'attempt', then by RFC 8785 canonical JSON as the tie-breaker.
- 'workflowRuns' uses exact shape 'WorkflowRun' and sorts ascending by scalar field-path tuple 'workflowRunId', then by RFC 8785 canonical JSON as the tie-breaker.

The Manager-added resource specifications are exactly:

- 'workflowRuns' uses exact shape 'WorkflowRun' and sorts ascending by scalar field-path tuple 'workflowRunId', then by RFC 8785 canonical JSON as the tie-breaker.

The FINAL Work kind enum is exactly the union 'RUN_EXECUTION'. The Manager-added
Work kinds are exactly (none). All V1 snapshot point-in-time,
recursive '*Token' omission, sorting, Work state/lease/retention/drain, and Domain Event rules remain
mandatory. The FINAL binary reruns exactly these three V1-compatible scenarios:

- 'run-enqueue': enqueue 300 Runs/s with p95 <= 250 ms; threshold: At least 300 successful enqueues/s for 60 seconds and p95 <= 250 ms; unexpected 5xx = 0.
- 'short-run-execution': claim and complete 5,000 short Runs within 60 s using four workers; threshold: The complete set finishes in <= 60 seconds; stale-lease responses and unexpected 5xx are zero.
- 'expired-lease-recovery': recover 2,000 expired leases within 45 s without capacity oversubscription; threshold: All expired leases recover in <= 45 seconds; unexpected worker failures = 0.

Their published setup, selector, request, concurrency, warm-up, measurement, timer, success condition,
and threshold remain unchanged. This Manager change adds correctness, concurrency, and recovery
assertions only; it does not replace or relax a performance scenario.

迁移必须同时满足：

- Existing Runs remain standalone with workflowRunId null and unchanged histories.
- Pending and leased V1 Runs continue after migration with the same lease and attempt semantics.
- Existing idempotency records and Run Event sequences remain replayable.

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
