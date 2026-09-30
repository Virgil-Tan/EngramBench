# ClinicGrid — Complete system requirements

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

# ClinicGrid

Build ClinicGrid from this intentionally blank repository. This README is the complete product
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
| 'npm run start:worker' | Start one Expiry Task worker. |
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
| 'DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/clinicgrid' | Production/development authority. |
| 'TEST_DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/clinicgrid_test' | Required by all stateful tests. |
| 'PORT' | '3000' | Integer 1-65535; API and production UI origin. |
| 'ADMIN_TOKEN' | task-local value | Required only for documented admin mutation routes; never log it. |
| 'WEBHOOK_URL' | 'http://127.0.0.1:4010/events' | HTTP endpoint for Domain Event delivery. |
| 'WORK_LEASE_SECONDS' | '3' | Integer 1-60; persisted lease duration used by workers and recovery tests. |
| 'CHROMIUM_PATH' | '/usr/bin/chromium' | Browser executable for project-owned E2E. |
| 'MANAGED_DATA_ROOT' | '/tmp/clinicgrid-data' | Writable root for staged or generated bytes; never serve a path directly. |
| 'TEST_BARRIER_URL' | empty | Optional localhost HTTP receiver used only by controlled recovery tests. |
| 'TEST_BARRIER_TOKEN' | empty | Required barrier header value when the URL is set; never log it. |

Bind only to '127.0.0.1'. Logs must not contain tokens, idempotency keys, raw seed input, webhook
bodies, or private absolute paths.

## Domain and V1 behavior

| Term | Canonical definition | Avoid |
| --- | --- | --- |
| Clinician | A practitioner with versioned availability intervals. | Doctor, provider |
| Room | A physical treatment room with independent availability. | Location, office |
| Equipment Unit | A uniquely reservable device required by a Service Type. | Asset, tool |
| Appointment | One patient request that holds a Clinician, Room, and required Equipment Units for one interval. | Booking, visit |
| Waitlist Entry | A prioritized request for one Service Type and acceptable time range. | Queue item |
| Expiry Task | Durable work that expires an unconfirmed Appointment and releases every resource once. | Timer, cron |

Appointment: HELD -> CONFIRMED | CANCELLED | EXPIRED; terminal transitions are mutually exclusive.

1. Search availability from real Clinician, Room, and Equipment calendars.
2. Atomically hold every required resource for a 15-minute-aligned interval with a published expiry.
3. Confirm, cancel, or expire an Appointment with exactly one terminal winner and durable replay.
4. Promote eligible Waitlist Entries in strict priority, joinedAt, and ID order without skipping the head.
5. Expose patient and coordinator calendars, asynchronous expiry/promotion state, and event delivery.

### Deterministic policy

1. Intervals are half-open [startAt,endAt), startAt is aligned to 15 UTC minutes, and endAt equals startAt plus ServiceType.durationMinutes; duration is 15..240 in 15-minute steps.
2. Choose the requested Clinician, then the available Room by priority ascending and roomId, then one unit of each required equipment type by priority and equipmentUnitId. All calendars must cover the full interval.
3. A successful hold expires exactly 120 seconds after the database transaction timestamp. Confirm is legal strictly before expiresAt; at or after expiresAt the expiry outcome wins.
4. Waitlist priority is an integer from 0 through 100. Waitlist order is priority descending, joinedAt ascending, waitlistEntryId ascending. Promotion considers the head only and chooses the earliest feasible slot, then the normal resource order.

## Mandatory invariants

1. No resource has overlapping HELD or CONFIRMED Appointments.
2. An Appointment owns all required resources for its complete interval or owns none.
3. Cancellation or expiry releases each resource exactly once.
4. A Waitlist Entry produces at most one Appointment and the published head blocking order is preserved.
5. The persisted expiresAt instant, not a process-local timer, determines expiry.

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

- Appointment = {appointmentId:uuid,patientId:uuid,serviceTypeId:uuid,clinicianId:uuid,roomId:uuid,equipmentUnitIds:[uuid],startAt:timestamp,endAt:timestamp,state:HELD|CONFIRMED|CANCELLED|EXPIRED,expiresAt:timestamp,confirmedAt:timestamp|null,terminalAt:timestamp|null,sequence:int}
- AvailabilitySlot = {serviceTypeId:uuid,clinicianId:uuid,startAt:timestamp,endAt:timestamp,roomIds:[uuid],equipmentOptions:[[uuid]]}; options are sorted by allocation priority
- WaitlistEntry = {waitlistEntryId:uuid,patientId:uuid,serviceTypeId:uuid,earliestStart:timestamp,latestEnd:timestamp,priority:int,state:WAITING|PROMOTED|WITHDRAWN,joinedAt:timestamp,appointmentId:uuid|null}
- ServiceType = {serviceTypeId:uuid,name:string,durationMinutes:int,requiredEquipmentTypes:[string]}

