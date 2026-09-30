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