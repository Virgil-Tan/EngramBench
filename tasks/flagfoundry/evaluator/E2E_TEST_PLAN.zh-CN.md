# FlagFoundry Harness-owned E2E / Concurrency / Recovery / Performance 方案

## 1. 边界与等级

本文件位于 candidate workspace 外，只定义 D1 黑盒评测方案。当前没有 runner、中央 score
manifest、gold 或 calibration 证据，不能声称 D3。Evaluator 只使用公开命令、HTTP、浏览器、
webhook receiver、文件下载和进程信号；不得 import 候选源码、ORM、表名或 'dist' 路径。

## 2. 固定环境

- Node.js 22、PostgreSQL 16、Chromium 和 Docker-compatible OCI；容器限制为 4 logical CPUs、
  8 GiB RAM，两个 API、两个 workers、一个 dispatcher 和 PostgreSQL 共享该限制；
- 每个 scenario 使用新数据库、新端口和独立 managed data directory；
- 两个 API、至少两个 Compilation Task workers 和一个 dispatcher 共享同一 PostgreSQL；
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

- Create typed Flags and Draft revisions with ordered targeting rules and integer basis-point allocations.
- Compile Drafts asynchronously into deterministic Snapshots and reject invalid or stale revisions.
- Activate one revision with expected-active compare-and-set semantics across API instances.
- Evaluate a captured Snapshot deterministically and expose an explanation trace without process-local authority.
- Deliver activation events at least once and show revisions, diffs, evaluations, and audit history in the UI.

对每个成功状态同时检查响应、查询、历史、异步工作和事件。

### H-04 Atomic rejection and conservation

在每个公开失败边界生成合法但不可满足的请求，断言无 partial aggregate、任务、事件或守恒量
变化。核心断言：

1. Exactly one Flag Revision is active for a Flag and Environment at an instant.
2. The same Snapshot digest and Evaluation Context always produce the same variant and reason.
3. Variant allocation basis points sum to exactly 10,000 for every percentage rule.
4. Activation succeeds only for the exact active revision and rule schema captured by Compilation Task.
5. An inactive, rejected, or stale revision cannot become observable through evaluation.

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

- Existing active revisions and Snapshot digests remain byte-identical and acquire no synthetic activation.
- Pending Compilation Tasks retain their captured active revision and complete or fail stale normally.
- Old evaluation and activation replay responses remain exactly valid; only newly progressive activations include rollout fields.

### H-10 Manager core behavior

仅在 T16 已发布后按黑盒方式验证：

- Activation may include 1-10 ordered Cohort Steps, each with candidateExposureBasisPoints, minimumEvaluationCount, maximumFailureBasisPoints, and observationSeconds.
- For every Step, the rollout bucket is SHA-256(UTF-8(flagKey) + NUL + UTF-8(environment) + NUL + UTF-8(subjectKey)), interpreted from its first eight bytes as an unsigned big-endian integer modulo 10000. The candidate is selected exactly when bucket < candidateExposureBasisPoints; otherwise the captured prior Snapshot is selected. The bucket is independent of snapshotDigest and remains stable across Steps, and every response names rolloutId and stepIndex.
- Clients submit idempotent Evaluation Outcome batches keyed by outcomeId with SUCCESS or FAILURE for the exact evaluation Snapshot and Step.
- For a Step, evaluationCount equals successCount plus failureCount; when evaluationCount is positive, failureBasisPoints is floor(failureCount * 10000 / evaluationCount). A Step with minimumEvaluationCount 0 passes immediately; otherwise it remains OBSERVING before its deadline while evaluationCount is below the minimum, then passes when failureBasisPoints <= maximumFailureBasisPoints or fails and atomically rolls all traffic back when failureBasisPoints is greater.
- The first Step starts at the activation transaction time and each later Step starts in the transaction that passes its predecessor. observationDeadlineAt equals startedAt plus observationSeconds. At database time >= observationDeadlineAt, deadline resolution precedes new Outcome acceptance: a still-OBSERVING Step passes only when evaluationCount >= minimumEvaluationCount and failureBasisPoints <= maximumFailureBasisPoints, otherwise it fails and rolls back.
- Concurrent immediate activation makes the rollout STALE and no later Outcome may advance it.
- Legacy activation is one Step at 10000 basis points with zero observation requirement and keeps the old response shape; progressive activations expose rollout and steps[].

新增 wire schema 与接口同样属于断言面：

- ProgressiveRollout = {rolloutId:uuid,flagId:uuid,environment:string,priorRevisionId:uuid,candidateRevisionId:uuid,state:RUNNING|COMPLETED|ROLLED_BACK|STALE,currentStepIndex:int,steps:[{stepIndex:int,candidateExposureBasisPoints:int,minimumEvaluationCount:int,maximumFailureBasisPoints:int,observationSeconds:int,successCount:int,failureCount:int,state:PENDING|OBSERVING|PASSED|FAILED,startedAt:timestamp|null,observationDeadlineAt:timestamp|null,completedAt:timestamp|null}],createdAt:timestamp,terminalAt:timestamp|null}
- EvaluationOutcome = {outcomeId:string,rolloutId:uuid,stepIndex:int,subjectKey:string,snapshotDigest:sha256,outcome:SUCCESS|FAILURE,reportedAt:timestamp}
- POST /api/v1/flag-revisions/:revisionId/progressive-activate with {expectedActiveRevision,steps:[{candidateExposureBasisPoints,minimumEvaluationCount,maximumFailureBasisPoints,observationSeconds}]} returns 202 ProgressiveRollout; observationSeconds is an integer from 1 through 86400
- POST /api/v1/progressive-rollouts/:rolloutId/outcome-batches with {outcomes:[{outcomeId,stepIndex,subjectKey,snapshotDigest,outcome}]} atomically returns accepted and duplicate IDs
- GET /api/v1/progressive-rollouts/:rolloutId returns exact rollout counters; Evaluation adds rolloutId:uuid|null and stepIndex:int|null
- 409 ROLLOUT_STALE: active revision changed or an Outcome targets another current Step
- 409 OUTCOME_WINDOW_CLOSED: the current Step reached observationDeadlineAt before this Outcome batch could commit
- 409 OUTCOME_ID_CONFLICT: an existing outcomeId has different semantics
- 400 INVALID_ROLLOUT_STEPS: exposure is not strictly increasing to 10000, thresholds are outside 0..10000, or observationSeconds is outside 1..86400
- The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
- The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
- Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
- Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

