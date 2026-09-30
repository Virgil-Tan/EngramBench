# BillForge

Build BillForge from this intentionally blank repository. This README is the complete public product
contract. Ask before making a product choice that the contract does not settle.

## Required stack and commands

- Node.js 22, TypeScript, React, PostgreSQL 16, npm, and the preinstalled Chromium.
- PostgreSQL is the sole authority for business state, idempotency, leases, ledger entries, outbox events,
  and ordering. The provider test double is the only external boundary.
- The production UI must use the public HTTP API; browser-only state is never authoritative.

Required non-interactive commands:

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

Every command must be non-interactive, exit non-zero on failure, and clean up child processes.

## Domain

BillForge is a tenant-scoped billing platform. It generates invoices from versioned subscription prices,
tax rules, discounts, and frozen exchange rates; captures payments through a local provider double; handles
unknown provider results, refunds, and monthly settlement; and exposes a real React operations UI.

The provider double can return `SUCCEEDED`, `DECLINED`, `TIMEOUT`, `CONNECTION_RESET`, `DUPLICATE`, or delayed,
duplicated, and reordered Webhooks. No real network payment provider is used.

### Canonical objects

```text
Tenant, Customer, Plan, PriceVersion, Subscription, Invoice, InvoiceLine,
TaxCalculation, DiscountAllocation, ExchangeRateSnapshot, PaymentIntent,
PaymentAttempt, ProviderTransaction, Refund, LedgerAccount,
LedgerEntry, SettlementRun, SettlementSnapshot, OutboxEvent, Work
```

### State machines

```text
Invoice: DRAFT -> OPEN -> PAID -> PARTIALLY_REFUNDED -> REFUNDED
                 |                     |
                 +-> VOID

PaymentIntent: CREATED -> PROCESSING -> SUCCEEDED | FAILED | UNKNOWN
Refund: REQUESTED -> PROCESSING -> SUCCEEDED | FAILED
SettlementRun: OPEN -> SNAPSHOTTING -> CALCULATING -> POSTING -> CLOSED
```

An invoice may use only the monotonic path applicable to its facts; a state transition is committed with
its business effect and Domain Event in one transaction.

### Exact public shapes

`uuid` is lowercase RFC 4122 text, `timestamp` is UTC ISO-8601 with millisecond precision and `Z`,
`currency` is three uppercase ASCII letters, `sha256` is 64 lowercase hex, and `int` is a JSON safe integer.

```text
InvoiceLine = {invoiceLineId:uuid,kind:BASE|PRORATION|DISCOUNT|TAX,description:string,quantity:int,unitAmountMinor:int,amountMinor:int}
Invoice = {invoiceId:uuid,tenantId:uuid,customerId:uuid,subscriptionId:uuid,currency:currency,periodStart:timestamp,periodEnd:timestamp,state:DRAFT|OPEN|PAID|PARTIALLY_REFUNDED|REFUNDED|VOID,totalMinor:int,paidMinor:int,refundedMinor:int,outstandingMinor:int,priceVersion:int,taxVersion:int,discountVersion:int,exchangeRateSnapshotId:uuid,lines:[InvoiceLine],createdAt:timestamp,finalizedAt:timestamp|null,sequence:int}
PaymentIntent = {paymentIntentId:uuid,invoiceId:uuid,amountMinor:int,currency:currency,state:CREATED|PROCESSING|SUCCEEDED|FAILED|UNKNOWN,providerRequestId:string,providerTransactionId:string|null,createdAt:timestamp,resolvedAt:timestamp|null,sequence:int}
Refund = {refundId:uuid,paymentIntentId:uuid,amountMinor:int,state:REQUESTED|PROCESSING|SUCCEEDED|FAILED,providerTransactionId:string|null,createdAt:timestamp,resolvedAt:timestamp|null}
LedgerEntry = {ledgerEntryId:uuid,postingId:uuid,tenantId:uuid,currency:currency,accountCode:string,direction:DEBIT|CREDIT,amountMinor:int,referenceType:PAYMENT|REFUND|SETTLEMENT,referenceId:uuid,createdAt:timestamp}
SettlementRun = {settlementRunId:uuid,tenantId:uuid,periodStart:timestamp,periodEnd:timestamp,state:OPEN|SNAPSHOTTING|CALCULATING|POSTING|CLOSED,snapshotDigest:sha256|null,totalInvoiceMinor:int,totalPaymentMinor:int,totalRefundMinor:int,createdAt:timestamp,closedAt:timestamp|null,sequence:int}
```

## Money and accounting contract

- All monetary values are safe non-negative integers in the smallest currency unit.
- A ledger is double-entry. Every posting has balanced debit and credit legs with the same currency.
- A successful payment posts `CustomerReceivable -> CashClearing`.
- A successful refund posts `RefundExpense -> CashClearing`.
- An invoice's effective balance is `total - successful payments + successful refunds`.
- No posting or refund may make a ledger account negative unless the account's
  published type explicitly permits it. The default accounts do not permit overdrafts.
- Historical postings are immutable.

## Required behavior

### Billing

1. Price, tax, discount, and exchange-rate versions are effective-dated and non-overlapping.
2. Invoice generation freezes the selected versions and the exchange-rate snapshot.
3. Subscription upgrades, downgrades, and cancellation inside a period create deterministic proration lines.
4. The same tenant, customer, billing period, and subscription version cannot generate duplicate invoices.
5. A discount cannot make a line or invoice negative; tax is calculated from the frozen taxable base.

