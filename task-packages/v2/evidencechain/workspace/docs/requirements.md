# EvidenceChain — Complete system requirements

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

# EvidenceChain

Build EvidenceChain from this intentionally blank repository. This README is the complete product
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
| 'npm run start:worker' | Start one Verification Task worker. |
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
| 'DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/evidencechain' | Production/development authority. |
| 'TEST_DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/evidencechain_test' | Required by all stateful tests. |
| 'PORT' | '3000' | Integer 1-65535; API and production UI origin. |
| 'ADMIN_TOKEN' | task-local value | Required only for documented admin mutation routes; never log it. |
| 'WEBHOOK_URL' | 'http://127.0.0.1:4010/events' | HTTP endpoint for Domain Event delivery. |
| 'WORK_LEASE_SECONDS' | '3' | Integer 1-60; persisted lease duration used by workers and recovery tests. |
| 'CHROMIUM_PATH' | '/usr/bin/chromium' | Browser executable for project-owned E2E. |
| 'MANAGED_DATA_ROOT' | '/tmp/evidencechain-data' | Writable root for staged or generated bytes; never serve a path directly. |
| 'TEST_BARRIER_URL' | empty | Optional localhost HTTP receiver used only by controlled recovery tests. |
| 'TEST_BARRIER_TOKEN' | empty | Required barrier header value when the URL is set; never log it. |

Bind only to '127.0.0.1'. Logs must not contain tokens, idempotency keys, raw seed input, webhook
bodies, or private absolute paths.

## Domain and V1 behavior

| Term | Canonical definition | Avoid |
| --- | --- | --- |
| Case Manifest | An immutable expected list of Collected Items for one Case. | Checklist, order |
| Collected Item | One uniquely labeled evidence item expected by a Case Manifest. | Sample, object |
| Intake Scan | An immutable observed label, seal, timestamp, and facility from one scanner batch. | Reading, upload |
| Custody Match | The confirmed association between an expected Collected Item and Intake Scan in V1. | Link, pairing |
| Custody Transfer | An immutable from/to handoff accepted by exactly one current custodian. | Move, status |
| Verification Task | Durable leased work checking seals, labels, and manifest rules. | Job, inspection |

Collected Item: EXPECTED -> RECEIVED -> VERIFIED | QUARANTINED; Custody Match: PROPOSED -> CONFIRMED | REVERSED.

1. Import scanner batches atomically and durably deduplicate scans from intermittently connected devices.
2. Suggest and confirm one-to-one Custody Matches using exact published label and seal rules.
3. Run recoverable Verification Tasks and quarantine failures without losing original observations.
4. Transfer custody with compare-and-set current custodian and immutable handoff history.
5. Expose missing, unmatched, quarantined, and custody timelines through real coordinator UI flows.

### Deterministic policy

1. A device batchSequence is a positive contiguous integer. A replay with the same deviceId, sequence, and canonical digest returns the original batch; a gap or different digest is rejected atomically.
2. Suggestion candidates require exact case-sensitive label equality. Exact seal equality ranks first; a seal mismatch may be proposed second but Verification deterministically quarantines it.
3. Process unmatched Collected Items by caseId, expectedLabel, collectedItemId and scans by scannedAt,deviceId,scanId; one snapshot may use each member once.
4. Confirm assigns the receiving Facility's configured Custodian. A transfer requires fromCustodianId to equal currentCustodianId and occurredAt not precede the last accepted transfer.
5. Custody Match reversal is legal only from CONFIRMED while the Collected Item remains RECEIVED, no Verification result has committed, and no Custody Transfer has been accepted. It atomically restores the Item to EXPECTED and Intake Scan to UNMATCHED, clears the Item's intake and custodian fields, fences pending Verification work, and emits custody-match.reversed.

## Mandatory invariants

1. An Intake Scan is active in at most one Custody Match.
2. A Collected Item is active in at most one Custody Match in V1.
3. Exactly one custodian owns a received item at an instant and each accepted transfer links to the prior one.
4. A scanner batch is wholly accepted or leaves no scans, tasks, matches, or events.
5. Verification never changes the immutable observed label, seal, device sequence, or scannedAt.

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

