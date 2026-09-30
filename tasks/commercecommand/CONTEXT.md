# CommerceCommand Context

CommerceCommand is a multi-tenant omnichannel transaction control plane. Its single business flow is:

`immutable offer -> frozen quote -> inventory hold -> uncertain payment -> fulfillment/entitlement -> balanced ledger -> notification`

Canonical terms:

- `OfferVersion`: immutable commercial terms for one Product. An OrderLine freezes one exact version.
- `InventoryPool`: one independently conserved stock pool. Availability is `onHand - reserved`.
- `InventoryHold`: a quantity reservation for one OrderLine and pool; it is consumed or released exactly once.
- `PaymentAttempt`: one provider operation whose outcome can remain `UNKNOWN` until reconciliation.
- `FulfillmentPlan`: durable physical or digital delivery work derived from a captured Order.
- `EntitlementGrant`: a digital right created once and revocable once.
- `LedgerEntry`: one immutable debit or credit in a balanced journal and currency.
- `NotificationDelivery`: an immutable outbox delivery identity and body.
- `SellerAllocation`, `SellerSettlement`, `CommerceDispute`, and `SettlementAdjustment` are introduced only by the Manager change.

Amounts are integer minor units. Every invariant is tenant-scoped, but tenant isolation is also an authorization boundary.
