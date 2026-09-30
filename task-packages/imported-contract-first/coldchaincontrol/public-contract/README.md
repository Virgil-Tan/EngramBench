# ColdChainControl: public integration contract (taskVersion 4)

The external interface is fixed. The starter implementation is OPTIONAL and REPLACEABLE, not a business implementation.
README and the original Manager requirements still define every business obligation. Explicit v4 wire clarifications below override ONLY ambiguous transport representations in the legacy text, not business rules.

## External interface vs internal implementation

- Fixed: published HTTP methods/paths, request/response/error shapes, command names and arguments, environment variables, seed and snapshot wire formats. Preserve the original README business requirements and runtime constraints.
- Free: source directories, modules, function names, router/framework, build configuration, package module type, npm script BODIES and dependencies. Neither `src/` nor `dist/` nor `execute(operationId, context)` is required by the checker.
- `src/implementation.ts`, `src/lifecycle.ts`, `contract/server.mjs`, `contract/seed.mjs` and `tsconfig.json` are replaceable starter examples. Keep them only if useful; implement actual database-backed business behavior yourself.
- Author-owned specification and checks remain fixed: README/AGENTS, original requirements, contract/README.md, contract.json, openapi.json, seed.example.json, check.mjs, runtime.mjs and protected.json. Do not change these to make an incorrect implementation pass.
- Additional real application routes are allowed; they must not replace or change a published route. The optional starter's publicExtensions hook is one possible implementation, not a required interface.

## Commands and clean environment

Run `npm ci`, then `npm run build`. Preserve a reproducible package-lock.json and the required npm command NAMES; you may replace every command body. The untouched lifecycle stubs deliberately fail, and compilation alone is not delivery.
Run `npm run test:public-contract` in a DISPOSABLE database with DATABASE_URL, TEST_DATABASE_URL and ADMIN_TOKEN set. It replays migration/seed, starts the real roles and probes the live API. It is not safe to point at a valuable database.
The official gate runs the author copy in a new evaluator container on a fresh checkout/database. It does not trust a submitted test script or its reported result.
The checker launches `npm run start:api` with a numeric PORT and waits for a TCP listener, then sends actual HTTP requests. It launches workers/dispatchers via their public npm commands, never imports application modules and does not require Node IPC messages. Long-running role commands must stay alive and honor process termination.
Required commands: `npm run build`, `npm run db:migrate`, `npm run db:seed`, `npm run start:api`, `npm run start:worker`, `npm run start:dispatcher`, `npm run test:public-contract`, `npm run check:contract-source`, `npm run test:unit`, `npm run test:integration`, `npm run test:e2e`, `npm run test:concurrency`, `npm run test:recovery`, `npm run test:perf`, `npm run test:all`.
`npm run check:contract-source` checks file integrity/schema construction ONLY; this is not a live pass.

## Public create → operate → query check

The ordered `smoke` list in contract.json includes real successful writes followed by a query/snapshot of those same resources. `capture` binds response JSON pointers; `${name}` in later requests and expected bodies refers to that actual returned value. Whole-value references retain JSON types; path references are URL-encoded. A missing/wrong response cannot be replaced with a guessed ID. These are public integration examples, not hidden scoring cases.
- 1. health: HTTP 200.
- 2. openapi: HTTP 200.
- 3. verification-snapshot: HTTP 200.
- 4. list-excursions: HTTP 200.
- 5. create-tenant: HTTP 200; capture publicTenantId.
- 6. create-config-revision: HTTP 200; capture publicConfigId, publicConfigVersion.
- 7. verification-snapshot: HTTP 200.
- 8. publish-config-revision: HTTP 200.
- 9. verification-snapshot: HTTP 200.
- 10. create-recall: HTTP 400.

## Published operations

