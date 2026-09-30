# ConfigRelay — Complete system requirements

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

# ConfigRelay

Build ConfigRelay from this intentionally blank repository. This README is the complete product
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
| 'npm run start:worker' | Start one Delivery Task worker. |
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
| 'DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/configrelay' | Production/development authority. |
| 'TEST_DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/configrelay_test' | Required by all stateful tests. |
| 'PORT' | '3000' | Integer 1-65535; API and production UI origin. |
| 'ADMIN_TOKEN' | task-local value | Required only for documented admin mutation routes; never log it. |
| 'WEBHOOK_URL' | 'http://127.0.0.1:4010/events' | HTTP endpoint for Domain Event delivery. |
| 'WORK_LEASE_SECONDS' | '3' | Integer 1-60; persisted lease duration used by workers and recovery tests. |
| 'CHROMIUM_PATH' | '/usr/bin/chromium' | Browser executable for project-owned E2E. |
| 'MANAGED_DATA_ROOT' | '/tmp/configrelay-data' | Writable root for staged or generated bytes; never serve a path directly. |
| 'TEST_BARRIER_URL' | empty | Optional localhost HTTP receiver used only by controlled recovery tests. |
| 'TEST_BARRIER_TOKEN' | empty | Required barrier header value when the URL is set; never log it. |

Bind only to '127.0.0.1'. Logs must not contain tokens, idempotency keys, raw seed input, webhook
bodies, or private absolute paths.

## Domain and V1 behavior

| Term | Canonical definition | Avoid |
| --- | --- | --- |
| Agent | A registered endpoint with a durable appliedRevision and monotonically increasing commandSequence. | Client, node |
| Configuration | Canonical versioned JSON content owned by one Fleet. | Settings, payload |
| Deployment | The request to make one Configuration revision desired for selected Agents. | Rollout, publish |
| Assignment | One Agent's durable desired revision and delivery state. | Job, mapping |
| Delivery Task | Leased work delivering one Assignment with stable deliveryId and body. | Message, retry |
| Acknowledgement | An Agent report accepting or rejecting one exact revision and fencing token. | Heartbeat, response |

Deployment: PENDING -> DELIVERING -> APPLIED | FAILED | CANCELLED; Agent assignment: WAITING -> SENT -> ACKED | SUPERSEDED.

1. Publish immutable Configuration revisions and create Deployments for a deterministic Agent selector snapshot.
2. Deliver Assignments at least once in increasing command sequence and nondecreasing V1 revision order per Agent.
3. Accept acknowledgements only for the current assignment token and preserve duplicate replay.
4. Recover delivery after dispatcher death and reconcile Agents that reconnect with stale applied revisions.
5. Expose fleet drift, assignment progress, failures, per-Agent history, and audit events in the UI.

### Deterministic policy

1. Configuration content is any RFC 8785 JSON value <=1 MiB and revision is contiguous per Fleet. Agent labels and selector keys match [a-z][a-z0-9_.-]{0,63}; selector is AND over exact case-sensitive equality.
2. Target Agents are those matching at the Deployment transaction and sort by agentId; targetDigest is SHA-256 of their newline-joined IDs and never changes after creation.
3. Deployment creation assigns each target Agent its next positive commandSequence in commit order. Poll returns only the lowest non-terminal sequence and repeats the same deliveryId, body, and token until a valid Acknowledgement.
4. Acknowledgement must match Agent, Deployment, commandSequence, revision, digest, and current token. Normal V1 delivery never sends a revision lower than appliedRevision; reconnect reconciliation resumes the current greater desired revision.

## Mandatory invariants

1. For each Agent, the first accepted acknowledgement for a commandSequence is exactly the prior accepted sequence plus one and matches the current assignmentToken; an identical replay has no second effect, and no stale token or sequence can change desired or applied state.
2. One Deployment captures an immutable selector result and Configuration digest.
3. A stale assignment token cannot change current desired or applied state.
4. Every successful acknowledgement matches the exact delivered revision digest.
5. Repeated delivery preserves deliveryId, semantic body, and per-Agent command order.

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

