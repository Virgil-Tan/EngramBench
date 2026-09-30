# SeatReserve

Build SeatReserve from this intentionally blank repository. This README is the complete public product
contract. Ask before making a product choice that the contract does not settle.

## Stack, authority, commands, and environment

Use Node.js 22, TypeScript, React, PostgreSQL 16, npm, and preinstalled Chromium. PostgreSQL is authoritative
for events, seats, prices, holds, orders, payments, idempotency, leases, events, and availability. The UI uses
only the public HTTP API; browser clocks, storage, and process memory are not authoritative.

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

Commands are non-interactive, fail with non-zero exit, and clean children. `PORT` defaults to 3000. Runtime
uses `DATABASE_URL`, `TEST_DATABASE_URL`, `ADMIN_TOKEN`, `PROVIDER_BASE_URL` (default
`http://127.0.0.1:4011`), `WEBHOOK_URL`,
`WORK_LEASE_SECONDS` (1..30), `TEST_BARRIER_URL`, and `TEST_BARRIER_TOKEN`. Credentials, raw Provider bodies,
payment tokens, and private paths never appear in public state, logs, Event, or snapshot.

## Domain and states

SeatReserve sells assigned seats for tenant Events. Clients query availability, atomically hold one or more
seats at a frozen Zone PriceVersion, and check out through a deterministic local payment-provider double. A
Hold expires by database time unless converted, cancelled, or protected by an unresolved PaymentIntent grace
fence. The system exposes a real React booking and operations UI.

```text
Tenant, Venue, Event, Zone, Seat, PriceVersion, SeatHold, HoldSeat,
Order, OrderSeat, PaymentIntent, ProviderReceipt, OutboxEvent, Work

Event:         DRAFT -> ON_SALE -> SALES_CLOSED -> CANCELLED
SeatHold:      HELD -> CHECKOUT -> CONVERTED | EXPIRED | CANCELLED
Order:         PENDING_PAYMENT -> PAYMENT_UNKNOWN | CONFIRMED | CANCELLED
PaymentIntent: CREATED -> PROCESSING -> SUCCEEDED | FAILED | UNKNOWN
```

`uuid` is lowercase RFC 4122, `timestamp` is UTC ISO-8601 with milliseconds and `Z`, currency is three uppercase
ASCII letters, and all money is a non-negative JSON safe integer in minor units.

```text
Seat = {seatId:uuid,eventId:uuid,zoneId:uuid,row:string,number:int,accessible:boolean,createdAt:timestamp}
PriceVersion = {priceVersionId:uuid,zoneId:uuid,version:int,state:DRAFT|ACTIVE|SUPERSEDED,unitAmountMinor:int,feeMinor:int,currency:string,effectiveFrom:timestamp,effectiveTo:timestamp|null,createdAt:timestamp}
SeatHold = {holdId:uuid,tenantId:uuid,eventId:uuid,customerRef:string,state:HELD|CHECKOUT|CONVERTED|EXPIRED|CANCELLED,expiresAt:timestamp,paymentGraceExpiresAt:timestamp|null,totalMinor:int,currency:string,createdAt:timestamp,terminalAt:timestamp|null,sequence:int}
HoldSeat = {holdId:uuid,seatId:uuid,priceVersionId:uuid,unitAmountMinor:int,feeMinor:int}
Order = {orderId:uuid,holdId:uuid,tenantId:uuid,eventId:uuid,customerRef:string,state:PENDING_PAYMENT|PAYMENT_UNKNOWN|CONFIRMED|CANCELLED,totalMinor:int,currency:string,paymentIntentId:uuid,createdAt:timestamp,confirmedAt:timestamp|null,sequence:int}
OrderSeat = {orderId:uuid,seatId:uuid,priceVersionId:uuid,unitAmountMinor:int,feeMinor:int}
PaymentIntent = {paymentIntentId:uuid,orderId:uuid,amountMinor:int,currency:string,state:CREATED|PROCESSING|SUCCEEDED|FAILED|UNKNOWN,providerRequestId:string,providerTransactionId:string|null,createdAt:timestamp,resolvedAt:timestamp|null,sequence:int}
ProviderReceipt = {providerReceiptId:uuid,providerEventId:string,providerRequestId:string,outcome:SUCCEEDED|FAILED,providerTransactionId:string|null,occurredAt:timestamp,receivedAt:timestamp}
```

## Inventory, holds, and pricing

1. A Seat belongs to exactly one Event and Zone. The event layout is immutable after `ON_SALE`.
2. A seat is unavailable when owned by one unexpired HELD/CHECKOUT Hold or one CONFIRMED/PAYMENT_UNKNOWN Order.
   At every committed instant a Seat has at most one such owner.
