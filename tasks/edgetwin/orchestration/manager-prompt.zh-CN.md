# EdgeTwin Manager 固定需求

V1 完成并通过现有测试后，为 UpgradeCampaign 增加健康门控 `DeploymentWave`：

1. Campaign 创建时冻结有序 wave 定义、每 wave 的设备成员、最小观察时间、最大失败率和目标 FirmwareRelease。
2. Wave 状态为 `PENDING | RUNNING | PAUSED | SUCCEEDED | FAILED | ROLLED_BACK`；同一 Campaign 同时最多一个 RUNNING wave。
3. 只有设备上报匹配 firmware digest 的成功 receipt 才算成功；dispatch、连接或 shadow 更新都不能替代确认。
4. 达到失败阈值时 durable 自动暂停，旧 Worker lease 不能继续向后续 wave 发命令。resume 只继续未终态设备。
5. rollback 为已成功设备创建一个冻结 prior firmware 的唯一补偿 UpgradeTarget；重复和乱序 receipt 不得重复回滚。
6. 两个 API 的 pause/resume/cancel/rollback 与 Worker claim 必须收敛到一个合法状态；cancel 不伪装撤回设备已执行的命令。
7. 新增 `DeploymentWave`、`WaveDevice` snapshot resource 和 `DEPLOYMENT_WAVE_ADVANCE` Work。
8. 兼容迁移把现有 V1 Campaign 表示为一个 legacy wave，并保留 Device、Shadow、Command、Receipt、UpgradeTarget、Event、Work 与幂等 replay 身份。
9. 更新 OpenAPI、真实 wave UI、Integration、Chromium E2E、多进程并发和 barrier/SIGKILL recovery。

新增公开接口为：

```text
GET/POST /api/v1/deployment-waves
GET      /api/v1/deployment-waves/:deploymentWaveId
POST     /api/v1/deployment-waves/:deploymentWaveId/pause
POST     /api/v1/deployment-waves/:deploymentWaveId/resume
POST     /api/v1/deployment-waves/:deploymentWaveId/cancel
POST     /api/v1/deployment-waves/:deploymentWaveId/rollback
```

创建请求为 `{tenantId,upgradeCampaignId,requestRef,waves:[{name,deviceIds,minimumObservationSeconds,maximumFailurePercent}]}`；控制接口使用空对象，并继承现有 Idempotency-Key、strict JSON、稳定 replay、tenant scope 和错误 envelope。

新增资源的精确公开合同为：

```text
DeploymentWave = {deploymentWaveId,tenantId,upgradeCampaignId,requestRef,state:QUEUED|RUNNING|PAUSED|COMPLETED|CANCELLED|ROLLED_BACK,currentWaveOrdinal:int|null,waves:[{ordinal:int,name,state:PENDING|RUNNING|PAUSED|SUCCEEDED|FAILED|ROLLED_BACK,minimumObservationSeconds:int,maximumFailurePercent:int}],createdAt,updatedAt,sequence:int}
WaveDevice = {deploymentWaveId,waveOrdinal:int,deviceId,priorFirmwareReleaseId,targetFirmwareReleaseId,state:PENDING|COMMAND_CREATED|SUCCEEDED|FAILED|ROLLBACK_PENDING|ROLLED_BACK,commandId:null|uuid,rollbackTargetId:null|uuid,confirmedAt:null|timestamp}
```

Wave 名称在请求内唯一，设备只能属于一个 wave；输入顺序冻结为从 0 开始的 `ordinal`，每 wave 至少一个设备，观察时间为 1..86400 秒，失败率为 0..100。创建返回 `{deploymentWave:DeploymentWave,waveDevices:WaveDevice[]}`，查询返回同一形状，控制接口返回更新后的 `DeploymentWave`。新增 409 错误为 `DEPLOYMENT_WAVE_TERMINAL`、`WAVE_DEVICE_CONFLICT`、`WAVE_HEALTH_GATE_FAILED`、`ROLLBACK_UNAVAILABLE` 和 `EXPECTED_WAVE_STATE_MISMATCH`；失败不得留下部分 device、补偿 target、Work 或 Event。
`DEPLOYMENT_WAVE_ADVANCE` Work 的 `aggregateId` 必须是 `deploymentWaveId`。

迁移为每个 V1 UpgradeCampaign 创建一个确定性的 legacy DeploymentWave，`requestRef="legacy:" + upgradeCampaignId`，只含 `ordinal=0,name="legacy"` 的 wave；其 WaveDevice 集合与原 UpgradeTarget 设备集合完全相同，状态由原 Campaign/Target 终态推导，重复 migration 不得更换 identity。

本消息仅描述产品合同，不提供代码、SQL、锁、调度算法、命令或 Debug 提示。本轮只做影响分析和计划。
