# AccessSentinel — V2 fixed public interface

Author scaffold revision 2026-09-08.1: exact decimal validation and incremental seed-file decoding. This is a revised public scaffold, not the unchanged historical evaluation environment. Business requirements and seed scale remain unchanged.

Business requirements: read the COMPLETE ../docs/frontal-legacy/README.md and manager-requirements.md. The files are preserved verbatim. The wire clarifications below override only ambiguous representations, never remove business requirements.
Public author policy revision accesssentinel-2026-09-08.1: read the supplements below in full. They resolve explicitly identified business-policy and test-protocol omissions; only an explicitly named author-approved exception overrides a corresponding original rule, and every other original obligation remains in force. This revision must not be compared as an unchanged historical benchmark.

## Implementation seam

- Implement all operations behind src/implementation.ts; use src/operation-ids.ts and contract.json for exact IDs, schemas, status codes and examples. Split internal modules freely.
- Implement migrations, database seed, worker/dispatcher roles, real UI build and project-owned verification in src/lifecycle.ts. Throwing stubs are deliberate: compilation is not business completion.
- The API process awaits optional src/implementation.ts exports start() before listening and stop() when terminating. Use these for pools and any background work required inside npm start (notably LaunchPass expiration/promotion). They may delegate to your own lifecycle modules; do not keep them only in the build command.
- contract/ is author-owned. Do not edit its router/checker/contract or the README to make tests pass. You may add modules, dependencies, UI assets and your own tests.
- Raw uploads arrive as RequestContext.stream; consume them incrementally. Raw download responses may be Buffer, string or readable stream. The router does not implement file persistence.
- Additional UI endpoints may use publicExtensions; published operation IDs/method/path cannot be replaced.

## Contract and examples

- contract.json is the single wire source. openapi.json is generated from it, not separately handwritten.
- The fixed HTTP server listens on 0.0.0.0; contract.httpHost preserves any task-specific bind requirement. PORT selects its port.
- transportErrors preserves task-specific HTTP error codes. Otherwise V2 wire defaults are INVALID_REQUEST/400, MALFORMED_JSON/400, UNAUTHORIZED/401, NOT_FOUND/404 and UNSUPPORTED_MEDIA_TYPE/415; domain resource errors still follow the complete README.
- seed.example.json is a legal NONEMPTY seed. Its replay rule and argv are under contract.seed; do not guess db:seed versus seed.
- contract/seed-reader.mjs exports readSeedJsonFile(path): incremental JSON decoding without a whole-file string. The author seed command still validates the entire decoded value against the public schema before invoking your lifecycle. You may reuse this reader in your own importer; foreign keys, digests, duplicate rules and atomic import remain your responsibility. The decoded object tree still occupies memory, and a single JSON string remains subject to the JavaScript engine string limit; this helper is not a database importer.
- operation.example values are independent wire examples, not a complete executable business sequence. smoke contains an ordered public live sequence with captured identifiers.
- A smoke signatures entry constructs a lowercase-hex HMAC-SHA256 request field: {target:["headers"|"body","existingField"],key:"public fixture key",message:"published UTF-8 signing line"}. Captured variables are expanded first; body fields are signed before JSON serialization. This is a public client helper, never server-side authentication or business implementation.
- npm run check:contract-source only verifies author file integrity and schema construction.
- npm run test:public-contract uses a DISPOSABLE database, builds, migrates, imports the seed, starts the real API/roles, then checks nonempty identities and live operations. Do not point it at a valuable database.
- Public failures identify the failed command stage and retain its exit code/stdout/stderr. A probe blocked by an earlier failed identifier capture is reported as blockedBy, not as an independent implementation failure. Fix the first failure, then rerun the public check.
- HTTP probe failures identify method/path, expectedStatus, actualStatus and a named errorCode when available; they do not dump credentials or signatures. The official Harness reruns this author-owned check in an isolated copy before freezing; failed public checks return to the same Coding Agent for repair, while infrastructure errors stop the check without becoming business scores.
- Passing public checks proves only the published example wiring. It does not certify full business requirements, security, recovery, UI or performance, and does not replace the final README audit.
- The official Harness runs the author-owned checker against an isolated copy before freezing. A public failure is feedback, not a hidden business score.

## Published operations

