# FirmwareFleet — Complete system requirements

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

# FirmwareFleet

Build FirmwareFleet from this intentionally blank repository. This README is the complete product
contract. Do not invent behavior outside it. Ask before making a product choice that the contract
does not settle.

## Required stack

- Node.js 22, TypeScript, React, PostgreSQL 16, npm, and the preinstalled Chromium.
- PostgreSQL is the sole authority for business state, idempotency, leases, events, and ordering.
- The production UI must use the public HTTP API; no mock, in-memory database, or browser-only state
  may provide correctness.
- Use integer domain quantities and UTC ISO-8601 timestamps. Do not use floating point for money,
  capacity, sequence, duration units, or conserved quantities.

## Required non-interactive commands

| Command | Contract |
| --- | --- |
| 'npm run db:migrate' | Apply all versioned migrations repeatedly and safely. |
| 'npm run db:seed -- --file <path>' | Atomically import the versioned JSON seed. |
| 'npm run dev' | Start development API and UI. |
| 'npm run build' | Produce the production API, worker, dispatcher, and UI assets. |
| 'npm run start:api' | Start one production API/UI process. |
| 'npm run start:worker' | Start one Command Task worker. |
| 'npm run start:dispatcher' | Start the Domain Event webhook dispatcher. |
| 'npm run test:unit' | Run pure logic and boundary tests. |
| 'npm run test:integration' | Run real PostgreSQL plus public HTTP integration tests. |
| 'npm run test:e2e' | Run production-build Chromium tests through visible controls. |
| 'npm run test:concurrency' | Run at least two API and two worker processes against one database. |
| 'npm run test:recovery' | Use observable barriers, SIGKILL, restart, and persistent recovery. |
| 'npm run test:all' | Run every non-performance gate above from a clean database. |
| 'npm run test:perf' | Run the fixed sustained load and verify all post-load invariants. |

Every command exits non-zero on failure, cleans up its own child processes, and requires no prompts.

## Environment

| Variable | Default | Rules |
| --- | --- | --- |
| 'DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/firmwarefleet' | Production/development authority. |
| 'TEST_DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/firmwarefleet_test' | Required by all stateful tests. |
| 'PORT' | '3000' | Integer 1-65535; API and production UI origin. |
| 'ADMIN_TOKEN' | task-local value | Required only for documented admin mutation routes; never log it. |
| 'WEBHOOK_URL' | 'http://127.0.0.1:4010/events' | HTTP endpoint for Domain Event delivery. |
| 'WORK_LEASE_SECONDS' | '3' | Integer 1-60; persisted lease duration used by workers and recovery tests. |
| 'CHROMIUM_PATH' | '/usr/bin/chromium' | Browser executable for project-owned E2E. |
| 'MANAGED_DATA_ROOT' | '/tmp/firmwarefleet-data' | Writable root for staged or generated bytes; never serve a path directly. |
| 'TEST_BARRIER_URL' | empty | Optional localhost HTTP receiver used only by controlled recovery tests. |
| 'TEST_BARRIER_TOKEN' | empty | Required barrier header value when the URL is set; never log it. |

Bind only to '127.0.0.1'. Logs must not contain tokens, idempotency keys, raw seed input, webhook
bodies, or private absolute paths.

## Domain and V1 behavior

| Term | Canonical definition | Avoid |
| --- | --- | --- |
| Device | A registered hardware unit with model, bootloader, and installed firmware version. | Agent, client |
| Firmware Image | Immutable bytes, digest, size, model compatibility, and version. | Artifact, package |
| Firmware Campaign | A captured set of Devices targeted with one Firmware Image. | Deployment, rollout |
| Device Update | One Device's durable campaign state and current command sequence. | Assignment, job |
| Command Task | Leased delivery work for download, install, verify, or rollback commands. | Message, queue |
| Device Report | A sequence-numbered idempotent observation tied to one command token. | Heartbeat, ack |

Device Update: WAITING -> DOWNLOADING -> INSTALLING -> VERIFYING -> SUCCEEDED, any active state -> FAILED -> ROLLED_BACK, or WAITING -> CANCELLED; Campaign: PENDING -> RUNNING -> SUCCEEDED | FAILED, or PENDING|RUNNING -> CANCELLED.