FINAL snapshot 与性能兼容断言：

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

同时验证每个失败分支整组回滚和重复请求一致。

### H-11 Manager UI, concurrency, and recovery

用 production Chromium 完成新旧流程；两个 API/worker 竞争 Manager 新基数或状态；在可观察
barrier 崩溃并恢复；检查 compatibility fields、聚合状态、成员状态、事件顺序和无重复效果。

### H-12 Sustained performance plus post-load correctness

严格对 FINAL binary 重跑 workspace README 的同三个 V1-compatible scenario，不得改变任何字段或
阈值；Manager 增量只增加 correctness、concurrency 和 recovery 断言。每个 scenario 使用独立新库，
严格执行公开 dataset、setup、selector、request、concurrency、warm-up、measurement、success、
threshold 和 timer，记录 p50/p95/p99、吞吐、成功 mutation、预期冲突、unexpected 5xx、
worker/dispatcher backlog 与排空时间。固定 dataset 为：seedVersion perf-v1 contains exactly 100 projects, 300 environments, 5,000 flags, and 5,000 activeRevisions, one active Revision for each measured Flag and Environment pair; compilation runs create candidates through the public API.。三个场景是：

### Scenario 'flag-evaluation'

- Target: evaluate 2,000 decisions/s with p95 <= 40 ms
- Mode: 'http'
- Method: 'POST'
- Path: '/api/v1/evaluations'
- Setup: Use all measured active Flag/Environment pairs. Context has exactly subjectKey, region, and tier and satisfies the selected Environment schema.
- Selector: Round-robin pairs by projectId,flagId,environment bytewise; subjectKey is perf-subject-{request ordinal modulo 100000}.
- Request: {projectId,flagKey,environment,context:{subjectKey,region:"us",tier:"pro"}} with no snapshotDigest pin.
- Concurrency: 64
- Warm-up seconds: 10
- Measure seconds: 60
- Success: Only 200 Evaluation responses matching an active immutable FlagSnapshot count; repeat inputs must return the same variant and reason.
- Threshold: At least 2,000 successful decisions/s for 60 seconds and p95 <= 40 ms; mixed-snapshot and unexpected 5xx counts are zero.
- Timer: The throughput window starts with the first measured request after warm-up; each latency sample runs from request dispatch through the complete response body.

### Scenario 'revision-compilation'

- Target: compile 100 revisions/s with p95 queue latency <= 2 s
- Mode: 'http'
- Method: 'POST'
- Path: '/api/v1/flags/:flagId/revisions'
- Setup: Prepare disjoint warm-up and measured request ordinals over existing Flags; each candidate has two variants and ten one-clause rules using declared attributes.
- Selector: Round-robin flagId then Environment bytewise; expectedActiveRevision is read once immediately before each request.
- Request: {environment,flagType,defaultVariant,variants:[two totaling 10000],rules:[ten],expectedActiveRevision} with a fresh key.
- Concurrency: 64
- Warm-up seconds: 10
- Measure seconds: 60
- Success: Only 202 creations whose FLAG_COMPILATION Work reaches READY count; REJECTED or stale candidates do not count.
- Threshold: At least 100 READY revisions/s for 60 seconds and creation-commit to READY-commit queue-latency p95 <= 2,000 ms.
- Timer: The throughput window starts at first measured POST; per-revision latency starts at creation commit and ends at the READY commit observed in one snapshot.

### Scenario 'disjoint-activation'

- Target: activate 500 disjoint revisions during 60 s with no mixed snapshot reads
- Mode: 'http'
- Method: 'POST'
- Path: '/api/v1/flag-revisions/:revisionId/activate'
- Setup: Before timing, create exactly 500 READY measured candidates for 500 distinct Flag/Environment pairs and a disjoint warm-up set.
- Selector: Activate candidates by flagId,environment bytewise; each pair is targeted once.
- Request: {expectedActiveRevision} captured with the candidate; use a fresh Idempotency-Key.
- Concurrency: 64
- Warm-up seconds: 10
- Measure seconds: 60
- Success: All 500 requests succeed, each pair has exactly one new active pointer, and concurrent evaluations see only the complete prior or candidate Snapshot.
- Threshold: Exactly 500 disjoint activations finish within 60 seconds; conflicts, mixed snapshots, gaps, and unexpected 5xx are zero.
- Timer: The throughput window starts with the first measured request after warm-up; each latency sample runs from request dispatch through the complete response body.

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
