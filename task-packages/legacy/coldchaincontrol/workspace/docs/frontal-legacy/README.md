# ColdChainControl

Build a production-shaped global cold-chain control plane from this intentionally blank repository. The system configures edge sensors, tracks temperature-controlled shipments, accepts signed and out-of-order telemetry, projects shipment state, detects excursions, and delivers operational notifications. PostgreSQL is the durable authority; API, worker, and dispatcher are separate processes; the browser UI is a real production build.

## Required stack and commands

- Node.js 22, TypeScript, React, PostgreSQL 16, and a browser-routable production build.
- `npm run build`
- `npm run db:migrate`
- `npm run db:seed -- --file <seed.json>`
- `npm run start:api`, `npm run start:worker`, `npm run start:dispatcher`
- `npm run test:unit`, `test:integration`, `test:e2e`, `test:concurrency`, `test:recovery`, `test:perf`, and `test:all`

`PORT`, `DATABASE_URL`, `ADMIN_TOKEN`, `WEBHOOK_URL`, `WORK_LEASE_SECONDS`, `TEST_BARRIER_URL`, and `TEST_BARRIER_TOKEN` are runtime configuration. The API exposes `/healthz` or `/api/health`, `/openapi.json` using OpenAPI 3.1, the API below, and a non-empty production UI at `/`.

## Global invariants

- Every resource belongs to exactly one Tenant. Cross-tenant IDs fail without disclosing whether the foreign resource exists.
- All JSON objects reject unknown fields. UUIDs are lowercase canonical UUID strings; timestamps are RFC 3339 UTC; monetary-free sensor integers are safe integers.
- Every mutation requires a non-empty `Idempotency-Key`. The first completed status and body are saved durably. An exact replay returns that response byte-for-byte across API processes and restarts; a changed request returns `409 IDEMPOTENCY_CONFLICT` without side effects.
- Malformed JSON returns `400 MALFORMED_JSON`. Errors use `{error:{code,message,details}}` and never include secrets, SQL, stack traces, private paths, or foreign-tenant identifiers.
- State, Work, Domain Event, audit, and outbox creation required by one mutation commit atomically. Aggregate Event sequence is contiguous and unique.
- Worker leases use database time and fencing tokens. A stale or killed worker cannot publish state after a newer lease, cancellation, terminal state, credential revocation, or configuration supersession.
- Dispatcher retries an unknown webhook acknowledgement using the identical event ID and body. It sends `X-ColdChain-Event-Id`.
- API, workers, and dispatchers may run in several processes. Correctness cannot rely on process-local locks, queues, caches, clocks, or replay maps.

## Seed contract

The seed document has exactly these keys:

`schemaVersion`, `seedVersion`, `importedAt`, `tenants`, `sites`, `carriers`, `deviceCredentials`, `devices`, `configRevisions`, `configAssignments`, `shipments`, `shipmentLegs`, `telemetryReadings`, `shipmentProjections`, `excursions`, `notificationPolicies`, `notificationDeliveries`, `auditEntries`.

Import is one transaction. A repeated identical `seedVersion` is a no-op; different content under that version returns non-zero and changes nothing. Unknown members, duplicate business identities, broken references, invalid state, invalid secret material, and cross-tenant references reject the whole document. Device credential secrets are accepted only by the seed/import boundary and are encrypted or one-way protected at rest; they never appear in API responses, logs, Events, audit details, or the verification snapshot.

## Domain records

