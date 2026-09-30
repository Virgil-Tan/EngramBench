# CommerceCommand: public integration contract (taskVersion 4)

The external interface is fixed. The starter implementation is OPTIONAL and REPLACEABLE, not a business implementation.
README and the original Manager requirements still define every business obligation. Explicit v4 wire clarifications below override ONLY ambiguous transport representations in the legacy text, not business rules.

## External interface vs internal implementation

- Fixed: published HTTP methods/paths, request/response/error shapes, command names and arguments, environment variables, seed and snapshot wire formats. Preserve the original README business requirements and runtime constraints.
- Free: source directories, modules, function names, router/framework, build configuration, package module type, npm script BODIES and dependencies. Neither `src/` nor `dist/` nor `execute(operationId, context)` is required by the checker.
- `src/implementation.ts`, `src/lifecycle.ts`, `contract/server.mjs`, `contract/seed.mjs` and `tsconfig.json` are replaceable starter examples. Keep them only if useful; implement actual database-backed business behavior yourself.
- Author-owned specification and checks remain fixed: README/AGENTS, original requirements, contract/README.md, contract.json, openapi.json, seed.example.json, check.mjs, runtime.mjs and protected.json. Do not change these to make an incorrect implementation pass.
- Additional real application routes are allowed; they must not replace or change a published route. The optional starter's publicExtensions hook is one possible implementation, not a required interface.

## Commands and clean environment

Run `npm ci`, then `npm run build`. Preserve a reproducible package-lock.json and the required npm command NAMES; you may replace every command body. The untouched lifecycle stubs deliberately fail, and compilation alone is not delivery.
Run `npm run test:public-contract` in a DISPOSABLE database with DATABASE_URL, TEST_DATABASE_URL and ADMIN_TOKEN set. It replays migration/seed, starts the real roles and probes the live API. It is not safe to point at a valuable database.
The official gate runs the author copy in a new evaluator container on a fresh checkout/database. It does not trust a submitted test script or its reported result.
The checker launches `npm run start:api` with a numeric PORT and waits for a TCP listener, then sends actual HTTP requests. It launches workers/dispatchers via their public npm commands, never imports application modules and does not require Node IPC messages. Long-running role commands must stay alive and honor process termination.
Required commands: `npm run build`, `npm run db:migrate`, `npm run db:seed`, `npm run start:api`, `npm run start:worker`, `npm run start:dispatcher`, `npm run test:public-contract`, `npm run check:contract-source`, `npm run test:unit`, `npm run test:integration`, `npm run test:e2e`, `npm run test:concurrency`, `npm run test:recovery`, `npm run test:perf`, `npm run test:all`.
`npm run check:contract-source` checks file integrity/schema construction ONLY; this is not a live pass.

## Public create → operate → query check

The ordered `smoke` list in contract.json includes real successful writes followed by a query/snapshot of those same resources. `capture` binds response JSON pointers; `${name}` in later requests and expected bodies refers to that actual returned value. Whole-value references retain JSON types; path references are URL-encoded. A missing/wrong response cannot be replaced with a guessed ID. These are public integration examples, not hidden scoring cases.
- 1. getHealth: HTTP 200.
- 2. getOpenApi: HTTP 200.
- 3. getVerificationSnapshot: HTTP 200.
- 4. createQuote: HTTP 201; capture orderId, orderLineId, quoteExpiresAt.
- 5. getVerificationSnapshot: HTTP 200; capture inventoryHoldId.
- 6. cancelOrder: HTTP 200.
- 7. getOrder: HTTP 200.
- 8. getVerificationSnapshot: HTTP 200.

## Published operations

