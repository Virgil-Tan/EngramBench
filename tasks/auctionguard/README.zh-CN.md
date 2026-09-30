# AuctionGuard 项目设计说明

## 1. 定位

AuctionGuard 是一个从近空白 Git fixture 开始的高难度全栈 Coding Benchmark，主流程是
concurrent ascending auctions with durable close。这是 learning task，用于形成可迁移的工程经验。

本题只用一个主流程承载难度，重点测量：monotonic winner selection、deadline extension races、idempotent bidding、close recovery、audit ordering。领域词汇以
[CONTEXT.md](./CONTEXT.md) 为准。

## 2. 可见性

Codex 初始只能看到 'workspace/README.md'、'workspace/AGENTS.md' 和独立 fixture Git 历史。
Manager 变更、Checklist、对话状态机、评测方案和实验 metadata 都在 workspace 外，不能在
开发回合、Session Evolution 或盲审前复制或透露。

## 3. 完整 V1

- Create scheduled Auctions and open them through persisted time boundaries.
- Accept strictly increasing integer-minor-unit Bids with durable scoped idempotency.
- Select a deterministic Leading Bid under concurrent API requests and extend endAt under the exact anti-sniping rule.
- Close with recoverable Close Tasks and publish exactly one winner or no-sale result.
- Expose live bid history, countdown based on server time, outcome, and event delivery in the UI.

核心状态：Auction: SCHEDULED -> OPEN -> CLOSING -> CLOSED | CANCELLED; Bid: ACCEPTED | OUTBID | WINNING.

### 可计算不变量

1. Accepted bid amounts for an Auction are strictly increasing in committed sequence.
2. At most one Bid is Leading and at most one winner is finalized in V1.
3. A Bid accepted before the effective deadline cannot be lost by a concurrent close.
4. Each qualifying accepted Bid applies at most one deterministic deadline extension.
5. Closing emits one immutable outcome and repeated workers cannot change it.

## 4. Manager 固定变更

V1、真实 Browser E2E、双 API/双 Worker 并发与恢复完成后，T16 才发布
“multi-unit uniform-price auctions”。它改变核心基数、状态或一致性边界：

- An Auction may offer 2-100 identical Units and each Bid requests quantity 1-20 at one maximum unit price.
- At close, sort accepted Bids by unit price descending, committed sequence ascending, then bidId; allocate until Units are exhausted.
- The clearing unit price is the lowest winning unit price; a final Bid may receive a partial quantity.
- Closing creates 1-N immutable Awards atomically, never more awarded Units than available.
- Cancellation remains illegal after any accepted Bid; anti-sniping semantics are unchanged.
- Legacy single-unit Auctions keep leadingBidId, winnerId, and winningAmountMinor; multi-unit Auctions keep leadingBidId as the current highest-price Bid, return null for winnerId and winningAmountMinor, and expose awards[].
- For a multi-unit Bid, amountMinor multiplied by quantity must be a JSON safe integer; this also bounds every Award totalAmountMinor.

新增 wire schema：

- MultiUnitBid = {bidId:uuid,auctionId:uuid,bidderId:uuid,amountMinor:int,quantity:int,committedSequence:int,state:ACCEPTED|OUTBID|WINNING,acceptedAt:timestamp,effectiveEndAtAfter:timestamp}
- Award = {awardId:uuid,auctionId:uuid,bidId:uuid,bidderId:uuid,allocatedQuantity:int,clearingUnitPriceMinor:int,totalAmountMinor:int,allocationRank:int,createdAt:timestamp}
- MultiUnitAuctionOutcome = {auctionId:uuid,result:WINNER|NO_SALE,unitCount:int,allocatedUnitCount:int,unallocatedUnitCount:int,clearingUnitPriceMinor:int|null,awards:[Award],closedAt:timestamp}
- AuctionDetail = {auctionId:uuid,lotId:uuid,currency:currency,reservePriceMinor:int,minimumIncrementMinor:int,startAt:timestamp,effectiveEndAt:timestamp,state:SCHEDULED|OPEN|CLOSING|CLOSED|CANCELLED,leadingBidId:uuid|null,winnerId:uuid|null,winningAmountMinor:int|null,sequence:int,unitCount:int,awards:[Award],outcome:AuctionOutcome|MultiUnitAuctionOutcome|null}; outcome is null before CLOSED, AuctionOutcome for a closed one-unit Auction, and MultiUnitAuctionOutcome for a closed multi-unit Auction

