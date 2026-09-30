# V2：单一最终系统评测

公开范围修订：`learning-final-system-2026-09-08.1`。

用户已明确取消“先完成 V1，再做 Manager 升级”的评测设计。此前本文件提出的官方旧库、旧服务、真实跨版本迁移方案已撤销，不再执行。

## 唯一流程

完整公开需求与固定接口 → 一份最终 workspace → 空数据库初始化 → 公开 seed/API 建立数据 → 真实业务测试 → 保存结果与证据。

适用此次审计的 **30 个 Learning 任务**。13 个 Transfer 的需求与历史评测不在此次修订范围内。

## 取消

- 历史模型 workspace、V1 可执行程序和中间提交物。
- 历史数据库格式、旧环境、跨版本升级和旧服务在线迁移。
- 只因迁移而要求生成的 legacy 包装资源。
- 缺少旧快照便排除计分的 Learning 路径。
- 固定返回 diagnostic、没有调用提交的占位用例。
- 未经公开定义的公式、性能阈值、精确错误字符串或内部实现要求。

## 保留

- 基础功能和原 Manager 新增功能，必须在同一个完整系统中实现。
- 公开 API、请求/响应 schema、错误规则、合法 seed、实际业务状态与关联。
- 持久化、事务、幂等、并发、权限、签名、Worker、真实 UI、OpenAPI、进程崩溃恢复，以及明确公开的性能要求。
- 测试数据只经公开 seed/API 创建；snapshot 仅用于观察，不能充当数据库备份或恢复答案。
- 外部交互若属于产品本身的要求，用测试内启动的本地接收端/Provider 模拟器，不需要真实账号、生产服务或历史服务。

`db:migrate` 只负责当前系统初始化。`/api/v1` 和 `schemaVersion:1` 是接口版本名称，不代表还需第二份程序。

## 判定

合法输入下缺功能、状态错误、重复副作用或违反公开要求，就是 `failed`。测试输入错误、不可用环境、测试作者 Bug 是 `evaluator_error`，不能变成提交的零分或自动通过。

不按某份提交定制 Adapter，不改冻结代码、轨迹和旧分数。原始文档归档只作溯源；当前 Coding Agent 应完整阅读生成的 `workspace/docs/requirements.md` 与 `contract/`。

本次是明确改变评测范围的新版本，不能包装成与历史跨版本任务完全相同的实验。新增/澄清的协议也不能追溯判罚旧提交。

## 实现与验收位置

| 位置 | 职责 |
| --- | --- |
| `contracts/learning/final-system-policy.mjs` | 唯一最终系统规则与当前完整需求生成 |
| `contracts/learning/<task>.mjs` | 每题公开接口与协议 |
| `evaluators/learning/<task>/v2/` | 各题独立业务用例与断言，不是统一万能测试 |
| `scripts/materialize-learning.mjs` | 生成新任务包，保留原始文本与 Frozen Plan |
| `src/task-package-v2-evaluator.mjs` | 拒绝带旧 workspace 前置或 blocked 占位的新 Learning manifest |
| `test/*final*.test.mjs` | 测试输入、真实调用边界、断言正反例及范围回归 |

静态检查和测试替身的正反例只验证 evaluator，不等于候选业务通过。真实隔离评测与正式发布认证仍需单独记录；未经真实验证不得声称全部提交已重测或用例已经认证。

## 本次验证记录（2026-09-08）

- 30 个 Learning 共 660 项：旧 workspace 前置为 0，固定待定占位为 0；生成包与各题作者源码一致。
- 全量自检启用真实 Chromium：765 通过、0 失败、1 跳过。跳过的是需要单独提供五百万条记录 fixture 的大规模 seed 读取自检，不是将某项业务测试判通过。
- 43 个任务包静态校验通过，3,023 份原始文件哈希未改变。
- 删除了 LaunchPass 等四题的废弃诊断收尾状态与自动排除分支；真实 HTTP 正反例确认正确行为通过、业务错误失败、基础设施故障单独报告。
- 尚未对已有提交重跑这 660 项新业务评测；30 题发布状态为 `pending_live_validation`。历史代码、轨迹和分数保持不变。