| Operation | Method / path | Request schema | Response schema | Source |
| --- | --- | --- | --- | --- |
| getUi | GET / | see original text | see notes/original text | contract/README.md (v4 wire clarification) |
| getOpenApi | GET /openapi.json | see original text | see notes/original text | docs/frontal-legacy/README.md#required-stack-and-delivery |
| getHealth | GET /healthz | see original text | see notes/original text | docs/frontal-legacy/README.md#required-stack-and-delivery |
| listTenants | GET /api/v1/tenants | see original text | see notes/original text | docs/frontal-legacy/README.md#http-errors-and-idempotency |
| listProducts | GET /api/v1/products | see original text | see notes/original text | docs/frontal-legacy/README.md#http-errors-and-idempotency |
| createOfferVersion | POST /api/v1/offer-versions | see original text | published | docs/frontal-legacy/README.md#product-and-immutable-offerversion |
| adjustInventoryPool | POST /api/v1/inventory-pools/:inventoryPoolId/adjustments | see original text | see notes/original text | docs/frontal-legacy/README.md#http-errors-and-idempotency |
| createQuote | POST /api/v1/orders/quotes | published | published | contract/README.md (v4 wire clarification) |
| listOrders | GET /api/v1/orders | see original text | see notes/original text | docs/frontal-legacy/README.md#http-errors-and-idempotency |
| getOrder | GET /api/v1/orders/:orderId | see original text | published | contract/README.md (v4 wire clarification) |
| checkoutOrder | POST /api/v1/orders/:orderId/checkout | published | see notes/original text | docs/frontal-legacy/README.md#checkout-and-uncertain-payment |
| cancelOrder | POST /api/v1/orders/:orderId/cancel | published | published | contract/README.md (v4 wire clarification) |
| refundOrder | POST /api/v1/orders/:orderId/refunds | published | see notes/original text | docs/frontal-legacy/README.md#fulfillment-and-digital-entitlement |
| recordPaymentCallback | POST /api/v1/payment-provider/callbacks | published | see notes/original text | contract/README.md (v4 wire clarification) |
| reconcilePaymentAttempt | POST /api/v1/payment-attempts/:paymentAttemptId/reconcile | published | see notes/original text | contract/README.md (v4 wire clarification) |
| completeFulfillmentPlan | POST /api/v1/fulfillment-plans/:fulfillmentPlanId/complete | see original text | see notes/original text | docs/frontal-legacy/README.md#fulfillment-and-digital-entitlement |
| revokeEntitlementGrant | POST /api/v1/entitlement-grants/:entitlementGrantId/revoke | see original text | see notes/original text | docs/frontal-legacy/README.md#fulfillment-and-digital-entitlement |
| listLedger | GET /api/v1/ledger | see original text | see notes/original text | docs/frontal-legacy/README.md#http-errors-and-idempotency |
| listEvents | GET /api/v1/events | see original text | see notes/original text | docs/frontal-legacy/README.md#http-errors-and-idempotency |
| listWork | GET /api/v1/work | see original text | see notes/original text | docs/frontal-legacy/README.md#http-errors-and-idempotency |
| listNotifications | GET /api/v1/notifications | see original text | see notes/original text | docs/frontal-legacy/README.md#http-errors-and-idempotency |
| getVerificationSnapshot | GET /api/v1/verification-snapshot | see original text | published | docs/frontal-legacy/README.md#seed-and-verification-snapshot |
| setSellerAllocations | POST /api/v1/orders/:orderId/seller-allocations | published | see notes/original text | docs/frontal-legacy/manager-requirements.md |
| createSellerSettlement | POST /api/v1/seller-settlements | published | see notes/original text | docs/frontal-legacy/manager-requirements.md |
| closeSellerSettlement | POST /api/v1/seller-settlements/:sellerSettlementId/close | published | see notes/original text | docs/frontal-legacy/manager-requirements.md |
| createCommerceDispute | POST /api/v1/commerce-disputes | published | see notes/original text | docs/frontal-legacy/manager-requirements.md |
| resolveCommerceDispute | POST /api/v1/commerce-disputes/:commerceDisputeId/resolve | published | see notes/original text | contract/README.md (v4 wire clarification) |
| createSettlementAdjustment | POST /api/v1/settlement-adjustments | published | see notes/original text | docs/frontal-legacy/manager-requirements.md |

## Wire clarifications and limits

