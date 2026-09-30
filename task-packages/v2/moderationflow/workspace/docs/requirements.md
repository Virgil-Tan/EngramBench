# ModerationFlow — Complete system requirements

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

# ModerationFlow

Build ModerationFlow from this intentionally blank repository. This README is the complete public product
contract. Ask before making a product choice that the contract does not settle.

## Stack, authority, commands, and environment

Use Node.js 22, TypeScript, React, PostgreSQL 16, npm, and preinstalled Chromium. PostgreSQL is authoritative
for content, evidence, policies, cases, review stages, decisions, appeals, idempotency, leases, events, audit,
and ordering. The production UI uses only the public HTTP API.

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

Commands are non-interactive, exit non-zero on failure, and clean children. `PORT` defaults to 3000. Required
runtime variables are `DATABASE_URL`, `TEST_DATABASE_URL`, `ADMIN_TOKEN`, `WEBHOOK_URL`,
`WORK_LEASE_SECONDS` (1..30), `TEST_BARRIER_URL`, and `TEST_BARRIER_TOKEN`. Secrets, raw private evidence,
credentials, and private paths never appear in response, Event, AuditEntry, snapshot, UI, or logs.

## Domain model and states

ModerationFlow receives a ContentItem and initial EvidenceVersion, freezes the current PolicyVersion, and
creates a ModerationCase. A Worker opens LEVEL_1. A reviewer may ALLOW, RESTRICT, REMOVE, or ESCALATE; ESCALATE
opens LEVEL_2, whose decision is final. A final decision may be appealed once, creating a distinct APPEAL stage
that references but never edits the challenged decision. Evidence and policy histories are immutable.

```text
Tenant, Policy, PolicyVersion, ContentItem, EvidenceVersion, ModerationCase,
ReviewStage, ModerationDecision, Appeal, AuditEntry, AuditCheckpoint, OutboxEvent, Work

ModerationCase: QUEUED -> IN_REVIEW -> DECIDED | CANCELLED | FAILED
ReviewStage:     OPEN -> CLAIMED -> DECIDED | EXPIRED
Appeal:          FILED -> IN_REVIEW -> UPHELD | OVERTURNED | REJECTED
```

`uuid` is lowercase RFC 4122, `timestamp` is UTC ISO-8601 with milliseconds and `Z`, `sha256` is 64 lowercase
hex, and integers are JSON safe.

```text
ContentItem = {contentItemId:uuid,tenantId:uuid,externalContentId:string,contentType:POST|COMMENT|IMAGE|VIDEO,bodyDigest:sha256,text:string|null,createdAt:timestamp,sequence:int}
EvidenceVersion = {evidenceVersionId:uuid,contentItemId:uuid,version:int,kind:SUBMISSION|CONTEXT|REPORT|EXPERT_NOTE,digest:sha256,summary:string,createdBy:string,createdAt:timestamp}
PolicyVersion = {policyVersionId:uuid,policyId:uuid,version:int,state:DRAFT|ACTIVE|SUPERSEDED|REVOKED,categories:[{categoryCode:string,severity:int,level1Action:ALLOW|RESTRICT|REMOVE|ESCALATE}],createdAt:timestamp,activatedAt:timestamp|null}
ModerationCase = {caseId:uuid,contentItemId:uuid,policyVersionId:uuid,evidenceHeadVersion:int,state:QUEUED|IN_REVIEW|DECIDED|CANCELLED|FAILED,finalDecisionId:uuid|null,createdAt:timestamp,decidedAt:timestamp|null,sequence:int}
ReviewStage = {stageId:uuid,caseId:uuid,level:LEVEL_1|LEVEL_2|APPEAL,state:OPEN|CLAIMED|DECIDED|EXPIRED,assigneeId:string|null,leaseExpiresAt:timestamp|null,openedAt:timestamp,closedAt:timestamp|null,revision:int}
ModerationDecision = {decisionId:uuid,stageId:uuid,outcome:ALLOW|RESTRICT|REMOVE|ESCALATE,categoryCode:string,reason:string,reviewerId:string,evidenceHeadVersion:int,policyVersionId:uuid,createdAt:timestamp}
Appeal = {appealId:uuid,caseId:uuid,challengedDecisionId:uuid,reason:string,evidenceHeadVersion:int,state:FILED|IN_REVIEW|UPHELD|OVERTURNED|REJECTED,appealDecisionId:uuid|null,createdAt:timestamp,resolvedAt:timestamp|null}
AuditEntry = {auditEntryId:uuid,tenantId:uuid,sequence:int,eventType:string,subjectRef:string,payloadDigest:sha256,priorDigest:sha256|null,digest:sha256,createdAt:timestamp}
```

