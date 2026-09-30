# IncidentRelay 项目设计说明

## 1. 定位

IncidentRelay 是一个从近空白 Git fixture 开始的高难度全栈 Coding Benchmark，主流程是
durable incident escalation and responder acknowledgement。这是 transfer task；正式 paired curriculum 为 `queueforge` learning -> `incidentrelay` transfer。

本题只用一个主流程承载难度，重点测量：deadline scheduling、lease recovery、terminal acknowledgement races、fair routing、ordered notification。领域词汇以
[CONTEXT.md](./CONTEXT.md) 为准。

## 2. 可见性

Codex 初始只能看到 'workspace/README.md'、'workspace/AGENTS.md' 和独立 fixture Git 历史。
Manager 变更、Checklist、对话状态机、评测方案和实验 metadata 都在 workspace 外，不能在
开发回合、Session Evolution 或盲审前复制或透露。

## 3. 完整 V1

- Ingest alerts with scoped durable deduplication and capture the current Escalation Policy version.
- Schedule and lease Escalation Steps by persisted dueAt across multiple workers.
- Deliver each step to its target at least once with stable body and ordering.
- Accept the first valid acknowledgement and supersede remaining steps atomically.
- Resolve or expire Incidents with legal races, timeline UI, and recovery after worker death.

核心状态：Incident: OPEN -> ACKNOWLEDGED -> RESOLVED, or OPEN -> EXPIRED; Escalation Steps are PENDING -> SENT | SUPERSEDED.

### 可计算不变量

1. For one serviceId and dedupKey, at most one active Incident exists at a time; every accepted Idempotency-Key replays its original stable result forever.
2. An Incident captures one immutable Escalation Policy version.
3. At most one Responder wins acknowledgement in V1.
4. No step after acknowledgement or resolution becomes newly deliverable.
5. Successful notifications for one Incident follow increasing step order.

## 4. Manager 固定变更

V1、真实 Browser E2E、双 API/双 Worker 并发与恢复完成后，T16 才发布
“parallel quorum acknowledgement”。它改变核心基数、状态或一致性边界：

- An Escalation Step may target a responder group and require an acknowledgement quorum from 1-N distinct Responders.
- Acknowledgements are independently durable and unique by incidentId, stepIndex, and responderId. An exact duplicate is resolved before Incident state checks and returns its original result with replayed true without increasing the count.
- An acknowledgement is accepted only for the named SENT Escalation Step while the Incident is OPEN. The first transaction that makes any sent Step reach its own quorum records that stepIndex as acknowledgementStepIndex, changes the Incident to ACKNOWLEDGED exactly once, and supersedes every other Step.
- Later Escalation Steps stop only after quorum, not after the first vote.
- Withdrawn acknowledgements are not supported; resolution records the immutable quorum members.
- Legacy policies have quorum 1 and keep the singular acknowledgedBy field; quorum incidents also expose acknowledgements[].

新增 wire schema：

- IncidentAcknowledgement = {acknowledgementId:uuid,incidentId:uuid,stepIndex:int,responderId:uuid,acknowledgedAt:timestamp}; Incident adds acknowledgementStepIndex:int|null and acknowledgements:[IncidentAcknowledgement]
- GroupEscalationStep = {incidentId:uuid,stepIndex:int,responderIds:[uuid],quorumRequired:int,dueAt:timestamp,state:PENDING|SENT|SUPERSEDED,notifications:[NotificationDelivery],successfulDeliveryAt:timestamp|null}; notifications contains one stable NotificationDelivery per responderId in the same order, and successfulDeliveryAt is the transaction time when the quorumRequired-th distinct notification first becomes DELIVERED

新增或变更的公开接口：

- For Manager policy versions, POST /api/v1/services/:serviceId/escalation-policies accepts {expectedCurrentVersion,steps:[{stepIndex,delaySeconds,responderIds,quorumRequired}],expireAfterSeconds} and creates EscalationPolicy = {policyId:uuid,version:int,steps:[{stepIndex:int,delaySeconds:int,responderIds:[uuid],quorumRequired:int}],expireAfterSeconds:int}; responderIds are sorted unique and quorumRequired is 1..responderIds.length. Migration maps each V1 responderId to responderIds:[responderId] with quorumRequired 1
- POST /api/v1/incidents/:incidentId/acknowledgements with {stepIndex,responderId} returns {incident,acknowledgement,replayed}; the same incidentId, stepIndex, and responderId replays even after the Incident becomes terminal. Legacy /acknowledge selects the lowest-index SENT Step targeting responderId and remains available only when every captured Step has quorumRequired 1
- A Manager GroupEscalationStep creates one NotificationDelivery per responderId when due and changes PENDING to SENT only when quorumRequired distinct notifications are DELIVERED. A new acknowledgement requires a SENT GroupEscalationStep and that Responder's own delivered notification; every notification retains the V1 business header, retry identity, and separation from Domain Event webhooks
- GET /api/v1/incidents/:incidentId returns acknowledgements by acknowledgedAt then acknowledgementId and keeps acknowledgedBy only when the winning Step has quorumRequired 1

新增稳定错误：

- 409 RESPONDER_NOT_IN_ACTIVE_QUORUM: the named Escalation Step is not SENT or the Responder is not one of its captured targets
- 400 INVALID_QUORUM_POLICY: responderIds is empty or duplicated, or quorumRequired is outside 1..responderIds.length

跨层规则：

- The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
- The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
- Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
- Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

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

迁移必须同时满足：

- Migrate every V1 winning acknowledgement into one acknowledgement record without changing timestamps or events.
- Pending Escalation Steps and delivery retry identities remain intact.
- Old acknowledge requests and stored idempotency replies remain valid.

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
