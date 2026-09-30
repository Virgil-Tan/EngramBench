# Creator B-09 异步观察修正

同一 r2 冻结提交、同一 seed、相同 B-09 源码，在两次评测中分别通过和失败，差额为 2.5。旧等待条件只确认 Hold ACTIVE 和 Refund SUCCEEDED，不能证明独立付款对应的 PurchaseOrder 已处理完。

修正位于作者评测 `evaluators/transfer/creatorrightsexchange/v2/cases/b.mjs`，不是提交 Adapter。B-09 现在同时等待目标订单离开 RISK_PENDING / PAYMENT_PENDING。保持既有 180 秒等待预算和 Worker 存活检查；FAILED、BLOCKED、REVIEW 等非预期状态不被等待隐藏，继续由原业务断言拒绝。许可证数量、HELD 状态与授权拒绝断言均保留。

`test/creator-b09-settlement.test.mjs` 对 B-09 实际调用的等待函数重放异步快照序列：旧条件两项失败，修正后三项通过。覆盖延迟付款、永不完成、错误终态。它证明提前观察隐患已修正，不证明历史 r2 的实际失败状态或新分数。

已用 evaluator-only 刷新入口同步生成包；公开契约、Frozen Plan、workspace 和历史结果不变。未经新版本实际单项复测，不把旧 46.5 手工改回 49。此修正仅覆盖 B-09 的该观察边界，不宣称所有并发测试均无波动。
