# SchemaHarbor — V2 fixed public interface

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
| health | GET /healthz | V2 public wire clarification (contract notes) |
| openapi | GET /openapi.json | docs/frontal-legacy/README.md#http-and-openapi-31 |
| production-ui | GET / | docs/frontal-legacy/README.md#real-ui |
| list-schema-versions | GET /api/v1/schema-versions | docs/frontal-legacy/README.md#http-and-openapi-31 |
| read-schema-version | GET /api/v1/schema-versions/:schemaVersionId | docs/frontal-legacy/README.md#http-and-openapi-31 |
| create-subject | POST /api/v1/subjects | docs/frontal-legacy/README.md#http-and-openapi-31 |
| create-schema-draft | POST /api/v1/subjects/:subjectId/schema-drafts | docs/frontal-legacy/README.md#http-and-openapi-31 |
| publish-schema-draft | POST /api/v1/schema-drafts/:draftId/publish | docs/frontal-legacy/README.md#http-and-openapi-31 |
| change-compatibility-mode | POST /api/v1/subjects/:subjectId/compatibility-mode | docs/frontal-legacy/README.md#http-and-openapi-31 |
| latest-schema | GET /api/v1/subjects/:subjectId/versions/latest | docs/frontal-legacy/README.md#http-and-openapi-31 |
| schema-diff | GET /api/v1/subjects/:subjectId/versions/:version/diff | docs/frontal-legacy/README.md#http-and-openapi-31 |
| list-subject-versions | GET /api/v1/subjects/:subjectId/versions | docs/frontal-legacy/README.md#http-and-openapi-31 |
| read-subject-version | GET /api/v1/subjects/:subjectId/versions/:version | docs/frontal-legacy/manager-requirements.md |
| create-release-bundle | POST /api/v1/release-bundles | docs/frontal-legacy/manager-requirements.md |
| read-release-bundle | GET /api/v1/release-bundles/:releaseBundleId | docs/frontal-legacy/manager-requirements.md |
| publish-release-bundle | POST /api/v1/release-bundles/:releaseBundleId/publish | docs/frontal-legacy/manager-requirements.md |
| domain-events | GET /api/v1/domain-events | V2 public wire clarification (contract notes) |
| verification-snapshot | GET /api/v1/verification-snapshot | docs/frontal-legacy/README.md#http-and-openapi-31 |

## Explicit V2 wire clarifications

- Authority: the complete original public README and Manager requirements. This contract uses no private evaluator cases or submitted implementation. Wire validation does not establish workflow, recovery or performance correctness.
- V2 wire clarification: unspecified health body is exactly {status:"ok"}; production UI is HTML at /. GET domain-events returns {items:[DomainEvent]} with aggregateId required and optional afterSequence (default 0), limit (default 50, range 1..100), ordered by sequence. No other query keys are accepted.
- Original error details is an exact empty object. Every mutation requires its published Idempotency-Key. Only documented admin routes require ADMIN_TOKEN. Output timestamps retain the original UTC millisecond precision.
- The FINAL snapshot has exactly its published resource keys and explicitly typed Work/DomainEvent records. It is one database snapshot; recursive *Token omission, stable ordering, retained terminal Work and event identity remain business requirements. Manager-only data is created by public APIs, never inserted through the V1 seed.
- Examples are independent public transport examples, not a required stateful sequence. A success requires the state/time/lease/revision prerequisites in the original public documents. Smoke checks identity and a separate write/read path, not every operation or concurrency invariant.
- V2 wire clarification: RecordSchema field values are exactly {type:STRING|INTEGER|BOOLEAN,required:boolean}; the stray separator in the original notation does not introduce a fourth type. Empty field maps remain legal because no public minimum was stated.
- The V1 seed accepts LegacySchemaVersion without releaseBundleId; FINAL snapshots and fresh version reads add releaseBundleId:null for standalone and seeded versions. Previously saved V1 replay bodies remain LegacySchemaVersion. New standalone publication uses the FINAL response shape.
- V2 wire clarification: schema-draft dependencies for bundle members are stored as resolved {subjectId,version} pins, using prospective member versions. ReleaseBundle captures the dependency kind and canonical digest input described by the Manager; this does not alter snapshot/head validation.
- Seed Subject.createdAt is the first import transaction timestamp, preserved on replay; headVersion derives from the imported contiguous version history. The example has one valid optional BOOLEAN field, a verified RFC 8785 digest, and no dependency cycle.
- Bundle creation and publication use 200 under the original default-status rule. Publication returns the updated ReleaseBundle. Existing subject-version routes return the Manager extension consistently; no unpublished bundle seed fields are required.
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