- Agent = {agentId:uuid,fleetId:uuid,labels:{key:string},appliedRevision:int,appliedDigest:sha256|null,desiredRevision:int|null,desiredDigest:sha256|null,drift:boolean,lastCommandSequence:int,lastSeenAt:timestamp}
- Configuration = {fleetId:uuid,revision:int,content:json,canonicalDigest:sha256,createdAt:timestamp}
- Deployment = {deploymentId:uuid,fleetId:uuid,configurationRevision:int,selector:{labels:{key:string,value:string}},targetCount:int,targetDigest:sha256,state:PENDING|DELIVERING|APPLIED|FAILED|CANCELLED,createdAt:timestamp,completedAt:timestamp|null,sequence:int}
- Assignment = {assignmentId:uuid,deploymentId:uuid,agentId:uuid,commandSequence:int,revision:int,digest:sha256,state:WAITING|SENT|ACKED|FAILED|SUPERSEDED,deliveryId:uuid,assignmentToken:string,sentAt:timestamp|null,ackedAt:timestamp|null}
- Acknowledgement = {agentId:uuid,deploymentId:uuid,commandSequence:int,revision:int,digest:sha256,assignmentToken:string,outcome:APPLIED|REJECTED,reportedAt:timestamp}
- AgentPollResponse = {status:COMMAND|NO_CHANGE,command:Assignment|null}; command is null exactly when status is NO_CHANGE

The public aggregate routes are:

- 'GET /api/v1/deployments?limit&cursor' and
  'GET /api/v1/deployments/:deploymentId'.
- POST /api/v1/deployments with {fleetId,configurationRevision,selector,expectedFleetRevision}; return 202 with immutable targetCount and targetDigest.
- POST /api/v1/fleets/:fleetId/configurations with {content,expectedFleetRevision} creates exactly the next immutable Configuration and returns 201 with its RFC 8785 canonicalDigest.
- POST /api/v1/agents/:agentId/poll with {appliedRevision} returns AgentPollResponse with the current ordered Assignment or exact {status:NO_CHANGE,command:null}.
- POST /api/v1/agents/:agentId/acknowledgements with {deploymentId,commandSequence,revision,digest,assignmentToken,outcome} rejects stale tokens or sequences.
- POST /api/v1/deployments/:deploymentId/cancel with {reason} supersedes only unacknowledged Assignments.
- GET /api/v1/agents/:agentId returns the exact Agent shape and GET /api/v1/agents/:agentId/assignments returns exact Assignment history.
- 'GET /api/v1/domain-events?aggregateId&afterSequence&limit' returns committed events in sequence.
- 'GET /api/v1/verification-snapshot' requires 'Authorization: Bearer <ADMIN_TOKEN>' and returns one
  serializable snapshot '{asOf:timestamp,resources:{...},work:[Work],events:[DomainEvent]}'.

### V1 verification snapshot

The complete snapshot is read from one PostgreSQL point-in-time; 'asOf', every resource array, 'work',
and 'events' must describe that same database snapshot. The V1 'resources' object has exactly these keys
and no others:

- 'agents' uses exact shape 'Agent' and sorts ascending by scalar field-path tuple 'agentId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'configurations' uses exact shape 'Configuration' and sorts ascending by scalar field-path tuple 'fleetId', 'revision', then by RFC 8785 canonical JSON as the tie-breaker.
- 'deployments' uses exact shape 'Deployment' and sorts ascending by scalar field-path tuple 'deploymentId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'assignments' uses exact shape 'Assignment' and sorts ascending by scalar field-path tuple 'assignmentId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'acknowledgements' uses exact shape 'Acknowledgement' and sorts ascending by scalar field-path tuple 'agentId', 'deploymentId', 'commandSequence', then by RFC 8785 canonical JSON as the tie-breaker.

