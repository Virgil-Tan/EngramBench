# ImportWorks — V2 fixed public interface

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
| createTenant | POST /api/v1/tenants | contract/README.md — explicit V2 public wire clarification |
| createSchema | POST /api/v1/schemas | contract/README.md — explicit V2 public wire clarification |
| createSchemaRevision | POST /api/v1/schemas/:schemaId/revisions | contract/README.md — explicit V2 public wire clarification |
| createImport | POST /api/v1/imports | docs/frontal-legacy/README.md — Upload and resume |
| getImport | GET /api/v1/imports/:importId | docs/frontal-legacy/README.md — Upload and resume |
| putChunk | PUT /api/v1/imports/:importId/chunks/:chunkNumber | docs/frontal-legacy/README.md — Upload and resume |
| completeImport | POST /api/v1/imports/:importId/complete | docs/frontal-legacy/README.md — Upload and resume / Validation, commit, and reports |
| commitImport | POST /api/v1/imports/:importId/commit | docs/frontal-legacy/README.md — Upload and resume / Validation, commit, and reports |
| cancelImport | POST /api/v1/imports/:importId/cancel | docs/frontal-legacy/README.md — Upload and resume / Validation, commit, and reports |
| getFindings | GET /api/v1/imports/:importId/findings | docs/frontal-legacy/README.md — HTTP contract |
| getErrorReport | GET /api/v1/imports/:importId/error-report | docs/frontal-legacy/README.md — Exact public shapes / HTTP contract |
| downloadErrorReport | GET /api/v1/imports/:importId/error-report/content | contract/README.md — explicit V2 public wire clarification |
| listRecords | GET /api/v1/records | docs/frontal-legacy/README.md — HTTP contract |
| createBundle | POST /api/v1/import-bundles | docs/frontal-legacy/manager-requirements.md |
| addBundleMember | POST /api/v1/import-bundles/:bundleId/members | docs/frontal-legacy/manager-requirements.md |
| stageBundle | POST /api/v1/import-bundles/:bundleId/stage | docs/frontal-legacy/manager-requirements.md |
| publishBundle | POST /api/v1/import-bundles/:bundleId/publish | docs/frontal-legacy/manager-requirements.md |
| snapshot | GET /api/v1/verification-snapshot | docs/frontal-legacy/README.md — Seed and snapshot |
| health | GET /healthz | contract/README.md — explicit V2 public wire clarification |
| openapi | GET /openapi.json | docs/frontal-legacy/README.md — HTTP contract |
| productionUi | GET / | contract/README.md — explicit V2 public wire clarification |

## Explicit V2 wire clarifications

- V2 public wire clarification (new protocol, not a claim about the original specification): object schemas are closed; server-generated identities, counters and timestamps are omitted from creation inputs. Empty command bodies are {}. Tenant is exactly {tenantId,name}; no createdAt is added to it.
- V2 public wire clarification: snapshot is exactly {schemaVersion:1,resources,work,events}; every listed collection is complete and sorted lexicographically by its public identity (composite identities by listed component order). Manager resource collections extend resources. Snapshot requires Authorization: Bearer ADMIN_TOKEN. Health is {status:"ok"}; production UI is HTML at /. Error.details is exactly {}. DomainEvent uses the fixed redacted envelope declared in schemas; payload contains only the published resource references/state/digests, never credentials or raw sensitive content.
- V2 public wire clarification: seed is metadata, validated atomically including references and invariants; missing required fields are errors, not adapter defaults. Seed replay follows the original version+canonical digest no-op rule. JSON schema validates wire shape; business checks such as uniqueness, reference ownership, ordering, digest correctness and CAS remain implementation responsibilities.
- Every listed operation has an independent public request example. Examples containing resource IDs from later lifecycle stages illustrate wire shape, not a promise that they can all be called in isolation. Only smoke is an executable ordered scenario; it verifies real seed/read and write/read behavior, not full business acceptance.
- V2 public wire clarification: Schema is {schemaId,tenantId,datasetKey,name}; one Schema exists per (tenantId,datasetKey). SchemaRevision is the declared immutable closed object; server assigns revisions starting at 1. Field names are unique; externalIdField names a required string field. additionalProperties is always false, preserving the original rule that unknown row fields produce findings. Type-specific bounds apply only to the matching type; minimum<=maximum. No arbitrary JSON Schema extensions or executable validators are accepted.
- V2 public wire clarification: fields has at least the external identity field. Missing optional maxLength/minimum/maximum means no such constraint. These are public schema-language additions, not requirements silently inferred from private seeds. Import creation resolves schema by tenantId+datasetKey+schemaRevision, not current revision.
- V2 public wire clarification: chunkNumber starts at 0; byte ranges are inclusive. Import GET returns exact ImportJob fields plus receivedRanges and missingRanges as ascending coalesced {start,end} intervals. All mutation responses retain the exact primary resource at top level. Initial ImportJob sequence is 0; accepted state transitions increment it.
- V2 public wire clarification: GET error-report returns only ErrorReport metadata. Added GET /api/v1/imports/:importId/error-report/content serves a READY report as UTF-8 application/x-ndjson: each sorted ValidationFinding is RFC 8785 canonical JSON followed by LF; sha256 hashes precisely those bytes, empty report hashes the empty byte string. Non-READY content returns IMPORT_NOT_VALIDATED. This explicit extra route makes the original download requirement usable without leaking rejected values.
- V2 public wire clarification: seed keeps the original absence of importedAt and adds importBundles/bundleMembers arrays. The public example contains a tenant, populated schema revision, and byte-free UPLOADING job. Bundle members use zero-based insertion positions, contiguous within the bundle. Snapshot collection identities are schemaId+revision, importId+chunkNumber and bundleId+position for composite rows, otherwise the named ID.
- The smoke performs a real independent upload and resume read but deliberately does not claim validation, atomic commit, recovery or performance acceptance. All 15 original routes, all 4 Manager routes, and the explicit report-content clarification route are declared.
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
