# AccessSentinel

Build a production-style privileged-access control plane from this intentionally blank repository. The system accepts device and location evidence, rotates user sessions, evaluates each privileged access request against immutable policy and risk revisions, obtains independent human review when required, issues a short-lived grant, revokes it immediately when authority changes, and records every security transition in a tamper-evident audit chain with transactional event delivery.

`README.md` and `AGENTS.md` are the complete public contract. Use Node.js 22, TypeScript, PostgreSQL 16, and a real browser UI. Do not use an in-memory database or a production runtime that depends on a test process.

## Published lifecycle

`package.json` must provide these commands:

- `build`
- `db:migrate`
- `db:seed -- --file <path>`
- `start:api`
- `start:worker`
- `start:dispatcher`
- `test:unit`
- `test:integration`
- `test:e2e`
- `test:concurrency`
- `test:recovery`
- `test:perf`
- `test:all`

`npm ci`, `npm run build`, repeated `db:migrate`, strict seed replay, and all three production roles must work from a clean checkout. The UI served by `start:api` must be a built production application, not a development server or placeholder page.

Runtime configuration:

- `DATABASE_URL`, `TEST_DATABASE_URL`
- `PORT`, `ADMIN_TOKEN`, `WEBHOOK_URL`
- `WORK_LEASE_SECONDS`
- `CHROMIUM_PATH`
- `MANAGED_DATA_ROOT`
- `TEST_BARRIER_URL`, `TEST_BARRIER_TOKEN`

## HTTP rules

All routes are under `/api/v1` except `/healthz`, `/openapi.json`, and `/`. `/openapi.json` is OpenAPI 3.1 and describes every route, exact request, response, status, and stable error code.

Every mutation requires `Idempotency-Key`. The first committed status and JSON response are replayed byte-for-byte across concurrent API processes and restarts. Reusing a key with a different canonical request returns `409 IDEMPOTENCY_CONFLICT` with no side effect. Unknown JSON fields, invalid UUIDs, invalid enum values, and missing required fields return `400 INVALID_REQUEST`; malformed JSON returns `400 MALFORMED_JSON`. Authorization or tenant mismatch returns a stable `403` without revealing whether a foreign resource exists. Collection order is deterministic.

Errors use:

```json
{"error":{"code":"STABLE_CODE","message":"human-readable message","details":{}}}
```

Use RFC 8785 canonical JSON wherever a digest is required. Timestamps are UTC RFC 3339 strings. UUIDs are lowercase canonical UUID strings. Durations and bounds are checked with integers; floating-point time or revision comparison is forbidden.

The production UI and external verifiers use these exact read routes:

- `GET /api/v1/tenants` returns `{tenants:Tenant[]}`.
- `GET /api/v1/principals?tenantId=<uuid>` returns `{principals:Principal[]}`.
- `GET /api/v1/devices?tenantId=<uuid>&principalId=<uuid?>` returns `{devices:Device[]}`; `principalId` is optional.
- `GET /api/v1/access-requests/:accessRequestId` returns `{accessRequest:AccessRequest}`.

Unknown query parameters are invalid. A known foreign identity and an unknown identity must return the same stable `403` envelope when reached through a tenant-scoped request.

## Seed contract

`db:seed` accepts exactly:

```text
schemaVersion, seedVersion, importedAt,
tenants, principals, devices, deviceTrustRevisions, sessions,
policyBundles, policyRevisions, riskModelRevisions,
locationObservations, deviceLocations,
accessRequests, riskDecisions, accessReviews, accessGrants,
revocations, auditEntries
```

Unknown top-level or nested fields, duplicate identities, broken references, invalid digests, non-contiguous revisions, overlapping active intervals, raw secrets, invalid audit links, or a conflicting `seedVersion` fail the whole import. Replaying the identical canonical seed is a no-op. Seed import never creates Events or Work.

Raw refresh tokens, device nonces, private keys, credentials, authorization headers, and administrator tokens are never accepted by seed, stored in snapshots, emitted in Events, or logged. Only SHA-256 token digests and public-key fingerprints may persist.

## V1 resources

### Identity and trust

- `Tenant={tenantId,name,revocationEpoch,createdAt}`.
- `Principal={principalId,tenantId,displayName,state,revocationEpoch,createdAt}` where `state=ACTIVE|SUSPENDED|REVOKED`.
- `Device={deviceId,tenantId,principalId,publicKeyFingerprint,state,currentTrustRevision,revocationEpoch,createdAt}` where `state=ACTIVE|REVOKED`.
- `DeviceTrustRevision={deviceTrustRevisionId,deviceId,tenantId,revision,state,assurance,validFrom,validUntil,evidenceDigest,createdAt}`. Revisions are immutable; exactly one unexpired `TRUSTED` revision may be current.
- `Session={sessionId,tenantId,principalId,deviceId,deviceTrustRevisionId,familyId,generation,refreshTokenDigest,state,expiresAt,revocationEpoch,createdAt,updatedAt}` where `state=ACTIVE|REVOKED|EXPIRED`.