- `Tenant = {tenantId,name}`.
- `Site = {siteId,tenantId,code,name,latitudeE6,longitudeE6,radiusMeters:int,timeZone}` with unique `(tenantId,code)` and a positive integer `radiusMeters`.
- `Carrier = {carrierId,tenantId,code,name,state:ACTIVE|SUSPENDED}`.
- `DeviceCredential = {deviceCredentialId,tenantId,deviceId,keyVersion:int,state:ACTIVE|REVOKED,validFrom,revokedAt}`. Only seed input additionally contains `secret`.
- `SensorDevice = {deviceId,tenantId,carrierId,serialNumber,state:ACTIVE|SUSPENDED|RETIRED,currentKeyVersion:int,currentConfigVersion:int|null,lastSequence:int,lastSeenAt}`.
- `ConfigRevision = {configRevisionId,tenantId,version:int,state:DRAFT|PUBLISHED,minTemperatureMilliC,maxTemperatureMilliC,sampleIntervalSeconds,offlineAfterSeconds,createdAt,publishedAt}`. Published revisions are immutable and versions are gapless per Tenant.
- `ConfigAssignment = {configAssignmentId,tenantId,deviceId,configRevisionId,state:PENDING|DELIVERED|CONFIRMED|EXPIRED,expiresAt,confirmedAt,createdAt}`. One nonterminal assignment exists per Device.
- `ColdShipment = {shipmentId,tenantId,externalRef,productLotCode,carrierId,originSiteId,destinationSiteId,deviceId,state:DRAFT|ACTIVE|DELIVERED|CANCELLED,minimumTemperatureMilliC,maximumTemperatureMilliC,expectedStartAt,expectedEndAt,activatedAt,terminalAt}`.
- `ShipmentLeg = {shipmentLegId,shipmentId,ordinal:int,fromSiteId,toSiteId,plannedDepartureAt,plannedArrivalAt}`. Ordinals start at zero, are gapless, and adjacent sites connect.
- `TelemetryReading = {telemetryReadingId,tenantId,deviceId,readingId,sequence:int,observedAt,receivedAt,latitudeE6,longitudeE6,temperatureMilliC,configVersion:int,keyVersion:int,signature}`.
- `ShipmentProjection = {shipmentId,tenantId,lastSequence:int,lastObservedAt,lastLatitudeE6,lastLongitudeE6,lastTemperatureMilliC,currentSiteId,currentLegOrdinal,state:IN_TRANSIT|AT_SITE|DELIVERED|CANCELLED,updatedAt}`.
- `Excursion = {excursionId,tenantId,shipmentId,kind:TEMPERATURE|OFFLINE,state:OPEN|ACKNOWLEDGED|RESOLVED,openedAt,acknowledgedAt,resolvedAt,firstSequence:int,lastSequence:int,minimumObservedMilliC,maximumObservedMilliC}`.
- `NotificationPolicy = {notificationPolicyId,tenantId,eventKinds:[string],destination,rateLimitPerMinute:int,state:ACTIVE|DISABLED}`.
- `NotificationDelivery = {notificationDeliveryId,tenantId,notificationPolicyId,eventId,state:PENDING|DELIVERED|DEAD_LETTER,attempts:int,nextAttemptAt,deliveredAt}`.
- `AuditEntry = {auditEntryId,tenantId,actorType:USER|DEVICE|SYSTEM,actorRef,action,resourceType,resourceId,occurredAt,details}`.

## Configuration and edge synchronization

- `POST /api/v1/tenants`, `/api/v1/sites`, `/api/v1/carriers`, and `/api/v1/devices` create the corresponding resources.
- `POST /api/v1/config-revisions` creates the next DRAFT version. `POST /api/v1/config-revisions/:configRevisionId/publish` atomically publishes it; a stale expected version returns `409 CONFIG_VERSION_CONFLICT`.
- `POST /api/v1/devices/:deviceId/config-assignments` with `{configRevisionId,expiresAt}` creates `CONFIG_DELIVER` Work. Assignment delivery and expiry are fenced.
- `GET /api/v1/devices/:deviceId/config` authenticates the Device and returns its newest unexpired assignment. `POST /api/v1/devices/:deviceId/config-acknowledgements` with `{configAssignmentId,configVersion,appliedAt}` confirms exactly that assignment. An older acknowledgement cannot lower `currentConfigVersion`.
- Device-authenticated config calls carry `X-Device-Id`, `X-Device-Key-Version`, `X-Device-Timestamp`, and lowercase hex `X-Device-Signature`. The signature is HMAC-SHA256 over `METHOD|path|timestamp|keyVersion`; timestamps outside a 60-second database-time window and a Device ID different from the path are rejected.

## Device credentials and signed telemetry

- `POST /api/v1/devices/:deviceId/credentials/rotate` with `{expectedKeyVersion,secret,validFrom}` creates the next key version and immediately makes it current. `POST /api/v1/devices/:deviceId/credentials/:keyVersion/revoke` with `{reason}` revokes that key. Rotation and revocation serialize with ingest.
- `POST /api/v1/telemetry-readings` accepts a Device-authenticated reading. `signature` is lowercase hex HMAC-SHA256 over the UTF-8 line `deviceId|readingId|sequence|observedAt|latitudeE6|longitudeE6|temperatureMilliC|configVersion|keyVersion`, using that key version's seed/rotation secret.
- `(tenantId,deviceId,readingId)` and `(tenantId,deviceId,sequence)` are unique. Exact replay is one reading. A reused identity with changed canonical fields returns `409 TELEMETRY_CONFLICT`.
- Invalid, revoked, not-yet-valid, foreign, or superseded key use returns `401 INVALID_DEVICE_SIGNATURE` without creating reading, Work, Event, audit, or idempotency success.
- Signed readings may arrive out of sequence. They are retained exactly once, and `TELEMETRY_PROJECT` Work deterministically rebuilds the projection in ascending `(sequence,readingId)` order. A late lower sequence never moves `lastSequence` backward and can still correct the excursion history.

## Shipment lifecycle and excursions

