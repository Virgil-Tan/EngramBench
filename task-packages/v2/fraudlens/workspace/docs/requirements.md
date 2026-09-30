# FraudLens — Complete system requirements

Public scope revision: **learning-final-system-2026-09-08.1**. This is a single final-system task, not a historical upgrade benchmark.

## Scope and authority

- Build one complete system from the start. Base features and the formerly named Manager features are required together; there is no intermediate submission, old program, historical workspace, or cross-version upgrade assessment.
- V1 in an API or source description denotes the base feature contract, not a separately running program. The published /api/v1 paths and schemaVersion values do not change.
- Cross-version-only duties are withdrawn: importing an unspecified historical physical database, upgrading an earlier binary, migration-time availability of an earlier binary, and synthesizing migration-only legacy wrappers. Current public resource shapes, base APIs, additional features and their ordinary business relationships remain required.
- Initialize an empty database using the published commands. db:migrate is current-system schema initialization, not an obligation to recognize a hidden old schema. Preserve the original current-system seed validation, atomicity and replay rules.
- Evaluation creates fresh data through the published seed or APIs, then checks actual behavior and durable state. Restart and recovery assertions use this same final system. A snapshot is a read-only observation, not a database backup format.
- Persistence, transactionality, idempotency, concurrency, authorization, real UI, OpenAPI, recovery and explicitly specified performance requirements remain in scope. This policy does not remove an otherwise explicit business or security requirement.
- No external legacy service is required. An isolated receiver or provider simulator is used only for an external interaction actually required by the public product contract; no real account or production service is required.
- Hidden assertions must use published inputs and observable requirements. Unspecified algorithms, exact error strings, control points or performance thresholds cannot silently become requirements. Code defects fail; invalid author fixtures and infrastructure faults are evaluator errors, not zero-score business outcomes.

The original source documents are retained under frontal-legacy/ only for provenance. The complete active business requirements are reproduced below; the withdrawn historical orchestration and cross-version-only clauses are not a second source of obligations. contract/ fixes public representation.

## Base product requirements

# FraudLens

Build FraudLens from this intentionally blank repository. This README is the complete public product
contract. Ask before making a product choice that this contract does not settle.

## Required stack and commands

- Node.js 22, TypeScript, React, PostgreSQL 16, npm, and the preinstalled Chromium.
- PostgreSQL is the sole authority for rules, events, assessments, review state, decisions, idempotency,
  leases, events, audit ordering, and active-version selection.
- The production UI uses the public HTTP API; browser storage and process memory are never authoritative.

Required non-interactive commands:

```text
npm run db:migrate
npm run db:seed -- --file <path>
npm run dev
npm run build
npm run start:api
npm run start:worker
npm run start:dispatcher
npm run test:unit
npm run test:integration
npm run test:e2e
npm run test:concurrency
npm run test:recovery
npm run test:all
npm run test:perf
```

Every command exits non-zero on failure and cleans up child processes. `PORT` defaults to `3000`;
`DATABASE_URL`, `TEST_DATABASE_URL`, `ADMIN_TOKEN`, `WEBHOOK_URL`, `WORK_LEASE_SECONDS`,
`TEST_BARRIER_URL`, and `TEST_BARRIER_TOKEN` have their conventional meanings. Lease duration is 1..30
seconds. Credentials and tokens must never enter responses, snapshots, events, or logs.

## Domain and states

FraudLens accepts immutable tenant RiskEvents, evaluates them against the one ACTIVE immutable RuleVersion,
stores an explainable Assessment, and either produces a final automated Decision or a ReviewCase. Human
review can confirm or override the recommendation. Operators can activate a newer RuleVersion or roll back
to a prior version without rewriting historical Assessments.

```text
Tenant, RuleSet, RuleVersion, RiskEvent, Assessment, RuleHit,
ReviewCase, ReviewDecision, RuleRollback, AuditEntry, OutboxEvent, Work

RuleVersion: DRAFT -> ACTIVE -> SUPERSEDED | ROLLED_BACK
Assessment:  PENDING -> SCORED -> REVIEW_REQUIRED | DECIDED | FAILED
ReviewCase:  OPEN -> CLAIMED -> APPROVED | BLOCKED | EXPIRED
```

