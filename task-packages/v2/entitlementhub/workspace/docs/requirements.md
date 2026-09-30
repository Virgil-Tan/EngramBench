# EntitlementHub — Complete system requirements

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

# EntitlementHub

Build EntitlementHub from this intentionally blank repository. README.md and AGENTS.md are the complete public contract.

## Required stack and commands

Use Node.js 22, TypeScript, React, PostgreSQL 16, npm, and installed Chromium. PostgreSQL is the sole authority for
plans, subscriptions, provider events, refunds, grants, access decisions, revocation fences, idempotency, Work, and
events. The production UI uses only the public HTTP API.

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

Commands are non-interactive, return truthful nonzero failure codes, and clean children. Environment variables are
`DATABASE_URL`, `TEST_DATABASE_URL`, `PORT` (default `3000`), `ADMIN_TOKEN`, `WEBHOOK_URL`,
`WORK_LEASE_SECONDS` (default `3`), `PROVIDER_BASE_URL`, `TEST_BARRIER_URL`, and `TEST_BARRIER_TOKEN`.

## Product boundary and canonical states

EntitlementHub converts tenant-scoped subscription lifecycle into externally queryable feature access. It supports
frozen PlanRevision terms, one trial per subject and plan family, upgrades, scheduled downgrades, expiration, refunds,
duplicate/reordered provider callbacks, monotonic revocation, audit history, and a production UI. A local provider
double is used; no real payment network or credentials are allowed.

```text
Subscription: PENDING -> TRIALING | ACTIVE | FAILED
              TRIALING -> ACTIVE | CANCELLED | EXPIRED
              ACTIVE -> PAST_DUE | CANCELLED | EXPIRED | REFUNDED
              PAST_DUE -> ACTIVE | CANCELLED | EXPIRED
PlanChange: REQUESTED -> APPLIED | SCHEDULED | REJECTED | CANCELLED
Refund: REQUESTED -> SUCCEEDED | FAILED | UNKNOWN
EntitlementView: ENABLED | DISABLED
```

Database time controls trial, period, grace, expiry, refund eligibility, and leases. Money uses integer minor units and
ISO currency; floating point is forbidden. A PlanRevision freezes price, currency, billing interval, feature names,
limits, trial duration, grace duration, and refundable window.

## Exact public shapes

`uuid` is lowercase RFC 4122, `timestamp` is UTC ISO-8601 with milliseconds and `Z`, and unlisted fields are rejected.

```text
PlanRevision = {planRevisionId:uuid,planId:uuid,revision:int,state:DRAFT|PUBLISHED|RETIRED,priceMinor:int,currency:string,interval:MONTH|YEAR,features:json,trialDays:int,graceDays:int,refundDays:int,createdAt:timestamp,publishedAt:timestamp|null}
Subscription = {subscriptionId:uuid,tenantId:uuid,subjectId:string,planRevisionId:uuid,state:string,periodStart:timestamp,periodEnd:timestamp,trialEndsAt:timestamp|null,cancelAtPeriodEnd:boolean,pendingPlanRevisionId:uuid|null,revocationVersion:int,createdAt:timestamp,terminalAt:timestamp|null,sequence:int}
PlanChange = {changeId:uuid,subscriptionId:uuid,fromPlanRevisionId:uuid,toPlanRevisionId:uuid,kind:UPGRADE|DOWNGRADE,state:REQUESTED|APPLIED|SCHEDULED|REJECTED|CANCELLED,effectiveAt:timestamp,amountMinor:int,createdAt:timestamp}
Refund = {refundId:uuid,subscriptionId:uuid,providerRequestId:string,amountMinor:int,currency:string,state:REQUESTED|SUCCEEDED|FAILED|UNKNOWN,createdAt:timestamp,resolvedAt:timestamp|null}
ProviderEvent = {providerEventId:string,providerRequestId:string,kind:SUBSCRIPTION|REFUND,outcome:SUCCEEDED|FAILED|UNKNOWN,occurredAt:timestamp}
EntitlementGrant = {grantId:uuid,subscriptionId:uuid,feature:string,limit:int|null,validFrom:timestamp,validUntil:timestamp|null,grantRevision:int}
EntitlementView = {tenantId:uuid,subjectId:string,feature:string,state:ENABLED|DISABLED,limit:int|null,subscriptionId:uuid|null,revocationVersion:int,evaluatedAt:timestamp}
```

## Lifecycle and conservation rules

1. A subject may consume one trial per `planId` across all revisions. Concurrent trial requests create at most one
   Subscription and one trial-consumption identity. Cancelling or refunding never restores trial eligibility.
2. Starting or renewing freezes a published PlanRevision for that period. Later plan edits cannot change prior price,
   features, limit, trial, grace, or refund terms.
3. Upgrade applies immediately: the current grant is closed, deterministic integer proration is recorded, a new grant
   starts at the same database timestamp, and revocationVersion increments atomically. There is never a gap or overlap.
