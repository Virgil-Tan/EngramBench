# 四个超级难 Transfer：V2 契约迁移

## 2026-09-08：作者授权补充公开政策并续跑旧代码

本节取代下方历史记录中仍待授权的政策缺口。公开作者源为 `contracts/transfer/coldchaincontrol-policy.md`（`coldchaincontrol-2026-09-08.1`）和 `accesssentinel-events.md`（`accesssentinel-2026-09-08.1`），随生成器进入完整公开契约。原 README、Frozen Plan、Scenario 和历史成绩不改。

- ColdChainControl：明确距离公式/毫米舍入/半径边界、通知事件与不可变字节、共享滑动限流、退避/死信及精确 Worker/Dispatcher 故障注入协议；原被阻塞断言改为实际校验，不直接赠分。修正投影 oracle 关闭一个温度异常后无法记录下一次异常的问题。
- AccessSentinel：明确请求、风险、审核、授权、撤销、过期事件的名称和封闭 payload；A-14 按提交资源核对事件与 webhook 字节，不再标 AS-GAP-03。未公开的 V1 Region mutation/可控时钟不额外假定存在。
- CreatorRightsExchange：沿用已经补齐的公开上传链与错误清理修复，无新增业务政策。
- 验证：`npm test` 359 通过、0 失败、1 项可选原生浏览器检查跳过；`npm run check` 通过。新增政策回归 8/8。仍为 `pending_live_validation`，不把单测当作正式端到端认证。

续跑使用现有 `migration-repair`，不新增 Runner。复用原代码到独立续跑 workspace 的 `legacy/`，记录逐文件 SHA-256 和来源 session；模型先读 `MIGRATION.md`、审计并复用已有实现，再对齐 V2。不是清空代码重新开发。原 workspace、成绩和运行记录保留；新增 Turn/Token 单独记账。

本轮目标：ColdChainControl r2/r3、AccessSentinel r1/r2/r3、CreatorRightsExchange r1/r2，共 7 份已停止代码。ColdChainControl r1、CreatorRightsExchange r3 仍运行，不覆盖；CommerceCommand 已有单独迁移，不重复启动。配置见 `profiles/*-v2-align-*-20260908.json`，服务器独立部署根为 `<private-run-root>/evaluation-inputs/superhard-v2-alignment-20260908/runtime`。沿用 GPT-5.5 medium Coding Agent、原 Guide 镜像和 Skill Bank。公开接入验收失败会回到该续跑模型修复；通过后冻结，正式隐藏计分仍须先完成 evaluator 认证。

启动记录（北京时间 2026-09-08 01:16）：7 个 Runner/专属容器及新 rollout 均存活，6 份已执行真实命令；导入文件数分别为 Cold r2/r3：28/25，Access r1/r2/r3：27/25/22，Creator r1/r2：21/19，逐文件 digest 保存在各 run 的 `projects/01-<task>/private/migration.json`。最初部署缺失 `tasks/`、`experiments/` 源清单，进程在模型调用前退出；已补齐并复用同一 run id 启动，原日志与 `bootstrap-recovery.json` 保留。此处仅为启动快照，不表示已经完成 V2 对齐。

## 2026-09-08：评测异常收尾和公开成功链

修复 Creator/Access 的浏览器等待未处理异常；Creator 公开上传接入链新增 5 步，Access 公开 Session→Request→Snapshot 新增 3 步。Access 已公开 Review 与 FINAL Snapshot 的断言已接通，不再标为 AS-GAP-01/04。完整变更、未定义政策及验证边界见 [三题修复记录](superhard-v2-integration-findings-20260908.zh-CN.md)。原生成业务代码、原 README/Plan/Scenario、历史运行和分数未改；未完成真实提交认证的 release 不放行。

## 2026-09-07：公开接入验收加强