1. Register compatible Firmware Images and create one-wave Campaigns from an immutable Device selector.
2. Deliver download, install, and verify commands in order with stable IDs and fencing tokens.
3. Accept offline Device Reports in atomic ordered batches and replay duplicates safely.
4. Recover Command Tasks and fail or roll back updates under the exact timeout policy.
5. Expose fleet versions, device timelines, campaign progress, failures, and event deliveries in the UI.

### Deterministic policy

1. A Firmware Image applies only to the same model and an installed version listed in compatibleFromVersions. A version has 1..8 dot-separated components, each exactly 0 or [1-9][0-9]* and a JSON safe integer, with total length <=64; compare component by component with missing components as zero.
2. Firmware Image size is 1..2147483648 bytes; downloadPath matches ^/firmware/[a-z0-9][a-z0-9._/-]{0,255}$, contains no empty, dot, or dot-dot segment, and is unique. compatibleFromVersions has 1..100 distinct canonical versions, and modelId plus version is unique.
3. Campaign selector is AND over exact modelId and label equality. Target set sorts by deviceId and is captured once; maxParallel is 1..1000 and counts non-terminal active Device Updates.
4. Commands use sequence 1 DOWNLOAD, 2 INSTALL, 3 VERIFY; each expires reportTimeoutSeconds after creation. A valid contiguous Device Report batch may repeat identical prior reports but cannot skip or rewrite a sequence.
5. VERIFY SUCCEEDED must report target image digest before installedVersion changes. Timeout or explicit failure creates one ROLLBACK command using captured priorVersion metadata and frees capacity only at terminal outcome.
6. A Campaign is PENDING before any Device Update starts, RUNNING after the first starts while any update remains non-terminal, SUCCEEDED only when every target succeeds, and FAILED when no update is active and at least one is FAILED or ROLLED_BACK. Cancellation from PENDING or RUNNING atomically sets Campaign CANCELLED, changes every WAITING update to CANCELLED, preserves terminal updates, and requires each active update to finish a ROLLBACK without issuing another forward command.

## Mandatory invariants

1. A Device executes at most one active Device Update and one current command at an instant.
2. Installed firmware changes only after a valid verify report for the exact image digest and token.
3. Device Report sequence is strictly increasing; identical duplicate batches have no second effect.
4. A Campaign target set and Firmware Image never change after creation.
5. Rollback returns to the captured prior version exactly once and cannot install an unrelated image.

These invariants must hold after success, validation failure, unknown HTTP outcome, duplicate request,
concurrent request, worker or dispatcher SIGKILL, restart, migration, and sustained load.

## HTTP and OpenAPI 3.1

Serve canonical OpenAPI at 'GET /openapi.json' and health at 'GET /healthz'. The OpenAPI document and
runtime behavior must agree. API routes use JSON except explicitly documented raw content. Reject an
unsupported media type with 415 'UNSUPPORTED_MEDIA_TYPE', malformed JSON with 400 'MALFORMED_JSON',
unknown object keys with 400 'UNKNOWN_FIELD', and a shape or range violation without a more specific
published code with 400 'INVALID_REQUEST'. Semantic or state conflicts use their published 409 code. A
missing, malformed, or incorrect Bearer token on a documented ADMIN_TOKEN route returns 401
'ADMIN_AUTH_REQUIRED'.

Successful paginated collection reads return '{items,nextCursor}'. 'limit' defaults to 50 and is an
integer from 1 through 100. Cursor order is stable and opaque; malformed cursors return 400
'INVALID_CURSOR'. Fields typed 'uuid' are lowercase UUID strings; untyped string identifiers retain
their published syntax. Timestamps are UTC with a trailing 'Z'. A resource miss returns 404 'NOT_FOUND'.

Errors use exactly:

~~~json
{"error":{"code":"STABLE_CODE","message":"human-readable text","details":{}}}
~~~

