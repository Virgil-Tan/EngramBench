# ConfigOrbit 任务设计

ConfigOrbit 是独立的多环境配置中心任务，重点测量不可变版本、确定性灰度、回滚、客户端缓存栅栏、
多实例竞争、Worker/outbox 恢复，以及 Manager 引入的跨环境 PromotionTrain。

任务从空白 fixture 开始，公开合同完整列出接口、状态、错误、阈值和测试命令；隐藏 Evaluator 只改变
合法输入、并发交错与 crash 时点，不新增行为。目录包含 H-01～H-13 可执行适配器、三条领域专属压力
场景、100 分 Checklist 和独立多轮剧本。
