# EntitlementHub Manager 固定需求

V1 通过后增加组织席位 `EntitlementPool`：

1. FINAL 为 Subscription 创建请求兼容新增可选 `subscriptionKind: INDIVIDUAL | ORGANIZATION`；V1 历史记录和省略该字段的请求均按 `INDIVIDUAL` 解释。只有 `ORGANIZATION` 订阅可以创建 Pool；Pool 冻结 `subscriptionId`、feature、初始 seatLimit 和当前 plan period，初始 seatLimit 不得超过该 PlanRevision 的 feature limit，现有个人订阅不自动迁移。
   Pool 状态为 `ACTIVE | OVER_LIMIT | REVOKED | EXPIRED`。公开形状为 `EntitlementPool = {poolId:uuid,tenantId:uuid,subscriptionId:uuid,feature:string,seatLimit:int,state:string,version:int,periodStart:timestamp,periodEnd:timestamp,createdAt:timestamp}` 和 `SeatAssignment = {poolId:uuid,subjectId:string,state:ACTIVE|REVOKED|EXPIRED,assignedAt:timestamp,terminalAt:timestamp|null}`；FINAL snapshot 使用 `entitlementPools` 与 `seatAssignments`。
2. `SeatAssignment` 状态为 `ACTIVE -> REVOKED | EXPIRED`。同一 Pool 中 subject 唯一，ACTIVE 数不得超过 seatLimit。
3. `POST /api/v1/entitlement-pools` 使用 `{tenantId:uuid,subscriptionId:uuid,feature:string,seatLimit:int}` 并返回 `EntitlementPool`；`POST /api/v1/entitlement-pools/:poolId/assignments` 使用 `{subjectId:string,expectedPoolVersion:int}`，`POST /api/v1/entitlement-pools/:poolId/assignments/:subjectId/revoke` 使用 `{expectedPoolVersion:int}`，两者返回 `{pool:EntitlementPool,assignment:SeatAssignment}`；`GET /api/v1/entitlement-pools/:poolId/assignments` 返回 `{items:[SeatAssignment],nextCursor:string|null}`。Pool version 从 0 开始，每次成功分配或撤销恰好加 1；三个 mutation 都要求 durable `Idempotency-Key`。
4. upgrade/downgrade 会按新 PlanRevision 的 feature limit 原子调整 Pool seatLimit，退款、取消、过期会原子撤销 Pool 能力；seatLimit 降低时先进入 `OVER_LIMIT`，禁止新分配但不任意驱逐，管理员显式撤销至合法后恢复 `ACTIVE`。
5. 两个 API 的并发分配、最后一个 seat 与 subscription revoke/expire 竞争必须可串行化；Pool 调整与撤权分别使用公开 Work kind `POOL_RECONCILE` 和 `POOL_REVOKE`，两者均以 `aggregateId = poolId`。撤权在 2 秒内对所有 API 可见，旧传播不能重新启用。新增稳定错误为 `409 ORGANIZATION_SUBSCRIPTION_REQUIRED`、`409 POOL_VERSION_CHANGED`、`409 POOL_CAPACITY_EXCEEDED`、`409 POOL_OVER_LIMIT`、`409 POOL_TERMINAL`、`409 SEAT_ALREADY_ASSIGNED`、`409 IDEMPOTENCY_CONFLICT` 和 `404 NOT_FOUND`；错误仍使用 V1 的标准 JSON envelope。
6. 迁移保留全部 V1 Subscription、PlanChange、Refund、Grant、fence、Audit、Event、Work 和 replay。个人 EntitlementView 响应保持兼容。
7. 更新 OpenAPI、Worker、production UI、Integration、Chromium、Concurrency、Recovery 和三条压力后的 Pool 不变量。

首次出现只做影响分析和计划；本消息不提供表、锁、事务、算法或 Debug 提示。
