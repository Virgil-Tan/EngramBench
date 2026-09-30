# 评测时钟与失败归因修正（2026-09-08）

## 时间基准

- 删除正式 V2 评测及冻结代码补评入口对绝对日期的注入，不再把某一天作为整个批次的 fixture 日期。
- 每个独立用例创建上下文时，以当时真实时间生成相对时间数据；应用与 PostgreSQL 使用正常系统时间。不修改提交的时钟或业务代码。
- 随机 seed 保持不变；会话有效期、租约过期、恢复等待、性能断言等公开要求仍然保留。
- 补评记录 `clockPolicy: case-start-wall-clock-v1`。历史固定日期只作为来源记录，不参与新用例执行；旧结果不能在新时钟策略下直接复用。
- 单元测试仍可给 fixture 显式日期，以验证跨日期的相对时间语义；这不是业务评测的时间注入入口。

## 失败归因

- 明确的提交断言、有效公共命令执行失败、明确观察到的不合规响应，仍记录 `failed`。
- 已标记的测试数据、公开契约或基础设施错误，记录 `evaluator_error`，保留其错误码。
- 来源不明的异常（如 TypeError、ReferenceError、未归因 socket 错误），记录 `evaluator_error / EVALUATOR_UNATTRIBUTED_FAILURE`，不默认扣模型分。
- 任务断言包装必须先调用共享 `assertCandidateError`，不能把任意异常包装成提交失败。轮询不能吞掉测试代码异常再改报提交超时。
- 私有报告保留异常链、命令阶段、退出信息与诊断；存在评测异常时不能宣称正式总分。异常不等于通过，也不补送分数。
- 公共 seed/request 边界继续验证正向测试数据。此规则不能自动证明所有 fixture 的业务语义正确：无法判断责任时保留未归因状态，必须查证，不能归罪提交。

## 已核实的独立问题

- AccessSentinel r2 同一冻结代码从 37.75 下降到 14.75，其中 11 个由通过转为失败的用例共 23 分，与固定日期造成会话过期吻合。
- AccessSentinel r1 仍存在 seed 中 JSONB 数组编码、内部字段导入、快照类型等独立问题，不由该时间基准造成，未修改提交。
- E-07 与 B-04 共用严格的 UTC 时刻比较，接受等价的 `Z` / `.000Z` 表示，仍拒绝不同时间、非法时间以及不同非时间字段。

## 修改边界与验证

只更新评测作者源文件、共享执行器、补评入口和生成评测包；不更新公开 README、Frozen Plan、业务断言标准、Skill Bank、实验 workspace 或冻结提交。生成包刷新逐项验证公开契约与 workspace 摘要不变。

验证包括：跨日期同 seed 的有效会话与相对过期语义、未知错误/错误包装/轮询归因、真实提交失败不获豁免、UTC 等价表示及不同值的反例；运行完整 `npm test` 与 `npm run check`。服务器验证使用独立评测副本和新输出目录，历史结果保留。

本轮验证记录：

- 本地完整测试：763 通过，3 跳过，0 失败；43 个任务静态检查通过。这不是 43 个任务的业务认证。
- 服务器独立副本：`<private-run-root>/evaluation-inputs/superhard-v2-clock-attribution-20260908/runtime`。以原补评 runtime 为底，只移植本次时钟/归因和 E-07 时间比较修正，未把本地并行进行的其他改动带入服务器。
- 服务器针对性回归：11 项通过。
- AccessSentinel r2 A-09 使用同一 seed 和同一冻结代码重新执行，结果 `passed`；原固定时间补评在该用例报会话过期。新结果：`<private-run-root>/evaluations/superhard-v2-clock-attribution-20260908/accesssentinel-r2-time-smoke`。这是单用例验证，不是新的整套总分。
- AccessSentinel r3 尚未开始的补评等待器切换至新独立入口，去掉固定日期参数；仍等待原 Coding Harness 冻结提交，不修改或重启 Coding Agent。队列记录：新结果父目录下 `accesssentinel-r3-queue.log` 和 `accesssentinel-r3-queue.pid`。

## 后续：精简测试自身的额外要求

### 已修改

- **不指定内部 Work 状态名称。** Creator C-01 和快照 Work 校验不再要求 `state === LEASED` 或终态必须不叫 `LEASED`；公开 `DurableWork.state` 只是字符串。C-01 仍检查实际 claim 对应的 Work、kind、aggregateId、attempt、owner、有效 UTC expiry、令牌不泄露，以及 release 后保留 terminal 记录。租约过期和 fencing 仍由恢复用例验证，不用测试准备或读取快照的耗时冒充租约时长。
- 删除 C-05/E-04 中同样依赖私有 `LEASED` 名称的全局瞬时检查：C-05 已等待本用例所有相关 Work 真正 terminal；E-04 已检查完整处理结果、唯一性、吞吐、RSS 和临时文件清理，不应从一次快照推断所有后台 Work 都不能处于租约过期待重领的合法过渡状态。专门的过期重领、旧 token fencing、崩溃恢复检查不删。
- **删除重复的日期字符串比较。** Access B-04/E-07 与 Creator 账期区间、账目排序统一按 UTC 时刻比较，接受等价的 `Z`、`+00:00`、可选小数和大小写表示。保留小于毫秒的精度、左闭右开边界和全部非时间字段断言。只在比较时解释时间，不重写响应或哈希输入中的时间字符串。
- Creator A-06、A-14、B-08 的区间判断复用 `periodEntries`，不再各自用字符串大小判断范围。生成的评测包已同步；43 个包的公开契约和 workspace 摘要均保持不变。

### 不能靠删除测试消除的提交问题

