# DispatchBoard 多轮用户与 Manager Prompt 协议

## 可见性

本文件只属于 Benchmark Harness，不得复制进 workspace、传给 Codex、Session Evolution 或
盲审 Judge。DS 只根据 workspace 的公开合同、可见对话和当前 scene 推进。

## DS system role

你是一名使用 Codex 完成 DispatchBoard 的交付负责人。每轮只提出一个主要目标，用自然简短的中文推进真实开发。可以询问模块职责、接口、状态、数据流、设计取舍和实际验证证据，但绝不能提供代码、伪代码、SQL、命令、补丁、文件或函数定位、表结构、锁、事务、索引、缓存、队列、算法、性能方案、日志分析、Debug 根因或修复提示。Codex 报告失败时只要求其自行定位、修复并重新验证。只使用 README、AGENTS 和已经出现在可见对话中的 Manager 变更，不透露未来阶段或私有评测。

DS 每轮只能返回一个主要用户目标。不能写代码、SQL、命令、补丁、伪代码、文件/函数定位、
表结构、锁、事务、索引、缓存、队列、算法、性能方案或 Debug 提示。它不能透露 Checklist、
权重、hidden scenario、未来 Manager 需求、Control/Treatment 标签或 Frontal 状态。

## 状态协议

- scenes 严格按 T01 到 T22；DS 根据可见证据自行决定重复当前 scene 或前进一格；
- advanceGate 只提供判断依据，Harness 不执行中途硬 Gate；失败时只要求 Codex 自行定位、修复并重新验证；
- T16 第一次访问时由 Harness 原样注入 fixedMessage，后续访问由 DS 自然跟进；
- T16 之前不能出现 Manager-only requirement 或其可识别业务规则；
- 整个 Session 唯一的自动截止条件是 'hardMaxTurns = 60'；达到上限后直接结束，不强制推进 scene；
- 'safeMessage' 只用于 provider 失败后的已审核 fallback，不能据此强制推进。

## Scene map

| Scene | Title | Advance guidance |
| --- | --- | --- |
| T01 | Initial plan | A coherent plan covers deliverables, dependencies, risks, and verification without repository edits. |
| T02 | Module and process ownership | The response defines module dependencies, process boundaries, authority, and responsibilities that stay separate. |
| T03 | Success and failure flows | Both flows identify atomic effects, forbidden records, replay behavior, and visible outcomes. |
| T04 | Public contract first | Canonical public contracts cover every published input, output, state, error, command, and asynchronous result. |
| T05 | Test strategy | The strategy distinguishes unit, real integration, browser, multi-process, recovery, aggregate, and performance evidence. |
| T06 | Runnable skeleton | All public processes start with documented commands, expose health, and stop cleanly. |
| T07 | Migration and seed | Migrations replay safely; valid, replayed, conflicting, and invalid seeds have exact atomic outcomes. |
| T08 | Read model and UI data | Queries, cursors, ordering, states, and UI data come from real PostgreSQL through HTTP. |
| T09 | Atomic V1 mutation | Success, atomic rejection, replay, conflict, and concurrent requests preserve every V1 invariant. |
| T10 | Worker lifecycle and terminal races | Leases recover; stale ownership cannot commit; each effect and terminal state occurs at most once. |
| T11 | Transactional outbox and backend review | Events commit with state, retries preserve identity/body/order, dispatcher recovery passes, and concrete review findings are fixed. |
| T12 | Complete real frontend | The UI completes all V1 flows through visible controls and real API data with correct asynchronous and error states. |
| T13 | Real integration suite | Integration tests cover contract, seed, V1 state, idempotency, worker, outbox, and cleanup and pass repeatably. |
| T14 | Production browser E2E | Project-owned browser tests cover public V1 flows and asynchronous states and pass under one command. |
| T15 | Multi-process recovery and V1 review | Controlled races and crashes preserve all V1 invariants with no unresolved finding. |
| T16 | Harness-owned Manager change | Codex explains domain, schema, migration, API, worker, event, UI, compatibility, concurrency, recovery, and performance impact and gives a staged plan without implementing. |
| T17 | Compatible migration and backend | Populated V1 data and replay remain valid; changed domain/state/worker behavior passes focused tests. |
| T18 | Changed API and integration | New and old contracts agree; migration and replay evidence hold; real HTTP integration passes. |
| T19 | Changed frontend | The UI exposes changed and compatible flows, aggregate/member states, history, errors, accessibility, and responsive behavior. |
| T20 | Changed browser, concurrency, and recovery | Changed browser and crash races are automated and pass without compatibility or invariant failures. |
| T21 | Sustained performance and full regression | Evidence reports environment, scale, duration, throughput, errors, latency, drain, invariants, targets, and passing full regression. |
| T22 | Final review and handoff | No material finding remains; all required gates pass; documentation and handoff accurately state architecture, operation, compatibility, evidence, risks, and unrun checks. |

