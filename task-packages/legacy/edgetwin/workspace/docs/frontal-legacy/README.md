# EdgeTwin

Build a production-style, tenant-isolated device control platform from this intentionally blank repository. Use TypeScript on Node.js 22, PostgreSQL 16, a React production UI, independent command workers, and an outbox dispatcher. PostgreSQL, immutable receipts, and monotonic device versions are authoritative; in-memory queues, SQLite, mocks, and placeholder tests are not acceptable.

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

All commands are non-interactive and fail with nonzero status. `start:api` serves API, OpenAPI, health, device-poll endpoints, and the production UI. Worker and dispatcher are separate long-running roles. Graceful `SIGTERM` must stop every role.

## Environment

| Variable | Contract |
| --- | --- |
| `DATABASE_URL` | Required PostgreSQL authority |
| `PORT` | API port, default `3000` |
| `ADMIN_TOKEN` | Verification snapshot Bearer token only |
| `WEBHOOK_URL` | Domain-event dispatcher target |
| `WORK_LEASE_SECONDS` | Worker lease, default `3`, range 1..300 |
| `DEVICE_POLL_LIMIT` | Max commands per poll, default `100`, range 1..1000 |
| `TEST_BARRIER_URL`, `TEST_BARRIER_TOKEN` | Optional controlled crash barrier |

Do not return or log device credentials, firmware signing material, private broker addresses, authorization headers, `DATABASE_URL`, admin tokens, private paths, or another tenant's state.

## Domain model

- `Tenant {tenantId,name}`.
- `Device {deviceId,tenantId,externalRef,state:ONLINE|OFFLINE|RETIRED,lastSeenAt,createdAt}`.
- `DeviceShadow {deviceId,desiredVersion,desired,reportedVersion,reported,updatedAt}`. Desired and reported JSON are objects no larger than 64 KiB each.
- `DeviceCommand {commandId,tenantId,deviceId,kind,payload,desiredVersion,deliveryIdentity,state:QUEUED|DELIVERED|ACKNOWLEDGED|FAILED|EXPIRED|CANCELLED,expiresAt,createdAt}`.
- `CommandReceipt {receiptId,tenantId,deviceId,commandId,deviceSequence,outcome:ACKNOWLEDGED|FAILED,reportedPatch,observedAt,receivedAt}` is immutable.
- `FirmwareRelease {firmwareReleaseId,tenantId,version,digest,sizeBytes,state:READY|REVOKED,createdAt}`.
- `UpgradeCampaign {upgradeCampaignId,tenantId,firmwareReleaseId,state:QUEUED|RUNNING|PAUSED|COMPLETED|CANCELLED,createdAt}` freezes members.
- `UpgradeTarget {upgradeCampaignId,deviceId,priorFirmwareDigest,state:PENDING|COMMAND_CREATED|SUCCEEDED|FAILED|EXPIRED|CANCELLED,commandId}`.

## Invariants and lifecycle

1. Desired and reported versions are independent, integer, and strictly monotonic. A patch requires the exact expected version; replay returns the original result, while stale or skipped version returns `SHADOW_VERSION_CONFLICT`.
2. JSON Merge Patch semantics apply to shadow patches. Keys beginning with `$`, prototype-related keys, arrays over 1000 entries, depth over 32, non-finite numbers, and results over 64 KiB are rejected atomically.
3. A command freezes payload, desired version, expiry, and `deliveryIdentity`. Offline devices retain QUEUED commands durably. Polling delivers eligible commands ordered by `(createdAt,commandId)` without changing identity.
4. Expiry uses database time. Once expiry commits, no poll or stale Worker lease may deliver the command. A receipt for EXPIRED/CANCELLED remains visible evidence but cannot change terminal state.
5. `(tenantId,deviceId,deviceSequence)` and `receiptId` each identify one canonical receipt. Exact duplicates replay; different content conflicts. Receipt arrival order never moves reportedVersion backward or overwrites a newer terminal command state.
6. ACKNOWLEDGED requires matching command and delivery identity. It may apply `reportedPatch` only when its device-reported base version is current; otherwise the receipt is retained with `projectionStatus=STALE`.
7. UpgradeCampaign freezes a deduplicated device set and target FirmwareRelease. Each `(campaignId,deviceId)` owns at most one UpgradeTarget and one stable upgrade command. Success requires an ACK whose reported firmware digest equals the release digest.
8. pause prevents creation/delivery of new upgrade commands; resume continues pending targets; cancel fences pending and undelivered commands but does not pretend an already acknowledged device rolled back.
9. Command/campaign mutation, Work, and Domain Event commit together. Lease recovery may repeat computation but cannot create another logical command, target, or receipt effect.
10. Every API, cursor, snapshot, event, work item, and UI view is tenant-isolated.

