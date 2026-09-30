# IdentityMesh — V2 fixed public interface

Business requirements: read the COMPLETE ../docs/frontal-legacy/README.md and manager-requirements.md. The files are preserved verbatim. The wire clarifications below override only ambiguous representations, never remove business requirements.

## Implementation seam

- Implement all operations behind src/implementation.ts; use src/operation-ids.ts and contract.json for exact IDs, schemas, status codes and examples. Split internal modules freely.
- Implement migrations, database seed, worker/dispatcher roles, real UI build and project-owned verification in src/lifecycle.ts. Throwing stubs are deliberate: compilation is not business completion.
- The API process awaits optional src/implementation.ts exports start() before listening and stop() when terminating. Use these for pools and any background work required inside npm start (notably LaunchPass expiration/promotion). They may delegate to your own lifecycle modules; do not keep them only in the build command.
- contract/ is author-owned. Do not edit its router/checker/contract or the README to make tests pass. You may add modules, dependencies, UI assets and your own tests.
- Raw uploads arrive as RequestContext.stream; consume them incrementally. Raw download responses may be Buffer, string or readable stream. The router does not implement file persistence.
- Additional UI endpoints may use publicExtensions; published operation IDs/method/path cannot be replaced.

## Contract and examples

- contract.json is the single wire source. openapi.json is generated from it, not separately handwritten.
- transportErrors preserves task-specific HTTP error codes. Otherwise V2 wire defaults are INVALID_REQUEST/400, MALFORMED_JSON/400, UNAUTHORIZED/401, NOT_FOUND/404 and UNSUPPORTED_MEDIA_TYPE/415; domain resource errors still follow the complete README.
- seed.example.json is a legal NONEMPTY seed. Its replay rule and argv are under contract.seed; do not guess db:seed versus seed.
- operation.example values are independent wire examples, not a complete executable business sequence. smoke contains an ordered public live sequence with captured identifiers.
- npm run check:contract-source only verifies author file integrity and schema construction.
- npm run test:public-contract uses a DISPOSABLE database, builds, migrates, imports the seed, starts the real API/roles, then checks nonempty identities and live operations. Do not point it at a valuable database.
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

## Delivery

Public checks are necessary, not sufficient. Re-read the entire README, audit every observable requirement, and run all required project checks. Guide completion does not mean task completion. Do not return fixture-only responses or empty arrays to simulate completed workflows.
