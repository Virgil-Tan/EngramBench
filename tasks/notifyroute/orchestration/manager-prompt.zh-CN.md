# NotifyRoute Manager 固定需求

在 V1 完成并通过现有测试后，Manager 要求增加冻结受众的 Broadcast Campaign：

1. `POST /api/v1/campaigns` 按 Tenant 和显式 recipientIds 创建 Campaign，并在同一事务中冻结去重后的受众、TemplateVersion、RoutePolicy revision 和创建时的 Suppression revision。
2. Campaign 状态为 `QUEUED -> RUNNING -> COMPLETED | CANCELLED`，另支持 `RUNNING <-> PAUSED`；状态只能单调进入终态。
3. 每个 Campaign 和 Recipient 最多生成一个 Notification。Worker 重试、租约过期和并发 fan-out 不能重复生成。
4. pause 必须阻止新的 fan-out，但不撤回 Provider 已接受的 Delivery；resume 只继续未创建的受众。
5. cancel 必须用 durable fence 阻止所有尚未创建或尚未开始外部发送的项目；已经 Provider ACCEPTED 的项目保留真实状态，不伪装撤回。
6. 并发 pause、resume、cancel 和 Worker claim 必须串行化；一旦 `CANCELLED`，任何旧 lease 都不能继续产生 Notification 或外部发送。
7. 新增 `Campaign`、`CampaignRecipient` snapshot resource 和 `CAMPAIGN_FANOUT` Work，并保留完整事件顺序和幂等 replay。
8. 迁移必须保留 V1 Notification、Delivery、Suppression、RateLimit、ProviderReceipt、Event 和 Work 身份。
9. 更新 OpenAPI、真实 Campaign UI、Integration、Chromium E2E、多进程并发和 Barrier/SIGKILL Recovery。

本消息只描述产品需求，不提供实现、锁策略、SQL、命令或 Debug 提示。
