# ClinicGrid 项目设计说明

## 1. 定位

ClinicGrid 是一个从近空白 Git fixture 开始的高难度全栈 Coding Benchmark，主流程是
multi-resource clinical appointment holds。这是 learning task，用于形成可迁移的工程经验。

本题只用一个主流程承载难度，重点测量：temporal exclusion、multi-resource atomicity、expiry recovery、waitlist fairness、calendar performance。领域词汇以
[CONTEXT.md](./CONTEXT.md) 为准。

## 2. 可见性

Codex 初始只能看到 'workspace/README.md'、'workspace/AGENTS.md' 和独立 fixture Git 历史。
Manager 变更、Checklist、对话状态机、评测方案和实验 metadata 都在 workspace 外，不能在
开发回合、Session Evolution 或盲审前复制或透露。

## 3. 完整 V1

- Search availability from real Clinician, Room, and Equipment calendars.
- Atomically hold every required resource for a 15-minute-aligned interval with a published expiry.
- Confirm, cancel, or expire an Appointment with exactly one terminal winner and durable replay.
- Promote eligible Waitlist Entries in strict priority, joinedAt, and ID order without skipping the head.
- Expose patient and coordinator calendars, asynchronous expiry/promotion state, and event delivery.

核心状态：Appointment: HELD -> CONFIRMED | CANCELLED | EXPIRED; terminal transitions are mutually exclusive.

### 可计算不变量

1. No resource has overlapping HELD or CONFIRMED Appointments.
2. An Appointment owns all required resources for its complete interval or owns none.
3. Cancellation or expiry releases each resource exactly once.
4. A Waitlist Entry produces at most one Appointment and the published head blocking order is preserved.
5. The persisted expiresAt instant, not a process-local timer, determines expiry.

## 4. Manager 固定变更

V1、真实 Browser E2E、双 API/双 Worker 并发与恢复完成后，T16 才发布
“atomic multi-visit care plans”。它改变核心基数、状态或一致性边界：

- Create a Care Plan containing 2-12 ordered Appointment requests for one patient.
- All visits must be held atomically; if any required resource is unavailable, no Care Plan or Appointment remains.
- Each visit keeps its own resources and expiry. CarePlan.expiresAt is the earliest expiresAt among HELD visits and is null when no visit remains HELD; the Care Plan exposes aggregate HELD, PARTIALLY_CONFIRMED, CONFIRMED, or TERMINATED state.
- Care Plan state is HELD when every visit is HELD, PARTIALLY_CONFIRMED when at least one visit is CONFIRMED and every other visit is HELD, CONFIRMED when every visit is CONFIRMED, and TERMINATED after explicit termination or when any visit becomes CANCELLED or EXPIRED.
- Confirming and cancelling operate per visit. Cancelling or expiring one visit atomically changes the Care Plan to TERMINATED, preserves CONFIRMED visits, cancels every other HELD visit, and releases all affected resources exactly once. Explicit Plan termination has the same preservation and cancellation rule and is legal only from HELD or PARTIALLY_CONFIRMED.
- A multi-visit Waitlist Entry participates as one item in the existing Waitlist order and promotes only when every visit can be held atomically.
- Legacy single Appointment APIs and response bodies remain unchanged.

新增 wire schema：

- CarePlan = {carePlanId:uuid,patientId:uuid,state:HELD|PARTIALLY_CONFIRMED|CONFIRMED|TERMINATED,visits:[{visitIndex:int,appointment:Appointment}],expiresAt:timestamp|null,createdAt:timestamp,terminalAt:timestamp|null,sequence:int}
- CarePlanWaitlistEntry = {waitlistEntryId:uuid,patientId:uuid,priority:int,visits:[{visitIndex:int,serviceTypeId:uuid,clinicianId:uuid,earliestStart:timestamp,latestEnd:timestamp}],state:WAITING|PROMOTED|WITHDRAWN,joinedAt:timestamp,carePlanId:uuid|null}; priority uses the V1 0..100 bound and visitIndex values are contiguous from 1

新增或变更的公开接口：

- POST /api/v1/care-plans with {patientId,visits:[{serviceTypeId,clinicianId,startAt}]} returns 201 CarePlan only when all 2..12 visits hold atomically
- GET /api/v1/care-plans/:carePlanId returns CarePlan; POST /api/v1/care-plans/:carePlanId/visits/:visitIndex/confirm with {} confirms one HELD visit under the V1 expiry and error rules
- POST /api/v1/care-plans/:carePlanId/visits/:visitIndex/cancel with {reason} cancels one HELD visit and atomically applies the published Care Plan termination and resource-release rule
- POST /api/v1/care-plans/:carePlanId/terminate with {reason} atomically cancels every HELD visit and returns TERMINATED
- POST /api/v1/waitlist-entries accepts either the legacy single-visit body or {patientId,priority,visits:[{serviceTypeId,clinicianId,earliestStart,latestEnd}]}, never both, requires priority 0..100, and returns 201 CarePlanWaitlistEntry for 2..12 visits. Promotion processes the entry as one queue head, chooses each visit's earliest feasible slot in visitIndex order using V1 resource ordering, and atomically creates and links one CarePlan or creates nothing

新增稳定错误：

- 409 CARE_PLAN_UNAVAILABLE: one or more complete visit resource bundles cannot be held
- 409 CARE_PLAN_NOT_TERMINABLE: Care Plan is CONFIRMED or TERMINATED, or no visit remains HELD

跨层规则：

- The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
- The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
- Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
- Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

FINAL snapshot 与性能兼容合同：

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

迁移必须同时满足：

- Existing Appointments remain standalone with carePlanId null and unchanged replay bodies.
- Historical resource assignments, expiry instants, and event sequences cannot change.
- Each migration statement may hold an access-exclusive lock for at most 2 seconds and availability reads must remain p95 <= 500 ms during migration.

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
