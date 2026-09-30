# RoutePilot 任务设计

RoutePilot 是一个完全独立的 API 网关全栈任务。候选人从只有 README 和 AGENTS 的空白 Git 仓库开始，实现控制面、数据面、PostgreSQL 权威状态、后台传播、事件分发和真实 React 运维界面。

## 评测重点

- 确定性路由匹配和明确的优先级/歧义拒绝；
- 冻结配置 revision、稳定灰度分桶、租户级分布式限流和共享熔断器；
- 原子热更新、并发发布、回滚、未知响应幂等和跨进程一致性；
- Worker lease、Outbox 未知 ACK、V1 到 Manager 兼容迁移；
- Manager 新增分区域、分阶段、可暂停与可回滚的 RegionalRollout；
- 三条独立持续压力场景及负载后不变量。

## 独立性

公开合同只位于 `workspace/`。Manager Prompt、Persona、Checklist、对话剧本、固定 seed 和 H-01～H-13 evaluator 全部封装在本目录。共享框架只提供进程、HTTP、PostgreSQL、Chromium、barrier 和负载原语，不包含 RoutePilot 业务逻辑。
