# CommerceCommand

Build a production-shaped multi-tenant omnichannel transaction control plane from this intentionally blank repository. This file and `AGENTS.md` are the complete V1 product contract. A later Manager message may introduce one compatible product change; do not anticipate it.

The system owns one coherent flow:

```text
immutable offer -> frozen quote -> inventory hold -> uncertain payment
-> physical fulfillment or digital entitlement -> balanced ledger -> notification
```

## Required stack and delivery

- Node.js 22, TypeScript, React, and PostgreSQL 16.
- A real PostgreSQL-backed API, a separately runnable Worker, a separately runnable dispatcher, and a production-built browser UI.
- OpenAPI 3.1 at `GET /openapi.json` and health at `GET /healthz` or `GET /api/health`.
- All dates are RFC 3339 UTC. All identifiers are UUID strings. All money is integer minor units plus an ISO 4217 currency. Floating-point money is forbidden.
- JSON object contracts are closed: reject unknown fields rather than silently ignoring them.
- Do not require global npm packages, Docker-in-Docker, external SaaS, or internet access after `npm install`.

Required non-interactive commands:

```bash
npm install --no-audit --no-fund
npm run build
npm run db:migrate
npm run db:seed -- --file /absolute/path/seed.json
npm run start:api
npm run start:worker
npm run start:dispatcher
npm run test:unit
npm run test:integration
npm run test:e2e
npm run test:concurrency
npm run test:recovery
npm run test:perf
npm run test:all
```

`db:migrate` is repeatable. Every start command is a long-running non-interactive production role. `test:all` runs every non-performance gate; it must not replace any named gate with a placeholder.

## Environment

| Variable | Required behavior |
| --- | --- |
| `DATABASE_URL` | PostgreSQL URL used by API, Worker, dispatcher, migration, and seed. |
| `PORT` | API port; default `3000`. |
| `ADMIN_TOKEN` | Bearer token for verification and administrative endpoints; never log it. |
| `WEBHOOK_URL` | Dispatcher destination; default may be absent, but dispatcher must stay alive and retry durable work. |
| `WORK_LEASE_SECONDS` | Worker/dispatcher lease duration, integer `1..300`, default `30`. |
| `TEST_BARRIER_URL` | Optional controlled crash barrier used only by concurrency/recovery tests. |
| `TEST_BARRIER_TOKEN` | Token sent only to the barrier; never persist or log it. |
| `BENCH_PERF_SCALE` | Test-only scale in `(0,1]`; a scored performance run uses exactly `1`. |

The API, Worker, and dispatcher may run as multiple processes against the same database. Process memory is never correctness authority.

## Domain model

### Tenant and buyer

Every business resource carries one `tenantId`. A `Buyer` belongs to exactly one Tenant. A request authenticated for one Tenant must behave as if another Tenant's IDs do not exist: return `404 RESOURCE_NOT_FOUND`, not data-dependent authorization detail. Admin verification uses `Authorization: Bearer <ADMIN_TOKEN>`.

### Product and immutable OfferVersion

A Product has physical or digital `kind`. Commercial terms are immutable `OfferVersion` rows:

```text
OfferVersion = {
  offerVersionId, tenantId, productId, version,
  currency, unitPriceMinor, taxMinor, fulfillmentKind,
  effectiveFrom, effectiveUntil, state
}
```

`version` is monotonic per Product. Once referenced by an OrderLine, price, tax, currency, fulfillment kind, and effective bounds never change. Activating a later version does not change an existing Order or saved idempotency replay.

### InventoryPool and InventoryHold

A physical Product may draw from multiple InventoryPools. Each pool stores non-negative `onHand` and `reserved` quantities. A quote deterministically selects pools by `(priority, inventoryPoolId)` and may split one line across pools.

At every committed state:

```text
0 <= reserved <= onHand
reserved = sum(quantity of HELD holds for the pool)
one hold belongs to one order line and one pool
HELD -> CONSUMED | RELEASED | EXPIRED exactly once
CONSUMED decreases onHand and reserved atomically by the same quantity
RELEASED or EXPIRED decreases reserved exactly once and never onHand
```