| ID | Method / path | Source |
| --- | --- | --- |
| health | GET /healthz | docs/frontal-legacy/README.md |
| openapi | GET /openapi.json | docs/frontal-legacy/README.md |
| ui | GET / | docs/frontal-legacy/README.md |
| listTenants | GET /api/v1/tenants | docs/frontal-legacy/README.md |
| listPrincipals | GET /api/v1/principals | docs/frontal-legacy/README.md |
| listDevices | GET /api/v1/devices | docs/frontal-legacy/README.md |
| getAccessRequest | GET /api/v1/access-requests/:accessRequestId | docs/frontal-legacy/README.md |
| createSession | POST /api/v1/sessions | docs/frontal-legacy/README.md |
| refreshSession | POST /api/v1/sessions/:sessionId/refresh | docs/frontal-legacy/README.md |
| revokeSession | POST /api/v1/sessions/:sessionId/revoke | docs/frontal-legacy/README.md |
| publishTrust | POST /api/v1/devices/:deviceId/trust-revisions | docs/frontal-legacy/README.md |
| revoke-devices | POST /api/v1/devices/:deviceId/revoke | docs/frontal-legacy/README.md |
| revoke-principals | POST /api/v1/principals/:principalId/revoke | docs/frontal-legacy/README.md |
| revoke-tenants | POST /api/v1/tenants/:tenantId/revoke | docs/frontal-legacy/README.md |
| createPolicyBundle | POST /api/v1/policy-bundles | docs/frontal-legacy/README.md |
| publishPolicy | POST /api/v1/policy-bundles/:policyBundleId/publish | docs/frontal-legacy/README.md |
| rollbackPolicy | POST /api/v1/policy-bundles/:policyBundleId/rollback | docs/frontal-legacy/README.md |
| observeLocation | POST /api/v1/location-observations | docs/frontal-legacy/README.md |
| createAccessRequest | POST /api/v1/access-requests | docs/frontal-legacy/README.md |
| batchAccessRequests | POST /api/v1/access-requests:batch | docs/frontal-legacy/README.md |
| reviewAccessRequest | POST /api/v1/access-requests/:accessRequestId/reviews | docs/frontal-legacy/README.md |
| grantAccessRequest | POST /api/v1/access-requests/:accessRequestId/grant | docs/frontal-legacy/README.md |
| checkGrant | GET /api/v1/grants/:grantId/check | docs/frontal-legacy/README.md |
| revokeGrant | POST /api/v1/grants/:grantId/revoke | docs/frontal-legacy/README.md |
| createBreakGlass | POST /api/v1/break-glass-sessions | docs/frontal-legacy/manager-requirements.md |
| approveBreakGlass | POST /api/v1/break-glass-sessions/:breakGlassSessionId/approvals | docs/frontal-legacy/manager-requirements.md |
| activateBreakGlass | POST /api/v1/break-glass-sessions/:breakGlassSessionId/activate | docs/frontal-legacy/manager-requirements.md |
| closeBreakGlass | POST /api/v1/break-glass-sessions/:breakGlassSessionId/close | docs/frontal-legacy/manager-requirements.md |
| checkBreakGlass | POST /api/v1/break-glass-sessions/:breakGlassSessionId/check | docs/frontal-legacy/manager-requirements.md |
| quarantineRegion | POST /api/v1/regions/:region/quarantine | docs/frontal-legacy/manager-requirements.md |
| releaseRegion | POST /api/v1/regions/:region/release | docs/frontal-legacy/manager-requirements.md |
| reviewRetrospective | POST /api/v1/break-glass-sessions/:breakGlassSessionId/retrospective-reviews | docs/frontal-legacy/manager-requirements.md |
| snapshot | GET /api/v1/verification-snapshot | docs/frontal-legacy/README.md |

## Explicit V2 wire clarifications

- # AccessSentinel immutable Event protocol

Policy revision: `accesssentinel-2026-09-08.1`.

This author-approved supplement defines previously unspecified names/payloads;
it does not change authorization, risk rules, TTLs, review independence, revocation
or performance requirements. Old results are not judged retroactively.

Keep the exact Event envelope:
{eventId,tenantId,aggregateType,aggregateId,sequence,type,occurredAt,payload}.
Each successful transition below atomically emits one corresponding event.
Replays and Work retries never duplicate it. All use aggregateType AccessRequest,
aggregateId accessRequestId. Other required Events may interleave, with their
existing public names, so these events need not occupy fixed sequence numbers.