`POST /api/v1/sessions` accepts `{tenantId,principalId,deviceId,deviceTrustRevisionId,requestedTtlSeconds}` where TTL is 60..3600 seconds. It creates one session and returns `{session,refreshToken}`; the raw token is shown only in this committed response. `POST /api/v1/sessions/:sessionId/refresh` accepts `{refreshToken,requestedTtlSeconds}` and atomically rotates to generation + 1. A successful refresh invalidates the prior token. Reuse of any prior token returns `409 REFRESH_TOKEN_REUSED` and atomically revokes the entire family. `POST /api/v1/sessions/:sessionId/revoke` accepts `{expectedGeneration,reason}` and is monotonic.

`POST /api/v1/devices/:deviceId/trust-revisions` accepts `{expectedRevision,assurance,validFrom,validUntil,evidenceDigest}`. Publication uses CAS and immutable revisions. Revoking a device invalidates all of its sessions and grants; a concurrent stale trust publication cannot restore it.

`POST /api/v1/devices/:deviceId/revoke`, `POST /api/v1/principals/:principalId/revoke`, and `POST /api/v1/tenants/:tenantId/revoke` each accept `{expectedEpoch,reason}`. They atomically advance exactly one monotonic epoch, append the subject Revocation and AuditEntry, and enqueue propagation. Replaying the same idempotency key returns the original response; a different key with a stale epoch returns `409 REVOCATION_EPOCH_CONFLICT`.

### Immutable policy and risk

- `PolicyBundle={policyBundleId,tenantId,name,currentRevision,currentPolicyRevisionId,createdAt}`.
- `PolicyRevision={policyRevisionId,policyBundleId,tenantId,revision,effectiveFrom,rules,digest,createdAt}`.
- `RiskModelRevision={riskModelRevisionId,tenantId,revision,effectiveFrom,lowMax,reviewMax,maxLocationAgeSeconds,maxTravelKph,digest,createdAt}`.

`POST /api/v1/policy-bundles` accepts `{tenantId,name}`. `POST /api/v1/policy-bundles/:policyBundleId/publish` accepts `{expectedRevision,effectiveFrom,rules}`. `rules` contains 1..500 items `{ruleId,effect,actions,resourcePattern,minAssurance,regions}`; arrays are unique and sorted, `effect=ALLOW|DENY`, and deny overrides allow. Publication creates revision + 1 and atomically moves the active pointer. Existing revisions are immutable. `POST /api/v1/policy-bundles/:policyBundleId/rollback` accepts `{expectedRevision,targetRevision,effectiveFrom}` and creates a new revision containing the target rules; it never edits history.

Each accepted access request freezes exactly one `policyRevisionId`, `riskModelRevisionId`, `deviceTrustRevisionId`, session generation, tenant/principal revocation epochs, and location watermark. Later publication, rollback, or late location processing cannot change its decision basis.

### Location and deterministic replay

- `LocationObservation={observationId,tenantId,deviceId,deviceSequence,observedAt,longitude,latitude,region,acceptedAt}`.
- `DeviceLocation={deviceId,tenantId,lastSequence,watermarkObservedAt,longitude,latitude,region,riskFlags,revision,updatedAt}`.

`POST /api/v1/location-observations` accepts `{tenantId,deviceId,deviceSequence,observedAt,longitude,latitude,region}`. `(deviceId,deviceSequence)` is unique and immutable. Longitude is -180..180 and latitude is -90..90. Worker processing orders by `(observedAt,deviceSequence,observationId)`, accepts late observations within ten minutes of the watermark, and deterministically rebuilds the affected device projection. Older observations become terminal with `LOCATION_TOO_LATE` and do not mutate the projection. Duplicate and out-of-order deliveries converge without gaps or duplicate risk flags.

### Request, decision, review, and grant

- `AccessRequest={accessRequestId,tenantId,principalId,deviceId,sessionId,action,resource,region,requestedTtlSeconds,justification,state,policyRevisionId,riskModelRevisionId,deviceTrustRevisionId,sessionGeneration,tenantRevocationEpoch,principalRevocationEpoch,locationWatermark,createdAt,updatedAt}` where `state=PENDING_RISK|DENIED|PENDING_REVIEW|APPROVED|GRANTED|REVOKED|EXPIRED`.
- `RiskDecision={riskDecisionId,accessRequestId,tenantId,score,level,reasons,policyEffect,inputDigest,decidedAt}` where `level=LOW|REVIEW|HIGH`. It is immutable and unique per request.
- `AccessReview={accessReviewId,accessRequestId,tenantId,reviewerId,decision,comment,createdAt}` where `decision=APPROVE|REJECT`.
- `AccessGrant={grantId,accessRequestId,tenantId,principalId,deviceId,sessionId,action,resource,region,policyRevisionId,riskDecisionId,state,notBefore,expiresAt,revocationEpoch,createdAt,updatedAt}` where `state=ACTIVE|REVOKED|EXPIRED`.
- `Revocation={revocationId,tenantId,subjectType,subjectId,epoch,reason,effectiveAt,createdAt}` where `subjectType=TENANT|PRINCIPAL|DEVICE|SESSION|GRANT|REGION`.

