# AuctionGuard — Complete system requirements

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

# AuctionGuard

Build AuctionGuard from this intentionally blank repository. This README is the complete product
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
| 'npm run start:worker' | Start one Close Task worker. |
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
| 'DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/auctionguard' | Production/development authority. |
| 'TEST_DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/auctionguard_test' | Required by all stateful tests. |
| 'PORT' | '3000' | Integer 1-65535; API and production UI origin. |
| 'ADMIN_TOKEN' | task-local value | Required only for documented admin mutation routes; never log it. |
| 'WEBHOOK_URL' | 'http://127.0.0.1:4010/events' | HTTP endpoint for Domain Event delivery. |
| 'WORK_LEASE_SECONDS' | '3' | Integer 1-60; persisted lease duration used by workers and recovery tests. |
| 'CHROMIUM_PATH' | '/usr/bin/chromium' | Browser executable for project-owned E2E. |
| 'MANAGED_DATA_ROOT' | '/tmp/auctionguard-data' | Writable root for staged or generated bytes; never serve a path directly. |
| 'TEST_BARRIER_URL' | empty | Optional localhost HTTP receiver used only by controlled recovery tests. |
| 'TEST_BARRIER_TOKEN' | empty | Required barrier header value when the URL is set; never log it. |

Bind only to '127.0.0.1'. Logs must not contain tokens, idempotency keys, raw seed input, webhook
bodies, or private absolute paths.

## Domain and V1 behavior

| Term | Canonical definition | Avoid |
| --- | --- | --- |
| Lot | The immutable item offered by one Auction. | Product, listing |
| Auction | A timed ascending-price competition for one Lot in V1. | Sale, market |
| Bid | An immutable maximum amount submitted by one Bidder. | Offer, price |
| Leading Bid | The deterministic currently winning accepted Bid. | Winner, top row |
| Close Task | Durable leased work that closes an Auction after its effective endAt. | Timer, cron |
| Anti-sniping Window | The published interval in which an accepted Bid extends endAt once per new effective deadline. | Delay, grace |

Auction: SCHEDULED -> OPEN -> CLOSING -> CLOSED | CANCELLED; Bid: ACCEPTED | OUTBID | WINNING.

1. Create scheduled Auctions and open them through persisted time boundaries.
2. Accept strictly increasing integer-minor-unit Bids with durable scoped idempotency.
3. Select a deterministic Leading Bid under concurrent API requests and extend endAt under the exact anti-sniping rule.
4. Close with recoverable Close Tasks and publish exactly one winner or no-sale result.
5. Expose live bid history, countdown based on server time, outcome, and event delivery in the UI.

### Deterministic policy

1. All money is a positive safe integer in Auction currency. The first accepted Bid must be >= reservePriceMinor; each later Bid must be >= current leading amount plus minimumIncrementMinor.
2. The database transaction timestamp is acceptedAt. A Bid is eligible only while state OPEN and acceptedAt < effectiveEndAt; serialized commit order assigns committedSequence and therefore the unique leader.
3. antiSnipingWindowSeconds is 120. If an accepted Bid has effectiveEndAt - acceptedAt <= 120 seconds, set effectiveEndAt to acceptedAt + 120 seconds; otherwise keep it unchanged.
4. Close Tasks process by effectiveEndAt then auctionId and must lock/recheck the deadline. A leading Bid produces WINNER; no accepted Bid produces NO_SALE. Cancel is legal only in SCHEDULED/OPEN with no Bid.

## Mandatory invariants

1. Accepted bid amounts for an Auction are strictly increasing in committed sequence.
2. At most one Bid is Leading and at most one winner is finalized in V1.
3. A Bid accepted before the effective deadline cannot be lost by a concurrent close.
4. Each qualifying accepted Bid applies at most one deterministic deadline extension.
5. Closing emits one immutable outcome and repeated workers cannot change it.

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

