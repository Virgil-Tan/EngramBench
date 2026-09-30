# MediaDock — V2 fixed public interface

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
| createProfile | POST /api/v1/transcode-profiles | contract/README.md — explicit V2 public wire clarification |
| createProfileRevision | POST /api/v1/transcode-profiles/:profileId/revisions | contract/README.md — explicit V2 public wire clarification |
| createCleanupPolicy | POST /api/v1/cleanup-policies | contract/README.md — explicit V2 public wire clarification |
| createUpload | POST /api/v1/uploads | docs/frontal-legacy/README.md — Multipart upload contract |
| getUpload | GET /api/v1/uploads/:uploadId | docs/frontal-legacy/README.md — Multipart upload contract |
| putPart | PUT /api/v1/uploads/:uploadId/parts/:partNumber | docs/frontal-legacy/README.md — Multipart upload contract |
| completeUpload | POST /api/v1/uploads/:uploadId/complete | contract/README.md — explicit V2 public wire clarification |
| abortUpload | POST /api/v1/uploads/:uploadId/abort | docs/frontal-legacy/README.md — Multipart upload contract |
| getAsset | GET /api/v1/assets/:assetId | docs/frontal-legacy/README.md — Public HTTP surface |
| listRenditions | GET /api/v1/assets/:assetId/renditions | docs/frontal-legacy/README.md — Public HTTP surface |
| createGrant | POST /api/v1/assets/:assetId/access-grants | docs/frontal-legacy/README.md — Temporary access contract |
| revokeGrant | POST /api/v1/access-grants/:grantId/revoke | docs/frontal-legacy/README.md — Temporary access contract |
| getMedia | GET /media/:grantId | docs/frontal-legacy/README.md — Temporary access contract |
| headMedia | HEAD /media/:grantId | docs/frontal-legacy/README.md — Temporary access contract |
| recordScanResult | POST /api/v1/scanner/results | contract/README.md — explicit V2 public wire clarification |
| reconcileScan | POST /api/v1/scan-jobs/:scanJobId/reconcile | docs/frontal-legacy/README.md — Virus scan gate |
| createCleanupRun | POST /api/v1/cleanup-runs | contract/README.md — explicit V2 public wire clarification |
| getCleanupRun | GET /api/v1/cleanup-runs/:cleanupRunId | contract/README.md — explicit V2 public wire clarification |
| createAlias | POST /api/v1/media-aliases | docs/frontal-legacy/manager-requirements.md |
| publishAlias | POST /api/v1/media-aliases/:aliasId/publish | docs/frontal-legacy/manager-requirements.md |
| getAlias | GET /api/v1/media-aliases/:aliasId | docs/frontal-legacy/manager-requirements.md |
| resolveAlias | GET /api/v1/media-aliases/:aliasId/resolve | docs/frontal-legacy/manager-requirements.md |
| createAliasGrant | POST /api/v1/media-aliases/:aliasId/access-grants | docs/frontal-legacy/manager-requirements.md |
| snapshot | GET /api/v1/verification-snapshot | docs/frontal-legacy/README.md — Seed and snapshot |
| health | GET /healthz | contract/README.md — explicit V2 public wire clarification |
| openapi | GET /openapi.json | docs/frontal-legacy/README.md — HTTP contract |
| productionUi | GET / | contract/README.md — explicit V2 public wire clarification |

## Explicit V2 wire clarifications