Each resource array contains every current or immutable instance named by its declared shape exactly
once. Each listed sort path resolves to a scalar. Scalar order is null first, then false before true,
integers numerically, and every other string-form scalar by UTF-8 bytes. Sort ascending by the complete
tuple, then use RFC 8785 canonical JSON only as the tie-breaker.
Recursively omit every object field whose name ends in 'Token', at every nesting depth.

'Work' is exactly
'{workId:uuid,kind:ASSIGNMENT_DELIVERY,aggregateId:uuid,state:PENDING|LEASED|SUCCEEDED|FAILED|CANCELLED,terminal:boolean,attempt:int,leaseOwner:string|null,leaseExpiresAt:timestamp|null}'.
'kind' is one of exactly 'ASSIGNMENT_DELIVERY'. Both lease fields are non-null exactly
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
| 409 | FLEET_REVISION_CHANGED | expectedFleetRevision is stale |
| 409 | STALE_ASSIGNMENT_TOKEN | Acknowledgement token is no longer current |
| 409 | ACKNOWLEDGEMENT_CONFLICT | same assignment has another semantic outcome |
| 409 | DEPLOYMENT_NOT_CANCELLABLE | Deployment is terminal |
| 400 | INVALID_AGENT_SELECTOR | label selector key, value, or cardinality is invalid |

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

'{schemaVersion:1,seedVersion,fleets,agents,configurations,deployments,assignments}; revisions and command sequences are contiguous per authority, canonical digests match content, and Agent capabilities use declared keys only.'

Member schemas are exact:

- fleets[] = {fleetId:uuid,name:string,currentRevision:int}; agents[] = {agentId:uuid,fleetId:uuid,labels:object,appliedRevision:int,appliedDigest:sha256|null,lastCommandSequence:int,lastSeenAt:timestamp}
- configurations[] use the exact Configuration schema with contiguous revisions and verified canonicalDigest
- deployments[] and assignments[] use exact wire schemas; target membership, digest, desired/applied revisions, and terminal counts must reconcile

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
`deployment.created`, `assignment.sent`, `assignment.acknowledged`, `assignment.failed`, `deployment.completed`, `deployment.cancelled`. 'payload' is exactly '{}' for every V1 event; a later Manager event also uses '{}' unless
its published contract literally supplies another payload shape. A rollback creates no event. Sequence
is contiguous per aggregate.

The dispatcher sends JSON with 'X-ConfigRelay-Event-Id' and 'X-ConfigRelay-Event-Type'. Network errors,
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
performing every public user action, observing asynchronous Delivery Task progress, browsing event and
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

### Scenario 'agent-poll'

- Target: serve 2,000 Agent polls/s with p95 <= 80 ms
- Mode: 'http'
- Method: 'POST'
- Path: '/api/v1/agents/:agentId/poll'
- Setup: Use 50,000 Agents with one current WAITING Assignment and 50,000 without a newer Assignment; the scenario does not acknowledge commands.
- Selector: Alternate COMMAND-eligible and NO_CHANGE Agent IDs, each subgroup bytewise round-robin.
- Request: {appliedRevision} equal to the seeded Agent value; COMMAND Agents submit last known applied revision and NO_CHANGE Agents are current.
- Concurrency: 64
- Warm-up seconds: 10
- Measure seconds: 60
- Success: Only 200 exact AgentPollResponse bodies count; the measured mix is exactly 50% COMMAND and 50% NO_CHANGE over each complete 100-request block.
- Threshold: At least 2,000 successful polls/s for 60 seconds and p95 <= 80 ms; token mix-up and unexpected 5xx = 0.
- Timer: The throughput window starts with the first measured request after warm-up; each latency sample runs from request dispatch through the complete response body.

### Scenario 'acknowledgement-ingest'

