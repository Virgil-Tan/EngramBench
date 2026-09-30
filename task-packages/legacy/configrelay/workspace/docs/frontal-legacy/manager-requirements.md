【Product Manager · Maya】

V1 已完成并通过基础验收。本期正式增加“staged cohort rollout with automatic rollback”。以下业务规则、wire schema、接口和错误全部是公开增量合同。

业务规则：

1. A Deployment contains ordered Cohorts selected from one immutable target snapshot and starts only the first Cohort.
2. Each Cohort declares minimum success basis points, maximum failure basis points, and an observation deadline. Both thresholds are integers 0..10000 and the denominator is immutable targetCount. Before the deadline, success and failure count APPLIED and REJECTED acknowledgements; at the deadline, success still counts APPLIED and failure is targetCount minus successCount, so every missing acknowledgement is a failure.
3. Evaluate once when every target has acknowledged or when observationDeadlineAt is reached: the Cohort succeeds exactly when floor(successCount*10000/targetCount) >= minimumSuccessBasisPoints and floor(failureCount*10000/targetCount) <= maximumFailureBasisPoints; otherwise it fails. targetCount zero is invalid, and simultaneous acknowledgements or deadline workers produce one durable transition.
4. A failed Cohort supersedes every still-pending APPLY command and starts one automatic Rollback for exactly the captured Agents in this and earlier Cohorts whose APPLY acknowledgement changed them to the Deployment revision.
5. Rollback delivery uses new stable identities and a strictly increasing commandSequence; it may apply each affected Agent's captured lower prior revision and completes only after every captured rollback command is terminal.
6. Legacy all-at-once Deployments behave as one Cohort and keep existing response fields; staged Deployments expose cohorts[] and rollback.
7. Migrate V1 Deployments to one Cohort without changing targets, assignments, tokens, acknowledgements, or events.
8. In-flight Delivery Tasks continue with identical delivery IDs and bodies.
9. Existing Agents never receive a synthetic rollback or lower revision during migration.
10. The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
11. The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
12. Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
13. Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

新增 wire schema：

- DeploymentCohort = {cohortId:uuid,deploymentId:uuid,ordinal:int,name:string,selector:{labels:{key:string,value:string}},targetCount:int,targetDigest:sha256,minimumSuccessBasisPoints:int,maximumFailureBasisPoints:int,observationSeconds:int,successCount:int,failureCount:int,pendingCount:int,state:WAITING|DELIVERING|OBSERVING|SUCCEEDED|FAILED|ROLLED_BACK,startedAt:timestamp|null,observationDeadlineAt:timestamp|null,completedAt:timestamp|null}; counts are non-negative and sum to targetCount, and deadline evaluation moves every missing acknowledgement from pendingCount to failureCount
- RolloutCommand = {commandId:uuid,deploymentId:uuid,cohortId:uuid,agentId:uuid,commandSequence:int,kind:APPLY|ROLLBACK,fromRevision:int,toRevision:int,toDigest:sha256,deliveryId:uuid,assignmentToken:string,state:WAITING|SENT|ACKED|FAILED|SUPERSEDED,createdAt:timestamp,ackedAt:timestamp|null}
- DeploymentRollback = {rollbackId:uuid,deploymentId:uuid,failedCohortId:uuid,state:PENDING|DELIVERING|COMPLETED|FAILED,commandCount:int,completedCount:int,startedAt:timestamp,completedAt:timestamp|null}; commandCount is the immutable affected-Agent count
- For staged Deployments, AgentPollResponse.command additionally permits RolloutCommand; status and nullability rules are unchanged
- Under the Manager schema a staged Deployment adds cohorts:[DeploymentCohort] and rollback:DeploymentRollback|null; cohorts sort by ordinal and rollback is null until a failed Cohort atomically creates it. A legacy all-at-once Deployment retains its exact V1 Deployment shape and omits both Manager-only fields

新增或变更接口：

- POST /api/v1/deployments accepts optional cohorts:[{name,selector,minimumSuccessBasisPoints,maximumFailureBasisPoints,observationSeconds}]. A staged plan contains 1..20 Cohorts; each threshold is an integer 0..10000, observationSeconds is an integer 1..86400, and every Cohort has at least one target. Against the captured outer target set, every Agent must match exactly one Cohort; membership, order, prior revision, and digests commit atomically.
- GET /api/v1/deployments/:deploymentId returns the extended Deployment with cohorts[] in ordinal order and rollback:null|DeploymentRollback only for a staged Deployment; a legacy all-at-once Deployment returns the exact V1 Deployment shape with no cohorts or rollback fields.
- POST /api/v1/agents/:agentId/poll accepts optional lastCommandSequence and returns at most the next RolloutCommand. APPLY and ROLLBACK share one strictly increasing per-Agent commandSequence and retries preserve commandId, deliveryId, body, and assignmentToken.
- POST /api/v1/agents/:agentId/acknowledgements includes commandSequence for staged Deployments; only the current token at the next sequence can change state, while an identical replay returns its original result.
- The transaction that fails a Cohort freezes the affected-Agent set from successful APPLY acknowledgements, supersedes all other pending APPLY commands, creates exactly one ROLLBACK command per affected Agent, and never adds a later Agent to that Rollback.

