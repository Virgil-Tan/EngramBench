# QueueForge 多轮用户与 Manager Prompt 协议

## 可见性

本文件只属于 Benchmark Harness，不得复制进 workspace、传给 Codex、Session Evolution 或
盲审 Judge。DS 只根据 workspace 的公开合同、可见对话和当前 scene 推进。

## DS system role

你是一名使用 Codex 完成 QueueForge 的交付负责人。每轮只提出一个主要目标，用自然简短的中文推进真实开发。可以询问模块职责、接口、状态、数据流、设计取舍和实际验证证据，但绝不能提供代码、伪代码、SQL、命令、补丁、文件或函数定位、表结构、锁、事务、索引、缓存、队列、算法、性能方案、日志分析、Debug 根因或修复提示。Codex 报告失败时只要求其自行定位、修复并重新验证。只使用 README、AGENTS 和已经出现在可见对话中的 Manager 变更，不透露未来阶段或私有评测。

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

V1 已完成并通过基础验收。本期正式增加“dependency-aware run graphs”。以下业务规则、wire schema、接口和错误全部是公开增量合同。

业务规则：

1. A Workflow Run contains 1-50 node Runs connected by an acyclic dependency graph.
2. Nodes become eligible only after all required predecessors succeed; independent nodes may execute concurrently.
3. When a node becomes FAILED, every non-terminal transitive descendant with that failed ancestor becomes BLOCKED. A BLOCKED Run has no Execution Lease, consumes no Attempt, and cannot be claimed.
4. Cancelling a Workflow Run cancels every non-terminal node atomically and never changes completed nodes.
5. Retry is legal for any FAILED node below its captured maxAttempts, including a leaf node. The retry transaction changes that node to QUEUED and changes only BLOCKED descendants whose sole FAILED ancestor was that node to QUEUED without changing their attemptCount; other BLOCKED descendants remain unchanged. It changes a FAILED Workflow Run back to RUNNING with terminalAt null and leaves claim eligibility gated on all immediate predecessors being SUCCEEDED.
6. Workflow Run is QUEUED before its first claim, RUNNING after that point while any node is QUEUED or RUNNING, SUCCEEDED when every node succeeds, FAILED when no node is QUEUED or RUNNING and at least one node is FAILED or BLOCKED, and CANCELLED after workflow cancellation.
7. Legacy standalone Run endpoints and response bodies remain unchanged; graph nodes expose workflowRunId and nodeKey.
8. Existing Runs remain standalone with workflowRunId null and unchanged histories.
9. Pending and leased V1 Runs continue after migration with the same lease and attempt semantics.
10. Existing idempotency records and Run Event sequences remain replayable.
11. The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
12. The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
13. Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
14. Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

新增 wire schema：

- WorkflowNode = {nodeKey:string,runId:uuid,dependsOn:[string],state:QUEUED|RUNNING|SUCCEEDED|FAILED|BLOCKED|CANCELLED}; Run adds workflowRunId:uuid|null and nodeKey:string|null, and workflow node Runs additionally permit state BLOCKED
- WorkflowRun = {workflowRunId:uuid,state:QUEUED|RUNNING|SUCCEEDED|FAILED|CANCELLED,nodes:[WorkflowNode],createdAt:timestamp,terminalAt:timestamp|null,sequence:int}

新增或变更接口：

- POST /api/v1/workflow-runs with {nodes:[{nodeKey,jobDefinitionId,jobVersion,queueId,priority,input,dependsOn:[nodeKey]}]} atomically creates 1..50 Runs after validating a DAG
- GET /api/v1/workflow-runs/:workflowRunId returns WorkflowRun in nodeKey order; POST /api/v1/workflow-runs/:workflowRunId/cancel with {reason} cancels all non-terminal nodes
- POST /api/v1/workflow-runs/:workflowRunId/nodes/:nodeKey/retry with {} performs the published FAILED/BLOCKED-to-QUEUED transaction; the next worker claim creates the next Attempt and Execution Lease

新增稳定错误：

- 400 WORKFLOW_GRAPH_CYCLE: dependsOn contains a cycle, missing key, duplicate key, or self-edge
- 409 WORKFLOW_NODE_NOT_RETRYABLE: node state or dependent state makes retry illegal

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
