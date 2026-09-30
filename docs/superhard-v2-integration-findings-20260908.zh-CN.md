# 三题 V2 接入问题清单

记录日期：2026-09-08。范围：ColdChainControl、AccessSentinel、CreatorRightsExchange；不含已单独续开发的 CommerceCommand。

下方保留修复前检查证据；本页顶部记录本轮修复状态。只修改独立 V2 作者源码、公开检查与生成包，未修改历史提交代码、服务器运行或历史分数。

## 本轮修复状态（2026-09-08）

| 范围 | 已实施 | 未宣称完成 |
| --- | --- | --- |
| CreatorRightsExchange CRE-01/02 | 上传的多响应等待、共享单响应等待及文件选择等待立即绑定 rejection observer。仍返回原 Promise，原 UI 失败、响应超时和业务断言照常失败，页面关闭不再产生未处理 rejection。AccessSentinel 同型等待一并处理。 | 不补提交缺失 UI，不保证全部浏览器业务正确。 |
| CRE-03 | 公开 smoke 9→14：沿用已有公开单字节上传示例，创建→原始字节 chunk→完成→GET→Snapshot；绑定 uploadId/blobId/digest/持久化记录。 | 不提供扫描、转码、恢复等业务实现。 |
| AS-01 | FINAL Snapshot 必须包含全部四个已公开 Manager 集合，V1 检查仍使用独立旧集合。A-12、D-01、D-03 实际调用/操作 Review 并检查持久化和状态；A-15/A-16/D-05/D-08 检查 Manager 状态及连接。删除的仅是已实现断言对应的 AS-GAP-01/04 标记。 | AS-GAP-03 的事件类型/payload 仍未公开；不是模型开发失败。 |
| AS-02 | 公开 smoke 9→12：增加合法公开 RiskModel 示例 Seed、成功 Session→AccessRequest→Snapshot，核对冻结的 Session/Policy/Risk/Trust 标识。 | 示例风险权重不是新增强制业务政策；没有宣称 Risk Worker 或 Grant 全部通过。 |
| ColdChainControl | 保留已有 13 步签名接入链。重新核对原文，仅要求半径映射、持久化限流与 barrier 故障注入，未定义缺失的具体规则。 | SPEC-GAP-02/03/04 需要公开政策/协议补充，不能擅自猜测或删掉扣分项。 |
| 运行时打包 | 共用 browser.mjs 加入 V2 runtime 文件锁并重新生成作者任务包；不依赖机器上未打包的辅助文件。 | 不热更新历史 run。 |

验证：

- `npm test`：352 项，351 通过，0 失败，1 项真实 Chromium 测试因默认未配置可执行路径跳过；同一测试已在本机 Chrome 和固定原生 ARM64 Docker Chromium 中显式执行通过。
- 固定原生 ARM64 Docker 镜像中的 PostgreSQL `SELECT 1` 成功；浏览器/上传接线/Review 持久化回归共 8/8 通过。
- `npm run check`：43 个任务包通过，3,023 个原始导入文件字节一致；共享运行时文件锁已同步。机器记录为 `reports/validation.json`。
- 负向回归确认：缺少 UI 仍失败，完成响应没有持久化 Blob 仍失败，Review 未落库/请求未更新仍失败，FINAL Snapshot 缺任一必需集合仍失败。
- 未进行完整真实提交隐藏评测，未验证服务器原生 AMD64 全部路径。三题 release 保持 `pending_live_validation`；修正其说明，不再把“业务全通过”误当成环境认证条件。

环境版本及复现命令见 [V2 评测环境记录](evaluator-environments.zh-CN.md)。

## 判断边界

- 评测环境应能按公开契约发起请求、读取结果、完成清理，并正常记录失败。
- 提交不符合已公开接口、缺少 UI 或业务错误，属于开发失败，应正常扣分。
- 不用提交专用 Adapter 补业务、不放宽断言、不以业务全通过作为接入检查通过的必要条件。
- 公开检查只验证最小真实接入链，不应扩张为隐藏业务答案。

## 修复前收集的问题（历史证据）

| 编号 | 任务 | 证据级别 | 问题及影响 | 后续处理范围 |
| --- | --- | --- | --- | --- |
| CRE-01 | CreatorRightsExchange | 当前源码片段已复现 | D-02 先创建两个响应等待，再执行 UI 操作。操作抛错时没有收尾等待；页面关闭会产生未处理 Promise rejection，可能使 evaluator 退出，而不是正常记录提交 UI 失败。 | 修评测等待的异常收尾，保留原始业务失败；不得补提交 UI。 |
| CRE-02 | CreatorRightsExchange | 同型源码待回归 | 另一上传片段及共享 `captureJsonResponse` 也使用先等待、后执行 action、最后 await 的模式；action 失败路径需要统一核查。 | 在评测端验证同类失败路径，不逐提交添加补丁。 |
| CRE-03 | CreatorRightsExchange | 公开检查源码确认 | 9 个 smoke probe 覆盖健康、OpenAPI、Seed、Tenant/Creator/Work/权益拆分及回读，未覆盖成功上传的最小接入链。现有 smoke 通过不能证明上传请求、二进制数据及返回标识接线正确。 | 按已公开协议补最小上传接入与标识回读检查；转码质量、并发、恢复仍由隐藏测试评分。 |
| AS-01 | AccessSentinel | 契约与评测标记并存 | 公开契约已定义 Review 与 FINAL Snapshot 的部分形状，但 manifest/scoring/cases 仍保留“未公开”的诊断标记。不能把所有标记直接删除，尤其 V1 checkpoint 与 FINAL V2 需区分。 | 逐断言核对公开来源；确已明确者实现精确断言并同步标记，真正未定义者单独保留待定。 |
| AS-02 | AccessSentinel | 公开检查源码确认 | 9 个 smoke probe 验证关联 Seed、策略创建/发布/回读；Session 只检查空请求 400，未走成功的 Session→授权接入链。 | 增加公开正常请求链及返回标识/持久化核对，不替模型实现授权规则。 |
| CCC-01 | ColdChainControl | manifest/scoring 明确阻塞 | SPEC-GAP-02：站点半径的距离公式及边界舍入未明确。 | 先核对原文；需要新政策时明确公开版本，不能私自猜规则或删测试。 |
| CCC-02 | ColdChainControl | manifest/scoring 明确阻塞 | SPEC-GAP-03：通知 payload、限流窗口、死信触发细节未明确。 | 分离 wire 澄清与业务政策，先发布必要契约再同步评测。 |
| CCC-03 | ColdChainControl | manifest/scoring 明确阻塞 | SPEC-GAP-04：barrier 点位、payload 与 release 协议未明确，精确旧 owner 故障注入未接通。 | 固定公开故障注入协议，仅提供控制接口，不实现 fencing/恢复业务。 |
| COMMON-01 | 三题 | release 文件与入口实测 | 三题均为 `pending_live_validation`，实际调用正式发布检查均返回 `v2_evaluator_not_released`。尚无这三题完整原生环境接入验证的证据。 | 验证 PostgreSQL、生产启动、浏览器、清理与失败报告链路；业务失败应有结果，不等于环境失败。不能仅改 release 标签放行。 |

