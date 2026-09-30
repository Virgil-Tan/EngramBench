# CommerceCommand — V2 fixed public interface

Author scaffold revision 2026-09-10.ui-entry.1: exact decimal validation, incremental seed-file decoding, and implementation-owned browser document query state. This is a revised public scaffold, not the unchanged historical evaluation environment. Business requirements and seed scale remain unchanged.

Business requirements: read the COMPLETE ../docs/frontal-legacy/README.md and manager-requirements.md. The files are preserved verbatim. The wire clarifications below override only ambiguous representations, never remove business requirements.
Public author policy revision commercecommand-2026-09-08.1: read the supplements below in full. They resolve explicitly identified business-policy and test-protocol omissions; only an explicitly named author-approved exception overrides a corresponding original rule, and every other original obligation remains in force. This revision must not be compared as an unchanged historical benchmark.

## Implementation seam

- Implement all operations behind src/implementation.ts; use src/operation-ids.ts and contract.json for exact IDs, schemas, status codes and examples. Split internal modules freely.
- Implement migrations, database seed, worker/dispatcher roles, real UI build and project-owned verification in src/lifecycle.ts. Throwing stubs are deliberate: compilation is not business completion.
- The API process awaits optional src/implementation.ts exports start() before listening and stop() when terminating. Use these for pools and any background work required inside npm start (notably LaunchPass expiration/promotion). They may delegate to your own lifecycle modules; do not keep them only in the build command.
- contract/ is author-owned. Do not edit its router/checker/contract or the README to make tests pass. You may add modules, dependencies, UI assets and your own tests.
- Raw uploads arrive as RequestContext.stream; consume them incrementally. Raw download responses may be Buffer, string or readable stream. The router does not implement file persistence.
- Additional UI endpoints may use publicExtensions; published operation IDs/method/path cannot be replaced.

## Contract and examples

- contract.json is the single wire source. openapi.json is generated from it, not separately handwritten.
- The fixed HTTP server listens on 0.0.0.0; contract.httpHost preserves any task-specific bind requirement. PORT selects its port.
- transportErrors preserves task-specific HTTP error codes. Otherwise V2 wire defaults are INVALID_REQUEST/400, MALFORMED_JSON/400, UNAUTHORIZED/401, NOT_FOUND/404 and UNSUPPORTED_MEDIA_TYPE/415; domain resource errors still follow the complete README.
- seed.example.json is a legal NONEMPTY seed. Its replay rule and argv are under contract.seed; do not guess db:seed versus seed.
- contract/seed-reader.mjs exports readSeedJsonFile(path): incremental JSON decoding without a whole-file string. The author seed command still validates the entire decoded value against the public schema before invoking your lifecycle. You may reuse this reader in your own importer; foreign keys, digests, duplicate rules and atomic import remain your responsibility. The decoded object tree still occupies memory, and a single JSON string remains subject to the JavaScript engine string limit; this helper is not a database importer.
- operation.example values are independent wire examples, not a complete executable business sequence. smoke contains an ordered public live sequence with captured identifiers.
- A smoke signatures entry constructs a lowercase-hex HMAC-SHA256 request field: {target:["headers"|"body","existingField"],key:"public fixture key",message:"published UTF-8 signing line"}. Captured variables are expanded first; body fields are signed before JSON serialization. This is a public client helper, never server-side authentication or business implementation.
- npm run check:contract-source only verifies author file integrity and schema construction.
- npm run test:public-contract uses a DISPOSABLE database, builds, migrates, imports the seed, starts the real API/roles, then checks nonempty identities and live operations. Do not point it at a valuable database.
- Public failures identify the failed command stage and retain its exit code/stdout/stderr. A probe blocked by an earlier failed identifier capture is reported as blockedBy, not as an independent implementation failure. Fix the first failure, then rerun the public check.
- HTTP probe failures identify method/path, expectedStatus, actualStatus and a named errorCode when available; they do not dump credentials or signatures. The official Harness reruns this author-owned check in an isolated copy before freezing; failed public checks return to the same Coding Agent for repair, while infrastructure errors stop the check without becoming business scores.
- Passing public checks proves only the published example wiring. It does not certify full business requirements, security, recovery, UI or performance, and does not replace the final README audit.
- The official Harness runs the author-owned checker against an isolated copy before freezing. A public failure is feedback, not a hidden business score.