Wire notation below is normative: 'uuid' is lowercase RFC 4122 text, 'int' is a JSON safe integer,
'timestamp' is UTC ISO-8601 with millisecond precision and trailing Z, 'date' is strict YYYY-MM-DD,
'sha256' is 64 lowercase hex, 'currency' is three uppercase ASCII letters, and 'json' is any value
accepted by RFC 8785. 'http-url' is an absolute http or https URL without credentials or a fragment.
'interval' is exactly '{startAt:timestamp,endAt:timestamp}', has startAt before endAt, and denotes the
half-open range '[startAt,endAt)'. A '|null' field is required and nullable. Every unlisted field is
rejected and arrays preserve their stated order. Responses use exactly these resource shapes:

Successful response contracts are closed:

- A mutation route without a literally stated success status returns 200.
- Unless a route literally publishes another object, array, or empty body, a success described by a named resource, named resource state, or named resource fields returns that exact resource shape at the JSON top level. Any response-only fields literally named by the route are additional top-level fields.
- If a mutation publishes no success body, it returns the exact current shape of the single primary resource created or changed by that route at the JSON top level.
- When a route explicitly returns multiple named resources, the body is one object keyed by their lower-camel resource names unless the route publishes another literal shape.
- Wrappers such as `{data:...}`, `{result:...}`, or an extra single-resource envelope are invalid unless the route literally declares them. OpenAPI must publish the same success status and closed response schema as runtime.

- FirmwareImage = {firmwareImageId:uuid,modelId:uuid,version:string,sha256:sha256,size:int,downloadPath:string,compatibleFromVersions:[string],createdAt:timestamp}
- FirmwareCampaign = {campaignId:uuid,firmwareImageId:uuid,targetCount:int,targetDigest:sha256,maxParallel:int,reportTimeoutSeconds:int,state:PENDING|RUNNING|SUCCEEDED|FAILED|CANCELLED,createdAt:timestamp,completedAt:timestamp|null,sequence:int}
- DeviceUpdate = {deviceUpdateId:uuid,campaignId:uuid,deviceId:uuid,priorVersion:string,targetVersion:string,state:WAITING|DOWNLOADING|INSTALLING|VERIFYING|SUCCEEDED|FAILED|ROLLED_BACK|CANCELLED,currentCommandSequence:int,installedDigest:sha256|null}
- DeviceCommand = {commandId:uuid,deviceUpdateId:uuid,sequence:int,type:DOWNLOAD|INSTALL|VERIFY|ROLLBACK,imageDigest:sha256,commandToken:string,createdAt:timestamp,expiresAt:timestamp}
- DeviceCommandPollResponse = {status:COMMAND|NO_CHANGE,command:DeviceCommand|null}; command is null exactly when status is NO_CHANGE
- DeviceReport = {deviceId:uuid,deviceUpdateId:uuid,sequence:int,commandId:uuid,commandToken:string,outcome:SUCCEEDED|FAILED,installedDigest:sha256|null,reportedAt:timestamp}

The public aggregate routes are:

- 'GET /api/v1/firmware-campaigns?limit&cursor' and
  'GET /api/v1/firmware-campaigns/:campaignId'.
- POST /api/v1/firmware-campaigns with {firmwareImageId,selector,maxParallel,reportTimeoutSeconds}; return 202 with targetCount, targetDigest, and one-wave progress.
- POST /api/v1/firmware-images with {modelId,version,sha256,size,downloadPath,compatibleFromVersions} validates the published image bounds, registers one immutable FirmwareImage, and returns 201 with its exact FirmwareImage body.
- POST /api/v1/devices/:deviceId/commands/poll with {lastCommandSequence} returns DeviceCommandPollResponse with the next stable command, or exact {status:NO_CHANGE,command:null} when no greater current command exists.
- POST /api/v1/devices/:deviceId/report-batches with {firstSequence,reports:[{sequence,commandId,commandToken,outcome,installedDigest}]} atomically accepts a contiguous batch and returns the stored DeviceReport objects with server reportedAt values.
- POST /api/v1/firmware-campaigns/:campaignId/cancel with {reason} applies the published Campaign cancellation rule and returns the exact CANCELLED FirmwareCampaign.
- GET /api/v1/devices/:deviceId/updates returns {items:[DeviceUpdate]} and GET /api/v1/firmware-campaigns/:campaignId/updates returns all target Device Updates by deviceId.
- 'GET /api/v1/domain-events?aggregateId&afterSequence&limit' returns committed events in sequence.
- 'GET /api/v1/verification-snapshot' requires 'Authorization: Bearer <ADMIN_TOKEN>' and returns one
  serializable snapshot '{asOf:timestamp,resources:{...},work:[Work],events:[DomainEvent]}'.