## HTTP and OpenAPI

Serve OpenAPI 3.1 at `GET /openapi.json`, health at `GET /healthz`, and:

```text
GET/POST /api/v1/tenants
GET/POST /api/v1/devices
GET      /api/v1/devices/:deviceId/shadow
PATCH    /api/v1/devices/:deviceId/shadow/desired
POST     /api/v1/device-commands
GET      /api/v1/device-commands/:commandId
POST     /api/v1/device-commands/:commandId/cancel
POST     /api/v1/devices/:deviceId/connect
POST     /api/v1/devices/:deviceId/disconnect
POST     /api/v1/devices/:deviceId/poll
POST     /api/v1/command-receipts
GET/POST /api/v1/firmware-releases
GET/POST /api/v1/upgrade-campaigns
POST     /api/v1/upgrade-campaigns/:upgradeCampaignId/pause
POST     /api/v1/upgrade-campaigns/:upgradeCampaignId/resume
POST     /api/v1/upgrade-campaigns/:upgradeCampaignId/cancel
GET      /api/v1/verification-snapshot
```

Command creation accepts `{tenantId,deviceId,kind,payload,desiredVersion,expiresAt}`. Device poll requires `{tenantId,connectionId,limit}` and returns frozen command envelopes. Receipt accepts `{tenantId,deviceId,commandId,deliveryIdentity,receiptId,deviceSequence,outcome,reportedBaseVersion,reportedPatch,observedAt}`. Campaign creation accepts `{tenantId,firmwareReleaseId,deviceIds}` and freezes unique active devices.

All mutations require `Idempotency-Key` (1..128 visible ASCII). Same canonical request returns the original status/JSON after response loss, concurrency, and restart; changed content returns `409 IDEMPOTENCY_CONFLICT`. Strict JSON rejects malformed JSON, duplicate/unknown fields, wrong media type, invalid UUID/RFC3339/digest, unsafe numbers, bodies over 1 MiB, cross-tenant references, and unbounded nested values. Collections use `{items,nextCursor}` with stable opaque cursors.

Published semantic errors are exhaustive:

```text
400 INVALID_REQUEST
400 MALFORMED_JSON
400 INVALID_SHADOW_PATCH
400 INVALID_EXPIRY
404 DEVICE_NOT_FOUND
409 IDEMPOTENCY_CONFLICT
409 SHADOW_VERSION_CONFLICT
409 RECEIPT_CONFLICT
409 DELIVERY_IDENTITY_CONFLICT
409 COMMAND_EXPIRED
409 TERMINAL_STATE
409 CAMPAIGN_STATE_CONFLICT
```

Durable Work is `{workId,kind:COMMAND_DISPATCH|COMMAND_EXPIRE|UPGRADE_FANOUT|RECEIPT_PROJECT,aggregateId,state:PENDING|LEASED|SUCCEEDED|FAILED|CANCELLED,terminal,attempt,leaseOwner,leaseExpiresAt}`. Required event types are `shadow.desired_updated`, `shadow.reported_updated`, `command.created`, `command.delivered`, `command.acknowledged`, `command.failed`, `command.expired`, `upgrade.created`, `upgrade.target_terminal`, and `upgrade.terminal`. Events are contiguous by aggregate and dispatched at least once with stable canonical body and `X-EdgeTwin-Event-Id`.

## Seed and snapshot

Exact seed shape:

```json
{"schemaVersion":1,"seedVersion":"...","importedAt":"...","tenants":[],"devices":[],"deviceShadows":[],"deviceCommands":[],"commandReceipts":[],"firmwareReleases":[],"upgradeCampaigns":[],"upgradeTargets":[]}
```