## Published operations

| ID | Method / path | Source |
| --- | --- | --- |
| getUi | GET / | contract/README.md (V2 wire clarification) |
| getOpenApi | GET /openapi.json | docs/frontal-legacy/README.md#required-stack-and-delivery |
| getHealth | GET /healthz | docs/frontal-legacy/README.md#required-stack-and-delivery |
| listTenants | GET /api/v1/tenants | docs/frontal-legacy/README.md#http-errors-and-idempotency |
| listProducts | GET /api/v1/products | docs/frontal-legacy/README.md#http-errors-and-idempotency |
| createOfferVersion | POST /api/v1/offer-versions | docs/frontal-legacy/README.md#product-and-immutable-offerversion |
| adjustInventoryPool | POST /api/v1/inventory-pools/:inventoryPoolId/adjustments | docs/frontal-legacy/README.md#http-errors-and-idempotency |
| createQuote | POST /api/v1/orders/quotes | contract/README.md (V2 wire clarification) |
| listOrders | GET /api/v1/orders | docs/frontal-legacy/README.md#http-errors-and-idempotency |
| getOrder | GET /api/v1/orders/:orderId | contract/README.md (V2 wire clarification) |
| checkoutOrder | POST /api/v1/orders/:orderId/checkout | docs/frontal-legacy/README.md#checkout-and-uncertain-payment |
| cancelOrder | POST /api/v1/orders/:orderId/cancel | contract/README.md (V2 wire clarification) |
| refundOrder | POST /api/v1/orders/:orderId/refunds | docs/frontal-legacy/README.md#fulfillment-and-digital-entitlement |
| recordPaymentCallback | POST /api/v1/payment-provider/callbacks | contract/README.md (V2 wire clarification) |
| reconcilePaymentAttempt | POST /api/v1/payment-attempts/:paymentAttemptId/reconcile | contract/README.md (V2 wire clarification) |
| completeFulfillmentPlan | POST /api/v1/fulfillment-plans/:fulfillmentPlanId/complete | docs/frontal-legacy/README.md#fulfillment-and-digital-entitlement |
| revokeEntitlementGrant | POST /api/v1/entitlement-grants/:entitlementGrantId/revoke | docs/frontal-legacy/README.md#fulfillment-and-digital-entitlement |
| listLedger | GET /api/v1/ledger | docs/frontal-legacy/README.md#http-errors-and-idempotency |
| listEvents | GET /api/v1/events | docs/frontal-legacy/README.md#http-errors-and-idempotency |
| listWork | GET /api/v1/work | docs/frontal-legacy/README.md#http-errors-and-idempotency |
| listNotifications | GET /api/v1/notifications | docs/frontal-legacy/README.md#http-errors-and-idempotency |
| getVerificationSnapshot | GET /api/v1/verification-snapshot | docs/frontal-legacy/README.md#seed-and-verification-snapshot |
| setSellerAllocations | POST /api/v1/orders/:orderId/seller-allocations | docs/frontal-legacy/manager-requirements.md |
| createSellerSettlement | POST /api/v1/seller-settlements | docs/frontal-legacy/manager-requirements.md |
| closeSellerSettlement | POST /api/v1/seller-settlements/:sellerSettlementId/close | docs/frontal-legacy/manager-requirements.md |
| createCommerceDispute | POST /api/v1/commerce-disputes | docs/frontal-legacy/manager-requirements.md |
| resolveCommerceDispute | POST /api/v1/commerce-disputes/:commerceDisputeId/resolve | contract/README.md (V2 wire clarification) |
| createSettlementAdjustment | POST /api/v1/settlement-adjustments | docs/frontal-legacy/manager-requirements.md |

## Explicit V2 wire clarifications