## Policy, evidence, and review rules

1. A tenant Policy has exactly one ACTIVE immutable PolicyVersion. Categories are unique, severity is 0..100,
   and activation requires at least one category. Activation and case acceptance serialize.
2. Case creation freezes current PolicyVersion and current EvidenceVersion head in the same transaction as Work,
   Event, and AuditEntry. Later policy/evidence versions do not silently change an existing stage.
3. Evidence versions are append-only, contiguous per ContentItem, and limited to a 4 KiB summary plus digest.
   An EvidenceVersion can be added only while a case or Appeal is non-terminal. Concurrent append with the same
   expected head has one winner; a gap or stale head is `EVIDENCE_HEAD_CHANGED`.
4. Every decision records exactly which evidence head and policy version it used. It cannot cite a future,
   missing, or cross-tenant version. A decision does not mutate ContentItem, EvidenceVersion, or PolicyVersion.
5. LEVEL_1 ESCALATE opens exactly one LEVEL_2 stage. Other LEVEL_1 outcomes are final. LEVEL_2 cannot ESCALATE.
6. Stage claim is a bounded database lease; only the fenced current owner can decide. Competing outcomes produce
   one terminal Decision. Stale owners return `REVIEW_LEASE_CONFLICT` without partial effects.
7. A final case can be appealed once within 30 days. Appeal freezes the then-current evidence head and challenged
   Decision; its stage may UPHOLD or OVERTURN by appending a new final Decision, never editing the old one.
8. Duplicate `externalContentId` with the same canonical submission returns the same item/case; changed content is
   `EXTERNAL_CONTENT_CONFLICT`.

## Audit, idempotency, recovery, and events

Every mutation requires `Idempotency-Key` scoped by method and canonical path. Exact replay, concurrent replay,
lost response, and API restart return the original status/body. Changed payload is `IDEMPOTENCY_CONFLICT`.

Every security or moderation transition appends one immutable AuditEntry in the same transaction. The digest is
SHA-256 over canonical public fields including prior digest; tenant sequence is contiguous. Verification detects
deletion, insertion, reordering, or mutation. Audit payloads never contain raw private evidence.

Workers use bounded leases and fenced commits. Required event types are `content.accepted`, `evidence.appended`,
`review.opened`, `review.decided`, `appeal.filed`, `appeal.resolved`, `policy.activated`. Dispatch is at least once;
retry preserves Event ID, aggregate sequence, and canonical body.

Durable Work is exactly
`{workId:uuid,kind:CASE_OPEN|STAGE_EXPIRY|APPEAL_OPEN|AUDIT_DELIVERY,aggregateId:uuid,state:PENDING|LEASED|SUCCEEDED|FAILED|CANCELLED,terminal:boolean,attempt:int,leaseOwner:string|null,leaseExpiresAt:timestamp|null}`.

## Public HTTP surface

```text
POST /api/v1/tenants
POST /api/v1/policies
POST /api/v1/policies/:policyId/versions
POST /api/v1/policy-versions/:policyVersionId/activate
POST /api/v1/content-items
POST /api/v1/content-items/:contentItemId/evidence-versions
GET  /api/v1/moderation-cases/:caseId
GET  /api/v1/review-stages?state&level&limit&cursor
POST /api/v1/review-stages/:stageId/claim
POST /api/v1/review-stages/:stageId/decisions
POST /api/v1/moderation-cases/:caseId/appeals
POST /api/v1/appeals/:appealId/decision
GET  /api/v1/audit/verify
GET  /api/v1/audit?limit&cursor
GET  /api/v1/verification-snapshot
```

