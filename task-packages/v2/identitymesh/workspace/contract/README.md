# IdentityMesh — V2 fixed public interface

Author scaffold revision 2026-09-08.final-system.1: exact decimal validation and incremental seed-file decoding. This is a revised public scaffold, not the unchanged historical evaluation environment. Evaluation scope is one complete final system; historical cross-version duties are withdrawn. Current business requirements and seed scale remain required.

Business requirements: read the COMPLETE ../docs/requirements.md. learning-final-system-2026-09-08.1 explicitly withdraws historical cross-version obligations, not current business functionality. Source documents remain unchanged only for provenance.
Public author policy revision learning-final-system-2026-09-08.1: read the supplements below in full. They resolve explicitly identified business-policy and test-protocol omissions; only an explicitly named author-approved exception overrides a corresponding original rule, and every other original obligation remains in force. This revision must not be compared as an unchanged historical benchmark.

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
| production-ui | GET / | docs/frontal-legacy/README.md |
| create-tenant | POST /api/v1/tenants | docs/frontal-legacy/README.md |
| create-user | POST /api/v1/users | docs/frontal-legacy/README.md |
| create-login-attempt | POST /api/v1/login-attempts | docs/frontal-legacy/README.md |
| provider-callback | POST /api/v1/provider/callbacks | docs/frontal-legacy/README.md |
| reconcile-login-attempt | POST /api/v1/login-attempts/:attemptId/reconcile | docs/frontal-legacy/README.md |
| refresh-session | POST /api/v1/sessions/:sessionId/refresh | docs/frontal-legacy/README.md |
| revoke-session | POST /api/v1/sessions/:sessionId/revoke | docs/frontal-legacy/README.md |
| list-sessions | GET /api/v1/sessions | docs/frontal-legacy/README.md |
| register-device | POST /api/v1/devices/register | docs/frontal-legacy/README.md |
| create-device-challenge | POST /api/v1/devices/:deviceId/challenges | docs/frontal-legacy/README.md |
| approve-device-challenge | POST /api/v1/device-challenges/:challengeId/approve | docs/frontal-legacy/README.md |
| revoke-device | POST /api/v1/devices/:deviceId/revoke | docs/frontal-legacy/README.md |
| rotate-signing-key | POST /api/v1/signing-keys/rotate | docs/frontal-legacy/README.md |
| read-jwks | GET /api/v1/signing-keys/jwks | docs/frontal-legacy/README.md |
| create-revocation | POST /api/v1/revocations | docs/frontal-legacy/README.md |
| verify-audit | GET /api/v1/audit/verify | docs/frontal-legacy/README.md |
| list-audit | GET /api/v1/audit | docs/frontal-legacy/README.md |
| create-compromise-incident | POST /api/v1/compromise-incidents | contract/README.md (V2 wire clarification) |
| read-compromise-incident | GET /api/v1/compromise-incidents/:incidentId | contract/README.md (V2 wire clarification) |
| approve-recovery | POST /api/v1/compromise-incidents/:incidentId/approvals | contract/README.md (V2 wire clarification) |
| recover-tenant | POST /api/v1/compromise-incidents/:incidentId/recover | contract/README.md (V2 wire clarification) |
| verification-snapshot | GET /api/v1/verification-snapshot | docs/frontal-legacy/README.md |

## Explicit V2 wire clarifications