### V1 verification snapshot

The complete snapshot is read from one PostgreSQL point-in-time; 'asOf', every resource array, 'work',
and 'events' must describe that same database snapshot. The V1 'resources' object has exactly these keys
and no others:

- 'deviceModels' uses exact shape 'DeviceModel = {modelId:uuid,name:string}' and sorts ascending by scalar field-path tuple 'modelId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'devices' uses exact shape 'Device = {deviceId:uuid,modelId:uuid,labels:object,installedVersion:string,installedDigest:sha256,lastReportSequence:int}' and sorts ascending by scalar field-path tuple 'deviceId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'firmwareImages' uses exact shape 'FirmwareImage' and sorts ascending by scalar field-path tuple 'firmwareImageId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'firmwareCampaigns' uses exact shape 'FirmwareCampaign' and sorts ascending by scalar field-path tuple 'campaignId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'deviceUpdates' uses exact shape 'DeviceUpdate' and sorts ascending by scalar field-path tuple 'deviceUpdateId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'deviceCommands' uses exact shape 'DeviceCommand' and sorts ascending by scalar field-path tuple 'deviceUpdateId', 'sequence', then by RFC 8785 canonical JSON as the tie-breaker.
- 'deviceReports' uses exact shape 'DeviceReport' and sorts ascending by scalar field-path tuple 'deviceUpdateId', 'sequence', then by RFC 8785 canonical JSON as the tie-breaker.

Each resource array contains every current or immutable instance named by its declared shape exactly
once. Each listed sort path resolves to a scalar. Scalar order is null first, then false before true,
integers numerically, and every other string-form scalar by UTF-8 bytes. Sort ascending by the complete
tuple, then use RFC 8785 canonical JSON only as the tie-breaker.
Recursively omit every object field whose name ends in 'Token', at every nesting depth.

'Work' is exactly
'{workId:uuid,kind:COMMAND_DELIVERY|REPORT_TIMEOUT|ROLLBACK,aggregateId:uuid,state:PENDING|LEASED|SUCCEEDED|FAILED|CANCELLED,terminal:boolean,attempt:int,leaseOwner:string|null,leaseExpiresAt:timestamp|null}'.
'kind' is one of exactly 'COMMAND_DELIVERY', 'REPORT_TIMEOUT', 'ROLLBACK'. Both lease fields are non-null exactly
when state is 'LEASED' and are null in every other state. 'terminal' is true exactly when state is
'SUCCEEDED', 'FAILED', or 'CANCELLED'; terminal Work is retained.
A backlog is drained exactly when no matching Work has 'terminal:false'. The 'work' array sorts by
workId.

'events' contains exact Domain Event objects sorted by aggregateId, then sequence, then eventId. Apply
the same recursive '*Token' omission to every event payload. Omit authentication and business fencing
tokens, idempotency keys, raw webhook bodies, private filesystem paths, and secrets. This is the
external invariant query surface.

Domain errors below are exhaustive for well-formed requests, in addition to the common errors published
above plus 400 'INVALID_REQUEST', 400 'INVALID_CURSOR', 404 'NOT_FOUND', and 409
'IDEMPOTENCY_CONFLICT':

| HTTP | Code | Exact trigger |
| ---: | --- | --- |
| 409 | FIRMWARE_INCOMPATIBLE | Device model or installed version is not supported |
| 409 | DEVICE_UPDATE_ACTIVE | Device already has another non-terminal update |
| 409 | DEVICE_REPORT_SEQUENCE_GAP | batch is not the next contiguous sequence |
| 409 | STALE_COMMAND_TOKEN | report does not match the current command token |
| 409 | INSTALLED_DIGEST_MISMATCH | VERIFY reports another digest |
| 409 | FIRMWARE_VERSION_EXISTS | modelId and canonical version already identify another Firmware Image |
| 400 | INVALID_FIRMWARE_IMAGE | version, size, path, digest, or compatibleFromVersions violates the published bounds |