- 复用原有交付 gate，不新增 Runner、回合限制或提交 Adapter：作者文件完整性检查 → 隔离副本/数据库运行公开验收 → 失败反馈到同一 Coding Agent → 复查 → 核对通过验收的源码 digest 后冻结。环境异常不进入隐藏业务计分。该流程适用于所有使用 V2 入口的实验组，历史运行不会热更新。
- ColdChainControl 公开 smoke 加入完整的最小接入链：公开非空 Seed → 以 Snapshot 数据库时间和公开凭证签名 → 获取配置 → 签名上报遥测 → Snapshot 核对返回 ID、设备/租户、数值与签名脱敏。不能只靠空读取、Schema 通过或伪造成功响应过关。
- 公共 checker 支持声明式 HMAC-SHA256 请求签名；只构造公开客户端请求，不提供提交端的凭证查找、鉴权、持久化或业务实现。签名输入源自公开 README 协议与既有公开 Seed，未使用隐藏 fixture 或历史提交生成公开答案。
- 失败报告包含方法、路径、预期/实际状态和错误码；上游捕获失败时，下游标记 blockedBy，不冒充多个独立缺陷。报告不直接输出鉴权头、签名或完整响应正文。
- ColdChainControl 已公开明确的 SPEC-GAP-01 改为可执行校验：A-04 的实际 Snapshot、A-07 的精确 items/nextCursor、跨页无重叠/遗漏与重启连续性、D-01 的公开状态及真实响应。保留原业务断言和权重，不接受猜测包装，也不只用提交自行声明的 OpenAPI 验证自己。
- SPEC-GAP-02/03/04（距离边界、通知策略、故障注入协议）仍保留，不擅自制定新业务政策；release 仍为 pending_live_validation。定向回归和模拟 HTTP 不等于真实 PostgreSQL/浏览器全量认证。
- 本轮验证：当前仓库 `npm test` 300/300 通过，`npm run check` 通过 43 个任务包，确认 3,023 个原始文件未改。ColdChainControl 公开 probe 从 9 项增至 13 项；测试覆盖签名的独立协议校验、401、假成功无持久化、错误游标包装，以及现有 gate 的失败反馈/复查、基础设施隔离和冻结 digest。全套数量包含仓库同期其他工作，不代表本轮新增 300 项。未部署服务器、未重跑历史提交、未宣布真实业务认证通过。

## 2026-09-07：公开接线与评测错误修正

- AccessSentinel 与 CreatorRightsExchange 的 UTC 时间字段和隐藏时间校验复用公开 runtime 的同一 Schema/validator；接受公开允许的无小数、不同小数精度及 `+00:00`，仍拒绝非法日历、非法时钟和非 UTC 偏移。未转换提交响应，也未移除业务断言。
- 复用已有 `test:public-contract` 真实链路：安装、构建、迁移、公开非空 Seed 导入/重放、API/生产角色启动、创建/修改/查询及 Snapshot。命令失败保留 stage、退出码和输出；捕获变量失败时依赖 probe 标为 `blockedBy`，独立 probe 仍执行。结构检查通过不代表导入或业务正确。
- 隐藏评测保留 CommandError 的 stage/exit/stdout/stderr、嵌套 cause 和独立 cleanupError。合法 Seed 被提交导入器拒绝仍属提交失败；明确的评测环境错误仍属 evaluator_error，不通过错误文本猜测免责。
- Case 清理成功后才标记完成，成功释放的资源不重复释放，失败资源与临时目录保留；进程停止需要确认专属进程组已退出。业务断言与清理失败同时发生时保留两条证据，结果为 evaluator_error，不作为正式零分。
- 外层容器清理失败单独写入 `cases/<id>/cleanup-error.json`，保留已有 case 结果与私有状态，停止后续 case，避免隔离未确认时继续；不自动重启模型或覆写提交。环境修复后由调用方显式续测。
- 未调整分值/业务阈值，未增加模型回合或调用超时，未新增提交专用 Adapter。共享模板和 runtime lock 需同步到本仓库生成任务包；历史运行目录、原始 README/Plan/Scenario 不变。
- 此修改不等于四题已完成真实 PostgreSQL/浏览器/全量隐藏评测认证；release 继续保留原有待验证状态。
- 验证：本次修改及四题相关定向回归 47/47；最终当前仓库全套 `npm test` 为 234 通过、0 失败、1 个既有 GeoPulse TODO；`npm run check` 通过全部 43 个任务包并确认 3,023 个原始文件未改。全套数字包含仓库同期其他修改，不表示这些测试都由本次新增。

