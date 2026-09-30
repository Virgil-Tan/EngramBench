# LedgerBridge — Complete system requirements

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

# LedgerBridge

Build LedgerBridge from this intentionally blank repository. This README is the complete product
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
| 'npm run start:worker' | Start one Settlement Task worker. |
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
| 'DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/ledgerbridge' | Production/development authority. |
| 'TEST_DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/ledgerbridge_test' | Required by all stateful tests. |
| 'PORT' | '3000' | Integer 1-65535; API and production UI origin. |
| 'ADMIN_TOKEN' | task-local value | Required only for documented admin mutation routes; never log it. |
| 'WEBHOOK_URL' | 'http://127.0.0.1:4010/events' | HTTP endpoint for Domain Event delivery. |
| 'WORK_LEASE_SECONDS' | '3' | Integer 1-60; persisted lease duration used by workers and recovery tests. |
| 'CHROMIUM_PATH' | '/usr/bin/chromium' | Browser executable for project-owned E2E. |
| 'MANAGED_DATA_ROOT' | '/tmp/ledgerbridge-data' | Writable root for staged or generated bytes; never serve a path directly. |
| 'TEST_BARRIER_URL' | empty | Optional localhost HTTP receiver used only by controlled recovery tests. |
| 'TEST_BARRIER_TOKEN' | empty | Required barrier header value when the URL is set; never log it. |

Bind only to '127.0.0.1'. Logs must not contain tokens, idempotency keys, raw seed input, webhook
bodies, or private absolute paths.

## Domain and V1 behavior

| Term | Canonical definition | Avoid |
| --- | --- | --- |
| Account | A balance owner identified by a stable accountId and one integer minor-unit currency. | Wallet, purse |
| Transfer | One requested movement between two distinct Accounts. | Payment, transaction |
| Posting | The immutable balanced debit and credit pair for a Transfer. | Balance update |
| Settlement Task | Durable leased work that finalizes a pending Transfer. | Job, queue item |
| Reversal | A compensating Posting linked to exactly one posted Transfer. | Delete, refund |
| Domain Event | A versioned fact committed with aggregate state and sequence. | Message, log |

Transfer: PENDING -> POSTED | CANCELLED; POSTED -> REVERSED. CANCELLED and REVERSED are terminal.

1. Create a Transfer from one Account to another using integer minor units and one currency.
2. Reserve available source funds atomically and let leased workers post the balanced debit and credit.
3. Allow cancellation only while pending and reversal only after posting; competing terminal actions have one winner.
4. Expose account statements, transfer history, event history, and a real API-backed operations UI.
5. Deliver Domain Events through an at-least-once webhook dispatcher with stable identity and per-Transfer order.

### Deterministic policy

1. currency is exactly three uppercase ASCII letters; amountMinor is an integer from 1 through 9007199254740991; source and destination must differ and both Accounts must use that currency.
2. availableMinor equals balanceMinor minus reservedMinor. Creation increments source reservedMinor only; posting decrements source balance and reservation and increments destination balance in one transaction.
3. Settlement Tasks claim PENDING Transfers by createdAt then transferId. Cancellation wins only before posting; reversal creates the opposite balanced Posting and changes balances exactly once.
4. Statements sort by createdAt ascending then postingId ascending; cursor encodes both values and balanceAfterMinor is the committed balance after that leg.

## Mandatory invariants

1. For every currency, the sum of Account balanceMinor values is conserved; reservations never participate in that sum.
2. Every posted Transfer has exactly two Posting legs whose signed amounts sum to zero.
3. For each Account, reservedMinor equals the sum of amountMinor for its outgoing PENDING Transfers, availableMinor equals balanceMinor minus reservedMinor, and none of those values is negative.
4. A Transfer has at most one successful Posting and at most one Reversal.
5. A committed state transition has exactly one Domain Event; a rolled-back transition has none.

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

- Account = {accountId:uuid,currency:currency,openingBalanceMinor:int,balanceMinor:int,reservedMinor:int,availableMinor:int,revision:int}
- Transfer = {transferId:uuid,sourceAccountId:uuid,destinationAccountId:uuid,currency:currency,amountMinor:int,state:PENDING|POSTED|CANCELLED|REVERSED,postingId:uuid|null,reversalPostingId:uuid|null,createdAt:timestamp,postedAt:timestamp|null,cancelledAt:timestamp|null,reversedAt:timestamp|null,sequence:int}
- Posting = {postingId:uuid,transferId:uuid,kind:TRANSFER|REVERSAL,legs:[{accountId:uuid,direction:DEBIT|CREDIT,amountMinor:int}],createdAt:timestamp}; legs contain exactly one DEBIT then one CREDIT
- StatementPage = {items:[{postingId:uuid,transferId:uuid,kind:TRANSFER|REVERSAL,direction:DEBIT|CREDIT,amountMinor:int,balanceAfterMinor:int,createdAt:timestamp}],nextCursor:string|null}