- Auction = {auctionId:uuid,lotId:uuid,currency:currency,reservePriceMinor:int,minimumIncrementMinor:int,startAt:timestamp,effectiveEndAt:timestamp,state:SCHEDULED|OPEN|CLOSING|CLOSED|CANCELLED,leadingBidId:uuid|null,winnerId:uuid|null,winningAmountMinor:int|null,sequence:int}
- Bid = {bidId:uuid,auctionId:uuid,bidderId:uuid,amountMinor:int,committedSequence:int,state:ACCEPTED|OUTBID|WINNING,acceptedAt:timestamp,effectiveEndAtAfter:timestamp}
- AuctionOutcome = {auctionId:uuid,result:WINNER|NO_SALE,winnerId:uuid|null,winningBidId:uuid|null,winningAmountMinor:int|null,closedAt:timestamp}
- Lot = {lotId:uuid,title:string,description:string}

The public aggregate routes are:

- 'GET /api/v1/auctions?limit&cursor' and
  'GET /api/v1/auctions/:auctionId'.
- POST /api/v1/auctions/:auctionId/bids with {bidderId,amountMinor}; return 201 accepted Bid and effectiveEndAt, or stable 409 BID_TOO_LOW/AUCTION_NOT_OPEN.
- POST /api/v1/admin/auctions with {lotId,currency,reservePriceMinor,minimumIncrementMinor,startAt,endAt} requires ADMIN_TOKEN and returns 201 SCHEDULED.
- POST /api/v1/auctions/:auctionId/cancel with {reason} succeeds only before an accepted Bid exists.
- POST /api/v1/admin/auctions/:auctionId/open with {} enforces scheduled start and idempotent replay.
- GET /api/v1/auctions/:auctionId/bids?limit&cursor returns committed bid sequence without leaking idempotency keys.
- GET /api/v1/time returns {now:timestamp}; browser countdown and hidden deadline tests use this server-authority clock.
- 'GET /api/v1/domain-events?aggregateId&afterSequence&limit' returns committed events in sequence.
- 'GET /api/v1/verification-snapshot' requires 'Authorization: Bearer <ADMIN_TOKEN>' and returns one
  serializable snapshot '{asOf:timestamp,resources:{...},work:[Work],events:[DomainEvent]}'.

### V1 verification snapshot

The complete snapshot is read from one PostgreSQL point-in-time; 'asOf', every resource array, 'work',
and 'events' must describe that same database snapshot. The V1 'resources' object has exactly these keys
and no others:

- 'bidders' uses exact shape 'Bidder = {bidderId:uuid,displayName:string}' and sorts ascending by scalar field-path tuple 'bidderId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'lots' uses exact shape 'Lot' and sorts ascending by scalar field-path tuple 'lotId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'auctions' uses exact shape 'Auction' and sorts ascending by scalar field-path tuple 'auctionId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'bids' uses exact shape 'Bid' and sorts ascending by scalar field-path tuple 'auctionId', 'committedSequence', 'bidId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'auctionOutcomes' uses exact shape 'AuctionOutcome' and sorts ascending by scalar field-path tuple 'auctionId', then by RFC 8785 canonical JSON as the tie-breaker.

Each resource array contains every current or immutable instance named by its declared shape exactly
once. Each listed sort path resolves to a scalar. Scalar order is null first, then false before true,
integers numerically, and every other string-form scalar by UTF-8 bytes. Sort ascending by the complete
tuple, then use RFC 8785 canonical JSON only as the tie-breaker.
Recursively omit every object field whose name ends in 'Token', at every nesting depth.

'Work' is exactly
'{workId:uuid,kind:AUCTION_CLOSE,aggregateId:uuid,state:PENDING|LEASED|SUCCEEDED|FAILED|CANCELLED,terminal:boolean,attempt:int,leaseOwner:string|null,leaseExpiresAt:timestamp|null}'.
'kind' is one of exactly 'AUCTION_CLOSE'. Both lease fields are non-null exactly
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
| 409 | AUCTION_NOT_OPEN | Auction state or effective deadline does not accept Bids |
| 409 | BID_TOO_LOW | amount does not satisfy reserve or current minimum |
| 409 | AUCTION_NOT_CANCELLABLE | a Bid exists or state is not cancellable |
| 409 | AUCTION_ALREADY_CLOSED | a terminal outcome already exists |
| 400 | INVALID_BID_AMOUNT | amount is not a positive safe integer |
| 400 | INVALID_AUCTION_SCHEDULE | money fields are invalid or startAt is not before endAt |

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