- IntakeScan = {intakeScanId:uuid,scanId:string,deviceId:uuid,batchSequence:int,label:string,sealCode:string,scannedAt:timestamp,facilityId:uuid,state:UNMATCHED|MATCHED,revision:int}
- CollectedItem = {collectedItemId:uuid,caseId:uuid,expectedLabel:string,expectedSealCode:string,quantity:int,state:EXPECTED|RECEIVED|VERIFIED|QUARANTINED,currentCustodianId:uuid|null,intakeScanId:uuid|null,revision:int,sequence:int}; quantity is a positive safe integer
- CustodyMatch = {matchId:uuid,collectedItemId:uuid,intakeScanId:uuid,state:PROPOSED|CONFIRMED|REVERSED,createdAt:timestamp,confirmedAt:timestamp|null,reversedAt:timestamp|null}
- CustodyTransfer = {transferId:uuid,collectedItemId:uuid,fromCustodianId:uuid,toCustodianId:uuid,occurredAt:timestamp,acceptedAt:timestamp,priorTransferId:uuid|null}
- EvidenceTimelineItem = {sequence:int,type:MATCH_CONFIRMED|MATCH_REVERSED|ITEM_VERIFIED|ITEM_QUARANTINED|CUSTODY_TRANSFERRED,occurredAt:timestamp,matchId:uuid|null,transferId:uuid|null,fromCustodianId:uuid|null,toCustodianId:uuid|null}; every field is required, matchId is non-null only for MATCH events, transferId and both custodian IDs are non-null only for CUSTODY_TRANSFERRED, occurredAt is the Match transition time, Verification completion time, or CustodyTransfer.acceptedAt, and sequence is the Collected Item's committed transition sequence

The public aggregate routes are:

- 'GET /api/v1/custody-matches?limit&cursor' and
  'GET /api/v1/custody-matches/:matchId'.
- POST /api/v1/intake-batches with {deviceId,batchSequence,scans:[{scanId,label,sealCode,scannedAt,facilityId}]}; return 202 with stable IDs or reject the complete batch.
- POST /api/v1/custody-matches with {collectedItemId,intakeScanId} creates a PROPOSED match.
- POST /api/v1/custody-matches/:matchId/confirm with {expectedItemRevision,expectedScanRevision} atomically reserves both.
- POST /api/v1/custody-matches/:matchId/reverse with {reason} atomically restores both members and returns REVERSED, or 409 CUSTODY_MATCH_NOT_REVERSIBLE.
- POST /api/v1/collected-items/:itemId/transfers with {fromCustodianId,toCustodianId,occurredAt} requires the current custodian.
- GET /api/v1/collected-items/:itemId/timeline returns {item:CollectedItem,items:[EvidenceTimelineItem]}; items contain exactly one entry per committed Item transition and sort by sequence ascending with no duplicate sequence.
- 'GET /api/v1/domain-events?aggregateId&afterSequence&limit' returns committed events in sequence.
- 'GET /api/v1/verification-snapshot' requires 'Authorization: Bearer <ADMIN_TOKEN>' and returns one
  serializable snapshot '{asOf:timestamp,resources:{...},work:[Work],events:[DomainEvent]}'.

### V1 verification snapshot

The complete snapshot is read from one PostgreSQL point-in-time; 'asOf', every resource array, 'work',
and 'events' must describe that same database snapshot. The V1 'resources' object has exactly these keys
and no others:

- 'cases' uses exact shape 'Case = {caseId:uuid,caseNumber:string}' and sorts ascending by scalar field-path tuple 'caseId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'caseManifests' uses exact shape 'CaseManifest = {caseId:uuid,version:int,items:[{collectedItemId:uuid,expectedLabel:string,expectedSealCode:string,quantity:int}]}' and sorts ascending by scalar field-path tuple 'caseId', 'version', then by RFC 8785 canonical JSON as the tie-breaker.
- 'facilities' uses exact shape 'Facility = {facilityId:uuid,name:string,receivingCustodianId:uuid}' and sorts ascending by scalar field-path tuple 'facilityId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'custodians' uses exact shape 'Custodian = {custodianId:uuid,name:string}' and sorts ascending by scalar field-path tuple 'custodianId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'deviceRegistrations' uses exact shape 'DeviceRegistration = {deviceId:uuid,facilityId:uuid,lastBatchSequence:int}' and sorts ascending by scalar field-path tuple 'deviceId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'intakeScans' uses exact shape 'IntakeScan' and sorts ascending by scalar field-path tuple 'intakeScanId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'collectedItems' uses exact shape 'CollectedItem' and sorts ascending by scalar field-path tuple 'collectedItemId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'custodyMatches' uses exact shape 'CustodyMatch' and sorts ascending by scalar field-path tuple 'matchId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'custodyTransfers' uses exact shape 'CustodyTransfer' and sorts ascending by scalar field-path tuple 'transferId', then by RFC 8785 canonical JSON as the tie-breaker.

Each resource array contains every current or immutable instance named by its declared shape exactly
once. Each listed sort path resolves to a scalar. Scalar order is null first, then false before true,
integers numerically, and every other string-form scalar by UTF-8 bytes. Sort ascending by the complete
tuple, then use RFC 8785 canonical JSON only as the tie-breaker.
Recursively omit every object field whose name ends in 'Token', at every nesting depth.

'Work' is exactly
'{workId:uuid,kind:EVIDENCE_VERIFICATION,aggregateId:uuid,state:PENDING|LEASED|SUCCEEDED|FAILED|CANCELLED,terminal:boolean,attempt:int,leaseOwner:string|null,leaseExpiresAt:timestamp|null}'.
'kind' is one of exactly 'EVIDENCE_VERIFICATION'. Both lease fields are non-null exactly
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
| 409 | DEVICE_SEQUENCE_GAP | batchSequence is not the next value |
| 409 | INTAKE_BATCH_CONFLICT | a replayed device sequence has another digest |
| 409 | CUSTODY_MATCH_CONFLICT | Item or Scan revision changed or is already matched |
| 409 | CUSTODY_MATCH_NOT_REVERSIBLE | Match is not CONFIRMED, Item is not RECEIVED, a Verification result has committed, or a Custody Transfer exists |
| 409 | CUSTODIAN_CHANGED | fromCustodianId is no longer current |
| 400 | INVALID_INTAKE_BATCH | batch member, label, seal, facility, or time is invalid |

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

'{schemaVersion:1,seedVersion,cases,caseManifests,facilities,custodians,deviceRegistrations,intakeScans,custodyMatches,transfers}; history arrays may be empty, expected labels are unique per Case, device IDs and starting sequences are unique, and references exist.'

Member schemas are exact:

- cases[] = {caseId:uuid,caseNumber:string}; caseManifests[] = {caseId:uuid,version:int,items:[{collectedItemId:uuid,expectedLabel:string,expectedSealCode:string,quantity:int}]}; quantity is a positive safe integer
- facilities[] = {facilityId:uuid,name:string,receivingCustodianId:uuid}; custodians[] = {custodianId:uuid,name:string}
- deviceRegistrations[] = {deviceId:uuid,facilityId:uuid,lastBatchSequence:int}; intakeScans[], custodyMatches[], and transfers[] use exact wire schemas, may be empty, and otherwise form valid chains

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
`intake-batch.accepted`, `custody-match.confirmed`, `item.verified`, `item.quarantined`, `custody.transferred`, `custody-match.reversed`. 'payload' is exactly '{}' for every V1 event; a later Manager event also uses '{}' unless
its published contract literally supplies another payload shape. A rollback creates no event. Sequence
is contiguous per aggregate.

The dispatcher sends JSON with 'X-EvidenceChain-Event-Id' and 'X-EvidenceChain-Event-Type'. Network errors,
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
performing every public user action, observing asynchronous Verification Task progress, browsing event and
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

