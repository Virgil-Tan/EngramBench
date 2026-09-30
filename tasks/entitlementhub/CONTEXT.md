# EntitlementHub Context

EntitlementHub is a tenant-scoped subscription-to-access authority.

- `PlanRevision` freezes price, billing interval, features, limits, trial duration, and refund policy.
- `Subscription` owns one subject's commercial lifecycle and current period.
- `EntitlementGrant` is an immutable source grant; `EntitlementView` is the current derived access decision.
- `ProviderEvent` resolves billing outcomes and is deduplicated by provider identity.
- `RevocationFence` is the monotonic version that prevents stale access from returning.
- `EntitlementPool` and `SeatAssignment` are introduced only by the Manager message.

Do not conflate subscription state, a historical grant, and the current entitlement decision.
