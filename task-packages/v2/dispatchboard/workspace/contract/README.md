# DispatchBoard — V2 fixed public interface

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
| health | GET /healthz | docs/frontal-legacy/README.md; V2 wire clarification (contracts/learning contract and generated contract/README.md) |
| openapi | GET /openapi.json | docs/frontal-legacy/README.md; V2 wire clarification (contracts/learning contract and generated contract/README.md) |
| production-ui | GET / | docs/frontal-legacy/README.md; V2 wire clarification (contracts/learning contract and generated contract/README.md) |
| deliveries-list | GET /api/v1/deliveries | docs/frontal-legacy/README.md; V2 wire clarification (contracts/learning contract and generated contract/README.md) |
| delivery-get | GET /api/v1/deliveries/:deliveryId | docs/frontal-legacy/README.md; V2 wire clarification (contracts/learning contract and generated contract/README.md) |
| delivery-create | POST /api/v1/deliveries | docs/frontal-legacy/manager-requirements.md; V2 wire clarification (contracts/learning contract and generated contract/README.md) |
| offer-accept | POST /api/v1/offers/:offerId/accept | docs/frontal-legacy/README.md; docs/frontal-legacy/manager-requirements.md; V2 wire clarification (contracts/learning contract and generated contract/README.md) |
| delivery-cancel | POST /api/v1/deliveries/:deliveryId/cancel | docs/frontal-legacy/README.md; V2 wire clarification (contracts/learning contract and generated contract/README.md) |
| delivery-pickup | POST /api/v1/deliveries/:deliveryId/pickup | docs/frontal-legacy/README.md; V2 wire clarification (contracts/learning contract and generated contract/README.md) |
| delivery-complete | POST /api/v1/deliveries/:deliveryId/complete | docs/frontal-legacy/README.md; V2 wire clarification (contracts/learning contract and generated contract/README.md) |
| delivery-offers | GET /api/v1/deliveries/:deliveryId/offers | docs/frontal-legacy/README.md; V2 wire clarification (contracts/learning contract and generated contract/README.md) |
| courier-get | GET /api/v1/couriers/:courierId | docs/frontal-legacy/README.md; V2 wire clarification (contracts/learning contract and generated contract/README.md) |
| assignment-ready | POST /api/v1/deliveries/:deliveryId/assignments/:assignmentId/ready | docs/frontal-legacy/manager-requirements.md; V2 wire clarification (contracts/learning contract and generated contract/README.md) |
| domain-events | GET /api/v1/domain-events | docs/frontal-legacy/README.md; V2 wire clarification (contracts/learning contract and generated contract/README.md) (event collection envelope) |
| verification-snapshot | GET /api/v1/verification-snapshot | docs/frontal-legacy/README.md; V2 wire clarification (contracts/learning contract and generated contract/README.md) |

## Explicit V2 wire clarifications

- Source authority is the full public README, Manager requirements and AGENTS. No hidden evaluator data or solution code is imported. This V2 contract fixes wire boundaries; state machines, algorithms, isolation, migrations and performance remain implementation work.
- V2 wire clarification: every route has the closed request/success schema published here; only business inputs occur in creation requests. Omitted success status is 200. Health returns {status:"ok"}; UI returns HTML. Collection nextCursor is string or null, with null denoting completion. Path/query/header parameters and independent request examples are explicit. Examples validate transport only, not eligibility of referenced resources.
- V2 wire clarification: the authenticated verification snapshot is one point-in-time envelope with complete named resource arrays, typed retained Work and ordered DomainEvents. When the legacy source did not specify event fields, V2 uses eventId,aggregateId,sequence,type,occurredAt,schemaVersion,payload; payload remains a JSON object. No hidden event payload is prescribed.
- The seed uses the exact V1 array names and graph references. Repeated identical seed import is a no-op; another digest under the same seedVersion conflicts. Manager resources are derived by migration or created by public operations, never invented V1 seed members.
- V2 wire clarification: legacy offer acceptance returns Assignment, consistent with the published hot-offer-claims successful Assignment result; team acceptance and ready return the complete TeamAssignment, including current role reservations. This resolves the original prose tension between an ASSIGNED delivery and an Assignment response without changing the acceptance transaction. Delivery lifecycle mutations return Delivery or TeamDelivery. Offer history is {items:[Offer|TeamOffer]}.
- The public smoke asserts created/read identity, not a timing-sensitive delivery state. Its single-zone distance matrix is complete and symmetric. The courier notification URL is an independently authored local test-double address; no real courier service is contacted.
- V2 clarification of a source inconsistency: seed prose calls load positive but the published performance seed has zero assignments. An idle Courier has activeLoadUnits:0; capacityUnits and an actual Assignment load remain positive. This is not a new minimum-workload rule.
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