Import validates the whole graph before one atomic write. Exact version/content replay is a no-op; changed content under the same version fails `SEED_VERSION_CONFLICT`. Reject unknown members, dangling/cross-tenant references, duplicate external refs/sequences, invalid monotonic versions, inconsistent terminal states, expired delivered commands, duplicate targets, and digest mismatches.

`GET /api/v1/verification-snapshot` requires `Authorization: Bearer $ADMIN_TOKEN` and returns one point-in-time `{schemaVersion:1,asOf,resources,work,events}`. V1 `resources` contains exactly `tenants`, `devices`, `deviceShadows`, `deviceCommands`, `commandReceipts`, `firmwareReleases`, `upgradeCampaigns`, and `upgradeTargets`, complete and sorted by public identity. Secrets and private endpoints are forbidden.

## Production UI

The React UI uses only production HTTP APIs. It supports tenant/device selection, online state, desired/reported shadow comparison and patching, offline command creation and expiry, poll/receipt simulation, firmware release inspection, campaign creation/pause/resume/cancel, target progress, and event/work visibility. Loading, empty, validation, stale version, conflict, expiry, terminal, and retry states are visible.

## Project-owned verification

- Unit: merge patch limits, version state machines, receipt ordering, expiry, canonicalization.
- Integration: real PostgreSQL and HTTP for shadows, offline commands, poll/receipts, campaigns, seed, events.
- Browser E2E: production build in real Chromium with real APIs.
- Concurrency: two APIs/four workers race patches, poll/expiry, receipts, campaign fan-out and cancellation.
- Recovery: observable `worker.claimed` and `dispatcher.response-received`, real `SIGKILL`, lease replacement.
- Performance: sustained load plus complete post-load invariant recomputation.
- `test:all`: all non-performance gates.

## Fixed performance contract

Formal scoring uses Linux arm64, 4 vCPU, 8 GiB RAM, PostgreSQL 16, Node 22, production build, two APIs, and four workers. Each scenario executes its complete published operation count; recovery deadlines are 60 seconds.

1. `shadow-patch-ingest`: 100,000 devices receive desired and reported patches from 64 clients; >= 500 patch/s, p95 <= 300ms, unexpected 5xx=0, every version contiguous and every stored value equals deterministic replay.
2. `offline-command-expiry`: 50,000 commands across online/offline devices with expiry around poll barriers; >= 350 mutation/s, p95 <= 450ms, no expired command delivered, every eligible command delivered at most once logically, and stable delivery identities survive two APIs.
3. `fleet-upgrade-recovery`: freeze 10,000 devices, inject shuffled duplicate receipts and kill two workers at `worker.claimed`; four replacements drain eligible work within 60 seconds, one target/command per device, no false success, correct campaign aggregate, events/work terminal.

After load, recompute shadow monotonicity, command/receipt identity, expiry fences, target uniqueness, firmware confirmation, campaign state, event ordering, Work terminality, and tenant isolation. Emit p50/p95/p99, throughput, statuses, RSS, recovery duration, and invariant outcomes. Performance without correctness fails.

## Out of scope

Real MQTT/cloud broker, device authentication protocol, firmware byte storage/signing, binary delta generation, telemetry analytics, geolocation, billing, arbitrary scripts, hardware drivers, peer-to-peer updates, and cross-tenant fleet control.

## Handoff

Deliver source, migrations, OpenAPI, production UI, all commands, and a findings-first final review. Report exact commands/results, measured metrics, unresolved findings, risks, and checks not run.

## Successful response contracts

Successful response contracts are closed:

- A mutation route without a literally stated success status returns 200.
- Unless a route literally publishes another object, array, or empty body, a success described by a named resource, named resource state, or named resource fields returns that exact resource shape at the JSON top level. Any response-only fields literally named by the route are additional top-level fields.
- If a mutation publishes no success body, it returns the exact current shape of the single primary resource created or changed by that route at the JSON top level.
- When a route explicitly returns multiple named resources, the body is one object keyed by their lower-camel resource names unless the route publishes another literal shape.
- Wrappers such as `{data:...}`, `{result:...}`, or an extra single-resource envelope are invalid unless the route literally declares them. OpenAPI must publish the same success status and closed response schema as runtime.
