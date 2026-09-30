# CommerceCommand V2 — public execution protocol supplement

Public package revision: `commercecommand-2026-09-08.1`. This revision adds visible
marketplace/cross-layer browser seams and external recovery-controller forwarding;
the `2026-09-07.1` economic policy and its monetary rules are unchanged.

This document is a **new benchmark-author clarification**, not a claim that the
original README specified these wire details. It makes the original uncertain
payment, recovery, notification, and Manager performance obligations executable.
The original README and Manager requirements remain in force. This document does
not prescribe storage layout, transaction implementation, scheduling algorithms,
or settlement mathematics. The separately published economic policy defines the
latter. All experiment arms receive this same document before implementation.

## 1. Replaceable SANDBOX payment dependency

`SANDBOX_PROVIDER_URL` is optional and names a local HTTP provider service supplied
by a public test or evaluator. It is not an external SaaS dependency. No payment
credential, admin token, or barrier token is sent to it. When unset, the documented
callback and reconciliation routes remain available; absence of the dependency
must not fabricate a capture or definitive decline.

When set, checkout and payment reconciliation use these provider operations:

| Operation | Request | Successful response |
| --- | --- | --- |
| `POST /payments` | `Content-Type: application/json`, `Idempotency-Key: <providerRequestId>`, body `{tenantId,providerRequestId,amountMinor,currency}` | HTTP 200, `{providerRequestId,outcome,capturedMinor}` |
| `GET /payments/:providerRequestId?tenantId=<tenantId>` | Percent-encode the path component and query value. | HTTP 200, the same result shape; HTTP 404 means the provider has no operation under this identity. |

`amountMinor` is the frozen Order total. `outcome` is `CAPTURED`, `DECLINED`, or
`UNKNOWN`. A non-capture has `capturedMinor: 0`; a capture has the requested amount.
Objects are closed. The provider operation identity is
`(tenantId,providerRequestId)`, not the request ID alone. Replaying the same identity
and body returns its saved result without another charge; conflicting body reuse
returns HTTP 409 with the standard error envelope and code
`PROVIDER_REQUEST_CONFLICT`.

The provider's current saved result may move from UNKNOWN to a definitive outcome;
an exact POST replay and a GET then report that same current result. Once captured,
a later transport failure cannot turn capture into failure. The application still
enforces the original callback/query deduplication and outcome precedence.

A test provider can durably accept a POST, record at most one charge, and close the
connection before sending its response. The application must then retain UNKNOWN
and reconcile this **same** provider operation; it must not create a replacement
request identity. A GET connection failure, malformed response, or 404 does not
prove a previously sent charge failed. A definitive decline must come from an
explicit provider result. Repeated provider observations cannot duplicate capture,
inventory consumption, journals, Work, Events, or notifications.

Fault schedules belong to the test provider, not to a production mutation route or
hidden fixture name inside the submitted application. Public tests may configure
that service out of band to accept-and-disconnect, disconnect before acceptance,
return UNKNOWN, or later return a definitive result. The application sees only the
HTTP protocol above. A fault-control log must distinguish acceptance from response
delivery so the test can demonstrate the UNKNOWN case rather than assume it.

## 2. Controlled recovery barriers

Enable barriers only when **both** `TEST_BARRIER_URL` and `TEST_BARRIER_TOKEN` are
nonempty. POST to that exact URL with `Content-Type: application/json` and
`Authorization: Bearer <TEST_BARRIER_TOKEN>`. The token is sent only to this URL;
never log, persist, or copy it into a payload, provider request, or webhook.

Worker barrier bodies are closed objects:

```text
{
  point: "worker.claimed" | "worker.before-effect",
  role: "worker",
  kind: <the published Work kind>,
  workId: <Work UUID>,
  aggregateId: <Work aggregate UUID>,
  attempt: <positive integer claim attempt>,
  fencingToken: <positive integer current token>
}
```

- `worker.claimed`: after the lease and fencing token commit, before executing the
  claimed business effect. A controller can now kill this Worker and observe a
  replacement reclaim after lease expiry.
- `worker.before-effect`: immediately before the attempted effect. A released
  barrier is not lease authority: the implementation must still validate its
  current lease/token at the effect's commit point.

Dispatcher barrier bodies are closed objects with their own real delivery identity:

```text
{
  point: "dispatcher.response-received",
  role: "dispatcher",
  notificationDeliveryId: <delivery UUID>,
  eventId: <event UUID>,
  aggregateId: <Order UUID>,
  attempt: <positive integer delivery attempt>,
  fencingToken: <positive integer current delivery lease token>,
  responseStatus: <integer HTTP status 100..599>
}
```

Call this immediately after a webhook HTTP response and before persisting its ACK.
The controller may hold the barrier response, kill that dispatcher, and start a
replacement. Do not invent a Work row or Work ID for a delivery merely to call a
barrier.

Any HTTP 2xx releases the barrier; its body is ignored. Until release, the paused
attempt cannot continue to its next effect or ACK. A barrier failure cannot be
treated as permission to proceed: leave recoverable durable state, and do not mark
an uncommitted effect or ACK successful. The replacement uses normal lease and
fencing rules. When barriers are disabled, there is no barrier request or alternate
business path. These are observability seams, not test-specific implementations.

### Project-owned recovery verification controller

When `npm run test:recovery` receives both `TEST_BARRIER_URL` and
`TEST_BARRIER_TOKEN` from its caller, it must forward those exact values to the
production Worker and dispatcher it exercises. It must not replace or bypass that
external controller. Both `worker.claimed` and
`dispatcher.response-received` must actually be reached with the authenticated
public payload above, and the command must perform the required kill/replacement
verification before reporting success. Without an external controller, the test
may create its own controller using the same public protocol.

An unreachable controller, rejected authorization, non-2xx barrier response, or
failure to reach either required barrier makes this verification unsuccessful:
the command must exit nonzero, never print a successful recovery result and skip
the broken seam. This does not grant the controller permission to implement any
business effect or supply hidden test answers.

### Visible marketplace and cross-layer browser seams

These stable `data-testid` values name visible, accessible production React
controls or displayed business results. They define no page layout or internal
implementation. They extend the existing V1 browser seams; hidden controls, JSON
dumps, direct browser-script HTTP calls, and hard-coded successful responses are
not a substitute for these user interactions. The selected Order and settlement
must remain server-authoritative after reloading their deep link.

- The selected Order shows `order-total-minor`, `order-captured-minor` and
  `order-refunded-minor` as base-10 integer minor units. Existing `order-id`,
  `order-state` and `payment-state` display their current public identity/state.
- `allocation-add-row` appends an editable row numbered from zero. Row `N`
  contains select controls `allocation-line-N` and `allocation-seller-N` whose
  option values are public OrderLine/Seller UUIDs, and numeric inputs
  `allocation-quantity-N` and `allocation-amount-minor-N`.
  `seller-allocations-submit` sends the complete set for the selected Order.
  Persisted rows are visible as `seller-allocation-<sellerAllocationId>`.
- `settlement-seller` is a Seller UUID select. `settlement-period-start` and
  `settlement-period-end` accept the published RFC3339 UTC strings;
  `settlement-currency` accepts the ISO currency. `settlement-create` creates the
  proposal and displays `settlement-id`. `settlement-close` closes that proposal.
  Display `settlement-state`, `settlement-gross-minor`, `settlement-fee-minor`,
  `settlement-refund-reserve-minor`, `settlement-dispute-reserve-minor` and
  `settlement-net-minor` using the returned public state/base-10 minor units.
  Frozen allocation members are visible as
  `settlement-allocation-<sellerAllocationId>`.
- Dispute creation uses `dispute-payment-attempt` (UUID),
  `dispute-provider-id` (public opaque ID), `dispute-amount-minor` and
  `dispute-create`; the result displays `dispute-id` and `dispute-state`.
  `dispute-provider-event-id`, `dispute-outcome` (WON/LOST select) and
  `dispute-resolve` resolve the selected dispute.
- Adjustment creation uses `adjustment-seller` (Seller UUID select),
  `adjustment-source-settlement` and `adjustment-source-allocation` (UUID inputs),
  `adjustment-amount-minor`, `adjustment-reason` and `adjustment-create`.
  Display `adjustment-id` and `adjustment-target-period-start` from the persisted
  result. Do not derive a different target period in the browser.

The selected Tenant supplies `tenantId` for these forms; all other values map to
the already published mutation bodies. Inputs and submit controls must be
keyboard usable and labelled; selectors may never expose another Tenant's
resources. Errors must be visible and must not turn a rejected API mutation into
a successful UI state. These seams expose the existing marketplace operations;
they do not provide allocation, settlement, reserve or adjustment implementations.