`POST /api/v1/access-requests` accepts `{tenantId,principalId,deviceId,sessionId,action,resource,region,requestedTtlSeconds,justification}` with grant TTL 5..900 seconds. `POST /api/v1/access-requests:batch` accepts `{requests:[...]}` with 1..100 requests and is all-or-nothing. A request against a stale, expired, revoked, foreign, or insufficient-assurance identity is rejected atomically. Successful acceptance schedules `RISK_EVALUATION` Work.

Risk evaluation begins at zero and uses the frozen RiskModel weights: add `oldSession` when Session age is greater than 1,800 seconds, `staleLocation` when location age exceeds `maxLocationAgeSeconds`, `regionMismatch` when the latest device region differs, and `impossibleTravel` when ordered observations exceed `maxTravelKph`. Reasons are sorted signal names. `score<=lowMax` is `LOW`, `score<=reviewMax` is `REVIEW`, otherwise `HIGH`. A policy deny always produces `HIGH` with `POLICY_DENY`. `RiskModelRevision` therefore also contains `weights={oldSession,staleLocation,regionMismatch,impossibleTravel}` and its digest covers all fields except `digest`.

A policy deny or `HIGH` risk denies. `LOW` risk may be granted without human review. `REVIEW` requires one independent `APPROVE`; the reviewer must be ACTIVE, in the same tenant, different from the requester, and must not review the same request twice. A rejection is terminal. `POST /api/v1/access-requests/:accessRequestId/reviews` records the review. `POST /api/v1/access-requests/:accessRequestId/grant` accepts `{expectedState}` and creates at most one exact short-lived grant. It cannot extend requested TTL or use current revisions in place of frozen revisions.

`GET /api/v1/grants/:grantId/check` returns `{grantId,active,reason,policyRevisionId,checkedAt}` and fails closed if any frozen epoch, session generation, device trust, policy authority, region authority, or expiry is stale. `POST /api/v1/grants/:grantId/revoke` accepts `{reason}`. Revocation commits the state, monotonic fence, `AuditEntry`, Domain Event, and propagation Work in one transaction. Every API process must observe revocation after the commit; a stale cache never returns `active:true`.

### Audit, Work, and Events

- `AuditEntry={auditEntryId,tenantId,sequence,occurredAt,actorType,actorId,action,subjectType,subjectId,data,previousDigest,digest}`. Sequence begins at 1 and is contiguous per tenant. `digest=SHA256(previousDigest || RFC8785(entry without digest))`. Entries are immutable, secret-free, and committed in the same transaction as the security change.
- Work uses `{workId,tenantId,kind,aggregateId,state,attempt,availableAt,leaseOwner,leaseToken,leaseExpiresAt,lastError,terminal,createdAt,updatedAt}`. `state=PENDING|LEASED|SUCCEEDED|FAILED|CANCELLED`; both lease fields are non-null exactly while leased. Workers claim with a fencing token. Completion from a killed or expired lease is ignored.
- Domain Events use `{eventId,tenantId,aggregateType,aggregateId,sequence,type,occurredAt,payload}` and sort by `(aggregateId,sequence,eventId)`. Events and state commit atomically. The dispatcher retries the identical event ID and canonical body after an unknown webhook acknowledgement.

V1 Work kinds are `RISK_EVALUATION`, `LOCATION_REPLAY`, `GRANT_EXPIRY`, `REVOCATION_PROPAGATE`, `AUDIT_CHECKPOINT`, and `EVENT_DELIVERY`.

`GET /api/v1/verification-snapshot` requires `Authorization: Bearer ${ADMIN_TOKEN}` and returns one PostgreSQL point-in-time:

```json
{"schemaVersion":1,"asOf":"...","resources":{},"work":[],"events":[],"metrics":{"databaseBytes":0}}
```

`resources` has exactly these arrays: `tenants`, `principals`, `devices`, `deviceTrustRevisions`, `sessions`, `policyBundles`, `policyRevisions`, `riskModelRevisions`, `locationObservations`, `deviceLocations`, `accessRequests`, `riskDecisions`, `accessReviews`, `accessGrants`, `revocations`, `auditEntries`. Each contains the exact public shape above and sorts by its identity (audit by tenant and sequence, policy/trust revisions by owner and revision). Work and Events use the exact shapes above. Recursively omit fields named `refreshToken`, `deviceNonce`, `privateKey`, `credential`, `authorization`, or `adminToken`, case-insensitively.