- Target: ingest 1,000 acknowledgements/s with p95 <= 180 ms
- Mode: 'http'
- Method: 'POST'
- Path: '/api/v1/agents/:agentId/acknowledgements'
- Setup: Poll 35,000 disjoint current Assignments before timing to obtain their exact tokens. Reserve 5,000 for warm-up and 30,000 for measurement.
- Selector: Repeat two-request pairs: one new acknowledgement then one exact idempotent replay. Among unique requests, 90% outcome APPLIED and 10% REJECTED.
- Request: {deploymentId,commandSequence,revision,digest,assignmentToken,outcome}; each replay reuses the original key and byte-identical body.
- Concurrency: 64
- Warm-up seconds: 10
- Measure seconds: 60
- Success: A first stored acknowledgement or exact replay counts; stale token/sequence responses do not count and each unique Assignment changes state once.
- Threshold: At least 1,000 successful responses/s for 60 seconds and p95 <= 180 ms with the exact 45% APPLIED, 5% REJECTED, 50% replay request mix.
- Timer: The throughput window starts with the first measured request after warm-up; each latency sample runs from request dispatch through the complete response body.

### Scenario 'assignment-delivery-recovery'

- Target: recover and deliver 50,000 pending Assignments within 120 s
- Mode: 'worker'
- Method: 'N/A'
- Path: 'work:ASSIGNMENT_DELIVERY'
- Setup: Exactly 50,000 WAITING Assignments on distinct Agents have pending delivery Work. Hold two workers at worker.claimed, SIGKILL, wait for lease expiry, then start two replacements.
- Selector: Deliver by deployment createdAt,deploymentId,agentId and preserve each commandSequence plus deliveryId across retry.
- Request: No measured client request is issued; setup uses only the published seed and public APIs before the worker timer starts.
- Concurrency: 2
- Warm-up seconds: 0
- Measure seconds: 120
- Success: Every selected Assignment reaches SENT with its stable delivery identity, no ASSIGNMENT_DELIVERY Work remains nonterminal, and Agent desired state plus Deployment counts reconcile; ACKED is not required.
- Threshold: All 50,000 Assignments reach SENT in <= 120 seconds after replacement spawn; stale commits and unexpected failures are zero.
- Timer: Start when both replacements spawn and stop on a point-in-time snapshot proving SENT state, drained Work, and all counters.

Fixed performance seed: seedVersion perf-v1 contains exactly 100 fleets, 100,000 agents, 1,000 configurations, 500 deployments, and 50,000 WAITING assignments, with one current Assignment on each of 50,000 distinct Agents.

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

- configuration schema design
- agent software update
- multi-region replication
- secret distribution
- peer-to-peer delivery

## Handoff

Keep README and OpenAPI current. Finish with a findings-first review and report architecture, module and
process ownership, public interfaces, success/failure data flow, transaction and lease boundaries,
migrations, compatibility, exact commands run, test and performance results, recovery evidence, known
risks, and every check not run. Do not claim a check that was not actually executed.

## Additional product requirements — required in the same final system




完整系统包含“staged cohort rollout with automatic rollback”。
以下业务规则、wire schema、接口和错误全部是公开产品合同。

业务规则：

1. A Deployment contains ordered Cohorts selected from one immutable target snapshot and starts only the first Cohort.
2. Each Cohort declares minimum success basis points, maximum failure basis points, and an observation deadline.
Both thresholds are integers 0..10000 and the denominator is immutable targetCount.
Before the deadline, success and failure count APPLIED and REJECTED acknowledgements
at the deadline, success still counts APPLIED and failure is targetCount minus successCount, so every missing acknowledgement is a failure.
3. Evaluate once when every target has acknowledged or when observationDeadlineAt is reached: the Cohort succeeds exactly when floor(successCount*10000/targetCount) >= minimumSuccessBasisPoints and floor(failureCount*10000/targetCount) <= maximumFailureBasisPoints
otherwise it fails. targetCount zero is invalid, and simultaneous acknowledgements or deadline workers produce one durable transition.
4. A failed Cohort supersedes every still-pending APPLY command and starts one automatic Rollback for exactly the captured Agents in this and earlier Cohorts whose APPLY acknowledgement changed them to the Deployment revision.
5. Rollback delivery uses new stable identities and a strictly increasing commandSequence
it may apply each affected Agent's captured lower prior revision and completes only after every captured rollback command is terminal.
6. Legacy all-at-once Deployments behave as one Cohort and keep existing response fields
staged Deployments expose cohorts[] and rollback.

