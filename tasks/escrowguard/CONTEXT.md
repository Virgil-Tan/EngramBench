# EscrowGuard Context

EscrowGuard models milestone escrow release, refund, and dispute resolution. This vocabulary is authoritative for the public contract,
dialogue, checklist, and evaluator design.

| Term | Canonical definition | Avoid |
| --- | --- | --- |
| Escrow | One funded agreement between one Buyer and one Seller with an immutable currency and total. | Payment, wallet |
| Milestone | One ordered portion of Escrow value that must be submitted and accepted before release. | Task, line item |
| Fund Position | The conserved available, released, and refunded integer amounts for one Escrow. | Balance row |
| Dispute | A frozen disagreement over one submitted Milestone resolved by an authorized adjudicator. | Comment, ticket |
| Escrow Expiry Task | Durable leased work that refunds unreleased value after the effective expiry. | Timer, cron |
| Release | An immutable settlement fact for an accepted Milestone. | Transfer, payout |

## State language

Escrow: FUNDED -> ACTIVE -> RELEASED | REFUNDED, or ACTIVE -> DISPUTED -> RELEASED | REFUNDED; Milestone: PENDING -> SUBMITTED -> ACCEPTED -> RELEASED, or SUBMITTED -> DISPUTED.

## Core invariants

1. For every Escrow, totalMinor equals availableMinor plus releasedMinor plus refundedMinor and every term is a non-negative safe integer.
2. Milestone amounts sum exactly to Escrow totalMinor and their ordinal values are contiguous from 1.
3. At most one Milestone is SUBMITTED or DISPUTED and later Milestones cannot advance before every earlier Milestone is RELEASED.
4. A Milestone amount is released or refunded at most once, never both, and every Release agrees with committed Fund Position.
5. Expiry, acceptance, and dispute resolution have one serialized winner and a stale worker or request cannot change the terminal result.

Use these exact terms in API fields, UI labels, events, tests, and handoff. A synonym in explanatory
prose must not introduce a second domain concept.
