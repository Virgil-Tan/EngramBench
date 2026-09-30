# DispatchBoard Harness-owned E2E / Concurrency / Recovery / Performance 方案

## 1. 边界与等级

本文件位于 candidate workspace 外，只定义 D1 黑盒评测方案。当前没有 runner、中央 score
manifest、gold 或 calibration 证据，不能声称 D3。Evaluator 只使用公开命令、HTTP、浏览器、
webhook receiver、文件下载和进程信号；不得 import 候选源码、ORM、表名或 'dist' 路径。

## 2. 固定环境

- Node.js 22、PostgreSQL 16、Chromium 和 Docker-compatible OCI；容器限制为 4 logical CPUs、
  8 GiB RAM，两个 API、两个 workers、一个 dispatcher 和 PostgreSQL 共享该限制；
- 每个 scenario 使用新数据库、新端口和独立 managed data directory；
- 两个 API、至少两个 Offer Task workers 和一个 dispatcher 共享同一 PostgreSQL；
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

- Create Delivery requests and rank eligible Couriers by published distance bucket, capacity, and ID.
- Issue deterministic Offer Rounds with persisted expiry and at-least-once notifications.
- Accept the first legal Offer claim atomically and expire all competitors without double assignment.
- Handle cancellation, pickup, delivery, Offer expiry, and worker death with one legal state sequence.
- Expose customer tracking and dispatcher offer/assignment histories through real UI flows.

对每个成功状态同时检查响应、查询、历史、异步工作和事件。

### H-04 Atomic rejection and conservation

在每个公开失败边界生成合法但不可满足的请求，断言无 partial aggregate、任务、事件或守恒量
变化。核心断言：

1. A Delivery has at most one active Assignment and one successful pickup in V1.
2. An Offer can be accepted only before its persisted expiresAt and only once.
3. A Courier's active assigned load never exceeds published capacity.
4. A cancelled Delivery cannot later be picked up or delivered.
5. Repeated or concurrent Offer Tasks cannot create duplicate rounds or notifications with new identities.

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

- Migrate each V1 Assignment to one DRIVER role without changing state, capacity, notifications, events, or replay bodies.
- Pending Offer Tasks and active Offers retain their deadlines and stable IDs.
- Existing picked-up Deliveries complete under V1 semantics.

### H-10 Manager core behavior

仅在 T16 已发布后按黑盒方式验证：

- A heavy Delivery requires 2-4 named roles with one distinct Courier assigned per role.
- One Offer Round may collect role claims independently, but the Assignment becomes active only when every role is filled.
- A Courier may claim only one role; simultaneous final claims create exactly one team activation.
- Before pickup, an expired role claim is released and only that role is re-offered; other valid claims remain reserved.
- Pickup requires every assigned Courier to acknowledge readiness; completion remains one terminal operation.
- Legacy ordinary Deliveries retain singular courier and assignment fields; team Deliveries return null there and expose assignments[].
- requiredRoles preserve request order. In a delivery-wide round, each unfilled role independently receives up to five Offers under the V1 Courier ranking; one Courier may receive Offers for multiple roles, but accepting one role atomically loses that Courier's other open Offers for the Delivery.

新增 wire schema 与接口同样属于断言面：

