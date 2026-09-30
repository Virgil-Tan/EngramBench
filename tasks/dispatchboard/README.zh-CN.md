# DispatchBoard 项目设计说明

## 1. 定位

DispatchBoard 是一个从近空白 Git fixture 开始的高难度全栈 Coding Benchmark，主流程是
competitive courier offer assignment and delivery completion。这是 Learning task；它的 Trajectory 与隐藏测试结果用于 Skill Evolution，不属于 13 个 Transfer/Test task。

本题只用一个主流程承载难度，重点测量：single-winner claiming、offer expiry、assignment recovery、terminal races、team migration。领域词汇以
[CONTEXT.md](./CONTEXT.md) 为准。

## 2. 可见性

Codex 初始只能看到 'workspace/README.md'、'workspace/AGENTS.md' 和独立 fixture Git 历史。
Manager 变更、Checklist、对话状态机、评测方案和实验 metadata 都在 workspace 外，不能在
开发回合、Session Evolution 或盲审前复制或透露。

## 3. 完整 V1

- Create Delivery requests and rank eligible Couriers by published distance bucket, capacity, and ID.
- Issue deterministic Offer Rounds with persisted expiry and at-least-once notifications.
- Accept the first legal Offer claim atomically and expire all competitors without double assignment.
- Handle cancellation, pickup, delivery, Offer expiry, and worker death with one legal state sequence.
- Expose customer tracking and dispatcher offer/assignment histories through real UI flows.

核心状态：Delivery: REQUESTED -> OFFERING -> ASSIGNED -> PICKED_UP -> DELIVERED, or pre-pickup -> CANCELLED/EXPIRED.

### 可计算不变量

1. A Delivery has at most one active Assignment and one successful pickup in V1.
2. An Offer can be accepted only before its persisted expiresAt and only once.
3. A Courier's active assigned load never exceeds published capacity.
4. A cancelled Delivery cannot later be picked up or delivered.
5. Repeated or concurrent Offer Tasks cannot create duplicate rounds or notifications with new identities.

## 4. Manager 固定变更

V1、真实 Browser E2E、双 API/双 Worker 并发与恢复完成后，T16 才发布
“role-based courier teams”。它改变核心基数、状态或一致性边界：

- A heavy Delivery requires 2-4 named roles with one distinct Courier assigned per role.
- One Offer Round may collect role claims independently, but the Assignment becomes active only when every role is filled.
- A Courier may claim only one role; simultaneous final claims create exactly one team activation.
- Before pickup, an expired role claim is released and only that role is re-offered; other valid claims remain reserved.
- Pickup requires every assigned Courier to acknowledge readiness; completion remains one terminal operation.
- Legacy ordinary Deliveries retain singular courier and assignment fields; team Deliveries return null there and expose assignments[].
- requiredRoles preserve request order. In a delivery-wide round, each unfilled role independently receives up to five Offers under the V1 Courier ranking; one Courier may receive Offers for multiple roles, but accepting one role atomically loses that Courier's other open Offers for the Delivery.

新增 wire schema：

- TeamOffer = {offerId:uuid,deliveryId:uuid,round:int,roleIndex:int,role:string,courierId:uuid,rank:int,state:OPEN|ACCEPTED|LOST|EXPIRED,createdAt:timestamp,expiresAt:timestamp,notificationId:uuid}; roleIndex is the zero-based requiredRoles position and responses sort by round, roleIndex, rank, offerId
- RoleAssignment = {assignmentId:uuid,deliveryId:uuid,role:string,courierId:uuid,offerId:uuid,state:RESERVED|READY|RELEASED|PICKED_UP|COMPLETED,claimedAt:timestamp,claimExpiresAt:timestamp,readyAt:timestamp|null,releasedAt:timestamp|null}
- TeamAssignment = {teamAssignmentId:uuid,deliveryId:uuid,state:FORMING|ACTIVE|READY|PICKED_UP|COMPLETED|CANCELLED,requiredRoles:[string],assignments:[RoleAssignment],activatedAt:timestamp|null,pickedUpAt:timestamp|null,completedAt:timestamp|null,revision:int}
- For a Manager-created team Delivery, Delivery adds requiredRoles:[string],teamAssignmentId:uuid|null,assignments:[RoleAssignment], and its V1 assignmentId is null. requiredRoles preserves request order, assignments sorts by that role order, and an ordinary Delivery retains the exact V1 Delivery shape without these Manager-only fields

新增或变更的公开接口：

- POST /api/v1/deliveries accepts the V1 body plus optional roles:[string]; omission creates an ordinary Delivery, while a team Delivery requires 2..4 non-empty role names unique by exact string.
- POST /api/v1/offers/:offerId/accept with {courierId} reserves that TeamOffer role and Courier load until claimExpiresAt=claimedAt+120 seconds; the Courier must be distinct from every other live role claimant, and the final required claim atomically activates one TeamAssignment.
- POST /api/v1/deliveries/:deliveryId/assignments/:assignmentId/ready with {courierId} records one readiness acknowledgement; the TeamAssignment becomes READY only after every live RoleAssignment is READY.
- POST /api/v1/deliveries/:deliveryId/pickup with {courierId} succeeds once only when courierId names one live READY RoleAssignment and every required role has a live READY assignment; the Offer Task releases an expired pre-pickup role, restores Courier load, increments Delivery.currentRound, and creates up to five next-round Offers only for that role.
- POST /api/v1/deliveries/:deliveryId/complete keeps {courierId,proofCode}; for a team Delivery courierId must name any live RoleAssignment, TeamAssignment must be PICKED_UP, and the one winning request atomically marks the Delivery, TeamAssignment, and every RoleAssignment completed and releases every Courier load exactly once.
- POST /api/v1/deliveries/:deliveryId/cancel keeps {reason}; before pickup it atomically cancels the TeamAssignment, releases every live RoleAssignment and Courier load, and supersedes every pending team OfferNotification.
- For TeamOffers, OfferNotification.body populates roleIndex and role from the exact requiredRoles position; retry identity, captured deliveryUrl, body, and deadline semantics remain the V1 notification contract.
- GET /api/v1/deliveries/:deliveryId returns requiredRoles, teamAssignmentId, and assignments[] for a team Delivery while assignmentId is null; ordinary Deliveries retain the exact V1 singular response.

新增稳定错误：

- 400 INVALID_TEAM_ROLES: roles has fewer than 2 or more than 4 entries, an empty name, or a duplicate exact name
- 409 TEAM_ROLE_ALREADY_FILLED: the accepted Offer targets a role with another live RoleAssignment
- 409 COURIER_TEAM_ROLE_CONFLICT: the Courier already holds another live role on the Delivery
- 409 TEAM_ROLE_CLAIM_EXPIRED: database time is at or after claimExpiresAt for readiness or pickup
- 409 TEAM_NOT_READY: pickup is requested before every required role has a live READY assignment
- 409 TEAM_COURIER_NOT_ASSIGNED: pickup or completion courierId does not name a live RoleAssignment for the Delivery

跨层规则：

- The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
- The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
- Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
- Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

FINAL snapshot 与性能兼容合同：

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

迁移必须同时满足：

- Migrate each V1 Assignment to one DRIVER role without changing state, capacity, notifications, events, or replay bodies.
- Pending Offer Tasks and active Offers retain their deadlines and stable IDs.
- Existing picked-up Deliveries complete under V1 semantics.

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