| Transition | type | Exact payload |
| --- | --- | --- |
| Accept AccessRequest | ACCESS_REQUESTED | {accessRequestId,sessionId,policyRevisionId,riskModelRevisionId,deviceTrustRevisionId} |
| Commit RiskDecision | RISK_DECIDED | {accessRequestId,riskDecisionId,score,level,reasons,policyEffect,inputDigest} |
| Record review | ACCESS_REVIEWED | {accessRequestId,accessReviewId,reviewerId,decision,comment} |
| Issue AccessGrant | ACCESS_GRANTED | {accessRequestId,grantId,policyRevisionId,riskDecisionId,expiresAt} |
| Revoke / expire Grant | ACCESS_REVOKED / ACCESS_EXPIRED | {accessRequestId,grantId,state,revocationEpoch} |

Payloads are closed and contain all listed fields, using their existing resource
types. Copy values from the corresponding committed resource. Do not substitute
later policy/current projections. reasons remains the immutable sorted reason
list. Existing contiguous unique aggregate sequences and transactional invariants
remain mandatory.

Dispatcher POSTs exactly this immutable Event to WEBHOOK_URL with Content-Type
application/json. Canonical JSON sorts object keys recursively in JavaScript
UTF-16 order, preserves arrays, uses JSON.stringify without whitespace and UTF-8.
Freeze bytes once; unknown ACK/restart retries reuse eventId and complete bytes.
Any HTTP 2xx acknowledges; other statuses/connection failures retain retryable
Work under original rules. Events may not contain raw refresh tokens, device
nonces, private keys, credentials, authorization headers or administrator tokens.

- The original README and Manager message remain complete authority. V2 clarifies only missing wire representations; all business, security, concurrency, recovery, migration, UI and performance requirements remain mandatory.
- Seed uses schemaVersion:1, string seedVersion and UTC importedAt, keeps the original closed V1 collection whitelist, and provides a linked Tenant/Principal/Device/TRUSTED revision. Identical seed replay is allowed; conflicting content under the same version rejects atomically. No raw secret is in the public seed.
- Every resource is closed and every field has a declared type. Resource IDs are lowercase UUIDs; generic actorId/subjectId/aggregateId are strings because actors and region subjects need not be resource UUIDs. actorId may be null for a system actor. Integer epochs, revisions, generation, assurance, risk scores/weights and sequence counters are nonnegative safe integers. Coordinates are finite numbers in their original ranges.
- Digest fields are lowercase SHA-256 hex; fingerprints remain opaque public strings. Work terminal is boolean; leaseOwner/leaseToken/leaseExpiresAt and lastError are nullable. PolicyBundle currentPolicyRevisionId is null before publication. locationWatermark and not-yet-occurred lifecycle timestamps are null. reasons/riskFlags/actions/resourcePatterns are string arrays. Audit data and Event payload are explicit free JSON metadata with the original recursive secret exclusion.
- Health GET /healthz returns {status:"ok"}; / returns nonempty text/html; /openapi.json publishes OpenAPI 3.1 from this same contract. Snapshot requires Authorization: Bearer ADMIN_TOKEN. All mutation routes require Idempotency-Key except POST BreakGlass check, which is explicitly a side-effect-free authorization check.
- Batch acceptance returns 200 {accessRequests:AccessRequest[]} in input order; cardinality is exactly the number accepted and the entire input is committed or rejected atomically. It performs the same acceptance semantics and frozen authority capture as single creation.
- List tenant/principal/device returns the named collection envelope; principal/device lists optionally filter tenantId. Unpublished query keys reject. Path IDs are UUIDs, region is a nonempty string, and query/path values use the common validator. JSON values never undergo numeric coercion.
- Malformed JSON returns 400 MALFORMED_JSON; unknown fields/queries and invalid wire shapes return 400 INVALID_REQUEST; unsupported media returns 415 UNSUPPORTED_MEDIA_TYPE; missing snapshot authentication returns 401 UNAUTHORIZED. Original named business errors retain their original status and exact closed envelope.
- Final snapshot adds exactly the four lower-camel plural Manager collections. Policy publication and rollback return the new PolicyRevision, revocation returns the subject resource. New PolicyBundle starts currentRevision:0/currentPolicyRevisionId:null; first publication creates revision:1 and moves the pointer.
- The smoke reads linked identities and an immutable public example RiskModelRevision, creates/publishes a PolicyBundle, then creates a real Session and AccessRequest and verifies captured authority identities in persisted snapshot records. Risk thresholds/weights in this seed are example configuration, not new mandatory business policy. It does not certify risk worker completion, grants, full business behavior, browser, recovery or performance.

## Delivery

Public checks are necessary, not sufficient. Re-read the entire README, audit every observable requirement, and run all required project checks. Guide completion does not mean task completion. Do not return fixture-only responses or empty arrays to simulate completed workflows.