## 范围

CommerceCommand、ColdChainControl、CreatorRightsExchange、AccessSentinel 沿用完整原始业务 README、Manager 需求、Frozen Plan 和 Scenario。它们加入 `transfer-tasks.json`，不改变 `learning-tasks.json` 的 30 题，不进行 Skill Evolution。

迁移只在本 V2 仓库内进行，不更新旧仓库、运行 workspace、历史分数或模型会话。没有提交专用 Adapter，也没有参考业务实现注入起始工程。

## 文件与唯一维护入口

| 路径 | 职责 |
| --- | --- |
| `task-packages/imported-contract-first/<id>/` | 用户指定四个新版任务包的逐字原始副本，不用于 V2 运行 |
| `task-packages/legacy/<id>/`、`tasks/<id>/` | 原业务文本、Plan、Scenario、评测来源，不修改 |
| `provenance/superhard-import.json` | 原始文件 SHA-256 清单 |
| `contracts/transfer/<id>.mjs` | 每题唯一公开 wire 合同：字段、类型、错误、参数、示例、seed、snapshot、smoke |
| `evaluators/transfer/<id>/v2/` | 同步此公开合同的私有业务评测作者源 |
| `evaluators/transfer/<id>/release.json` | 隐藏评测对齐与真实运行认证状态 |
| `task-packages/v2/<id>/` | 使用现有 V2 生成器产生的正式任务包位置 |

## 迁移原则

1. 公开文档决定业务；缺失表示方式由作者明确发布为 V2 wire 澄清。不得从旧提交、私有 fixture 或测试答案生成公开需求/示例。
2. 所有发布操作有请求/响应/成功状态；真正无 body 显式标注。路径、查询、请求头的类型和必填规则可机械验证。
3. 每题提供非空关联 seed；公开烟测使用实际返回 ID，完成写入后再从持久化结果读取验证。schema 构造或空快照通过不算业务完成。
4. 私有 HTTP 调用和 seed 输入也经过同一个作者合同验证。正向测试违反合同报 `EVALUATOR_PUBLIC_CONTRACT_MISMATCH`；仅真正畸形输入测试单独声明 `contractExpectation:'invalid'`。
5. 私有评测不能要求未公开字段名、额外精度或未声明格式。保留独立业务、幂等、并发、恢复、UI、性能断言，不以更改提交适配评测。
6. 编译、fixture 和 oracle 回归不等于业务端到端认证。未完成真实提交隔离验证的包不得声明 `certified`，正式计分启动仍受已有发布门禁控制。

原文未提供的经济/策略决策不通过“补字段”擅自决定；如仍阻碍可执行业务断言，必须在 release/blockers 中明确记录，不能默默把 blocked 用例变成 passed。

## 生成与验证

```sh
# 仅重新生成这四个任务的作者包，绝不重写运行 workspace
node scripts/materialize-learning.mjs --group transfer --refresh
npm test
npm run check

# 导出任一任务的公开起始工程，不包含隐藏评测
npm run prepare:task -- --task coldchaincontrol --output /absolute/new-workspace
```

文件名 `materialize-learning.mjs` 保留原入口兼容性；`--group transfer` 使用同一个生成器/传输层/检查器，无第二套 Harness。省略 group 仍仅生成原 30 个 Learning，`--group all` 才显式选择两组。

正式实验沿用 `scripts/run-v2.mjs` 和 baseline/native/guide profile；选择上列 taskIds，`evolution:false`，使用新的 runId。认证不足会在模型调用前拒绝正式计分。迁移修复实验仍单独标记，不与旧空白起点实验混算。

## 验证记录

最终机器可读统计由 `npm run check` 写入 `reports/validation.json`；逐题 wire/fixture/oracle 回归位于 `test/superhard-*.test.mjs`。是否进行了真实业务提交评测，以每题 release 和对应实际运行记录为准，不以测试数量代替。

本次四题合计 137 个公开操作、155 个 schema、35 步公开 smoke，保留 213 个私有用例。原始 619 份导入文件逐字校验，不更新旧仓库和历史提交。