## 3. Immutable notification wire body

The dispatcher POSTs the published `NotificationDelivery` shape to `WEBHOOK_URL`
with these headers:

```text
Content-Type: application/json
X-Event-Id: <eventId>
X-Aggregate-Sequence: <base-10 aggregateSequence>
```

HTTP header names are case-insensitive. Their values must agree with the body.
Any HTTP 2xx is an ACK; connection loss and all other statuses leave delivery
retryable under the original durable retry requirements.

The wire body is a **frozen notification**, not a freshly serialized copy of the
mutable delivery-status projection. At its creation use the stable identities,
sequence, and creation time with `state: "PENDING"`, `attempts: 0`, and
`deliveredAt: null`. These wire fields remain frozen even when the corresponding
database/snapshot fields report later attempts or delivery success. Actual attempt
numbers are observable in the database projection and barrier, not by mutating a
retry's body.

Canonical JSON means recursively sorting object keys by JavaScript UTF-16 code-unit
order, preserving array order, then using `JSON.stringify` without whitespace and
encoding as UTF-8. This notification's field names are ASCII. No undefined values,
non-finite numbers, or duplicate JSON keys are allowed. Timestamps are the published
UTC string form; do not parse and reformat a saved notification during retry.

1. Canonicalize the frozen body **without** the `bodyDigest` member.
2. Compute lowercase hexadecimal SHA-256 of those UTF-8 bytes.
3. Add that value as `bodyDigest`, canonicalize the complete body once, and retain
   those exact bytes for delivery and every retry.

`bodyDigest` deliberately excludes itself; it is not a self-referential hash of the
complete body. An ACK lost after the receiver records a request must lead to the
same event ID and byte-identical complete body. The receiver may deduplicate by
event ID. Per-Order aggregate ordering and independent progress for other Orders
remain mandatory.

## 4. Reproducible Manager performance starting points

Keep all seven original V1 scenarios and all three Manager scenarios. Their
published sizes, concurrency, measured durations, rates, latency bounds, drain
deadlines, and post-load invariants are unchanged. This section fills in workload
construction, not implementations or expected fixture answers.

### Shared conventions

- Use a fresh PostgreSQL 16 database, production build, and `BENCH_PERF_SCALE=1` for
  each scored scenario. Preparation and warmup are outside the measurement window.
- Use deterministic UUIDs and operation keys generated from a published scenario
  seed and record ordinal. Log the seed, chosen UTC reference instant, process
  topology, and dataset counts. Do not branch on fixed UUIDs in application code.
- Distribute records round-robin across 10 Tenants; each Tenant has distinct Buyers,
  Products, offers, and Sellers. Use one currency per Order. No resource reference
  crosses a Tenant. Amounts and time ranges satisfy the separately published
  economic policy, and preparation independently verifies those preconditions.
- Generate linked input through the strict public seed and/or public mutations.
  Preparation may not inject implementation-specific SQL or precompute responses
  that should be produced by the measured operations.
- Measured HTTP latency starts immediately before sending a request and ends when
  its full response body is received. Count completed responses in the fixed window;
  separately report success, documented business rejection, transport failure, and
  unfinished requests. Report throughput, p50/p95/p99, process failures, drain time,
  and post-load invariants. No fabricated success or test-script exit alone counts.
- A valid request rejected for an allowed contention outcome can count as a completed
  mutation response; malformed input, missing routes, unexpected status, or server
  errors cannot satisfy the required rate. Report accepted mutations separately.
- Read committed state after load/drain and independently validate inventory,
  capture/refund/reserve bounds, immutable settlements, balanced journals, Event and
  notification identity/order, Work terminal state, and Tenant isolation.

### `seller-settlement-close`

Prepare exactly 50,000 eligible SellerAllocations, evenly distributed across the
10 Tenants, each belonging to a distinct Seller/period settlement. Use 50,000
distinct Sellers and prepared OPEN settlements, one eligible allocation each, so
the workload cannot exhaust a small set of settlements before the measurement
window. Include physical and digital Orders equally; establish actual captured
payments and immutable allocation sets before measurement. Settlement periods and
eligibility come from the economic policy, not from private test assumptions.

