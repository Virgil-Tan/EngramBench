# BillForge Manager 固定需求

在 V1 完成并通过现有测试后，Manager 要求增加争议、Chargeback 和关账后 Adjustment：

1. 成功 PaymentIntent 可以创建多个 Dispute，但 Refund 成功额、Refund 预留额、Dispute 预留额之和不得超过 captured amount。
2. Dispute 状态为 `OPEN -> WON | LOST`。`WON` 释放预留；`LOST` 原子创建一组平衡的 Chargeback Ledger Entries，且只能创建一次。
3. Refund 与 Dispute resolve 并发时，对剩余可退款金额必须只有一个可串行化结果，不允许超额退款或重复冲销。
4. 已 CLOSED 的 SettlementRun 不得修改或重新计算。修正只能创建 Adjustment，引用原 Posting，并在下一个开放周期创建平衡分录。
5. 新增 `POST /api/v1/payment-intents/:paymentIntentId/disputes`、`POST /api/v1/disputes/:disputeId/resolve` 和 `POST /api/v1/settlements/:settlementId/adjustments`。
6. 迁移必须保留所有 V1 Invoice、PaymentIntent、Refund、Ledger Entry、Settlement snapshot、Event 和幂等 replay 的身份与语义。
7. 更新 OpenAPI、真实 UI、Integration、Chromium E2E、并发、SIGKILL Recovery 和性能后不变量验证。

本消息只描述产品需求，不提供实现或 Debug 提示。
