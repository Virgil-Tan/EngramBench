# ClinicGrid Harness-owned E2E / Concurrency / Recovery / Performance 方案

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

- Search availability from real Clinician, Room, and Equipment calendars.
- Atomically hold every required resource for a 15-minute-aligned interval with a published expiry.
- Confirm, cancel, or expire an Appointment with exactly one terminal winner and durable replay.
- Promote eligible Waitlist Entries in strict priority, joinedAt, and ID order without skipping the head.
- Expose patient and coordinator calendars, asynchronous expiry/promotion state, and event delivery.

对每个成功状态同时检查响应、查询、历史、异步工作和事件。

### H-04 Atomic rejection and conservation

在每个公开失败边界生成合法但不可满足的请求，断言无 partial aggregate、任务、事件或守恒量
变化。核心断言：

1. No resource has overlapping HELD or CONFIRMED Appointments.
2. An Appointment owns all required resources for its complete interval or owns none.
3. Cancellation or expiry releases each resource exactly once.
4. A Waitlist Entry produces at most one Appointment and the published head blocking order is preserved.
5. The persisted expiresAt instant, not a process-local timer, determines expiry.

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

- Existing Appointments remain standalone with carePlanId null and unchanged replay bodies.
- Historical resource assignments, expiry instants, and event sequences cannot change.
- Each migration statement may hold an access-exclusive lock for at most 2 seconds and availability reads must remain p95 <= 500 ms during migration.

### H-10 Manager core behavior

仅在 T16 已发布后按黑盒方式验证：

- Create a Care Plan containing 2-12 ordered Appointment requests for one patient.
- All visits must be held atomically; if any required resource is unavailable, no Care Plan or Appointment remains.
- Each visit keeps its own resources and expiry. CarePlan.expiresAt is the earliest expiresAt among HELD visits and is null when no visit remains HELD; the Care Plan exposes aggregate HELD, PARTIALLY_CONFIRMED, CONFIRMED, or TERMINATED state.
- Care Plan state is HELD when every visit is HELD, PARTIALLY_CONFIRMED when at least one visit is CONFIRMED and every other visit is HELD, CONFIRMED when every visit is CONFIRMED, and TERMINATED after explicit termination or when any visit becomes CANCELLED or EXPIRED.
- Confirming and cancelling operate per visit. Cancelling or expiring one visit atomically changes the Care Plan to TERMINATED, preserves CONFIRMED visits, cancels every other HELD visit, and releases all affected resources exactly once. Explicit Plan termination has the same preservation and cancellation rule and is legal only from HELD or PARTIALLY_CONFIRMED.
- A multi-visit Waitlist Entry participates as one item in the existing Waitlist order and promotes only when every visit can be held atomically.
- Legacy single Appointment APIs and response bodies remain unchanged.

新增 wire schema 与接口同样属于断言面：

- CarePlan = {carePlanId:uuid,patientId:uuid,state:HELD|PARTIALLY_CONFIRMED|CONFIRMED|TERMINATED,visits:[{visitIndex:int,appointment:Appointment}],expiresAt:timestamp|null,createdAt:timestamp,terminalAt:timestamp|null,sequence:int}
- CarePlanWaitlistEntry = {waitlistEntryId:uuid,patientId:uuid,priority:int,visits:[{visitIndex:int,serviceTypeId:uuid,clinicianId:uuid,earliestStart:timestamp,latestEnd:timestamp}],state:WAITING|PROMOTED|WITHDRAWN,joinedAt:timestamp,carePlanId:uuid|null}; priority uses the V1 0..100 bound and visitIndex values are contiguous from 1
- POST /api/v1/care-plans with {patientId,visits:[{serviceTypeId,clinicianId,startAt}]} returns 201 CarePlan only when all 2..12 visits hold atomically
- GET /api/v1/care-plans/:carePlanId returns CarePlan; POST /api/v1/care-plans/:carePlanId/visits/:visitIndex/confirm with {} confirms one HELD visit under the V1 expiry and error rules
- POST /api/v1/care-plans/:carePlanId/visits/:visitIndex/cancel with {reason} cancels one HELD visit and atomically applies the published Care Plan termination and resource-release rule
- POST /api/v1/care-plans/:carePlanId/terminate with {reason} atomically cancels every HELD visit and returns TERMINATED
- POST /api/v1/waitlist-entries accepts either the legacy single-visit body or {patientId,priority,visits:[{serviceTypeId,clinicianId,earliestStart,latestEnd}]}, never both, requires priority 0..100, and returns 201 CarePlanWaitlistEntry for 2..12 visits. Promotion processes the entry as one queue head, chooses each visit's earliest feasible slot in visitIndex order using V1 resource ordering, and atomically creates and links one CarePlan or creates nothing
- 409 CARE_PLAN_UNAVAILABLE: one or more complete visit resource bundles cannot be held
- 409 CARE_PLAN_NOT_TERMINABLE: Care Plan is CONFIRMED or TERMINATED, or no visit remains HELD
- The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
- The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
- Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
- Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

