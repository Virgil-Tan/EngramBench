# RuleBench 任务说明

RuleBench 是一个从空仓库实现的多租户确定性规则引擎。候选项目要实现规则优先级、短路、不可变版本、
静态冲突检测、异步评估、确定性回放和结构化解释，并在多进程、幂等重试、乱序工作和 Worker 崩溃后
保持相同决定与相同解释摘要。

V1 的核心难点是公开且受限的 JSON 规则语言、严格 canonical facts、规则版本冻结、静态冲突报告、
优先级/terminal 短路、ExplanationNode 完整性、ReplayRun 和 transactional Work/Event。

Manager 变更新增 ComparisonRun：冻结一组历史 Evaluation 作为 corpus，使用 baseline 与 candidate 两个
RuleSetVersion 做 shadow comparison，生成不可变差异结果；并发 start/cancel/promote、Worker 崩溃、旧版本
迁移和回放不能改变 corpus 或结果。

隐藏 evaluator 实现 H-01～H-13。H-12 的三条专属持续压力是 `evaluation-throughput`、
`deep-short-circuit` 和 `comparison-recovery`。该目录包含独立 fixture Git、Persona、Dialogue、Checklist、
Manager Prompt、实验 manifest 和 evaluator，不依赖批量生成器。
