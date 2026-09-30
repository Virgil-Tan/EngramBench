【Product Manager · Maya】

V1 已完成并通过基础验收。本期正式增加“ordered multi-stage permit approval”。以下业务规则、wire schema、接口和错误全部是公开增量合同。

业务规则：

1. A Review Policy may contain 1-5 ordered Stages; every Stage has its own V1 role policy.
2. Only the current Stage accepts Claims and Decisions; completing it freezes its exact Decisions before activating the next Stage.
3. REQUEST_CHANGES or rejection terminates the complete staged review under the V1 semantics and no later Stage activates.
4. Final approval occurs only after every Stage completes in ordinal order for the same immutable Revision.
5. Stage activation and the final Decision that completes the prior Stage commit atomically.
6. Legacy one-stage policies migrate to Stage 1 and preserve Application, Decision, Permit, event, and replay bodies.
7. Migrate every V1 current Revision and policy to one Stage without changing IDs, Claims, Decisions, Permits, events, Work, or saved responses.
8. Pending Deadline Tasks retain their original applicationId, deadline, attempt, and lease state.
9. Old clients continue submitting and reviewing one-stage Applications with unchanged request and response semantics.
10. The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
11. The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
12. Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
13. Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

新增 wire schema：

- ReviewStage = {stageId:uuid,applicationId:uuid,revision:int,ordinal:int,name:string,state:PENDING|ACTIVE|COMPLETED|TERMINAL,policy:ReviewPolicy,activatedAt:timestamp|null,completedAt:timestamp|null}; ordinals are contiguous from 1
- PermitApplication adds currentStageOrdinal:int|null and stages:[ReviewStage]; legacy one-stage responses may omit these fields on the legacy media type

新增或变更接口：

- POST /api/v1/permit-applications accepts either legacy reviewPolicy or stages:[{name,reviewPolicy}], never both; staged creation returns Revision 1 with Stage 1 ACTIVE and later Stages PENDING.
- Review Claim and Decision endpoints retain their V1 shapes and resolve eligibility only against the current ACTIVE Stage.
- GET /api/v1/permit-applications/:applicationId/stages returns {items:[ReviewStage]} in ordinal order with immutable completed-stage evidence.

新增稳定错误：

- 400 INVALID_REVIEW_STAGES: stage count, name, ordinal, or a nested Review Policy is invalid
- 409 REVIEW_STAGE_CHANGED: a Claim or Decision targets a Stage that is no longer ACTIVE

FINAL snapshot 与性能兼容合同：

The FINAL verification snapshot 'resources' object has exactly the union of these V1 and Manager resource specifications, with no other keys:

- 'applicants' uses exact shape 'Applicant = {applicantId:uuid,name:string}' and sorts ascending by scalar field-path tuple 'applicantId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'reviewers' uses exact shape 'Reviewer = {reviewerId:uuid,name:string,roles:[string]}' and sorts ascending by scalar field-path tuple 'reviewerId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'permitApplications' uses exact shape 'PermitApplication' and sorts ascending by scalar field-path tuple 'applicationId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'applicationRevisions' uses exact shape 'ApplicationRevision' and sorts ascending by scalar field-path tuple 'applicationId', 'revision', then by RFC 8785 canonical JSON as the tie-breaker.
- 'reviewClaims' uses exact shape 'ReviewClaim' and sorts ascending by scalar field-path tuple 'applicationId', 'revision', 'claimId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'reviewDecisions' uses exact shape 'ReviewDecision' and sorts ascending by scalar field-path tuple 'applicationId', 'revision', 'decidedAt', 'decisionId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'approvedPermits' uses exact shape 'ApprovedPermit = {permitId:uuid,applicationId:uuid,revision:int,canonicalDigest:sha256,issuedAt:timestamp}' and sorts ascending by scalar field-path tuple 'permitId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'reviewStages' uses exact shape 'ReviewStage' and sorts ascending by scalar field-path tuple 'applicationId', 'revision', 'ordinal', 'stageId', then by RFC 8785 canonical JSON as the tie-breaker.

The Manager-added resource specifications are exactly:

- 'reviewStages' uses exact shape 'ReviewStage' and sorts ascending by scalar field-path tuple 'applicationId', 'revision', 'ordinal', 'stageId', then by RFC 8785 canonical JSON as the tie-breaker.

The FINAL Work kind enum is exactly the union 'PERMIT_DEADLINE'. The Manager-added
Work kinds are exactly (none). All V1 snapshot point-in-time,
recursive '*Token' omission, sorting, Work state/lease/retention/drain, and Domain Event rules remain
mandatory. The FINAL binary reruns exactly these three V1-compatible scenarios:

- 'application-current-read': serve 350 current Application reads/s with p95 <= 120 ms; threshold: At least 350 successful reads/s for 60 seconds and p95 <= 120 ms; mixed revisions and unexpected 5xx are zero.
- 'application-submit': submit 100 Permit Applications/s with p95 <= 350 ms; threshold: At least 100 successful Applications/s for 60 seconds and p95 <= 350 ms; partial revision state and unexpected 5xx are zero.
- 'permit-deadline-recovery': expire 10,000 undecided Applications within 75 s after worker recovery; threshold: The backlog drains in <= 75 seconds after replacement spawn; stale decisions, invented Permits, and unexpected failures are zero.

Their published setup, selector, request, concurrency, warm-up, measurement, timer, success condition,
and threshold remain unchanged. This Manager change adds correctness, concurrency, and recovery
assertions only; it does not replace or relax a performance scenario.

本轮先不要实现。请先说明它会影响哪些领域关系、模块、schema、migration、接口、状态、成功与失败数据流、兼容性、Worker、事件、前端、并发、恢复和性能测试，然后给出分阶段修改计划。