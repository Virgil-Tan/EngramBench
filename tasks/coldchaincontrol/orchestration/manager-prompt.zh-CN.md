# ColdChainControl 唯一 Manager 变更

本消息是 V1 评审完成后唯一允许发布的新增产品合同。在发布前，DS 用户不得提及其中任何名称、接口、状态、错误、Work kind 或暗示。

【Global Operations Manager】在不破坏 V1 Shipment、Device、Config、Telemetry、Excursion、Notification、saved replay、pending Work、Event 和 Audit identity 的前提下，新增多承运人责任接力以及按产品批次的召回隔离。

## 数据合同

- `CustodyChain = {custodyChainId:uuid,tenantId:uuid,shipmentId:uuid,revision:int,state:PLANNED|ACTIVE|COMPLETED|CANCELLED,currentOrdinal:int,createdAt:timestamp,terminalAt:timestamp|null}`。
- `CustodyHandoff = {custodyHandoffId:uuid,custodyChainId:uuid,ordinal:int,fromCarrierId:uuid,toCarrierId:uuid,siteId:uuid,windowStart:timestamp,windowEnd:timestamp,state:PENDING|OFFERED|ACCEPTED|EXPIRED|CANCELLED,offeredAt:timestamp|null,acceptedAt:timestamp|null,terminalAt:timestamp|null}`。
- `RecallOrder = {recallId:uuid,tenantId:uuid,productLotCode:string,reason:string,state:ISSUED|QUARANTINING|CONTAINED|CANCELLED,revision:int,issuedAt:timestamp,terminalAt:timestamp|null}`。
- `QuarantineAction = {quarantineActionId:uuid,recallId:uuid,shipmentId:uuid,state:PENDING|APPLIED|RELEASED,expectedShipmentState:string,createdAt:timestamp,appliedAt:timestamp|null,releasedAt:timestamp|null}`。

`CustodyChain` 创建时冻结一条 Shipment 的完整接力步骤：至少两个不同 ACTIVE Carrier，第一步 `fromCarrierId` 必须等于 V1 Shipment.carrierId，相邻步骤的 `toCarrierId/fromCarrierId` 必须连接，siteId 必须按 ShipmentLeg 路线单调前进，window 必须递增且不重叠。一个非终态 Shipment 最多一个非终态 Chain。创建必须同时生成所有 PENDING Handoff、`CUSTODY_HANDOFF_EXPIRY` Work、Audit 和 Event，任一无效则整批回滚。

Handoff 只能按 ordinal 推进。offer 使用数据库时间并把该 Handoff 置 OFFERED；accept 必须由冻结的 `toCarrierId` 携带有效 Device attestation，在 window 内以 `expectedChainRevision` 原子完成。accept 同一事务将 Handoff 置 ACCEPTED、Chain revision +1、currentOrdinal 前移，并更新 Shipment 当前 Carrier；旧 Carrier、过期 offer、旧 revision、撤销 Credential 或旧 Worker fence 都不得再写。最后一次 accept 将 Chain 置 COMPLETED。过期只让当前 OFFERED Handoff EXPIRED 并把 Chain CANCELLED；不得部分推进后续步骤。

`RecallOrder` 以 `(tenantId,productLotCode)` 冻结发布时所有未取消的 Shipment 集合。相同批次存在非终态 Recall 时拒绝第二条。创建一个 Recall、每个受影响 Shipment 一条 QuarantineAction、`RECALL_PROPAGATE` 和 `QUARANTINE_ENFORCE` Work、Audit、Event 与 NotificationDelivery；整批原子。quarantine 使用 `expectedRevision` 从 ISSUED 进入 QUARANTINING，所有 Action APPLIED 后进入 CONTAINED。APPLIED Shipment 不得 activate、deliver、推进 Chain 或被旧 Worker/旧 lease 释放；正在 Handoff 的责任保持在最后一个已 ACCEPTED Carrier。取消只允许 ISSUED 且尚无 APPLIED Action 的 Recall。`RELEASED` 不是取消；本版本不提供解除接口。

## 公开接口

- `POST /api/v1/custody-chains`，body `{tenantId,shipmentId,expectedShipmentState,steps:[{fromCarrierId,toCarrierId,siteId,windowStart,windowEnd}]}`，返回 `201 CustodyChain`。
- `GET /api/v1/custody-chains/:chainId`，返回 `200 {chain:CustodyChain,handoffs:[CustodyHandoff]}`。
- `POST /api/v1/custody-chains/:chainId/handoffs`，body `{expectedChainRevision}`，返回 `200 CustodyHandoff`，表示对当前 ordinal 发出 offer。
- `POST /api/v1/custody-handoffs/:handoffId/accept`，body `{carrierId,deviceId,keyVersion,attestation,acceptedAt,expectedChainRevision}`，返回 `200 {chain:CustodyChain,handoff:CustodyHandoff,shipment:ColdShipment}`。
- `POST /api/v1/recalls`，body `{tenantId,productLotCode,reason,issuedAt}`，返回 `201 RecallOrder`。
- `GET /api/v1/recalls/:recallId`，返回 `200 {recall:RecallOrder,actions:[QuarantineAction]}`。
- `POST /api/v1/recalls/:recallId/quarantine`，body `{expectedRevision}`，返回 `202 RecallOrder`。

所有 mutation 继承 V1 `Idempotency-Key`、严格未知字段拒绝、durable replay、错误 envelope、租户隔离、Event 顺序和 transactional outbox。Device attestation 使用接收 Carrier 的当前有效 DeviceCredential，对 `custodyHandoffId|carrierId|acceptedAt|expectedChainRevision|keyVersion` 做与 V1 相同的 HMAC-SHA256；不得保存或回显 secret/attestation。

新增穷举错误：`400 CUSTODY_CHAIN_INVALID`、`400 RECALL_INVALID`、`401 INVALID_HANDOFF_ATTESTATION`、`409 CUSTODY_CHAIN_CONFLICT`、`409 CUSTODY_HANDOFF_NOT_CURRENT`、`409 CUSTODY_HANDOFF_EXPIRED`、`409 CUSTODY_REVISION_CONFLICT`、`409 RECALL_ALREADY_ACTIVE`、`409 RECALL_REVISION_CONFLICT`、`409 SHIPMENT_QUARANTINED`、`409 RECALL_TERMINAL`；缺失或越租户一律 `404 NOT_FOUND`。

新增 Work kinds：`CUSTODY_HANDOFF_EXPIRY`、`RECALL_PROPAGATE`、`QUARANTINE_ENFORCE`。它们都必须使用数据库时间、bounded retry、lease/fencing 和 terminal reason，并允许 Barrier/SIGKILL 测试。

UI 新增 Chain 时间线、当前 Carrier、Handoff offer/accept/expiry、按 lot 发起 Recall、受影响 Shipment 进度、Quarantine 状态和恢复告警。迁移后 verification snapshot 在 `managerResources` 中公开 `custodyChains`、`custodyHandoffs`、`recallOrders`、`quarantineActions`，仍不得泄露 secret 或 attestation。

在 V1 四条性能场景之外新增第五条 `recall-quarantine-convergence`：fresh database 中准备 10,000 active Shipments，其中 2,500 属于目标 lot、500 位于非终态 Chain、500 位于 OFFERED Handoff；64 clients 并发 replay/冲突并在四 Worker 中 kill 两个。90 秒内必须达到 CONTAINED，恰好 2,500 个 APPLIED QuarantineAction，非目标为零，无 split Carrier authority、stale release 或重复外部通知。

本轮只做影响分析与分阶段计划，不修改代码。
