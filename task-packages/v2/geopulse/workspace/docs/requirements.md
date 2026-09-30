# GeoPulse — Complete system requirements

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

# GeoPulse

Build GeoPulse from this intentionally blank repository. This README is the complete public product
contract. Ask before making a product choice that the contract does not settle.

## Required stack and commands

- Node.js 22, TypeScript, React, PostgreSQL 16, npm, and the preinstalled Chromium.
- PostgreSQL is the sole authority for location ordering, memberships, transitions, idempotency, leases,
  and Domain Events. In-memory spatial indexes are disposable caches only.
- The production UI uses the public HTTP API; browser state is never authoritative.

Required non-interactive commands:

```text
npm run db:migrate
npm run db:seed -- --file <path>
npm run dev
npm run build
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

Every command exits non-zero on failure and cleans up child processes.

## Domain and invariants

GeoPulse is tenant-scoped. A Device submits immutable LocationEvents. Workers evaluate the events against
the RegionVersions active at each event's `observedAt`, update Membership, and append immutable Transitions.

Canonical objects are:

```text
Tenant, Device, Region, RegionVersion, LocationEvent, Membership,
Transition, EvaluationCursor, OutboxEvent, Work
```

`uuid` is lowercase RFC 4122 text, `timestamp` is UTC ISO-8601 with millisecond precision and `Z`, `int`
is a JSON safe integer, and coordinates are decimal numbers with at most six fractional digits. Latitude is
in `[-90,90]`; longitude is in `[-180,180]`. Polygon rings are closed, non-self-intersecting, use
`[longitude,latitude]`, contain 4..10,001 points including the repeated endpoint, and never cross the
antimeridian. A point on an exact polygon edge is `BOUNDARY`, not implicitly inside.

```text
LocationEvent = {eventId:uuid,tenantId:uuid,deviceId:uuid,deviceSequence:int,observedAt:timestamp,receivedAt:timestamp,longitude:number,latitude:number,accuracyMeters:int}
RegionVersion = {regionVersionId:uuid,regionId:uuid,tenantId:uuid,revision:int,effectiveFrom:timestamp,effectiveTo:timestamp|null,polygon:[[number,number]],boundaryToleranceMeters:int,dwellSeconds:int,createdAt:timestamp}
Membership = {tenantId:uuid,deviceId:uuid,regionId:uuid,regionVersionId:uuid,state:OUTSIDE|INSIDE|BOUNDARY,enteredAt:timestamp|null,lastObservedAt:timestamp,lastDeviceSequence:int,watermark:timestamp,revision:int}
Transition = {transitionId:uuid,tenantId:uuid,deviceId:uuid,regionId:uuid,regionVersionId:uuid,type:ENTER|EXIT|DWELL,observedAt:timestamp,sourceEventId:uuid,sequence:int}
```

The following invariants are mandatory:

1. `(tenantId, deviceId, deviceSequence)` and `eventId` each identify one canonical LocationEvent.
2. Replaying the same identity and canonical body returns the original result; a different body is a conflict.
3. A Region revision and polygon are immutable after creation; revisions do not overlap in effective time.
4. At most one Membership exists for a tenant/device/region, and its revision increases monotonically.
5. For a device/region, Transition sequence is contiguous and no source event produces the same type twice.
6. A LocationEvent is evaluated against the RegionVersion active at `observedAt`, not arrival time.
7. Late events within the 10-minute reorder window are inserted by `(observedAt,deviceSequence,eventId)` and
   deterministically replay subsequent membership. Older events are stored with `LATE_IGNORED` and cannot
   rewrite published Transitions.
8. Boundary tolerance provides hysteresis: an inside device exits only beyond the outside tolerance, and an
   outside device enters only beyond the inside tolerance. `BOUNDARY` alone emits no transition.
9. DWELL is emitted once per continuous inside interval after `dwellSeconds`; exit resets the interval.
10. A business mutation, Work, and Domain Event commit in one PostgreSQL transaction.

## Required behavior and HTTP surface

```text
POST /api/v1/tenants
POST /api/v1/devices
POST /api/v1/regions
POST /api/v1/regions/:regionId/versions
GET  /api/v1/regions/:regionId
POST /api/v1/location-events
POST /api/v1/location-events/batch
GET  /api/v1/devices/:deviceId/memberships
GET  /api/v1/devices/:deviceId/transitions
POST /api/v1/regions/query
GET  /api/v1/verification-snapshot
GET  /openapi.json
GET  /healthz
```

Every mutation requires `Idempotency-Key`, scoped by tenant, method, and canonical path. Batch ingest accepts
1..10,000 events and is atomic: one invalid or conflicting event rejects the entire batch without Work,
Transition, Membership, or Event changes. Collection responses are `{items,nextCursor}` with an opaque stable
cursor. Unknown JSON fields and unsupported media types are rejected.

`POST /api/v1/regions/query` accepts `{tenantId,points:[{queryId:string,longitude:number,latitude:number,at:timestamp}]}`
with 1..10,000 points and returns input-order results containing all active `regionId` and `regionVersionId`
matches. It is a point-in-time read and must never mix revisions within one response.

Stable semantic errors are:

```text
400 INVALID_GEOMETRY
400 INVALID_REQUEST
409 DEVICE_SEQUENCE_CONFLICT
409 EVENT_ID_CONFLICT
409 REGION_REVISION_OVERLAP
409 IDEMPOTENCY_CONFLICT
413 BATCH_TOO_LARGE
```

Durable Work has exact shape
`{workId:uuid,kind:LOCATION_EVALUATION|LATE_REPLAY,aggregateId:uuid,state:PENDING|LEASED|SUCCEEDED|FAILED|CANCELLED,terminal:boolean,attempt:int,leaseOwner:string|null,leaseExpiresAt:timestamp|null}`.
Workers use bounded leases and fence final commits. Event types are `location.accepted`, `membership.entered`,
`membership.exited`, `membership.dwelled`, and `location.late_ignored`. Events are contiguous per aggregate,
dispatched at least once with stable identity and canonical body, and contain no raw location beyond the
published event reference and region identity.

## UI

The production React UI must let an operator create and version Regions, register Devices, ingest one event,
inspect Membership and Transition history, run a batch point query, and see pending/terminal Work. It must
show timestamps, version identities, late status, and validation errors from the real API. Production
Chromium tests must use the built UI and real PostgreSQL.

## Seed and verification snapshot

The seed is exactly:

```json
{"schemaVersion":1,"seedVersion":"...","importedAt":"...","tenants":[],"devices":[],"regions":[],"regionVersions":[],"locationEvents":[],"memberships":[],"transitions":[]}
```

Import is atomic. The same version and digest is a no-op; the same version with a different digest returns
`SEED_VERSION_CONFLICT`. V1 snapshot `resources` contains exactly `tenants`, `devices`, `regions`,
`regionVersions`, `locationEvents`, `memberships`, and `transitions`, each complete and sorted by published
identity. It also exposes Work and Domain Events but never credentials, raw authorization, private paths, or
unredacted historical coordinates inside events.

## Performance contract

Formal runs use 4 logical CPUs, 8 GiB RAM, PostgreSQL 16, two API processes, four Workers, one Dispatcher,
and a warmed production build. Smoke scaling is non-scoring.

1. `ordered-location-ingest`: 500,000 events across 100,000 devices, 64 clients for 60 seconds; throughput
   >= 500 events/s, p95 <= 250 ms, unexpected 5xx = 0, with exact device sequence uniqueness.
2. `boundary-jitter-convergence`: 100,000 observations for 2,000 devices oscillating around 100 Region edges,
   64 clients for 60 seconds; throughput >= 300 events/s, p95 <= 350 ms, and no spurious transition pair.
3. `bulk-spatial-query`: 10,000 Regions and 1,000,000 query points in batches of 1,000 for 60 seconds;
   throughput >= 20,000 points/s, p95 batch latency <= 700 ms, stable input order, and no mixed revisions.

After load, recompute event uniqueness, membership revision monotonicity, transition contiguity, hysteresis,
Work drainage, Event order, tenant isolation, RSS, and database growth.

## Out of scope

Road routing, address geocoding, altitude, antimeridian polygons, map-tile hosting, continuous GPS tracking,
real mobile SDKs, arbitrary GIS SQL supplied by users, and cross-tenant analytics.

## Successful response contracts

Successful response contracts are closed:

- A mutation route without a literally stated success status returns 200.
- Unless a route literally publishes another object, array, or empty body, a success described by a named resource, named resource state, or named resource fields returns that exact resource shape at the JSON top level. Any response-only fields literally named by the route are additional top-level fields.
- If a mutation publishes no success body, it returns the exact current shape of the single primary resource created or changed by that route at the JSON top level.
- When a route explicitly returns multiple named resources, the body is one object keyed by their lower-camel resource names unless the route publishes another literal shape.
- Wrappers such as `{data:...}`, `{result:...}`, or an extra single-resource envelope are invalid unless the route literally declares them. OpenAPI must publish the same success status and closed response schema as runtime.

## Additional product requirements — required in the same final system

新增 RegionBundle 原子发布。
RegionBundle={bundleId,tenantId,name,currentRevision,currentBundleRevisionId,createdAt}。
RegionBundleRevision={bundleRevisionId,bundleId,tenantId,revision,regionVersionIds,effectiveFrom,createdAt}。
regionVersionIds 必须来自同一租户、去重并按 UUID 升序保存，数量为 1..10,000。
Revision 不可变；
RegionBundle.currentBundleRevisionId 是唯一 active revision。
新增 HTTP 合同：POST /api/v1/region-bundles，request {tenantId,name}，response {bundle:RegionBundle}；
POST /api/v1/region-bundles/:bundleId/publish，request {expectedRevision,effectiveFrom,regionVersionIds}，response {bundle:RegionBundle,revision:RegionBundleRevision}；
POST /api/v1/region-bundles/:bundleId/rollback，request {expectedRevision,targetRevision,effectiveFrom}，response {bundle:RegionBundle,revision:RegionBundleRevision}；
GET /api/v1/region-bundles/:bundleId，response {bundle:RegionBundle,revisions:[RegionBundleRevision,...]}。
所有 mutation 仍要求 Idempotency-Key，未知字段仍须拒绝。
publish 使用 expectedRevision CAS 创建新 revision。
rollback 也创建新 revision，并复制 targetRevision 的成员集合，绝不能改写旧 revision。
CAS 失败返回 409 BUNDLE_REVISION_CONFLICT；
跨租户、空成员、未知 RegionVersion 或重叠有效时间返回稳定 400/409 语义错误且无部分副作用。
LocationEvent 接受时冻结唯一 bundleRevisionId，之后的 Worker、迟到重放和 Transition 都必须沿用该 revision。
Membership 公开 bundleRevisionId。
POST /api/v1/regions/query 的响应扩展为 {bundleRevisionId,items:[{queryId,matches:[{regionId,regionVersionId}]}]}；
items 保持输入顺序，单个响应不得混用 revision。
所有 API 必须在 publication/rollback 可观察后失效旧缓存。
新增 BUNDLE_REEVALUATION Work 与 region_bundle.published、region_bundle.rolled_back Events。

UI 增加 composition、publish、rollback 和 revision-consistent query。