## Fixed Manager message

<!-- FIXED_MANAGER_MESSAGE_START -->
【Product Manager · Maya】

V1 已完成并通过基础验收。本期正式增加“role-based courier teams”。以下业务规则、wire schema、接口和错误全部是公开增量合同。

业务规则：

1. A heavy Delivery requires 2-4 named roles with one distinct Courier assigned per role.
2. One Offer Round may collect role claims independently, but the Assignment becomes active only when every role is filled.
3. A Courier may claim only one role; simultaneous final claims create exactly one team activation.
4. Before pickup, an expired role claim is released and only that role is re-offered; other valid claims remain reserved.
5. Pickup requires every assigned Courier to acknowledge readiness; completion remains one terminal operation.
6. Legacy ordinary Deliveries retain singular courier and assignment fields; team Deliveries return null there and expose assignments[].
7. requiredRoles preserve request order. In a delivery-wide round, each unfilled role independently receives up to five Offers under the V1 Courier ranking; one Courier may receive Offers for multiple roles, but accepting one role atomically loses that Courier's other open Offers for the Delivery.
8. Migrate each V1 Assignment to one DRIVER role without changing state, capacity, notifications, events, or replay bodies.
9. Pending Offer Tasks and active Offers retain their deadlines and stable IDs.
10. Existing picked-up Deliveries complete under V1 semantics.
11. The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
12. The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
13. Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
14. Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

新增 wire schema：

- TeamOffer = {offerId:uuid,deliveryId:uuid,round:int,roleIndex:int,role:string,courierId:uuid,rank:int,state:OPEN|ACCEPTED|LOST|EXPIRED,createdAt:timestamp,expiresAt:timestamp,notificationId:uuid}; roleIndex is the zero-based requiredRoles position and responses sort by round, roleIndex, rank, offerId
- RoleAssignment = {assignmentId:uuid,deliveryId:uuid,role:string,courierId:uuid,offerId:uuid,state:RESERVED|READY|RELEASED|PICKED_UP|COMPLETED,claimedAt:timestamp,claimExpiresAt:timestamp,readyAt:timestamp|null,releasedAt:timestamp|null}
- TeamAssignment = {teamAssignmentId:uuid,deliveryId:uuid,state:FORMING|ACTIVE|READY|PICKED_UP|COMPLETED|CANCELLED,requiredRoles:[string],assignments:[RoleAssignment],activatedAt:timestamp|null,pickedUpAt:timestamp|null,completedAt:timestamp|null,revision:int}
- For a Manager-created team Delivery, Delivery adds requiredRoles:[string],teamAssignmentId:uuid|null,assignments:[RoleAssignment], and its V1 assignmentId is null. requiredRoles preserves request order, assignments sorts by that role order, and an ordinary Delivery retains the exact V1 Delivery shape without these Manager-only fields

新增或变更接口：

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

本轮先不要实现。请先说明它会影响哪些领域关系、模块、schema、migration、接口、状态、成功与失败数据流、兼容性、Worker、事件、前端、并发、恢复和性能测试，然后给出分阶段修改计划。
<!-- FIXED_MANAGER_MESSAGE_END -->

两份正文的唯一来源是 task generator；'dialogue-script.json' 的 'fixedMessage' 必须逐字相同。
T16 只做影响分析和计划，不能把“已开始实现”视为通过。

## Decision output

DS 决策输出必须是一个 JSON object：

~~~json
{"decision":"continue|accept|abort","sceneId":"T01","message":"one user message","state":{"turn":1,"lastScene":"T01","visits":{"T01":1}}}
~~~

只有 T22 advanceGate 已满足、'minimumTurns' 已达到且当前没有未解决失败时才能 'accept'。
达到 hard limit、公开合同不可完成或隔离被破坏时才能 'abort'。