FINAL snapshot 与性能兼容断言：

The FINAL verification snapshot 'resources' object has exactly the union of these V1 and Manager resource specifications, with no other keys:

- 'clinicians' uses exact shape 'Clinician = {clinicianId:uuid,name:string,priority:int,availability:[{startAt:timestamp,endAt:timestamp}]}' and sorts ascending by scalar field-path tuple 'clinicianId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'rooms' uses exact shape 'Room = {roomId:uuid,name:string,priority:int,availability:[{startAt:timestamp,endAt:timestamp}]}' and sorts ascending by scalar field-path tuple 'roomId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'equipmentUnits' uses exact shape 'EquipmentUnit = {equipmentUnitId:uuid,equipmentType:string,priority:int,availability:[{startAt:timestamp,endAt:timestamp}]}' and sorts ascending by scalar field-path tuple 'equipmentUnitId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'serviceTypes' uses exact shape 'ServiceType' and sorts ascending by scalar field-path tuple 'serviceTypeId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'patients' uses exact shape 'Patient = {patientId:uuid,name:string}' and sorts ascending by scalar field-path tuple 'patientId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'appointments' uses exact shape 'Appointment' and sorts ascending by scalar field-path tuple 'appointmentId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'waitlistEntries' uses exact shape 'WaitlistEntry' and sorts ascending by scalar field-path tuple 'waitlistEntryId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'carePlans' uses exact shape 'CarePlan' and sorts ascending by scalar field-path tuple 'carePlanId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'carePlanWaitlistEntries' uses exact shape 'CarePlanWaitlistEntry' and sorts ascending by scalar field-path tuple 'waitlistEntryId', then by RFC 8785 canonical JSON as the tie-breaker.

The Manager-added resource specifications are exactly:

- 'carePlans' uses exact shape 'CarePlan' and sorts ascending by scalar field-path tuple 'carePlanId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'carePlanWaitlistEntries' uses exact shape 'CarePlanWaitlistEntry' and sorts ascending by scalar field-path tuple 'waitlistEntryId', then by RFC 8785 canonical JSON as the tie-breaker.

The FINAL Work kind enum is exactly the union 'APPOINTMENT_EXPIRY', 'WAITLIST_PROMOTION'. The Manager-added
Work kinds are exactly (none). All V1 snapshot point-in-time,
recursive '*Token' omission, sorting, Work state/lease/retention/drain, and Domain Event rules remain
mandatory. The FINAL binary reruns exactly these three V1-compatible scenarios:

