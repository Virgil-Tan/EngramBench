# QuotaMesh Harness-owned E2E / Concurrency / Recovery / Performance 方案

## 1. 边界与等级

本文件位于 candidate workspace 外，只定义 D1 黑盒评测方案。当前没有 runner、中央 score
manifest、gold 或 calibration 证据，不能声称 D3。Evaluator 只使用公开命令、HTTP、浏览器、
webhook receiver、文件下载和进程信号；不得 import 候选源码、ORM、表名或 'dist' 路径。

## 2. 固定环境

- Node.js 22、PostgreSQL 16、Chromium 和 Docker-compatible OCI；容器限制为 4 logical CPUs、
  8 GiB RAM，两个 API、两个 workers、一个 dispatcher 和 PostgreSQL 共享该限制；
- 每个 scenario 使用新数据库、新端口和独立 managed data directory；
- 两个 API、至少两个 Expiry Task workers 和一个 dispatcher 共享同一 PostgreSQL；
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

- Create Quota Pools and atomically reserve vectors across all requested Dimensions.
- Commit, release, or expire Reservations with one terminal winner across API instances.
- Queue rejected admission requests and promote them fairly when complete vectors fit.
- Recover expiry and promotion after worker death without process-local counters.
- Expose capacity, held/committed quantities, queue position, histories, and event delivery in the UI.

对每个成功状态同时检查响应、查询、历史、异步工作和事件。

### H-04 Atomic rejection and conservation

在每个公开失败边界生成合法但不可满足的请求，断言无 partial aggregate、任务、事件或守恒量
变化。核心断言：

1. For each Pool and Dimension, held plus committed quantity never exceeds capacity and no value is negative.
2. A Reservation owns its complete requested vector or owns none.
3. Commit, release, or expiry adjusts each Dimension exactly once.
4. An Admission Queue entry produces at most one Reservation and cannot bypass an eligible earlier entry of equal priority.
5. All mutation replay remains stable across restart and concurrent API instances.

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

- Existing Reservations, Commitments, queue order, expiry instants, events, and replay bodies remain unchanged.
- Pending Expiry Tasks continue against the default Project created by migration.
- No migration step may temporarily over-allocate an Organization or Project.

### H-10 Manager core behavior

仅在 T16 已发布后按黑盒方式验证：

- Quota Pools form a two-level Organization -> Project hierarchy, with each Project capacity bounded by its Organization allocation.
- A Project Reservation atomically consumes both Project and Organization available vectors.
- Sibling Projects compete under stable priority and requestedAt ordering; unused Project allocation is not implicitly borrowable.
- Organization capacity changes succeed only when every child allocation and active Reservation remains valid.
- Commit, release, expiry, and promotion update both levels exactly once under concurrency.
- Legacy flat Pools migrate as Organizations with one default Project and retain singular pool fields for default-project queries.

新增 wire schema 与接口同样属于断言面：

