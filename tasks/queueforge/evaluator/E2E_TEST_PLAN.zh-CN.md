# QueueForge Harness-owned E2E / Concurrency / Recovery / Performance 方案

## 1. 边界与等级

本文件位于 candidate workspace 外，只定义 D1 黑盒评测方案。当前没有 runner、中央 score
manifest、gold 或 calibration 证据，不能声称 D3。Evaluator 只使用公开命令、HTTP、浏览器、
webhook receiver、文件下载和进程信号；不得 import 候选源码、ORM、表名或 'dist' 路径。

## 2. 固定环境

- Node.js 22、PostgreSQL 16、Chromium 和 Docker-compatible OCI；容器限制为 4 logical CPUs、
  8 GiB RAM，两个 API、两个 workers、一个 dispatcher 和 PostgreSQL 共享该限制；
- 每个 scenario 使用新数据库、新端口和独立 managed data directory；
- 两个 API、至少两个 Execution Lease workers 和一个 dispatcher 共享同一 PostgreSQL；
- command timeout 60 分钟，project timeout 24 小时；
- 合法随机输入和交错保存私有 seed，失败报告只公开脱敏后的断言与复现 ID。

## 3. Snapshot 与 barrier

T15 后冻结 'V1_SNAPSHOT'，T22 后冻结 'FINAL_SNAPSHOT'。H-09 先用 V1 binary/contract 写入
历史数据、pending work、event 和 idempotency replay，再切换到 FINAL migration。

- unknown HTTP outcome：response shield 收到完整 upstream response 后断开 candidate client；
- unknown webhook ACK：receiver 收到并持久化完整 request 后暂停 ACK，再 SIGKILL dispatcher；
- worker recovery：按公开 'TEST_BARRIER_URL' 协议在 'worker.claimed'、
  'worker.effect-complete' 或 'worker.before-commit' 收到完整 barrier body 后暂停，再 SIGKILL
  worker 并等待 'WORK_LEASE_SECONDS'；
- 不允许随机 sleep 推断 commit、claim、delivery 或 ACK 时点。

## 4. Hidden scenario design

### H-01 Clean install, migration, seed, build, and boot

从 fixture commit 开始执行公开命令；migration 重放；合法 seed、同 digest 重放、冲突版本和随机
非法成员；生产 API/UI/worker/dispatcher 全部启动。断言 OpenAPI 与 runtime 基础状态一致。

### H-02 Contract, validation, query, and browser baseline

随机 UUID、边界整数、未知字段、媒体类型、游标和时间；验证稳定错误、分页、排序、真实 React
页面、键盘路径、移动布局和 refresh 后状态。

### H-03 V1 successful main flow

通过公开 API 和浏览器完成：

- Create versioned Job Definitions and enqueue Runs with priority and notBefore.
- Let multiple workers lease Runs fairly while respecting per-Queue concurrency capacity.
- Retry published failure classes with deterministic backoff and recover expired leases after SIGKILL.
- Cancel queued or running Runs with one winner against completion and no duplicate terminal event.
- Expose queue depth, attempts, live state, histories, and at-least-once Run Event webhooks.

对每个成功状态同时检查响应、查询、历史、异步工作和事件。

### H-04 Atomic rejection and conservation

在每个公开失败边界生成合法但不可满足的请求，断言无 partial aggregate、任务、事件或守恒量
变化。核心断言：

1. A Run has at most one live Execution Lease and at most one terminal outcome.
2. Active leases in a Queue never exceed its configured capacity.
3. Each Attempt number is unique and strictly increasing for its Run.
4. A retry uses the immutable Job Definition version captured when the Run was created.
5. Priority, notBefore, createdAt, and ID produce a deterministic claim order among eligible Runs.

### H-05 Durable idempotency and unknown response

对每个 mutation 测试相同 key replay、语义冲突、20 路并发、response shield、API SIGKILL 和
重启。状态码与语义 JSON 保持原结果，且只出现一次业务效果和事件。

### H-06 Multi-process contention

两个 API 和两个 workers 对同一热点 authority 进行有 seed 的竞争；随机化合法请求数量和顺序，
最后通过公开查询重算全部不变量，不依赖数据库内部结构。

### H-07 Worker lease and terminal recovery

分别在 claim 后、外部工作后、commit 前 barrier SIGKILL worker；等待 'WORK_LEASE_SECONDS' 后
启动另一 worker，断言任务可恢复、stale token 失败、终态和副作用最多一次。

### H-08 Transactional outbox and unknown ACK

对成功和回滚业务检查 event existence；receiver 返回 500、断开连接、在完整 body 后暂停 ACK，
dispatcher 重启。重试保持 eventId/body，成功顺序递增，不能丢 event 或制造新身份。

### H-09 Populated V1 to FINAL migration

V1_SNAPSHOT 生成普通、边界、terminal、pending、leased、undelivered 和已保存 replay 数据。
FINAL migration 后逐项验证：