- 'availability-read': 200 availability queries/s with p95 <= 180 ms; threshold: At least 200 successful responses/s for 60 seconds and p95 <= 180 ms; unexpected 5xx = 0.
- 'competing-holds': 30 competing hold requests/s with p95 <= 600 ms; threshold: At least 30 complete attempts/s for 60 seconds, all successful-hold responses have p95 <= 600 ms, and no slot has zero or multiple winners.
- 'expiry-and-promotion-recovery': expire and promote 2,000 due records within 45 s after restart; threshold: Both backlogs drain in <= 45 seconds after replacement workers spawn; unexpected failures = 0.

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
worker/dispatcher backlog 与排空时间。固定 dataset 为：seedVersion perf-v1 contains exactly 2,000 clinicians, 2,000 rooms, 4,000 equipmentUnits, 20 serviceTypes, 100,000 patients, 51,000 appointments, and 1,000 waitlistEntries: 50,000 Appointments are CONFIRMED, exactly 1,000 are HELD with expiry due at measurement start, and exactly 1,000 Waitlist Entries are WAITING and eligible for promotion at measurement start.。三个场景是：

### Scenario 'availability-read'

- Target: 200 availability queries/s with p95 <= 180 ms
- Mode: 'http'
- Method: 'GET'
- Path: '/api/v1/availability?serviceTypeId=:serviceTypeId&clinicianId=:clinicianId&from=:from&to=:to'
- Setup: Select all serviceTypeId,clinicianId pairs with seeded availability; for each pair use its earliest complete UTC day as the half-open query range.
- Selector: Round-robin eligible pairs by serviceTypeId then clinicianId, both bytewise; reads reuse the same immutable ranges.
- Request: No body; from and to are millisecond UTC timestamps exactly 24 hours apart and to is exclusive.
- Concurrency: 64
- Warm-up seconds: 10
- Measure seconds: 60
- Success: Only 200 responses with deterministically ordered AvailabilitySlot items and no overlapping allocation count.
- Threshold: At least 200 successful responses/s for 60 seconds and p95 <= 180 ms; unexpected 5xx = 0.
- Timer: The throughput window starts with the first measured request after warm-up; each latency sample runs from request dispatch through the complete response body.

### Scenario 'competing-holds'

- Target: 30 competing hold requests/s with p95 <= 600 ms
- Mode: 'http'
- Method: 'POST'
- Path: '/api/v1/appointments'
- Setup: Create 30 warm-up and 180 measured feasible hot slots. Assign ten distinct Patient IDs to contend for each slot and never reuse a patient-slot attempt.
- Selector: Visit hot slots round-robin; send their ten contenders concurrently in bytewise patientId order before advancing to the next slot.
- Request: {patientId,serviceTypeId,clinicianId,startAt} for the exact hot slot; every request has a fresh Idempotency-Key.
- Concurrency: 64
- Warm-up seconds: 10
- Measure seconds: 60
- Success: For each slot exactly one 201 HELD is a successful hold and the other nine responses are exactly 409 SLOT_UNAVAILABLE; request-rate latency includes both outcomes.
- Threshold: At least 30 complete attempts/s for 60 seconds, all successful-hold responses have p95 <= 600 ms, and no slot has zero or multiple winners.
- Timer: The throughput window starts with the first measured request after warm-up; each latency sample runs from request dispatch through the complete response body.

### Scenario 'expiry-and-promotion-recovery'

- Target: expire and promote 2,000 due records within 45 s after restart
- Mode: 'worker'
- Method: 'N/A'
- Path: 'work:APPOINTMENT_EXPIRY,WAITLIST_PROMOTION'
- Setup: The seed has exactly 1,000 due HELD Appointments and 1,000 eligible WAITING entries. Hold two workers at worker.claimed, SIGKILL, wait for lease expiry, then start two replacements.
- Selector: Expire by expiresAt,appointmentId and promote by priority descending,joinedAt,waitlistEntryId without bypass.
- Request: No measured client request is issued; setup uses only the published seed and public APIs before the worker timer starts.
- Concurrency: 2
- Warm-up seconds: 0
- Measure seconds: 45
- Success: All 1,000 due Appointments are EXPIRED once, all 1,000 eligible entries are PROMOTED once, no named Work remains nonterminal, and resource calendars remain exclusive.
- Threshold: Both backlogs drain in <= 45 seconds after replacement workers spawn; unexpected failures = 0.
- Timer: Start when both replacements spawn and stop only on a verification snapshot proving both Work kinds drained and all invariants.

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
