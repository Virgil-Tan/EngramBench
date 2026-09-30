# RouteWeave 任务设计

RouteWeave 是一个完全独立的物流网络全栈任务。候选人需要实现多段运输、不可变扫描证据、确定性轨迹投影、丢件 fence、重派、恢复和真实运维 UI。

## 评测重点

- 多段 RoutePlan 与 hub/leg 顺序不变量；
- 重复、迟到、乱序和互相冲突的 ScanEvent 收敛；
- 丢件、找回、重派和旧计划事件的 fence；
- API 幂等、跨进程竞争、Worker/Outbox 崩溃恢复和兼容迁移；
- Manager 将单件 Shipment 扩展为多件 Consignment，并要求逐件轨迹和聚合状态一致；
- 三条物流专属持续压力场景及负载后轨迹重算。

## 独立性

公开合同只位于 `workspace/`。本目录自带 Manager、Persona、Checklist、自然阶段对话、固定 seed、H-01～H-13 runner adapter 和合同测试；不依赖其他 Task 的源码、数据库或生成器。