3. `POST /holds` accepts 1..12 sorted unique seat IDs from one ON_SALE Event and TTL 30..900 seconds. It either
   acquires every seat or changes nothing. Conflict returns all currently unavailable requested seat IDs.
4. Expiry uses PostgreSQL time. Expiry Work rechecks Hold state and fence immediately before release. A stale
   Worker or client clock cannot release, extend, or resurrect a Hold.
5. Each HoldSeat freezes the PriceVersion active at the Hold's commit boundary. Total is the overflow-checked
   sum of unit amount plus fee. Later price publication never changes an existing Hold or Order.
6. One Zone has at most one ACTIVE PriceVersion at a time. Effective intervals do not overlap. Price activation
   racing Hold creation has one database serialization order visible in every frozen HoldSeat.
7. Exact Hold cancellation releases all seats atomically. A CONVERTED, EXPIRED, or CANCELLED Hold is terminal.

## Checkout and uncertain payment

1. Checkout converts a HELD Hold to CHECKOUT and creates exactly one Order and PaymentIntent for the frozen total.
   Its JSON body is `{providerScenario:SUCCEEDED|FAILED|TIMEOUT|CONNECTION_RESET}`; this selects deterministic
   behavior from the local benchmark Provider double and is frozen on first execution.
2. Provider request identity is stable for the PaymentIntent. Timeout or connection reset becomes UNKNOWN; it is
   not a decline and the system must not send a second semantic charge.
3. UNKNOWN extends seat protection to the published `paymentGraceExpiresAt`, at most 15 minutes from checkout.
   Hold expiry cannot release those seats before reconciliation or grace expiry.
4. Provider receipts and active reconcile commute. Duplicate, delayed, and reordered messages converge to one
   result. A transaction ID belongs to one PaymentIntent.
5. SUCCEEDED atomically confirms Order, converts Hold, fixes OrderSeats, and emits one event. FAILED cancels Order
   and Hold and releases seats. A success received after a valid failed/released terminal result is recorded as
   `PROVIDER_RESULT_CONFLICT` and cannot steal a seat from another owner.
6. Concurrent checkout, cancellation, expiry, receipt, and reconcile have exactly one legal terminal history.

The benchmark Provider double exposes this complete public protocol. Only the Worker contacts it; the API commits
checkout and `PAYMENT_CAPTURE` Work without waiting on the Provider.

```text
POST ${PROVIDER_BASE_URL}/charges
  body {providerRequestId:string,amountMinor:int,currency:string,scenario:SUCCEEDED|FAILED|TIMEOUT|CONNECTION_RESET}
  SUCCEEDED -> 200 {outcome:SUCCEEDED,providerTransactionId:string}
  FAILED    -> 200 {outcome:FAILED,providerTransactionId:null}
  TIMEOUT   -> 504 {error:{code:PROVIDER_TIMEOUT,message:string,details:{}}}
  CONNECTION_RESET -> connection closes without a response
GET  ${PROVIDER_BASE_URL}/charges/:providerRequestId
  -> 200 {outcome:PENDING|SUCCEEDED|FAILED,providerTransactionId:string|null}
```

The double durably records one canonical request per `providerRequestId`. Retrying `POST /charges` with the same
body returns the same result; changed money, currency, or scenario returns `409 PROVIDER_REQUEST_CONFLICT`. A
TIMEOUT or CONNECTION_RESET request has one deterministic terminal result discoverable by `GET`, so reconcile
must query that identity rather than issue another semantic charge.

Every mutation requires `Idempotency-Key` scoped by method and canonical path. Exact replay, concurrent replay,
lost response, and API restart return original status/body. Changed body returns `IDEMPOTENCY_CONFLICT` without
state change. Duplicate `providerEventId` with changed content is `PROVIDER_EVENT_CONFLICT`.

## Work, events, and recovery

Workers use bounded PostgreSQL leases and fenced final commits. A killed owner is reclaimable after the lease.
Business state, Work, and Event commit atomically. Dispatch is at least once and retry preserves Event ID,
aggregate sequence, headers, and canonical body. Required events are `hold.created`, `hold.expired`,
`hold.cancelled`, `checkout.started`, `payment.unknown`, `order.confirmed`, and `order.cancelled`.

Durable Work is exactly
`{workId:uuid,kind:HOLD_EXPIRY|PAYMENT_CAPTURE|PAYMENT_RECONCILE,aggregateId:uuid,state:PENDING|LEASED|SUCCEEDED|FAILED|CANCELLED,terminal:boolean,attempt:int,leaseOwner:string|null,leaseExpiresAt:timestamp|null}`.
`HOLD_EXPIRY.aggregateId` is the Hold ID; `PAYMENT_CAPTURE.aggregateId` and
`PAYMENT_RECONCILE.aggregateId` are the PaymentIntent ID.

## Public HTTP surface