The public aggregate routes are:

- 'GET /api/v1/appointments?limit&cursor' and
  'GET /api/v1/appointments/:appointmentId'.
- POST /api/v1/appointments with {patientId,serviceTypeId,clinicianId,startAt}; return 201 HELD with assigned room/equipment and expiresAt, or 409 SLOT_UNAVAILABLE with no effects.
- POST /api/v1/appointments/:appointmentId/confirm with {} returns CONFIRMED only from HELD before expiresAt; at or after expiresAt it atomically expires and returns APPOINTMENT_EXPIRED, while CONFIRMED or CANCELLED returns APPOINTMENT_NOT_CONFIRMABLE and an already EXPIRED Appointment returns APPOINTMENT_EXPIRED.
- POST /api/v1/appointments/:appointmentId/cancel with {reason} releases resources once.
- POST /api/v1/waitlist-entries with {patientId,serviceTypeId,earliestStart,latestEnd,priority} requires integer priority 0..100 and returns 201 WAITING with server-assigned joinedAt.
- GET /api/v1/availability?serviceTypeId&clinicianId&from&to returns {items:[AvailabilitySlot]} in startAt order for a range of at most 31 days.
- GET /api/v1/resources/:resourceType/:resourceId/calendar?from&to returns active Appointment IDs and half-open intervals.
- 'GET /api/v1/domain-events?aggregateId&afterSequence&limit' returns committed events in sequence.
- 'GET /api/v1/verification-snapshot' requires 'Authorization: Bearer <ADMIN_TOKEN>' and returns one
  serializable snapshot '{asOf:timestamp,resources:{...},work:[Work],events:[DomainEvent]}'.

### V1 verification snapshot

The complete snapshot is read from one PostgreSQL point-in-time; 'asOf', every resource array, 'work',
and 'events' must describe that same database snapshot. The V1 'resources' object has exactly these keys
and no others:

- 'clinicians' uses exact shape 'Clinician = {clinicianId:uuid,name:string,priority:int,availability:[{startAt:timestamp,endAt:timestamp}]}' and sorts ascending by scalar field-path tuple 'clinicianId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'rooms' uses exact shape 'Room = {roomId:uuid,name:string,priority:int,availability:[{startAt:timestamp,endAt:timestamp}]}' and sorts ascending by scalar field-path tuple 'roomId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'equipmentUnits' uses exact shape 'EquipmentUnit = {equipmentUnitId:uuid,equipmentType:string,priority:int,availability:[{startAt:timestamp,endAt:timestamp}]}' and sorts ascending by scalar field-path tuple 'equipmentUnitId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'serviceTypes' uses exact shape 'ServiceType' and sorts ascending by scalar field-path tuple 'serviceTypeId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'patients' uses exact shape 'Patient = {patientId:uuid,name:string}' and sorts ascending by scalar field-path tuple 'patientId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'appointments' uses exact shape 'Appointment' and sorts ascending by scalar field-path tuple 'appointmentId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'waitlistEntries' uses exact shape 'WaitlistEntry' and sorts ascending by scalar field-path tuple 'waitlistEntryId', then by RFC 8785 canonical JSON as the tie-breaker.

Each resource array contains every current or immutable instance named by its declared shape exactly
once. Each listed sort path resolves to a scalar. Scalar order is null first, then false before true,
integers numerically, and every other string-form scalar by UTF-8 bytes. Sort ascending by the complete
tuple, then use RFC 8785 canonical JSON only as the tie-breaker.
Recursively omit every object field whose name ends in 'Token', at every nesting depth.

'Work' is exactly
'{workId:uuid,kind:APPOINTMENT_EXPIRY|WAITLIST_PROMOTION,aggregateId:uuid,state:PENDING|LEASED|SUCCEEDED|FAILED|CANCELLED,terminal:boolean,attempt:int,leaseOwner:string|null,leaseExpiresAt:timestamp|null}'.
'kind' is one of exactly 'APPOINTMENT_EXPIRY', 'WAITLIST_PROMOTION'. Both lease fields are non-null exactly
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
| 409 | SLOT_UNAVAILABLE | the complete resource bundle cannot be allocated |
| 409 | APPOINTMENT_EXPIRED | confirm arrives at or after expiresAt |
| 409 | APPOINTMENT_NOT_CONFIRMABLE | Appointment is already CONFIRMED or CANCELLED |
| 409 | APPOINTMENT_NOT_CANCELLABLE | Appointment is already terminal |
| 409 | WAITLIST_HEAD_BLOCKED | a later entry attempts promotion before the eligible head |
| 400 | INVALID_APPOINTMENT_INTERVAL | start alignment or Service Type duration is invalid |

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