Insufficient aggregate availability rejects the complete quote with `409 INSUFFICIENT_INVENTORY`; it creates no Order, OrderLine, Hold, Event, Work, or idempotency success record.

### Order and frozen quote

`POST /api/v1/orders/quotes` accepts:

```json
{
  "tenantId": "uuid",
  "buyerId": "uuid",
  "channel": "WEB",
  "lines": [
    {"productId": "uuid", "quantity": 2}
  ],
  "holdTtlSeconds": 900
}
```

`channel` is `WEB`, `STORE`, or `PARTNER`; `lines` contains `1..100` unique Products; quantity is `1..1000`; TTL is `30..3600`. A successful quote atomically creates one `Order`, frozen `OrderLine` rows, required `InventoryHold` rows, one `OrderQuoted` DomainEvent, one notification outbox item, and `QUOTE_EXPIRY` Work. Response status is `201` and includes `orderId`, frozen totals, `quoteExpiresAt`, and line allocation summaries.

For every Order and currency:

```text
lineTotalMinor = quantity * (unitPriceMinor + taxMinor)
orderTotalMinor = sum(lineTotalMinor)
capturedMinor - refundedMinor >= 0
refundedMinor <= capturedMinor <= orderTotalMinor
```

Order states are `QUOTED`, `PAYMENT_PENDING`, `PAID`, `FULFILLING`, `FULFILLED`, `CANCELLED`, `PARTIALLY_REFUNDED`, and `REFUNDED`. Expired or cancelled quotes release all HELD inventory once.

### Checkout and uncertain payment

`POST /api/v1/orders/:orderId/checkout` accepts:

```json
{"provider":"SANDBOX","providerRequestId":"merchant-unique-string"}
```

It freezes the quote, creates exactly one PaymentAttempt for the provider request, changes the Order to `PAYMENT_PENDING`, and schedules `PAYMENT_RECONCILIATION`. Provider credentials are outside this project and must never be stored. A timeout or connection loss after sending a provider request produces `UNKNOWN`; it must not be treated as failure and must never trigger a second provider charge.

`POST /api/v1/payment-provider/callbacks` accepts `{providerEventId, providerRequestId, outcome, capturedMinor}` where outcome is `CAPTURED`, `DECLINED`, or `UNKNOWN`. Callback identity is durable. Duplicate and out-of-order callbacks converge by the documented precedence `CAPTURED > DECLINED > UNKNOWN`; after `CAPTURED`, a later decline cannot undo capture. Conflicting reuse of `providerEventId` returns `409 PROVIDER_EVENT_CONFLICT` without mutation.

`POST /api/v1/payment-attempts/:paymentAttemptId/reconcile` accepts `{providerQueryId, outcome, capturedMinor}` and records a provider query outcome under the same convergence rules. `providerQueryId` is durably deduplicated. Capture must atomically:

- mark the attempt captured and the Order paid;
- consume every HELD inventory allocation for physical lines;
- create one FulfillmentPlan per physical shipment group and one Entitlement Work item per digital line;
- append one balanced capture journal;
- emit one immutable event and notification.

Decline or definitive failed reconciliation releases all HELD inventory once. An UNKNOWN attempt remains retryable with bounded backoff.

### Fulfillment and digital entitlement

`FulfillmentPlan` contains frozen order lines and allocation quantities. Workers claim `FULFILLMENT` Work using a database lease and monotonically increasing fencing token. Only the current token may complete a plan. Killing a worker after claim must allow a replacement to reclaim after lease expiry without duplicate shipment, inventory consumption, Event, LedgerEntry, or notification.

Digital capture produces one `EntitlementGrant` per digital OrderLine. Its unique identity is `(orderLineId, grantRevision)`. State is `ACTIVE` or `REVOKED`; concurrent grant and revoke must converge to the Order's final financial state. A fully refunded digital line cannot retain an ACTIVE grant.

Published mutation routes:

- `POST /api/v1/fulfillment-plans/:fulfillmentPlanId/complete`
- `POST /api/v1/entitlement-grants/:entitlementGrantId/revoke`
- `POST /api/v1/orders/:orderId/cancel`
- `POST /api/v1/orders/:orderId/refunds`

A refund accepts `{amountMinor, reason, restockLines}` where `restockLines` is an optional array of `{orderLineId, quantity}` for physical units that have observably returned. Restock quantity cannot exceed the captured quantity minus prior restocks. It appends immutable refund state, returns only declared physical units to inventory, revokes proportional/full digital rights as applicable, and writes one balanced refund journal. Concurrent refunds may succeed partially, but their committed sum can never exceed captured amount.

### Balanced ledger

Every financial transition writes immutable LedgerEntries. A journal is identified by `journalId`; entries contain `tenantId`, `orderId`, `currency`, `account`, `direction`, and `amountMinor`.

```text
amountMinor > 0
for each (tenantId, journalId, currency): total DEBIT = total CREDIT
one business transition -> at most one journal of that kind
ledger rows are append-only; correction uses a new reversing journal
```

Capture posts receivable/cash and order liability/revenue according to the documented account names. Refund creates a separate reversing journal. Retrying after an unknown HTTP response returns the original journal identities.

### DomainEvent, Work, and NotificationDelivery

Business state, DomainEvent, Work, ledger, and outbox creation are committed in one PostgreSQL transaction. Events have stable `eventId`, aggregate identity, monotonic aggregate sequence, type, occurredAt, and immutable JSON payload.

Worker Work kinds are `QUOTE_EXPIRY`, `PAYMENT_RECONCILIATION`, `FULFILLMENT`, `ENTITLEMENT_GRANT`, and `ENTITLEMENT_REVOCATION`. `Work={workId,tenantId,kind,aggregateId,payloadVersion,state,attempts,availableAt,leaseOwner,leaseExpiresAt,fencingToken,terminal}`. State is `PENDING`, `LEASED`, `SUCCEEDED`, or `DEAD`; attempts and lease/fencing metadata are observable. At least-once execution may repeat delivery, but cannot repeat the business effect.

The dispatcher sends `NotificationDelivery={notificationDeliveryId,tenantId,orderId,eventId,aggregateSequence,state,attempts,bodyDigest,createdAt,deliveredAt}` bodies to `WEBHOOK_URL`. It includes a stable event ID header. If it receives a response and dies before committing the ACK, a replacement sends the exact same event ID and byte-identical body. Notification order for one Order follows aggregate sequence; another Order must not head-of-line block it.

## HTTP, errors, and idempotency

The following public paths must be implemented and documented in OpenAPI:

- `GET /api/v1/tenants`
- `GET /api/v1/products`
- `POST /api/v1/offer-versions`
- `POST /api/v1/inventory-pools/:inventoryPoolId/adjustments`
- `POST /api/v1/orders/quotes`
- `GET /api/v1/orders`
- `GET /api/v1/orders/:orderId`
- `POST /api/v1/orders/:orderId/checkout`
- `POST /api/v1/orders/:orderId/cancel`
- `POST /api/v1/orders/:orderId/refunds`
- `POST /api/v1/payment-provider/callbacks`
- `POST /api/v1/payment-attempts/:paymentAttemptId/reconcile`
- `POST /api/v1/fulfillment-plans/:fulfillmentPlanId/complete`
- `POST /api/v1/entitlement-grants/:entitlementGrantId/revoke`
- `GET /api/v1/ledger`
- `GET /api/v1/events`
- `GET /api/v1/work`
- `GET /api/v1/notifications`
- `GET /api/v1/verification-snapshot`

Every mutation requires `Idempotency-Key`, scoped by Tenant, method, and canonical route. The first successful or business-rejected result persists status and exact response body. Exact replay returns it across processes and restarts. A different canonical body returns `409 IDEMPOTENCY_CONFLICT`. Concurrent first use has one authority. Malformed JSON returns `400 MALFORMED_JSON` and creates no idempotency record.

Errors use:

```json
{"error":{"code":"STABLE_CODE","message":"human readable","details":{}}}
```

Required codes include `VALIDATION_ERROR`, `RESOURCE_NOT_FOUND`, `IDEMPOTENCY_CONFLICT`, `MALFORMED_JSON`, `INSUFFICIENT_INVENTORY`, `QUOTE_EXPIRED`, `INVALID_ORDER_STATE`, `PROVIDER_EVENT_CONFLICT`, `REFUND_EXCEEDS_CAPTURE`, `STALE_FENCE`, and `TENANT_MISMATCH` where exposing that distinction is safe to an administrator.

## Seed and verification snapshot

`db:seed` accepts one strict JSON document:

```text
{
  schemaVersion: 1,
  seedVersion,
  tenants: [], buyers: [], products: [], offerVersions: [],
  inventoryPools: [], orders: [], orderLines: [], inventoryHolds: [],
  paymentAttempts: [], fulfillmentPlans: [], entitlementGrants: [],
  ledgerEntries: [], notificationDeliveries: []
}
```

All arrays are required, unknown members are rejected, references and invariants are validated before writes, and the complete import is atomic. Exact `seedVersion` plus canonical body replay is a no-op; the same version with different content fails without mutation. Seed never invokes external effects.

`GET /api/v1/verification-snapshot` requires the admin token and returns deterministic JSON:

```text
{
  asOf,
  resources: {
    tenants, buyers, products, offerVersions, inventoryPools,
    orders, orderLines, inventoryHolds, paymentAttempts,
    fulfillmentPlans, entitlementGrants, ledgerEntries,
    notificationDeliveries
  },
  events: [],
  work: []
}
```

Arrays use the stable ordering published in OpenAPI. Volatile lease timestamps may differ, but stable identities, payloads, totals, event sequences, and terminal outcomes are deterministic.

## UI

The production React UI is not a JSON dump. It must let a user:

1. select a Tenant and Buyer without exposing another Tenant's data;
2. browse Products and the currently effective OfferVersion;
3. build a mixed physical/digital basket and create a quote;
4. inspect frozen price, tax, pool holds, expiry, and totals;
5. checkout, observe UNKNOWN payment, reconcile it, and see fulfillment or entitlement progress;
6. cancel or refund where legal and observe inventory, entitlement, ledger, event, and notification results;
7. reload each deep link and retain server-authoritative state;
8. see accessible loading, empty, conflict, validation, expired, unknown, retry, and terminal states.

Project-owned Chromium tests must interact with visible controls and verify a reload; direct API setup is allowed only for preconditions.

The production UI exposes stable test seams on the visible controls: `data-testid="tenant-select"`, `buyer-select`, `product-<productId>-add`, `create-quote`, `order-id`, `checkout`, `payment-state`, `refund-amount`, `refund-submit`, and `order-state`. These attributes are part of the public browser contract; they do not replace accessible labels or visible text.

## Project-owned verification

- Unit: money arithmetic, quote freezing, allocation ordering, state machines, callback precedence, ledger balancing, lease fencing, and canonical idempotency hashing.
- Integration: real PostgreSQL transactions for quote, capture, decline, refund, outbox, and strict seed rollback.
- Browser E2E: complete physical/digital journey, UNKNOWN reconciliation, error states, reload, and responsive production UI.
- Concurrency: two API processes plus multiple Workers race quote stock, checkout, callbacks, refunds, entitlement revoke, and fulfillment completion.
- Recovery: Barrier-controlled `SIGKILL` after Worker claim and after dispatcher response; replacement roles complete without duplicate effects.
- Performance: the seven fixed V1 scenarios below, followed by invariant validation.

## Fixed V1 performance scenarios

All scenarios use Release build, PostgreSQL 16, `BENCH_PERF_SCALE=1`, the published deterministic seed, and the stated concurrency. Warmup traffic is not measured. Report completed operations, response distribution, throughput, p50, p95, p99, process failures, drain time, and post-load invariants.

### Scenario 'quote-read-mix'