Serve OpenAPI 3.1 at `/openapi.json` and health at `/healthz`. Reject malformed JSON, unsupported media type,
unknown fields, invalid UUID/time/digest, unsafe integers, and cross-tenant references. JSON errors are
`{"error":{"code":"STABLE_CODE","message":"...","details":{}}}`. Collections use `{items,nextCursor}`.

Exhaustive semantic errors for well-formed requests:

```text
409 IDEMPOTENCY_CONFLICT
409 EXTERNAL_CONTENT_CONFLICT
409 ACTIVE_POLICY_VERSION_CHANGED
409 POLICY_VERSION_IMMUTABLE
409 EVIDENCE_HEAD_CHANGED
409 REVIEW_LEASE_CONFLICT
409 REVIEW_TERMINAL
409 APPEAL_ALREADY_EXISTS
409 APPEAL_WINDOW_CLOSED
400 POLICY_INVALID
400 EVIDENCE_INVALID
400 INVALID_REQUEST
```

## Seed, snapshot, UI, and project verification

Seed is exactly:

```json
{"schemaVersion":1,"seedVersion":"...","importedAt":"...","tenants":[],"policies":[],"policyVersions":[],"contentItems":[],"evidenceVersions":[],"moderationCases":[],"reviewStages":[],"moderationDecisions":[],"appeals":[],"auditEntries":[],"auditCheckpoints":[]}
```

Import is atomic; exact version+digest replay is a no-op and changed digest is `SEED_VERSION_CONFLICT`.
Verification snapshot contains exactly these resource arrays, plus resources introduced by any later published
change only after its migration, complete and deterministically sorted, alongside `work` and `events`. It excludes
private evidence bodies and secrets.

The production React UI provides policy versions/activation, submission, evidence timeline, queues, claim and
decision, appeal, audit verification, stable errors, loading/empty states, and accessible controls. A real
Chromium flow submits content, appends evidence, completes multi-level review, files and resolves an Appeal.

Project-owned Unit, real PostgreSQL Integration, production Chromium E2E, two-process Concurrency, barrier plus
SIGKILL Recovery, Aggregate, and Performance commands are mandatory. Performance uses the fixed environment of
4 vCPU, 8 GiB RAM, PostgreSQL 16, four APIs and four Workers:

1. `moderation-ingest`: 50,000 submissions, concurrency 96, >= 250 accepted/s, p95 <= 350ms, 0 5xx.
2. `evidence-appeal-contention`: 20,000 evidence append/review/Appeal operations, concurrency 64,
   >= 150 terminal operations/s, p95 <= 800ms, no duplicate stages or decisions.
3. `policy-boundary-recovery`: 10,000 Cases split across one Policy activation, two claimed Workers killed and
   four replacements, drain <= 90 seconds with every Case frozen to the PolicyVersion active at acceptance and
   an intact audit chain.

After every load, recompute version references, stage/decision uniqueness, appeal lineage, tenant isolation,
audit digests, Event order, and terminal Work. `test:all` runs all non-performance gates; `test:perf` runs all
three full-scale scenarios.

## Out of scope

Machine-learning classifiers, image recognition, real third-party moderation providers, arbitrary executable
policies, public social feeds, copyright adjudication, law-enforcement integrations, and cross-tenant review.

## Successful response contracts

Successful response contracts are closed:

