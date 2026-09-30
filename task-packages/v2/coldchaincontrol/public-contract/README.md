# ColdChainControl — V2 fixed public interface

Author scaffold revision 2026-09-08.1: exact decimal validation and incremental seed-file decoding. This is a revised public scaffold, not the unchanged historical evaluation environment. Business requirements and seed scale remain unchanged.

Business requirements: read the COMPLETE ../docs/frontal-legacy/README.md and manager-requirements.md. The files are preserved verbatim. The wire clarifications below override only ambiguous representations, never remove business requirements.
Public author policy revision coldchaincontrol-2026-09-08.1: read the supplements below in full. They resolve explicitly identified business-policy and test-protocol omissions; only an explicitly named author-approved exception overrides a corresponding original rule, and every other original obligation remains in force. This revision must not be compared as an unchanged historical benchmark.

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
| health | GET /healthz | docs/frontal-legacy/README.md:14 |
| openapi | GET /openapi.json | docs/frontal-legacy/README.md:14 |
| production-ui | GET / | docs/frontal-legacy/README.md:14 |
| create-tenant | POST /api/v1/tenants | contract/README.md (v4 wire clarification) |
| create-site | POST /api/v1/sites | contract/README.md (v4 wire clarification) |
| create-carrier | POST /api/v1/carriers | contract/README.md (v4 wire clarification) |
| create-device | POST /api/v1/devices | contract/README.md (v4 wire clarification) |
| create-config-revision | POST /api/v1/config-revisions | contract/README.md (v4 wire clarification) |
| publish-config-revision | POST /api/v1/config-revisions/:configRevisionId/publish | contract/README.md (v4 wire clarification) |
| create-config-assignment | POST /api/v1/devices/:deviceId/config-assignments | docs/frontal-legacy/README.md:57 |
| read-device-config | GET /api/v1/devices/:deviceId/config | contract/README.md (v4 wire clarification) |
| acknowledge-config | POST /api/v1/devices/:deviceId/config-acknowledgements | docs/frontal-legacy/README.md:58 |
| rotate-device-credential | POST /api/v1/devices/:deviceId/credentials/rotate | docs/frontal-legacy/README.md:63 |
| revoke-device-credential | POST /api/v1/devices/:deviceId/credentials/:keyVersion/revoke | docs/frontal-legacy/README.md:63 |
| ingest-telemetry | POST /api/v1/telemetry-readings | contract/README.md (v4 wire clarification) |
| create-shipment | POST /api/v1/shipments | contract/README.md (v4 wire clarification) |
| activate-shipment | POST /api/v1/shipments/:shipmentId/activate | contract/README.md (v4 wire clarification) |
| cancel-shipment | POST /api/v1/shipments/:shipmentId/cancel | contract/README.md (v4 wire clarification) |
| read-shipment | GET /api/v1/shipments/:shipmentId | docs/frontal-legacy/README.md:73 |
| read-shipment-timeline | GET /api/v1/shipments/:shipmentId/timeline | docs/frontal-legacy/README.md:73 |
| deliver-shipment | POST /api/v1/shipments/:shipmentId/deliver | contract/README.md (v4 wire clarification) |
| acknowledge-excursion | POST /api/v1/excursions/:excursionId/acknowledge | contract/README.md (v4 wire clarification) |
| create-notification-policy | POST /api/v1/notification-policies | contract/README.md (v4 wire clarification) |
| list-excursions | GET /api/v1/excursions | contract/README.md (v4 wire clarification) |
| verification-snapshot | GET /api/v1/verification-snapshot | docs/frontal-legacy/README.md:84 |
| create-custody-chain | POST /api/v1/custody-chains | docs/frontal-legacy/manager-requirements.md:9 |
| read-custody-chain | GET /api/v1/custody-chains/:chainId | docs/frontal-legacy/manager-requirements.md:9 |
| offer-custody-handoff | POST /api/v1/custody-chains/:chainId/handoffs | docs/frontal-legacy/manager-requirements.md:9 |
| accept-custody-handoff | POST /api/v1/custody-handoffs/:handoffId/accept | docs/frontal-legacy/manager-requirements.md:9 |
| create-recall | POST /api/v1/recalls | docs/frontal-legacy/manager-requirements.md:9 |
| read-recall | GET /api/v1/recalls/:recallId | docs/frontal-legacy/manager-requirements.md:9 |
| quarantine-recall | POST /api/v1/recalls/:recallId/quarantine | docs/frontal-legacy/manager-requirements.md:9 |

## Explicit V2 wire clarifications

