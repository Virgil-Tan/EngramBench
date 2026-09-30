# RouteWeave — Complete system requirements

Public scope revision: **learning-final-system-2026-09-08.1**. This is a single final-system task, not a historical upgrade benchmark.

## Scope and authority

- Build one complete system from the start. Base features and the formerly named Manager features are required together; there is no intermediate submission, old program, historical workspace, or cross-version upgrade assessment.
- V1 in an API or source description denotes the base feature contract, not a separately running program. The published /api/v1 paths and schemaVersion values do not change.
- Cross-version-only duties are withdrawn: importing an unspecified historical physical database, upgrading an earlier binary, migration-time availability of an earlier binary, and synthesizing migration-only legacy wrappers. Current public resource shapes, base APIs, additional features and their ordinary business relationships remain required.
- Initialize an empty database using the published commands. db:migrate is current-system schema initialization, not an obligation to recognize a hidden old schema. Preserve the original current-system seed validation, atomicity and replay rules.
- Evaluation creates fresh data through the published seed or APIs, then checks actual behavior and durable state. Restart and recovery assertions use this same final system. A snapshot is a read-only observation, not a database backup format.
- Persistence, transactionality, idempotency, concurrency, authorization, real UI, OpenAPI, recovery and explicitly specified performance requirements remain in scope. This policy does not remove an otherwise explicit business or security requirement.
- No external legacy service is required. An isolated receiver or provider simulator is used only for an external interaction actually required by the public product contract; no real account or production service is required.
- Hidden assertions must use published inputs and observable requirements. Unspecified algorithms, exact error strings, control points or performance thresholds cannot silently become requirements. Code defects fail; invalid author fixtures and infrastructure faults are evaluator errors, not zero-score business outcomes.

The original source documents are retained under frontal-legacy/ only for provenance. The complete active business requirements are reproduced below; the withdrawn historical orchestration and cross-version-only clauses are not a second source of obligations. contract/ fixes public representation.

## Base product requirements

# RouteWeave

Build a production-style, tenant-isolated logistics tracking platform from this intentionally blank repository. Use TypeScript on Node.js 22, PostgreSQL 16, a React production UI, independent projection workers, and an outbox dispatcher. Immutable scan evidence and PostgreSQL are authoritative; in-memory tracking state, SQLite, mocks, or placeholder tests are not acceptable.

## Required commands

```text
npm run build
npm run db:migrate
npm run db:seed -- --file <absolute-json-path>
npm run start:api
npm run start:worker
npm run start:dispatcher
npm run test:unit
npm run test:integration
npm run test:e2e
npm run test:concurrency
npm run test:recovery
npm run test:all
npm run test:perf
```

Commands are non-interactive and report failure with nonzero exit status. `start:api` serves the API, OpenAPI, health, and production UI; worker and dispatcher are independent processes. `SIGTERM` stops each role cleanly.

## Environment

| Variable | Contract |
| --- | --- |
| `DATABASE_URL` | Required PostgreSQL authority |
| `PORT` | API port, default `3000` |
| `ADMIN_TOKEN` | Bearer token for verification snapshot only |
| `WEBHOOK_URL` | Domain-event dispatcher target |
| `WORK_LEASE_SECONDS` | Projection lease, default `3`, range 1..300 |
| `TEST_BARRIER_URL`, `TEST_BARRIER_TOKEN` | Optional controlled crash barrier |

Do not expose carrier credentials, private facility metadata, admin tokens, database values, personal address data, private paths, or another tenant's journey.

## Domain model

- `Tenant {tenantId,name}`.
- `Hub {hubId,tenantId,code,name,timeZone}`; code is unique inside one Tenant.
- `Carrier {carrierId,tenantId,code,name,state:ACTIVE|SUSPENDED}`.
- `Shipment {shipmentId,tenantId,trackingCode,state:PLANNED|IN_TRANSIT|DELIVERED|LOST|CANCELLED,currentRoutePlanId,createdAt}`.
- `RoutePlan {routePlanId,shipmentId,revision,reason:INITIAL|REASSIGNED,priorRoutePlanId,createdAt}` owns ordered `TransportLeg`s.
- `TransportLeg {legId,routePlanId,ordinal,fromHubId,toHubId,carrierId,state:PLANNED|DEPARTED|ARRIVED|SKIPPED}`.
- `ScanEvent {scanEventId,tenantId,shipmentId,scannerEventId,type,hubId,legId,observedAt,receivedAt,payloadDigest}` is immutable source evidence.
- `JourneyProjection {shipmentId,projectionVersion,currentHubId,currentLegId,state,lastObservedAt,routePlanRevision}` is fully reproducible.
- `LossCase {lossCaseId,shipmentId,state:OPEN|RESOLVED_FOUND|RESOLVED_REASSIGNED,openedAt,resolvedAt}`.
- `Reassignment {reassignmentId,shipmentId,lossCaseId,fromRoutePlanId,toRoutePlanId,reason,createdAt}`.

