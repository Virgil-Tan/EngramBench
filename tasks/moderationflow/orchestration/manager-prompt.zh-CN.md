# ModerationFlow Manager Change

【Trust & Safety Manager】新增 `PolicyRecallRun` 和 append-only `Reconsideration`。本消息是这次变更的
完整公开合同；不得自行发明其他状态、字段或接口。

创建 Recall 时，`recalledPolicyVersionId` 必须是该 tenant 已被替代或撤销的版本，
`replacementPolicyVersionId` 必须是同一 Policy 当前 ACTIVE 的版本。创建事务冻结闭区间
`decidedFrom/decidedTo` 内、使用 recalled version 的全部终态 Case IDs，同时冻结每个 Case 当时的
`finalDecisionId` 和 `evidenceHeadVersion`。replacement 必须包含所有冻结 Decision 的 categoryCode，否则
整批以 `POLICY_RECALL_POLICY_INCOMPATIBLE` 拒绝。`POLICY_RECALL` Work 的 `aggregateId` 是
`policyRecallRunId`。

Worker 用冻结 Decision 的 categoryCode 查找 replacement category，其 `level1Action` 就是
`suggestedOutcome`。它为每个冻结 Case append 恰好一条 Reconsideration，绝不修改原 Case、Stage、
Decision、Appeal、EvidenceVersion 或 AuditEntry。建议改变时创建恰好一个 `RECONSIDERATION`
ReviewStage 供人工确认；该 Stage 只能决定 ALLOW、RESTRICT 或 REMOVE，不能 ESCALATE，也不会自动改写现实
处置。建议相同则记录 NO_CHANGE 且不创建 Stage。

公开资源为：

```text
PolicyRecallRun = {policyRecallRunId:uuid,tenantId:uuid,recalledPolicyVersionId:uuid,replacementPolicyVersionId:uuid,decidedFrom:timestamp,decidedTo:timestamp,state:PENDING|RUNNING|COMPLETED|CANCELLED,totalCount:int,completedCount:int,changedCount:int,noChangeCount:int,createdAt:timestamp,completedAt:timestamp|null,cancelledAt:timestamp|null}
Reconsideration = {reconsiderationId:uuid,policyRecallRunId:uuid,caseId:uuid,evidenceHeadVersion:int,oldDecisionId:uuid,oldOutcome:ALLOW|RESTRICT|REMOVE,suggestedOutcome:ALLOW|RESTRICT|REMOVE|ESCALATE,replacementPolicyVersionId:uuid,outcome:CHANGED|NO_CHANGE,reason:string,reconsiderationStageId:uuid|null,createdAt:timestamp}
```

FINAL migration 将 ReviewStage.level 扩展为 `LEVEL_1|LEVEL_2|APPEAL|RECONSIDERATION`。计数恒满足
`completedCount = changedCount + noChangeCount <= totalCount`。取消只阻止未开始 Work；已提交
Reconsideration 和 Stage 保留。取消与最后提交竞争时，Run 只能序列化为 `COMPLETED` 或 `CANCELLED`。

公开 HTTP 合同为：

```text
POST /api/v1/policy-recall-runs
  body {tenantId,recalledPolicyVersionId,replacementPolicyVersionId,decidedFrom,decidedTo}
  -> 201 PolicyRecallRun
GET  /api/v1/policy-recall-runs/:runId
  -> 200 {run:PolicyRecallRun,reconsiderations:[Reconsideration]}
POST /api/v1/policy-recall-runs/:runId/cancel
  body {}
  -> 200 PolicyRecallRun
```

所有 mutation 继承 V1 `Idempotency-Key`、未知字段拒绝和稳定错误 envelope。新增且穷举的 well-formed
语义错误是：`409 POLICY_RECALL_VERSION_MISMATCH`、`409 POLICY_RECALL_RUN_TERMINAL`、
`409 POLICY_RECALL_POLICY_INCOMPATIBLE`、`400 POLICY_RECALL_RANGE_INVALID`、`400 INVALID_REQUEST`。
不存在的 ID 返回 `404 NOT_FOUND`。

UI 必须提供 Recall 创建、进度、差异、取消、Reconsideration 和人工确认。并发创建、取消、Worker
SIGKILL 和旧 lease 不能重复结果或越过 fence。兼容迁移保留 V1 identity、saved replay、pending Work、
Event 和 audit chain。本轮只做影响分析和分阶段计划，不要编码。