Barrier-aware worker and dispatcher code calls `TEST_BARRIER_URL` with the bearer `TEST_BARRIER_TOKEN` at `worker.claimed`, `worker.before-effect`, and `dispatcher.response-received`. This is an observability seam only; it cannot alter production semantics when unset.

## Production UI

The real UI must use the public HTTP routes and show tenants, principals, devices, sessions, immutable policy history, risk decisions and reasons, independent reviews, active/expired/revoked grants, location freshness, revocations, Work, Event delivery, and the verified Audit chain. It must support creating and rotating sessions, publishing and rolling back policy, requesting/reviewing/granting/revoking access, and visible loading, empty, conflict, forbidden, recovery, and terminal states. No mock data or browser-side reconstruction of server authority is allowed.

## Project-owned verification

- Unit: canonicalization, rule evaluation, risk thresholds, TTL, audit digests, and transition tables.
- Integration: real PostgreSQL transactions, constraints, strict seed, migrations, idempotency, and tenant isolation.
- E2E: production build in system Chromium through public HTTP routes.
- Concurrency: at least two API processes and four workers for publication, refresh, review, grant, and revoke races.
- Recovery: barrier-controlled `SIGKILL` after claim/effect plus unknown dispatcher acknowledgement.
- Performance: fixed deterministic seed, exact request counts, measured latency/throughput, topology, RSS/database growth, and post-load invariants.

## Eight required performance scenarios

Scoring runs use `BENCH_PERF_SCALE=1`; a lower value is allowed only for local non-scoring smoke runs. Each scenario starts from a fresh database and reports p50/p95/p99, statuses, throughput or convergence time, process topology, RSS, database bytes, and post-load invariant results.

1. `session-refresh-storm`: fixed seed 20,000 active session families; 64 clients perform exactly 100,000 rotations across two APIs. At least 800 rotations/s, p95 <= 180 ms, one surviving generation per family, and no raw token in snapshot/logs.
2. `access-decision-ingest`: fixed seed 100,000 trusted principals/devices and one frozen policy/risk revision; 64 clients submit exactly 500,000 requests while eight workers drain. At least 500 accepted requests/s, p95 <= 250 ms, exactly one decision per request, and no nonterminal Work after drain.
3. `policy-evaluation-hotset`: 100 policies with 500 rules each and 100,000 frozen requests; 64 clients perform exactly 1,000,000 grant checks. At least 2,000 checks/s, p95 <= 75 ms, deterministic deny-overrides results, and one revision per response.
4. `location-replay-convergence`: 10,000 devices receive exactly 200,000 observations with bounded out-of-order delivery through 64 clients and eight workers. At least 350 observations/s, p95 <= 300 ms, contiguous device sequence identity, deterministic final locations, and no duplicate risk flags.
5. `grant-revocation-fanout`: 100,000 active grants across 1,000 principals; revoke all principals using 32 clients, then drain eight workers. Mutation p95 <= 250 ms and every check must fail closed within 30 seconds with one monotonic revocation per principal.
6. `audit-chain-append`: 64 clients execute exactly 250,000 valid security mutations across two APIs. At least 300 mutations/s, p95 <= 300 ms, contiguous per-tenant audit sequence, valid digest links, and no secret fields.
7. `outbox-ack-recovery`: deliver 50,000 committed Events with four dispatchers while one response is acknowledged then hidden and two dispatchers are killed. Drain within 45 seconds; retries preserve exact event ID/body and every event is delivered at least once without a second logical Event.
8. `revocation-fence-recovery`: 50,000 active grants are checked continuously through two APIs while a device, session, principal, and tenant fence advance and four workers are killed after claim. Replacement workers converge within 45 seconds; after each commit, no stale process may return `active:true` for the affected grant.

Correctness after load is mandatory; throughput alone is not a pass.

## Successful response contracts

Successful response contracts are closed:

- A mutation route without a literally stated success status returns 200.
- Unless a route literally publishes another object, array, or empty body, a success described by a named resource, named resource state, or named resource fields returns that exact resource shape at the JSON top level. Any response-only fields literally named by the route are additional top-level fields.
- If a mutation publishes no success body, it returns the exact current shape of the single primary resource created or changed by that route at the JSON top level.
- When a route explicitly returns multiple named resources, the body is one object keyed by their lower-camel resource names unless the route publishes another literal shape.
- Wrappers such as `{data:...}`, `{result:...}`, or an extra single-resource envelope are invalid unless the route literally declares them. OpenAPI must publish the same success status and closed response schema as runtime.