### Scenario 'scanner-batch-ingest'

- Target: ingest 100 scanner batches/s with p95 <= 350 ms
- Mode: 'http'
- Method: 'POST'
- Path: '/api/v1/intake-batches'
- Setup: Prepare independent warm-up and measured device sequence ranges. Every batch has exactly 20 scans; nine batches are new, then one exact idempotent replay of the preceding batch.
- Selector: Round-robin deviceId bytewise while preserving a strictly increasing batchSequence per Device; scanId is deterministic from Device and sequence.
- Request: {deviceId,batchSequence,scans:[{scanId,label,sealCode,scannedAt,facilityId} x20]}; replay uses the original key and body.
- Concurrency: 64
- Warm-up seconds: 10
- Measure seconds: 60
- Success: A new atomic 202 or byte-identical replay counts; exactly 180 new IntakeScans exist per ten requests and partial batches never exist.
- Threshold: At least 100 complete successful batch responses/s for 60 seconds and p95 <= 350 ms; unexpected 5xx = 0.
- Timer: The throughput window starts with the first measured request after warm-up; each latency sample runs from request dispatch through the complete response body.

### Scenario 'custody-timeline-read'

- Target: serve 200 custody timeline reads/s with p95 <= 180 ms
- Mode: 'http'
- Method: 'GET'
- Path: '/api/v1/collected-items/:itemId/timeline'
- Setup: Use all Collected Items with at least one seeded timeline fact; reads do not mutate custody.
- Selector: Round-robin collectedItemId values bytewise.
- Request: No body or query parameters.
- Concurrency: 64
- Warm-up seconds: 10
- Measure seconds: 60
- Success: Only 200 responses with exact item shape and contiguous EvidenceTimelineItem sequence count.
- Threshold: At least 200 successful reads/s for 60 seconds and p95 <= 180 ms; unexpected 5xx = 0.
- Timer: The throughput window starts with the first measured request after warm-up; each latency sample runs from request dispatch through the complete response body.

### Scenario 'verification-recovery'

- Target: verify 10,000 scans within 60 s after worker recovery
- Mode: 'worker'
- Method: 'N/A'
- Path: 'work:EVIDENCE_VERIFICATION'
- Setup: Exactly 10,000 matched IntakeScans have pending verification Work. Hold two workers at worker.claimed, SIGKILL, wait for lease expiry, then start two replacements.
- Selector: Verify in committed Match order and update each Collected Item at most once.
- Request: No measured client request is issued; setup uses only the published seed and public APIs before the worker timer starts.
- Concurrency: 2
- Warm-up seconds: 0
- Measure seconds: 60
- Success: All 10,000 selected items reach VERIFIED exactly once, no Work remains nonterminal, and custody identity remains exclusive.
- Threshold: All 10,000 Work records become terminal in <= 60 seconds after replacement spawn; stale commits and unexpected failures are zero.
- Timer: Start when both replacements spawn and stop only on a snapshot proving the drained Work and every reconciliation invariant.

Fixed performance seed: seedVersion perf-v1 contains exactly 100 cases, 100 caseManifests with 10,000 Collected Items total, 10 facilities, 10 custodians, 100 deviceRegistrations, 10,000 intakeScans, 10,000 CONFIRMED custodyMatches, and 50,000 transfers; every matched scan label and sealCode exactly match its Collected Item expectedLabel and expectedSealCode, and all 10,000 matched scans have pending Verification Tasks.

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

- biometric data
- laboratory analysis
- court filing
- image recognition
- GPS tracking

## Handoff

Keep README and OpenAPI current. Finish with a findings-first review and report architecture, module and
process ownership, public interfaces, success/failure data flow, transaction and lease boundaries,
migrations, compatibility, exact commands run, test and performance results, recovery evidence, known
risks, and every check not run. Do not claim a check that was not actually executed.

## Additional product requirements — required in the same final system




完整系统包含“aliquot split and composite lineage”。
以下业务规则、wire schema、接口和错误全部是公开产品合同。