2026-09-07 集成回归：`npm test` 共 149 项，148 通过、0 失败、1 项既有 GeoPulse TODO（冻结运行时的小数 multipleOf 精度问题，不属于此次四题迁移）；`npm run check` 对 30 Learning + 4 Transfer 静态校验通过。新增回归覆盖实际 HTTP 参数/错误/监听地址/畸形 JSON、公开包隔离导出及 TypeScript 编译、私有 OpenAPI/seed/请求 helper/oracle；没有把这些回归称为完整业务提交验收。

上轮迁移结束时，三个任务为 `pending_live_validation`；CommerceCommand 为 `pending_alignment`，当时尚有原文未定义的结算资格、费用/净额/舍入策略、部分数字退款策略、故障注入和完整性能负载协议。下节记录用户授权后的公开补充；这些不是历史模型实现缺陷。四题仍未完成真实 PostgreSQL、Chromium、并发恢复及性能认证。

额外发现的既有 V2 认证限制：当前 release digest 尚未覆盖整个作者 `public-contract/` 执行文件集合。未修改已有 30 题的认证协议/锁；四题保持未认证，不因定向回归通过而放行正式计分。完成这一覆盖以及上列业务验证后，才可发布正式认证。

## CommerceCommand 公开政策补充：2026-09-07.1

用户授权补充原先未定义的业务规则。作者源为 `contracts/transfer/commercecommand-policy.md` 和 `commercecommand-protocol.md`，由该题 `.mjs` 并入 `contract.json` 与 `contract/README.md`。不是从旧提交或隐藏答案倒推出需求，也不声称这些新选择原本已经存在。

- 明确累计退款分配、数字权益、结算资格、2% 费率/半入舍入、reserve/net、迟到争议和跨期 adjustment、账户及错误格式。
- 明确可替换本地 SANDBOX provider、Worker/Dispatcher barrier、冻结通知原始字节与 digest、三个 Manager 压测起点；原阈值不变。
- 公开检查增加真实报价、seller allocation、capture、settlement close、持久化读取，合计 15 步。只提供输入和独立预期，不实现业务。
- 同步核心经济断言；未写完或未实测的恢复、UI、性能断言继续明确标记，不通过删除诊断标记伪造认证。
- 仅 CommerceCommand 作者包重新生成；原始 README、Manager、Frozen Plan、Scenario、旧代码和旧分数保留不动。

续开发使用现成 `run-v2.mjs` 的 `migration-repair`：把旧 CommerceCommand r2 源码校验复制至新工作区 `legacy/`，模型自行复用并接入新接口，不由 Harness 替模型修改业务。新 session、独立 run ID、原账号/GPT-5.5 medium、原 18 条 Skill、GPT-6 medium Composer/300 秒保持不变。完成后停在 `awaiting_evaluation`，正式认证前不自动计分；不能和旧空白起点实验混算。

本轮本地验证：`npm test` 156 项，155 通过、0 失败、1 项既有 GeoPulse TODO；`npm run check` 对 34 题通过静态校验。未运行完整隐藏业务评测。

2026-09-07 18:43（北京时间）已启动 `commercecommand-v2-policy-migration-20260907`。独立部署与结果位于服务器 `<private-run-root>/evaluation-inputs/commercecommand-v2-policy-migration-20260907/runtime/`；run 在该目录 `runs/` 下。迁移记录确认复制了旧 r2 的 22 个源文件，原文件逐个 SHA-256 校验；新 Runner 和 Docker 容器存活，新 Codex rollout 已有真实命令执行。此处是启动时快照，不是持续运行保证。

## 2026-09-08：12 份统一 V2 续跑

用户进一步授权补齐公开规则并同步测试、在现有 workspace 继续。12 份的唯一当前映射、备份、独立补评环境和未测边界统一记录在 未随开源版发布的内部续跑状态记录。以上历史启动记录保留，不重复计入新运行数量；Commerce r2 继续的是已完成的 V2 workspace。公开 protocol 修订为 `commercecommand-2026-09-08.1`；经济 policy 不再次更改。恢复、可见 UI 和完整规模性能用例已补完；真实业务评测和正式认证仍不得由本地回归代替。