8. In-flight Delivery Tasks continue with identical delivery IDs and bodies.

10. The versioned seed schema remains exactly V1
Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
11. The only new Domain Event type names are those written literally in the Manager rules or contracts above.
Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
12. Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
13. Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

新增 wire schema：

- DeploymentCohort = {cohortId:uuid,deploymentId:uuid,ordinal:int,name:string,selector:{labels:{key:string,value:string}},targetCount:int,targetDigest:sha256,minimumSuccessBasisPoints:int,maximumFailureBasisPoints:int,observationSeconds:int,successCount:int,failureCount:int,pendingCount:int,state:WAITING|DELIVERING|OBSERVING|SUCCEEDED|FAILED|ROLLED_BACK,startedAt:timestamp|null,observationDeadlineAt:timestamp|null,completedAt:timestamp|null}
counts are non-negative and sum to targetCount, and deadline evaluation moves every missing acknowledgement from pendingCount to failureCount
- RolloutCommand = {commandId:uuid,deploymentId:uuid,cohortId:uuid,agentId:uuid,commandSequence:int,kind:APPLY|ROLLBACK,fromRevision:int,toRevision:int,toDigest:sha256,deliveryId:uuid,assignmentToken:string,state:WAITING|SENT|ACKED|FAILED|SUPERSEDED,createdAt:timestamp,ackedAt:timestamp|null}
- DeploymentRollback = {rollbackId:uuid,deploymentId:uuid,failedCohortId:uuid,state:PENDING|DELIVERING|COMPLETED|FAILED,commandCount:int,completedCount:int,startedAt:timestamp,completedAt:timestamp|null}
commandCount is the immutable affected-Agent count
- For staged Deployments, AgentPollResponse.command additionally permits RolloutCommand
status and nullability rules are unchanged
- Under the Manager schema a staged Deployment adds cohorts:[DeploymentCohort] and rollback:DeploymentRollback|null
cohorts sort by ordinal and rollback is null until a failed Cohort atomically creates it.
A legacy all-at-once Deployment retains its exact V1 Deployment shape and omits both Manager-only fields

新增或变更接口：

- POST /api/v1/deployments accepts optional cohorts:[{name,selector,minimumSuccessBasisPoints,maximumFailureBasisPoints,observationSeconds}].
A staged plan contains 1..20 Cohorts
each threshold is an integer 0..10000, observationSeconds is an integer 1..86400, and every Cohort has at least one target.
Against the captured outer target set, every Agent must match exactly one Cohort
membership, order, prior revision, and digests commit atomically.
- GET /api/v1/deployments/:deploymentId returns the extended Deployment with cohorts[] in ordinal order and rollback:null|DeploymentRollback only for a staged Deployment
a legacy all-at-once Deployment returns the exact V1 Deployment shape with no cohorts or rollback fields.
- POST /api/v1/agents/:agentId/poll accepts optional lastCommandSequence and returns at most the next RolloutCommand.
APPLY and ROLLBACK share one strictly increasing per-Agent commandSequence and retries preserve commandId, deliveryId, body, and assignmentToken.
- POST /api/v1/agents/:agentId/acknowledgements includes commandSequence for staged Deployments
only the current token at the next sequence can change state, while an identical replay returns its original result.
- The transaction that fails a Cohort freezes the affected-Agent set from successful APPLY acknowledgements, supersedes all other pending APPLY commands, creates exactly one ROLLBACK command per affected Agent, and never adds a later Agent to that Rollback.

新增稳定错误：

