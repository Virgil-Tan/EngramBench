# AuctionGuard Harness-owned E2E / Concurrency / Recovery / Performance 方案

## 1. 边界与等级

本文件位于 candidate workspace 外，只定义 D1 黑盒评测方案。当前没有 runner、中央 score
manifest、gold 或 calibration 证据，不能声称 D3。Evaluator 只使用公开命令、HTTP、浏览器、
webhook receiver、文件下载和进程信号；不得 import 候选源码、ORM、表名或 'dist' 路径。

## 2. 固定环境

- Node.js 22、PostgreSQL 16、Chromium 和 Docker-compatible OCI；容器限制为 4 logical CPUs、
  8 GiB RAM，两个 API、两个 workers、一个 dispatcher 和 PostgreSQL 共享该限制；
- 每个 scenario 使用新数据库、新端口和独立 managed data directory；
- 两个 API、至少两个 Close Task workers 和一个 dispatcher 共享同一 PostgreSQL；
- command timeout 60 分钟，project timeout 24 小时；
- 合法随机输入和交错保存私有 seed，失败报告只公开脱敏后的断言与复现 ID。

## 3. Snapshot 与 barrier

T15 后冻结 'V1_SNAPSHOT'，T22 后冻结 'FINAL_SNAPSHOT'。H-09 先用 V1 binary/contract 写入
历史数据、pending work、event 和 idempotency replay，再切换到 FINAL migration。

- unknown HTTP outcome：response shield 收到完整 upstream response 后断开 candidate client；
- unknown webhook ACK：receiver 收到并持久化完整 request 后暂停 ACK，再 SIGKILL dispatcher；
- worker recovery：按公开 'TEST_BARRIER_URL' 协议在 'worker.claimed'、
  'worker.effect-complete' 或 'worker.before-commit' 收到完整 barrier body 后暂停，再 SIGKILL
  worker 并等待 'WORK_LEASE_SECONDS'；
- 不允许随机 sleep 推断 commit、claim、delivery 或 ACK 时点。

## 4. Hidden scenario design

### H-01 Clean install, migration, seed, build, and boot

从 fixture commit 开始执行公开命令；migration 重放；合法 seed、同 digest 重放、冲突版本和随机
非法成员；生产 API/UI/worker/dispatcher 全部启动。断言 OpenAPI 与 runtime 基础状态一致。

### H-02 Contract, validation, query, and browser baseline

随机 UUID、边界整数、未知字段、媒体类型、游标和时间；验证稳定错误、分页、排序、真实 React
页面、键盘路径、移动布局和 refresh 后状态。

### H-03 V1 successful main flow

通过公开 API 和浏览器完成：

- Create scheduled Auctions and open them through persisted time boundaries.
- Accept strictly increasing integer-minor-unit Bids with durable scoped idempotency.
- Select a deterministic Leading Bid under concurrent API requests and extend endAt under the exact anti-sniping rule.
- Close with recoverable Close Tasks and publish exactly one winner or no-sale result.
- Expose live bid history, countdown based on server time, outcome, and event delivery in the UI.

对每个成功状态同时检查响应、查询、历史、异步工作和事件。

### H-04 Atomic rejection and conservation

在每个公开失败边界生成合法但不可满足的请求，断言无 partial aggregate、任务、事件或守恒量
变化。核心断言：

1. Accepted bid amounts for an Auction are strictly increasing in committed sequence.
2. At most one Bid is Leading and at most one winner is finalized in V1.
3. A Bid accepted before the effective deadline cannot be lost by a concurrent close.
4. Each qualifying accepted Bid applies at most one deterministic deadline extension.
5. Closing emits one immutable outcome and repeated workers cannot change it.

### H-05 Durable idempotency and unknown response

对每个 mutation 测试相同 key replay、语义冲突、20 路并发、response shield、API SIGKILL 和
重启。状态码与语义 JSON 保持原结果，且只出现一次业务效果和事件。

