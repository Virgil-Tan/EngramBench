【Product Manager · Maya】

V1 已完成并通过基础验收。本期正式增加“linked arrival and departure movements”。以下业务规则、wire schema、接口和错误全部是公开增量合同。

业务规则：

1. A Port Call now contains an ARRIVAL movement and a DEPARTURE movement, each with its own Berth, Tug Pool, and Yard Window allocation.
2. Both movements are created atomically and departure.startAt must be at least 120 minutes after arrival.endAt.
3. Arrival may complete before departure clearance, producing ARRIVED aggregate state.
4. Departure cancellation after arrival keeps the completed arrival immutable and releases only departure resources.
5. Workers may clear different movements concurrently, but each movement starts and completes once.
6. A new Movement has clearanceTaskId null until its first successful confirm transaction. Confirm atomically assigns one stable clearanceTaskId and schedules its Clearance Task; the ID remains populated through later states and confirmation replay preserves it.
7. Each new Movement receives expiresAt equal to the creation transaction time plus 180 seconds and expires only while HELD. Confirm must commit strictly before its expiresAt; start and completion set startedAt and completedAt once.
8. For a new two-movement call, aggregate state is CANCELLED when ARRIVAL is cancelled, COMPLETED only when both movements are COMPLETED, ARRIVED when ARRIVAL is COMPLETED and DEPARTURE is not COMPLETED, EXPIRED when a Movement is EXPIRED before ARRIVAL completes, and HELD otherwise. ARRIVAL expiry cancels any not-started DEPARTURE. DEPARTURE expiry cancels ARRIVAL only if it has not started; an already IN_SERVICE ARRIVAL may complete, after which aggregate state becomes ARRIVED.
9. In Manager responses, the legacy singular arrivalAt, departureAt, requiredTugs, containerUnits, berthId, tugPoolId, yardWindowId, expiresAt, startedAt, and completedAt fields remain populated unchanged for migrated one-movement V1 calls and are null for new two-movement calls; every call exposes movements[].
10. Migrate each V1 Port Call to one ARRIVAL movement whose state is the exact prior Port Call state, including EXPIRED, without changing the aggregate state, singular fields, resource history, or event order.
11. V1 pending Clearance Tasks continue against their migrated movement.
12. Saved idempotency responses for old create/confirm/cancel requests remain byte-equivalent JSON.
13. The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
14. The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
15. Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
16. Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

新增 wire schema：

- PortMovement = {movementId:uuid,portCallId:uuid,type:ARRIVAL|DEPARTURE,berthId:uuid,tugPoolId:uuid,yardWindowId:uuid,startAt:timestamp,endAt:timestamp,requiredTugs:int,containerUnits:int,state:HELD|CLEARED|IN_SERVICE|COMPLETED|CANCELLED|EXPIRED,expiresAt:timestamp,startedAt:timestamp|null,completedAt:timestamp|null,clearanceTaskId:uuid|null,sequence:int}
- PortCall adds movements:[PortMovement]. Its legacy arrivalAt, departureAt, requiredTugs, containerUnits, berthId, tugPoolId, yardWindowId, expiresAt, startedAt, and completedAt fields become required nullable fields under the Manager schema: all are populated for a migrated V1 call and all are null for a new two-movement call

新增或变更接口：

- POST /api/v1/port-calls accepts {vesselId,arrival:{startAt,endAt,requiredTugs,containerUnits},departure:{startAt,endAt,requiredTugs,containerUnits}} and returns an extended PortCall with two movements
- POST /api/v1/port-calls/:portCallId/movements/:movementId/confirm|start-service|complete use {} and return the complete PortMovement; cancel uses {reason}
- GET /api/v1/port-calls/:portCallId returns movements in ARRIVAL then DEPARTURE order. A new two-movement call has aggregate state HELD|ARRIVED|COMPLETED|CANCELLED|EXPIRED under the published aggregate rules; a migrated one-movement call returns its exact V1 aggregate state, including CLEARED, IN_SERVICE, or EXPIRED

新增稳定错误：

- 409 TURNAROUND_GAP_TOO_SHORT: departure.startAt is less than 120 minutes after arrival.endAt
- 409 MOVEMENT_STATE_CONFLICT: movement action is illegal or contradicts the other movement state

FINAL snapshot 与性能兼容合同：

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

本轮先不要实现。请先说明它会影响哪些领域关系、模块、schema、migration、接口、状态、成功与失败数据流、兼容性、Worker、事件、前端、并发、恢复和性能测试，然后给出分阶段修改计划。