'{schemaVersion:1,seedVersion,clinicians,rooms,equipmentUnits,serviceTypes,patients,appointments,waitlistEntries}; intervals are UTC, 15-minute aligned, non-overlapping per resource, and references must exist.'

Member schemas are exact:

- clinicians[] = {clinicianId:uuid,name:string,priority:int,availability:[{startAt:timestamp,endAt:timestamp}]} and intervals do not overlap
- rooms[] = {roomId:uuid,name:string,priority:int,availability:[interval]} with unique priority per facility
- equipmentUnits[] = {equipmentUnitId:uuid,equipmentType:string,priority:int,availability:[interval]} with unique priority per type
- serviceTypes[] use the exact ServiceType wire schema; patients[] = {patientId:uuid,name:string}; seeded appointments use the exact Appointment schema and must not overlap
- waitlistEntries[] use the exact WaitlistEntry schema; priority is 0..100 and PROMOTED entries reference their unique Appointment

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
`appointment.held`, `appointment.confirmed`, `appointment.cancelled`, `appointment.expired`, `waitlist.promoted`. 'payload' is exactly '{}' for every V1 event; a later Manager event also uses '{}' unless
its published contract literally supplies another payload shape. A rollback creates no event. Sequence
is contiguous per aggregate.

The dispatcher sends JSON with 'X-ClinicGrid-Event-Id' and 'X-ClinicGrid-Event-Type'. Network errors,
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
performing every public user action, observing asynchronous Expiry Task progress, browsing event and
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

### Scenario 'availability-read'

- Target: 200 availability queries/s with p95 <= 180 ms
- Mode: 'http'
- Method: 'GET'
- Path: '/api/v1/availability?serviceTypeId=:serviceTypeId&clinicianId=:clinicianId&from=:from&to=:to'
- Setup: Select all serviceTypeId,clinicianId pairs with seeded availability; for each pair use its earliest complete UTC day as the half-open query range.
- Selector: Round-robin eligible pairs by serviceTypeId then clinicianId, both bytewise; reads reuse the same immutable ranges.
- Request: No body; from and to are millisecond UTC timestamps exactly 24 hours apart and to is exclusive.
- Concurrency: 64
- Warm-up seconds: 10
- Measure seconds: 60
- Success: Only 200 responses with deterministically ordered AvailabilitySlot items and no overlapping allocation count.
- Threshold: At least 200 successful responses/s for 60 seconds and p95 <= 180 ms; unexpected 5xx = 0.
- Timer: The throughput window starts with the first measured request after warm-up; each latency sample runs from request dispatch through the complete response body.

### Scenario 'competing-holds'

- Target: 30 competing hold requests/s with p95 <= 600 ms
- Mode: 'http'
- Method: 'POST'
- Path: '/api/v1/appointments'
- Setup: Create 30 warm-up and 180 measured feasible hot slots. Assign ten distinct Patient IDs to contend for each slot and never reuse a patient-slot attempt.
- Selector: Visit hot slots round-robin; send their ten contenders concurrently in bytewise patientId order before advancing to the next slot.
- Request: {patientId,serviceTypeId,clinicianId,startAt} for the exact hot slot; every request has a fresh Idempotency-Key.
- Concurrency: 64
- Warm-up seconds: 10
- Measure seconds: 60
- Success: For each slot exactly one 201 HELD is a successful hold and the other nine responses are exactly 409 SLOT_UNAVAILABLE; request-rate latency includes both outcomes.
- Threshold: At least 30 complete attempts/s for 60 seconds, all successful-hold responses have p95 <= 600 ms, and no slot has zero or multiple winners.
- Timer: The throughput window starts with the first measured request after warm-up; each latency sample runs from request dispatch through the complete response body.

### Scenario 'expiry-and-promotion-recovery'

