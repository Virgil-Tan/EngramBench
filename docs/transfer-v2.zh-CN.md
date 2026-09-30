# 其余九个 Transfer/Test 的 V2 迁移

## 范围与来源

本次迁移以下九题，加入同一 V2 任务包协议。原来的四个超难题继续保留，完整清单为 **30 Learning + 13 Transfer/Test**。

| 任务 ID | 分组 | 原私有用例数 |
| --- | --- | ---: |
| metersettle | 标准 Transfer | 44 |
| dockchain | 标准 Transfer | 44 |
| incidentrelay | 标准 Transfer | 44 |
| flagfoundry | 标准 Transfer | 44 |
| carbonledger | 标准 Transfer | 49 |
| parcelflow | 标准 Transfer | 49 |
| escrowguard | 中高难 Transfer | 48 |
| permitforge | 中高难 Transfer | 48 |
| capacitylease | 中高难 Transfer | 49 |

`transfer-tasks.json` 按旧仓库发布的 13 题原顺序排列；没有更改 30 个 Learning 标签，也不对 Transfer 启用 Skill Evolution。

来源是 `<original-source>` 的原任务源码、任务包与 runtime manifest，不使用运行提交、轨迹、历史 Adapter 或 Gold Skills 作为公开契约来源。共保留 548 份原始文件的 SHA-256，记录在 `provenance/transfer-import.json`。依赖目录、Git 元数据、环境密钥文件不属于任务源码，不导入；原仓库及历史 workspace 不变。

## 文件与维护接口

- `task-packages/legacy/<id>/`、`tasks/<id>/`、`experiments/<id>/task.json`：逐字原始副本，不编辑。
- `contracts/transfer/<id>.mjs`：每题独立的公开请求、响应、参数、错误、seed、snapshot、示例和 smoke。
- `evaluators/transfer/<id>/v2/`：与公开表示同步的私有评测作者源；保留原业务、恢复、并发、UI 与性能要求。
- `evaluators/transfer/<id>/release.json`：真实对齐/认证状态。不能把静态通过写成完整业务认证。
- `task-packages/v2/<id>/`：生成包。其中 `workspace/` 是模型起始工程，`public-contract/` 是作者持有副本，`evaluator/` 是私有评测。

README 与 Manager 业务原文、Frozen Plan、Scenario 均不改。V2 公开澄清只解决表示缺口；不把明确的原错误码改成方便测试的默认值，不把私有 fixture 的偶然结构反推成新需求。

用户另外明确批准的业务规则以公开 `policyRevision` 标识，只覆盖补充中点名的冲突规则，不能借此改变其他要求。原始副本仍逐字保留；新规则下的实验不视作原历史题目完全不变的重测。

## 共享协议中的必要补全

沿用既有生成器/HTTP 层，不新增第二套 Harness，也没有提交专用 Adapter。

1. **有效期字段**：公开 smoke 从服务响应捕获 `asOf` 等时间，再用 `${clock+60000ms}` 计算合法相对时间。没有更改提交的时钟，没有模型回合/时间限制。
2. **错误码**：`missingTransportError` 区分缺失和格式非法；`bodyTransportErrors` 保留特定字段的原文错误语义，数值与字符串错误不混淆。规则同步公开在 OpenAPI。
3. **完整 OpenAPI**：保留操作显式声明的所有错误状态及出站 `webhooks`，不只生成一组固定错误码。
4. **私有原始 JSON 请求**：校验器解析合法 `raw` 仅用于验证，发出的原始字节不改；与真实请求函数保持 `json` 优先级一致。合法原始 JSON 不再误报作者契约错误，畸形负向仍需显式标记。

第 4 项更改了共享 evaluator 文件，现有 V2 作者包的 runtime lock 只同步了这个文件的 hash；没有重新生成原 30 题或原四题业务合同，也没有重新运行模型或历史提交。旧的业务认证不能自动继承运行时变化。

## 生成与使用

```sh
# 只生成/刷新本轮九题的作者包
node scripts/materialize-learning.mjs --tasks metersettle,dockchain,incidentrelay,flagfoundry,carbonledger,parcelflow,escrowguard,permitforge,capacitylease --refresh
npm test
npm run check

# 将公开起始工程导出到一个不存在的新目录；不会复制隐藏评测
npm run prepare:task -- --task capacitylease --output /absolute/new-capacitylease-workspace
```

原导入入口保留文件名兼容：`node scripts/import-superhard.mjs --remaining` 只用于首次复制这九题，拒绝覆盖已有目录；`--resume` 会逐字核对已有原始副本，不覆盖已编辑的 evaluator 作者源。平时改合同或评测后只运行生成器，不反复导入。

正式实验使用相同的 `run-v2.mjs` 与 baseline/native/guide profile；设置该题 ID、新 runId 和 `evolution:false`。A/B 使用相同起点、Plan、模型与评测，只有 Skill/Guide 条件不同。没有认证的 evaluator 不能产生正式分数。

## 验证边界

逐题回归在 `test/transfer-<id>.test.mjs`；共享时间/HTTP回归和 `test/superhard-packages.test.mjs` 检查所有 Transfer 的导出隔离、原文保留、编译与诚实空桩。最终统计见 `reports/validation.json` 与 `reports/validation.md`。

