## CommerceCommand public policy supplement — 2026-09-07.1

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

Evaluation clarification (2026-09-10): concurrent refund requests with otherwise identical valid bodies may exhaust the remaining restock quantity. Rejecting subsequent requests as `400 VALIDATION_ERROR` or an applicable published 409 conflict is acceptable; this is not permission to accept arbitrary 400 errors. Exactly one full-quantity restock may commit, financial bounds must hold, and inventory must increase by exactly the returned physical quantity. No response-code Adapter may manufacture success or rewrite these outcomes.
