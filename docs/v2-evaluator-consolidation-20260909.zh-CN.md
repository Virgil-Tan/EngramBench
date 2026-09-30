# V2 评测修复归并记录（2026-09-09）

## 权威版本与边界

本次把历史补测中已验证、仍适用于 V2 的测试侧修复归并到正式作者源，再同步全部 **30 Learning + 13 Transfer** 生成评测包。

唯一维护链路：

```text
evaluators/<learning|transfer>/<task>/v2/ + src/ 共享评测运行器
  → npm run build:evaluators
  → task-packages/v2/<task>/evaluator/ + runtime-lock.json
  → npm test + npm run check
  → 新部署使用经校验的版本
```

不修改提交代码、已冻结 workspace、公开合同、README、Frozen Plan、Scenario、原题分类或历史结果。没有在本次工作中替换服务器正在运行的冻结实验版本，也没有重启模型实验。旧运行仍绑定其原评测版本；重新评测应另存新版本结果，不能覆盖旧分数。

## 历史来源核对

- `archives/learning30-complete-20260908/bundle/reproduction/`：两批迁移、Learning 22 项作者修复的三轮版本，以及最终单系统补测版本。
- `work/paired-evaluator-repair-20260909/`：IncidentRelay、ParcelFlow、MeterSettle 的 original/fixed 差异。
- `work/metersettle-omission-retest-20260909/`：遗漏 UI 用例的作用域、控件与请求观察修复。
- `work/historical-guide-confirmed-fixes-20260908/`：CarbonLedger、FlagFoundry、EscrowGuard 的已确认修复。
- 旧仓库 `scripts/evaluator-fixture-adapters/` 和 `scripts/evaluator-bin/`：逐项区分测试夹具修复、已有修复与旧提交兼容逻辑；没有整份覆盖当前 V2 作者源。

## 本次补入正式源码

| 范围 | 修复内容 | 保留的失败判断 |
| --- | --- | --- |
| EscrowGuard fixture | 默认金额数组与状态数组等长；总额保持 100 | 显式传入长度冲突仍报错 |
| EscrowGuard A13 | 按 Milestone 身份和 ordinal 校验 Shares，不依赖首次出现顺序 | 交叉归属、金额和业务关系错误仍失败 |
| EscrowGuard 历史前置 | 8 个需要真实历史的用例，通过公开 create/submit 建立历史；在正式动作前启动所需 Worker | 不合成 Work/Event；不从提交复制业务期望；API 失败不回退；seed/迁移专项仍使用原前置 |
| EscrowGuard / PermitForge A02 | 只对已观察到的迁移 PID 执行终止，避免 SQL 条件重排误杀查询连接 | 原迁移中断与恢复断言不变 |
| PermitForge A04 | 从真实 projections 选择可认领的历史，并提供公开 Security Reviewers | 保留全部公开错误矩阵和回滚断言 |
| FlagFoundry Work | 未认领 Work 可有 attempt=0，LEASED 必须大于 0 | 非整数、负值及非法租约仍失败 |
| FlagFoundry 恢复用例 | 停止 fixture 准备阶段 Worker，避免抢走屏障测试的 Work | 被测屏障、崩溃、重领、幂等断言不变 |
| FlagFoundry / ColdChainControl UI | SELECT 使用真实选择操作，不用文本 fill | 缺控件、缺选项仍失败 |
| CarbonLedger D07 | 零测试输出按独立结果行识别，避免 npm 包版本字符串误匹配 | 真正零测试或跳过测试仍失败 |
| IncidentRelay UI | 支持可见的分词标签、隐式 label、真实 SELECT 与异步 loading 状态 | 不接受缺少的字段、选项或状态 |
| ParcelFlow UI | 按实际 SKU/数量字段对添加行，支持按钮或链接导航，排除隐藏 option 文本 | 没有真实新增行或导航仍失败 |
| MeterSettle UI | 按表单/区域限定字段和提交按钮，等待真实请求；datetime-local 去掉 Z 并保留秒/毫秒 | 不代替 UI 发业务请求，不为缺失功能返回成功 |
| MeterSettle 回滚 | 仅排除 snapshot.asOf，比较全部持久状态 | resources/work/events 及其他持久字段改变仍失败 |
| 共享进程清理 | 成功退出的父进程允许子进程正常收尾；失败退出保留短清理窗口 | 原失败退出、超时、泄漏与专属进程清理判断保留；不是新增 Agent 超时 |