- Target: expire and promote 2,000 due records within 45 s after restart
- Mode: 'worker'
- Method: 'N/A'
- Path: 'work:APPOINTMENT_EXPIRY,WAITLIST_PROMOTION'
- Setup: The seed has exactly 1,000 due HELD Appointments and 1,000 eligible WAITING entries. Hold two workers at worker.claimed, SIGKILL, wait for lease expiry, then start two replacements.
- Selector: Expire by expiresAt,appointmentId and promote by priority descending,joinedAt,waitlistEntryId without bypass.
- Request: No measured client request is issued; setup uses only the published seed and public APIs before the worker timer starts.
- Concurrency: 2
- Warm-up seconds: 0
- Measure seconds: 45
- Success: All 1,000 due Appointments are EXPIRED once, all 1,000 eligible entries are PROMOTED once, no named Work remains nonterminal, and resource calendars remain exclusive.
- Threshold: Both backlogs drain in <= 45 seconds after replacement workers spawn; unexpected failures = 0.
- Timer: Start when both replacements spawn and stop only on a verification snapshot proving both Work kinds drained and all invariants.

Fixed performance seed: seedVersion perf-v1 contains exactly 2,000 clinicians, 2,000 rooms, 4,000 equipmentUnits, 20 serviceTypes, 100,000 patients, 51,000 appointments, and 1,000 waitlistEntries: 50,000 Appointments are CONFIRMED, exactly 1,000 are HELD with expiry due at measurement start, and exactly 1,000 Waitlist Entries are WAITING and eligible for promotion at measurement start.

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

- medical records
- billing
- telemedicine
- prescriptions
- patient authentication

## Handoff

Keep README and OpenAPI current. Finish with a findings-first review and report architecture, module and
process ownership, public interfaces, success/failure data flow, transaction and lease boundaries,
migrations, compatibility, exact commands run, test and performance results, recovery evidence, known
risks, and every check not run. Do not claim a check that was not actually executed.

## Additional product requirements — required in the same final system




完整系统包含“atomic multi-visit care plans”。
以下业务规则、wire schema、接口和错误全部是公开产品合同。

业务规则：

1. Create a Care Plan containing 2-12 ordered Appointment requests for one patient.
2. All visits must be held atomically
if any required resource is unavailable, no Care Plan or Appointment remains.
3. Each visit keeps its own resources and expiry.
CarePlan.expiresAt is the earliest expiresAt among HELD visits and is null when no visit remains HELD
the Care Plan exposes aggregate HELD, PARTIALLY_CONFIRMED, CONFIRMED, or TERMINATED state.
4. Care Plan state is HELD when every visit is HELD, PARTIALLY_CONFIRMED when at least one visit is CONFIRMED and every other visit is HELD, CONFIRMED when every visit is CONFIRMED, and TERMINATED after explicit termination or when any visit becomes CANCELLED or EXPIRED.
5. Confirming and cancelling operate per visit.
Cancelling or expiring one visit atomically changes the Care Plan to TERMINATED, preserves CONFIRMED visits, cancels every other HELD visit, and releases all affected resources exactly once.
Explicit Plan termination has the same preservation and cancellation rule and is legal only from HELD or PARTIALLY_CONFIRMED.
6. A multi-visit Waitlist Entry participates as one item in the existing Waitlist order and promotes only when every visit can be held atomically.
7. Legacy single Appointment APIs and response bodies remain unchanged.
8. Existing Appointments remain standalone with carePlanId null and unchanged replay bodies.
9. Historical resource assignments, expiry instants, and event sequences cannot change.

11. The versioned seed schema remains exactly V1
Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
12. The only new Domain Event type names are those written literally in the Manager rules or contracts above.
Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
13. Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
14. Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

新增 wire schema：

- CarePlan = {carePlanId:uuid,patientId:uuid,state:HELD|PARTIALLY_CONFIRMED|CONFIRMED|TERMINATED,visits:[{visitIndex:int,appointment:Appointment}],expiresAt:timestamp|null,createdAt:timestamp,terminalAt:timestamp|null,sequence:int}
- CarePlanWaitlistEntry = {waitlistEntryId:uuid,patientId:uuid,priority:int,visits:[{visitIndex:int,serviceTypeId:uuid,clinicianId:uuid,earliestStart:timestamp,latestEnd:timestamp}],state:WAITING|PROMOTED|WITHDRAWN,joinedAt:timestamp,carePlanId:uuid|null}
priority uses the V1 0..100 bound and visitIndex values are contiguous from 1

新增或变更接口：