The public aggregate routes are:

- 'GET /api/v1/transfers?limit&cursor' and
  'GET /api/v1/transfers/:transferId'.
- POST /api/v1/transfers with {sourceAccountId,destinationAccountId,currency,amountMinor}; return 202 with the complete Transfer and required Idempotency-Key replay semantics.
- POST /api/v1/transfers/:transferId/cancel with {} returns the winning terminal result or 409 TRANSFER_NOT_CANCELLABLE.
- POST /api/v1/transfers/:transferId/reverse with {reason} returns 202 or 409 TRANSFER_NOT_REVERSIBLE.
- GET /api/v1/accounts/:accountId/statement?limit&cursor returns ordered Posting legs and a stable cursor.
- GET /api/v1/accounts/:accountId returns the exact Account wire shape used to recompute conservation.
- 'GET /api/v1/domain-events?aggregateId&afterSequence&limit' returns committed events in sequence.
- 'GET /api/v1/verification-snapshot' requires 'Authorization: Bearer <ADMIN_TOKEN>' and returns one
  serializable snapshot '{asOf:timestamp,resources:{...},work:[Work],events:[DomainEvent]}'.

### V1 verification snapshot

The complete snapshot is read from one PostgreSQL point-in-time; 'asOf', every resource array, 'work',
and 'events' must describe that same database snapshot. The V1 'resources' object has exactly these keys
and no others:

- 'accounts' uses exact shape 'Account' and sorts ascending by scalar field-path tuple 'accountId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'transfers' uses exact shape 'Transfer' and sorts ascending by scalar field-path tuple 'transferId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'postings' uses exact shape 'Posting' and sorts ascending by scalar field-path tuple 'postingId', then by RFC 8785 canonical JSON as the tie-breaker.

Each resource array contains every current or immutable instance named by its declared shape exactly
once. Each listed sort path resolves to a scalar. Scalar order is null first, then false before true,
integers numerically, and every other string-form scalar by UTF-8 bytes. Sort ascending by the complete
tuple, then use RFC 8785 canonical JSON only as the tie-breaker.
Recursively omit every object field whose name ends in 'Token', at every nesting depth.

'Work' is exactly
'{workId:uuid,kind:SETTLEMENT,aggregateId:uuid,state:PENDING|LEASED|SUCCEEDED|FAILED|CANCELLED,terminal:boolean,attempt:int,leaseOwner:string|null,leaseExpiresAt:timestamp|null}'.
'kind' is one of exactly 'SETTLEMENT'. Both lease fields are non-null exactly
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
| 409 | INSUFFICIENT_FUNDS | source availableMinor is less than amountMinor |
| 409 | ACCOUNT_CURRENCY_MISMATCH | either Account has another currency |
| 409 | TRANSFER_NOT_CANCELLABLE | Transfer is not PENDING |
| 409 | TRANSFER_NOT_REVERSIBLE | Transfer is not POSTED |
| 400 | INVALID_AMOUNT | amountMinor is outside the published integer range |

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

'{schemaVersion:1,seedVersion,accounts,transfers}; account IDs are unique, balances are non-negative integers, and currencies use three uppercase letters.'

Member schemas are exact:

- accounts[] = {accountId:uuid,currency:currency,openingBalanceMinor:int}; openingBalanceMinor is 0..9007199254740991
- transfers[] = {transferId:uuid,sourceAccountId:uuid,destinationAccountId:uuid,currency:currency,amountMinor:int,state:PENDING|POSTED|CANCELLED,createdAt:timestamp,terminalAt:timestamp|null}
- For seeded POSTED Transfers, postings are derived deterministically from transferId and totals must reconcile with every Account opening balance; CANCELLED Transfers have no Posting.

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
`transfer.created`, `transfer.posted`, `transfer.cancelled`, `transfer.reversed`. 'payload' is exactly '{}' for every V1 event; a later Manager event also uses '{}' unless
its published contract literally supplies another payload shape. A rollback creates no event. Sequence
is contiguous per aggregate.