### H-06 Multi-process contention

两个 API 和两个 workers 对同一热点 authority 进行有 seed 的竞争；随机化合法请求数量和顺序，
最后通过公开查询重算全部不变量，不依赖数据库内部结构。

### H-07 Worker lease and terminal recovery

分别在 claim 后、外部工作后、commit 前 barrier SIGKILL worker；等待 'WORK_LEASE_SECONDS' 后
启动另一 worker，断言任务可恢复、stale token 失败、终态和副作用最多一次。

### H-08 Transactional outbox and unknown ACK

对成功和回滚业务检查 event existence；receiver 返回 500、断开连接、在完整 body 后暂停 ACK，
dispatcher 重启。重试保持 eventId/body，成功顺序递增，不能丢 event 或制造新身份。

### H-09 Populated V1 to FINAL migration

V1_SNAPSHOT 生成普通、边界、terminal、pending、leased、undelivered 和已保存 replay 数据。
FINAL migration 后逐项验证：

- Migrate each V1 Auction to unitCount 1 and its winner to one Award without changing bid/outcome/event histories.
- Pending Close Tasks and effective deadlines remain exact.
- Stored one-unit Bid and close replay responses remain byte-equivalent JSON.

### H-10 Manager core behavior

仅在 T16 已发布后按黑盒方式验证：

- An Auction may offer 2-100 identical Units and each Bid requests quantity 1-20 at one maximum unit price.
- At close, sort accepted Bids by unit price descending, committed sequence ascending, then bidId; allocate until Units are exhausted.
- The clearing unit price is the lowest winning unit price; a final Bid may receive a partial quantity.
- Closing creates 1-N immutable Awards atomically, never more awarded Units than available.
- Cancellation remains illegal after any accepted Bid; anti-sniping semantics are unchanged.
- Legacy single-unit Auctions keep leadingBidId, winnerId, and winningAmountMinor; multi-unit Auctions keep leadingBidId as the current highest-price Bid, return null for winnerId and winningAmountMinor, and expose awards[].
- For a multi-unit Bid, amountMinor multiplied by quantity must be a JSON safe integer; this also bounds every Award totalAmountMinor.

新增 wire schema 与接口同样属于断言面：

- MultiUnitBid = {bidId:uuid,auctionId:uuid,bidderId:uuid,amountMinor:int,quantity:int,committedSequence:int,state:ACCEPTED|OUTBID|WINNING,acceptedAt:timestamp,effectiveEndAtAfter:timestamp}
- Award = {awardId:uuid,auctionId:uuid,bidId:uuid,bidderId:uuid,allocatedQuantity:int,clearingUnitPriceMinor:int,totalAmountMinor:int,allocationRank:int,createdAt:timestamp}
- MultiUnitAuctionOutcome = {auctionId:uuid,result:WINNER|NO_SALE,unitCount:int,allocatedUnitCount:int,unallocatedUnitCount:int,clearingUnitPriceMinor:int|null,awards:[Award],closedAt:timestamp}
- AuctionDetail = {auctionId:uuid,lotId:uuid,currency:currency,reservePriceMinor:int,minimumIncrementMinor:int,startAt:timestamp,effectiveEndAt:timestamp,state:SCHEDULED|OPEN|CLOSING|CLOSED|CANCELLED,leadingBidId:uuid|null,winnerId:uuid|null,winningAmountMinor:int|null,sequence:int,unitCount:int,awards:[Award],outcome:AuctionOutcome|MultiUnitAuctionOutcome|null}; outcome is null before CLOSED, AuctionOutcome for a closed one-unit Auction, and MultiUnitAuctionOutcome for a closed multi-unit Auction
- POST /api/v1/admin/auctions accepts the V1 fields plus unitCount; omission creates a legacy one-unit Auction, while an explicit multi-unit value must be an integer from 2 through 100.
- POST /api/v1/auctions/:auctionId/bids accepts {bidderId,amountMinor,quantity}; quantity is required and must be 1..20 for a multi-unit Auction, amountMinor * quantity must be <= 9007199254740991, and the legacy one-unit request may omit quantity and receives quantity 1.
- GET /api/v1/auctions/:auctionId returns the exact AuctionDetail. A multi-unit outcome and AuctionDetail.awards use identical Awards ordered by allocationRank; each Award totalAmountMinor equals allocatedQuantity multiplied by the common clearingUnitPriceMinor.
- For a one-unit Auction the existing leadingBidId, winnerId, winningAmountMinor, and replay JSON remain populated exactly as before; for a multi-unit Auction winnerId and winningAmountMinor are null, leadingBidId retains its V1 meaning, and awards contains the complete immutable allocation.
- 400 INVALID_AUCTION_UNIT_COUNT: an explicitly supplied unitCount is not a safe integer from 2 through 100
- 400 INVALID_BID_QUANTITY: a multi-unit Bid omits quantity or quantity is not a safe integer from 1 through 20
- 400 BID_TOTAL_OVERFLOW: amountMinor multiplied by quantity exceeds 9007199254740991
- 409 AWARD_ALLOCATION_CONFLICT: a close retry observes an Award set that differs from canonical allocation for the locked Bid snapshot
- The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
- The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
- Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
- Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