### Durable idempotency

Every mutation requires 'Idempotency-Key', 1-128 visible ASCII characters. Scope is method, canonical
path, and key. Persist a canonical semantic request
fingerprint and the complete status/body before acknowledging success. An identical retry, including
after restart or unknown response loss, returns the original status and semantic JSON with no second
effect. Reusing a key with different semantics returns 409 'IDEMPOTENCY_CONFLICT'. Concurrent identical
requests converge on one result; a process-local map is not authority. Do not expire records during the
benchmark or rewrite saved replay bodies during migration.

## Seed contract

'npm run db:seed -- --file <path>' accepts exactly:

'{schemaVersion:1,seedVersion,deviceModels,devices,firmwareImages,campaigns,deviceUpdates,commands,reports}; image digests match relative fixture bytes, versions follow the published comparator, and device/report sequences are valid.'

Member schemas are exact:

- deviceModels[] = {modelId:uuid,name:string}; devices[] = {deviceId:uuid,modelId:uuid,labels:object,installedVersion:string,installedDigest:sha256,lastReportSequence:int}
- firmwareImages[] use exact FirmwareImage fields plus assetPath relative to <seed-directory>/assets; bytes, size, digest, model, and version compatibility verify atomically
- campaigns[], deviceUpdates[], commands[], and reports[] use exact FirmwareCampaign, DeviceUpdate, DeviceCommand, and DeviceReport schemas and must reconcile sequence, active capacity, installed versions, and terminal state

'seedVersion' is a non-empty string up to 64 characters. The importer records the canonical file digest.
The same version and digest is a no-op replay; the same version with different content fails with
'SEED_VERSION_CONFLICT'. Reject unknown keys, duplicate IDs, missing references, invalid states, broken
invariants, out-of-range integers, and malformed times. Any invalid member rejects the complete import
without changing business rows, tasks, idempotency, or Domain Events.

## Workers, events, and recovery

Workers claim bounded persisted leases using 'WORK_LEASE_SECONDS'. Lease ownership must be proven again
inside the short transaction that commits a result. Do not hold a database transaction while waiting on
HTTP, files, clocks, or another process. An expired lease is reclaimable, but a stale token cannot commit.

Business state and its Domain Event commit in one transaction. Event fields are 'eventId', 'aggregateId',
positive integer 'sequence', 'type', 'occurredAt', 'schemaVersion:1', and 'payload'. Required event types:
`campaign.created`, `device-update.started`, `firmware.installed`, `device-update.failed`, `device-update.rolled-back`, `campaign.completed`. 'payload' is exactly '{}' for every V1 event; a later Manager event also uses '{}' unless
its published contract literally supplies another payload shape. A rollback creates no event. Sequence
is contiguous per aggregate.

The dispatcher sends JSON with 'X-FirmwareFleet-Event-Id' and 'X-FirmwareFleet-Event-Type'. Network errors,
timeouts, and non-2xx responses retry indefinitely with bounded backoff. Every retry keeps the same
eventId and semantic body. Successful delivery order is increasing aggregate sequence. At-least-once
delivery may repeat a request; it must not invent another event identity.

### Controlled recovery barrier

When 'TEST_BARRIER_URL' is empty, no barrier request exists. When both test variables are set, workers
POST before continuing at 'worker.claimed', 'worker.effect-complete', and 'worker.before-commit'; the
dispatcher posts at 'dispatcher.response-received'. The exact JSON is
'{schemaVersion:1,processRole:worker|dispatcher,point,workId,aggregateId,attempt,leaseTokenHash}' and the
header is 'X-Test-Barrier-Token: <TEST_BARRIER_TOKEN>'. IDs and point stay identical across retries;
leaseTokenHash is SHA-256 of the token, never the token. A 204 response releases the process. A held
response pauses it without an open database transaction. Connection loss or non-204 retries every
100 ms with the same body until lease loss or process termination. Only localhost URLs are accepted.

## Real UI