- The complete public README and Manager requirements remain business authority. These V2 schemas freeze previously unspecified transport fields; they are authored from public documents only. The public smoke checks interface and persistence identity, not complete business correctness.
- V2 wire clarification: health returns {status:"ok"}; the production root returns HTML. Mutation bodies are closed, server-generated identity/state/timestamps are outputs, all mutation examples require durable Idempotency-Key, and unspecified success status is 200. Path parameters use their corresponding resource field types. Collection limits are 1..100 (default 50) with stable opaque cursors.
- V2 wire clarification: Tenant is {tenantId,name}; the default AuditEntry/AuditCheckpoint, DomainEvent envelope and fenced Work fields are the published schema definitions. Unless legacy prose literally fixes payload to {}, DomainEvent.payload is a public JSON object. This does not authorize exposing secrets or inventing event types.
- V2 wire clarification: snapshot is one PostgreSQL point-in-time with exact resources, work and events keys (and schemaVersion only where declared). Resource arrays are complete, sorted by public identity tuple; audit by tenantId then sequence, events by aggregateId then sequence then eventId, Work by workId. Foreign keys, state invariants and digest validity remain implementation validation. Token/credential/private-path fields never appear in snapshot.
- Seed preserves exactly the V1 top-level members; Manager-only resources are created by public operations or the explicitly required compatibility migration. The nonempty example is a minimal legal starting graph, with no evaluator fixtures.
- V2 wire clarification: User and all formerly unspecified authentication request/response shapes are explicit here. AuthTokens and challenge nonce appear only in successful direct authentication/challenge responses and durable protected replay storage; public Session, snapshot, audit and events never expose them. LoginResult has null session/tokens until SUCCEEDED. Reconcile returns the same session/token issuance identity. Credentials are never persisted or returned.
- V2 wire clarification: public JWK supports Ed25519/EdDSA or RSA/RS256 and contains only public fields. Challenge lifetime is a caller-specified positive expiresInSeconds; access-token expiresAt is server-issued and never exceeds Session.expiresAt. Signing-key retiringForSeconds is the verification grace and cannot permit a token beyond its own expiry. Refresh expectedGeneration fences the stored token generation.
- The Manager publishes quarantine behavior but no routes or resource fields. V2 explicitly introduces /compromise-incidents create/read, /approvals and /recover with the closed shapes here. Incidents freeze approver identities and quorum; requiredApprovals must not exceed approver count. Each tenant compromiseEpoch increments atomically; approvals are unique by incident and approver and must match the frozen epoch. TENANT_QUARANTINE/TENANT_RECOVERY aggregateId is incidentId.
- V2 wire clarification: Manager states are QUARANTINED, RECOVERY_READY, RECOVERING and RECOVERED; the sole threshold transition emits tenant.recovery_ready, creation emits tenant.quarantined and completed recovery emits tenant.recovered. This names the Manager transition events explicitly. Recovery requires completed revocation propagation and an ACTIVE key generated after quarantine; it never restores old sessions, families, challenges or keys.
- V2 wire clarification: quarantine errors are 409 COMPROMISE_EPOCH_CHANGED, RECOVERY_NOT_READY, INCIDENT_TERMINAL, APPROVER_NOT_ALLOWED, RECOVERY_ALREADY_APPROVED; invalid quorum is 400 INVALID_AUTH_REQUEST. Public IDs missing from any route return 404 NOT_FOUND. Identity-provider integration is restricted to the local double and must reconcile one stable providerRequestId.
- ## Public policy supplement — identitymesh-provider-2026-09-08.1

This author-approved revision fills the previously unspecified local identity-provider wire protocol.
It is not the unchanged historical benchmark and is not a retroactive interpretation of old runs.
The complete original README and Manager requirements remain in force: password authentication,
single session/token-family issuance, durable idempotency, UNKNOWN reconciliation, device ownership,
revocation, secret-free audit and quarantine are not relaxed. The existing incoming login, callback
and reconcile operations and their exact request/response shapes do not change.

### Test accounts and authority

The local provider is a separate test service at `PROVIDER_BASE_URL`, never a real external provider.
Its explicit account table has rows `{tenantId,userId,username,password}`. The exact, case-sensitive
`(tenantId,username,password)` tuple authenticates to that row's `userId`; an unknown tuple fails.
Account rows must refer to existing same-tenant Users provisioned by a public seed or create-user
operation. Configuring the test provider does not create Users, Devices, Sessions or trust inside
IdentityMesh. No password spelling, username prefix or user ID encoding selects a test outcome.
The public example account is declared under `providerProtocol.accounts` in contract.json;
other tests configure their own explicit rows through the same public helper.

### Outbound login

IdentityMesh sends `POST /v1/login` relative to `PROVIDER_BASE_URL`, with JSON Content-Type and
`Idempotency-Key` exactly equal to the 1–128 visible-ASCII-character `providerRequestId` in the closed body:

`{providerRequestId,tenantId,deviceId,username,password}`.

IdentityMesh generates one opaque providerRequestId for a LoginAttempt and durably binds it before
contacting the provider. Incoming idempotent replay and concurrent retry keep that identity. The
provider returns HTTP 200 and the closed body `{providerRequestId,outcome,userId}`. `outcome` is
`SUCCEEDED`, `FAILED` or `UNKNOWN`; userId is the configured User UUID only for SUCCEEDED and null
otherwise. Invalid credentials produce FAILED, not an HTTP transport error. The response always
echoes the exact providerRequestId. Repeating an identical request returns the same provider record;
reusing that ID with any different body is HTTP 409 PROVIDER_REQUEST_CONFLICT. The provider never
echoes credentials. The service must validate the returned identity against the same tenant, User
and Device ownership and retain every original revocation and quarantine check.

### Unknown outcome and reconciliation