4. Downgrade is scheduled for `periodEnd`; only the latest accepted pending downgrade applies. Concurrent cancel,
   renewal, provider callback, and downgrade produce one serializable result.
5. Refund successful amount across all Refunds cannot exceed the charge for the frozen period. Full refund immediately
   makes the Subscription `REFUNDED` and disables all features. Partial refund does not change access unless the public
   PlanRevision refund policy says full-refund revocation; V1 policy is full refund only.
6. `UNKNOWN` refund is unresolved, reserves its amount, and must be reconciled before another refund can exceed the
   remaining amount. Duplicate or reordered provider events converge by provider event ID and request ID.
7. Cancellation, expiry, full refund, subject suspension, or plan retirement increments a monotonic revocation fence in
   the same transaction as access removal, AuditEntry, Work, and DomainEvent. A stale cache may never re-enable access.

## Access decision contract

`GET /api/v1/entitlements/check` receives tenantId, subjectId, feature, and optional `knownRevocationVersion`. It returns
the exact EntitlementView. If the known version is behind the subject's required fence, any local cache is bypassed.
Revocation must be externally visible to all API processes within 2 seconds. Duplicate or reordered propagation applies
only greater versions. List responses are stable `{items,nextCursor}`.

Every mutation requires durable `Idempotency-Key` scoped by tenant, method, canonical path, and key. Unknown HTTP
outcome, 20-way replay, process restart, and another API process must return the saved status and JSON without a second
subscription, refund, grant, audit record, Work item, or event.

## Public HTTP surface

```text
POST /api/v1/tenants
POST /api/v1/plans
POST /api/v1/plans/:planId/revisions
POST /api/v1/plan-revisions/:planRevisionId/publish
POST /api/v1/subscriptions
GET  /api/v1/subscriptions/:subscriptionId
POST /api/v1/subscriptions/:subscriptionId/change-plan
POST /api/v1/subscriptions/:subscriptionId/cancel
POST /api/v1/subscriptions/:subscriptionId/refunds
POST /api/v1/provider/events
POST /api/v1/refunds/:refundId/reconcile
GET  /api/v1/entitlements/check?tenantId&subjectId&feature&knownRevocationVersion
GET  /api/v1/entitlements?tenantId&subjectId&limit&cursor
POST /api/v1/admin/expire-due
GET  /api/v1/audit?tenantId&limit&cursor
GET  /api/v1/verification-snapshot
```

Serve OpenAPI 3.1 at `/openapi.json` and health at `/healthz`. Errors are
`{"error":{"code":"STABLE_CODE","message":"...","details":{}}}`. Exhaustive semantic errors:

```text
400 INVALID_SUBSCRIPTION  400 INVALID_PLAN_CHANGE  400 INVALID_REFUND  400 INVALID_REQUEST  400 MALFORMED_JSON
409 TRIAL_ALREADY_CONSUMED  409 PLAN_REVISION_CHANGED  409 SUBSCRIPTION_TERMINAL
409 PENDING_PROVIDER_RESULT  409 REFUND_LIMIT_EXCEEDED  409 REVOCATION_FENCE_STALE
409 IDEMPOTENCY_CONFLICT  404 NOT_FOUND
```

## Seed, Work, events, and snapshot

Seed shape is exactly:

```json
{"schemaVersion":1,"seedVersion":"...","tenants":[],"plans":[],"planRevisions":[],"subscriptions":[],"trialConsumptions":[],"planChanges":[],"refunds":[],"providerEvents":[],"entitlementGrants":[],"revocationFences":[],"auditEntries":[]}
```

Seed is one transaction; same version+digest replays, changed digest conflicts, unknown members and invalid references
reject everything. V1 Work kinds are `SUBSCRIPTION_ACTIVATE`, `PLAN_CHANGE_APPLY`, `SUBSCRIPTION_EXPIRE`,
`REFUND_RECONCILE`, `ENTITLEMENT_REVOKE`, and `EVENT_DELIVERY`. Workers fence final commits. Events include
`subscription.started`, `subscription.changed`, `subscription.cancelled`, `subscription.expired`, `refund.succeeded`,
and `entitlement.revoked`; at-least-once retry preserves identity and byte body.

The admin snapshot contains complete sorted V1 resources named exactly as the seed arrays, plus events and Work. It
excludes raw provider credentials, access tokens, private paths, and in-process cache contents.

## UI and project-owned tests

The production React UI must publish plans, start trial/subscription, upgrade/downgrade, cancel, refund/reconcile,
inspect current entitlements and revocation version, and browse audit history through the real API.

Unit covers periods, proration, refund bound, and feature resolution. Integration uses real PostgreSQL and HTTP.
Chromium drives the production build. Concurrency starts two APIs and two Workers. Recovery uses claimed and response
barriers with real `SIGKILL`. `test:all` runs non-performance gates; `test:perf` runs all fixed loads plus invariants.

## Published performance gates

