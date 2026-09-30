# RoutePilot Manager 固定需求

V1 完成并通过现有测试后，新增分区域的 `RegionalRollout`：

1. `POST /api/v1/regional-rollouts` 在同一事务中冻结 Tenant、目标 ConfigRelease、去重且有序的 region stages，以及每阶段最小观察时间和失败阈值。
2. 状态为 `QUEUED -> RUNNING -> COMPLETED | CANCELLED | ROLLED_BACK`，并支持 `RUNNING <-> PAUSED`；终态不可离开。
3. 每个 `(rolloutId, region)` 最多一个 `RegionalStage`。只有当前阶段达到观察条件且未越过失败阈值，下一阶段才能激活。
4. pause 阻止新 region 激活但不改变已激活请求；resume 只继续剩余阶段。cancel 停止未来阶段且不伪装回滚。
5. rollback 原子恢复每个已激活 region 在 rollout 开始时冻结的 prior release；旧 Worker lease 不得重新激活目标 release。
6. 两个 API 的 pause/resume/cancel/rollback 与 Worker claim 必须收敛到一个合法状态和一组稳定事件。
7. 新增 `RegionalRollout`、`RegionalStage` snapshot resource 和 `REGIONAL_ROLLOUT_ADVANCE` Work。
8. 兼容迁移必须把 V1 的全局 active release 表示为 region=`GLOBAL`，且保留 RouteRevision、ConfigRelease、GatewayRequest、RateWindow、CircuitWindow、Event、Work 和幂等 replay 身份。
9. 更新 OpenAPI、真实区域 Rollout UI、Integration、Chromium E2E、多进程并发与 barrier/SIGKILL recovery。

新增公开接口为：

```text
GET/POST /api/v1/regional-rollouts
GET      /api/v1/regional-rollouts/:regionalRolloutId
POST     /api/v1/regional-rollouts/:regionalRolloutId/pause
POST     /api/v1/regional-rollouts/:regionalRolloutId/resume
POST     /api/v1/regional-rollouts/:regionalRolloutId/cancel
POST     /api/v1/regional-rollouts/:regionalRolloutId/rollback
```

创建请求为 `{tenantId,targetConfigReleaseId,stages:[{region,minimumObservationSeconds,failureThresholdPercent}],requestRef}`；控制接口使用空对象，均遵循现有 Idempotency-Key、strict JSON、租户隔离、稳定 replay 和错误 envelope。

新增公开资源的精确形状为：

```text
RegionalRollout = {regionalRolloutId,tenantId,targetConfigReleaseId,requestRef,state:QUEUED|RUNNING|PAUSED|COMPLETED|CANCELLED|ROLLED_BACK,currentStageOrdinal:int|null,createdAt,updatedAt,sequence:int}
RegionalStage = {regionalStageId,regionalRolloutId,ordinal:int,region,minimumObservationSeconds:int,failureThresholdPercent:int,priorConfigReleaseId,targetConfigReleaseId,state:PENDING|ACTIVE|SUCCEEDED|FAILED|ROLLED_BACK,activatedAt:null|timestamp,completedAt:null|timestamp}
```

`stages` 按请求首次出现顺序去重，`ordinal` 从 0 连续递增；范围为观察时间 1..86400 秒、失败阈值 0..100。创建返回 `{regionalRollout:RegionalRollout,stages:RegionalStage[]}`，查询返回同一形状。控制接口返回更新后的 `RegionalRollout`。新增稳定错误为 `REGIONAL_ROLLOUT_TERMINAL`、`REGIONAL_STAGE_NOT_READY`、`REGIONAL_ROLLBACK_UNAVAILABLE` 和 `EXPECTED_ROLLOUT_STATE_MISMATCH`，均为 409，失败不得留下部分 Stage、Work 或 Event。
`REGIONAL_ROLLOUT_ADVANCE` Work 的 `aggregateId` 必须是 `regionalRolloutId`。

迁移时每个已有 Tenant 必须创建一个确定性的 `requestRef="legacy-global"` COMPLETED Rollout 和唯一 `region="GLOBAL"`、`ordinal=0`、`state=SUCCEEDED` Stage，二者都指向迁移前 ACTIVE ConfigRelease；重复 migration 不得更换这些 identity。

本消息只描述产品行为，不提供代码、SQL、锁、算法、命令或 Debug 提示。本轮只做影响分析和修改计划。
