# ConfigRelay Harness-owned E2E / Concurrency / Recovery / Performance 方案

## 1. 边界与等级

本文件位于 candidate workspace 外，只定义 D1 黑盒评测方案。当前没有 runner、中央 score
manifest、gold 或 calibration 证据，不能声称 D3。Evaluator 只使用公开命令、HTTP、浏览器、
webhook receiver、文件下载和进程信号；不得 import 候选源码、ORM、表名或 'dist' 路径。

## 2. 固定环境

- Node.js 22、PostgreSQL 16、Chromium 和 Docker-compatible OCI；容器限制为 4 logical CPUs、
  8 GiB RAM，两个 API、两个 workers、一个 dispatcher 和 PostgreSQL 共享该限制；
- 每个 scenario 使用新数据库、新端口和独立 managed data directory；
- 两个 API、至少两个 Delivery Task workers 和一个 dispatcher 共享同一 PostgreSQL；
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

- Publish immutable Configuration revisions and create Deployments for a deterministic Agent selector snapshot.
- Deliver Assignments at least once in increasing command sequence and nondecreasing V1 revision order per Agent.
- Accept acknowledgements only for the current assignment token and preserve duplicate replay.
- Recover delivery after dispatcher death and reconcile Agents that reconnect with stale applied revisions.
- Expose fleet drift, assignment progress, failures, per-Agent history, and audit events in the UI.

对每个成功状态同时检查响应、查询、历史、异步工作和事件。

### H-04 Atomic rejection and conservation

在每个公开失败边界生成合法但不可满足的请求，断言无 partial aggregate、任务、事件或守恒量
变化。核心断言：

1. For each Agent, the first accepted acknowledgement for a commandSequence is exactly the prior accepted sequence plus one and matches the current assignmentToken; an identical replay has no second effect, and no stale token or sequence can change desired or applied state.
2. One Deployment captures an immutable selector result and Configuration digest.
3. A stale assignment token cannot change current desired or applied state.
4. Every successful acknowledgement matches the exact delivered revision digest.
5. Repeated delivery preserves deliveryId, semantic body, and per-Agent command order.

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

- Migrate V1 Deployments to one Cohort without changing targets, assignments, tokens, acknowledgements, or events.
- In-flight Delivery Tasks continue with identical delivery IDs and bodies.
- Existing Agents never receive a synthetic rollback or lower revision during migration.

### H-10 Manager core behavior

仅在 T16 已发布后按黑盒方式验证：

- A Deployment contains ordered Cohorts selected from one immutable target snapshot and starts only the first Cohort.
- Each Cohort declares minimum success basis points, maximum failure basis points, and an observation deadline. Both thresholds are integers 0..10000 and the denominator is immutable targetCount. Before the deadline, success and failure count APPLIED and REJECTED acknowledgements; at the deadline, success still counts APPLIED and failure is targetCount minus successCount, so every missing acknowledgement is a failure.
- Evaluate once when every target has acknowledged or when observationDeadlineAt is reached: the Cohort succeeds exactly when floor(successCount*10000/targetCount) >= minimumSuccessBasisPoints and floor(failureCount*10000/targetCount) <= maximumFailureBasisPoints; otherwise it fails. targetCount zero is invalid, and simultaneous acknowledgements or deadline workers produce one durable transition.
- A failed Cohort supersedes every still-pending APPLY command and starts one automatic Rollback for exactly the captured Agents in this and earlier Cohorts whose APPLY acknowledgement changed them to the Deployment revision.
- Rollback delivery uses new stable identities and a strictly increasing commandSequence; it may apply each affected Agent's captured lower prior revision and completes only after every captured rollback command is terminal.
- Legacy all-at-once Deployments behave as one Cohort and keep existing response fields; staged Deployments expose cohorts[] and rollback.

新增 wire schema 与接口同样属于断言面：