`uuid` is lowercase RFC 4122 text, `timestamp` is UTC ISO-8601 with millisecond precision and `Z`, `sha256`
is 64 lowercase hex, and every integer is a JSON safe integer.

```text
RiskEvent = {riskEventId:uuid,tenantId:uuid,externalEventId:string,subjectId:string,amountMinor:int,currency:string,occurredAt:timestamp,attributes:object,createdAt:timestamp,sequence:int}
RuleVersion = {ruleVersionId:uuid,ruleSetId:uuid,version:int,state:DRAFT|ACTIVE|SUPERSEDED|ROLLED_BACK,rules:[{ruleId:string,priority:int,field:string,operator:EQ|IN|GTE|LTE,value:string|int,score:int,reasonCode:string}],reviewThreshold:int,blockThreshold:int,createdAt:timestamp,activatedAt:timestamp|null}
Assessment = {assessmentId:uuid,riskEventId:uuid,ruleVersionId:uuid,state:PENDING|SCORED|REVIEW_REQUIRED|DECIDED|FAILED,score:int|null,recommendation:APPROVE|REVIEW|BLOCK|null,decision:APPROVE|BLOCK|null,createdAt:timestamp,decidedAt:timestamp|null,sequence:int}
RuleHit = {assessmentId:uuid,ruleId:string,priority:int,score:int,reasonCode:string}
ReviewCase = {reviewCaseId:uuid,assessmentId:uuid,state:OPEN|CLAIMED|APPROVED|BLOCKED|EXPIRED,assigneeId:string|null,leaseExpiresAt:timestamp|null,openedAt:timestamp,closedAt:timestamp|null,revision:int}
ReviewDecision = {reviewDecisionId:uuid,reviewCaseId:uuid,outcome:APPROVE|BLOCK,reasonCode:string,reviewerId:string,createdAt:timestamp}
RuleRollback = {rollbackId:uuid,ruleSetId:uuid,fromRuleVersionId:uuid,toRuleVersionId:uuid,reason:string,createdAt:timestamp}
AuditEntry = {auditEntryId:uuid,tenantId:uuid,sequence:int,eventType:string,subjectRef:string,payloadDigest:sha256,priorDigest:sha256|null,digest:sha256,createdAt:timestamp}
```

Unknown request fields are rejected. Attribute values are only booleans, safe integers, strings of at most
256 UTF-8 bytes, or arrays of at most 32 such scalars. Objects do not nest. Amount is 0..9,000,000,000,000.

## Rules and scoring

1. A RuleVersion is immutable after activation. A tenant RuleSet has exactly one ACTIVE version.
2. Rules evaluate by ascending `priority`, then `ruleId`; every match creates one RuleHit. Score is the
   overflow-checked sum clamped to 0..1000.
3. `score >= blockThreshold` recommends BLOCK; `score >= reviewThreshold` recommends REVIEW; otherwise
   APPROVE. Thresholds satisfy `0 <= reviewThreshold <= blockThreshold <= 1000`.
4. Assessment creation freezes the active RuleVersion in the same transaction as RiskEvent, Work, and Event.
   Later activation or rollback cannot change its RuleHits, score, recommendation, or audit facts.
5. Repeated `externalEventId` inside one tenant with identical canonical payload returns the same RiskEvent
   and Assessment. A different payload is `EXTERNAL_EVENT_CONFLICT`.
6. Rules may inspect only published event fields and attributes. They cannot execute code or perform network
   calls. A malformed or cross-tenant rule reference rejects the complete mutation atomically.

## Review and rollback

1. APPROVE and BLOCK recommendations become final automated decisions. REVIEW creates exactly one ReviewCase.
2. A ReviewCase uses a bounded database lease. Only its current fenced owner can append a ReviewDecision.
   Concurrent decisions produce exactly one terminal outcome; losing requests return `REVIEW_TERMINAL`.
3. A ReviewDecision never rewrites the Assessment recommendation or RuleHits. It appends the final business
   decision and immutable AuditEntry in one transaction.
4. Rollback requires the currently ACTIVE version and an earlier version of the same RuleSet. It atomically
   makes the target ACTIVE and records RuleRollback, Event, and AuditEntry.
5. Events accepted before rollback keep their frozen version; events accepted after commit use the restored
   version. Concurrent activation and rollback have exactly one serialization order.
