# AuctionGuard Context

AuctionGuard models concurrent ascending auctions with durable close. This vocabulary is authoritative for the public contract,
dialogue, checklist, and evaluator design.

| Term | Canonical definition | Avoid |
| --- | --- | --- |
| Lot | The immutable item offered by one Auction. | Product, listing |
| Auction | A timed ascending-price competition for one Lot in V1. | Sale, market |
| Bid | An immutable maximum amount submitted by one Bidder. | Offer, price |
| Leading Bid | The deterministic currently winning accepted Bid. | Winner, top row |
| Close Task | Durable leased work that closes an Auction after its effective endAt. | Timer, cron |
| Anti-sniping Window | The published interval in which an accepted Bid extends endAt once per new effective deadline. | Delay, grace |

## State language

Auction: SCHEDULED -> OPEN -> CLOSING -> CLOSED | CANCELLED; Bid: ACCEPTED | OUTBID | WINNING.

## Core invariants

1. Accepted bid amounts for an Auction are strictly increasing in committed sequence.
2. At most one Bid is Leading and at most one winner is finalized in V1.
3. A Bid accepted before the effective deadline cannot be lost by a concurrent close.
4. Each qualifying accepted Bid applies at most one deterministic deadline extension.
5. Closing emits one immutable outcome and repeated workers cannot change it.

Use these exact terms in API fields, UI labels, events, tests, and handoff. A synonym in explanatory
prose must not introduce a second domain concept.