- Public smoke imports the published credential, signs real config and telemetry requests using database snapshot time, and verifies the accepted reading in the persisted snapshot. Its HMAC helper is client-side request construction only: storage, lookup, verification and business effects remain implementation work.
- Authority is the complete original README and Manager requirements. The following V2 clarifications fix wire representation only; every original business, UI, recovery and performance obligation remains required.
- Health is GET /healthz with {status:"ok"}; production / returns nonempty text/html. OpenAPI is 3.1 and generated from this same contract.
- All mutations require a nonempty Idempotency-Key. Device config, acknowledgement and ingest require the four X-Device authentication headers. Signature and database-time authentication remain business validation. Wire-invalid device-authentication headers return 401 INVALID_DEVICE_SIGNATURE.
- Request schemas publish only input fields. New ConfigRevision is the next tenant version; publish expectedVersion is the previous published version (0 before first publication), and publication preserves the created identity/version.
- GET device config returns the referenced ConfigRevision at top level; its selected ConfigAssignment remains in the snapshot. Shipment transitions and excursion acknowledgement take an empty JSON object.
- GET excursions returns {items,nextCursor}; query tenantId/shipmentId/kind/state filter, limit is a positive safe integer (default 50), cursor is opaque. Stable ordering and continuity must survive restart.
- Shipment timeline returns {shipmentId,readings,excursions,events}; readings sort by sequence/readingId and redact signature to null; excursions sort by firstSequence/excursionId; events sort by aggregate sequence/eventId. All records come from the shipment tenant and point-in-time committed history.
- Work and Event use the explicitly closed schemas published here. Work leaseOwner/leaseToken/leaseExpiresAt are null unless leased; lastError is string|null. Event payload and Audit details are explicitly free JSON metadata, recursively secret-free. outboxState reports PENDING/DELIVERED/DEAD_LETTER.
- Unobserved projection timestamp/coordinates/temperature and nullable lifecycle timestamps are null. Excursion observed bounds are nullable for OFFLINE. Snapshot telemetry signature is always null, while ingest/seed carries the signed value.
- Seed header is schemaVersion:1, string seedVersion and UTC importedAt. The nonempty public graph links a tenant, carrier, active device, credential, published config and confirmed assignment. Identical seed replay is a no-op; changed bytes under one version reject atomically. Manager collections remain snapshot.managerResources, outside the V1 seed whitelist.
- UUID path parameters are lowercase canonical UUIDs, keyVersion is a positive safe integer. Query/path integers are normalized from HTTP strings; JSON numbers are never coerced. Unknown query/JSON keys and other malformed shapes use 400 INVALID_REQUEST; malformed JSON uses 400 MALFORMED_JSON; unsupported media uses 415 UNSUPPORTED_MEDIA_TYPE; missing snapshot auth uses 401 UNAUTHORIZED. Original named business errors retain their original status.
- Recall cancellation has no published endpoint; no new business route is invented. All canonical payloads, sortedness, foreign keys, state transitions and cross-field consistency remain implementation work.
- The smoke verifies the linked seed, independently creates a tenant/config, reads it, publishes it and reads the committed published identity. Public smoke does not certify hidden, concurrent, recovery, Chromium or performance behavior.
- # ColdChainControl public policy and execution protocol

Policy revision: `coldchaincontrol-2026-09-08.1`.

These are new author-approved choices, not rules retroactively inferred from old
submissions. All arms receive this supplement. Original business requirements,
security invariants, workload sizes and performance thresholds remain unchanged.

## Site radius

Coordinates are integer degrees times 1,000,000. Use spherical Haversine distance
with Earth radius exactly 6,371,008.8 metres, clamping its intermediate to [0,1].
Quantize once to integer millimetres: floor(distanceMetres * 1000 + 0.5).
Membership is inclusive: distanceMillimetres <= radiusMeters * 1000.
Only Sites in the Shipment Tenant and frozen route are eligible. Select minimum
quantized distance, breaking ties by lexicographically smallest lowercase siteId.
Site membership never permits route regression, skipped custody or delivery with
unresolved temperature excursions.

## Notifications

Mandatory notification kinds for matching ACTIVE policies are EXCURSION_OPENED,
EXCURSION_RESOLVED, SHIPMENT_DELIVERED, SHIPMENT_CANCELLED, RECALL_ISSUED and
RECALL_CONTAINED. Their exact payload is {resourceType,resourceId,shipmentId,state}.
resourceType is Excursion, ColdShipment or RecallOrder, resourceId is its UUID and
state is the committed public state. shipmentId is the parent Shipment UUID for
Excursion, the Shipment UUID itself for ColdShipment, and null for RecallOrder.
Excursion/Shipment events use aggregateType ColdShipment and aggregateId shipmentId;
Recall events use aggregateType RecallOrder and aggregateId resourceId.
Other original mandatory Events remain required and may retain their public types.

