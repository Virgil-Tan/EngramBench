# CommerceCommand Manager 固定需求

V1 完成并通过已有真实测试后，Manager 要求把单商家交易升级为 marketplace 分账和结算：

1. 一个已冻结 `Order` 可以包含多个 Seller；新增 `SellerAllocation`，把每个 OrderLine 的数量和金额完整分配给一个或多个 seller。每条 line 的 allocation 数量和金额必须精确守恒，不能少分、多分或跨 tenant。
2. allocation 在首次成功提交后不可变；相同幂等键重放返回同一结果，不同正文冲突。并发 allocation 只能有一个合法集合，已进入履约的 Order 不得重新分配。
3. 新增 `SellerSettlement`。它冻结周期、currency、eligible allocation、fee、refund reserve、dispute reserve 和净额。`CLOSED` 结算不可改写，也不能把后续退款或争议偷偷写回旧周期。
4. 新增 `CommerceDispute`。同一 captured payment 的 refund 加 dispute reserve 总额不能超过 captured amount；并发退款、开争议和关闭结算必须在数据库中守恒。
5. `LOST` dispute 只产生一次平衡的 chargeback journal 和一次 seller liability 调整；重复、乱序 provider event 不得重复扣款。`WON` 只释放原 reserve。
6. `CLOSED` settlement 之后到达的 refund、chargeback 或纠错只能创建下一开放周期的 immutable `SettlementAdjustment`，并引用原 allocation、settlement 和原因。
7. 新增 `SELLER_SETTLEMENT_CLOSE`、`DISPUTE_RECONCILIATION`、`SETTLEMENT_ADJUSTMENT` Work；它们继续使用 lease、fencing、幂等和崩溃恢复合同。
8. 迁移必须保留全部 V1 ID、Order、OfferVersion、InventoryHold、PaymentAttempt、FulfillmentPlan、EntitlementGrant、LedgerEntry、DomainEvent、Work、NotificationDelivery 和已保存幂等 replay；V1 客户端仍可完成单 seller 交易。
9. 更新 OpenAPI、真实 UI、seed、verification snapshot、Unit、Integration、Chromium E2E、多进程并发和 Barrier/SIGKILL Recovery。
   - `POST /api/v1/orders/:orderId/seller-allocations` 接受 `{allocations:[{orderLineId,sellerId,quantity,amountMinor}]}`。
   - `POST /api/v1/seller-settlements` 接受 `{tenantId,sellerId,periodStart,periodEnd,currency}`；`POST /api/v1/seller-settlements/:sellerSettlementId/close` 接受空对象。
   - `POST /api/v1/commerce-disputes` 接受 `{tenantId,paymentAttemptId,providerDisputeId,amountMinor}`；`POST /api/v1/commerce-disputes/:commerceDisputeId/resolve` 接受 `{providerEventId,outcome}`，其中 outcome 为 `WON` 或 `LOST`。
   - `POST /api/v1/settlement-adjustments` 接受 `{tenantId,sellerId,sourceSettlementId,sourceAllocationId,amountMinor,reason}`，只允许引用 CLOSED settlement 并写入下一开放周期。持久化 `SettlementAdjustment={settlementAdjustmentId,tenantId,sellerId,sourceSettlementId,sourceAllocationId,targetPeriodStart,amountMinor,reason,createdAt}`，其中 `targetPeriodStart >= source settlement.periodEnd`。
   - 所有 mutation 继续要求 `Idempotency-Key`；非法守恒返回 `409 ALLOCATION_NOT_CONSERVED`，超额 reserve 返回 `409 RESERVE_EXCEEDS_CAPTURE`，关闭后改写返回 `409 SETTLEMENT_CLOSED`。
10. 保留 V1 已公布的 7 条性能场景，并增加以下 3 条。正式运行均使用 Release build、固定 seed、`BENCH_PERF_SCALE=1`：
   - Scenario 'seller-settlement-close'：50,000 条 eligible allocation，64 并发持续关闭不同 seller/period 60 秒；吞吐至少 80 settlement/s，p95 不超过 750ms，结束后每条 allocation 最多进入一个 CLOSED settlement，所有净额和 reserve 守恒。
   - Scenario 'refund-dispute-race'：20,000 个 captured order 上以 64 并发持续交错 refund、open dispute 和 provider resolution 60 秒；吞吐至少 100 mutation/s，p95 不超过 750ms，任何时刻 refund + dispute reserve 不超过 captured amount，LOST 只记一次 chargeback。
   - Scenario 'full-catastrophe-recovery'：预装 10,000 个混合实体，在持续 checkout、reconcile、fulfillment、notification、settlement 和 dispute 负载下依次 SIGKILL 一个 API、一个 Worker 和一个 dispatcher，再启动替代进程；300 秒内 Work 和 outbox drain，且全部库存、金额、账本、事件、租户、allocation、settlement 和 replay 不变量仍成立。

本回合只要求影响分析和实施计划，不要立即修改代码。本消息不提供实现或 Debug 提示。