- V2 public wire clarification (new protocol, not a claim about the original specification): object schemas are closed; server-generated identities, counters and timestamps are omitted from creation inputs. Empty command bodies are {}. Tenant is exactly {tenantId,name}; no createdAt is added to it.
- V2 public wire clarification: snapshot is exactly {schemaVersion:1,resources,work,events}; every listed collection is complete and sorted lexicographically by its public identity (composite identities by listed component order). Manager resource collections extend resources. Snapshot requires Authorization: Bearer ADMIN_TOKEN. Health is {status:"ok"}; production UI is HTML at /. Error.details is exactly {}. DomainEvent uses the fixed redacted envelope declared in schemas; payload contains only the published resource references/state/digests, never credentials or raw sensitive content.
- V2 public wire clarification: seed is metadata, validated atomically including references and invariants; missing required fields are errors, not adapter defaults. Seed replay follows the original version+canonical digest no-op rule. JSON schema validates wire shape; business checks such as uniqueness, reference ownership, ordering, digest correctness and CAS remain implementation responsibilities.
- Every listed operation has an independent public request example. Examples containing resource IDs from later lifecycle stages illustrate wire shape, not a promise that they can all be called in isolation. Only smoke is an executable ordered scenario; it verifies real seed/read and write/read behavior, not full business acceptance.
- V2 public wire clarification: upload parts are numbered from 1 and complete accepts {parts:[{partNumber,sha256,size}]}. Upload GET is the UploadSession fields plus complete sorted parts. Completion returns UploadSession with its assetId; asset and scan state are read through their own public resources. The seed imports metadata only: it cannot create physical bytes, READY assets/renditions or aliases pointing at READY publication content.
- V2 public wire clarification: TranscodeProfile creation assigns revision 1 and a fresh profileId; a new revision of an existing profile uses the added POST /api/v1/transcode-profiles/:profileId/revisions route. COPY requires prefixBase64:null; PREFIX requires valid canonical Base64 (empty prefix allowed). Profile revisions are immutable; jobs freeze the revision applicable when the asset passes CLEAN.
- V2 public wire clarification: CleanupPolicy is versioned per tenant; POST creates the next revision with the fixed six retention-second fields. CleanupEntry has a stable cleanupEntryId and refers to one public target identity, never a path. Cleanup GET is CleanupRun plus its sorted entries. Tenant ownership and all live references are rechecked transactionally before deletion.
- V2 privacy conflict resolution: the original Exact public shapes includes ScanJob.signature, but Virus scan gate forbids public persisted signatures. V2 keeps that field for shape compatibility and requires null in all public outputs and seeds. The scanner result input may carry a signature privately; ScanResult exposes only IDs, state and receivedAt. No scanner payload/signature reaches snapshot/events.
- V2 Manager wire clarification: the Manager supplied behavior but no routes or object fields. The declared media-aliases create/publish/get/resolve/access-grants routes and MediaAlias/PublicationRevision schemas are new public wire contracts. requiredProfileIds are frozen, deduplicated and UUID-sorted at creation. Publish CAS checks expectedRevision, increments from 0, captures one READY clean asset and its required READY renditions atomically, and records retainUntil=publication time+alias.retentionSeconds. The current revision is retained regardless of that deadline; old revisions remain retained through the deadline and while any grant or stream references their bytes.
- V2 Manager wire clarification: publish returns {alias,revision}; alias GET returns {alias,revisions}; resolve returns one immutable source/rendition digest set and never bytes from mixed revisions. Direct asset grant input may pin publicationRevisionId; alias grant always pins the resolved current publication. AccessGrant adds nullable publicationRevisionId, null only for direct non-publication grants. Publish conflicts use 409 PUBLICATION_REVISION_CONFLICT; missing/ineligible content uses 409 ASSET_QUARANTINED; absent resources/unpublished resolution use 404 NOT_FOUND. PUBLICATION_SWITCH is the exact new Work kind and Event type.
- V2 transport clarification: media GET emits raw bytes (not a JSON string or base64); HEAD emits no body with the equivalent headers. Full/range/not-modified success statuses are 200/206/304; Range failure uses 416 with Content-Range bytes */size. ETag is the quoted lowercase SHA-256; media response schemas describe the byte-string seam. Capability HMAC input is UTF-8 grantId + LF + expiresAt and HMAC-SHA256 with GRANT_SIGNING_KEY, encoded unpadded base64url; verification is constant-time. This previously unspecified byte encoding is a public V2 convention.
- The public seed includes a tenant, OPEN metadata-only upload, profile, cleanup policy and unpublished alias. The smoke checks these reads and independent profile/alias creation; it does not claim virus scanning, streaming, cleanup, publication CAS, recovery or performance acceptance. All 21 README routes plus the explicit Manager wire routes are declared.
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