- TeamOffer = {offerId:uuid,deliveryId:uuid,round:int,roleIndex:int,role:string,courierId:uuid,rank:int,state:OPEN|ACCEPTED|LOST|EXPIRED,createdAt:timestamp,expiresAt:timestamp,notificationId:uuid}; roleIndex is the zero-based requiredRoles position and responses sort by round, roleIndex, rank, offerId
- RoleAssignment = {assignmentId:uuid,deliveryId:uuid,role:string,courierId:uuid,offerId:uuid,state:RESERVED|READY|RELEASED|PICKED_UP|COMPLETED,claimedAt:timestamp,claimExpiresAt:timestamp,readyAt:timestamp|null,releasedAt:timestamp|null}
- TeamAssignment = {teamAssignmentId:uuid,deliveryId:uuid,state:FORMING|ACTIVE|READY|PICKED_UP|COMPLETED|CANCELLED,requiredRoles:[string],assignments:[RoleAssignment],activatedAt:timestamp|null,pickedUpAt:timestamp|null,completedAt:timestamp|null,revision:int}
- For a Manager-created team Delivery, Delivery adds requiredRoles:[string],teamAssignmentId:uuid|null,assignments:[RoleAssignment], and its V1 assignmentId is null. requiredRoles preserves request order, assignments sorts by that role order, and an ordinary Delivery retains the exact V1 Delivery shape without these Manager-only fields
- POST /api/v1/deliveries accepts the V1 body plus optional roles:[string]; omission creates an ordinary Delivery, while a team Delivery requires 2..4 non-empty role names unique by exact string.
- POST /api/v1/offers/:offerId/accept with {courierId} reserves that TeamOffer role and Courier load until claimExpiresAt=claimedAt+120 seconds; the Courier must be distinct from every other live role claimant, and the final required claim atomically activates one TeamAssignment.
- POST /api/v1/deliveries/:deliveryId/assignments/:assignmentId/ready with {courierId} records one readiness acknowledgement; the TeamAssignment becomes READY only after every live RoleAssignment is READY.
- POST /api/v1/deliveries/:deliveryId/pickup with {courierId} succeeds once only when courierId names one live READY RoleAssignment and every required role has a live READY assignment; the Offer Task releases an expired pre-pickup role, restores Courier load, increments Delivery.currentRound, and creates up to five next-round Offers only for that role.
- POST /api/v1/deliveries/:deliveryId/complete keeps {courierId,proofCode}; for a team Delivery courierId must name any live RoleAssignment, TeamAssignment must be PICKED_UP, and the one winning request atomically marks the Delivery, TeamAssignment, and every RoleAssignment completed and releases every Courier load exactly once.
- POST /api/v1/deliveries/:deliveryId/cancel keeps {reason}; before pickup it atomically cancels the TeamAssignment, releases every live RoleAssignment and Courier load, and supersedes every pending team OfferNotification.
- For TeamOffers, OfferNotification.body populates roleIndex and role from the exact requiredRoles position; retry identity, captured deliveryUrl, body, and deadline semantics remain the V1 notification contract.
- GET /api/v1/deliveries/:deliveryId returns requiredRoles, teamAssignmentId, and assignments[] for a team Delivery while assignmentId is null; ordinary Deliveries retain the exact V1 singular response.
- 400 INVALID_TEAM_ROLES: roles has fewer than 2 or more than 4 entries, an empty name, or a duplicate exact name
- 409 TEAM_ROLE_ALREADY_FILLED: the accepted Offer targets a role with another live RoleAssignment
- 409 COURIER_TEAM_ROLE_CONFLICT: the Courier already holds another live role on the Delivery
- 409 TEAM_ROLE_CLAIM_EXPIRED: database time is at or after claimExpiresAt for readiness or pickup
- 409 TEAM_NOT_READY: pickup is requested before every required role has a live READY assignment
- 409 TEAM_COURIER_NOT_ASSIGNED: pickup or completion courierId does not name a live RoleAssignment for the Delivery
- The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
- The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
- Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
- Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

FINAL snapshot 与性能兼容断言：

The FINAL verification snapshot 'resources' object has exactly the union of these V1 and Manager resource specifications, with no other keys:

- 'zones' uses exact shape 'Zone = {zoneId:string,name:string}' and sorts ascending by scalar field-path tuple 'zoneId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'zoneDistances' uses exact shape 'ZoneDistance = {fromZone:string,toZone:string,distanceBucket:int}' and sorts ascending by scalar field-path tuple 'fromZone', 'toZone', then by RFC 8785 canonical JSON as the tie-breaker.
- 'couriers' uses exact shape 'Courier' and sorts ascending by scalar field-path tuple 'courierId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'customers' uses exact shape 'Customer = {customerId:uuid,name:string}' and sorts ascending by scalar field-path tuple 'customerId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'deliveries' uses exact shape 'Delivery' and sorts ascending by scalar field-path tuple 'deliveryId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'offers' uses exact shape 'Offer' and sorts ascending by scalar field-path tuple 'deliveryId', 'round', 'rank', 'offerId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'offerNotifications' uses exact shape 'OfferNotification' and sorts ascending by scalar field-path tuple 'offerId', 'notificationId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'assignments' uses exact shape 'Assignment' and sorts ascending by scalar field-path tuple 'assignmentId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'teamOffers' uses exact shape 'TeamOffer' and sorts ascending by scalar field-path tuple 'deliveryId', 'round', 'roleIndex', 'rank', 'offerId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'teamAssignments' uses exact shape 'TeamAssignment' and sorts ascending by scalar field-path tuple 'teamAssignmentId', then by RFC 8785 canonical JSON as the tie-breaker.

The Manager-added resource specifications are exactly:

- 'teamOffers' uses exact shape 'TeamOffer' and sorts ascending by scalar field-path tuple 'deliveryId', 'round', 'roleIndex', 'rank', 'offerId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'teamAssignments' uses exact shape 'TeamAssignment' and sorts ascending by scalar field-path tuple 'teamAssignmentId', then by RFC 8785 canonical JSON as the tie-breaker.