- QuotaOrganization = {organizationId:uuid,tenantId:uuid,name:string,capacity:{dimension:int},allocated:{dimension:int},held:{dimension:int},committed:{dimension:int},revision:int}; allocated is the sum of child Project allocations and available equals capacity-held-committed
- QuotaProject = {projectId:uuid,organizationId:uuid,name:string,allocation:{dimension:int},held:{dimension:int},committed:{dimension:int},revision:int}; available equals allocation-held-committed
- Reservation, Commitment, and AdmissionEntry add organizationId:uuid and projectId:uuid, and their poolId becomes uuid|null. New hierarchy records have poolId null; records migrated from a flat Pool retain poolId and also reference the created Organization and default Project
- POST /api/v1/quota-organizations with {tenantId,name,capacity} returns 201 QuotaOrganization; POST /api/v1/quota-organizations/:organizationId/projects with {name,allocation} returns 201 QuotaProject only when each new allocated total remains <= Organization capacity.
- POST /api/v1/quota-organizations/:organizationId/projects/:projectId/reservations with {ownerId,quantities,ttlSeconds} atomically increments Project and Organization held vectors; Project capacity is checked before Organization capacity and either every Dimension changes or none.
- PUT /api/v1/quota-organizations/:organizationId/capacity with {capacity,expectedRevision} and PUT /api/v1/quota-organizations/:organizationId/projects/:projectId/allocation with {allocation,expectedOrganizationRevision,expectedProjectRevision} use compare-and-set and return exact updated totals.
- GET /api/v1/quota-organizations/:organizationId and GET /api/v1/quota-organizations/:organizationId/projects/:projectId return the exact hierarchy shapes used to recompute both conservation levels.
- POST /api/v1/admission-queue accepts either legacy {poolId,ownerId,quantities,priority} or hierarchy {organizationId,projectId,ownerId,quantities,priority}, never both; hierarchy entries compete within one Organization by priority descending, requestedAt ascending, admissionEntryId ascending and only the first entry is considered for promotion.
- Legacy /api/v1/quota-pools/:poolId routes map to the migrated default Project and retain V1 request and response fields.
- 409 PROJECT_QUOTA_EXCEEDED: the complete vector does not fit Project allocation or current available quantities
- 409 ORGANIZATION_QUOTA_EXCEEDED: the vector fits the Project but not Organization available quantities
- 409 QUOTA_HIERARCHY_REVISION_CHANGED: an expected Organization or Project revision is stale
- 409 ORGANIZATION_CAPACITY_CONFLICT: new capacity is below usage or allocated child totals
- 409 PROJECT_ALLOCATION_CONFLICT: new allocation makes child totals exceed Organization capacity or is below Project usage
- The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
- The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
- Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
- Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

FINAL snapshot 与性能兼容断言：

The FINAL verification snapshot 'resources' object has exactly the union of these V1 and Manager resource specifications, with no other keys:

- 'dimensions' uses exact shape 'Dimension = {name:string,unit:string}' and sorts ascending by scalar field-path tuple 'name', then by RFC 8785 canonical JSON as the tie-breaker.
- 'quotaPools' uses exact shape 'QuotaPool' and sorts ascending by scalar field-path tuple 'poolId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'reservations' uses exact shape 'Reservation' and sorts ascending by scalar field-path tuple 'reservationId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'commitments' uses exact shape 'Commitment' and sorts ascending by scalar field-path tuple 'commitmentId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'admissionEntries' uses exact shape 'AdmissionEntry' and sorts ascending by scalar field-path tuple 'admissionEntryId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'quotaOrganizations' uses exact shape 'QuotaOrganization' and sorts ascending by scalar field-path tuple 'organizationId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'quotaProjects' uses exact shape 'QuotaProject' and sorts ascending by scalar field-path tuple 'projectId', then by RFC 8785 canonical JSON as the tie-breaker.

The Manager-added resource specifications are exactly:

- 'quotaOrganizations' uses exact shape 'QuotaOrganization' and sorts ascending by scalar field-path tuple 'organizationId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'quotaProjects' uses exact shape 'QuotaProject' and sorts ascending by scalar field-path tuple 'projectId', then by RFC 8785 canonical JSON as the tie-breaker.

The FINAL Work kind enum is exactly the union 'RESERVATION_EXPIRY', 'ADMISSION_PROMOTION'. The Manager-added
Work kinds are exactly (none). All V1 snapshot point-in-time,
recursive '*Token' omission, sorting, Work state/lease/retention/drain, and Domain Event rules remain
mandatory. The FINAL binary reruns exactly these three V1-compatible scenarios:

