# ModerationFlow 任务设计

ModerationFlow 是完全独立的内容审核平台任务，不依赖其他 Task 的源码、数据库、配置或状态。

## 评测重点

- 多级审核、明确升级条件和并发终态竞争；
- EvidenceVersion append-only、案件冻结证据 head 和 PolicyVersion；
- ALLOW、RESTRICT、REMOVE 决策与独立 Appeal lineage；
- 策略发布只影响提交边界之后的新案件；
- 事务性 Event、不可变 tenant audit digest chain、Worker/Dispatcher 恢复；
- Manager 新增 PolicyRecallRun，以 append-only Reconsideration 纠正被召回策略影响的历史案件；
- production React、真实项目测试和三条持续压力场景。

## 难度来源

审核结果不能只由当前策略或最新证据解释。系统必须保留“当时看到了哪个证据版本、依据哪个策略、
经过哪一级审核、之后如何申诉或复议”的完整历史，同时在并发决策、策略切换和进程死亡下保持唯一终态。

## 独立性

公开合同只在 `workspace/`。Manager、Persona、Checklist、24 阶段剧本、Evaluator 和合同测试均封装在
本目录；共享 Harness 只提供无业务含义的执行原语。