- 400 INVALID_COHORT_PLAN: cohort count, order, thresholds, observation duration, name, or selector is invalid
- 409 COHORT_TARGET_PARTITION_INVALID: a captured target Agent matches zero or multiple Cohorts
- 409 AGENT_COMMAND_SEQUENCE_CONFLICT: the command or acknowledgement is not the current next per-Agent sequence

FINAL snapshot 与性能兼容合同：

The FINAL verification snapshot 'resources' object has exactly the union of these V1 and Manager resource specifications, with no other keys:

- 'agents' uses exact shape 'Agent' and sorts ascending by scalar field-path tuple 'agentId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'configurations' uses exact shape 'Configuration' and sorts ascending by scalar field-path tuple 'fleetId', 'revision', then by RFC 8785 canonical JSON as the tie-breaker.
- 'deployments' uses exact shape 'Deployment' and sorts ascending by scalar field-path tuple 'deploymentId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'assignments' uses exact shape 'Assignment' and sorts ascending by scalar field-path tuple 'assignmentId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'acknowledgements' uses exact shape 'Acknowledgement' and sorts ascending by scalar field-path tuple 'agentId', 'deploymentId', 'commandSequence', then by RFC 8785 canonical JSON as the tie-breaker.
- 'deploymentCohorts' uses exact shape 'DeploymentCohort' and sorts ascending by scalar field-path tuple 'deploymentId', 'ordinal', 'cohortId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'rolloutCommands' uses exact shape 'RolloutCommand' and sorts ascending by scalar field-path tuple 'deploymentId', 'agentId', 'commandSequence', then by RFC 8785 canonical JSON as the tie-breaker.
- 'deploymentRollbacks' uses exact shape 'DeploymentRollback' and sorts ascending by scalar field-path tuple 'deploymentId', then by RFC 8785 canonical JSON as the tie-breaker.

The Manager-added resource specifications are exactly:

- 'deploymentCohorts' uses exact shape 'DeploymentCohort' and sorts ascending by scalar field-path tuple 'deploymentId', 'ordinal', 'cohortId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'rolloutCommands' uses exact shape 'RolloutCommand' and sorts ascending by scalar field-path tuple 'deploymentId', 'agentId', 'commandSequence', then by RFC 8785 canonical JSON as the tie-breaker.
- 'deploymentRollbacks' uses exact shape 'DeploymentRollback' and sorts ascending by scalar field-path tuple 'deploymentId', then by RFC 8785 canonical JSON as the tie-breaker.

The FINAL Work kind enum is exactly the union 'ASSIGNMENT_DELIVERY', 'COHORT_DEADLINE', 'ROLLBACK_DELIVERY'.
The Manager-added Work kinds are exactly 'COHORT_DEADLINE', 'ROLLBACK_DELIVERY'.
All V1 snapshot point-in-time, recursive '*Token' omission, sorting, Work state/lease/retention/drain, and Domain Event rules remain mandatory.
The FINAL binary reruns exactly these three V1-compatible scenarios:

- 'agent-poll': serve 2,000 Agent polls/s with p95 <= 80 ms
threshold: At least 2,000 successful polls/s for 60 seconds and p95 <= 80 ms
token mix-up and unexpected 5xx = 0.
- 'acknowledgement-ingest': ingest 1,000 acknowledgements/s with p95 <= 180 ms
threshold: At least 1,000 successful responses/s for 60 seconds and p95 <= 180 ms with the exact 45% APPLIED, 5% REJECTED, 50% replay request mix.
- 'assignment-delivery-recovery': recover and deliver 50,000 pending Assignments within 120 s
threshold: All 50,000 Assignments reach SENT in <= 120 seconds after replacement spawn
stale commits and unexpected failures are zero.

Their published setup, selector, request, concurrency, warm-up, measurement, timer, success condition, and threshold remain unchanged.
This Manager change adds correctness, concurrency, and recovery assertions only
it does not replace or relax a performance scenario.



