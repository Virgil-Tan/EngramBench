# SeatReserve Context

SeatReserve models finite physical-seat ownership under expiring holds and uncertain payment outcomes.

- `Seat` is one immutable physical position within one Event.
- `PriceVersion` is immutable after publication; every Hold freezes one version and exact totals.
- `SeatHold` owns an all-or-nothing set of `HoldSeat` rows until expiry, cancellation, or conversion.
- `Order` owns the confirmed entitlement for seats converted from one Hold.
- `PaymentIntent` owns one provider identity; `UNKNOWN` is unresolved, not failure.
- Availability is derived from live Holds and confirmed Orders, never from browser state.
- `WaitlistEntry` and `SeatOffer` are introduced only by the Manager message.

Do not call a Provider timeout a decline, or release seats while an unknown payment still owns its published grace fence.