Seed 20,000 Products with immutable offers and sufficient stock. Run 64 clients for 10 seconds warmup and 60 seconds measured time with 80% product/order reads and 20% one-line quote creation. Require at least 250 responses/s and p95 at most 300ms, with every accepted quote frozen to the selected OfferVersion.

### Scenario 'checkout-contention'

Prepare 2,000 valid quotes. Run 64 clients for 60 seconds, including duplicate same-key checkout and distinct-key races for each quote. Require at least 120 responses/s and p95 at most 500ms; each Order has at most one provider operation and one captured transition.

### Scenario 'inventory-hotspot'

Use 10 hot InventoryPools and 50,000 randomized quote attempts from two API processes at concurrency 64 for 60 seconds. Require at least 150 responses/s and p95 at most 500ms. Both success and `INSUFFICIENT_INVENTORY` are valid; post-load pool equations must hold exactly.

### Scenario 'payment-unknown-reconcile'

Prepare 5,000 UNKNOWN PaymentAttempts. Reconcile them with duplicate and out-of-order callbacks at concurrency 64 for 60 seconds. Require at least 100 responses/s and p95 at most 700ms; within 120 seconds of load end all determinable attempts are terminal with at most one capture and balanced journals.

### Scenario 'fulfillment-drain'

Prepare 10,000 captured physical Orders and run four Workers. Kill one process after a claimed lease, start a replacement, and require at least 50 terminal plans/s with all Work drained within 300 seconds. No plan, shipment effect, inventory consumption, journal, or Event may duplicate.

### Scenario 'notification-unknown-ack'

Prepare 10,000 notifications, run two dispatchers, and make the receiver lose 10% of ACKs after recording the request. Kill one dispatcher at the response barrier. Require at least 100 deliveries/s and drain within 180 seconds. Retries keep byte-identical body and identity, and per-Order sequence remains ordered.

### Scenario 'entitlement-revocation-storm'

Prepare 20,000 captured digital lines and race grant, full refund, and revoke calls at concurrency 64 for 60 seconds. Require at least 150 responses/s and p95 at most 500ms. No fully refunded line remains ACTIVE, and each transition has one event and balanced journal where financial.

After every scenario, re-check tenant isolation, inventory equations, Order totals, payment bounds, ledger balance, event sequence, outbox identity, Work drain, and deterministic snapshot ordering. A fast result with a broken post-load invariant fails.

## Migration and compatibility

Schema changes are forward-only and safe for a rolling deployment. A FINAL build must open data created by the V1 snapshot, preserve all IDs and immutable payloads, return the original response for a saved V1 idempotency replay, and allow documented V1 requests during the compatibility window. Worker payloads are versioned; new Workers process old pending payloads. Unknown enum values fail closed rather than being silently rewritten.

## Out of scope

- Real card data, payment credentials, tax calculation services, carrier APIs, email/SMS providers, and cryptographic key custody.
- Multi-currency conversion inside one Order.
- Eventual correctness that temporarily violates committed inventory, refund, or ledger constraints.
- In-memory substitutes for PostgreSQL, mock browser-only UIs, placeholder performance scripts, and hidden fixture special cases.

## Final handoff

Report architecture, state and transaction boundaries, migration compatibility, exact commands run, actual test and performance results, known risks, and checks not run. Do not claim a gate passed without its real output.

## Successful response contracts

Successful response contracts are closed:

- A mutation route without a literally stated success status returns 200.
- Unless a route literally publishes another object, array, or empty body, a success described by a named resource, named resource state, or named resource fields returns that exact resource shape at the JSON top level. Any response-only fields literally named by the route are additional top-level fields.
- If a mutation publishes no success body, it returns the exact current shape of the single primary resource created or changed by that route at the JSON top level.
- When a route explicitly returns multiple named resources, the body is one object keyed by their lower-camel resource names unless the route publishes another literal shape.
- Wrappers such as `{data:...}`, `{result:...}`, or an extra single-resource envelope are invalid unless the route literally declares them. OpenAPI must publish the same success status and closed response schema as runtime.