这些检查不是完整 PostgreSQL/Chromium/并发恢复/性能认证；也不保证提交的业务正确。原文仍未定义、不能仅通过补字段解决的业务规则必须列在该题 release/blockers，不能作为私人评分规则。

## 迁移初版验证记录（2026-09-07，以下业务修订之前）

- 九题全部已生成：129 个公开操作、64 个公开 smoke、190 个 schemas，保留 419 个隐藏用例。
- `npm test`：237 项，236 通过、0 失败、1 项既有 GeoPulse TODO。该 TODO 是另一 Learning 题的小数精度问题，不属于本轮九题；没有忽略这九题的失败。
- `npm run check`：30 Learning + 13 Transfer 全部通过静态校验；3,023 份原始导入文件的 SHA-256 未变化，其中本轮九题 548 份。
- 回归覆盖实际 HTTP、正向/负向私有 seed、实际请求 helper、OpenAPI 与 webhook schema、公开导出隔离、TypeScript 编译和诚实未实现桩。未运行模型或完整业务隐藏测试。

| 任务 | 当前评测状态 | 尚需完成 |
| --- | --- | --- |
| metersettle | pending_live_validation | 完整业务、恢复、并发、UI 与性能验证 |
| dockchain | pending_live_validation | 同上 |
| carbonledger | pending_live_validation | 同上 |
| parcelflow | pending_live_validation | 同上 |
| escrowguard | pending_live_validation | 同上 |
| capacitylease | pending_live_validation | 同上 |
| incidentrelay | pending_alignment | 补公开错误码映射、按已有规则完善投递/确认/观察的评测；不把评测缺失误列为待用户决定的业务行为 |
| flagfoundry | pending_alignment | 已同步确认的灰度权威规则；仍需补 CompilationFinding/context schema 观察接口及剩余评测对齐 |
| permitforge | pending_alignment | 已同步确认的跨阶段审批及名称规则；仍需补齐原有 gap-diagnostic 用例实际未执行的断言 |

后三题的具体 SPEC-GAP、用例 ID 与原文边界保留在 `evaluators/transfer/<id>/release.json`。这些是评测作者待办，不是提交缺陷；不能以此判模型 0 分，也不能把迁移完成等同于正式计分认证。

## 用户确认的三项规则（2026-09-07）

1. **FlagFoundry 灰度权威**：RUNNING 时旧版本保持 ACTIVE，候选版本保持 READY，但允许它在 Manager 灰度分流中被评估；全部步骤通过才正式切换。失败继续使用旧版本。此规则不改变并发直接激活使 rollout STALE 的原规则。
2. **PermitForge 跨阶段审批**：同一 Reviewer 可以参与同一 Revision 的多个 Stage；Manager 多阶段的唯一性改为每 Reviewer、每 Revision、每 Stage 最多一个 Decision。旧单阶段仍为每 Reviewer、每 Revision 最多一次。旧 Claim/Decision、seed、事件和保存的幂等回复保持兼容。
3. **PermitForge 阶段名称**：拒绝空字符串和纯空白名称；允许重名，以 Stage ID 和 ordinal 区分，不以名称判断是否为同一阶段。

对应规则必须同时出现在公开合同、模型可见 README 入口和评测断言中；不能只写进隐藏测试。公开读取还必须能明确关联 Stage 的审批证据，不能通过时间戳或姓名猜测归属。

## 本次确认后的验证记录（2026-09-07）

- 公开修订编号：`flagfoundry-rollout-authority-v1`、`permitforge-stage-review-v1`。已生成模型可见 README 入口、完整公开契约、OpenAPI、示例与探针，并同步相关隐藏评测作者源。
- PermitForge 多阶段读取明确返回 `{items,evidence}`，用 Stage ID 关联 Claim/Decision；同名、同 Reviewer 或相同时间戳均不能代替阶段归属。新增公开探针实际串联同一 Reviewer 在两个同名 Stage 中依次审批。
- FlagFoundry 回归检查进行中的灰度分流、成功切换、回滚以及并发直接激活导致的 STALE；历史终态 rollout 不冻结后续合法激活。
- 同时修正 EscrowGuard 已解决争议的评测断言：从 resolve 响应检查解决结果，详情中的当前争议必须为 `null`。没有为提交补 Adapter，也没有改原业务规则。
- 本轮定向回归：FlagFoundry 9/9、PermitForge 10/10、EscrowGuard 9/9。独立复核覆盖前两题的 19 项测试。
- 当前共享 V2 工作树 `npm test`：297 项全部通过，0 失败、0 跳过、0 TODO。该总数包含其他并行工作已落入共享工作树的测试，不将其全部归因于本次三项规则。
- 最终静态记录 `reports/validation.json`（`2026-09-07T13:07:43.776Z`）：43 题通过，3,023 份原始文件 hash 未变化。此前共享运行时锁不一致在最终检查中已不再出现。
- 九题当前共 129 个公开操作、72 个公开探针、191 个 schemas，仍保留 419 个私有用例。原 README/Manager、Frozen Plan、Scenario 及历史 workspace 不变。

以上只验证作者契约、评测调用与回归行为；未运行模型，也未完成完整业务、数据库恢复、浏览器 UI 和性能认证。FlagFoundry、PermitForge 与 IncidentRelay 的剩余对齐待办仍保留，不能据此宣称正式隐藏评测已全部认证。