Provide desktop and mobile flows for creating the V1 aggregate, viewing collections and detail,
performing every public user action, observing asynchronous Command Task progress, browsing event and
history evidence, and recovering after refresh. Show loading, empty, validation, conflict, stale,
offline/retry, terminal, and permission-error states. Use visible semantic controls, keyboard navigation,
associated labels, focus management, and WCAG AA contrast. Never require devtools or direct API calls to
complete the primary flow.

## Project-owned verification

- Unit tests cover deterministic policy, state transitions, canonicalization, and boundary values.
- Integration tests start real PostgreSQL and real HTTP processes; they never call internal services.
- Browser E2E uses the production build, real Chromium, real API/database/workers, and visible controls.
- Concurrency tests use at least two API processes and two workers against one PostgreSQL database.
- Recovery tests use a public test-only barrier to observe claim/commit or receiver/ACK boundaries before
  SIGKILL; random sleeps are not fault control.
- Performance tests run the production build for the fixed intervals below, report p50/p95/p99, throughput,
  successful mutations, expected conflicts, unexpected 5xx, backlog drain, and post-load invariants.

Fixed V1-compatible performance scenarios:

### Scenario 'device-command-poll'

- Target: serve 3,000 command polls/s with p95 <= 80 ms
- Mode: 'http'
- Method: 'POST'
- Path: '/api/v1/devices/:deviceId/commands/poll'
- Setup: All 100,000 Devices have one current command. Half of the poll targets report the preceding sequence and half report the current sequence; polling does not consume commands.
- Selector: Alternate COMMAND and NO_CHANGE Device IDs from separate bytewise-sorted lists.
- Request: {lastCommandSequence}; use current-1 for COMMAND and current for NO_CHANGE.
- Concurrency: 64
- Warm-up seconds: 10
- Measure seconds: 60
- Success: Only 200 exact poll responses count; each complete 100-request block is exactly 50 COMMAND and 50 NO_CHANGE, and command tokens never cross Device IDs.
- Threshold: At least 3,000 successful polls/s for 60 seconds and p95 <= 80 ms; unexpected 5xx = 0.
- Timer: The throughput window starts with the first measured request after warm-up; each latency sample runs from request dispatch through the complete response body.

### Scenario 'device-report-batch'

- Target: ingest 2,000 Device Reports/s with p95 <= 200 ms
- Mode: 'http'
- Method: 'POST'
- Path: '/api/v1/devices/:deviceId/report-batches'
- Setup: Reserve 70,000 Device commands: 10,000 unique reports for warm-up and 60,000 for measurement. Every request contains exactly one report.
- Selector: Repeat a new one-report batch then its exact idempotent replay. Across each 100 unique reports, 90 are SUCCEEDED and 10 are FAILED.
- Request: {firstSequence,reports:[{sequence,commandId,commandToken,outcome,installedDigest}]}; replay reuses key and body.
- Concurrency: 64
- Warm-up seconds: 10
- Measure seconds: 60
- Success: A first atomic stored batch or exact replay counts; no partial batch, sequence gap, or cross-command token is accepted.
- Threshold: At least 2,000 successful one-report batch responses/s for 60 seconds and p95 <= 200 ms; exactly half the requests are replays.
- Timer: The throughput window starts with the first measured request after warm-up; each latency sample runs from request dispatch through the complete response body.

### Scenario 'command-recovery'

- Target: recover and drain 100,000 pending Command Tasks within 180 s after restart
- Mode: 'worker'
- Method: 'N/A'
- Path: 'work:COMMAND_DELIVERY'
- Setup: Exactly 100,000 Devices each have one pending COMMAND_DELIVERY Work. Hold two workers at worker.claimed, SIGKILL, wait for lease expiry, then start two replacements.
- Selector: Process campaignId,deviceId,command sequence order while respecting each Campaign maxParallel bound.
- Request: No measured client request is issued; setup uses only the published seed and public APIs before the worker timer starts.
- Concurrency: 2
- Warm-up seconds: 0
- Measure seconds: 180
- Success: Every selected command becomes durably pollable with one identity, no COMMAND_DELIVERY Work remains nonterminal, and Campaign active counts never exceed maxParallel.
- Threshold: All 100,000 pending commands drain in <= 180 seconds after replacement spawn; stale commit and unexpected failure counts are zero.
- Timer: Start when both replacements spawn and stop only after snapshot plus representative poll responses prove every postcondition.

