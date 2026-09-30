# RouteWeave Manager 固定需求

V1 完成并通过现有测试后，把单件 Shipment 扩展为多件 `Consignment`：

1. `POST /api/v1/consignments` 创建一个 Consignment 和 1～100 个稳定 `ParcelPiece`，同一事务冻结共享 RoutePlan revision；外部 pieceRef 在 Consignment 内唯一。
2. 每条 ScanEvent 必须明确属于一个 ParcelPiece；每件独立投影当前位置、当前 leg、丢失状态与终态。
3. Consignment 聚合状态为 `PLANNED | IN_TRANSIT | PARTIALLY_DELIVERED | DELIVERED | EXCEPTION`，由所有 piece 的可重算状态决定，不能由最后到达的事件直接覆盖。
4. 丢件与重派只影响目标 piece；共享改线必须以新 RoutePlan revision 原子应用于全部尚未终态的 piece，任何非法成员导致整批失败。
5. 并发 scan、loss、reassign 和旧 Worker lease 必须保持 `(pieceId, scannerEventId)` 唯一，不能重复推进或越过 fence。
6. 新增 `Consignment`、`ParcelPiece`、`PieceProjection` snapshot resource 和 `CONSIGNMENT_PROJECT` Work。
7. V1 Shipment 在迁移中自动获得一个稳定 legacy ParcelPiece；原 shipmentId、trackingCode、ScanEvent、Projection、Event、Work 和幂等 replay 不变。
8. 更新 OpenAPI、真实多件轨迹 UI、Integration、Chromium E2E、多进程乱序并发和 barrier/SIGKILL recovery。

新增公开接口为：

```text
GET/POST /api/v1/consignments
GET      /api/v1/consignments/:consignmentId
POST     /api/v1/consignments/:consignmentId/reassign
POST     /api/v1/consignments/:consignmentId/cancel
POST     /api/v1/parcel-pieces/:pieceId/scan-events
POST     /api/v1/parcel-pieces/:pieceId/loss
POST     /api/v1/parcel-pieces/:pieceId/found
```

创建请求为 `{tenantId,externalRef,pieceRefs,legs}`；共享 reassign 为 `{reason,expectedRoutePlanRevision,legs}`。所有新 mutation 使用现有 Idempotency-Key、strict JSON、稳定 replay、tenant scope 和错误 envelope。

新增资源和 mutation 的精确公开合同为：

```text
Consignment = {consignmentId,tenantId,externalRef,routePlanId,routePlanRevision:int,state:PLANNED|IN_TRANSIT|PARTIALLY_DELIVERED|DELIVERED|EXCEPTION,createdAt,updatedAt,sequence:int}
ParcelPiece = {pieceId,consignmentId,pieceRef,legacyShipmentId:null|uuid,state:PLANNED|IN_TRANSIT|DELIVERED|LOST|CANCELLED,createdAt,terminalAt:null|timestamp}
PieceProjection = {pieceId,routePlanRevision:int,currentLegOrdinal:int|null,currentHubId:null|uuid,state:PLANNED|IN_TRANSIT|DELIVERED|LOST|CANCELLED,lastObservedAt:null|timestamp,sequence:int}
```

Piece scan 请求为 `{tenantId,scannerEventId,type:PICKED_UP|DEPARTED|ARRIVED|DELIVERED,routePlanRevision,legId,hubId,observedAt}`；loss 为 `{reason,observedAt}`，found 为 `{observedAt}`，cancel 使用空对象。成功创建返回 `{consignment:Consignment,pieces:ParcelPiece[]}`，查询同时返回 Consignment、按 `pieceRef` 排序的 pieces 和 projections。新增 409 错误为 `PIECE_REF_CONFLICT`、`PIECE_TERMINAL`、`CONSIGNMENT_TERMINAL` 和 `EXPECTED_ROUTE_PLAN_REVISION_MISMATCH`；任何失败不得留下部分 piece、route revision、Work 或 Event。
`CONSIGNMENT_PROJECT` Work 的 `aggregateId` 必须是 `consignmentId`。

迁移为每个 V1 Shipment 创建确定性 legacy Consignment 和恰好一个 ParcelPiece：`legacyShipmentId` 保留原 shipmentId，`pieceRef` 等于原 trackingCode，共用原 RoutePlan identity 和 revision；重复 migration 不得更换 identity 或复制 scan/projection。

本消息不包含实现和调试提示。本轮只做 schema、API、Worker、UI、迁移与验证影响分析，不立即编码。
