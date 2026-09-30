# ParcelFlow — V2 fixed public interface

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
| health | GET /api/health | docs/frontal-legacy/README.md#6-http-and-openapi-contract |
| production-ui | GET / | docs/frontal-legacy/README.md#6-http-and-openapi-contract |
| openapi | GET /openapi.json | docs/frontal-legacy/README.md#6-http-and-openapi-contract |
| create-warehouse | POST /api/admin/warehouses | docs/frontal-legacy/README.md#6-http-and-openapi-contract |
| create-sku | POST /api/admin/skus | docs/frontal-legacy/README.md#6-http-and-openapi-contract |
| set-inventory | PUT /api/admin/inventory/:warehouseId/:skuId | docs/frontal-legacy/README.md#6-http-and-openapi-contract |
| list-warehouses | GET /api/warehouses | docs/frontal-legacy/README.md#6-http-and-openapi-contract |
| list-skus | GET /api/skus | docs/frontal-legacy/README.md#6-http-and-openapi-contract |
| list-inventory | GET /api/inventory | docs/frontal-legacy/README.md#6-http-and-openapi-contract |
| create-order | POST /api/orders | docs/frontal-legacy/README.md#6-http-and-openapi-contract |
| list-orders | GET /api/orders | docs/frontal-legacy/README.md#6-http-and-openapi-contract |
| get-order | GET /api/orders/:orderId | docs/frontal-legacy/README.md#6-http-and-openapi-contract |
| cancel-order | POST /api/orders/:orderId/cancel | docs/frontal-legacy/README.md#6-http-and-openapi-contract |

## Explicit V2 wire clarifications

- Authority is the complete original README plus the preserved Manager requirement. The original commands, public query surfaces, domain errors, seed import scale, conservation, race, outbox, UI and performance requirements remain unchanged. No synthetic verification snapshot or seed-only business API is introduced.
- V2 public wire clarification: canonical /openapi.json is generated from this contract; the originally required openapi.yaml uses the same canonical document serialized as JSON-compatible YAML 1.2 (JSON text is valid YAML 1.2), including outbound webhook body and header schemas. Both representations preserve the author operation schemas, parameters and statuses. Error details is a JSON array; input timestamps accept explicit RFC 3339 offsets, output timestamps are UTC Z. Names and customer references are trimmed, then checked against their documented length limits.
- V2 Manager wire clarification: new Order reads include fulfillments, each {id,warehouseId,status,shipment,allocations:[{skuId,quantity}]}. Allocations expose the per-group quantities needed by the Manager UI and sort by skuId; groups sort by warehouse priority then warehouseId. The singular fulfillment remains exactly the V1 shape for one group and null for split orders. Saved V1 mutation replies remain valid without the added field.
- V2 Manager event clarification: previously committed V1 events and replay bodies stay unchanged. New single-warehouse orders keep their V1 order.allocated and order.cancelled payloads. Split order.allocated data is {orderId,fulfillments:[{fulfillmentId,warehouseId,lines:[{skuId,quantity}]}]}; split order.cancelled data is {orderId,fulfillmentIds,cancelledAt}. Every newly completed group emits fulfillment.shipped with the V1 shipment data shape; the final split order.shipped data is {orderId,fulfillmentIds,shippedAt}, while a single-warehouse terminal order.shipped keeps its V1 data. Group ID arrays preserve the published group order; all new event sequences are contiguous per order. Immutable prior events are not rewritten.
- Idempotency-Key and administrator Authorization distinguish absent from malformed parameters through missingTransportError and transportError. Invalid path and exact-ID filter values use INVALID_ID; an invalid or stale opaque cursor remains a business INVALID_CURSOR. Actual Bearer token comparison remains implementation-owned.
- The nonempty public seed links warehouse, SKU, current stock and a historical shipped order with its line, fulfillment and shipment. It imports only into an empty database once, emits the exact summary and no historical Work/events, and does not decrement the already-current onHand quantity. No Manager-only seed fields are added.
- The public smoke reads imported inventory/history and creates, cancels and rereads a fresh captured order without starting a worker. Full worker shipping, split allocation, concurrent cancellation, webhook delivery and recovery remain mandatory hidden/project-owned verification, not certified by this smoke.

## Delivery

Public checks are necessary, not sufficient. Re-read the entire README, audit every observable requirement, and run all required project checks. Guide completion does not mean task completion. Do not return fixture-only responses or empty arrays to simulate completed workflows.