## 代码位置

相对路径以本独立 V2 仓库为根；生成包不是修改入口。

- CRE-01：`evaluators/transfer/creatorrightsexchange/v2/cases/d.mjs:119`、`:124`。
- CRE-02：同文件 `:765`、`:770`；`evaluators/transfer/creatorrightsexchange/v2/cases/helpers.mjs:1364`。
- CRE-03：`contracts/transfer/creatorrightsexchange.mjs:305`。
- AS-01：`evaluators/transfer/accesssentinel/v2/lib/scoring.mjs:14`；同题 `manifest.v2.json`、`cases/a.mjs`、`cases/d.mjs`；公开 `contracts/transfer/accesssentinel.mjs` 的 Review/Snapshot 定义。
- AS-02：`contracts/transfer/accesssentinel.mjs:153`；成功 Session 定义 `:77`，现有负向 probe `:167`。
- CCC-01～03：`evaluators/transfer/coldchaincontrol/v2/lib/scoring.mjs:14` 和同题 `manifest.v2.json`。
- COMMON-01：`evaluators/transfer/<task>/release.json`、`src/evaluator-release.mjs:14`。

## 阻塞范围

### ColdChainControl

- SPEC-GAP-02：A-14。
- SPEC-GAP-03：A-15、C-07、C-08。
- SPEC-GAP-04：C-02～C-06、E-03、E-06、E-08。
- SPEC-GAP-01 已在之前的 V2 加强中处理，不再列为未解决问题。
- 已有 13 个公开 probe，包括公开 Seed→签名读取配置→签名遥测上报→Snapshot 回读；不需要为提高分数改提交实现。

### AccessSentinel

当前阻塞声明覆盖 A-12、A-14～A-16、D-01、D-03、D-05、D-08。
注册表还列有 Region 撤销入口、事件类型/payload、可控时间及迟到 review 错误等历史缺口；本轮未证明每项都仍真实缺失，也未证明每项均已解决。须逐项对齐，不按名称批量删标记。

### CreatorRightsExchange

保留三个 SPEC-GAP 注册项，但 manifest 的 `blockedAssertions` 列表为空。仅有注册项不能推出这些项当前都会阻塞评分；需要逐 case 核实实际使用，不能把历史说明直接当新增故障。

## 已执行验证及局限

1. 定向回归 45/45 通过。覆盖三题契约/私有 fixture/请求 helper、公共签名、生命周期错误、清理错误分类，以及 Transfer 包的导出/编译/原文一致性。
2. 三题生成包中的 `evaluator/v2/cases/d.mjs` 均与对应作者源码字节一致：上述浏览器写法不是只存在于废弃源码。
3. CRE-01 最小复现抽取当前 D-02 的原始等待和点击代码片段，以测试替身模拟 UI 控件缺失后关闭页面，得到：

   ```text
   business assertion: SUBMISSION_UI_CONTROL_MISSING
   unhandled waiter errors: 2
   ```

   这是评测异常收尾缺陷的可重复证据，不是对真实 Chromium 的完整端到端认证，也没有修改任何提交。
4. 三题正式发布检查实际均返回 `v2_evaluator_not_released`。
5. 未启动新模型实验、未补跑隐藏测试、未修改业务代码或断言。静态和替身验证不证明所有真实环境路径已可靠。

定向回归入口：

```sh
node --test test/superhard-accesssentinel.test.mjs test/superhard-coldchaincontrol.test.mjs test/superhard-creatorrightsexchange.test.mjs test/superhard-packages.test.mjs test/public-signed-probe.test.mjs test/public-lifecycle-diagnostics.test.mjs test/evaluator-cleanup-diagnostics.test.mjs
```

## 最初的处理顺序（执行状态以上方为准）

1. 修复评测自身异常收尾，验证缺少 UI 时正常记业务失败而非进程崩溃。
2. 对齐已公开契约与遗留诊断标记；未定义政策另列，不混入开发扣分。
3. 补最小成功接入链，保留开发自由度和隐藏业务难度。
4. 原生 AMD64 隔离环境验证接入和失败路径。保留源码、环境版本、用例证据；不要求某份提交业务满分。

完成这些步骤后，才能判断环境已达到“正确接入、业务好坏正常评分”的标准。
