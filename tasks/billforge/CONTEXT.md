# BillForge Context

BillForge models tenant-scoped subscription billing under uncertain provider outcomes.

- `Invoice` freezes the price, tax, discount, exchange-rate, and billing-period inputs.
- `PaymentIntent` owns one provider capture lifecycle; `UNKNOWN` is a real unresolved state.
- `Refund` compensates a successful PaymentIntent subject to one shared refundable bound.
- `LedgerEntry` is immutable and belongs to one balanced Posting.
- `SettlementRun` freezes one tenant-period close and cannot be rewritten after `CLOSED`.
- `Dispute` and `Adjustment` are introduced only by the Manager message.

Do not use floating-point money or conflate Provider transaction identity with internal idempotency.