- The complete unchanged README and Manager requirements are business authority. These V2 schemas author the omitted public representations from those requirements, without using hidden fixtures or prior submissions. Transport clarifications do not supply transactions, provider integration, inventory allocation, leases, or recovery algorithms.
- V2 wire clarification: GET /healthz returns 200 {status:"ok"}, GET / returns production HTML, and GET /openapi.json returns OpenAPI 3.1. GET /api/health is not additionally required. Success status is 200 except quote creation (201). Each successful mutation returns its named primary resource; seller-allocations returns the array of frozen SellerAllocation records.
- V2 wire clarification: collection GETs return JSON arrays, without an extra envelope. Optional tenantId filters the collection; orders also accept buyerId and state, products accept kind. No pagination keys are defined: these endpoints return all matching records. Unknown query keys are rejected. Resource arrays sort by their public identity field ascending; notifications sort by orderId, aggregateSequence, notificationDeliveryId; events sort by aggregateId, aggregateSequence, eventId; Work sorts by workId.
- V2 wire clarification: Authorization uses Bearer credentials. ADMIN_TOKEN identifies an administrator. Tenant credential provisioning is implementation-owned and must be documented; a tenant-authenticated request cannot expand its scope. X-Tenant-Id is an optional explicit scope selector, not a credential, and cannot override authenticated scope. Any provided invalid credential returns 401 UNAUTHORIZED. Snapshot always requires ADMIN_TOKEN. Business requests without credentials must still enforce the documented Tenant ownership of all body/path references; anonymous access must not be treated as an authenticated foreign Tenant.
- Every mutation requires Idempotency-Key, scoped by Tenant, method, and canonical route. First success or business rejection persists exact status/body; exact replay survives restart; changed canonical body returns 409 IDEMPOTENCY_CONFLICT. MALFORMED_JSON returns 400 and creates no replay record.
- V2 wire clarification: quote returns Order fields plus lines containing frozen OrderLine fields and allocations:[{inventoryPoolId,quantity}]. GET Order and cancellation return Order. Checkout, callback and reconciliation return PaymentAttempt. Refund returns immutable Refund with journalId and observed restockLines. Fulfillment completion returns FulfillmentPlan and takes {fencingToken}; the current token is visible in Work and the claimed plan. Entitlement revocation and cancellation take {}.
- V2 wire clarification: offer creation supplies tenantId, productId, currency, unitPriceMinor, taxMinor, fulfillmentKind, effectiveFrom, effectiveUntil and state; the server assigns offerVersionId and next version. Inventory adjustment takes {delta,reason}, where delta is a signed safe integer change to onHand. Reserved inventory cannot be removed. Resource IDs and server-generated states are never accepted as extra create fields.
- Operation examples show individual legal wire representations, not an ordered workflow: referenced Orders, lines, attempts, grants and settlements must already exist in the required domain state. Only the ordered smoke list specifies a runnable seed-to-request sequence and captures real generated identities. Examples do not authorize bypassing foreign-key, Tenant or lifecycle validation.
- Internal identifiers follow the global UUID rule. providerRequestId is the published merchant-unique-string exception. The v4 wire clarification makes providerEventId and providerQueryId opaque strings as used by the transport callers; this explicitly narrows the legacy blanket UUID statement for external provider references. ISO currency membership, cross-row references, unique quote Product IDs, monetary equations, immutable terms, tenant isolation, fencing, and transactional convergence remain domain checks beyond these structural schemas.
- V2 wire clarification: seed schemaVersion remains 1 and seedVersion is a string. The original required arrays remain required. Optional explicitly named sellers, sellerAllocations, sellerSettlements, commerceDisputes, settlementAdjustments and refunds arrays default to empty on import, preserving old V1 seed clients. Snapshot.resources always includes those six arrays as well as the V1 arrays. Unknown members are rejected. Seed replay, full validation, foreign keys and atomicity remain business obligations.
- V2 wire clarification: all resource row fields and nullability are enumerated in the schemas. PaymentAttempt state is PENDING, UNKNOWN, CAPTURED or DECLINED; FulfillmentPlan is PENDING or COMPLETED. SellerSettlement is OPEN or CLOSED; CommerceDispute is OPEN, WON or LOST. LedgerEntry uses ledgerEntryId, and DomainEvent uses aggregateSequence and type. Lease owner/expiry, completion times and deliveredAt are null before their applicable transition. payloadVersion is a positive integer, terminal is boolean. Event payload and error details explicitly permit arbitrary JSON objects subject to secret redaction; resource records do not.
- The public policy supplement 2026-09-07.1 below explicitly authors previously omitted economic choices. It is part of this new package revision, not a retroactive interpretation of historical experiments. Published conservation, immutable close and reserve bounds remain fully required; no private alternative policy may be scored.
- The public chain imports one Tenant, Buyer, physical Product, active OfferVersion and InventoryPool into a clean database. It creates a two-unit quote, captures returned Order/OrderLine IDs and expiry, observes HELD inventory and captures its ID, cancels via that Order ID, reads CANCELLED Order detail and verifies the same durable rows with a RELEASED hold and unchanged onHand. The one-hour hold TTL keeps this bounded chain independent of background expiry timing. Array expectations have exact length; object expectations are partial. No volatile Work, notification, or event scheduling state is asserted.
- Required public errors include VALIDATION_ERROR, RESOURCE_NOT_FOUND, IDEMPOTENCY_CONFLICT, MALFORMED_JSON, INSUFFICIENT_INVENTORY, QUOTE_EXPIRED, INVALID_ORDER_STATE, PROVIDER_EVENT_CONFLICT, REFUND_EXCEEDS_CAPTURE, STALE_FENCE and TENANT_MISMATCH. Manager adds 409 ALLOCATION_NOT_CONSERVED, 409 RESERVE_EXCEEDS_CAPTURE and 409 SETTLEMENT_CLOSED. The error details members are not enumerated.
- Marketplace invariants remain binding: one immutable conserved allocation set per Order, same Tenant, no reassignment after fulfillment; CLOSED settlements immutable; refund plus dispute reserve bounded by capture; LOST charges back once, WON only releases reserve; adjustments persist targetPeriodStart at or after the source periodEnd in the next open period.
- Defaults: PORT=3000; WORK_LEASE_SECONDS is integer 1..300, default 30; WEBHOOK_URL may be absent but dispatcher stays alive and retries; BENCH_PERF_SCALE is test-only (0,1], scored runs use 1. Tokens must not be logged; TEST_BARRIER_TOKEN must not be persisted.
- db:migrate is repeatable; all start commands are long-running production roles. test:all includes every non-performance gate. Preserve seven V1 performance scenarios and add seller-settlement-close, refund-dispute-race, full-catastrophe-recovery with the exact published thresholds; this structural contract does not replace those gates.
- V2 wire defaults: malformed JSON is 400 MALFORMED_JSON; invalid/unknown body fields and query/path/header values are 400 VALIDATION_ERROR; unknown routes are 404 RESOURCE_NOT_FOUND; unsupported request media is 415 UNSUPPORTED_MEDIA_TYPE; invalid credentials are 401 UNAUTHORIZED. Domain error precedence and statuses explicitly required by README are unchanged. Browser deep links and tenant credential provisioning remain implementation-owned routes.
- ## CommerceCommand public policy supplement — 2026-09-07.1