'{schemaVersion:1,seedVersion,bidders,lots,auctions,bids}; monetary values are non-negative integers in one Auction currency, startAt precedes endAt, and anti-sniping parameters are bounded.'

Member schemas are exact:

- bidders[] = {bidderId:uuid,displayName:string}; lots[] use the exact Lot schema
- auctions[] use the exact Auction schema and add antiSnipingWindowSeconds:120; scheduled/open deadlines and money fields must be valid
- bids[] use the exact Bid schema with contiguous committedSequence and exactly one WINNING Bid matching each Auction leader

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
`auction.opened`, `bid.accepted`, `auction.extended`, `auction.closed`, `auction.cancelled`. 'payload' is exactly '{}' for every V1 event; a later Manager event also uses '{}' unless
its published contract literally supplies another payload shape. A rollback creates no event. Sequence
is contiguous per aggregate.

The dispatcher sends JSON with 'X-AuctionGuard-Event-Id' and 'X-AuctionGuard-Event-Type'. Network errors,
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
performing every public user action, observing asynchronous Close Task progress, browsing event and
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

### Scenario 'hot-auction-bids'

- Target: accept 250 Bids/s on 20 hot Auctions with p95 <= 300 ms
- Mode: 'http'
- Method: 'POST'
- Path: '/api/v1/auctions/:auctionId/bids'
- Setup: Use exactly 20 seeded OPEN hot Auctions and disjoint warm-up and measured Bidder pools. Keep one sequential producer per Auction.
- Selector: Each of 20 producers targets one Auction and chooses the next bidderId bytewise; amountMinor is prior accepted amount plus minimumIncrementMinor.
- Request: {bidderId,amountMinor}; the producer waits for its response before computing the next amount and always uses a fresh key.
- Concurrency: 20
- Warm-up seconds: 10
- Measure seconds: 60
- Success: Only 201 accepted Bids count; committedSequence is gapless, the leader matches the greatest committed amount, and no 409 is in the success numerator.
- Threshold: At least 250 accepted Bids/s across the 20 Auctions for 60 seconds and p95 <= 300 ms; unexpected 5xx = 0.
- Timer: The throughput window starts with the first measured request after warm-up; each latency sample runs from request dispatch through the complete response body.

### Scenario 'live-auction-read'

- Target: serve 400 live Auction reads/s with p95 <= 100 ms
- Mode: 'http'
- Method: 'GET'
- Path: '/api/v1/auctions/:auctionId'
- Setup: Use the same 20 OPEN hot Auctions without issuing Bids in this independent run.
- Selector: Round-robin auctionId values bytewise.
- Request: No body or query parameters.
- Concurrency: 64
- Warm-up seconds: 10
- Measure seconds: 60
- Success: Only 200 Auction responses whose leader, amount, state, and effectiveEndAt agree atomically count.
- Threshold: At least 400 successful reads/s for 60 seconds and p95 <= 100 ms; mixed revisions and unexpected 5xx are zero.
- Timer: The throughput window starts with the first measured request after warm-up; each latency sample runs from request dispatch through the complete response body.

### Scenario 'auction-close-recovery'

- Target: close 2,000 due Auctions within 45 s after restart
- Mode: 'worker'
- Method: 'N/A'
- Path: 'work:AUCTION_CLOSE'
- Setup: Exactly 2,000 CLOSING Auctions have due Close Work. Hold two workers at worker.claimed, SIGKILL, wait for lease expiry, then start two replacements.
- Selector: Close by effectiveEndAt,auctionId using the locked canonical Bid snapshot.
- Request: No measured client request is issued; setup uses only the published seed and public APIs before the worker timer starts.
- Concurrency: 2
- Warm-up seconds: 0
- Measure seconds: 45
- Success: Every Auction becomes CLOSED exactly once with one canonical AuctionOutcome, no AUCTION_CLOSE Work remains nonterminal, and stale workers cannot create another outcome.
- Threshold: The 2,000-Auction backlog drains in <= 45 seconds after replacement spawn; unexpected failures = 0.
- Timer: Start when both replacements spawn and stop at the first point-in-time snapshot proving all outcomes and invariants.

