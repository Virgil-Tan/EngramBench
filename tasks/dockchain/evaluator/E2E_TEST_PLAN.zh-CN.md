# DockChain Harness-owned E2E / Concurrency / Recovery / Performance 方案

## 1. 边界与等级

本文件位于 candidate workspace 外，只定义 D1 黑盒评测方案。当前没有 runner、中央 score
manifest、gold 或 calibration 证据，不能声称 D3。Evaluator 只使用公开命令、HTTP、浏览器、
webhook receiver、文件下载和进程信号；不得 import 候选源码、ORM、表名或 'dist' 路径。

## 2. 固定环境

- Node.js 22、PostgreSQL 16、Chromium 和 Docker-compatible OCI；容器限制为 4 logical CPUs、
  8 GiB RAM，两个 API、两个 workers、一个 dispatcher 和 PostgreSQL 共享该限制；
- 每个 scenario 使用新数据库、新端口和独立 managed data directory；
- 两个 API、至少两个 Clearance Task workers 和一个 dispatcher 共享同一 PostgreSQL；
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

- Search feasible windows using vessel dimensions, Berth rules, Tug Pool capacity, and Yard Window capacity.
- Hold every required resource atomically for a Port Call and expire unconfirmed holds durably.
- Run recoverable Clearance Tasks before service may start.
- Resolve cancellation, expiry, clearance, and start-service races with one legal outcome.
- Promote Standby Entries by priority, requestedAt, and ID without partial allocation.

对每个成功状态同时检查响应、查询、历史、异步工作和事件。

### H-04 Atomic rejection and conservation

在每个公开失败边界生成合法但不可满足的请求，断言无 partial aggregate、任务、事件或守恒量
变化。核心断言：

1. A Berth serves at most one active Port Call at an instant.
2. Reserved tug and yard capacity never exceeds the interval capacity and never becomes negative.
3. A Port Call holds its complete Berth/tug/yard bundle or no resource.
4. Each Clearance Task succeeds at most once and a Port Call starts service at most once.
5. Standby ordering is deterministic and an infeasible head is not bypassed within its priority class.

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

- Migrate each V1 Port Call to one ARRIVAL movement whose state is the exact prior Port Call state, including EXPIRED, without changing the aggregate state, singular fields, resource history, or event order.
- V1 pending Clearance Tasks continue against their migrated movement.
- Saved idempotency responses for old create/confirm/cancel requests remain byte-equivalent JSON.

### H-10 Manager core behavior

仅在 T16 已发布后按黑盒方式验证：

- A Port Call now contains an ARRIVAL movement and a DEPARTURE movement, each with its own Berth, Tug Pool, and Yard Window allocation.
- Both movements are created atomically and departure.startAt must be at least 120 minutes after arrival.endAt.
- Arrival may complete before departure clearance, producing ARRIVED aggregate state.
- Departure cancellation after arrival keeps the completed arrival immutable and releases only departure resources.
- Workers may clear different movements concurrently, but each movement starts and completes once.
- A new Movement has clearanceTaskId null until its first successful confirm transaction. Confirm atomically assigns one stable clearanceTaskId and schedules its Clearance Task; the ID remains populated through later states and confirmation replay preserves it.
- Each new Movement receives expiresAt equal to the creation transaction time plus 180 seconds and expires only while HELD. Confirm must commit strictly before its expiresAt; start and completion set startedAt and completedAt once.
- For a new two-movement call, aggregate state is CANCELLED when ARRIVAL is cancelled, COMPLETED only when both movements are COMPLETED, ARRIVED when ARRIVAL is COMPLETED and DEPARTURE is not COMPLETED, EXPIRED when a Movement is EXPIRED before ARRIVAL completes, and HELD otherwise. ARRIVAL expiry cancels any not-started DEPARTURE. DEPARTURE expiry cancels ARRIVAL only if it has not started; an already IN_SERVICE ARRIVAL may complete, after which aggregate state becomes ARRIVED.
- In Manager responses, the legacy singular arrivalAt, departureAt, requiredTugs, containerUnits, berthId, tugPoolId, yardWindowId, expiresAt, startedAt, and completedAt fields remain populated unchanged for migrated one-movement V1 calls and are null for new two-movement calls; every call exposes movements[].