- POST /api/v1/care-plans with {patientId,visits:[{serviceTypeId,clinicianId,startAt}]} returns 201 CarePlan only when all 2..12 visits hold atomically
- GET /api/v1/care-plans/:carePlanId returns CarePlan
POST /api/v1/care-plans/:carePlanId/visits/:visitIndex/confirm with {} confirms one HELD visit under the V1 expiry and error rules
- POST /api/v1/care-plans/:carePlanId/visits/:visitIndex/cancel with {reason} cancels one HELD visit and atomically applies the published Care Plan termination and resource-release rule
- POST /api/v1/care-plans/:carePlanId/terminate with {reason} atomically cancels every HELD visit and returns TERMINATED
- POST /api/v1/waitlist-entries accepts either the legacy single-visit body or {patientId,priority,visits:[{serviceTypeId,clinicianId,earliestStart,latestEnd}]}, never both, requires priority 0..100, and returns 201 CarePlanWaitlistEntry for 2..12 visits.
Promotion processes the entry as one queue head, chooses each visit's earliest feasible slot in visitIndex order using V1 resource ordering, and atomically creates and links one CarePlan or creates nothing

新增稳定错误：

- 409 CARE_PLAN_UNAVAILABLE: one or more complete visit resource bundles cannot be held
- 409 CARE_PLAN_NOT_TERMINABLE: Care Plan is CONFIRMED or TERMINATED, or no visit remains HELD

FINAL snapshot 与性能兼容合同：

The FINAL verification snapshot 'resources' object has exactly the union of these V1 and Manager resource specifications, with no other keys:

- 'clinicians' uses exact shape 'Clinician = {clinicianId:uuid,name:string,priority:int,availability:[{startAt:timestamp,endAt:timestamp}]}' and sorts ascending by scalar field-path tuple 'clinicianId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'rooms' uses exact shape 'Room = {roomId:uuid,name:string,priority:int,availability:[{startAt:timestamp,endAt:timestamp}]}' and sorts ascending by scalar field-path tuple 'roomId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'equipmentUnits' uses exact shape 'EquipmentUnit = {equipmentUnitId:uuid,equipmentType:string,priority:int,availability:[{startAt:timestamp,endAt:timestamp}]}' and sorts ascending by scalar field-path tuple 'equipmentUnitId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'serviceTypes' uses exact shape 'ServiceType' and sorts ascending by scalar field-path tuple 'serviceTypeId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'patients' uses exact shape 'Patient = {patientId:uuid,name:string}' and sorts ascending by scalar field-path tuple 'patientId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'appointments' uses exact shape 'Appointment' and sorts ascending by scalar field-path tuple 'appointmentId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'waitlistEntries' uses exact shape 'WaitlistEntry' and sorts ascending by scalar field-path tuple 'waitlistEntryId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'carePlans' uses exact shape 'CarePlan' and sorts ascending by scalar field-path tuple 'carePlanId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'carePlanWaitlistEntries' uses exact shape 'CarePlanWaitlistEntry' and sorts ascending by scalar field-path tuple 'waitlistEntryId', then by RFC 8785 canonical JSON as the tie-breaker.

The Manager-added resource specifications are exactly:

- 'carePlans' uses exact shape 'CarePlan' and sorts ascending by scalar field-path tuple 'carePlanId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'carePlanWaitlistEntries' uses exact shape 'CarePlanWaitlistEntry' and sorts ascending by scalar field-path tuple 'waitlistEntryId', then by RFC 8785 canonical JSON as the tie-breaker.

The FINAL Work kind enum is exactly the union 'APPOINTMENT_EXPIRY', 'WAITLIST_PROMOTION'.
The Manager-added Work kinds are exactly (none).
All V1 snapshot point-in-time, recursive '*Token' omission, sorting, Work state/lease/retention/drain, and Domain Event rules remain mandatory.
The FINAL binary reruns exactly these three V1-compatible scenarios:

- 'availability-read': 200 availability queries/s with p95 <= 180 ms
threshold: At least 200 successful responses/s for 60 seconds and p95 <= 180 ms
unexpected 5xx = 0.
- 'competing-holds': 30 competing hold requests/s with p95 <= 600 ms
threshold: At least 30 complete attempts/s for 60 seconds, all successful-hold responses have p95 <= 600 ms, and no slot has zero or multiple winners.
- 'expiry-and-promotion-recovery': expire and promote 2,000 due records within 45 s after restart
threshold: Both backlogs drain in <= 45 seconds after replacement workers spawn
unexpected failures = 0.

Their published setup, selector, request, concurrency, warm-up, measurement, timer, success condition, and threshold remain unchanged.
This Manager change adds correctness, concurrency, and recovery assertions only
it does not replace or relax a performance scenario.