- Existing Runs remain standalone with workflowRunId null and unchanged histories.
- Pending and leased V1 Runs continue after migration with the same lease and attempt semantics.
- Existing idempotency records and Run Event sequences remain replayable.

### H-10 Manager core behavior

仅在 T16 已发布后按黑盒方式验证：

- A Workflow Run contains 1-50 node Runs connected by an acyclic dependency graph.
- Nodes become eligible only after all required predecessors succeed; independent nodes may execute concurrently.
- When a node becomes FAILED, every non-terminal transitive descendant with that failed ancestor becomes BLOCKED. A BLOCKED Run has no Execution Lease, consumes no Attempt, and cannot be claimed.
- Cancelling a Workflow Run cancels every non-terminal node atomically and never changes completed nodes.
- Retry is legal for any FAILED node below its captured maxAttempts, including a leaf node. The retry transaction changes that node to QUEUED and changes only BLOCKED descendants whose sole FAILED ancestor was that node to QUEUED without changing their attemptCount; other BLOCKED descendants remain unchanged. It changes a FAILED Workflow Run back to RUNNING with terminalAt null and leaves claim eligibility gated on all immediate predecessors being SUCCEEDED.
- Workflow Run is QUEUED before its first claim, RUNNING after that point while any node is QUEUED or RUNNING, SUCCEEDED when every node succeeds, FAILED when no node is QUEUED or RUNNING and at least one node is FAILED or BLOCKED, and CANCELLED after workflow cancellation.
- Legacy standalone Run endpoints and response bodies remain unchanged; graph nodes expose workflowRunId and nodeKey.

新增 wire schema 与接口同样属于断言面：

- WorkflowNode = {nodeKey:string,runId:uuid,dependsOn:[string],state:QUEUED|RUNNING|SUCCEEDED|FAILED|BLOCKED|CANCELLED}; Run adds workflowRunId:uuid|null and nodeKey:string|null, and workflow node Runs additionally permit state BLOCKED
- WorkflowRun = {workflowRunId:uuid,state:QUEUED|RUNNING|SUCCEEDED|FAILED|CANCELLED,nodes:[WorkflowNode],createdAt:timestamp,terminalAt:timestamp|null,sequence:int}
- POST /api/v1/workflow-runs with {nodes:[{nodeKey,jobDefinitionId,jobVersion,queueId,priority,input,dependsOn:[nodeKey]}]} atomically creates 1..50 Runs after validating a DAG
- GET /api/v1/workflow-runs/:workflowRunId returns WorkflowRun in nodeKey order; POST /api/v1/workflow-runs/:workflowRunId/cancel with {reason} cancels all non-terminal nodes
- POST /api/v1/workflow-runs/:workflowRunId/nodes/:nodeKey/retry with {} performs the published FAILED/BLOCKED-to-QUEUED transaction; the next worker claim creates the next Attempt and Execution Lease
- 400 WORKFLOW_GRAPH_CYCLE: dependsOn contains a cycle, missing key, duplicate key, or self-edge
- 409 WORKFLOW_NODE_NOT_RETRYABLE: node state or dependent state makes retry illegal
- The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
- The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
- Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
- Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

FINAL snapshot 与性能兼容断言：

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

同时验证每个失败分支整组回滚和重复请求一致。

### H-11 Manager UI, concurrency, and recovery

用 production Chromium 完成新旧流程；两个 API/worker 竞争 Manager 新基数或状态；在可观察
barrier 崩溃并恢复；检查 compatibility fields、聚合状态、成员状态、事件顺序和无重复效果。

### H-12 Sustained performance plus post-load correctness

严格对 FINAL binary 重跑 workspace README 的同三个 V1-compatible scenario，不得改变任何字段或
阈值；Manager 增量只增加 correctness、concurrency 和 recovery 断言。每个 scenario 使用独立新库，
严格执行公开 dataset、setup、selector、request、concurrency、warm-up、measurement、success、
threshold 和 timer，记录 p50/p95/p99、吞吐、成功 mutation、预期冲突、unexpected 5xx、
worker/dispatcher backlog 与排空时间。固定 dataset 为：seedVersion perf-v1 contains exactly 100 queues, 1,000 jobDefinitions, 27,000 runs, 22,000 attempts, and 2,000 executionLeases: 20,000 SUCCEEDED Runs, 5,000 QUEUED Runs, and 2,000 RUNNING Runs whose sole leases are expired.。三个场景是：

### Scenario 'run-enqueue'

- Target: enqueue 300 Runs/s with p95 <= 250 ms
- Mode: 'http'
- Method: 'POST'
- Path: '/api/v1/runs'
- Setup: Choose one seeded ECHO JobDefinition and queues with unused measured capacity; warm-up and measured Run IDs are server-generated from disjoint Idempotency-Keys.
- Selector: Round-robin queues by queueId; use priority 50 and notBefore equal to the setup transaction timestamp.
- Request: {jobDefinitionId,jobVersion,queueId,priority:50,notBefore,input:{value:"64 ASCII bytes, fixed per request ordinal"}}.
- Concurrency: 64
- Warm-up seconds: 10
- Measure seconds: 60
- Success: Only 202 QUEUED responses count; each Run captures the requested JobDefinition version exactly.
- Threshold: At least 300 successful enqueues/s for 60 seconds and p95 <= 250 ms; unexpected 5xx = 0.
- Timer: The throughput window starts with the first measured request after warm-up; each latency sample runs from request dispatch through the complete response body.