6. A false-positive report is evidence for an operator; it does not silently edit rules or prior decisions.

## Reliability contract

Every mutation requires `Idempotency-Key`, scoped by method and canonical path. Exact replay, concurrent
replay, lost response, and API restart return the original status and body. Same key with a different canonical
body returns `IDEMPOTENCY_CONFLICT` with no state change.

Assessment work, review expiry, and audit delivery use PostgreSQL leases with fenced final commits. A killed
Worker is reclaimed after `WORK_LEASE_SECONDS`. A business mutation and its Work, Domain Event, and AuditEntry
commit atomically. Dispatch is at least once; retry keeps identical event ID and canonical body. Required event
types are `risk.accepted`, `assessment.scored`, `decision.recorded`, `review.opened`, `review.decided`,
`rule.activated`, and `rule.rolled_back`.

## Public HTTP surface

```text
POST /api/v1/tenants
POST /api/v1/rule-sets
POST /api/v1/rule-sets/:ruleSetId/versions
POST /api/v1/rule-versions/:ruleVersionId/activate
POST /api/v1/rule-sets/:ruleSetId/rollback
POST /api/v1/risk-events
GET  /api/v1/assessments/:assessmentId
GET  /api/v1/review-cases?state&limit&cursor
POST /api/v1/review-cases/:reviewCaseId/claim
POST /api/v1/review-cases/:reviewCaseId/decisions
GET  /api/v1/audit?limit&cursor
GET  /api/v1/verification-snapshot
```

Serve `GET /openapi.json` as OpenAPI 3.1 and `GET /healthz`. JSON errors use
`{"error":{"code":"STABLE_CODE","message":"...","details":{}}}`. Reject malformed JSON, unsupported media
types, invalid UUID/time/currency, unsafe integers, and unknown fields. Collections return `{items,nextCursor}`
with stable opaque cursors.

Published semantic errors for well-formed requests are exhaustive:

```text
409 IDEMPOTENCY_CONFLICT
409 EXTERNAL_EVENT_CONFLICT
409 ACTIVE_RULE_VERSION_CHANGED
409 RULE_VERSION_IMMUTABLE
409 REVIEW_LEASE_CONFLICT
409 REVIEW_TERMINAL
409 ROLLBACK_TARGET_INVALID
400 RULE_INVALID
400 SCORE_OVERFLOW
400 INVALID_REQUEST
```

Durable Work is exactly
`{workId:uuid,kind:RISK_ASSESSMENT|REVIEW_EXPIRY|AUDIT_DELIVERY,aggregateId:uuid,state:PENDING|LEASED|SUCCEEDED|FAILED|CANCELLED,terminal:boolean,attempt:int,leaseOwner:string|null,leaseExpiresAt:timestamp|null}`.

## Seed and verification snapshot

Seed is exactly:

```json
{"schemaVersion":1,"seedVersion":"...","importedAt":"...","tenants":[],"ruleSets":[],"ruleVersions":[],"riskEvents":[],"assessments":[],"ruleHits":[],"reviewCases":[],"reviewDecisions":[],"ruleRollbacks":[],"auditEntries":[]}
```

Import is atomic. Exact version and digest replay is a no-op; same version with another digest is
`SEED_VERSION_CONFLICT`. Snapshot `resources` contains exactly the listed arrays, plus resources introduced by
any later published change only after its migration. Arrays are complete and sorted by public identity or tenant audit sequence. Snapshot
also exposes `work` and ordered `events`, but never raw provider payloads, secrets, private paths, or hidden data.

## Required UI and project tests

The production React UI must expose tenant/rule/version management, event submission, Assessment explanation,
review queue and decision, rollback confirmation, audit verification, loading/empty/error states, and visible
stable error codes. At least one real Chromium flow activates a rule version, submits an event, waits for its
Assessment, completes review when needed, and performs rollback.

Unit tests cover canonical scoring and boundaries. Integration uses real PostgreSQL and HTTP. Browser E2E uses
production build and Chromium. Concurrency starts at least two API and two Worker processes. Recovery uses a
barrier and real `SIGKILL`. Performance runs the exact three scenarios below and then verifies all invariants:

