# IncidentRelay — V2 fixed public interface

Author scaffold revision 2026-09-08.1: exact decimal validation and incremental seed-file decoding. This is a revised public scaffold, not the unchanged historical evaluation environment. Business requirements and seed scale remain unchanged.

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
- The fixed HTTP server listens on 127.0.0.1; contract.httpHost preserves any task-specific bind requirement. PORT selects its port.
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
| health | GET /healthz | V2 public wire clarification (contract notes) |
| openapi | GET /openapi.json | docs/frontal-legacy/README.md#http-and-openapi-31 |
| production-ui | GET / | docs/frontal-legacy/README.md#real-ui |
| domain-events | GET /api/v1/domain-events | V2 public wire clarification (contract notes) |
| verification-snapshot | GET /api/v1/verification-snapshot | docs/frontal-legacy/README.md#http-and-openapi-31 |
| list-incidents | GET /api/v1/incidents | docs/frontal-legacy/README.md#http-and-openapi-31 |
| get-incident | GET /api/v1/incidents/:incidentId | docs/frontal-legacy/README.md#http-and-openapi-31 |
| create-incident | POST /api/v1/incidents | docs/frontal-legacy/README.md#http-and-openapi-31 |
| acknowledge-incident | POST /api/v1/incidents/:incidentId/acknowledge | docs/frontal-legacy/README.md#http-and-openapi-31 |
| resolve-incident | POST /api/v1/incidents/:incidentId/resolve | docs/frontal-legacy/README.md#http-and-openapi-31 |
| create-policy | POST /api/v1/services/:serviceId/escalation-policies | docs/frontal-legacy/manager-requirements.md |
| get-policy | GET /api/v1/services/:serviceId/escalation-policy | docs/frontal-legacy/README.md#http-and-openapi-31 |
| incident-timeline | GET /api/v1/incidents/:incidentId/timeline | docs/frontal-legacy/README.md#http-and-openapi-31 |
| record-acknowledgement | POST /api/v1/incidents/:incidentId/acknowledgements | docs/frontal-legacy/manager-requirements.md |

## Explicit V2 wire clarifications

- Authority: the complete original public README and Manager requirements. This contract uses no private evaluator cases or submitted implementation. Wire validation does not establish workflow, recovery or performance correctness.
- V2 wire clarification: unspecified health body is exactly {status:"ok"}; production UI is HTML at /. GET domain-events returns {items:[DomainEvent]} with aggregateId required and optional afterSequence (default 0), limit (default 50, range 1..100), ordered by sequence. No other query keys are accepted.
- Original error details is an exact empty object. Every mutation requires its published Idempotency-Key. Only documented admin routes require ADMIN_TOKEN. Output timestamps retain the original UTC millisecond precision.
- The FINAL snapshot has exactly its published resource keys and explicitly typed Work/DomainEvent records. It is one database snapshot; recursive *Token omission, stable ordering, retained terminal Work and event identity remain business requirements. Manager-only data is created by public APIs, never inserted through the V1 seed.
- Examples are independent public transport examples, not a required stateful sequence. A success requires the state/time/lease/revision prerequisites in the original public documents. Smoke checks identity and a separate write/read path, not every operation or concurrency invariant.
- V2 public wire clarification: GET incident timeline returns {items:[TimelineItem]} in sequence order, with no pagination query. New reads and mutations expose FINAL Incident fields, including nullable acknowledgementStepIndex and acknowledgements; the mutation response union also preserves exact saved V1 idempotency replies. No new response envelope or resolution field is added.
- V2 compatibility clarification: the V1 seed keeps legacy Incident and EscalationPolicy schemas only. FINAL reads accept both the immutable historical singular policy shape and Manager group policy shape, while migration exposes legacy targets as quorum-one groups. FINAL incidents include migrated acknowledgement records. FINAL snapshot retains all six original arrays and the two explicitly added arrays; no private Work/Event seed members exist.
- Policy list order, strictly increasing integer delays, distinct targets, quorum bounds, expiry, delivered-notification eligibility and business error codes are checked by the implementation. Integer/array wire shapes do not make an invalid policy legal: INVALID_ESCALATION_POLICY and INVALID_QUORUM_POLICY remain mandatory semantic errors.
- The public seed is a linked Service/Responder/immutable Policy graph. Its long first delay keeps the independent smoke incident OPEN during checks without depending on a notification receiver. The smoke does not validate notification delivery or recovery.

## Delivery

Public checks are necessary, not sufficient. Re-read the entire README, audit every observable requirement, and run all required project checks. Guide completion does not mean task completion. Do not return fixture-only responses or empty arrays to simulate completed workflows.
