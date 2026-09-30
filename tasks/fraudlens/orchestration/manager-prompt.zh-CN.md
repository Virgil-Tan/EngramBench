# FraudLens Manager Change

【Risk Operations Manager】新增误杀补救批次 `RemediationRun` 和 append-only
`AssessmentCorrection`。本消息是这次变更的完整公开合同；不得自行发明其他状态、字段或接口。

当 RuleVersion 被回滚后，操作员可以创建一次补救批次。创建事务必须冻结 `tenantId`、被回滚的
`fromRuleVersionId`、当前恢复的 `toRuleVersionId`、闭区间 `occurredFrom/occurredTo`，以及当时属于该
tenant、引用 from version 且 occurredAt 落在区间内的全部 Assessment IDs。`REMEDIATION_RECHECK`
Work 的 `aggregateId` 是 `remediationRunId`。Worker 使用恢复版本重算冻结 Assessment，但绝不修改原
RiskEvent、Assessment、RuleHit、ReviewDecision 或 AuditEntry。结果改变或相同都 append 恰好一条
AssessmentCorrection；每个 Run+Assessment 最多一条结果。

公开资源为：

```text
RemediationRun = {remediationRunId:uuid,tenantId:uuid,fromRuleVersionId:uuid,toRuleVersionId:uuid,occurredFrom:timestamp,occurredTo:timestamp,state:PENDING|RUNNING|COMPLETED|CANCELLED,totalCount:int,completedCount:int,correctionCount:int,noChangeCount:int,createdAt:timestamp,completedAt:timestamp|null,cancelledAt:timestamp|null}
AssessmentCorrection = {assessmentCorrectionId:uuid,remediationRunId:uuid,assessmentId:uuid,outcome:CORRECTED|NO_CHANGE,oldDecision:APPROVE|BLOCK,newDecision:APPROVE|REVIEW|BLOCK,reason:string,newRuleHitsDigest:sha256,createdAt:timestamp}
```

计数恒满足 `completedCount = correctionCount + noChangeCount <= totalCount`。只有所有冻结项都已有结果时
Run 才是 `COMPLETED`。取消将 Run 置为 `CANCELLED`，只取消尚未开始的 Work；已提交结果保留。若取消与
最后一项提交竞争，只允许数据库序列化出的 `COMPLETED` 或 `CANCELLED` 之一。

公开 HTTP 合同为：

```text
POST /api/v1/remediation-runs
  body {tenantId,fromRuleVersionId,toRuleVersionId,occurredFrom,occurredTo}
  -> 201 RemediationRun
GET  /api/v1/remediation-runs/:runId
  -> 200 {run:RemediationRun,corrections:[AssessmentCorrection]}
POST /api/v1/remediation-runs/:runId/cancel
  body {}
  -> 200 RemediationRun
```

所有 mutation 继承 V1 `Idempotency-Key` 规则、严格未知字段拒绝和稳定错误 envelope。新增且穷举的
well-formed 语义错误是：`409 REMEDIATION_VERSION_MISMATCH`、`409 REMEDIATION_RUN_TERMINAL`、
`400 REMEDIATION_RANGE_INVALID`、`400 INVALID_REQUEST`。不存在的 ID 返回 `404 NOT_FOUND`。

UI 必须提供创建、进度、差异、取消和结果明细。并发创建、取消、Worker SIGKILL 和旧 lease 均不得重复
correction 或越过 cancel fence。兼容迁移必须保留 V1 identity、saved replay、pending Work、Event 和
audit chain。本轮只做 schema、API、Worker、迁移、并发、UI 和测试的影响分析及分阶段计划，不要编码。
