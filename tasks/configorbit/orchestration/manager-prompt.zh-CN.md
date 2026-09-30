# ConfigOrbit Manager 固定需求

V1 通过后增加跨环境 `PromotionTrain`：

1. 一个 Train 冻结同一 Application 的一个已发布 ConfigRevision 内容，并按 development、staging、production 的明确阶段推进；每个 Stage 有独立 rollout basis points。
2. Train 状态为 `DRAFT -> RUNNING -> COMPLETED | ROLLED_BACK | CANCELLED`，Stage 为 `PENDING -> ACTIVE -> PROMOTED | ROLLED_BACK`。启动后 revision digest、阶段顺序和受众 salt 不可修改。公开形状为
   `PromotionTrain = {trainId:uuid,tenantId:uuid,applicationId:uuid,name:string,revisionId:uuid,revisionDigest:sha256,state:string,audienceSalt:string,createdAt:timestamp,startedAt:timestamp|null,terminalAt:timestamp|null}` 和
   `PromotionStage = {trainId:uuid,position:int,environmentId:uuid,rolloutBasisPoints:int,state:string}`；`position` 从 0 开始，FINAL snapshot 使用 `promotionTrains` 与 `promotionStages`。
3. `POST /api/v1/promotion-trains` 使用 `{tenantId:uuid,applicationId:uuid,name:string,revisionId:uuid,stages:[{environmentId:uuid,rolloutBasisPoints:int}]}`；`POST /api/v1/promotion-trains/:trainId/start` 使用 `{}`；`POST /api/v1/promotion-trains/:trainId/advance` 与 `POST /api/v1/promotion-trains/:trainId/rollback` 使用 `{expectedStage:int,expectedEnvironmentGeneration:int}`，其中 `expectedStage` 是从 0 开始的当前 Stage position，generation 是该 Stage 环境的当前 generation。每个 mutation 都要求 durable `Idempotency-Key`，成功响应返回完整 `PromotionTrain`；并发操作只能有一个成功。
4. 每次推进仍创建目标环境的正常不可变 Release、generation、invalidation、audit 和 event；前一环境历史不得被重写。
5. 任一 Stage 回滚只在该环境创建补偿 Release，不得倒退其他环境 generation；advance 与 rollback 分别使用公开 Work kind `PROMOTION_ADVANCE` 和 `PROMOTION_ROLLBACK`，两者均以 `aggregateId = trainId`。重复、未知响应和 Worker 重启收敛。新增稳定错误为 `409 PROMOTION_TRAIN_FROZEN`、`409 PROMOTION_STAGE_CHANGED`、`409 ENVIRONMENT_GENERATION_CHANGED`、`409 PROMOTION_TRAIN_TERMINAL`、`409 IDEMPOTENCY_CONFLICT` 和 `404 NOT_FOUND`；错误仍使用 V1 的标准 JSON envelope。
6. 迁移保留 V1 revision、release、rollout assignment、observation、invalidation、event、Work 和 idempotency replay。已有 Release 不自动加入 Train。
7. 更新 OpenAPI、Worker、UI、Integration、Chromium、Concurrency、Recovery 和性能后的不变量验证。

首次发布本消息时只做影响分析和分阶段计划；本消息不提供实现或 Debug 提示。
