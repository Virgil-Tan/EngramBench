# ImportWorks Manager 固定需求

V1 完成并通过现有测试后，增加跨文件 `ImportBundle` 原子发布：

1. 一个 Bundle 冻结同一租户下多个已经 `VALIDATED` 的 ImportJob；这里 `VALIDATED` 表示校验完成且可以包含 findings，带 findings 的 `ALL_OR_NOTHING` Job 到 commit 或 Bundle publish 时才进入 `REJECTED`。同一 ImportJob 只能属于一个未终结 Bundle。
2. Bundle 状态为 `DRAFT -> STAGED -> PUBLISHING -> PUBLISHED | REJECTED | CANCELLED`。成员、Schema Revision、源摘要和提交模式在 `STAGED` 后不可修改。公开形状为
   `ImportBundle = {bundleId:uuid,tenantId:uuid,name:string,state:string,createdAt:timestamp,stagedAt:timestamp|null,publishedAt:timestamp|null}` 和
   `BundleMember = {bundleId:uuid,importId:uuid,position:int,schemaRevision:int,sourceSha256:sha256,commitMode:ALL_OR_NOTHING|VALID_ROWS}`；FINAL snapshot 使用 `importBundles` 与 `bundleMembers`。
3. `POST /api/v1/import-bundles` 使用 `{tenantId:uuid,name:string}`；`POST /api/v1/import-bundles/:bundleId/members` 使用 `{importId:uuid}`；`POST /api/v1/import-bundles/:bundleId/stage` 和 `POST /api/v1/import-bundles/:bundleId/publish` 均使用 `{}`。每个 mutation 都要求 durable `Idempotency-Key`，成功响应返回对应的完整 Bundle 或 Member 公共形状。
4. publish 要么提交所有成员允许发布的记录并同时创建事件，要么一个都不提交；`ALL_OR_NOTHING` 成员的错误会拒绝整个 Bundle。
5. 两个 API、重复请求、未知响应和 Worker 重启必须收敛到一个 Bundle 结果。Bundle publish 使用公开 Work kind `BUNDLE_PUBLISH`，且 `aggregateId = bundleId`。失败后不得留下只发布一部分成员的状态。新增稳定错误为 `409 BUNDLE_MEMBER_CONFLICT`、`409 BUNDLE_FROZEN`、`409 BUNDLE_NOT_STAGEABLE`、`409 BUNDLE_NOT_PUBLISHABLE`、`409 IDEMPOTENCY_CONFLICT` 和 `404 NOT_FOUND`；错误仍使用 V1 的标准 JSON envelope。
6. 迁移必须保留所有 V1 ImportJob、chunk、finding、record、report、event 和 idempotency replay。已有已提交 ImportJob 视为不可变的单成员历史发布，不得回写。
7. 更新 OpenAPI、Worker、production UI、Integration、Chromium、Concurrency、Recovery 和三条性能场景后的 Bundle 不变量。

本消息只给产品需求，不提供表、锁、事务、算法或 Debug 提示。首次出现时只要求影响分析和分阶段计划。