新增或变更的公开接口：

- POST /api/v1/admin/auctions accepts the V1 fields plus unitCount; omission creates a legacy one-unit Auction, while an explicit multi-unit value must be an integer from 2 through 100.
- POST /api/v1/auctions/:auctionId/bids accepts {bidderId,amountMinor,quantity}; quantity is required and must be 1..20 for a multi-unit Auction, amountMinor * quantity must be <= 9007199254740991, and the legacy one-unit request may omit quantity and receives quantity 1.
- GET /api/v1/auctions/:auctionId returns the exact AuctionDetail. A multi-unit outcome and AuctionDetail.awards use identical Awards ordered by allocationRank; each Award totalAmountMinor equals allocatedQuantity multiplied by the common clearingUnitPriceMinor.
- For a one-unit Auction the existing leadingBidId, winnerId, winningAmountMinor, and replay JSON remain populated exactly as before; for a multi-unit Auction winnerId and winningAmountMinor are null, leadingBidId retains its V1 meaning, and awards contains the complete immutable allocation.

新增稳定错误：

- 400 INVALID_AUCTION_UNIT_COUNT: an explicitly supplied unitCount is not a safe integer from 2 through 100
- 400 INVALID_BID_QUANTITY: a multi-unit Bid omits quantity or quantity is not a safe integer from 1 through 20
- 400 BID_TOTAL_OVERFLOW: amountMinor multiplied by quantity exceeds 9007199254740991
- 409 AWARD_ALLOCATION_CONFLICT: a close retry observes an Award set that differs from canonical allocation for the locked Bid snapshot

跨层规则：

- The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
- The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
- Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
- Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

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

迁移必须同时满足：

- Migrate each V1 Auction to unitCount 1 and its winner to one Award without changing bid/outcome/event histories.
- Pending Close Tasks and effective deadlines remain exact.
- Stored one-unit Bid and close replay responses remain byte-equivalent JSON.

T16 只要求影响分析和分阶段修改计划，不允许立即实现。T17-T20 才依次处理迁移、后端、
API、UI、并发和恢复回归。

## 5. 评分结构

| Dimension | Weight |
| --- | ---: |
| Clean build, migration, seed, and operation | 5 |
| Contract, validation, and seed semantics | 5 |
| Complete V1 main flow | 10 |
| Atomicity and durable idempotency | 10 |
| Worker, outbox, and crash recovery | 15 |
| Multi-process consistency | 10 |
| Manager-compatible migration | 15 |
| Manager runtime, UI, and concurrency | 10 |
| Project-owned real tests | 8 |
| Sustained performance plus post-load correctness | 7 |
| Persona-fit explanation | 2 |
| Evidence and handoff | 3 |
| **Total** | **100** |

普通 CRUD 和页面数量不构成主要分值。并发、恢复、幂等、兼容迁移和负载后不变量失败会
触发对应高权重项失分；正式 hard cap 方案见 evaluator 文档。

## 6. 当前完成度

当前为 **D1 设计完成**：公开合同、固定 Manager 正文、22 阶段 Dialogue、100 分 Checklist、
环境设计、独立 fixture commit 和 H-01 至 H-13 黑盒方案已完成。当前**没有 hidden runner**、
'score-manifest.v1.json'、gold、mutant、逐题 project smoke 或 baseline，因此不能声称 D2/D3/D4/D5，
也不能把候选项目自己的 'test:all' 当作正式得分。

## 7. D2 以后仍需完成

- 验证共享 environment profile，并完成当前 task 的真实 project smoke；
- 实现 Harness-owned H-01 至 H-13 runner、中央 score manifest 和 Checklist 'testGates'；
- 冻结 V1/FINAL 双快照并接线 paired scripted curriculum；
- 用 gold、定向 mutants、重复 Control baseline 和 flake run 校准阈值。
