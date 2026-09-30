【Product Manager · Maya】

V1 已完成并通过基础验收。本期正式增加“multi-unit uniform-price auctions”。以下业务规则、wire schema、接口和错误全部是公开增量合同。

业务规则：

1. An Auction may offer 2-100 identical Units and each Bid requests quantity 1-20 at one maximum unit price.
2. At close, sort accepted Bids by unit price descending, committed sequence ascending, then bidId; allocate until Units are exhausted.
3. The clearing unit price is the lowest winning unit price; a final Bid may receive a partial quantity.
4. Closing creates 1-N immutable Awards atomically, never more awarded Units than available.
5. Cancellation remains illegal after any accepted Bid; anti-sniping semantics are unchanged.
6. Legacy single-unit Auctions keep leadingBidId, winnerId, and winningAmountMinor; multi-unit Auctions keep leadingBidId as the current highest-price Bid, return null for winnerId and winningAmountMinor, and expose awards[].
7. For a multi-unit Bid, amountMinor multiplied by quantity must be a JSON safe integer; this also bounds every Award totalAmountMinor.
8. Migrate each V1 Auction to unitCount 1 and its winner to one Award without changing bid/outcome/event histories.
9. Pending Close Tasks and effective deadlines remain exact.
10. Stored one-unit Bid and close replay responses remain byte-equivalent JSON.
11. The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
12. The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
13. Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
14. Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

新增 wire schema：

- MultiUnitBid = {bidId:uuid,auctionId:uuid,bidderId:uuid,amountMinor:int,quantity:int,committedSequence:int,state:ACCEPTED|OUTBID|WINNING,acceptedAt:timestamp,effectiveEndAtAfter:timestamp}
- Award = {awardId:uuid,auctionId:uuid,bidId:uuid,bidderId:uuid,allocatedQuantity:int,clearingUnitPriceMinor:int,totalAmountMinor:int,allocationRank:int,createdAt:timestamp}
- MultiUnitAuctionOutcome = {auctionId:uuid,result:WINNER|NO_SALE,unitCount:int,allocatedUnitCount:int,unallocatedUnitCount:int,clearingUnitPriceMinor:int|null,awards:[Award],closedAt:timestamp}
- AuctionDetail = {auctionId:uuid,lotId:uuid,currency:currency,reservePriceMinor:int,minimumIncrementMinor:int,startAt:timestamp,effectiveEndAt:timestamp,state:SCHEDULED|OPEN|CLOSING|CLOSED|CANCELLED,leadingBidId:uuid|null,winnerId:uuid|null,winningAmountMinor:int|null,sequence:int,unitCount:int,awards:[Award],outcome:AuctionOutcome|MultiUnitAuctionOutcome|null}; outcome is null before CLOSED, AuctionOutcome for a closed one-unit Auction, and MultiUnitAuctionOutcome for a closed multi-unit Auction

新增或变更接口：

- POST /api/v1/admin/auctions accepts the V1 fields plus unitCount; omission creates a legacy one-unit Auction, while an explicit multi-unit value must be an integer from 2 through 100.
- POST /api/v1/auctions/:auctionId/bids accepts {bidderId,amountMinor,quantity}; quantity is required and must be 1..20 for a multi-unit Auction, amountMinor * quantity must be <= 9007199254740991, and the legacy one-unit request may omit quantity and receives quantity 1.
- GET /api/v1/auctions/:auctionId returns the exact AuctionDetail. A multi-unit outcome and AuctionDetail.awards use identical Awards ordered by allocationRank; each Award totalAmountMinor equals allocatedQuantity multiplied by the common clearingUnitPriceMinor.
- For a one-unit Auction the existing leadingBidId, winnerId, winningAmountMinor, and replay JSON remain populated exactly as before; for a multi-unit Auction winnerId and winningAmountMinor are null, leadingBidId retains its V1 meaning, and awards contains the complete immutable allocation.

新增稳定错误：

- 400 INVALID_AUCTION_UNIT_COUNT: an explicitly supplied unitCount is not a safe integer from 2 through 100
- 400 INVALID_BID_QUANTITY: a multi-unit Bid omits quantity or quantity is not a safe integer from 1 through 20
- 400 BID_TOTAL_OVERFLOW: amountMinor multiplied by quantity exceeds 9007199254740991
- 409 AWARD_ALLOCATION_CONFLICT: a close retry observes an Award set that differs from canonical allocation for the locked Bid snapshot

FINAL snapshot 与性能兼容合同：

The FINAL verification snapshot 'resources' object has exactly the union of these V1 and Manager resource specifications, with no other keys:

- 'bidders' uses exact shape 'Bidder = {bidderId:uuid,displayName:string}' and sorts ascending by scalar field-path tuple 'bidderId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'lots' uses exact shape 'Lot' and sorts ascending by scalar field-path tuple 'lotId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'auctions' uses exact shape 'Auction' and sorts ascending by scalar field-path tuple 'auctionId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'bids' uses exact shape 'Bid' and sorts ascending by scalar field-path tuple 'auctionId', 'committedSequence', 'bidId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'auctionOutcomes' uses exact shape 'AuctionOutcome' and sorts ascending by scalar field-path tuple 'auctionId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'awards' uses exact shape 'Award' and sorts ascending by scalar field-path tuple 'auctionId', 'allocationRank', 'awardId', then by RFC 8785 canonical JSON as the tie-breaker.

The Manager-added resource specifications are exactly:

- 'awards' uses exact shape 'Award' and sorts ascending by scalar field-path tuple 'auctionId', 'allocationRank', 'awardId', then by RFC 8785 canonical JSON as the tie-breaker.

The FINAL Work kind enum is exactly the union 'AUCTION_CLOSE'. The Manager-added
Work kinds are exactly (none). All V1 snapshot point-in-time,
recursive '*Token' omission, sorting, Work state/lease/retention/drain, and Domain Event rules remain
mandatory. The FINAL binary reruns exactly these three V1-compatible scenarios:

- 'hot-auction-bids': accept 250 Bids/s on 20 hot Auctions with p95 <= 300 ms; threshold: At least 250 accepted Bids/s across the 20 Auctions for 60 seconds and p95 <= 300 ms; unexpected 5xx = 0.
- 'live-auction-read': serve 400 live Auction reads/s with p95 <= 100 ms; threshold: At least 400 successful reads/s for 60 seconds and p95 <= 100 ms; mixed revisions and unexpected 5xx are zero.
- 'auction-close-recovery': close 2,000 due Auctions within 45 s after restart; threshold: The 2,000-Auction backlog drains in <= 45 seconds after replacement spawn; unexpected failures = 0.

Their published setup, selector, request, concurrency, warm-up, measurement, timer, success condition,
and threshold remain unchanged. This Manager change adds correctness, concurrency, and recovery
assertions only; it does not replace or relax a performance scenario.

本轮先不要实现。请先说明它会影响哪些领域关系、模块、schema、migration、接口、状态、成功与失败数据流、兼容性、Worker、事件、前端、并发、恢复和性能测试，然后给出分阶段修改计划。