Fixed performance seed: seedVersion perf-v1 contains exactly 100 deviceModels, 100,000 devices, 500 firmwareImages, 100 campaigns, 100,000 deviceUpdates, 100,000 current commands, and zero reports; every Device is offline with exactly one current command and one pending Command Task.

The three scenarios are independent runs from a freshly migrated database and the exact seed above;
complete each scenario's Setup before its Timer begins. Mode 'http' means 'method' and 'path' name the
only measured public request operations and 'concurrency' is the exact closed-loop client count. Mode
'worker' means method 'N/A', 'path' names the measured Work kinds, and 'concurrency' is the exact worker
process count. Use exactly each scenario's Selector and Request; there is no inferred mixed workload.
Run exactly 'warmupSeconds' unmeasured seconds, then exactly 'measureSeconds' measured seconds or until
the Timer's stated terminal condition. Stateful warm-up and measured identities must be disjoint. Count
complete HTTP response bodies for latency. Expected published conflicts are reported separately unless
the scenario's Success and Threshold explicitly count them.

The benchmark container has 4 logical CPUs and 8 GiB RAM; PostgreSQL 16, Chromium, two API processes,
the specified workers, and one dispatcher share that limit. Every later compatible binary must rerun
these same three scenarios without changing any field or threshold.

Unexpected 5xx count must be zero. Meeting latency or throughput while any mandatory invariant is false
is a failed performance run.

## Out of scope

- binary delta generation
- device authentication
- CDN
- hardware attestation
- peer-to-peer updates

## Handoff

Keep README and OpenAPI current. Finish with a findings-first review and report architecture, module and
process ownership, public interfaces, success/failure data flow, transaction and lease boundaries,
migrations, compatibility, exact commands run, test and performance results, recovery evidence, known
risks, and every check not run. Do not claim a check that was not actually executed.

## Additional product requirements — required in the same final system




完整系统包含“multi-hop firmware upgrade plans”。
以下业务规则、wire schema、接口和错误全部是公开产品合同。

业务规则：

1. A target Firmware Image may require a Device to install 1-5 intermediate Images through declared compatibleFromVersions edges.
2. At Campaign creation, compute and persist one immutable Upgrade Plan per Device: fewest hops first, then lexicographically smallest version sequence, then imageId.
3. Each hop has DOWNLOAD, INSTALL, and VERIFY commands and the next hop cannot start before the prior digest verifies.
4. Failure rolls back only the current hop to its captured prior Image
a successful earlier intermediate remains the starting point for an explicit retry.
5. Campaign progress aggregates Devices and hop states, while maxParallel counts Devices rather than hop commands.
6. Legacy direct-compatible Campaigns remain one-hop and keep prior response fields
multi-hop updates expose upgradePlan[] and currentHopIndex.

8. In-flight Command Tasks retain their sequence and retry identity.
9. Completed Campaigns remain terminal.
10. The versioned seed schema remains exactly V1
Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
11. The only new Domain Event type names are those written literally in the Manager rules or contracts above.
Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
12. Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
13. Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

新增 wire schema：

- UpgradePlan = {deviceUpdateId:uuid,sourceVersion:string,targetVersion:string,pathDigest:sha256,currentHopIndex:int,hops:[UpgradeHop],createdAt:timestamp}
- UpgradeHop = {hopIndex:int,firmwareImageId:uuid,fromVersion:string,toVersion:string,imageDigest:sha256,state:WAITING|RUNNING|SUCCEEDED|FAILED,attempts:[UpgradeHopAttempt]}
- UpgradeHopAttempt = {attempt:int,state:DOWNLOADING|INSTALLING|VERIFYING|SUCCEEDED|FAILED|ROLLED_BACK,firstCommandSequence:int,lastCommandSequence:int|null,startedAt:timestamp,completedAt:timestamp|null}

新增或变更接口：

