【Product Manager · Maya】

近期有些订单无法由单个仓库完整履约，但多个仓库合计库存充足。本期需要增加“跨仓拆分履约”，这是现有公开需求的正式增量：

1. 创建订单时仍必须先按现有规则寻找第一个可完整满足整单的单仓库；找到时继续使用原来的单仓流程。
2. 只有没有任何单仓能完整满足整单时，才启用跨仓拆分。先按 skuId ASC 处理订单行，再按 warehouse.priority ASC、warehouseId ASC 的稳定顺序使用库存。一个订单行可以分配到多个仓库。
3. 任一订单行的总可用库存不足时，整单必须原子失败，不能留下 Order、Allocation、Fulfillment、DispatchTask、DomainEvent 或任何库存变化。
4. 每个实际参与分配的仓库形成一个独立 Fulfillment，并各自拥有一个 DispatchTask；每个 Fulfillment 最多生成一个 Shipment。
5. 未取消订单的发货进度状态使用 ALLOCATED、PARTIALLY_SHIPPED、SHIPPED：尚无分组发货时为 ALLOCATED，部分分组发货后为 PARTIALLY_SHIPPED，全部分组发货后为 SHIPPED；取消成功仍使用现有 CANCELLED。
6. 多个 Worker 可以并发处理同一 Order 的不同 Fulfillment，但每个 Fulfillment 只能结算一次库存并生成最多一个 Shipment。
7. 整单取消只允许在所有 Fulfillment 都未发货时成功；任何一个分组已经发货后，整单都不能取消。取消成功时释放全部尚未结算的预留库存。
8. 订单 API 增加 fulfillments[]。旧的 singular fulfillment 字段继续保留：单仓订单返回原来的对象，拆分订单返回 null。
9. 迁移必须把 V1 数据兼容为每个订单一个 Fulfillment。已有 Order、Allocation、Fulfillment、Shipment、DispatchTask、DomainEvent、每订单 sequence 和已保存的幂等 replay 结果都不能改变。
10. 每个分组成功发货时产生 fulfillment.shipped；最后一个分组完成时再产生 order.shipped。同一 Order 的事件和成功 webhook 投递继续遵守递增 sequence。
11. 前端必须展示所有 Fulfillment 的仓库、分配和发货状态，正确展示 ALLOCATED、PARTIALLY_SHIPPED、SHIPPED，并保持单仓订单兼容。
12. 更新 README、OpenAPI、migration、Integration Test、Browser E2E、双 API/双 Worker 并发与崩溃恢复测试，以及性能测试。

本轮先不要实现。请先说明它会影响哪些模块、领域关系、数据模型、migration、接口、状态、分配与发货数据流、兼容性、事件、前端和测试，然后给出分阶段修改计划。