新增 wire schema 与接口同样属于断言面：

- PortMovement = {movementId:uuid,portCallId:uuid,type:ARRIVAL|DEPARTURE,berthId:uuid,tugPoolId:uuid,yardWindowId:uuid,startAt:timestamp,endAt:timestamp,requiredTugs:int,containerUnits:int,state:HELD|CLEARED|IN_SERVICE|COMPLETED|CANCELLED|EXPIRED,expiresAt:timestamp,startedAt:timestamp|null,completedAt:timestamp|null,clearanceTaskId:uuid|null,sequence:int}
- PortCall adds movements:[PortMovement]. Its legacy arrivalAt, departureAt, requiredTugs, containerUnits, berthId, tugPoolId, yardWindowId, expiresAt, startedAt, and completedAt fields become required nullable fields under the Manager schema: all are populated for a migrated V1 call and all are null for a new two-movement call
- POST /api/v1/port-calls accepts {vesselId,arrival:{startAt,endAt,requiredTugs,containerUnits},departure:{startAt,endAt,requiredTugs,containerUnits}} and returns an extended PortCall with two movements
- POST /api/v1/port-calls/:portCallId/movements/:movementId/confirm|start-service|complete use {} and return the complete PortMovement; cancel uses {reason}
- GET /api/v1/port-calls/:portCallId returns movements in ARRIVAL then DEPARTURE order. A new two-movement call has aggregate state HELD|ARRIVED|COMPLETED|CANCELLED|EXPIRED under the published aggregate rules; a migrated one-movement call returns its exact V1 aggregate state, including CLEARED, IN_SERVICE, or EXPIRED
- 409 TURNAROUND_GAP_TOO_SHORT: departure.startAt is less than 120 minutes after arrival.endAt
- 409 MOVEMENT_STATE_CONFLICT: movement action is illegal or contradicts the other movement state
- The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
- The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
- Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
- Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

FINAL snapshot 与性能兼容断言：

The FINAL verification snapshot 'resources' object has exactly the union of these V1 and Manager resource specifications, with no other keys:

- 'berths' uses exact shape 'Berth = {berthId:uuid,name:string,priority:int,maxLengthMeters:int,availability:[{startAt:timestamp,endAt:timestamp}]}' and sorts ascending by scalar field-path tuple 'berthId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'tugPools' uses exact shape 'TugPool = {tugPoolId:uuid,name:string,priority:int,capacity:int,availability:[{startAt:timestamp,endAt:timestamp}]}' and sorts ascending by scalar field-path tuple 'tugPoolId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'yardWindows' uses exact shape 'YardWindow = {yardWindowId:uuid,priority:int,capacityUnits:int,startAt:timestamp,endAt:timestamp}' and sorts ascending by scalar field-path tuple 'yardWindowId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'vessels' uses exact shape 'Vessel = {vesselId:uuid,name:string,lengthMeters:int}' and sorts ascending by scalar field-path tuple 'vesselId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'portCalls' uses exact shape 'PortCall' and sorts ascending by scalar field-path tuple 'portCallId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'resourceAllocations' uses exact shape 'ResourceAllocation' and sorts ascending by scalar field-path tuple 'resourceType', 'resourceId', 'startAt', 'endAt', then by RFC 8785 canonical JSON as the tie-breaker.
- 'standbyEntries' uses exact shape 'StandbyEntry' and sorts ascending by scalar field-path tuple 'standbyEntryId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'clearances' uses exact shape 'Clearance' and sorts ascending by scalar field-path tuple 'portCallId', 'taskId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'portMovements' uses exact shape 'PortMovement' and sorts ascending by scalar field-path tuple 'portCallId', 'movementId', then by RFC 8785 canonical JSON as the tie-breaker.

The Manager-added resource specifications are exactly:

- 'portMovements' uses exact shape 'PortMovement' and sorts ascending by scalar field-path tuple 'portCallId', 'movementId', then by RFC 8785 canonical JSON as the tie-breaker.

The FINAL Work kind enum is exactly the union 'PORT_CALL_EXPIRY', 'CLEARANCE', 'STANDBY_PROMOTION'. The Manager-added
Work kinds are exactly (none). All V1 snapshot point-in-time,
recursive '*Token' omission, sorting, Work state/lease/retention/drain, and Domain Event rules remain
mandatory. The FINAL binary reruns exactly these three V1-compatible scenarios:

- 'feasible-window-read': 120 feasible-window queries/s with p95 <= 220 ms; threshold: At least 120 successful responses/s for 60 seconds and p95 <= 220 ms; unexpected 5xx = 0.
- 'port-call-create': 25 atomic Port Call creations/s with p95 <= 700 ms; threshold: At least 25 successful creations/s for 60 seconds and p95 <= 700 ms; no capacity oversubscription or unexpected 5xx.
- 'clearance-recovery': recover and clear 1,500 tasks within 60 s; threshold: The recovery backlog drains in <= 60 seconds with unexpected worker failures = 0.

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
worker/dispatcher backlog 与排空时间。固定 dataset 为：seedVersion perf-v1 contains exactly 1,000 berths, 20 tugPools, 20 yardWindows, 100,000 vessels, and 51,500 portCalls: 50,000 COMPLETED historical calls plus 1,500 HELD calls with pending Clearance Tasks.。三个场景是：

### Scenario 'feasible-window-read'

- Target: 120 feasible-window queries/s with p95 <= 220 ms
- Mode: 'http'
- Method: 'GET'
- Path: '/api/v1/port-resources/feasible-windows?vesselId=:vesselId&arrivalFrom=:arrivalFrom&arrivalTo=:arrivalTo&durationMinutes=120&requiredTugs=1&containerUnits=1'
- Setup: Select seeded vessels with at least one feasible two-hour window; use each vessel's earliest complete seven-day availability range.
- Selector: Round-robin vesselId bytewise; ranges are immutable during this read-only scenario.
- Request: No body; arrivalFrom/arrivalTo are exact UTC millisecond timestamps seven days apart.
- Concurrency: 64
- Warm-up seconds: 10
- Measure seconds: 60
- Success: Only 200 responses with windows in the published candidate and resource order count.
- Threshold: At least 120 successful responses/s for 60 seconds and p95 <= 220 ms; unexpected 5xx = 0.
- Timer: The throughput window starts with the first measured request after warm-up; each latency sample runs from request dispatch through the complete response body.

### Scenario 'port-call-create'

- Target: 25 atomic Port Call creations/s with p95 <= 700 ms
- Mode: 'http'
- Method: 'POST'
- Path: '/api/v1/port-calls'
- Setup: Reserve disjoint warm-up and measured sets of feasible vessel/time bundles so no request intentionally conflicts.
- Selector: Use vesselId bytewise and the earliest remaining feasible 120-minute window; requiredTugs and containerUnits are both 1.
- Request: {vesselId,arrivalAt,departureAt,requiredTugs:1,containerUnits:1}; every request has a fresh Idempotency-Key.
- Concurrency: 64
- Warm-up seconds: 10
- Measure seconds: 60
- Success: Only 201 HELD responses count; 409 outcomes do not count, and each response must expose the canonical resource bundle.
- Threshold: At least 25 successful creations/s for 60 seconds and p95 <= 700 ms; no capacity oversubscription or unexpected 5xx.
- Timer: The throughput window starts with the first measured request after warm-up; each latency sample runs from request dispatch through the complete response body.

### Scenario 'clearance-recovery'

- Target: recover and clear 1,500 tasks within 60 s
- Mode: 'worker'
- Method: 'N/A'
- Path: 'work:CLEARANCE'
- Setup: Exactly 1,500 HELD Port Calls have a pending Clearance Work. Hold two workers at worker.claimed, SIGKILL, wait for lease expiry, then start two replacements.
- Selector: Claim by Port Call creation order and portCallId; validate only the captured immutable vessel/resource snapshot.
- Request: No measured client request is issued; setup uses only the published seed and public APIs before the worker timer starts.
- Concurrency: 2
- Warm-up seconds: 0
- Measure seconds: 60
- Success: All 1,500 Calls become CLEARED exactly once, no CLEARANCE Work remains nonterminal, stale workers cannot commit, and every capacity invariant holds.
- Threshold: The recovery backlog drains in <= 60 seconds with unexpected worker failures = 0.
- Timer: Start when both replacement workers spawn and stop at the first point-in-time snapshot proving every postcondition.

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