| Operation | Method / path | Request schema | Response schema | Source |
| --- | --- | --- | --- | --- |
| health | GET /healthz | see original text | see notes/original text | docs/frontal-legacy/README.md:14 |
| openapi | GET /openapi.json | see original text | published | docs/frontal-legacy/README.md:14 |
| production-ui | GET / | see original text | see notes/original text | docs/frontal-legacy/README.md:14 |
| create-tenant | POST /api/v1/tenants | published | published | contract/README.md (v4 wire clarification) |
| create-site | POST /api/v1/sites | published | published | contract/README.md (v4 wire clarification) |
| create-carrier | POST /api/v1/carriers | published | published | contract/README.md (v4 wire clarification) |
| create-device | POST /api/v1/devices | published | published | contract/README.md (v4 wire clarification) |
| create-config-revision | POST /api/v1/config-revisions | published | published | contract/README.md (v4 wire clarification) |
| publish-config-revision | POST /api/v1/config-revisions/:configRevisionId/publish | published | published | contract/README.md (v4 wire clarification) |
| create-config-assignment | POST /api/v1/devices/:deviceId/config-assignments | published | published | docs/frontal-legacy/README.md:57 |
| read-device-config | GET /api/v1/devices/:deviceId/config | see original text | published | contract/README.md (v4 wire clarification) |
| acknowledge-config | POST /api/v1/devices/:deviceId/config-acknowledgements | published | published | docs/frontal-legacy/README.md:58 |
| rotate-device-credential | POST /api/v1/devices/:deviceId/credentials/rotate | published | published | docs/frontal-legacy/README.md:63 |
| revoke-device-credential | POST /api/v1/devices/:deviceId/credentials/:keyVersion/revoke | published | published | docs/frontal-legacy/README.md:63 |
| ingest-telemetry | POST /api/v1/telemetry-readings | published | published | contract/README.md (v4 wire clarification) |
| create-shipment | POST /api/v1/shipments | published | published | contract/README.md (v4 wire clarification) |
| activate-shipment | POST /api/v1/shipments/:shipmentId/activate | published | published | contract/README.md (v4 wire clarification) |
| cancel-shipment | POST /api/v1/shipments/:shipmentId/cancel | published | published | contract/README.md (v4 wire clarification) |
| read-shipment | GET /api/v1/shipments/:shipmentId | see original text | published | docs/frontal-legacy/README.md:73 |
| read-shipment-timeline | GET /api/v1/shipments/:shipmentId/timeline | see original text | see notes/original text | docs/frontal-legacy/README.md:73 |
| deliver-shipment | POST /api/v1/shipments/:shipmentId/deliver | published | published | contract/README.md (v4 wire clarification) |
| acknowledge-excursion | POST /api/v1/excursions/:excursionId/acknowledge | published | published | contract/README.md (v4 wire clarification) |
| create-notification-policy | POST /api/v1/notification-policies | published | published | contract/README.md (v4 wire clarification) |
| list-excursions | GET /api/v1/excursions | see original text | published | contract/README.md (v4 wire clarification) |
| verification-snapshot | GET /api/v1/verification-snapshot | see original text | published | docs/frontal-legacy/README.md:84 |
| create-custody-chain | POST /api/v1/custody-chains | published | published | docs/frontal-legacy/manager-requirements.md:9 |
| read-custody-chain | GET /api/v1/custody-chains/:chainId | see original text | published | docs/frontal-legacy/manager-requirements.md:9 |
| offer-custody-handoff | POST /api/v1/custody-chains/:chainId/handoffs | published | published | docs/frontal-legacy/manager-requirements.md:9 |
| accept-custody-handoff | POST /api/v1/custody-handoffs/:handoffId/accept | published | published | docs/frontal-legacy/manager-requirements.md:9 |
| create-recall | POST /api/v1/recalls | published | published | docs/frontal-legacy/manager-requirements.md:9 |
| read-recall | GET /api/v1/recalls/:recallId | see original text | published | docs/frontal-legacy/manager-requirements.md:9 |
| quarantine-recall | POST /api/v1/recalls/:recallId/quarantine | published | published | docs/frontal-legacy/manager-requirements.md:9 |