1. `risk-event-ingest`: 100,000 unique events, concurrency 96, at least 300 accepted/s, p95 <= 300ms, 0 5xx.
2. `hot-subject-review`: 20,000 events across 100 hot subjects with review claims/decisions, concurrency 64,
   at least 180 terminal decisions/s, p95 <= 700ms, no duplicate decisions or cross-tenant state.
3. `rollback-boundary-recovery`: 10,000 RiskEvents split across one rollback commit, two claimed Workers
   `SIGKILL`ed and four replacements; drain within 90 seconds, with every Assessment frozen to the version
   active at its acceptance boundary and intact audit/event chains.

`npm run test:all` runs every non-performance gate. `npm run test:perf` runs all three sustained scenarios at
full published scale and fails on threshold or post-load invariant failure.

## Out of scope

Machine-learning training, opaque external model APIs, payment capture, credit reporting, biometric identity,
graph databases, cross-tenant rule sharing, automatic punishment, and arbitrary executable rule expressions.

## Successful response contracts

Successful response contracts are closed:

- A mutation route without a literally stated success status returns 200.
- Unless a route literally publishes another object, array, or empty body, a success described by a named resource, named resource state, or named resource fields returns that exact resource shape at the JSON top level. Any response-only fields literally named by the route are additional top-level fields.
- If a mutation publishes no success body, it returns the exact current shape of the single primary resource created or changed by that route at the JSON top level.
- When a route explicitly returns multiple named resources, the body is one object keyed by their lower-camel resource names unless the route publishes another literal shape.
- Wrappers such as `{data:...}`, `{result:...}`, or an extra single-resource envelope are invalid unless the route literally declares them. OpenAPI must publish the same success status and closed response schema as runtime.

## Additional product requirements — required in the same final system

新增 RemediationRun 与 append-only AssessmentCorrection。
本消息是完整公开合同。
RuleVersion 回滚后才可创建；
创建事务冻结 tenantId、被回滚的 fromRuleVersionId、当前恢复的 toRuleVersionId、闭区间 occurredFrom/occurredTo 和当时符合条件的全部 Assessment IDs；
REMEDIATION_RECHECK Work.aggregateId=remediationRunId。
Worker 使用恢复版本重算，结果改变或相同都为每个冻结 Assessment append 恰好一条结果，不得修改原 RiskEvent、Assessment、RuleHit、ReviewDecision 或 AuditEntry。
RemediationRun = {remediationRunId:uuid,tenantId:uuid,fromRuleVersionId:uuid,toRuleVersionId:uuid,occurredFrom:timestamp,occurredTo:timestamp,state:PENDING|RUNNING|COMPLETED|CANCELLED,totalCount:int,completedCount:int,correctionCount:int,noChangeCount:int,createdAt:timestamp,completedAt:timestamp|null,cancelledAt:timestamp|null}。
AssessmentCorrection = {assessmentCorrectionId:uuid,remediationRunId:uuid,assessmentId:uuid,outcome:CORRECTED|NO_CHANGE,oldDecision:APPROVE|BLOCK,newDecision:APPROVE|REVIEW|BLOCK,reason:string,newRuleHitsDigest:sha256,createdAt:timestamp}。
completedCount=correctionCount+noChangeCount<=totalCount；
仅全部冻结项有结果时 COMPLETED。
取消置为 CANCELLED，只取消未开始 Work，已提交结果保留；
取消与最后提交竞争只能序列化为 COMPLETED 或 CANCELLED。
公开接口：POST /api/v1/remediation-runs，body {tenantId,fromRuleVersionId,toRuleVersionId,occurredFrom,occurredTo}，返回 201 RemediationRun；
GET /api/v1/remediation-runs/:runId，返回 200 {run:RemediationRun,corrections:[AssessmentCorrection]}；
POST /api/v1/remediation-runs/:runId/cancel，body {}，返回 200 RemediationRun。
所有 mutation 继承 V1 Idempotency-Key、严格未知字段拒绝和稳定错误 envelope。
新增穷举错误：409 REMEDIATION_VERSION_MISMATCH、409 REMEDIATION_RUN_TERMINAL、400 REMEDIATION_RANGE_INVALID、400 INVALID_REQUEST；
缺失 ID 为 404 NOT_FOUND。
UI 提供创建、进度、差异、取消和结果明细；
并发创建、取消、Worker SIGKILL 和旧 lease 不得重复 correction 或越过 cancel fence。