新增稳定错误：

- 400 INVALID_COHORT_PLAN: cohort count, order, thresholds, observation duration, name, or selector is invalid
- 409 COHORT_TARGET_PARTITION_INVALID: a captured target Agent matches zero or multiple Cohorts
- 409 AGENT_COMMAND_SEQUENCE_CONFLICT: the command or acknowledgement is not the current next per-Agent sequence

FINAL snapshot 与性能兼容合同：

The FINAL verification snapshot 'resources' object has exactly the union of these V1 and Manager resource specifications, with no other keys:

- 'agents' uses exact shape 'Agent' and sorts ascending by scalar field-path tuple 'agentId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'configurations' uses exact shape 'Configuration' and sorts ascending by scalar field-path tuple 'fleetId', 'revision', then by RFC 8785 canonical JSON as the tie-breaker.
- 'deployments' uses exact shape 'Deployment' and sorts ascending by scalar field-path tuple 'deploymentId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'assignments' uses exact shape 'Assignment' and sorts ascending by scalar field-path tuple 'assignmentId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'acknowledgements' uses exact shape 'Acknowledgement' and sorts ascending by scalar field-path tuple 'agentId', 'deploymentId', 'commandSequence', then by RFC 8785 canonical JSON as the tie-breaker.
- 'deploymentCohorts' uses exact shape 'DeploymentCohort' and sorts ascending by scalar field-path tuple 'deploymentId', 'ordinal', 'cohortId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'rolloutCommands' uses exact shape 'RolloutCommand' and sorts ascending by scalar field-path tuple 'deploymentId', 'agentId', 'commandSequence', then by RFC 8785 canonical JSON as the tie-breaker.
- 'deploymentRollbacks' uses exact shape 'DeploymentRollback' and sorts ascending by scalar field-path tuple 'deploymentId', then by RFC 8785 canonical JSON as the tie-breaker.

The Manager-added resource specifications are exactly:

- 'deploymentCohorts' uses exact shape 'DeploymentCohort' and sorts ascending by scalar field-path tuple 'deploymentId', 'ordinal', 'cohortId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'rolloutCommands' uses exact shape 'RolloutCommand' and sorts ascending by scalar field-path tuple 'deploymentId', 'agentId', 'commandSequence', then by RFC 8785 canonical JSON as the tie-breaker.
- 'deploymentRollbacks' uses exact shape 'DeploymentRollback' and sorts ascending by scalar field-path tuple 'deploymentId', then by RFC 8785 canonical JSON as the tie-breaker.

The FINAL Work kind enum is exactly the union 'ASSIGNMENT_DELIVERY', 'COHORT_DEADLINE', 'ROLLBACK_DELIVERY'. The Manager-added
Work kinds are exactly 'COHORT_DEADLINE', 'ROLLBACK_DELIVERY'. All V1 snapshot point-in-time,
recursive '*Token' omission, sorting, Work state/lease/retention/drain, and Domain Event rules remain
mandatory. The FINAL binary reruns exactly these three V1-compatible scenarios:

- 'agent-poll': serve 2,000 Agent polls/s with p95 <= 80 ms; threshold: At least 2,000 successful polls/s for 60 seconds and p95 <= 80 ms; token mix-up and unexpected 5xx = 0.
- 'acknowledgement-ingest': ingest 1,000 acknowledgements/s with p95 <= 180 ms; threshold: At least 1,000 successful responses/s for 60 seconds and p95 <= 180 ms with the exact 45% APPLIED, 5% REJECTED, 50% replay request mix.
- 'assignment-delivery-recovery': recover and deliver 50,000 pending Assignments within 120 s; threshold: All 50,000 Assignments reach SENT in <= 120 seconds after replacement spawn; stale commits and unexpected failures are zero.

Their published setup, selector, request, concurrency, warm-up, measurement, timer, success condition,
and threshold remain unchanged. This Manager change adds correctness, concurrency, and recovery
assertions only; it does not replace or relax a performance scenario.

本轮先不要实现。请先说明它会影响哪些领域关系、模块、schema、migration、接口、状态、成功与失败数据流、兼容性、Worker、事件、前端、并发、恢复和性能测试，然后给出分阶段修改计划。