Accepted ScanEvent types are `PICKED_UP`, `DEPARTED`, `ARRIVED`, `DELIVERED`, `LOSS_REPORTED`, and `FOUND`. Each event names the route revision and applicable hub/leg.

## Invariants and projection rules

1. A RoutePlan has at least one leg. Leg ordinals are contiguous from 1, adjacent legs join at the same Hub, and a Shipment has one current revision. Plans and legs are immutable after creation.
2. `(tenantId, scannerEventId)` identifies one canonical ScanEvent. Same body replays; a different body returns `SCAN_EVENT_CONFLICT`. Arrival time never changes evidence order.
3. Projection order is `(observedAt, typePrecedence, scanEventId)`, where `LOSS_REPORTED < FOUND < PICKED_UP < DEPARTED < ARRIVED < DELIVERED`. Rebuilding from the same set produces byte-equivalent business state across workers and restarts.
4. An event can advance a leg only when its hub/leg belongs to the event's frozen RoutePlan revision. A late valid event from an older plan remains visible evidence but cannot move the current projection after a Reassignment fence.
5. ARRIVED cannot precede the matching DEPARTED in projected state, a later leg cannot advance before all prior legs arrive, and DELIVERED is valid only at the final destination. Out-of-order evidence stays accepted and becomes effective when dependencies arrive.
6. LOSS_REPORTED opens at most one LossCase and fences movement. FOUND closes it and resumes the same plan. Reassignment closes it, creates one new route revision, skips unfinished old legs, and atomically moves the projection fence.
7. DELIVERED and CANCELLED are terminal. A late duplicate or older scan changes no terminal state; conflicting terminal evidence returns a stable conflict without deleting evidence already committed.
8. Shipment/plan creation, projection work, and Domain Event commit atomically. Projection Work may replay after lease expiry but each accepted evidence revision emits at most one logical projection result.
9. All resources, cursors, events, work, and UI queries are tenant-isolated.

## HTTP and OpenAPI

Serve OpenAPI 3.1 at `GET /openapi.json`, health at `GET /healthz`, and:

```text
GET/POST /api/v1/tenants
GET/POST /api/v1/hubs
GET/POST /api/v1/carriers
GET/POST /api/v1/shipments
GET      /api/v1/shipments/:shipmentId
GET      /api/v1/shipments/:shipmentId/timeline
POST     /api/v1/scan-events
POST     /api/v1/shipments/:shipmentId/loss
POST     /api/v1/shipments/:shipmentId/found
POST     /api/v1/shipments/:shipmentId/reassign
POST     /api/v1/shipments/:shipmentId/cancel
GET      /api/v1/verification-snapshot
```

Shipment creation accepts `{tenantId,trackingCode,legs:[{fromHubId,toHubId,carrierId}]}` and returns stable Shipment, RoutePlan, and leg identities. Scan creation accepts `{tenantId,shipmentId,scannerEventId,type,routePlanRevision,hubId,legId,observedAt}`. Reassign accepts `{lossCaseId,expectedRoutePlanRevision,reason,legs}` and atomically creates the replacement plan.

Every mutation requires `Idempotency-Key` (1..128 visible ASCII). Canonical replay returns the original status and JSON across unknown response, concurrent calls, and restart; different input returns `409 IDEMPOTENCY_CONFLICT`. Strict JSON rejects unknown/duplicate fields, malformed JSON, unsupported media type, invalid UUID/timestamp/time zone, unsafe integers, bodies over 1 MiB, cross-tenant references, duplicate routes, and disconnected legs. Collections use `{items,nextCursor}` with stable opaque cursors.

Published semantic errors are exhaustive:

