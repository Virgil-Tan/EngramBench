# EscrowGuard — V2 fixed public interface

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
| health | GET /healthz | docs/frontal-legacy/README.md; docs/frontal-legacy/manager-requirements.md; contract/README.md (V2 wire clarification) |
| openapi | GET /openapi.json | docs/frontal-legacy/README.md; docs/frontal-legacy/manager-requirements.md; contract/README.md (V2 wire clarification) |
| production-ui | GET / | docs/frontal-legacy/README.md; docs/frontal-legacy/manager-requirements.md; contract/README.md (V2 wire clarification) |
| list-escrows | GET /api/v1/escrows | docs/frontal-legacy/README.md; docs/frontal-legacy/manager-requirements.md; contract/README.md (V2 wire clarification) |
| create-escrow | POST /api/v1/escrows | docs/frontal-legacy/README.md; docs/frontal-legacy/manager-requirements.md; contract/README.md (V2 wire clarification) |
| read-escrow | GET /api/v1/escrows/:escrowId | docs/frontal-legacy/README.md; docs/frontal-legacy/manager-requirements.md; contract/README.md (V2 wire clarification) |
| submit-milestone | POST /api/v1/escrows/:escrowId/milestones/:milestoneId/submit | docs/frontal-legacy/README.md; docs/frontal-legacy/manager-requirements.md; contract/README.md (V2 wire clarification) |
| accept-milestone | POST /api/v1/escrows/:escrowId/milestones/:milestoneId/accept | docs/frontal-legacy/README.md; docs/frontal-legacy/manager-requirements.md; contract/README.md (V2 wire clarification) |
| open-dispute | POST /api/v1/escrows/:escrowId/milestones/:milestoneId/disputes | docs/frontal-legacy/README.md; docs/frontal-legacy/manager-requirements.md; contract/README.md (V2 wire clarification) |
| resolve-dispute | POST /api/v1/admin/disputes/:disputeId/resolve | docs/frontal-legacy/README.md; docs/frontal-legacy/manager-requirements.md; contract/README.md (V2 wire clarification) |
| domain-events | GET /api/v1/domain-events | docs/frontal-legacy/README.md; docs/frontal-legacy/manager-requirements.md; contract/README.md (V2 wire clarification) |
| verification-snapshot | GET /api/v1/verification-snapshot | docs/frontal-legacy/README.md; docs/frontal-legacy/manager-requirements.md; contract/README.md (V2 wire clarification) |

## Explicit V2 wire clarifications

- Source authority is the full public README, Manager requirements and AGENTS. No hidden evaluator data or solution code is imported. This V2 contract fixes wire boundaries; state machines, algorithms, isolation, migrations and performance remain implementation work.
- V2 wire clarification: every route has the closed request/success schema published here; only business inputs occur in creation requests. Omitted success status is 200. Health returns {status:"ok"}; UI returns HTML. Collection nextCursor is string or null, with null denoting completion. Path/query/header parameters and independent request examples are explicit. Examples validate transport only, not eligibility of referenced resources.
- V2 wire clarification: the authenticated verification snapshot is one point-in-time envelope with complete named resource arrays, typed retained Work and ordered DomainEvents. When the legacy source did not specify event fields, V2 uses eventId,aggregateId,sequence,type,occurredAt,schemaVersion,payload; payload remains a JSON object. No hidden event payload is prescribed.
- The seed uses the exact V1 array names and graph references. Repeated identical seed import is a no-op; another digest under the same seedVersion conflicts. Manager resources are derived by migration or created by public operations, never invented V1 seed members.
- V2 wire clarification: GET Escrow detail is the top-level Escrow plus milestones, dispute (current open Dispute or null), releases, fundPosition, beneficiaryShares and beneficiaryPayouts. FundPosition has totalMinor,availableMinor,releasedMinor,refundedMinor and equals the Escrow amounts. Submit returns {milestone,escrow}; accept returns Release; dispute creation/resolution return Dispute. Collections use {items,nextCursor}.
- Evidence is explicitly RFC 8785 JSON, not an invented evidence-resource schema. Escrow and beneficiary count/sign/sum/currency rules retain their named business errors; schema only enforces their JSON scalar types. Unknown keys remain UNKNOWN_FIELD.
- ReleaseResponse permits only the exact V1 Release or its exact Manager extension with payouts. Previously saved V1 replay bodies remain unchanged; a new multi-beneficiary release includes all ordered payouts. Manager snapshot collections expose every captured share and payout.
- The public seed is V1 only: three Parties plus a funded Escrow and one pending Milestone with exactly conserved value. Migration creates its one Seller share. No Manager-only seed members, worker implementation or settlement algorithm is provided.
- All original role authorization, conservation, escrow/dispute/expiry races, migration identities, UI and fixed performance obligations remain mandatory. No new event types or payload members are introduced.

## Delivery

Public checks are necessary, not sufficient. Re-read the entire README, audit every observable requirement, and run all required project checks. Guide completion does not mean task completion. Do not return fixture-only responses or empty arrays to simulate completed workflows.