- POST /api/v1/firmware-campaigns computes every target Device UpgradePlan in the creation transaction using fewest hops, then lexicographically smallest version sequence, then imageId sequence
if any target has no path of 1..5 hops, no Campaign, Device Update, command, or event is created.
- pathDigest is SHA-256 of RFC 8785 {deviceId,sourceVersion,targetVersion,imageIds:[uuid]} for the selected ordered path.
- GET /api/v1/device-updates/:deviceUpdateId/upgrade-plan returns the immutable UpgradePlan
legacy direct-compatible updates contain exactly one Hop and retain existing singular fields.
- POST /api/v1/device-updates/:deviceUpdateId/retry with {expectedCurrentHopIndex,expectedAttempt} is legal only after the current attempt failed and rolled back
it preserves successful earlier Hops and creates a new attempt with fresh tokens and continuing commandSequence values.
- Device commandSequence is global across all Hops and attempts.
Poll and report APIs never reset it at a Hop boundary, and a report for a non-current Hop, attempt, command, or token cannot change installed firmware or plan state.

新增稳定错误：

- 409 UPGRADE_PATH_UNAVAILABLE: a target Device has no deterministic path to the target Image within five hops
- 409 UPGRADE_HOP_NOT_CURRENT: the command or report references another Hop or attempt
- 409 DEVICE_UPDATE_NOT_RETRYABLE: the current Hop lacks a completed failed rollback or expected attempt is stale

FINAL snapshot 与性能兼容合同：

The FINAL verification snapshot 'resources' object has exactly the union of these V1 and Manager resource specifications, with no other keys:

- 'deviceModels' uses exact shape 'DeviceModel = {modelId:uuid,name:string}' and sorts ascending by scalar field-path tuple 'modelId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'devices' uses exact shape 'Device = {deviceId:uuid,modelId:uuid,labels:object,installedVersion:string,installedDigest:sha256,lastReportSequence:int}' and sorts ascending by scalar field-path tuple 'deviceId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'firmwareImages' uses exact shape 'FirmwareImage' and sorts ascending by scalar field-path tuple 'firmwareImageId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'firmwareCampaigns' uses exact shape 'FirmwareCampaign' and sorts ascending by scalar field-path tuple 'campaignId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'deviceUpdates' uses exact shape 'DeviceUpdate' and sorts ascending by scalar field-path tuple 'deviceUpdateId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'deviceCommands' uses exact shape 'DeviceCommand' and sorts ascending by scalar field-path tuple 'deviceUpdateId', 'sequence', then by RFC 8785 canonical JSON as the tie-breaker.
- 'deviceReports' uses exact shape 'DeviceReport' and sorts ascending by scalar field-path tuple 'deviceUpdateId', 'sequence', then by RFC 8785 canonical JSON as the tie-breaker.
- 'upgradePlans' uses exact shape 'UpgradePlan' and sorts ascending by scalar field-path tuple 'deviceUpdateId', then by RFC 8785 canonical JSON as the tie-breaker.

The Manager-added resource specifications are exactly:

- 'upgradePlans' uses exact shape 'UpgradePlan' and sorts ascending by scalar field-path tuple 'deviceUpdateId', then by RFC 8785 canonical JSON as the tie-breaker.

The FINAL Work kind enum is exactly the union 'COMMAND_DELIVERY', 'REPORT_TIMEOUT', 'ROLLBACK'.
The Manager-added Work kinds are exactly (none).
All V1 snapshot point-in-time, recursive '*Token' omission, sorting, Work state/lease/retention/drain, and Domain Event rules remain mandatory.
The FINAL binary reruns exactly these three V1-compatible scenarios:

- 'device-command-poll': serve 3,000 command polls/s with p95 <= 80 ms
threshold: At least 3,000 successful polls/s for 60 seconds and p95 <= 80 ms
unexpected 5xx = 0.
- 'device-report-batch': ingest 2,000 Device Reports/s with p95 <= 200 ms
threshold: At least 2,000 successful one-report batch responses/s for 60 seconds and p95 <= 200 ms
exactly half the requests are replays.
- 'command-recovery': recover and drain 100,000 pending Command Tasks within 180 s after restart
threshold: All 100,000 pending commands drain in <= 180 seconds after replacement spawn
stale commit and unexpected failure counts are zero.

Their published setup, selector, request, concurrency, warm-up, measurement, timer, success condition, and threshold remain unchanged.
This Manager change adds correctness, concurrency, and recovery assertions only
it does not replace or relax a performance scenario.