业务规则：

1. A verified Collected Item may split into 2-20 Aliquots whose integer quantities sum exactly to the parent quantity.
2. One Intake Scan batch may observe all Aliquots
confirmation creates one Custody Match Group atomically.
3. The parent becomes CONSUMED_BY_SPLIT and can no longer transfer custody independently.
4. Each Aliquot has its own seal, verification, custodian, and transfer chain while retaining immutable parent lineage.
5. Reversing an untransferred split restores the parent and removes active child custody atomically
a transferred child makes reversal illegal.
6. Legacy unsplit items keep singular intakeScan and custody fields
split items expose aliquots[] and singular fields are null.
7. Existing items become unsplit roots without changing labels, custody chains, verification, events, or replay bodies.
8. Pending Verification Tasks retain their target and lease state.
9. Existing one-to-one Custody Matches remain valid Match Groups of one with splitId null, their original collectedItemId populated, aliquotId null, and their exact PROPOSED, CONFIRMED, or REVERSED state and timestamps preserved.
10. The versioned seed schema remains exactly V1
Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
11. The only new Domain Event type names are those written literally in the Manager rules or contracts above.
Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
12. Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
13. Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

新增 wire schema：

- Aliquot = {aliquotId:uuid,parentItemId:uuid,quantity:int,sealCode:string,state:EXPECTED|RECEIVED|VERIFIED|QUARANTINED,currentCustodianId:uuid|null,intakeScanId:uuid|null,revision:int}
- ItemSplit = {splitId:uuid,parentItemId:uuid,totalQuantity:int,aliquots:[Aliquot],state:ACTIVE|REVERSED,createdAt:timestamp,reversedAt:timestamp|null}
- ItemSplitDetail = {split:ItemSplit,parent:CollectedItem,parentTimeline:[EvidenceTimelineItem],aliquotTimelines:[{aliquotId:uuid,items:[EvidenceTimelineItem]}]}
aliquotTimelines follows ItemSplit.aliquots order and every items array sorts by sequence
- CustodyMatchGroup = {custodyMatchGroupId:uuid,splitId:uuid|null,state:PROPOSED|CONFIRMED|REVERSED,members:[{collectedItemId:uuid|null,aliquotId:uuid|null,intakeScanId:uuid}],createdAt:timestamp,confirmedAt:timestamp|null,reversedAt:timestamp|null,sequence:int}
exactly one of collectedItemId and aliquotId is non-null.
A split Group has non-null splitId, is created directly as CONFIRMED, contains every active Aliquot once, and sorts by aliquotId
a legacy unsplit Group has splitId null and one member with collectedItemId populated and aliquotId null and preserves its prior state, including PROPOSED with confirmedAt null
- After the Manager change, CollectedItem.state additionally allows CONSUMED_BY_SPLIT
quantity remains immutable and singular currentCustodianId and intakeScanId are null in that state

新增或变更接口：

- POST /api/v1/collected-items/:itemId/splits with {expectedRevision,aliquots:[{aliquotId,quantity,sealCode}]} requires the positive safe-integer quantities to sum exactly to the stored CollectedItem.quantity, atomically changes the parent to CONSUMED_BY_SPLIT, and returns ItemSplit
- POST /api/v1/item-splits/:splitId/reverse with {reason} restores the parent only when no Aliquot has a Custody Transfer
- GET /api/v1/item-splits/:splitId returns the exact ItemSplitDetail with the parent timeline and one ordered timeline for each Aliquot
- POST /api/v1/custody-match-groups with {splitId,members:[{aliquotId,intakeScanId}]} requires every active Aliquot of the split exactly once and distinct current Intake Scans, confirms every pair atomically, and returns 201 CustodyMatchGroup
GET /api/v1/custody-match-groups/:custodyMatchGroupId returns the exact group shape

新增稳定错误：