FINAL snapshot 与性能兼容断言：

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

同时验证每个失败分支整组回滚和重复请求一致。

### H-11 Manager UI, concurrency, and recovery

用 production Chromium 完成新旧流程；两个 API/worker 竞争 Manager 新基数或状态；在可观察
barrier 崩溃并恢复；检查 compatibility fields、聚合状态、成员状态、事件顺序和无重复效果。

### H-12 Sustained performance plus post-load correctness

严格对 FINAL binary 重跑 workspace README 的同三个 V1-compatible scenario，不得改变任何字段或
阈值；Manager 增量只增加 correctness、concurrency 和 recovery 断言。每个 scenario 使用独立新库，
严格执行公开 dataset、setup、selector、request、concurrency、warm-up、measurement、success、
threshold 和 timer，记录 p50/p95/p99、吞吐、成功 mutation、预期冲突、unexpected 5xx、
worker/dispatcher backlog 与排空时间。固定 dataset 为：seedVersion perf-v1 contains exactly 100,000 bidders, 2,020 lots, 2,020 auctions, and 50,000 bids; exactly 20 Auctions are OPEN hot targets and 2,000 Auctions are CLOSING with due Close Tasks.。三个场景是：

### Scenario 'hot-auction-bids'

- Target: accept 250 Bids/s on 20 hot Auctions with p95 <= 300 ms
- Mode: 'http'
- Method: 'POST'
- Path: '/api/v1/auctions/:auctionId/bids'
- Setup: Use exactly 20 seeded OPEN hot Auctions and disjoint warm-up and measured Bidder pools. Keep one sequential producer per Auction.
- Selector: Each of 20 producers targets one Auction and chooses the next bidderId bytewise; amountMinor is prior accepted amount plus minimumIncrementMinor.
- Request: {bidderId,amountMinor}; the producer waits for its response before computing the next amount and always uses a fresh key.
- Concurrency: 20
- Warm-up seconds: 10
- Measure seconds: 60
- Success: Only 201 accepted Bids count; committedSequence is gapless, the leader matches the greatest committed amount, and no 409 is in the success numerator.
- Threshold: At least 250 accepted Bids/s across the 20 Auctions for 60 seconds and p95 <= 300 ms; unexpected 5xx = 0.
- Timer: The throughput window starts with the first measured request after warm-up; each latency sample runs from request dispatch through the complete response body.

### Scenario 'live-auction-read'