Run two API processes and the required Worker roles. For 60 seconds, 64 clients take
the next unclosed settlement in deterministic order and submit its close mutation
with a distinct stable operation key, balanced between the two API processes.
This scenario measures distinct close requests, not repeated cached replay of an
already closed settlement. Require at least **80 settlements/s**, **p95 ≤ 750ms**.
The settlement rate counts distinct transitions to CLOSED committed within the
60-second measurement window; HTTP latency measures the close request/response.
After admitted Work drains, verify every acknowledged close, at-most-once inclusion
of each allocation in a CLOSED settlement, frozen values, and all money/reserve
invariants. If the implementation returns asynchronous Work, HTTP acceptance and
terminal settlement completions must be reported separately; acceptance alone is
not evidence that a settlement closed.

### `refund-dispute-race`

Prepare exactly 20,000 captured Orders, evenly distributed across 10 Tenants and
physical/digital fulfillment kinds. Each Order has two Sellers with a conserved
allocation set. Establish deterministic batches of legal refund and dispute inputs
using the published reserve and refund policy. Maintain distinct operation keys,
and deliberately overlap calls targeting the same captured Order; unrelated Orders
must also be present so one global hot Order does not define the entire workload.

Run two API processes and 64 clients for **60 seconds**. Each per-Order batch starts
one refund and one dispute-open concurrently. After an open is acknowledged, submit
its resolution (alternate WON/LOST by Order ordinal); do not issue a resolution for
an unknown dispute ID. Half the batches have a combined requested amount within the
capture bound; half exceed it so the real race must enforce the published bound.
Generate amounts from each Order's captured amount and the public economic policy,
not arbitrary out-of-range or malformed requests. Revisit Orders only while a new
legal or intentionally contending mutation remains; replenish from the prepared
20,000-Order set rather than benchmarking only idempotency replays.

Require at least **100 mutation responses/s**, **p95 ≤ 750ms**. Report refund,
dispute-open, and resolution counts separately. Verify conservation after every
batch and after the full load, exactly-once LOST financial effects, WON reserve
release, immutable closed periods, and correctly attributed later adjustments.

### `full-catastrophe-recovery`

The public dataset manifest contains exactly **10,000 primary flow entities**:
2,000 QUOTED Orders; 2,000 PAYMENT_PENDING Orders with UNKNOWN attempts; 2,000
captured physical Orders; 2,000 captured digital Orders; 1,000 OPEN
SellerSettlements with eligible allocations; and 1,000 OPEN CommerceDisputes.
Their referenced Tenants, Buyers, Products, offers, pools, lines, allocations,
journals, Events, Work, and notifications are required linked supporting records
and are counted separately. Settlement/dispute subsets reference captured Orders;
they do not require inventing further primary Order counts. No seed step sends
external effects.

Start two API processes, two Workers, and two dispatchers. Use 64 clients cycling
through valid checkout, provider observation/reconciliation, fulfillment,
notification-producing mutation, settlement close, and dispute resolution work,
with equal scheduled shares and dependencies supplied from the manifest. Do not
pretend a direct write to Work/outbox is a public business mutation. The local
provider and webhook receiver stay alive independently of application processes.

After 10 seconds of active load, hold one Worker at `worker.claimed` and one
dispatcher at `dispatcher.response-received`; while both are held, SIGKILL those
two processes and one API process. Immediately start their replacements against
the same database. Keep client load active for a further 10 seconds, then stop new
requests and let admitted work drain. Record kill and replacement times; count the
original **300-second** recovery deadline from the kill, including the remaining
10 seconds of admitted load. Provider outcomes for all admitted UNKNOWN attempts
become definitive and the webhook receiver ACKs retries, so permanent external
unavailability cannot be mistaken for a recovery bug.

Evaluation clarification (2026-09-10): “active load” requires all six real client categories to have started, not all six to have completed a first request within ten seconds. In-flight claim acquisition is allowed. Errors still fail the case; actual Worker/dispatcher barriers, post-crash new work in all six categories, and the original recovery deadline and invariants remain mandatory.

By that deadline, admitted resolvable Work/outbox must drain and all original V1 and
marketplace invariants must hold. Verify that replacements, not just surviving
processes, actually claimed/completed work. Also demonstrate a stale pre-kill
fencing token cannot commit a business effect. If either requested barrier was
never reached or a target process was not killed, report setup failure; do not
claim that a recovery test ran.