- 409 ALIQUOT_QUANTITY_MISMATCH: Aliquot positive integer quantities do not sum to parent quantity
- 409 SPLIT_NOT_REVERSIBLE: an Aliquot has transferred custody or split is not ACTIVE
- 409 CUSTODY_MATCH_GROUP_CONFLICT: any Aliquot or Intake Scan is stale or already matched

FINAL snapshot 与性能兼容合同：

The FINAL verification snapshot 'resources' object has exactly the union of these V1 and Manager resource specifications, with no other keys:

- 'cases' uses exact shape 'Case = {caseId:uuid,caseNumber:string}' and sorts ascending by scalar field-path tuple 'caseId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'caseManifests' uses exact shape 'CaseManifest = {caseId:uuid,version:int,items:[{collectedItemId:uuid,expectedLabel:string,expectedSealCode:string,quantity:int}]}' and sorts ascending by scalar field-path tuple 'caseId', 'version', then by RFC 8785 canonical JSON as the tie-breaker.
- 'facilities' uses exact shape 'Facility = {facilityId:uuid,name:string,receivingCustodianId:uuid}' and sorts ascending by scalar field-path tuple 'facilityId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'custodians' uses exact shape 'Custodian = {custodianId:uuid,name:string}' and sorts ascending by scalar field-path tuple 'custodianId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'deviceRegistrations' uses exact shape 'DeviceRegistration = {deviceId:uuid,facilityId:uuid,lastBatchSequence:int}' and sorts ascending by scalar field-path tuple 'deviceId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'intakeScans' uses exact shape 'IntakeScan' and sorts ascending by scalar field-path tuple 'intakeScanId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'collectedItems' uses exact shape 'CollectedItem' and sorts ascending by scalar field-path tuple 'collectedItemId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'custodyMatches' uses exact shape 'CustodyMatch' and sorts ascending by scalar field-path tuple 'matchId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'custodyTransfers' uses exact shape 'CustodyTransfer' and sorts ascending by scalar field-path tuple 'transferId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'itemSplits' uses exact shape 'ItemSplit' and sorts ascending by scalar field-path tuple 'splitId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'aliquots' uses exact shape 'Aliquot' and sorts ascending by scalar field-path tuple 'aliquotId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'custodyMatchGroups' uses exact shape 'CustodyMatchGroup' and sorts ascending by scalar field-path tuple 'custodyMatchGroupId', then by RFC 8785 canonical JSON as the tie-breaker.

The Manager-added resource specifications are exactly:

- 'itemSplits' uses exact shape 'ItemSplit' and sorts ascending by scalar field-path tuple 'splitId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'aliquots' uses exact shape 'Aliquot' and sorts ascending by scalar field-path tuple 'aliquotId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'custodyMatchGroups' uses exact shape 'CustodyMatchGroup' and sorts ascending by scalar field-path tuple 'custodyMatchGroupId', then by RFC 8785 canonical JSON as the tie-breaker.

The FINAL Work kind enum is exactly the union 'EVIDENCE_VERIFICATION'.
The Manager-added Work kinds are exactly (none).
All V1 snapshot point-in-time, recursive '*Token' omission, sorting, Work state/lease/retention/drain, and Domain Event rules remain mandatory.
The FINAL binary reruns exactly these three V1-compatible scenarios:

- 'scanner-batch-ingest': ingest 100 scanner batches/s with p95 <= 350 ms
threshold: At least 100 complete successful batch responses/s for 60 seconds and p95 <= 350 ms
unexpected 5xx = 0.
- 'custody-timeline-read': serve 200 custody timeline reads/s with p95 <= 180 ms
threshold: At least 200 successful reads/s for 60 seconds and p95 <= 180 ms
unexpected 5xx = 0.
- 'verification-recovery': verify 10,000 scans within 60 s after worker recovery
threshold: All 10,000 Work records become terminal in <= 60 seconds after replacement spawn
stale commits and unexpected failures are zero.

Their published setup, selector, request, concurrency, warm-up, measurement, timer, success condition, and threshold remain unchanged.
This Manager change adds correctness, concurrency, and recovery assertions only
it does not replace or relax a performance scenario.



