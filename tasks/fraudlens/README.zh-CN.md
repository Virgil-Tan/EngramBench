# FraudLens 任务设计

FraudLens 是一个完全独立的实时反欺诈平台任务。它不复用其他 Task 的源码、数据库或运行状态。

## 评测重点

- 风险事件严格校验、实时评分和可解释 RuleHit；
- RuleVersion 激活、冻结和误杀后的原子回滚；
- APPROVE、REVIEW、BLOCK 与人工复核之间的确定性状态流；
- 重复请求、未知响应、多进程并发、Worker 崩溃和 Outbox 未知 ACK；
- 历史 Assessment 与 Decision 不可变，未来决策切换到回滚后的版本；
- Manager 新增冻结范围的误杀补救批次和 append-only correction；
- 真实 React 操作台、项目自带测试及三条持续压力场景。

## 难度来源

系统必须在规则发布、实时打分、人工复核和紧急回滚同时发生时保持确定性。测试不仅检查 HTTP
状态，还会从 verification snapshot 重算分数、版本归属、唯一最终决策、审计顺序、Work 与 Event。

## 独立性

公开合同只位于 `workspace/`。本目录独立拥有 Manager Prompt、Persona、Checklist、多轮剧本、
H-01～H-13 evaluator 和合同测试；共享 Harness 只提供进程、PostgreSQL、HTTP、Chromium、Barrier
和负载原语。