- DeploymentCohort = {cohortId:uuid,deploymentId:uuid,ordinal:int,name:string,selector:{labels:{key:string,value:string}},targetCount:int,targetDigest:sha256,minimumSuccessBasisPoints:int,maximumFailureBasisPoints:int,observationSeconds:int,successCount:int,failureCount:int,pendingCount:int,state:WAITING|DELIVERING|OBSERVING|SUCCEEDED|FAILED|ROLLED_BACK,startedAt:timestamp|null,observationDeadlineAt:timestamp|null,completedAt:timestamp|null}; counts are non-negative and sum to targetCount, and deadline evaluation moves every missing acknowledgement from pendingCount to failureCount
- RolloutCommand = {commandId:uuid,deploymentId:uuid,cohortId:uuid,agentId:uuid,commandSequence:int,kind:APPLY|ROLLBACK,fromRevision:int,toRevision:int,toDigest:sha256,deliveryId:uuid,assignmentToken:string,state:WAITING|SENT|ACKED|FAILED|SUPERSEDED,createdAt:timestamp,ackedAt:timestamp|null}
- DeploymentRollback = {rollbackId:uuid,deploymentId:uuid,failedCohortId:uuid,state:PENDING|DELIVERING|COMPLETED|FAILED,commandCount:int,completedCount:int,startedAt:timestamp,completedAt:timestamp|null}; commandCount is the immutable affected-Agent count
- For staged Deployments, AgentPollResponse.command additionally permits RolloutCommand; status and nullability rules are unchanged
- Under the Manager schema a staged Deployment adds cohorts:[DeploymentCohort] and rollback:DeploymentRollback|null; cohorts sort by ordinal and rollback is null until a failed Cohort atomically creates it. A legacy all-at-once Deployment retains its exact V1 Deployment shape and omits both Manager-only fields
- POST /api/v1/deployments accepts optional cohorts:[{name,selector,minimumSuccessBasisPoints,maximumFailureBasisPoints,observationSeconds}]. A staged plan contains 1..20 Cohorts; each threshold is an integer 0..10000, observationSeconds is an integer 1..86400, and every Cohort has at least one target. Against the captured outer target set, every Agent must match exactly one Cohort; membership, order, prior revision, and digests commit atomically.
- GET /api/v1/deployments/:deploymentId returns the extended Deployment with cohorts[] in ordinal order and rollback:null|DeploymentRollback only for a staged Deployment; a legacy all-at-once Deployment returns the exact V1 Deployment shape with no cohorts or rollback fields.
- POST /api/v1/agents/:agentId/poll accepts optional lastCommandSequence and returns at most the next RolloutCommand. APPLY and ROLLBACK share one strictly increasing per-Agent commandSequence and retries preserve commandId, deliveryId, body, and assignmentToken.
- POST /api/v1/agents/:agentId/acknowledgements includes commandSequence for staged Deployments; only the current token at the next sequence can change state, while an identical replay returns its original result.
- The transaction that fails a Cohort freezes the affected-Agent set from successful APPLY acknowledgements, supersedes all other pending APPLY commands, creates exactly one ROLLBACK command per affected Agent, and never adds a later Agent to that Rollback.
- 400 INVALID_COHORT_PLAN: cohort count, order, thresholds, observation duration, name, or selector is invalid
- 409 COHORT_TARGET_PARTITION_INVALID: a captured target Agent matches zero or multiple Cohorts
- 409 AGENT_COMMAND_SEQUENCE_CONFLICT: the command or acknowledgement is not the current next per-Agent sequence
- The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
- The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
- Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
- Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

FINAL snapshot 与性能兼容断言：

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

同时验证每个失败分支整组回滚和重复请求一致。

### H-11 Manager UI, concurrency, and recovery

用 production Chromium 完成新旧流程；两个 API/worker 竞争 Manager 新基数或状态；在可观察
barrier 崩溃并恢复；检查 compatibility fields、聚合状态、成员状态、事件顺序和无重复效果。

### H-12 Sustained performance plus post-load correctness