Create exactly one logical Delivery per matching (notificationPolicyId,eventId)
atomically with the effect/Event. Normally use the frozen policy destination.
WEBHOOK_URL, when configured, overrides the transport destination for local tests;
it does not bypass policy matching or logical recipient identity.

POST the immutable Event without outboxState:
{eventId,tenantId,aggregateType,aggregateId,sequence,kind,occurredAt,payload}.
Use Content-Type application/json and X-ColdChain-Event-Id equal to eventId.
Canonical JSON sorts object keys recursively by JavaScript UTF-16 order, preserves
arrays, uses JSON.stringify without whitespace, then UTF-8. Freeze complete bytes
once; retries preserve eventId and exact bytes. Mutable delivery status/attempts
never enter the payload. Original secret/HMAC/attestation exclusions apply.

## Durable rate, retry and dead letter

At admission time the Tenant budget is the minimum positive rateLimitPerMinute
among its ACTIVE policies. No ACTIVE policies means no admission. A shared durable
sliding window counts ALL HTTP send admissions across policies/processes/retries
in (databaseNow-60 seconds,databaseNow]. Reserve admission before sending. A crash
after reservation may consume a slot. Quota deferral sends nothing and does not
increment attempts; retry no earlier than the oldest counted admission +60s.

HTTP 2xx acknowledges. Unknown ACK, connection failures and other statuses retry
the same Delivery, at most six admitted attempts. After failures 1..5, earliest
delays are 1,2,4,8,16 seconds from database attempt completion, subject also to
the shared quota. Failure six commits DEAD_LETTER with null nextAttemptAt and
deliveredAt. Success commits DELIVERED and database deliveredAt. Crashes cannot
fabricate ACK, allocate replacement event identities or forget reserved attempts.
Cancellation suppresses only unsent excursion notifications made inapplicable;
its own SHIPMENT_CANCELLED event and already-observed unknown ACK retries are not
discarded. Suppression is durable DEAD_LETTER with no extra HTTP attempt.

## Recovery barrier protocol

Enable only when TEST_BARRIER_URL and TEST_BARRIER_TOKEN are both nonempty. POST
to that exact URL with Content-Type application/json and X-Test-Barrier-Token
equal to TEST_BARRIER_TOKEN. Do not log/persist this token.

Worker body is closed: {role:"worker",point,kind,workId,aggregateId,attempt,leaseToken}.
IDs are UUIDs, attempt is the positive persisted claim ordinal, and leaseToken is
the nonempty opaque token for that claim. kind is the actual published Work kind.
- worker.claimed: after durable claim, before effect preparation.
- worker.before-commit: after preparation, immediately before the transaction
  that writes effects and completes/cancels Work.
- worker.after-attempt: after the guarded transaction has completed or rejected
  the attempt. This body additionally requires outcome, either committed or stale.
  A stale outcome means no business or Work write from that attempt. This receipt
  makes release of an obsolete owner observable without relying on arbitrary sleeps.

All three apply to CONFIG_DELIVER, TELEMETRY_PROJECT, DEVICE_OFFLINE_CHECK,
CUSTODY_HANDOFF_EXPIRY, RECALL_PROPAGATE and QUARANTINE_ENFORCE. A paused barrier
must not retain locks preventing reclaim, cancellation or supersession. Release
does not grant authority: revalidate database lease/token and domain authority in
the effect transaction. A stale released owner cannot write effects or Work state.

Dispatcher body is closed:
{role:"dispatcher",point:"dispatcher.response-received",notificationDeliveryId,eventId,attempt,responseStatus}.
IDs are UUIDs, attempt is positive, responseStatus is an integer 100..599. Call
after receiving the webhook response, before persisting ACK. Do not invent Work
for Delivery. Controller may hold, kill or release after a replacement completes.
Any 2xx releases; ignore body. Failure/non-2xx is not permission to proceed with
effects/ACK: leave recoverable durable state. When disabled, do not call barriers
or use an alternate business implementation. Controllers provide no business code.


## Delivery

Public checks are necessary, not sufficient. Re-read the entire README, audit every observable requirement, and run all required project checks. Guide completion does not mean task completion. Do not return fixture-only responses or empty arrays to simulate completed workflows.