```text
400 INVALID_REQUEST
400 MALFORMED_JSON
400 INVALID_ROUTE_PLAN
400 INVALID_SCAN
404 SHIPMENT_NOT_FOUND
409 IDEMPOTENCY_CONFLICT
409 TRACKING_CODE_CONFLICT
409 SCAN_EVENT_CONFLICT
409 ROUTE_REVISION_CONFLICT
409 LOSS_FENCE_ACTIVE
409 TERMINAL_STATE
409 ILLEGAL_TRANSITION
```

Durable Work is `{workId,kind:JOURNEY_PROJECT|LOSS_RECONCILE,aggregateId,state:PENDING|LEASED|SUCCEEDED|FAILED|CANCELLED,terminal,attempt,leaseOwner,leaseExpiresAt}`. Required event types are `shipment.created`, `scan.accepted`, `shipment.projected`, `shipment.lost`, `shipment.found`, `shipment.reassigned`, `shipment.delivered`, and `shipment.cancelled`. Outbox delivery is at least once with stable canonical body, contiguous aggregate sequence, and `X-RouteWeave-Event-Id`.

## Seed and verification snapshot

Exact seed shape:

```json
{"schemaVersion":1,"seedVersion":"...","importedAt":"...","tenants":[],"hubs":[],"carriers":[],"shipments":[],"routePlans":[],"transportLegs":[],"scanEvents":[],"journeyProjections":[],"lossCases":[],"reassignments":[]}
```

Import validates the entire graph and writes all-or-nothing. Exact version/content replay is a no-op; different content under the same version fails `SEED_VERSION_CONFLICT`. It rejects unknown members, dangling/cross-tenant references, disconnected legs, non-contiguous revisions/ordinals, duplicate tracking/scanner IDs, impossible projections, and inconsistent loss/reassignment state.

`GET /api/v1/verification-snapshot` requires `Authorization: Bearer $ADMIN_TOKEN` and returns one point-in-time `{schemaVersion:1,asOf,resources,work,events}`. V1 resources are exactly `tenants`, `hubs`, `carriers`, `shipments`, `routePlans`, `transportLegs`, `scanEvents`, `journeyProjections`, `lossCases`, and `reassignments`, complete and sorted by public identity. No secret or private path appears.

## Production UI

The React UI uses only production HTTP APIs. It provides tenant selection, shipment creation, route/leg visualization, scanner event entry, an evidence timeline distinct from the derived journey, loss/found/reassign controls, projection/work/event status, and rebuild comparison. It visibly handles loading, empty, validation, conflict, stale revision, loss fence, terminal, and retry states.

## Project-owned verification

- Unit: route validation, total evidence ordering, deterministic projection, state machines, canonicalization.
- Integration: real PostgreSQL and HTTP for seed, shipment, scans, loss/found/reassign, events, snapshots.
- Browser E2E: production build and real Chromium using real APIs.
- Concurrency: two APIs and four workers ingest duplicate/out-of-order scans and race loss/reassignment.
- Recovery: observable `worker.claimed` and `dispatcher.response-received` barriers, `SIGKILL`, lease recovery.
- Performance: sustained external load followed by full journey replay and invariants.
- `test:all`: all non-performance gates.

## Fixed performance contract

Formal scoring uses Linux arm64, 4 vCPU, 8 GiB RAM, PostgreSQL 16, Node 22, production build, two APIs, and four workers. Each scenario executes its complete published operation count; recovery deadlines are 60 seconds.

1. `shipment-plan-ingest`: 100 hubs, 20 carriers, 4-leg shipments, 64 clients, 50,000 creations; >= 300 shipment/s, p95 <= 400ms, unexpected 5xx=0, all plans connected and identities unique.
2. `out-of-order-scan-storm`: 20,000 shipments receive 200,000 shuffled scans with 20% exact duplicates through two APIs; >= 600 mutation/s, p95 <= 500ms, no scan conflict for exact replay, and independent full replay equals every stored projection.
3. `loss-reroute-recovery`: 10,000 in-flight shipments receive concurrent loss/found/reassign operations; kill two workers at `worker.claimed`, start four replacements, and drain eligible work within 60 seconds. Exactly one valid current route and LossCase outcome remains per shipment; stale old-plan evidence never crosses the fence.

After load, recompute plan connectivity, evidence uniqueness, projection equality, leg monotonicity, terminal uniqueness, loss/reassignment fences, Event ordering, Work terminality, and tenant isolation. Emit p50/p95/p99, throughput, status counts, RSS, recovery duration, and invariant results. Passing latency without correctness fails.

## Out of scope