- Access r1 把 JSON 数组直接交给 PostgreSQL JSONB 导入，出现数组编码错误；空数组又被编码成对象，导致快照 `riskFlags` 类型错误。公开契约确实要求数组，不增加自动对象转数组的 Adapter。
- Creator r2 A-15 的正向 seed 已包含 Delivery 引用的 Event。冻结 `src/store.ts` 先在 1171 行导入 Delivery，到 1193 行才导入 Event，违反提交自己的 `deliveries_event_id_fkey`。不能替它调整数据库或删掉合法的关联 seed。
- seed 接口及完整快照均为公开要求，继续保留；测试作者先保证输入符合公开契约，提交负责正确导入和输出，不要求相同数据库表结构。

### 单独记录的契约缺口，不能笼统归罪提交

Creator A-06 的 CLOSED period seed 另有摘要口径分歧：README §7 规定 RFC8785 SHA-256，但没有像 Edition manifest 那样写出确切哈希输入。测试使用 entries 数组，r2 的 `seedPeriodDigest` 使用包含 period、entryCount、accountTotals、entries 的对象。两者不一致不等于已证明模型实现错误。时间修复时没有私自选择一个新业务定义，没有改公开规则或重算历史分数；不应与已证实的 Event 外键导入顺序错误混为一谈。

后续经用户批准，以独立 `creator-royalty-digest-v1` 公开策略补齐范围、字段、排序、时间表示和固定向量，并同步 seed 与 oracle。详见 [摘要策略与复测记录](creator-royalty-digest-v1.zh-CN.md)。新策略只评判收到该契约后的续跑交付，不倒扣历史提交。

### 本轮验证

- 先复现真实 C-01 对 `RUNNING` 的误判，以及账期字符串比较遗漏区间内数据，再修改。
- 新增回归覆盖状态命名自由、缺失/错误 lease authority、原始 token 泄露、必须实际观察 terminal、UTC 等价与不同值、亚毫秒边界、原 JSON 字节不变及 Delivery/Event 关联。
- 本地 `npm test`：772 通过、3 跳过、0 失败；`npm run check`：43 个任务静态验证通过。
- 服务器独立副本：`<private-run-root>/evaluation-inputs/superhard-v2-pure-contract-20260908/runtime`，仅基于上一版时钟/归因副本移植上述修改；9 项针对性回归通过。
- 原冻结 Creator r2 的单项 C-01 复验输出：`<private-run-root>/evaluations/superhard-v2-pure-contract-20260908/creatorrightsexchange-r2-lease-smoke`。这是修复验证，不是新一轮 Coding，也不是完整任务总分。
- C-01 复验结果仍为 `failed`，但已通过 Work 状态和租约字段检查，失败点变为公开快照暴露了与 barrier 相同的可用 `leaseToken`。原始冻结 digest 仍为 `a086fc198e537a763ac43079f896b1857163e4096144de6c8da867c9b5652a9e`，seed 未变。该令牌隐私断言直接来自 README §10，不能为提高分数删除。

## Commerce r1 冻结补评接入（2026-09-09）

- 原续跑在 `2026-09-08T20:00:00.030Z` 通过 15 项公开检查，共完成 48 Turn。冻结 digest 为 `eaebc6eb22bc93e30164c01ec7619769dbff0202b5e5554736a98022d6770d93`；原 12 份实验仍只算 12 个样本。
- 预检复现 `v2_evaluator_lock_mismatch`：时钟副本更新了共享运行器，但 Commerce 包仍锁定旧运行器。失败发生于启动测试之前，不是提交失败。
- 不修改旧部署。在独立副本 `<private-run-root>/evaluation-inputs/commerce-v2-clock-ready-20260909-DKv71I/runtime` 中，以原已发布的 Commerce evaluator 文件作为重打包输入，运行现有 `scripts/refresh-evaluator-only.mjs commercecommand`。业务用例 digest 仍为 `8ebbf91828820d3db5a9ec0d1605989735e98023618a61344a624b176332a828`；仅刷新部署锁定信息，未改断言、公开契约、Plan、实验 workspace 或冻结代码。
- 同一冻结预检随后通过，核验公共契约、原任务包、Plan、提交 digest 和运行器锁。沿用 seed `20bfc4d836bcff64c0d2c20e46fba05b5386f00da702fce03a460c752a601ab2`，采用 `case-start-wall-clock-v1` 及 PG256 / 32GiB PGDATA / 64GiB RAM / 4CPU 环境。
- 完整 55 项补评于 `2026-09-08T20:15:25.249Z` 启动，PID `2160159`，输出 `<private-run-root>/evaluations/superhard-v2-clock-attribution-20260908/commercecommand-r1`。这条记录只确认启动，不表示全量通过或正式认证；以后以该输出的 `status.json`、`result.json` 为准，不重复启动。
- 后续任何共享评测运行器变更，都应对待测任务执行同一冻结预检；不能因为其他任务的锁通过，就假定 Commerce 包也已同步。
- 本次补评于 `2026-09-08T21:22:10.823Z` 完成，耗时约 66.76 分钟：55 项中 36 `passed`、4 `failed`、12 `evaluator_error`、3 `excluded`。55 个用例 ID 与启动清单一致；52 份非排除用例结果及环境记录齐全，冻结 digest 一致，未见 OOM、磁盘耗尽、PG PANIC、连接耗尽或 PG 日志截断记录。12 项异常包括尚未标明责任的 `AssertionError` 和超时，不能据此统称环境故障，也不能手工改为通过或提交失败。`score`、`rawScore` 仍为 `null`，不作正式总分；保留完整输出，勿盲目重跑。