EscrowGuard 的公开历史前置直接执行 V2 的扁平响应契约，不带旧 wrapped-response 兼容。只更新 API 产生的身份和时间戳，不更新预期金额、状态、sequence；准备步骤失败也必须保留失败证据。

## 已在 V2 的历史修复：保留，不回滚

- Learning 30 项的最新业务用例、fixture、oracle 已在作者源中；ConfigRelay 对齐最新作者修复，IdentityMesh 对齐第三轮修复。
- 其余 Learning 的部分共享 lib 差异是后续错误归因增强，而不是遗漏旧修复；没有用旧 runtime 覆盖当前实现。
- Learning 单一最终系统、干净 seed、公开版本、Provider 实际调用、恢复与精确数值修复继续保留。
- CarbonLedger lot 容量修复、FlagFoundry E04 monitor/有界诊断、DockChain ACK 与输出读取、浏览器等待拒绝处理、ParcelFlow 原始错误保留、评测副本 Git 初始化等已有实现继续保留。
- 四个超级难 Transfer 已有的时钟、租约、协议及安全相关修复保留；本次另补 ColdChainControl 的 SELECT 操作。

## 不迁入的旧逻辑

旧提交专用字段别名、路由猜测、wrapped/flat 自动探测、预期版本 UUID 兼容和入口豁免，不属于当前固定契约 V2 的通用修复。不把它们变成按提交分支的 Adapter。

未经验证的业务语义冲突，不凭历史低分修改 README 或放宽断言。旧结果中的 raw assertion / evaluator_error 不因此自动变成通过；仍需按新评测实际运行后逐项归因。

## 防止再次漏同步

- `npm run build:evaluators` 一次刷新全部 43 个私有评测包与共享运行器锁；刷新前后验证公开合同和初始 workspace 摘要未变。
- `npm run check` 的作者源/生成包及 release 对齐检查已从 Learning 扩展到全部 Transfer。
- 回归中另有全 43 包一致性检查；修复只留在作者源、没有同步任务包时会失败。
- `AGENTS.md` 和 README 明确：正式源码、回归、生成包、校验全部完成才算交付，临时补测修复不能作为终点。

## 验证记录

最终完整回归：**830 项，829 通过、0 失败、1 跳过**，耗时约 46.61 秒。执行命令：

```sh
FRONTAL_TEST_CHROMIUM='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm test
npm run check
```

唯一跳过项为 `full-size seed passes unchanged complete schema validation`：未提供可选的 `FRONTAL_LARGE_SEED_PATH` 外部大样本；不是浏览器回归跳过，也不记作通过。

真实浏览器回归使用本机 Chrome；未配置浏览器时相应用例会显式 skip。定向回归还覆盖公开历史前置、迁移终止 SQL、setup Worker 释放、Share 身份顺序、零测试识别、快照回滚范围，以及成功/失败进程的子进程清理。

静态校验通过：43 个任务包作者/生成源一致；**3,023 个导入原文件保持原摘要**；873 个公开操作、324 个公开 probes、1,292 个保留隐藏用例。刷新操作逐包确认公开合同与起始 workspace 摘要未变。完整静态摘要仍由 `reports/validation.json` / `reports/validation.md` 维护。

本次不是 43 题的完整业务隐藏评测，也没有把未认证的 evaluator 标为 certified；不产生或修改实验分数。
