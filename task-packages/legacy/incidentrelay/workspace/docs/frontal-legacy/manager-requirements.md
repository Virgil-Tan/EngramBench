【Product Manager · Maya】

V1 已完成并通过基础验收。本期正式增加“parallel quorum acknowledgement”。以下业务规则、wire schema、接口和错误全部是公开增量合同。

业务规则：

1. An Escalation Step may target a responder group and require an acknowledgement quorum from 1-N distinct Responders.
2. Acknowledgements are independently durable and unique by incidentId, stepIndex, and responderId. An exact duplicate is resolved before Incident state checks and returns its original result with replayed true without increasing the count.
3. An acknowledgement is accepted only for the named SENT Escalation Step while the Incident is OPEN. The first transaction that makes any sent Step reach its own quorum records that stepIndex as acknowledgementStepIndex, changes the Incident to ACKNOWLEDGED exactly once, and supersedes every other Step.
4. Later Escalation Steps stop only after quorum, not after the first vote.
5. Withdrawn acknowledgements are not supported; resolution records the immutable quorum members.
6. Legacy policies have quorum 1 and keep the singular acknowledgedBy field; quorum incidents also expose acknowledgements[].
7. Migrate every V1 winning acknowledgement into one acknowledgement record without changing timestamps or events.
8. Pending Escalation Steps and delivery retry identities remain intact.
9. Old acknowledge requests and stored idempotency replies remain valid.
10. The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
11. The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
12. Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
13. Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

新增 wire schema：

- IncidentAcknowledgement = {acknowledgementId:uuid,incidentId:uuid,stepIndex:int,responderId:uuid,acknowledgedAt:timestamp}; Incident adds acknowledgementStepIndex:int|null and acknowledgements:[IncidentAcknowledgement]
- GroupEscalationStep = {incidentId:uuid,stepIndex:int,responderIds:[uuid],quorumRequired:int,dueAt:timestamp,state:PENDING|SENT|SUPERSEDED,notifications:[NotificationDelivery],successfulDeliveryAt:timestamp|null}; notifications contains one stable NotificationDelivery per responderId in the same order, and successfulDeliveryAt is the transaction time when the quorumRequired-th distinct notification first becomes DELIVERED

新增或变更接口：

- For Manager policy versions, POST /api/v1/services/:serviceId/escalation-policies accepts {expectedCurrentVersion,steps:[{stepIndex,delaySeconds,responderIds,quorumRequired}],expireAfterSeconds} and creates EscalationPolicy = {policyId:uuid,version:int,steps:[{stepIndex:int,delaySeconds:int,responderIds:[uuid],quorumRequired:int}],expireAfterSeconds:int}; responderIds are sorted unique and quorumRequired is 1..responderIds.length. Migration maps each V1 responderId to responderIds:[responderId] with quorumRequired 1
- POST /api/v1/incidents/:incidentId/acknowledgements with {stepIndex,responderId} returns {incident,acknowledgement,replayed}; the same incidentId, stepIndex, and responderId replays even after the Incident becomes terminal. Legacy /acknowledge selects the lowest-index SENT Step targeting responderId and remains available only when every captured Step has quorumRequired 1
- A Manager GroupEscalationStep creates one NotificationDelivery per responderId when due and changes PENDING to SENT only when quorumRequired distinct notifications are DELIVERED. A new acknowledgement requires a SENT GroupEscalationStep and that Responder's own delivered notification; every notification retains the V1 business header, retry identity, and separation from Domain Event webhooks
- GET /api/v1/incidents/:incidentId returns acknowledgements by acknowledgedAt then acknowledgementId and keeps acknowledgedBy only when the winning Step has quorumRequired 1

新增稳定错误：

- 409 RESPONDER_NOT_IN_ACTIVE_QUORUM: the named Escalation Step is not SENT or the Responder is not one of its captured targets
- 400 INVALID_QUORUM_POLICY: responderIds is empty or duplicated, or quorumRequired is outside 1..responderIds.length

FINAL snapshot 与性能兼容合同：

The FINAL verification snapshot 'resources' object has exactly the union of these V1 and Manager resource specifications, with no other keys:

- 'services' uses exact shape 'Service = {serviceId:uuid,name:string,currentPolicyId:uuid,currentPolicyVersion:int}' and sorts ascending by scalar field-path tuple 'serviceId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'responders' uses exact shape 'Responder = {responderId:uuid,name:string,deliveryUrl:http-url}' and sorts ascending by scalar field-path tuple 'responderId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'escalationPolicies' uses exact shape 'EscalationPolicy' and sorts ascending by scalar field-path tuple 'policyId', 'version', then by RFC 8785 canonical JSON as the tie-breaker.
- 'incidents' uses exact shape 'Incident' and sorts ascending by scalar field-path tuple 'incidentId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'escalationSteps' uses exact shape 'EscalationStep' and sorts ascending by scalar field-path tuple 'incidentId', 'stepIndex', then by RFC 8785 canonical JSON as the tie-breaker.
- 'notificationDeliveries' uses exact shape 'NotificationDelivery' and sorts ascending by scalar field-path tuple 'incidentId', 'stepIndex', 'responderId', 'notificationId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'groupEscalationSteps' uses exact shape 'GroupEscalationStep' and sorts ascending by scalar field-path tuple 'incidentId', 'stepIndex', then by RFC 8785 canonical JSON as the tie-breaker.
- 'incidentAcknowledgements' uses exact shape 'IncidentAcknowledgement' and sorts ascending by scalar field-path tuple 'incidentId', 'stepIndex', 'responderId', then by RFC 8785 canonical JSON as the tie-breaker.

The Manager-added resource specifications are exactly:

- 'groupEscalationSteps' uses exact shape 'GroupEscalationStep' and sorts ascending by scalar field-path tuple 'incidentId', 'stepIndex', then by RFC 8785 canonical JSON as the tie-breaker.
- 'incidentAcknowledgements' uses exact shape 'IncidentAcknowledgement' and sorts ascending by scalar field-path tuple 'incidentId', 'stepIndex', 'responderId', then by RFC 8785 canonical JSON as the tie-breaker.

The FINAL Work kind enum is exactly the union 'ESCALATION_STEP', 'INCIDENT_EXPIRY'. The Manager-added
Work kinds are exactly (none). All V1 snapshot point-in-time,
recursive '*Token' omission, sorting, Work state/lease/retention/drain, and Domain Event rules remain
mandatory. The FINAL binary reruns exactly these three V1-compatible scenarios:

- 'deduplicated-incident-ingest': ingest 200 deduplicated alerts/s with p95 <= 250 ms; threshold: At least 200 complete successful responses/s for 60 seconds and p95 <= 250 ms; unexpected 5xx = 0.
- 'incident-timeline-read': serve 250 timeline reads/s with p95 <= 150 ms; threshold: At least 250 successful reads/s for 60 seconds and p95 <= 150 ms; unexpected 5xx = 0.
- 'escalation-recovery': drain 3,000 due Escalation Steps within 45 s after restart; threshold: The backlog drains in <= 45 seconds after replacement spawn; unexpected worker or receiver failures = 0.

Their published setup, selector, request, concurrency, warm-up, measurement, timer, success condition,
and threshold remain unchanged. This Manager change adds correctness, concurrency, and recovery
assertions only; it does not replace or relax a performance scenario.

本轮先不要实现。请先说明它会影响哪些领域关系、模块、schema、migration、接口、状态、成功与失败数据流、兼容性、Worker、事件、前端、并发、恢复和性能测试，然后给出分阶段修改计划。