Formal scoring uses fixed Linux arm64 with `BENCH_PERF_SCALE=1`; scaled runs are smoke only.

1. `entitlement-decision-read`: 100,000 subjects, 80% enabled and 20% disabled/stale-fence checks, 128 clients for
   60 seconds; >= 1,500 check/s, p95 <= 100ms, zero stale allow and zero unexpected 5xx.
2. `upgrade-refund-race`: 20,000 subscriptions, two APIs, 64 concurrent upgrade/downgrade/cancel/refund operations;
   >= 100 mutation/s, p95 <= 750ms, no overlapping grants, excess refund, duplicate trial, or version regression.
3. `expiry-revocation-recovery`: 50,000 due subscriptions; kill two claimed workers at observable barriers, wait for
   lease expiry, and recover with four workers in <= 90 seconds; every expired subject is disabled on all API processes within 2 seconds.

After each load, recompute frozen-term usage, trial uniqueness, period/refund conservation, grant interval non-overlap,
revocation monotonicity, audit/event sequence, tenant isolation, and Work drain.

## Out of scope

Tax, invoices, payment capture, coupons, usage metering, real card networks, RBAC/ABAC policy, cross-tenant grants,
cryptographic license files, and arbitrary expression evaluation are out of scope.

## Successful response contracts

Successful response contracts are closed:

- A mutation route without a literally stated success status returns 200.
- Unless a route literally publishes another object, array, or empty body, a success described by a named resource, named resource state, or named resource fields returns that exact resource shape at the JSON top level. Any response-only fields literally named by the route are additional top-level fields.
- If a mutation publishes no success body, it returns the exact current shape of the single primary resource created or changed by that route at the JSON top level.
- When a route explicitly returns multiple named resources, the body is one object keyed by their lower-camel resource names unless the route publishes another literal shape.
- Wrappers such as `{data:...}`, `{result:...}`, or an extra single-resource envelope are invalid unless the route literally declares them. OpenAPI must publish the same success status and closed response schema as runtime.

## Additional product requirements — required in the same final system

增加组织席位 EntitlementPool。
Subscription 创建请求兼容新增可选 subscriptionKind: INDIVIDUAL | ORGANIZATION；
V1 历史和省略字段按 INDIVIDUAL 解释。
只有 ORGANIZATION 订阅可创建 Pool；
Pool 冻结 subscriptionId、feature、初始 seatLimit 和当前 period，初始 seatLimit 不得超过 PlanRevision feature limit，个人订阅保持个人订阅语义。
Pool 状态为 ACTIVE | OVER_LIMIT | REVOKED | EXPIRED。
公开形状为 EntitlementPool = {poolId:uuid,tenantId:uuid,subscriptionId:uuid,feature:string,seatLimit:int,state:string,version:int,periodStart:timestamp,periodEnd:timestamp,createdAt:timestamp} 与 SeatAssignment = {poolId:uuid,subjectId:string,state:ACTIVE|REVOKED|EXPIRED,assignedAt:timestamp,terminalAt:timestamp|null}；
FINAL snapshot 使用 entitlementPools 与 seatAssignments。
POST /api/v1/entitlement-pools 使用 {tenantId:uuid,subscriptionId:uuid,feature:string,seatLimit:int} 并返回 EntitlementPool；
POST /api/v1/entitlement-pools/:poolId/assignments 使用 {subjectId:string,expectedPoolVersion:int}，POST /api/v1/entitlement-pools/:poolId/assignments/:subjectId/revoke 使用 {expectedPoolVersion:int}，两者返回 {pool:EntitlementPool,assignment:SeatAssignment}；
GET /api/v1/entitlement-pools/:poolId/assignments 返回 {items:[SeatAssignment],nextCursor:string|null}。
Pool version 从 0 开始，每次成功分配或撤销加 1，三个 mutation 都要求 durable Idempotency-Key。
同一 Pool subject 唯一且 ACTIVE 不超过 seatLimit。
upgrade/downgrade 按新 feature limit 调整 seatLimit；
退款、取消、过期撤销 Pool；
超限进入 OVER_LIMIT，不新增、不任意驱逐，显式撤销至合法后恢复 ACTIVE。
稳定错误为 409 ORGANIZATION_SUBSCRIPTION_REQUIRED、409 POOL_VERSION_CHANGED、409 POOL_CAPACITY_EXCEEDED、409 POOL_OVER_LIMIT、409 POOL_TERMINAL、409 SEAT_ALREADY_ASSIGNED、409 IDEMPOTENCY_CONFLICT 和 404 NOT_FOUND，并使用 V1 JSON error envelope。
两 API 最后席位与 Subscription revoke/expire 竞争须串行化；
Pool 调整与撤权分别使用公开 Work kind POOL_RECONCILE 和 POOL_REVOKE，aggregateId = poolId。
撤权两秒内可见且旧传播不能重启用。

更新 OpenAPI、Worker、production UI 和所有测试。