This is a new benchmark-author specification, not a claim that the original README already defined these choices. It fills the original economic-policy omissions. It applies equally to all arms using this package revision; historical submissions/results are not retroactively comparable. The original README and Manager requirements remain binding. Internal architecture and implementation are unrestricted.

### Monetary basis and deterministic allocation

All calculations use exact integer minor units. An Order may have only one successful capture effect; provider replay never adds another capture. Its frozen line totals sum to `orderTotalMinor`. The initial seller-allocation set must conserve both quantity and money separately for every line: quantities sum to the line quantity and amounts sum to `lineTotalMinor`. All Sellers and references belong to the Order's Tenant. A second distinct allocation set is rejected with `409 INVALID_ORDER_STATE`; identical idempotency replay returns the original records. An allocation set may be installed before fulfillment; completing any physical fulfillment or activating any digital grant prevents first installation or replacement. Once installed it is immutable.

The refund API names an amount, not the lines receiving that amount. The public allocation convention is therefore a **cumulative waterfall**, not an unpublished proportional rule: sort OrderLines by `orderLineId` ascending and allocate the Order's captured amount up to each frozen `lineTotalMinor`, carrying the remainder to the next line. Allocate cumulative refunds over those captured line shares in the same order, capped by each captured share. Within a line, allocate its captured share over SellerAllocations sorted by `(sellerId, sellerAllocationId)`, capped by `amountMinor`; refunds and retained dispute amounts consume those captured seller shares in that order. Refund money is allocated first; then disputes in `providerDisputeId` order. Recompute the cumulative projection, never round each request independently. Explicit `restockLines` changes only physically returned inventory and does not change this financial allocation convention.

