# MeterSettle — V2 fixed public interface

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
| health | GET /healthz | docs/frontal-legacy/README.md |
| openapi | GET /openapi.json | docs/frontal-legacy/README.md |
| production-ui | GET / | docs/frontal-legacy/README.md |
| list-statements | GET /api/v1/statements | docs/frontal-legacy/README.md |
| get-statement | GET /api/v1/statements/:statementId | docs/frontal-legacy/manager-requirements.md |
| create-usage-batch | POST /api/v1/usage-batches | docs/frontal-legacy/README.md |
| advance-watermark | POST /api/v1/tenants/:tenantId/watermark | docs/frontal-legacy/README.md |
| get-watermark | GET /api/v1/tenants/:tenantId/watermark | docs/frontal-legacy/README.md |
| meter-usage | GET /api/v1/meters/:meterId/usage | docs/frontal-legacy/README.md |
| domain-events | GET /api/v1/domain-events | docs/frontal-legacy/README.md |
| create-correction-batch | POST /api/v1/correction-batches | docs/frontal-legacy/manager-requirements.md |
| get-statement-revision | GET /api/v1/statements/:statementId/revisions/:revision | docs/frontal-legacy/manager-requirements.md |
| verification-snapshot | GET /api/v1/verification-snapshot | docs/frontal-legacy/README.md |

## Explicit V2 wire clarifications

- The complete public README and Manager requirements remain business authority. These V2 schemas freeze previously unspecified transport fields; they are authored from public documents only. The public smoke checks interface and persistence identity, not complete business correctness.
- V2 wire clarification: health returns {status:"ok"}; the production root returns HTML. Mutation bodies are closed, server-generated identity/state/timestamps are outputs, all mutation examples require durable Idempotency-Key, and unspecified success status is 200. Path parameters use their corresponding resource field types. Collection limits are 1..100 (default 50) with stable opaque cursors.
- V2 wire clarification: Tenant is {tenantId,name}; the default AuditEntry/AuditCheckpoint, DomainEvent envelope and fenced Work fields are the published schema definitions. Unless legacy prose literally fixes payload to {}, DomainEvent.payload is a public JSON object. This does not authorize exposing secrets or inventing event types.
- V2 wire clarification: snapshot is one PostgreSQL point-in-time with exact resources, work and events keys (and schemaVersion only where declared). Resource arrays are complete, sorted by public identity tuple; audit by tenantId then sequence, events by aggregateId then sequence then eventId, Work by workId. Foreign keys, state invariants and digest validity remain implementation validation. Token/credential/private-path fields never appear in snapshot.
- Seed preserves exactly the V1 top-level members; Manager-only resources are created by public operations or the explicitly required compatibility migration. The nonempty example is a minimal legal starting graph, with no evaluator fixtures.
- V2 representation clarification: a watermark mutation returns the same closed Watermark view as its GET (without tenant name). A revision detail returns {statementRevision,correctionEvents}; the Manager StatementDetail is used for current statement detail reads. Revision is an integer >=2, not a UUID. Base Statement revision remains exactly 1.
- Usage filters from/to are optional UTC bounds on occurredAt and use [from,to); omitted bounds are unbounded. Usage collection order is occurredAt then eventId; statement list order is statementId. Domain-event afterSequence defaults to zero and its nextCursor is null: continuation uses the last returned sequence together with aggregateId. Without aggregateId, order is aggregateId then sequence then eventId.
- The SeedUsageEvent deliberately omits ingestedAt; the importer derives it from importedAt. Seed is exactly the four published V1 arrays. Snapshot adds the Manager arrays, and tenantStates differs from the seed tenants view. Resource ordering remains the precise README/Manager tuple, including ratePlans tenantId/version, usageEvents tenantId/eventId, correctionEvents tenantId/correctionId and statementRevisions statementId/revision.
- The minimally sufficient rate-plan wire encoding is the published immutable flat unitPriceMinor. No tiers, private billing policy or new financial rounding rule is introduced. All integer arithmetic, corrections, month assignment, finalized-watermark rules and overflow detection remain implementation responsibilities.
- V2 representation clarification: acceptedEventIds/duplicateEventIds and acceptedCorrectionIds/duplicateCorrectionIds each preserve relative request-member order. Correction reason is the published unrestricted string, including empty text; no private reason-length limit is added. Correction ingestion itself emits no DomainEvent: the sole additional Manager type is statement.revision-finalized after finalization.
- Stable business errors remain INVALID_USAGE_BATCH (400), RATE_PLAN_UNAVAILABLE, EVENT_ID_CONFLICT, LATE_USAGE_EVENT, WATERMARK_NOT_ADVANCING (409), INVALID_CORRECTION_BATCH and CORRECTION_TOTAL_OVERFLOW (400), CORRECTION_ID_CONFLICT, NEGATIVE_EFFECTIVE_USAGE and STATEMENT_REVISION_PENDING (409). Shape errors on batch requests use the corresponding published INVALID_*_BATCH, unknown keys still UNKNOWN_FIELD.

## Delivery

Public checks are necessary, not sufficient. Re-read the entire README, audit every observable requirement, and run all required project checks. Guide completion does not mean task completion. Do not return fixture-only responses or empty arrays to simulate completed workflows.