严格对 FINAL binary 重跑 workspace README 的同三个 V1-compatible scenario，不得改变任何字段或
阈值；Manager 增量只增加 correctness、concurrency 和 recovery 断言。每个 scenario 使用独立新库，
严格执行公开 dataset、setup、selector、request、concurrency、warm-up、measurement、success、
threshold 和 timer，记录 p50/p95/p99、吞吐、成功 mutation、预期冲突、unexpected 5xx、
worker/dispatcher backlog 与排空时间。固定 dataset 为：seedVersion perf-v1 contains exactly 100 fleets, 100,000 agents, 1,000 configurations, 500 deployments, and 50,000 WAITING assignments, with one current Assignment on each of 50,000 distinct Agents.。三个场景是：

### Scenario 'agent-poll'

- Target: serve 2,000 Agent polls/s with p95 <= 80 ms
- Mode: 'http'
- Method: 'POST'
- Path: '/api/v1/agents/:agentId/poll'
- Setup: Use 50,000 Agents with one current WAITING Assignment and 50,000 without a newer Assignment; the scenario does not acknowledge commands.
- Selector: Alternate COMMAND-eligible and NO_CHANGE Agent IDs, each subgroup bytewise round-robin.
- Request: {appliedRevision} equal to the seeded Agent value; COMMAND Agents submit last known applied revision and NO_CHANGE Agents are current.
- Concurrency: 64
- Warm-up seconds: 10
- Measure seconds: 60
- Success: Only 200 exact AgentPollResponse bodies count; the measured mix is exactly 50% COMMAND and 50% NO_CHANGE over each complete 100-request block.
- Threshold: At least 2,000 successful polls/s for 60 seconds and p95 <= 80 ms; token mix-up and unexpected 5xx = 0.
- Timer: The throughput window starts with the first measured request after warm-up; each latency sample runs from request dispatch through the complete response body.

### Scenario 'acknowledgement-ingest'

- Target: ingest 1,000 acknowledgements/s with p95 <= 180 ms
- Mode: 'http'
- Method: 'POST'
- Path: '/api/v1/agents/:agentId/acknowledgements'
- Setup: Poll 35,000 disjoint current Assignments before timing to obtain their exact tokens. Reserve 5,000 for warm-up and 30,000 for measurement.
- Selector: Repeat two-request pairs: one new acknowledgement then one exact idempotent replay. Among unique requests, 90% outcome APPLIED and 10% REJECTED.
- Request: {deploymentId,commandSequence,revision,digest,assignmentToken,outcome}; each replay reuses the original key and byte-identical body.
- Concurrency: 64
- Warm-up seconds: 10
- Measure seconds: 60
- Success: A first stored acknowledgement or exact replay counts; stale token/sequence responses do not count and each unique Assignment changes state once.
- Threshold: At least 1,000 successful responses/s for 60 seconds and p95 <= 180 ms with the exact 45% APPLIED, 5% REJECTED, 50% replay request mix.
- Timer: The throughput window starts with the first measured request after warm-up; each latency sample runs from request dispatch through the complete response body.

### Scenario 'assignment-delivery-recovery'

- Target: recover and deliver 50,000 pending Assignments within 120 s
- Mode: 'worker'
- Method: 'N/A'
- Path: 'work:ASSIGNMENT_DELIVERY'
- Setup: Exactly 50,000 WAITING Assignments on distinct Agents have pending delivery Work. Hold two workers at worker.claimed, SIGKILL, wait for lease expiry, then start two replacements.
- Selector: Deliver by deployment createdAt,deploymentId,agentId and preserve each commandSequence plus deliveryId across retry.
- Request: No measured client request is issued; setup uses only the published seed and public APIs before the worker timer starts.
- Concurrency: 2
- Warm-up seconds: 0
- Measure seconds: 120
- Success: Every selected Assignment reaches SENT with its stable delivery identity, no ASSIGNMENT_DELIVERY Work remains nonterminal, and Agent desired state plus Deployment counts reconcile; ACKED is not required.
- Threshold: All 50,000 Assignments reach SENT in <= 120 seconds after replacement spawn; stale commits and unexpected failures are zero.
- Timer: Start when both replacements spawn and stop on a point-in-time snapshot proving SENT state, drained Work, and all counters.

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
