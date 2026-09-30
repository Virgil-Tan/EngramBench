# GeoPulse — V2 fixed public interface

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
- transportErrors preserves task-specific HTTP error codes. Otherwise V2 wire defaults are INVALID_REQUEST/400, MALFORMED_JSON/400, UNAUTHORIZED/401, NOT_FOUND/404 and UNSUPPORTED_MEDIA_TYPE/415; domain resource errors still follow the complete README.
- seed.example.json is a legal NONEMPTY seed. Its replay rule and argv are under contract.seed; do not guess db:seed versus seed.
- operation.example values are independent wire examples, not a complete executable business sequence. smoke contains an ordered public live sequence with captured identifiers.
- npm run check:contract-source only verifies author file integrity and schema construction.
- npm run test:public-contract uses a DISPOSABLE database, builds, migrates, imports the seed, starts the real API/roles, then checks nonempty identities and live operations. Do not point it at a valuable database.
- The official Harness runs the author-owned checker against an isolated copy before freezing. A public failure is feedback, not a hidden business score.

## Published operations

| ID | Method / path | Source |
| --- | --- | --- |
| createTenant | POST /api/v1/tenants | contract/README.md — explicit V2 public wire clarification |
| createDevice | POST /api/v1/devices | contract/README.md — explicit V2 public wire clarification |
| createRegion | POST /api/v1/regions | contract/README.md — explicit V2 public wire clarification |
| createRegionVersion | POST /api/v1/regions/:regionId/versions | docs/frontal-legacy/README.md — Domain and invariants |
| getRegion | GET /api/v1/regions/:regionId | contract/README.md — explicit V2 public wire clarification |
| ingestEvent | POST /api/v1/location-events | docs/frontal-legacy/README.md — Required behavior and HTTP surface |
| ingestBatch | POST /api/v1/location-events/batch | contract/README.md — explicit V2 public wire clarification |
| getMemberships | GET /api/v1/devices/:deviceId/memberships | docs/frontal-legacy/README.md — Required behavior and HTTP surface |
| getTransitions | GET /api/v1/devices/:deviceId/transitions | docs/frontal-legacy/README.md — Required behavior and HTTP surface |
| queryRegions | POST /api/v1/regions/query | docs/frontal-legacy/manager-requirements.md |
| createBundle | POST /api/v1/region-bundles | docs/frontal-legacy/manager-requirements.md |
| publishBundle | POST /api/v1/region-bundles/:bundleId/publish | docs/frontal-legacy/manager-requirements.md |
| rollbackBundle | POST /api/v1/region-bundles/:bundleId/rollback | docs/frontal-legacy/manager-requirements.md |
| getBundle | GET /api/v1/region-bundles/:bundleId | docs/frontal-legacy/manager-requirements.md |
| snapshot | GET /api/v1/verification-snapshot | docs/frontal-legacy/README.md — Seed and snapshot |
| health | GET /healthz | contract/README.md — explicit V2 public wire clarification |
| openapi | GET /openapi.json | docs/frontal-legacy/README.md — HTTP contract |
| productionUi | GET / | contract/README.md — explicit V2 public wire clarification |

## Explicit V2 wire clarifications

- V2 public wire clarification (new protocol, not a claim about the original specification): object schemas are closed; server-generated identities, counters and timestamps are omitted from creation inputs. Empty command bodies are {}. Tenant is exactly {tenantId,name}; no createdAt is added to it.
- V2 public wire clarification: snapshot is exactly {schemaVersion:1,resources,work,events}; every listed collection is complete and sorted lexicographically by its public identity (composite identities by listed component order). Manager resource collections extend resources. Snapshot requires Authorization: Bearer ADMIN_TOKEN. Health is {status:"ok"}; production UI is HTML at /. Error.details is exactly {}. DomainEvent uses the fixed redacted envelope declared in schemas; payload contains only the published resource references/state/digests, never credentials or raw sensitive content.
- V2 public wire clarification: seed is metadata, validated atomically including references and invariants; missing required fields are errors, not adapter defaults. Seed replay follows the original version+canonical digest no-op rule. JSON schema validates wire shape; business checks such as uniqueness, reference ownership, ordering, digest correctness and CAS remain implementation responsibilities.
- Every listed operation has an independent public request example. Examples containing resource IDs from later lifecycle stages illustrate wire shape, not a promise that they can all be called in isolation. Only smoke is an executable ordered scenario; it verifies real seed/read and write/read behavior, not full business acceptance.
- V2 wire clarification: Device adds externalRef and createdAt; Region adds createdAt. Region GET is the Region fields plus versions sorted by revision. Version creation assigns revision monotonically; effectiveTo is explicit null for an open interval. Batch input is {events:[...]}; response is {items,nextCursor:null} in input order.
- V2 wire clarification: seed adds regionBundles and regionBundleRevisions, and event/membership/transition expose nullable bundleRevisionId. The example includes an independent tenant/device/region/version/bundle graph, not a private test fixture.
- V2 selection clarification: query and event input may specify bundleId. Without it, no published bundle uses the original V1 active RegionVersions at observedAt/point.at and returns bundleRevisionId:null; exactly one published tenant bundle selects it; multiple published bundles require explicit bundleId and otherwise return INVALID_REQUEST. Explicit bundle selection must belong to tenant and have an active published revision. Frozen bundle membership does not waive RegionVersion effective-time validity. A point-query request may not span bundle publication boundaries: return INVALID_REQUEST rather than mix bundle revisions.
- Coordinates retain the original six-decimal constraint; schema multipleOf is a wire constraint, not permission to use floating-point boundary heuristics. Exact-edge BOUNDARY emits no transition. Point query matches inside and exact-boundary points; match arrays are sorted by (regionId,regionVersionId). This inclusion/sort convention is an explicit V2 wire clarification.
- No business or concurrency test is replaced: observedAt selection, late replay, hysteresis, DWELL, CAS, atomic batches and lease fencing remain original requirements. All 13 README routes and 4 Manager routes are declared.

## Delivery

Public checks are necessary, not sufficient. Re-read the entire README, audit every observable requirement, and run all required project checks. Guide completion does not mean task completion. Do not return fixture-only responses or empty arrays to simulate completed workflows.