The dispatcher sends JSON with 'X-LedgerBridge-Event-Id' and 'X-LedgerBridge-Event-Type'. Network errors,
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
performing every public user action, observing asynchronous Settlement Task progress, browsing event and
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

### Scenario 'statement-read'

- Target: 150 statement reads/s with p95 <= 150 ms
- Mode: 'http'
- Method: 'GET'
- Path: '/api/v1/accounts/:accountId/statement?limit=50'
- Setup: Use the unchanged perf-v1 seed; reads do not consume data.
- Selector: Choose accountId round-robin from all accounts in verification-snapshot bytewise UUID order; omit cursor on every request.
- Request: No body. Require Authorization only if the public route normally requires it.
- Concurrency: 64
- Warm-up seconds: 10
- Measure seconds: 60
- Success: Only complete 200 StatementPage responses count; every page must have valid order, cursor, leg amounts, and balanceAfterMinor.
- Threshold: At least 150 successful responses/s for 60 seconds and successful-response p95 <= 150 ms; unexpected 5xx = 0.
- Timer: The throughput window starts with the first measured request after warm-up; each latency sample runs from request dispatch through the complete response body.

### Scenario 'transfer-mutation-mix'

- Target: 40 transfer mutations/s with p95 <= 500 ms
- Mode: 'http'
- Method: 'POST'
- Path: '/api/v1/transfers; /api/v1/transfers/:transferId/cancel; /api/v1/transfers/:transferId/reverse'
- Setup: Reserve disjoint warm-up and measured pools of funded same-currency Account pairs, PENDING Transfers, and POSTED Transfers from bytewise-sorted seed IDs.
- Selector: Repeat CREATE, CREATE, CANCEL, REVERSE. Each CANCEL or REVERSE ID is used once; each CREATE uses the next Account pair, amountMinor 1, and a fresh key.
- Request: CREATE uses {sourceAccountId,destinationAccountId,currency,amountMinor:1}; CANCEL uses {}; REVERSE uses {reason:"perf"}. Warm-up and measured IDs never overlap.
- Concurrency: 64
- Warm-up seconds: 10
- Measure seconds: 60
- Success: Only the published 2xx terminal response for each scheduled operation counts; no expected conflict is part of the success numerator.
- Threshold: At least 40 successful mutations/s for 60 seconds and successful-response p95 <= 500 ms; all balances, reservations, postings, and events reconcile afterward.
- Timer: The throughput window starts with the first measured request after warm-up; each latency sample runs from request dispatch through the complete response body.

### Scenario 'settlement-recovery'

- Target: drain 2,000 Settlement Tasks within 45 s after workers restart
- Mode: 'worker'
- Method: 'N/A'
- Path: 'work:SETTLEMENT'
- Setup: Exactly 2,000 PENDING Transfers each have one nonterminal SETTLEMENT Work. Start two workers, hold both at worker.claimed, SIGKILL them, wait for both leases to expire, then start two replacements.
- Selector: Workers claim by the published createdAt,transferId order until no SETTLEMENT Work is nonterminal.
- Request: No measured client request is issued; setup uses only the published seed and public APIs before the worker timer starts.
- Concurrency: 2
- Warm-up seconds: 0
- Measure seconds: 45
- Success: All 2,000 Transfers are POSTED exactly once, no SETTLEMENT Work has terminal=false, stale workers cannot commit, and conservation plus event invariants pass.
- Threshold: The replacement-worker timer is <= 45 seconds and worker unexpected failures = 0.
- Timer: Start when both replacement worker processes are spawned; stop only after one verification snapshot proves the backlog drained and all postconditions.

Fixed performance seed: seedVersion perf-v1 contains exactly 20,000 accounts and 102,000 transfers: 100,000 POSTED and 2,000 PENDING, with exactly one pending Settlement Task per PENDING Transfer.

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

- foreign exchange
- interest
- fees
- external payment rails
- account overdrafts

## Handoff

Keep README and OpenAPI current. Finish with a findings-first review and report architecture, module and
process ownership, public interfaces, success/failure data flow, transaction and lease boundaries,
migrations, compatibility, exact commands run, test and performance results, recovery evidence, known
risks, and every check not run. Do not claim a check that was not actually executed.

## Additional product requirements — required in the same final system




完整系统包含“atomic multi-beneficiary transfers”。
以下业务规则、wire schema、接口和错误全部是公开产品合同。

业务规则：