Physical routing optimization, maps/geocoding, label purchase, customs documents, driver dispatch, warehouse inventory, payments, live carrier networks, predictive ETA/ML, address storage, and cross-tenant shipment transfer.

## Handoff

Deliver source, migrations, OpenAPI, production UI, every command, and a findings-first final review. Report exact command results, metrics, unresolved findings, residual risks, and checks not run.

## Successful response contracts

Successful response contracts are closed:

- A mutation route without a literally stated success status returns 200.
- Unless a route literally publishes another object, array, or empty body, a success described by a named resource, named resource state, or named resource fields returns that exact resource shape at the JSON top level. Any response-only fields literally named by the route are additional top-level fields.
- If a mutation publishes no success body, it returns the exact current shape of the single primary resource created or changed by that route at the JSON top level.
- When a route explicitly returns multiple named resources, the body is one object keyed by their lower-camel resource names unless the route publishes another literal shape.
- Wrappers such as `{data:...}`, `{result:...}`, or an extra single-resource envelope are invalid unless the route literally declares them. OpenAPI must publish the same success status and closed response schema as runtime.

## Additional product requirements — required in the same final system

把单件 Shipment 扩展为多件 Consignment。
公开接口为 GET/POST /api/v1/consignments、GET /api/v1/consignments/:consignmentId、POST /api/v1/consignments/:consignmentId/reassign、POST /api/v1/consignments/:consignmentId/cancel、POST /api/v1/parcel-pieces/:pieceId/scan-events、POST /api/v1/parcel-pieces/:pieceId/loss、POST /api/v1/parcel-pieces/:pieceId/found。
创建请求为 {tenantId,externalRef,pieceRefs,legs}；
共享 reassign 请求为 {reason,expectedRoutePlanRevision,legs}；
Piece scan 请求为 {tenantId,scannerEventId,type:PICKED_UP|DEPARTED|ARRIVED|DELIVERED,routePlanRevision,legId,hubId,observedAt}，loss 请求为 {reason,observedAt}，found 请求为 {observedAt}，cancel 使用空对象。
所有新 mutation 使用现有 Idempotency-Key、strict JSON、稳定 replay、tenant scope 和错误 envelope。
创建必须在同一事务创建一个 Consignment 和 1..100 个稳定 ParcelPiece，冻结共享 RoutePlan revision，且外部 pieceRef 在 Consignment 内唯一。
Consignment = {consignmentId,tenantId,externalRef,routePlanId,routePlanRevision:int,state:PLANNED|IN_TRANSIT|PARTIALLY_DELIVERED|DELIVERED|EXCEPTION,createdAt,updatedAt,sequence:int}；
ParcelPiece = {pieceId,consignmentId,pieceRef,legacyShipmentId:null|uuid,state:PLANNED|IN_TRANSIT|DELIVERED|LOST|CANCELLED,createdAt,terminalAt:null|timestamp}；
PieceProjection = {pieceId,routePlanRevision:int,currentLegOrdinal:int|null,currentHubId:null|uuid,state:PLANNED|IN_TRANSIT|DELIVERED|LOST|CANCELLED,lastObservedAt:null|timestamp,sequence:int}。
成功创建返回 {consignment:Consignment,pieces:ParcelPiece[]}；
查询返回 Consignment、按 pieceRef 排序的 pieces 和 projections。
每条 ScanEvent 必须明确属于一个 ParcelPiece；
每件独立投影当前位置、当前 leg、丢失状态与终态；
Consignment 聚合状态由所有 piece 的可重算状态决定，不能被最后到达的事件直接覆盖。
丢件与重派只影响目标 piece；
共享改线必须以新 RoutePlan revision 原子应用于全部尚未终态的 piece，任何非法成员导致整批失败。
并发 scan、loss、reassign 和旧 Worker lease 必须保持 (pieceId, scannerEventId) 唯一，不能重复推进或越过 fence。
新增 Consignment、ParcelPiece、PieceProjection snapshot resource 和 CONSIGNMENT_PROJECT Work；
该 Work 的 aggregateId 必须是 consignmentId。
新增稳定 409 错误 PIECE_REF_CONFLICT、PIECE_TERMINAL、CONSIGNMENT_TERMINAL、EXPECTED_ROUTE_PLAN_REVISION_MISMATCH；
任何失败不得留下部分 piece、route revision、Work 或 Event。


更新 OpenAPI、真实多件轨迹 UI、Integration、Chromium E2E、多进程乱序并发和 barrier/SIGKILL recovery。


