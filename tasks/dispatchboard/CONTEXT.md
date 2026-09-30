# DispatchBoard Context

DispatchBoard models competitive courier offer assignment and delivery completion. This vocabulary is authoritative for the public contract,
dialogue, checklist, and evaluator design.

| Term | Canonical definition | Avoid |
| --- | --- | --- |
| Delivery | One pickup-to-dropoff request with a service window. | Order, shipment |
| Courier | A registered capacity owner eligible for an Offer. | Driver, worker |
| Offer | A time-bounded invitation for one Courier to claim a Delivery. | Bid, notification |
| Offer Round | One deterministic ordered group of concurrent Offers. | Auction, batch |
| Assignment | The immutable winning Courier and accepted Offer in V1. | Claim, match |
| Offer Task | Durable leased work that creates or expires Offers and starts the next round. | Job, timer |

## State language

Delivery: REQUESTED -> OFFERING -> ASSIGNED -> PICKED_UP -> DELIVERED, or pre-pickup -> CANCELLED/EXPIRED.

## Core invariants

1. A Delivery has at most one active Assignment and one successful pickup in V1.
2. An Offer can be accepted only before its persisted expiresAt and only once.
3. A Courier's active assigned load never exceeds published capacity.
4. A cancelled Delivery cannot later be picked up or delivered.
5. Repeated or concurrent Offer Tasks cannot create duplicate rounds or notifications with new identities.

Use these exact terms in API fields, UI labels, events, tests, and handoff. A synonym in explanatory
prose must not introduce a second domain concept.