- Legacy source paths are relative to task-packages/legacy/commercecommand/workspace. The complete public README and Manager requirements define behavior. Explicit v4 wire clarifications describe transport omissions verified against the existing request/setup/extraction interface, without publishing fixture values, cases, assertions, or scoring.
- The README permits GET /healthz OR GET /api/health. getHealth selects /healthz as the canonical alternative; it does not establish a requirement to implement both. Neither health response fields nor a literal success status are published; the smoke uses ordinary HTTP 200 health success.
- All nine business GET routes are included. v4 fixes the closed top-level Order detail projection. Collection envelopes, pagination, filtering, and Tenant authentication transport remain unspecified; no unprovided list wrapper is asserted.
- Every mutation requires Idempotency-Key, scoped by Tenant, method, and canonical route. First success or business rejection persists exact status/body; exact replay survives restart; changed canonical body returns 409 IDEMPOTENCY_CONFLICT. MALFORMED_JSON returns 400 and creates no replay record.
- Mutation success status defaults to 200; quote creation is 201. Success bodies are the closed top-level primary resource shape unless an explicit literal shape or multiple named resources says otherwise. v4 fixes Order, OrderLine, InventoryHold and quote projections for the public chain; other incomplete success shapes remain explicit gaps.
- The v4 quote response is the closed Order fields plus lines containing frozen OrderLine fields and allocations:[{inventoryPoolId,quantity}]. GET Order and successful cancellation return the closed Order projection. Cancel accepts exactly {}. These external JSON projections do not constrain internal storage, language, framework, module names, or function signatures. Offer creation, inventory adjustment, fulfillment completion and entitlement revoke request layouts remain unspecified.
- Internal identifiers follow the global UUID rule. providerRequestId is the published merchant-unique-string exception. The v4 wire clarification makes providerEventId and providerQueryId opaque strings as used by the transport callers; this explicitly narrows the legacy blanket UUID statement for external provider references. ISO currency membership, cross-row references, unique quote Product IDs, monetary equations, immutable terms, tenant isolation, fencing, and transactional convergence remain domain checks beyond these structural schemas.
- Seed and snapshot preserve the V1 resource keys. The v4 wire clarification publishes Tenant, Buyer, Product, InventoryPool, Order, OrderLine and InventoryHold row layouts, PHYSICAL/DIGITAL serialization and string seedVersion; OfferVersion, Work and NotificationDelivery fields come from the README. Remaining empty row schemas and unknown scalar types express missing public information, not permissive runtime validation rules.
- The Manager requires marketplace entities in seed/snapshot but never specifies Seller rows, additional array names, schemaVersion changes, or complete marketplace resource fields. Seed and snapshot resources require the published V1 keys and permit additional arrays solely to accommodate those unnamed Manager extensions. Runtime must still reject unknown members against its documented complete contract; author clarification is required to close these two structural schemas.
- Work leaseOwner, leaseExpiresAt, terminal, payloadVersion and NotificationDelivery deliveredAt have no exact wire types or nullability published. Their value schemas remain unspecified. OfferVersion state and NotificationDelivery state have no literal enum lists.
- The public chain imports one Tenant, Buyer, physical Product, active OfferVersion and InventoryPool into a clean database. It creates a two-unit quote, captures returned Order/OrderLine IDs and expiry, observes HELD inventory and captures its ID, cancels via that Order ID, reads CANCELLED Order detail and verifies the same durable rows with a RELEASED hold and unchanged onHand. The one-hour hold TTL keeps this bounded chain independent of background expiry timing. Array expectations have exact length; object expectations are partial. No volatile Work, notification, or event scheduling state is asserted.
- Required public errors include VALIDATION_ERROR, RESOURCE_NOT_FOUND, IDEMPOTENCY_CONFLICT, MALFORMED_JSON, INSUFFICIENT_INVENTORY, QUOTE_EXPIRED, INVALID_ORDER_STATE, PROVIDER_EVENT_CONFLICT, REFUND_EXCEEDS_CAPTURE, STALE_FENCE and TENANT_MISMATCH. Manager adds 409 ALLOCATION_NOT_CONSERVED, 409 RESERVE_EXCEEDS_CAPTURE and 409 SETTLEMENT_CLOSED. The error details members are not enumerated.
- Marketplace invariants remain binding: one immutable conserved allocation set per Order, same Tenant, no reassignment after fulfillment; CLOSED settlements immutable; refund plus dispute reserve bounded by capture; LOST charges back once, WON only releases reserve; adjustments persist targetPeriodStart at or after the source periodEnd in the next open period.
- Defaults: PORT=3000; WORK_LEASE_SECONDS is integer 1..300, default 30; WEBHOOK_URL may be absent but dispatcher stays alive and retries; BENCH_PERF_SCALE is test-only (0,1], scored runs use 1. Tokens must not be logged; TEST_BARRIER_TOKEN must not be persisted.
- db:migrate is repeatable; all start commands are long-running production roles. test:all includes every non-performance gate. Preserve seven V1 performance scenarios and add seller-settlement-close, refund-dispute-race, full-catastrophe-recovery with the exact published thresholds; this structural contract does not replace those gates.
- The v4 wire clarification fixes GET / as the production browser entry, returning HTML. Other browser deep-link paths remain implementation-defined. Existing collection callers do not establish a list envelope, and existing setup supplies no marketplace seed extension keys; those gaps remain explicit.

## Acceptance boundary

Public checks require a successful create → operation → query chain and verify returned IDs/state through the public snapshot. They prove only the tested integration surface, not exhaustive business correctness, all seed combinations, concurrency, recovery, authorization, UI or performance. Implement and verify the ENTIRE README; no finite smoke test guarantees all hidden cases pass.
A local Guide finishing or public smoke passing does not mean the task is finished. Only submit after full README audit and final verification.
A public gate failure is returned verbatim to the Coding Agent for repair in the same session. Infrastructure failures stop with diagnostics; they are not business test failures. Once the gate passes, the exact checked source is frozen before hidden evaluation.
