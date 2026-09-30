# SeatReserve H-01～H-13 黑盒测试计划

Evaluator 只在候选 workspace 外使用公开命令、HTTP/OpenAPI、Chromium、本地 Provider double、receiver、
barrier、进程信号和 verification snapshot，不导入候选源码、ORM、数据库表或内部模块。

## H-01 干净构建、迁移、Seed 和角色启动

干净安装、build、重复 migration；合法空 seed、同 digest replay、冲突、未知成员和非法引用；验证整批
原子回滚，并分别启动 API、Worker、Dispatcher 和 production UI。

## H-02 合同、浏览器和隔离

验证 OpenAPI 3.1 全路径、严格 JSON/UUID/time/money/currency/seat 校验、稳定错误与游标。Chromium 完成
座位选择、Hold、checkout、UNKNOWN reconcile。两个 tenant 的客户、Seat、Hold、Order、Event 和 Work 不交叉。

## H-03 Hold、价格冻结和成功 checkout

在 Price v1 下原子 Hold 多席，竞争激活 v2，然后 checkout 成功。重算 HoldSeat/OrderSeat 的 version、单价、
fee、总额和唯一 owner；v2 只影响激活提交后的 Hold，成功支付只生成一个 Order/transaction/event。

## H-04 原子拒绝

malformed JSON、Idempotency 冲突、重复 seat、跨 Event/tenant seat、部分 unavailable 集合、过期 TTL、重叠
Price interval 和金额溢出均整组失败。前后 snapshot 除时间外一致，无孤儿 HoldSeat、Work 或 Event。

## H-05 响应丢失和持久幂等

API 已提交 Hold 或 checkout 后丢响应，随后串行、20-way、跨 API 和重启 replay。响应、Hold、Order、
PaymentIntent、Work 与 Event identity 一致；body 改变返回 `IDEMPOTENCY_CONFLICT`。

## H-06 热座位、价格和支付竞争

两个 API 64-way 抢同一 seat set，同时激活价格、取消、checkout、Provider receipt 与 reconcile。每个 Seat
最多一个 live owner；冻结价格对应一个序列化边界；Payment/Order 只有一个合法终态。

## H-07 Worker SIGKILL、过期和 UNKNOWN

Evaluator 启动 README 规定的确定性 Provider double，并把它的 URL 注入 Worker。在 `worker.claimed`
barrier 后杀死 HOLD_EXPIRY、PAYMENT_CAPTURE 或 PAYMENT_RECONCILE Worker。lease 后替代者完成；UNKNOWN
grace 前不释放，reconcile 只查询原 providerRequestId，stale owner 不能提交，Work 排空且不重复 charge identity。

## H-08 Outbox 未知 ACK

Receiver 收完整事件后暂停 ACK 并杀 Dispatcher。替代者重发保持 Event ID、aggregate sequence、header 和
canonical body；业务状态、Order 和 Payment 不重复。

## H-09 V1 到 FINAL 迁移

在 V1 保存 Held/Checkout/Confirmed 状态、price references、idempotent response 和 pending Payment Work，
再运行 FINAL migration。全部 identity、ownership、replay 和 Event 保留，新增 Manager 资源为空。

## H-10 Waitlist 和连续 Offer

创建不同 createdAt、Zone、seatCount 和 max price 的 Entries，释放连续/不连续座位。验证公平顺序、同 row
连续集合、冻结价格、单 ACTIVE Offer、两分钟 expiry；accept 原子生成正常 Hold，decline/expiry 继续匹配。

## H-11 Waitlist 并发、取消和恢复

四 API 并发释放、match、cancel、accept/decline，并在 Worker claim 后 SIGKILL。每个 Seat 一个 owner、每
Entry 一个 ACTIVE Offer；旧 lease 不越过 cancel/expiry，replacement 排空 Work，UI 与 snapshot 一致。

## H-12 三条专属持续压力场景

固定 4 vCPU、8 GiB RAM、PostgreSQL 16、4 API、4 Worker，正式评分使用完整规模：

1. `seat-hold-ingest`：50,000 个不相交 Hold、concurrency 96，>=250 holds/s、p95<=400ms、0 5xx；冻结价格与总额全部正确。
2. `hot-seat-contention`：20,000 attempts 竞争 1,000 hot Seats、concurrency 128，>=300 attempts/s、p95<=500ms；每 Seat 恰好一个 live owner，失败无部分集合。
3. `payment-expiry-recovery`：5,000 CHECKOUT/UNKNOWN Orders 与 expiry 混合，claim 后 SIGKILL 2 Worker，4
   替代者通过原 provider identity reconcile，在 90 秒内让本场景 PaymentIntent、Order、Hold 及其 Work
   全部终态；无超卖、重复 provider identity 或 stranded Hold。前两场景尚未到期的 HOLD_EXPIRY Work
   不计入本场景 drain，但仍必须保持合法、不可提前释放。

每条负载后重算 seat ownership、Hold/Order relation、PriceVersion、金额、Provider identity、Work 和 Event。
阈值、5xx、重复、提前释放、超卖、租户泄漏或未排空均失败。

## H-13 项目测试真实性

从干净安装审计并运行 Unit、真实 PostgreSQL/HTTP Integration、production Chromium E2E、至少双 API/双
Worker Concurrency、barrier+SIGKILL Recovery 和 Aggregate。拒绝 placeholder，确认 `test:perf` 运行上述
三条完整场景并检查负载后正确性。

## Hard caps

无法 build/boot、任何超卖或部分 Hold、冻结价格改变、UNKNOWN 提前释放、重复 Order/charge identity、
Waitlist 重复 Offer、迁移丢状态或负载后不变量失败均触发 hard cap。读取 hidden assets 或逃逸隔离使样本无效。