- `POST /api/v1/shipments` creates a DRAFT shipment with 1..32 connected legs and `minimumTemperatureMilliC < maximumTemperatureMilliC`.
- `POST /api/v1/shipments/:shipmentId/activate` freezes route, Device, Carrier, bounds, and the Device's current published configuration. A suspended Carrier, inactive Device, route gap, reused active Device, or config mismatch rejects atomically.
- `POST /api/v1/shipments/:shipmentId/cancel` is terminal and fences pending projection and notification work. `GET /api/v1/shipments/:shipmentId` and `/timeline` expose the aggregate and ordered public history.
- `POST /api/v1/shipments/:shipmentId/deliver` succeeds only when the projection reaches the destination with no unresolved TEMPERATURE excursion.
- Projection maps coordinates to a Site only within its stored integer radius and advances legs monotonically. A later observed reading cannot regress the route; a late earlier reading may amend history but not current ownership.
- Three consecutive projected readings outside the frozen range open one TEMPERATURE Excursion at the first violating sequence. Further violations extend it. Three consecutive in-range readings resolve it. `POST /api/v1/excursions/:excursionId/acknowledge` records acknowledgement but does not resolve it.
- If no accepted reading is observed for the frozen `offlineAfterSeconds`, `DEVICE_OFFLINE_CHECK` Work opens one OFFLINE Excursion. A newer reading resolves it. Database time and lease fencing are authoritative.

## Notifications, UI, and verification

- `POST /api/v1/notification-policies` creates a strict destination policy. `GET /api/v1/excursions` supports tenant, shipment, kind, state, and stable cursor pagination.
- Excursion opened/resolved and shipment terminal Events enqueue one NotificationDelivery per matching policy. Tenant-wide rate limiting is durable and shared by dispatcher processes. Retry preserves payload identity; terminal cancellation suppresses only deliveries whose public event is no longer applicable.
- The production UI supports tenant selection, shipment creation/activation, live route and temperature timeline, Device/config state, open excursions and acknowledgement, notification delivery status, and audit search. It visibly handles empty, loading, validation, conflict, stale, offline, and retry states.
- `GET /api/v1/verification-snapshot` requires `Authorization: Bearer $ADMIN_TOKEN` and returns `{schemaVersion:1,asOf,resources,work,events}`. `resources` contains all seed resource arrays sorted by their stable IDs. Secrets and raw authorization/signature material are redacted. Work includes stable identity, kind, aggregate, lease/fence, attempt, schedule, and terminal state. Events include stable ID, aggregate sequence, kind, canonical payload, and outbox state.

## Required errors

In addition to global errors: `INVALID_REQUEST`, `NOT_FOUND`, `TENANT_SCOPE_MISMATCH`, `STATE_CONFLICT`, `CONFIG_VERSION_CONFLICT`, `CONFIG_ASSIGNMENT_STALE`, `DEVICE_TERMINAL`, `DEVICE_CREDENTIAL_CONFLICT`, `INVALID_DEVICE_SIGNATURE`, `TELEMETRY_CONFLICT`, `SHIPMENT_ROUTE_INVALID`, `SHIPMENT_DEVICE_BUSY`, `SHIPMENT_TERMINAL`, `EXCURSION_TERMINAL`, and `RATE_LIMITED`.

## Project-owned verification and performance

Tests must use real PostgreSQL and the production browser bundle. Concurrency tests start at least two API processes; recovery tests use barrier hooks and `SIGKILL`; dispatcher tests prove unknown-ack replay; all tests assert post-run invariants rather than throughput alone.

V1 `test:perf` runs four fresh-database scenarios, each with 10 seconds warm-up and 60 seconds measurement at full scale:

1. `signed-telemetry-ingest`: 64 clients, at least 1,500 accepted signed readings/s, p95 <= 120 ms, with exact reading, Work, Event, and audit cardinality.
2. `hot-device-ordering`: 64 clients send 50,000 shuffled readings with 20% exact duplicates through two APIs; at least 900 requests/s, p95 <= 180 ms, one identity each and deterministic final projection.
3. `configuration-rollout-recovery`: 20,000 Devices, four workers, kill two after claim; all assignments confirm or expire within 60 seconds, no stale downgrade, p95 queue age <= 2 seconds.
4. `excursion-notification-recovery`: 5,000 shipments cross temperature bounds while two dispatchers lose acknowledgements; converge within 60 seconds with one Excursion and one stable logical delivery per policy/event.

## Successful response contracts

Successful response contracts are closed:

- A mutation route without a literally stated success status returns 200.
- Unless a route literally publishes another object, array, or empty body, a success described by a named resource, named resource state, or named resource fields returns that exact resource shape at the JSON top level. Any response-only fields literally named by the route are additional top-level fields.
- If a mutation publishes no success body, it returns the exact current shape of the single primary resource created or changed by that route at the JSON top level.
- When a route explicitly returns multiple named resources, the body is one object keyed by their lower-camel resource names unless the route publishes another literal shape.
- Wrappers such as `{data:...}`, `{result:...}`, or an extra single-resource envelope are invalid unless the route literally declares them. OpenAPI must publish the same success status and closed response schema as runtime.