1. A new Transfer may contain 1-20 destination legs
V1 single-destination requests remain valid.
2. Every destination amountMinor and their exact sum must be positive safe integers
an invalid member or overflowing sum is rejected before any durable effect.
3. All destination legs post together or none post
the source is charged exactly the sum of the legs.
4. For a pending multi-leg Transfer, the source reservation equals the exact safe-integer sum of its legs until posting or cancellation releases it.
5. Duplicate destination account IDs are rejected before any durable effect.
6. Each destination leg receives a stable legId and appears in Transfer detail and Account statements.
7. Reversal compensates every leg atomically and cannot partially succeed.
8. The legacy destinationAccountId and amountMinor response fields remain populated for one-leg Transfers and are null for multi-leg Transfers.
9. Upgrade every V1 Transfer to one leg without changing IDs, timestamps, statements, event sequences, or replay bodies.
10. Preserve all pending Settlement Tasks and their retry state.
11. Old one-leg clients continue to create and read Transfers unchanged.
12. The versioned seed schema remains exactly V1
Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
13. The only new Domain Event type names are those written literally in the Manager rules or contracts above.
Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
14. Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
15. Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

新增 wire schema：

- TransferLeg = {legId:uuid,destinationAccountId:uuid,amountMinor:int,postingLegId:uuid|null}
Transfer adds legs:[TransferLeg], while destinationAccountId and amountMinor become required nullable fields
- Manager Posting legs use {postingLegId:uuid,legId:uuid|null,accountId:uuid,direction:DEBIT|CREDIT,amountMinor:int}.
A multi-leg TRANSFER orders one source DEBIT with legId null before destination CREDIT legs in Transfer.legs order
a REVERSAL orders destination DEBIT legs in Transfer.legs order before one source CREDIT with legId null.
The source leg amount is the exact safe-integer sum of the destination legs.
This replaces the V1 exactly-two-leg rule only for multi-leg Transfers
one-leg Postings keep the V1 order and shape

新增或变更接口：

- POST /api/v1/transfers accepts either legacy {sourceAccountId,destinationAccountId,currency,amountMinor} or new {sourceAccountId,currency,legs:[{destinationAccountId,amountMinor}]}, never both
response is the extended Transfer
- GET /api/v1/transfers/:transferId and Account statements expose legId
reverse and cancel endpoints keep their V1 request shapes and act on the complete Transfer

新增稳定错误：

- 400 DUPLICATE_DESTINATION_ACCOUNT: two request legs name the same destinationAccountId
- 400 INVALID_MULTI_LEG_AMOUNT: a destination amountMinor or their exact sum is not a positive safe integer
- 409 MULTI_LEG_INSUFFICIENT_FUNDS: source availableMinor is less than the safe-integer sum of all legs

FINAL snapshot 与性能兼容合同：

The FINAL verification snapshot 'resources' object has exactly the union of these V1 and Manager resource specifications, with no other keys:

- 'accounts' uses exact shape 'Account' and sorts ascending by scalar field-path tuple 'accountId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'transfers' uses exact shape 'Transfer' and sorts ascending by scalar field-path tuple 'transferId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'postings' uses exact shape 'Posting' and sorts ascending by scalar field-path tuple 'postingId', then by RFC 8785 canonical JSON as the tie-breaker.

The Manager-added resource specifications are exactly:

- No additional resource keys.

The FINAL Work kind enum is exactly the union 'SETTLEMENT'.
The Manager-added Work kinds are exactly (none).
All V1 snapshot point-in-time, recursive '*Token' omission, sorting, Work state/lease/retention/drain, and Domain Event rules remain mandatory.
The FINAL binary reruns exactly these three V1-compatible scenarios:

- 'statement-read': 150 statement reads/s with p95 <= 150 ms
threshold: At least 150 successful responses/s for 60 seconds and successful-response p95 <= 150 ms
unexpected 5xx = 0.
- 'transfer-mutation-mix': 40 transfer mutations/s with p95 <= 500 ms
threshold: At least 40 successful mutations/s for 60 seconds and successful-response p95 <= 500 ms
all balances, reservations, postings, and events reconcile afterward.
- 'settlement-recovery': drain 2,000 Settlement Tasks within 45 s after workers restart
threshold: The replacement-worker timer is <= 45 seconds and worker unexpected failures = 0.

Their published setup, selector, request, concurrency, warm-up, measurement, timer, success condition, and threshold remain unchanged.
This Manager change adds correctness, concurrency, and recovery assertions only
it does not replace or relax a performance scenario.