```text
POST /api/v1/tenants
POST /api/v1/venues
POST /api/v1/events
POST /api/v1/events/:eventId/zones
POST /api/v1/events/:eventId/seats
POST /api/v1/zones/:zoneId/price-versions
POST /api/v1/price-versions/:priceVersionId/activate
POST /api/v1/events/:eventId/on-sale
GET  /api/v1/events/:eventId/availability?zoneId&limit&cursor
POST /api/v1/holds
GET  /api/v1/holds/:holdId
POST /api/v1/holds/:holdId/cancel
POST /api/v1/holds/:holdId/checkout
GET  /api/v1/orders/:orderId
POST /api/v1/payment-intents/:paymentIntentId/reconcile
POST /api/v1/provider/receipts
GET  /api/v1/verification-snapshot
```

Serve OpenAPI 3.1 at `/openapi.json` and health at `/healthz`. Reject malformed JSON, unsupported media types,
unknown fields, invalid UUID/time/currency/range, duplicate seats, and cross-tenant references. Errors are
`{"error":{"code":"STABLE_CODE","message":"...","details":{}}}`. Collections use `{items,nextCursor}`.

Exhaustive semantic errors for well-formed requests:

```text
409 IDEMPOTENCY_CONFLICT
409 SEAT_UNAVAILABLE
409 HOLD_TERMINAL
409 HOLD_EXPIRED
409 ACTIVE_PRICE_CHANGED
409 PAYMENT_RESULT_UNKNOWN
409 PROVIDER_EVENT_CONFLICT
409 PROVIDER_TRANSACTION_CONFLICT
409 PROVIDER_RESULT_CONFLICT
400 PRICE_INVALID
400 HOLD_INVALID
400 INVALID_REQUEST
```

## Seed and verification snapshot

Seed is exactly:

```json
{"schemaVersion":1,"seedVersion":"...","importedAt":"...","tenants":[],"venues":[],"events":[],"zones":[],"seats":[],"priceVersions":[],"holds":[],"holdSeats":[],"orders":[],"orderSeats":[],"paymentIntents":[],"providerReceipts":[]}
```

Import is atomic; exact version+digest replay is no-op, changed digest is `SEED_VERSION_CONFLICT`. Snapshot
resources contain exactly these arrays, plus resources introduced by any later published change only after its
migration, complete and sorted by public identity. It also exposes `work` and `events`, but no credentials, raw
Provider body, token, or private path.

## UI and project-owned verification

Production React exposes Event/Zone/Seat setup, price publication, availability, multi-seat Hold with a
server-expiry countdown, checkout, UNKNOWN resolution, Order state, errors, loading/empty states, and accessible
controls. A real Chromium test selects seats, holds them, checks out through the local Provider double, resolves
an UNKNOWN outcome, and sees authoritative availability.

Unit, real PostgreSQL/HTTP Integration, production Chromium E2E, at least two-API/two-Worker Concurrency,
barrier+SIGKILL Recovery, Aggregate, and Performance commands are mandatory. Fixed performance environment is
4 vCPU, 8 GiB RAM, PostgreSQL 16, four APIs and four Workers:

1. `seat-hold-ingest`: 50,000 disjoint Holds, concurrency 96, >=250 holds/s, p95<=400ms, 0 5xx.
2. `hot-seat-contention`: 20,000 attempts against 1,000 hot Seats through four APIs, concurrency 128,
   >=300 attempts/s, p95<=500ms, and exactly one live owner per Seat.
3. `payment-expiry-recovery`: 5,000 CHECKOUT/UNKNOWN Orders mixed with expiry, two Worker SIGKILLs and four
   replacements, drain <=90 seconds with no oversell, duplicate charge identity, or stranded live Hold.

After load, recompute seat ownership, Hold/Order relation, frozen totals, provider identities, Work, and Event
order. `test:all` runs all non-performance gates; `test:perf` runs all three full-scale scenarios.

## Out of scope

General admission, dynamic auctions, ticket resale, refunds, real payment networks, tax calculation, identity
verification, venue access control, seat-map graphics editing, and cross-event or cross-tenant Holds.

## Successful response contracts

Successful response contracts are closed:

- A mutation route without a literally stated success status returns 200.
- Unless a route literally publishes another object, array, or empty body, a success described by a named resource, named resource state, or named resource fields returns that exact resource shape at the JSON top level. Any response-only fields literally named by the route are additional top-level fields.
- If a mutation publishes no success body, it returns the exact current shape of the single primary resource created or changed by that route at the JSON top level.
- When a route explicitly returns multiple named resources, the body is one object keyed by their lower-camel resource names unless the route publishes another literal shape.
- Wrappers such as `{data:...}`, `{result:...}`, or an extra single-resource envelope are invalid unless the route literally declares them. OpenAPI must publish the same success status and closed response schema as runtime.