UNKNOWN, a lost/delayed response, or provider unavailability cannot issue tokens or imply FAILED.
Reconciliation sends `GET /v1/login-requests/:providerRequestId` with an encoded path segment and
no body or credentials. It returns the same HTTP 200 outcome shape for the original provider record.
A missing provider record returns HTTP 404 PROVIDER_REQUEST_NOT_FOUND; it is unresolved, not proof
of invalid credentials. The service keeps the original attempt unresolved and does not allocate a
replacement provider ID or a second LoginAttempt to bypass UNKNOWN. A caller replay of the original
idempotent login may resend the same request identity when the provider has no record; background
reconciliation needs only that identity and never stored credentials.

Provider truth may move from UNKNOWN to SUCCEEDED or FAILED. Terminal truth cannot be reversed.
The existing incoming reconcile operation and LOGIN_RECONCILIATION Work query this same record;
they converge with callbacks on at most one Session/token-family issuance and one terminal audit/event
transition. A new login blocked by an unresolved original attempt retains LOGIN_RESULT_UNKNOWN.

### Callbacks and test controls

Callbacks use the unchanged incoming `POST /api/v1/provider/callbacks` body
`{providerCallbackId,providerRequestId,outcome,userId,occurredAt}` and a durable Idempotency-Key.
The providerRequestId is obtained from the real outbound request or returned LoginAttempt, never
guessed. For SUCCEEDED, userId is the same configured mapping; otherwise it is null. The test sender
may deliver a notification repeatedly or deliver an earlier UNKNOWN notification after a terminal one.
Such delivery cannot change a terminal result, create another Session, or duplicate its audit/event.

The public `identitymesh-provider.mjs` helper hosts this protocol on loopback. It accepts an explicit
account table plus test-owned initial/reconciled outcome and response delay controls; these controls
are out-of-band configuration and are never extra fields on IdentityMesh's login request. It exposes
only secret-free observed request metadata, monotonic outcome resolution, and callback construction.
`registerAccounts(rows)` may extend the explicit out-of-band table after public Users are provisioned;
the same tenant/username may be registered again only with the identical userId and password mapping.
Credentials and raw provider assertions remain forbidden in service persistence, responses, snapshots,
events, audits and logs. This helper implements only the external test provider, not any IdentityMesh
business state, transaction, authentication-token algorithm, worker, or recovery logic.

Malformed provider wire uses HTTP 400 INVALID_PROVIDER_REQUEST, unsupported media uses HTTP 415
UNSUPPORTED_MEDIA_TYPE, and unpublished provider routes use HTTP 404 NOT_FOUND, each with the
closed `{error:{code,message,details:{}}}` envelope. These provider-side transport codes do not add
or replace IdentityMesh's published incoming semantic errors.

- learning-final-system-2026-09-08.1: Build one complete system from the start. Base features and the formerly named Manager features are required together; there is no intermediate submission, old program, historical workspace, or cross-version upgrade assessment.
- learning-final-system-2026-09-08.1: V1 in an API or source description denotes the base feature contract, not a separately running program. The published /api/v1 paths and schemaVersion values do not change.
- learning-final-system-2026-09-08.1: Cross-version-only duties are withdrawn: importing an unspecified historical physical database, upgrading an earlier binary, migration-time availability of an earlier binary, and synthesizing migration-only legacy wrappers. Current public resource shapes, base APIs, additional features and their ordinary business relationships remain required.
- learning-final-system-2026-09-08.1: Initialize an empty database using the published commands. db:migrate is current-system schema initialization, not an obligation to recognize a hidden old schema. Preserve the original current-system seed validation, atomicity and replay rules.
- learning-final-system-2026-09-08.1: Evaluation creates fresh data through the published seed or APIs, then checks actual behavior and durable state. Restart and recovery assertions use this same final system. A snapshot is a read-only observation, not a database backup format.
- learning-final-system-2026-09-08.1: Persistence, transactionality, idempotency, concurrency, authorization, real UI, OpenAPI, recovery and explicitly specified performance requirements remain in scope. This policy does not remove an otherwise explicit business or security requirement.
- learning-final-system-2026-09-08.1: No external legacy service is required. An isolated receiver or provider simulator is used only for an external interaction actually required by the public product contract; no real account or production service is required.
- learning-final-system-2026-09-08.1: Hidden assertions must use published inputs and observable requirements. Unspecified algorithms, exact error strings, control points or performance thresholds cannot silently become requirements. Code defects fail; invalid author fixtures and infrastructure faults are evaluator errors, not zero-score business outcomes.

## Delivery

Public checks are necessary, not sufficient. Re-read the entire README, audit every observable requirement, and run all required project checks. Guide completion does not mean task completion. Do not return fixture-only responses or empty arrays to simulate completed workflows.