## Wire clarifications and limits

- Source authority is the complete union of docs/frontal-legacy/README.md and manager-requirements.md. This document contains no hidden test data. Successful transport checks do not prove business correctness or completion.
- The legacy README allows either /healthz or /api/health. This v4 author contract chooses /healthz; it does not require an additional health alias. Health JSON body and production UI HTML are not specified by the legacy README.
- All mutation routes require a nonempty Idempotency-Key. Device config requests also require X-Device-Id, X-Device-Key-Version, X-Device-Timestamp and X-Device-Signature. Those authentication semantics require a live implementation, not only a JSON schema.
- v4 wire clarification: create requests supply domain input only; stored IDs, state-machine timestamps, sequence bookkeeping and projections are server outputs. Exact CreateTenant/Site/Carrier/Device/ConfigRevision/Shipment/NotificationPolicy and IngestTelemetry shapes are published here. Config publication takes {expectedVersion}; shipment activate/cancel/deliver and excursion acknowledge take {}. This clarification standardizes transport, not business transitions.
- v4 wire clarification: GET /devices/:deviceId/config selects the newest unexpired ConfigAssignment but returns its referenced ConfigRevision at the top level. ConfigAssignment remains observable in the snapshot. This supersedes only the ambiguous legacy success-body wording, not selection, authentication, expiry or fencing semantics. Config acknowledgement returns the changed ConfigAssignment.
- v4 wire clarification: GET /excursions returns {items:Excursion[],nextCursor:string|null}; null means no continuation. Supported query names are tenantId, shipmentId, kind, state, limit and cursor. The order is stable and cursor opaque. No new filter semantics or arbitrary maximum page size is introduced.
- The README describes shipment timeline as ordered public history without naming its response envelope. That route response remains explicitly unresolved; a JSON schema must not pretend the old prose already defined one.
- Lifecycle timestamp and not-yet-observed value nullability is not fully published. Nullable timestamps and projection/temperature placeholders are accepted rather than requiring invented sentinel values. Cross-field validity remains business validation.
- Seed schemaVersion and seedVersion types are not explicit in the legacy text; the public example chooses integer 1 and a string respectively. Manager resources are published under snapshot.managerResources, not invented as additional V1 seed keys.
- Snapshot Work/Event records are described semantically without exact field names, so this transport contract only requires object arrays. v4 wire clarification: snapshot telemetry retains its published signature key with the value null, never raw signature material. Seed credentials alone accept secret; public credentials never do. Retaining a null redaction marker preserves the named public record keys without exposing credentials.
- Recall cancellation is described semantically but no cancellation route is published. No route is invented here. RELEASED quarantine actions have no release endpoint in this version.
- Smoke assumes a fresh migrated database and the public empty seed. It creates a Tenant and a DRAFT ConfigRevision through public HTTP, captures their actual IDs/version, reads the draft from the PostgreSQL snapshot, publishes it and reads the same identity as PUBLISHED. Empty reads or a create-response echo alone do not pass this chain. It also checks health/OpenAPI and unknown-field validation; it is not a complete business or hidden evaluation.
- v4 wire clarification: config publish expectedVersion is the Tenant current published version before the transition; it is 0 before any configuration has been published. The public fresh-database chain publishes its first DRAFT using expectedVersion:0. A successful transition retains the created ConfigRevision identity and version; it does not create a second revision.

## Acceptance boundary

Public checks require a successful create → operation → query chain and verify returned IDs/state through the public snapshot. They prove only the tested integration surface, not exhaustive business correctness, all seed combinations, concurrency, recovery, authorization, UI or performance. Implement and verify the ENTIRE README; no finite smoke test guarantees all hidden cases pass.
A local Guide finishing or public smoke passing does not mean the task is finished. Only submit after full README audit and final verification.
A public gate failure is returned verbatim to the Coding Agent for repair in the same session. Infrastructure failures stop with diagnostics; they are not business test failures. Once the gate passes, the exact checked source is frozen before hidden evaluation.
