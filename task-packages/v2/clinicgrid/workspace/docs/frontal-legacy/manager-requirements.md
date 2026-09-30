【Product Manager · Maya】

V1 已完成并通过基础验收。本期正式增加“atomic multi-visit care plans”。以下业务规则、wire schema、接口和错误全部是公开增量合同。

业务规则：

1. Create a Care Plan containing 2-12 ordered Appointment requests for one patient.
2. All visits must be held atomically; if any required resource is unavailable, no Care Plan or Appointment remains.
3. Each visit keeps its own resources and expiry. CarePlan.expiresAt is the earliest expiresAt among HELD visits and is null when no visit remains HELD; the Care Plan exposes aggregate HELD, PARTIALLY_CONFIRMED, CONFIRMED, or TERMINATED state.
4. Care Plan state is HELD when every visit is HELD, PARTIALLY_CONFIRMED when at least one visit is CONFIRMED and every other visit is HELD, CONFIRMED when every visit is CONFIRMED, and TERMINATED after explicit termination or when any visit becomes CANCELLED or EXPIRED.
5. Confirming and cancelling operate per visit. Cancelling or expiring one visit atomically changes the Care Plan to TERMINATED, preserves CONFIRMED visits, cancels every other HELD visit, and releases all affected resources exactly once. Explicit Plan termination has the same preservation and cancellation rule and is legal only from HELD or PARTIALLY_CONFIRMED.
6. A multi-visit Waitlist Entry participates as one item in the existing Waitlist order and promotes only when every visit can be held atomically.
7. Legacy single Appointment APIs and response bodies remain unchanged.
8. Existing Appointments remain standalone with carePlanId null and unchanged replay bodies.
9. Historical resource assignments, expiry instants, and event sequences cannot change.
10. Each migration statement may hold an access-exclusive lock for at most 2 seconds and availability reads must remain p95 <= 500 ms during migration.
11. The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
12. The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
13. Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
14. Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

新增 wire schema：

- CarePlan = {carePlanId:uuid,patientId:uuid,state:HELD|PARTIALLY_CONFIRMED|CONFIRMED|TERMINATED,visits:[{visitIndex:int,appointment:Appointment}],expiresAt:timestamp|null,createdAt:timestamp,terminalAt:timestamp|null,sequence:int}
- CarePlanWaitlistEntry = {waitlistEntryId:uuid,patientId:uuid,priority:int,visits:[{visitIndex:int,serviceTypeId:uuid,clinicianId:uuid,earliestStart:timestamp,latestEnd:timestamp}],state:WAITING|PROMOTED|WITHDRAWN,joinedAt:timestamp,carePlanId:uuid|null}; priority uses the V1 0..100 bound and visitIndex values are contiguous from 1

新增或变更接口：

- POST /api/v1/care-plans with {patientId,visits:[{serviceTypeId,clinicianId,startAt}]} returns 201 CarePlan only when all 2..12 visits hold atomically
- GET /api/v1/care-plans/:carePlanId returns CarePlan; POST /api/v1/care-plans/:carePlanId/visits/:visitIndex/confirm with {} confirms one HELD visit under the V1 expiry and error rules
- POST /api/v1/care-plans/:carePlanId/visits/:visitIndex/cancel with {reason} cancels one HELD visit and atomically applies the published Care Plan termination and resource-release rule
- POST /api/v1/care-plans/:carePlanId/terminate with {reason} atomically cancels every HELD visit and returns TERMINATED
- POST /api/v1/waitlist-entries accepts either the legacy single-visit body or {patientId,priority,visits:[{serviceTypeId,clinicianId,earliestStart,latestEnd}]}, never both, requires priority 0..100, and returns 201 CarePlanWaitlistEntry for 2..12 visits. Promotion processes the entry as one queue head, chooses each visit's earliest feasible slot in visitIndex order using V1 resource ordering, and atomically creates and links one CarePlan or creates nothing

新增稳定错误：

- 409 CARE_PLAN_UNAVAILABLE: one or more complete visit resource bundles cannot be held
- 409 CARE_PLAN_NOT_TERMINABLE: Care Plan is CONFIRMED or TERMINATED, or no visit remains HELD

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

本轮先不要实现。请先说明它会影响哪些领域关系、模块、schema、migration、接口、状态、成功与失败数据流、兼容性、Worker、事件、前端、并发、恢复和性能测试，然后给出分阶段修改计划。