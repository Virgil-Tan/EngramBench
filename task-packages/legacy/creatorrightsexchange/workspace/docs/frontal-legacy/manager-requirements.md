【Product Manager】新增权利争议与结算后修正，但不得重写任何已发布或已结算事实。

新增三种资源：

```text
RightsDispute = {
  rightsDisputeId,tenantId,editionId,claimantCreatorId,licenseId:null|uuid,
  reason,evidenceRefs:string[],state:OPEN|UPHELD|REJECTED,revision,
  createdAt,resolvedAt:null|timestamp,resolutionReason:null|string
}
LicenseHold = {
  licenseHoldId,tenantId,rightsDisputeId,scope:EDITION|LICENSE,
  editionId,licenseId:null|uuid,state:ACTIVE|RELEASED,revision,reason,
  createdAt,releasedAt:null|timestamp
}
RoyaltyAdjustment = {
  royaltyAdjustmentId,tenantId,rightsDisputeId:null|uuid,originalPostingId,
  targetRoyaltyPeriodId,amountMinor,currency,reason,adjustmentPostingId,createdAt
}
```

新增以下 HTTP 合同。所有 mutation 继续要求 `Idempotency-Key`、严格拒绝未知字段，并持久化
exact replay：

```text
POST /api/v1/rights-disputes
  request  {tenantId,editionId,claimantCreatorId,reason,evidenceRefs,expectedEditionRevision,licenseId?}
  response {rightsDispute:RightsDispute}
GET /api/v1/rights-disputes/:rightsDisputeId
  response {rightsDispute:RightsDispute,holds:[LicenseHold,...]}
POST /api/v1/rights-disputes/:rightsDisputeId/resolve
  request  {expectedRevision,outcome:UPHELD|REJECTED,reason}
  response {rightsDispute:RightsDispute}
POST /api/v1/license-holds
  request  {rightsDisputeId,scope:EDITION|LICENSE,licenseId?,reason}
  response {licenseHold:LicenseHold}
POST /api/v1/license-holds/:licenseHoldId/release
  request  {expectedRevision,reason}
  response {licenseHold:LicenseHold}
POST /api/v1/royalty-adjustments
  request  {tenantId,rightsDisputeId?,originalPostingId,amountMinor,currency,reason,targetPeriodStart}
  response {royaltyAdjustment:RoyaltyAdjustment,entries:[RoyaltyEntry,...]}
```

RightsDispute 只能引用同租户的 PUBLISHED Edition、该 Edition 冻结 rights revision 中的 Creator，
以及可选的同 Edition License。`expectedEditionRevision` 不匹配返回
`409 EDITION_REVISION_CONFLICT`。`evidenceRefs` 为 1..20 个去重、升序、最大 512 字节的 opaque
reference，绝不能由服务端抓取。每个 `(editionId,claimantCreatorId)` 同时最多一个 OPEN 争议。

LicenseHold 必须引用 OPEN 或 UPHELD 的 RightsDispute。EDITION scope 的 `licenseId` 必须省略；
LICENSE scope 必须引用争议中同 Edition 的 License。同一争议和 scope authority 最多一个 ACTIVE
Hold。创建 Hold 与 `LICENSE_HOLD_APPLY` Work、Event 和 authority fence 在一个事务提交。

ACTIVE Edition Hold 提交后，所有 API 进程立即拒绝该 Edition 的新 Purchase；已经收款但尚未授权的
Purchase 停在 `LICENSE_HELD`，不得生成 License、Entitlement 或 Royalty posting；既有 ACTIVE License
进入 `HELD`，entitlement check 返回 false，但不自动退款也不改写原 royalty。LICENSE scope 只影响
指定 License。Release 后，未退款/未撤销的 License 恢复 ACTIVE，等待中的成功支付只生成一次授权。
Hold 与 Payment success、License grant、Refund success 并发时必须可串行化；任何可见状态都不能同时
显示 allowed=true 与 ACTIVE Hold。

resolve 使用 revision CAS。REJECTED 后允许 release Hold；UPHELD 保留 Hold，直到显式 release。争议
结论绝不能重写 Edition、RightsSplit、License、RoyaltyEntry 或 CLOSED RoyaltyPeriod。所有状态转换写
gapless Event sequence。

RoyaltyAdjustment 只允许引用 CLOSED period 中的原 posting，且 `amountMinor` 非零、绝对值不超过原
posting 可调整余额。它必须进入 `targetPeriodStart` 所属的 OPEN 下一期；若不存在则原子创建。使用原
Edition 冻结的 rights split 做确定性 remainder 分配，创建一组新的平衡 RoyaltyEntry，并通过
`originalPostingId` 关联。原 entry、原 CLOSED period、snapshotDigest 和既有通知保持逐字节不变。同一
`(originalPostingId,reason,amountMinor,targetRoyaltyPeriodId)` 只能生成一个 adjustment posting。

新增 `RIGHTS_DISPUTE_REVIEW`、`LICENSE_HOLD_APPLY`、`ROYALTY_ADJUSTMENT_POST` Work，以及
`rights_dispute.opened/resolved`、`license_hold.activated/released`、`royalty.adjusted` Events。Worker
继续使用 lease token fence；dispatcher 继续使用 stable event identity 与 unknown ACK 重试。

迁移必须保留所有 V1 media、Edition manifest、rights revision、Purchase/Payment/License/Entitlement、
RoyaltyEntry、CLOSED digest、Notification/Event、pending Work、lease 与幂等响应。UI 增加争议详情、
Hold authority、受影响授权以及 adjustment 原/新 posting 对照。增加真实 PostgreSQL、双 API/双 Worker、
Chromium、barrier SIGKILL 与持续负载测试。

本轮只做影响分析和分阶段计划，不要立即编码。