- Target: serve 400 live Auction reads/s with p95 <= 100 ms
- Mode: 'http'
- Method: 'GET'
- Path: '/api/v1/auctions/:auctionId'
- Setup: Use the same 20 OPEN hot Auctions without issuing Bids in this independent run.
- Selector: Round-robin auctionId values bytewise.
- Request: No body or query parameters.
- Concurrency: 64
- Warm-up seconds: 10
- Measure seconds: 60
- Success: Only 200 Auction responses whose leader, amount, state, and effectiveEndAt agree atomically count.
- Threshold: At least 400 successful reads/s for 60 seconds and p95 <= 100 ms; mixed revisions and unexpected 5xx are zero.
- Timer: The throughput window starts with the first measured request after warm-up; each latency sample runs from request dispatch through the complete response body.

### Scenario 'auction-close-recovery'

- Target: close 2,000 due Auctions within 45 s after restart
- Mode: 'worker'
- Method: 'N/A'
- Path: 'work:AUCTION_CLOSE'
- Setup: Exactly 2,000 CLOSING Auctions have due Close Work. Hold two workers at worker.claimed, SIGKILL, wait for lease expiry, then start two replacements.
- Selector: Close by effectiveEndAt,auctionId using the locked canonical Bid snapshot.
- Request: No measured client request is issued; setup uses only the published seed and public APIs before the worker timer starts.
- Concurrency: 2
- Warm-up seconds: 0
- Measure seconds: 45
- Success: Every Auction becomes CLOSED exactly once with one canonical AuctionOutcome, no AUCTION_CLOSE Work remains nonterminal, and stale workers cannot create another outcome.
- Threshold: The 2,000-Auction backlog drains in <= 45 seconds after replacement spawn; unexpected failures = 0.
- Timer: Start when both replacements spawn and stop at the first point-in-time snapshot proving all outcomes and invariants.

负载后重新执行 H-04 的全部不变量；任何不变量失败都使性能 assertion 失败。不得从旧的目标
摘要推断 workload，也不得把 Manager 增量改成第四个性能阈值。

### H-13 Project-owned gates and handoff truthfulness

从干净数据库逐个运行公开 test 命令，检查真实进程、真实 PostgreSQL、真实 Chromium、barrier
故障和 meaningful assertions；交叉核对最终回复所称命令、结果、性能、风险和未运行项。

## 5. 100 分映射

H-01 -> 5；H-02 -> 5；H-03 -> 10；H-04/H-05 -> 10；H-07/H-08 -> 15；
H-06 -> 10；H-09 -> 15；H-10/H-11 -> 10；H-13 tests -> 8；H-12 -> 7；
blind Judge explanation -> 2；evidence/handoff -> 3。最终 D3 必须把每个 assertion ID、唯一权重、
Checklist testGate 和 hard cap 写入一个 'score-manifest.v1.json'，不能重复计分。

## 6. Hard caps 与 invalid sample

- clean build、migration 或 production boot 失败：总分上限 25；
- 任一守恒、非负、唯一终态、at-most-once business effect 或 atomic rejection 不变量失败：上限 35；
- durable idempotency 在并发、未知响应或重启后产生第二效果：上限 30；
- 已提交业务缺 event、回滚业务有 event、event 重试改变身份/正文：上限 40；
- SIGKILL 后合法 pending work 永久丢失或 stale worker 可提交：上限 40；
- migration 丢历史数据、改变已保存 replay 或破坏旧客户端：上限 35；
- 性能后核心不变量失败：性能项 0 且应用相应 correctness cap。

读取 hidden assets、硬编码私有 fixture、访问 workspace 外路径或逃逸隔离标记为 invalid sample，
不是普通低分。

## 7. Calibration gate

实现 runner 后，先准备 gold 以及至少五个 mutants：process-local idempotency、非原子 event、
无 fencing lease、Manager partial migration、只测吞吐不验 invariant。相同 candidate/seed 至少
重复三次；所有 mutant 必须触发预期 assertion/cap，再冻结 image、fixture commit、README、
Manager、dialogue、score manifest、seed generator 和阈值。