- 'quota-pool-read': serve 500 quota reads/s with p95 <= 100 ms; threshold: At least 500 successful reads/s for 60 seconds and p95 <= 100 ms; inconsistent vectors and unexpected 5xx are zero.
- 'hot-pool-reservation-race': process 200 hot-pool Reservation races/s with p95 <= 400 ms; threshold: At least 200 complete attempts/s for 60 seconds and all-response p95 <= 400 ms with exact 80% 201 and 20% expected 409 over each 100 attempts.
- 'expiry-and-admission-recovery': expire 20,000 HELD Reservations and promote 20,000 Admission Entries within 60 s after recovery; threshold: Both 20,000-record backlogs drain in <= 60 seconds after replacement spawn; oversubscription, stale commit, and unexpected failure counts are zero.

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
worker/dispatcher backlog 与排空时间。固定 dataset 为：seedVersion perf-v1 contains exactly 5 dimensions, 1,000 quotaPools, 1,000 commitments, 100,000 reservations, and 20,000 admissionQueue entries; exactly 20,000 HELD Reservations are due and every queued Entry is eligible after their release.。三个场景是：

### Scenario 'quota-pool-read'

- Target: serve 500 quota reads/s with p95 <= 100 ms
- Mode: 'http'
- Method: 'GET'
- Path: '/api/v1/quota-pools/:poolId'
- Setup: Use all 1,000 seeded Quota Pools; reads do not mutate capacity vectors.
- Selector: Round-robin poolId values in bytewise order.
- Request: No body or query parameters.
- Concurrency: 64
- Warm-up seconds: 10
- Measure seconds: 60
- Success: Only 200 QuotaPool responses whose held and committed vectors reconcile with members count.
- Threshold: At least 500 successful reads/s for 60 seconds and p95 <= 100 ms; inconsistent vectors and unexpected 5xx are zero.
- Timer: The throughput window starts with the first measured request after warm-up; each latency sample runs from request dispatch through the complete response body.

### Scenario 'hot-pool-reservation-race'

- Target: process 200 hot-pool Reservation races/s with p95 <= 400 ms
- Mode: 'http'
- Method: 'POST'
- Path: '/api/v1/quota-pools/:poolId/reservations'
- Setup: Before warm-up, create ten measured and ten warm-up Pools through the public API. Each has all five Dimensions; the eight measured spare Pools have capacity 20,000 per Dimension and the other two are saturated.
- Selector: Repeat eight spare-Pool requests then two saturated-Pool requests, round-robin within each subgroup by poolId.
- Request: {ownerId,quantities:{each declared Dimension:1},ttlSeconds:300}; ownerId and key are unique per new request.
- Concurrency: 64
- Warm-up seconds: 10
- Measure seconds: 60
- Success: Spare targets return 201 HELD and saturated targets return exact 409 QUOTA_EXCEEDED; completed-attempt throughput includes both, while only 201 contributes successful reservations.
- Threshold: At least 200 complete attempts/s for 60 seconds and all-response p95 <= 400 ms with exact 80% 201 and 20% expected 409 over each 100 attempts.
- Timer: The throughput window starts with the first measured request after warm-up; each latency sample runs from request dispatch through the complete response body.

### Scenario 'expiry-and-admission-recovery'

- Target: expire 20,000 HELD Reservations and promote 20,000 Admission Entries within 60 s after recovery
- Mode: 'worker'
- Method: 'N/A'
- Path: 'work:RESERVATION_EXPIRY,ADMISSION_PROMOTION'
- Setup: Exactly 20,000 HELD Reservations are due and exactly 20,000 WAITING Admission Entries become eligible after release. Hold two workers at worker.claimed, SIGKILL, wait for lease expiry, then start two replacements.
- Selector: Expire by expiresAt,reservationId and promote each Pool by priority descending,requestedAt,admissionEntryId without bypass.
- Request: No measured client request is issued; setup uses only the published seed and public APIs before the worker timer starts.
- Concurrency: 2
- Warm-up seconds: 0
- Measure seconds: 60
- Success: All 20,000 Reservations become EXPIRED, all 20,000 Entries become PROMOTED, neither Work kind remains nonterminal, and every Dimension conserves capacity.
- Threshold: Both 20,000-record backlogs drain in <= 60 seconds after replacement spawn; oversubscription, stale commit, and unexpected failure counts are zero.
- Timer: Start when both replacements spawn and stop on the first point-in-time snapshot proving all 40,000 terminal transitions and invariants.

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