### Scenario 'short-run-execution'

- Target: claim and complete 5,000 short Runs within 60 s using four workers
- Mode: 'http'
- Method: 'POST'
- Path: '/api/v1/workers/:workerId/claim; /api/v1/runs/:runId/attempt-result'
- Setup: Use exactly 5,000 QUEUED ECHO Runs whose input JSON is <= 128 bytes; no other Run is eligible in their queues.
- Selector: Four worker clients claim maxRuns:25 from the same bytewise queueId list and immediately return the exact echoed value with outcome SUCCEEDED.
- Request: Claim body is {queueIds,maxRuns:25}; result body is {attempt,leaseToken,outcome:"SUCCEEDED",output:{value},errorCode:null}; the service computes and stores outputDigest.
- Concurrency: 4
- Warm-up seconds: 0
- Measure seconds: 60
- Success: All 5,000 Runs reach SUCCEEDED with one successful Attempt, no lease exceeds Queue capacity, and no Run remains QUEUED or RUNNING.
- Threshold: The complete set finishes in <= 60 seconds; stale-lease responses and unexpected 5xx are zero.
- Timer: Start immediately before the four clients issue their first claim and stop on the verification snapshot proving all 5,000 terminal results.

### Scenario 'expired-lease-recovery'

- Target: recover 2,000 expired leases within 45 s without capacity oversubscription
- Mode: 'worker'
- Method: 'N/A'
- Path: 'work:RUN_EXECUTION'
- Setup: Use exactly 2,000 seeded RUNNING Runs whose sole ExecutionLeases are expired. Start four workers with the published queue capacity limits.
- Selector: Reclaim in priority descending,notBefore,createdAt,runId order and execute each captured operation once.
- Request: No measured client request is issued; setup uses only the published seed and public APIs before the worker timer starts.
- Concurrency: 4
- Warm-up seconds: 0
- Measure seconds: 45
- Success: All 2,000 Runs become terminal through one new Attempt, expired tokens cannot commit, and active leases never exceed any Queue capacity.
- Threshold: All expired leases recover in <= 45 seconds; unexpected worker failures = 0.
- Timer: Start when all four recovery workers are spawned and stop at the first verification snapshot proving no selected Run is nonterminal.

负载后重新执行 H-04 的全部不变量；任何不变量失败都使性能 assertion 失败。不得从旧的目标
摘要推断 workload，也不得把 Manager 增量改成第四个性能阈值。

### H-13 Project-owned gates and handoff truthfulness

从干净数据库逐个运行公开 test 命令，检查真实进程、真实 PostgreSQL、真实 Chromium、barrier
故障和 meaningful assertions；交叉核对最终回复所称命令、结果、性能、风险和未运行项。

## 5. 100 分映射

H-01 -> 5；H-02 -> 5；H-03 -> 10；H-04/H-05 -> 10；H-07/H-08 -> 15；
H-06 -> 10；H-09 -> 15；H-10/H-11 -> 10；H-13 tests -> 8；H-12 -> 7；
blind Judge explanation -> 2；evidence/handoff -> 3。最终 D3 必须把每个 assertion ID、唯一权重、
Checklist testGate 和 hard cap 写入一个 'score-manifest.v1.json'，不能重复计分。

## 6. Hard caps 与 invalid sample

- clean build、migration 或 production boot 失败：总分上限 25；
- 任一守恒、非负、唯一终态、at-most-once business effect 或 atomic rejection 不变量失败：上限 35；
- durable idempotency 在并发、未知响应或重启后产生第二效果：上限 30；
- 已提交业务缺 event、回滚业务有 event、event 重试改变身份/正文：上限 40；
- SIGKILL 后合法 pending work 永久丢失或 stale worker 可提交：上限 40；
- migration 丢历史数据、改变已保存 replay 或破坏旧客户端：上限 35；
- 性能后核心不变量失败：性能项 0 且应用相应 correctness cap。

读取 hidden assets、硬编码私有 fixture、访问 workspace 外路径或逃逸隔离标记为 invalid sample，
不是普通低分。

## 7. Calibration gate

实现 runner 后，先准备 gold 以及至少五个 mutants：process-local idempotency、非原子 event、
无 fencing lease、Manager partial migration、只测吞吐不验 invariant。相同 candidate/seed 至少
重复三次；所有 mutant 必须触发预期 assertion/cap，再冻结 image、fixture commit、README、
Manager、dialogue、score manifest、seed generator 和阈值。