- A mutation route without a literally stated success status returns 200.
- Unless a route literally publishes another object, array, or empty body, a success described by a named resource, named resource state, or named resource fields returns that exact resource shape at the JSON top level. Any response-only fields literally named by the route are additional top-level fields.
- If a mutation publishes no success body, it returns the exact current shape of the single primary resource created or changed by that route at the JSON top level.
- When a route explicitly returns multiple named resources, the body is one object keyed by their lower-camel resource names unless the route publishes another literal shape.
- Wrappers such as `{data:...}`, `{result:...}`, or an extra single-resource envelope are invalid unless the route literally declares them. OpenAPI must publish the same success status and closed response schema as runtime.

## Additional product requirements — required in the same final system

新增 PolicyRecallRun 与 append-only Reconsideration。
本消息是完整公开合同。
recalledPolicyVersionId 必须是该 tenant 已被替代或撤销的版本，replacementPolicyVersionId 必须是同一 Policy 当前 ACTIVE 版本。
创建事务冻结闭区间 decidedFrom/decidedTo 内使用 recalled version 的全部终态 Case ID、finalDecisionId 和 evidenceHeadVersion；
replacement 缺少任一冻结 Decision.categoryCode 时整批以 POLICY_RECALL_POLICY_INCOMPATIBLE 拒绝。
POLICY_RECALL Work.aggregateId=policyRecallRunId。
Worker 以 replacement category.level1Action 生成 suggestedOutcome；
每个冻结 Case append 恰好一条 Reconsideration。
建议改变才创建恰好一个 RECONSIDERATION ReviewStage，人工只能决定 ALLOW、RESTRICT 或 REMOVE；
建议相同记录 NO_CHANGE 且不创建 Stage。
不得改写原 Case、Stage、Decision、Appeal、EvidenceVersion 或 AuditEntry。
PolicyRecallRun = {policyRecallRunId:uuid,tenantId:uuid,recalledPolicyVersionId:uuid,replacementPolicyVersionId:uuid,decidedFrom:timestamp,decidedTo:timestamp,state:PENDING|RUNNING|COMPLETED|CANCELLED,totalCount:int,completedCount:int,changedCount:int,noChangeCount:int,createdAt:timestamp,completedAt:timestamp|null,cancelledAt:timestamp|null}。
Reconsideration = {reconsiderationId:uuid,policyRecallRunId:uuid,caseId:uuid,evidenceHeadVersion:int,oldDecisionId:uuid,oldOutcome:ALLOW|RESTRICT|REMOVE,suggestedOutcome:ALLOW|RESTRICT|REMOVE|ESCALATE,replacementPolicyVersionId:uuid,outcome:CHANGED|NO_CHANGE,reason:string,reconsiderationStageId:uuid|null,createdAt:timestamp}。
FINAL 将 ReviewStage.level 扩展为 LEVEL_1|LEVEL_2|APPEAL|RECONSIDERATION。
completedCount=changedCount+noChangeCount<=totalCount。
取消只阻止未开始 Work，已提交 Reconsideration 和 Stage 保留；
取消与最后提交竞争只能序列化为 COMPLETED 或 CANCELLED。
公开接口：POST /api/v1/policy-recall-runs，body {tenantId,recalledPolicyVersionId,replacementPolicyVersionId,decidedFrom,decidedTo}，返回 201 PolicyRecallRun；
GET /api/v1/policy-recall-runs/:runId，返回 200 {run:PolicyRecallRun,reconsiderations:[Reconsideration]}；
POST /api/v1/policy-recall-runs/:runId/cancel，body {}，返回 200 PolicyRecallRun。
所有 mutation 继承 V1 Idempotency-Key、未知字段拒绝和稳定错误 envelope。
新增穷举错误：409 POLICY_RECALL_VERSION_MISMATCH、409 POLICY_RECALL_RUN_TERMINAL、409 POLICY_RECALL_POLICY_INCOMPATIBLE、400 POLICY_RECALL_RANGE_INVALID、400 INVALID_REQUEST；
缺失 ID 为 404 NOT_FOUND。
UI 提供 Recall 创建、进度、差异、取消、Reconsideration 和人工确认；
并发创建、取消、Worker SIGKILL 和旧 lease 不得重复结果或越过 fence。