The FINAL Work kind enum is exactly the union 'OFFER_ISSUANCE', 'OFFER_EXPIRY'. The Manager-added
Work kinds are exactly (none). All V1 snapshot point-in-time,
recursive '*Token' omission, sorting, Work state/lease/retention/drain, and Domain Event rules remain
mandatory. The FINAL binary reruns exactly these three V1-compatible scenarios:

- 'delivery-create': create 100 Deliveries/s with p95 <= 300 ms; threshold: At least 100 successful creations/s for 60 seconds and p95 <= 300 ms; unexpected 5xx = 0.
- 'hot-offer-claims': process 1,000 competing Offer claims across 200 hot Deliveries within 5 s with p95 <= 350 ms; threshold: All 1,000 claims finish in <= 5 seconds and all-response p95 <= 350 ms; exactly 200 winners, no double load, unexpected 5xx = 0.
- 'offer-expiry-recovery': recover and settle 5,000 due Offers within 60 s; threshold: All 5,000 due Offers settle in <= 60 seconds after replacement spawn; stale commits and unexpected failures are zero.

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
worker/dispatcher backlog 与排空时间。固定 dataset 为：seedVersion perf-v1 contains exactly 100 zones, 10,000 zoneDistances, 10,000 couriers, 100,000 customers, 5,200 deliveries, 30,000 offers, and zero assignments; exactly 1,000 OPEN Offers are distributed across 200 hot Deliveries with at most five per Delivery, and exactly 5,000 other Offers are due.。三个场景是：

### Scenario 'delivery-create'

- Target: create 100 Deliveries/s with p95 <= 300 ms
- Mode: 'http'
- Method: 'POST'
- Path: '/api/v1/deliveries'
- Setup: Prepare disjoint warm-up and measured Customer IDs and valid Zone pairs; readyAt is setup time plus 10 minutes and deliverBy is readyAt plus 60 minutes.
- Selector: Round-robin customerId and complete Zone pairs bytewise; loadUnits is 1.
- Request: {customerId,pickupZone,dropoffZone,readyAt,deliverBy,loadUnits:1} with a fresh Idempotency-Key.
- Concurrency: 64
- Warm-up seconds: 10
- Measure seconds: 60
- Success: Only 202 REQUESTED responses that schedule exactly one initial OFFER_ISSUANCE Work count.
- Threshold: At least 100 successful creations/s for 60 seconds and p95 <= 300 ms; unexpected 5xx = 0.
- Timer: The throughput window starts with the first measured request after warm-up; each latency sample runs from request dispatch through the complete response body.

### Scenario 'hot-offer-claims'

- Target: process 1,000 competing Offer claims across 200 hot Deliveries within 5 s with p95 <= 350 ms
- Mode: 'http'
- Method: 'POST'
- Path: '/api/v1/offers/:offerId/accept'
- Setup: Use exactly 200 hot Deliveries with five OPEN Offers each. All 1,000 Offers are before expiresAt and deliverBy when timing begins; historical Offers are not selected.
- Selector: Submit every Offer once in deliveryId,round,rank,offerId order with its own courierId; clients may race offers for the same Delivery.
- Request: {courierId} with one fresh Idempotency-Key per Offer.
- Concurrency: 64
- Warm-up seconds: 0
- Measure seconds: 5
- Success: Exactly one claim per Delivery returns the successful Assignment result; every later claim returns exact 409 OFFER_LOST. Completed-attempt throughput includes both published outcomes.
- Threshold: All 1,000 claims finish in <= 5 seconds and all-response p95 <= 350 ms; exactly 200 winners, no double load, unexpected 5xx = 0.
- Timer: The throughput window starts with the first measured request after warm-up; each latency sample runs from request dispatch through the complete response body.

### Scenario 'offer-expiry-recovery'

- Target: recover and settle 5,000 due Offers within 60 s
- Mode: 'worker'
- Method: 'N/A'
- Path: 'work:OFFER_EXPIRY,OFFER_ISSUANCE'
- Setup: Exactly 5,000 Offers are due. Hold two workers at worker.claimed, SIGKILL, wait for lease expiry, then start two replacements.
- Selector: Expire by expiresAt,deliveryId,round,rank and issue any legal next round deterministically.
- Request: No measured client request is issued; setup uses only the published seed and public APIs before the worker timer starts.
- Concurrency: 2
- Warm-up seconds: 0
- Measure seconds: 60
- Success: Every due Offer is terminal once, each affected Delivery has one coherent winner or next round, Courier loads reconcile, and neither Work kind remains nonterminal.
- Threshold: All 5,000 due Offers settle in <= 60 seconds after replacement spawn; stale commits and unexpected failures are zero.
- Timer: Start when both replacements spawn and stop on a snapshot proving all due Offers settled and every load invariant.

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