### Payments

1. Every mutation requires a durable `Idempotency-Key` scoped by method and canonical path.
2. A provider timeout or connection reset sets the PaymentIntent to `UNKNOWN`; it must not be charged again
   until reconciliation determines the provider transaction.
3. A Provider transaction ID can belong to only one PaymentIntent. Duplicate or reordered Webhooks are safe.
4. Reconcile and Webhook handling are commutative: whichever arrives first, the final semantic result is one.
5. A failed or unknown payment cannot mark an invoice paid or create a successful ledger posting.

### Refunds

1. Refunds support partial amounts and repeated refunds while available refundable amount remains.
2. Concurrent refunds and retries must never exceed the captured payment amount.
3. A failed or unknown Refund does not reduce refundable amount or create a successful Posting.

### Monthly settlement

1. A tenant and settlement period have at most one SettlementRun.
2. The run calculates from a frozen snapshot of invoices, payments, refunds, and exchange rates.
3. New transactions after snapshotting belong to the next period and cannot change the current run.
4. A crashed worker can resume from the last durable phase without duplicate postings.
5. `CLOSED` periods are immutable and cannot be reopened or directly changed.

## Public HTTP surface

```text
POST /api/v1/tenants
POST /api/v1/customers
POST /api/v1/plans
POST /api/v1/price-versions
POST /api/v1/subscriptions
POST /api/v1/subscriptions/:subscriptionId/change
POST /api/v1/subscriptions/:subscriptionId/cancel
POST /api/v1/invoices
POST /api/v1/invoices/:invoiceId/finalize
GET  /api/v1/invoices/:invoiceId
GET  /api/v1/invoices/:invoiceId/ledger
POST /api/v1/payment-intents
POST /api/v1/payment-intents/:paymentIntentId/reconcile
POST /api/v1/provider/webhooks
POST /api/v1/payment-intents/:paymentIntentId/refunds
POST /api/v1/settlements
GET  /api/v1/settlements/:settlementId
GET  /api/v1/verification-snapshot
```

Serve `GET /openapi.json` and `GET /healthz`. JSON errors use
`{"error":{"code":"STABLE_CODE","message":"...","details":{}}}`. Reject unknown fields and
unsupported media types. Collections use `{items,nextCursor}` with stable opaque cursors.

Published semantic errors are exhaustive for well-formed requests:

```text
409 INVOICE_ALREADY_EXISTS
409 PAYMENT_RESULT_UNKNOWN
409 PROVIDER_TRANSACTION_CONFLICT
409 REFUND_AMOUNT_EXCEEDED
409 SETTLEMENT_PERIOD_CLOSED
409 IDEMPOTENCY_CONFLICT
400 MONEY_OVERFLOW
400 INVALID_REQUEST
```

Durable Work has exact shape
`{workId:uuid,kind:INVOICE_FINALIZATION|PAYMENT_CAPTURE|REFUND_PROCESSING|SETTLEMENT_CLOSE,aggregateId:uuid,state:PENDING|LEASED|SUCCEEDED|FAILED|CANCELLED,terminal:boolean,attempt:int,leaseOwner:string|null,leaseExpiresAt:timestamp|null}`.
Workers use bounded leases and fence the final commit. Required event types are `invoice.created`,
`invoice.finalized`, `payment.succeeded`, `payment.failed`, `payment.unknown`, `refund.succeeded`, and
`settlement.closed`. Events are contiguous per aggregate and dispatch at least once with stable identity/body.

## Seed and snapshot

The seed is exactly:

```json
{"schemaVersion":1,"seedVersion":"...","importedAt":"...","tenants":[],"customers":[],"plans":[],"priceVersions":[],"subscriptions":[],"invoices":[],"paymentIntents":[],"refunds":[],"exchangeRateSnapshots":[],"ledgerAccounts":[],"ledgerEntries":[],"settlementRuns":[]}
```

Import is atomic. Replaying the same version and digest is a no-op; the same version with a different digest
returns `SEED_VERSION_CONFLICT`. The verification snapshot is point-in-time and exposes resources, durable
Work, and Domain Events without credentials, tokens, raw provider bodies, or private paths.
The V1 `resources` object contains exactly `tenants`, `customers`, `plans`, `priceVersions`,
`subscriptions`, `exchangeRateSnapshots`, `invoices`, `paymentIntents`, `refunds`, `ledgerAccounts`,
`ledgerEntries`, and `settlementRuns`; each array is complete and sorted by its primary public ID.

## Out of scope

Real card networks, PCI card storage, bank settlement, floating-point money, speculative fraud scoring,
cryptocurrency, interest, payroll, and cross-tenant financial aggregation.

## Successful response contracts

Successful response contracts are closed:

- A mutation route without a literally stated success status returns 200.
- Unless a route literally publishes another object, array, or empty body, a success described by a named resource, named resource state, or named resource fields returns that exact resource shape at the JSON top level. Any response-only fields literally named by the route are additional top-level fields.
- If a mutation publishes no success body, it returns the exact current shape of the single primary resource created or changed by that route at the JSON top level.
- When a route explicitly returns multiple named resources, the body is one object keyed by their lower-camel resource names unless the route publishes another literal shape.
- Wrappers such as `{data:...}`, `{result:...}`, or an extra single-resource envelope are invalid unless the route literally declares them. OpenAPI must publish the same success status and closed response schema as runtime.