Reject any new refund or OPEN dispute for which `refundedMinor + sum(amountMinor of OPEN or LOST disputes) > capturedMinor` would hold, using `409 REFUND_EXCEEDS_CAPTURE` for the refund-only bound and `409 RESERVE_EXCEEDS_CAPTURE` for the combined bound. WON disputes no longer retain funds. Concurrent operations must enforce these equations at commit, not only before writing. Refunds are positive and immutable; no successful refund record may exceed the amount actually committed.

### Digital partial refunds

One grant still represents one digital OrderLine; do not invent one grant per unit. Let `C` be that line's captured share, `R` its cumulative refunded share and `Q` its quantity. The remaining licensed quantity is `0` when `C=0`, otherwise `Q - floor(Q * R / C)`. A financial-state grant is ACTIVE while this quantity is positive and REVOKED when it reaches zero. Explicit manual revocation always takes precedence and cannot be undone by a delayed grant worker. UI must show the remaining rights; it may derive this quantity from the public financial records. Full Order refund therefore leaves no ACTIVE digital grants. Repeated Work must not create a new grant revision merely to undo revocation.

### Settlement eligibility and close

`periodStart < periodEnd`. Periods are half-open UTC accounting **batch labels**, not an implicit capture-time filter: the original wire contract has no capture timestamp. At the close transaction, an eligible SellerAllocation is one belonging to the same Tenant, Seller and currency, whose Order has a positive captured share for it, and which is not already in another CLOSED settlement. Refunded or disputed captured allocations remain eligible, with the deductions below. Uncaptured allocations are ineligible. An OPEN settlement is a proposal; eligibility and all projections freeze together only when close succeeds. A close with no eligible allocations or adjustments succeeds as an empty, zero-valued batch. Allocation IDs are sorted ascending. Each allocation can enter at most one CLOSED settlement, even when separate OPEN proposals close concurrently. Repeated close of an already CLOSED settlement returns the unchanged resource.

Multiple OPEN proposals, including overlapping batch labels, are permitted. Allocation and adjustment consumption is serialized at close; overlap never authorizes a second inclusion or deduction.

For a CLOSED settlement:

- `grossMinor` is the sum of the eligible allocations' captured shares, before refunds and disputes.
- The benchmark fee is **200 basis points (2%) of gross**, charged once per settlement and rounded half-up: `feeMinor = floor((grossMinor * 200 + 5000) / 10000)`. Use exact arithmetic for the multiplication.
- `refundReserveMinor` is the sum of their cumulative refund shares at close.
- `disputeReserveMinor` is the sum of their cumulative OPEN **or LOST** dispute shares at close. The field means funds withheld from the seller; LOST changes a contingent hold into a permanent loss, not a second deduction. WON contributes zero.
- `netMinor = grossMinor - feeMinor - refundReserveMinor - disputeReserveMinor + includedAdjustmentMinor`.
- `includedAdjustmentMinor` is the signed sum of not-previously-consumed adjustments for this Seller/currency whose `targetPeriodStart` belongs to this half-open period. Inclusion is durable and exactly once. Negative net is legal; do not clamp it to zero.

Example authored for the public specification: captured gross 1,001, refund share 100, retained dispute share 50 and an included adjustment of -7 gives fee 20 and net 824. No undisclosed fee tier, payout threshold, capture-date cutoff or alternative rounding may be used by the evaluator.

### Disputes and late adjustments