Fixed performance seed: seedVersion perf-v1 contains exactly 100,000 bidders, 2,020 lots, 2,020 auctions, and 50,000 bids; exactly 20 Auctions are OPEN hot targets and 2,000 Auctions are CLOSING with due Close Tasks.

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

- payments
- shipping
- bid withdrawal
- sealed bids
- combinatorial package bidding

## Handoff

Keep README and OpenAPI current. Finish with a findings-first review and report architecture, module and
process ownership, public interfaces, success/failure data flow, transaction and lease boundaries,
migrations, compatibility, exact commands run, test and performance results, recovery evidence, known
risks, and every check not run. Do not claim a check that was not actually executed.

## Additional product requirements — required in the same final system




完整系统包含“multi-unit uniform-price auctions”。
以下业务规则、wire schema、接口和错误全部是公开产品合同。

业务规则：

1. An Auction may offer 2-100 identical Units and each Bid requests quantity 1-20 at one maximum unit price.
2. At close, sort accepted Bids by unit price descending, committed sequence ascending, then bidId
allocate until Units are exhausted.
3. The clearing unit price is the lowest winning unit price
a final Bid may receive a partial quantity.
4. Closing creates 1-N immutable Awards atomically, never more awarded Units than available.
5. Cancellation remains illegal after any accepted Bid
anti-sniping semantics are unchanged.
6. Legacy single-unit Auctions keep leadingBidId, winnerId, and winningAmountMinor
multi-unit Auctions keep leadingBidId as the current highest-price Bid, return null for winnerId and winningAmountMinor, and expose awards[].
7. For a multi-unit Bid, amountMinor multiplied by quantity must be a JSON safe integer
this also bounds every Award totalAmountMinor.

9. Pending Close Tasks and effective deadlines remain exact.
10. Stored one-unit Bid and close replay responses remain byte-equivalent JSON.
11. The versioned seed schema remains exactly V1
Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
12. The only new Domain Event type names are those written literally in the Manager rules or contracts above.
Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
13. Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
14. Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

新增 wire schema：

- MultiUnitBid = {bidId:uuid,auctionId:uuid,bidderId:uuid,amountMinor:int,quantity:int,committedSequence:int,state:ACCEPTED|OUTBID|WINNING,acceptedAt:timestamp,effectiveEndAtAfter:timestamp}
- Award = {awardId:uuid,auctionId:uuid,bidId:uuid,bidderId:uuid,allocatedQuantity:int,clearingUnitPriceMinor:int,totalAmountMinor:int,allocationRank:int,createdAt:timestamp}
- MultiUnitAuctionOutcome = {auctionId:uuid,result:WINNER|NO_SALE,unitCount:int,allocatedUnitCount:int,unallocatedUnitCount:int,clearingUnitPriceMinor:int|null,awards:[Award],closedAt:timestamp}
- AuctionDetail = {auctionId:uuid,lotId:uuid,currency:currency,reservePriceMinor:int,minimumIncrementMinor:int,startAt:timestamp,effectiveEndAt:timestamp,state:SCHEDULED|OPEN|CLOSING|CLOSED|CANCELLED,leadingBidId:uuid|null,winnerId:uuid|null,winningAmountMinor:int|null,sequence:int,unitCount:int,awards:[Award],outcome:AuctionOutcome|MultiUnitAuctionOutcome|null}
outcome is null before CLOSED, AuctionOutcome for a closed one-unit Auction, and MultiUnitAuctionOutcome for a closed multi-unit Auction

新增或变更接口：

