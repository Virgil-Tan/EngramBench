# DockChain 项目设计说明

## 1. 定位

DockChain 是一个从近空白 Git fixture 开始的高难度全栈 Coding Benchmark，主流程是
port-call berth and tug window allocation。这是 transfer task；正式 paired curriculum 为 `clinicgrid` learning -> `dockchain` transfer。

本题只用一个主流程承载难度，重点测量：interval allocation、multi-capacity atomicity、lease recovery、priority fairness、compatible linked calls。领域词汇以
[CONTEXT.md](./CONTEXT.md) 为准。

## 2. 可见性

Codex 初始只能看到 'workspace/README.md'、'workspace/AGENTS.md' 和独立 fixture Git 历史。
Manager 变更、Checklist、对话状态机、评测方案和实验 metadata 都在 workspace 外，不能在
开发回合、Session Evolution 或盲审前复制或透露。

## 3. 完整 V1

- Search feasible windows using vessel dimensions, Berth rules, Tug Pool capacity, and Yard Window capacity.
- Hold every required resource atomically for a Port Call and expire unconfirmed holds durably.
- Run recoverable Clearance Tasks before service may start.
- Resolve cancellation, expiry, clearance, and start-service races with one legal outcome.
- Promote Standby Entries by priority, requestedAt, and ID without partial allocation.

核心状态：Port Call: HELD -> CLEARED -> IN_SERVICE -> COMPLETED, or HELD/CLEARED -> CANCELLED/EXPIRED.

### 可计算不变量

1. A Berth serves at most one active Port Call at an instant.
2. Reserved tug and yard capacity never exceeds the interval capacity and never becomes negative.
3. A Port Call holds its complete Berth/tug/yard bundle or no resource.
4. Each Clearance Task succeeds at most once and a Port Call starts service at most once.
5. Standby ordering is deterministic and an infeasible head is not bypassed within its priority class.

## 4. Manager 固定变更

V1、真实 Browser E2E、双 API/双 Worker 并发与恢复完成后，T16 才发布
“linked arrival and departure movements”。它改变核心基数、状态或一致性边界：

- A Port Call now contains an ARRIVAL movement and a DEPARTURE movement, each with its own Berth, Tug Pool, and Yard Window allocation.
- Both movements are created atomically and departure.startAt must be at least 120 minutes after arrival.endAt.
- Arrival may complete before departure clearance, producing ARRIVED aggregate state.
- Departure cancellation after arrival keeps the completed arrival immutable and releases only departure resources.
- Workers may clear different movements concurrently, but each movement starts and completes once.
- A new Movement has clearanceTaskId null until its first successful confirm transaction. Confirm atomically assigns one stable clearanceTaskId and schedules its Clearance Task; the ID remains populated through later states and confirmation replay preserves it.
- Each new Movement receives expiresAt equal to the creation transaction time plus 180 seconds and expires only while HELD. Confirm must commit strictly before its expiresAt; start and completion set startedAt and completedAt once.
- For a new two-movement call, aggregate state is CANCELLED when ARRIVAL is cancelled, COMPLETED only when both movements are COMPLETED, ARRIVED when ARRIVAL is COMPLETED and DEPARTURE is not COMPLETED, EXPIRED when a Movement is EXPIRED before ARRIVAL completes, and HELD otherwise. ARRIVAL expiry cancels any not-started DEPARTURE. DEPARTURE expiry cancels ARRIVAL only if it has not started; an already IN_SERVICE ARRIVAL may complete, after which aggregate state becomes ARRIVED.
- In Manager responses, the legacy singular arrivalAt, departureAt, requiredTugs, containerUnits, berthId, tugPoolId, yardWindowId, expiresAt, startedAt, and completedAt fields remain populated unchanged for migrated one-movement V1 calls and are null for new two-movement calls; every call exposes movements[].

新增 wire schema：

- PortMovement = {movementId:uuid,portCallId:uuid,type:ARRIVAL|DEPARTURE,berthId:uuid,tugPoolId:uuid,yardWindowId:uuid,startAt:timestamp,endAt:timestamp,requiredTugs:int,containerUnits:int,state:HELD|CLEARED|IN_SERVICE|COMPLETED|CANCELLED|EXPIRED,expiresAt:timestamp,startedAt:timestamp|null,completedAt:timestamp|null,clearanceTaskId:uuid|null,sequence:int}
- PortCall adds movements:[PortMovement]. Its legacy arrivalAt, departureAt, requiredTugs, containerUnits, berthId, tugPoolId, yardWindowId, expiresAt, startedAt, and completedAt fields become required nullable fields under the Manager schema: all are populated for a migrated V1 call and all are null for a new two-movement call

新增或变更的公开接口：

- POST /api/v1/port-calls accepts {vesselId,arrival:{startAt,endAt,requiredTugs,containerUnits},departure:{startAt,endAt,requiredTugs,containerUnits}} and returns an extended PortCall with two movements
- POST /api/v1/port-calls/:portCallId/movements/:movementId/confirm|start-service|complete use {} and return the complete PortMovement; cancel uses {reason}
- GET /api/v1/port-calls/:portCallId returns movements in ARRIVAL then DEPARTURE order. A new two-movement call has aggregate state HELD|ARRIVED|COMPLETED|CANCELLED|EXPIRED under the published aggregate rules; a migrated one-movement call returns its exact V1 aggregate state, including CLEARED, IN_SERVICE, or EXPIRED

新增稳定错误：

- 409 TURNAROUND_GAP_TOO_SHORT: departure.startAt is less than 120 minutes after arrival.endAt
- 409 MOVEMENT_STATE_CONFLICT: movement action is illegal or contradicts the other movement state

跨层规则：

- The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
- The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
- Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
- Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

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

迁移必须同时满足：

- Migrate each V1 Port Call to one ARRIVAL movement whose state is the exact prior Port Call state, including EXPIRED, without changing the aggregate state, singular fields, resource history, or event order.
- V1 pending Clearance Tasks continue against their migrated movement.
- Saved idempotency responses for old create/confirm/cancel requests remain byte-equivalent JSON.

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