`providerDisputeId` identifies one dispute within a Tenant; a repeated identical create returns that dispute, and a conflicting reuse is `409 PROVIDER_EVENT_CONFLICT`. An OPEN dispute may resolve to WON or LOST once. Duplicate `providerEventId` with the same body is a no-op; conflicting reuse or an opposite terminal outcome is `409 PROVIDER_EVENT_CONFLICT`. LOST writes one balanced chargeback journal and one durable seller-liability effect; WON releases the retained amount and does not write a chargeback. Worker retries and reversed arrival order cannot duplicate these effects.

Closing a settlement never edits its allocations or projections afterwards. A later refund or dispute outcome produces immutable adjustments per affected original allocation, equal to the change in seller entitlement **not already withheld at close or reflected by earlier adjustments**. Thus a LOST dispute already reserved in the closed batch needs a zero-valued liability acknowledgement, not a second debit; WON returns the previously withheld share. An unreserved late loss produces a negative adjustment. Before an allocation has entered a CLOSED settlement, its current refund/dispute projection is sufficient; do not fabricate a source settlement just to create an adjustment.

An explicit correction uses the published adjustment request and must reference a CLOSED settlement and one of its allocation IDs with matching Tenant/Seller. Reject invalid state with `409 INVALID_ORDER_STATE` and foreign references according to the published Tenant rules. The next open period is the matching Seller/currency OPEN settlement with the earliest `periodStart >= source.periodEnd` (ties by settlement ID). Set `targetPeriodStart` to that start; if none exists, persist it as `source.periodEnd`, ready for the next period that contains that timestamp. A correction cannot target a closed period. Closing consumes each eligible adjustment once. Distinct correction keys are distinct business requests; retrying a key is not a second correction.

### Ledger account names

Publish the following exact account convention: capture debits `CASH` and credits `ORDER_LIABILITY`; refund reverses those accounts; LOST chargeback debits `ORDER_LIABILITY` and credits `CASH`. Each financial transition has a distinct journal identity and positive entries balanced per Tenant/currency. Zero-valued acknowledgements do not manufacture zero-valued LedgerEntries. Seller settlement projections and adjustments track payout entitlement; they must not post a second refund or chargeback cash effect. Additional internal account detail is allowed only if these observable financial effects remain conserved.

### Error mapping and policy precedence

Invalid period bounds, unknown fields, invalid money/quantity types and other structurally invalid values are `400 VALIDATION_ERROR`. Missing resources are `404 RESOURCE_NOT_FOUND`. Published conflict codes (`ALLOCATION_NOT_CONSERVED`, `RESERVE_EXCEEDS_CAPTURE`, `SETTLEMENT_CLOSED`, `STALE_FENCE`, `QUOTE_EXPIRED`, `INSUFFICIENT_INVENTORY`, `REFUND_EXCEEDS_CAPTURE`, `INVALID_ORDER_STATE`, `PROVIDER_EVENT_CONFLICT`, `IDEMPOTENCY_CONFLICT`) use 409. Only an administrator may receive `409 TENANT_MISMATCH`; a tenant-authenticated foreign reference stays 404. These are public rules, not private test expectations.

- # CommerceCommand V2 — public execution protocol supplement

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

By that deadline, admitted resolvable Work/outbox must drain and all original V1 and
marketplace invariants must hold. Verify that replacements, not just surviving
processes, actually claimed/completed work. Also demonstrate a stale pre-kill
fencing token cannot commit a business effect. If either requested barrier was
never reached or a target process was not killed, report setup failure; do not
claim that a recovery test ran.

- Browser document query boundary: GET operations whose published response contentMediaType is text/html, outside /api and /media, accept additional implementation-owned URL query state unchanged. This is the sole exception to unknown-query rejection. Published query/path/header parameters and no-body rules remain validated; all API query and body validation remains strict. The implementation must interpret its own deep-link state and still implement authorization, server reads and business behavior.

## Delivery

Public checks are necessary, not sufficient. Re-read the entire README, audit every observable requirement, and run all required project checks. Guide completion does not mean task completion. Do not return fixture-only responses or empty arrays to simulate completed workflows.