- POST /api/v1/admin/auctions accepts the V1 fields plus unitCount
omission creates a legacy one-unit Auction, while an explicit multi-unit value must be an integer from 2 through 100.
- POST /api/v1/auctions/:auctionId/bids accepts {bidderId,amountMinor,quantity}
quantity is required and must be 1..20 for a multi-unit Auction, amountMinor * quantity must be <= 9007199254740991, and the legacy one-unit request may omit quantity and receives quantity 1.
- GET /api/v1/auctions/:auctionId returns the exact AuctionDetail.
A multi-unit outcome and AuctionDetail.awards use identical Awards ordered by allocationRank
each Award totalAmountMinor equals allocatedQuantity multiplied by the common clearingUnitPriceMinor.
- For a one-unit Auction the existing leadingBidId, winnerId, winningAmountMinor, and replay JSON remain populated exactly as before
for a multi-unit Auction winnerId and winningAmountMinor are null, leadingBidId retains its V1 meaning, and awards contains the complete immutable allocation.

新增稳定错误：

- 400 INVALID_AUCTION_UNIT_COUNT: an explicitly supplied unitCount is not a safe integer from 2 through 100
- 400 INVALID_BID_QUANTITY: a multi-unit Bid omits quantity or quantity is not a safe integer from 1 through 20
- 400 BID_TOTAL_OVERFLOW: amountMinor multiplied by quantity exceeds 9007199254740991
- 409 AWARD_ALLOCATION_CONFLICT: a close retry observes an Award set that differs from canonical allocation for the locked Bid snapshot

FINAL snapshot 与性能兼容合同：

The FINAL verification snapshot 'resources' object has exactly the union of these V1 and Manager resource specifications, with no other keys:

- 'bidders' uses exact shape 'Bidder = {bidderId:uuid,displayName:string}' and sorts ascending by scalar field-path tuple 'bidderId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'lots' uses exact shape 'Lot' and sorts ascending by scalar field-path tuple 'lotId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'auctions' uses exact shape 'Auction' and sorts ascending by scalar field-path tuple 'auctionId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'bids' uses exact shape 'Bid' and sorts ascending by scalar field-path tuple 'auctionId', 'committedSequence', 'bidId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'auctionOutcomes' uses exact shape 'AuctionOutcome' and sorts ascending by scalar field-path tuple 'auctionId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'awards' uses exact shape 'Award' and sorts ascending by scalar field-path tuple 'auctionId', 'allocationRank', 'awardId', then by RFC 8785 canonical JSON as the tie-breaker.

The Manager-added resource specifications are exactly:

- 'awards' uses exact shape 'Award' and sorts ascending by scalar field-path tuple 'auctionId', 'allocationRank', 'awardId', then by RFC 8785 canonical JSON as the tie-breaker.

The FINAL Work kind enum is exactly the union 'AUCTION_CLOSE'.
The Manager-added Work kinds are exactly (none).
All V1 snapshot point-in-time, recursive '*Token' omission, sorting, Work state/lease/retention/drain, and Domain Event rules remain mandatory.
The FINAL binary reruns exactly these three V1-compatible scenarios:

- 'hot-auction-bids': accept 250 Bids/s on 20 hot Auctions with p95 <= 300 ms
threshold: At least 250 accepted Bids/s across the 20 Auctions for 60 seconds and p95 <= 300 ms
unexpected 5xx = 0.
- 'live-auction-read': serve 400 live Auction reads/s with p95 <= 100 ms
threshold: At least 400 successful reads/s for 60 seconds and p95 <= 100 ms
mixed revisions and unexpected 5xx are zero.
- 'auction-close-recovery': close 2,000 due Auctions within 45 s after restart
threshold: The 2,000-Auction backlog drains in <= 45 seconds after replacement spawn
unexpected failures = 0.

Their published setup, selector, request, concurrency, warm-up, measurement, timer, success condition, and threshold remain unchanged.
This Manager change adds correctness, concurrency, and recovery assertions only
it does not replace or relax a performance scenario.



