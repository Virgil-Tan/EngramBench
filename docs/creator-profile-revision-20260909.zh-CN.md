# CreatorRightsExchange：Profile revision 接入修正

修订：`creator-profile-revision-v1`，2026-09-09。

## 问题与边界

原文只要求不可变、有版本号的 TranscodeProfile，未规定不同 profile 的 revision 是否共用租户级计数器。旧普通 seed 在同一租户下放入两个不同 profile，revision 都为 1；采用租户级唯一版本号的实现会在业务测试开始前失败。不能将这个未公开的假设当作模型业务错误。

作者契约现在明确：不强制特定版本号分配策略、不断言下一个版本号必须是多少；API 返回的版本和 seed 指定的版本必须原样保留，TranscodeJob/Rendition 必须绑定准确的 profileId + profileRevision。不可变性、租户隔离、完整引用、原子导入和重放断言不变。

公开示例增加一条独立的 Preview profile，采用不同版本号，并由真实公开 snapshot 检查两条已入库记录。隐藏普通 seed 的第二条 profile 使用不同版本号。这是任务级修正，不是某份提交的 Adapter；没有修改业务断言、权重或模型生成的代码。

## 单独存在的实现错误

Native Baseline r3 的 seed 引用映射遗漏 transcodeProfiles，导入含 TranscodeJob 的数据时对 undefined 调用 get。它不由重复版本号造成，本轮不代替模型修代码，也不删除相关合法数据以绕过错误。

补评已实测：r3 的 A-04 由失败变为通过，A-02/A-03 仍触发上述引用映射错误。r1 解除 revision 冲突后，A-02 暴露 `edition_assets_asset_id_fkey`：其 importSeed 在插入 EditionAsset 前没有向真实 blob_objects/renditions 业务表导入关联行，后面的通用 resource_records 保存也不能满足这些外键。该提交缺陷同样保留，不通过修改测试消除。r2 的 A-02/A-03 已通过；这些是执行中的单项观察，不是最终总分。

## 验证与补评

- 新回归直接调用实际 fixture factory，覆盖公开示例、多种普通 seed、批量数据和冻结版本引用；修改前失败，修改后通过。
- 定向测试 12 项通过；完整 `npm test` 841 项通过、0 失败、7 跳过；`npm run check` 通过。作者/生成 evaluator、release 及公开契约副本一致。
- evaluator digest：`6769ea9af65e2f222771c8d06f052439811f036f3742385351c8cba05e86a663`。
- 作者源同步到新生成包；新实验读取公开说明与增强示例。
- 三份历史 Baseline 使用相同修正 evaluator、相同评测 seed 补评，保留它们开发时的公开包、Frozen Plan、workspace 和冻结提交摘要。新公开示例不追溯注入历史代码。
- 独立结果目录：`<private-run-root>/evaluations/creator-profile-revision-20260909/baseline-r1` 至 `baseline-r3`。原结果不覆盖。
- 使用既有原生 AMD64 evaluator 与独立数据库/网络，不使用 QEMU、接口重写或 Coding Agent。
- 沿用 author-validation 口径；必须等完整结果，不把部分通过权重当最终分，不把 evaluator_error 当业务失败。

启动时间：2026-09-09 21:59（北京时间），三份各执行完整 54 项清单；原有缺少 V1 checkpoint 的排除项仍保留。

本轮源码改动是 profile 前置数据和公开说明；部署使用当前已验证的 V2。相对旧 Native 评测镜像外的运行库，另包含此前已存在的命令退出清理、HTTP 超时归因、共享断言/UI 工具以及 Creator B-09 异步观察修正。因此总分变化不能全部归因于这一处版本号调整。没有将这些旧修正重复声明为本轮新增。

## Guide 同版补评

经用户确认，Guide r1/r2/r3 也从各自冻结提交重新执行完整 54 项清单。来源仍为 `creatorrightsexchange-digest-v1-r1/r2/r3-20260908`，没有调用开发模型或改变代码。

独立部署位于同一 evaluation-inputs 目录下的 `guide-runtime`；来源记录是 `guide-manifest.json`，结果是同一 evaluations 目录下的 `guide-r1`、`guide-r2`、`guide-r3`。Baseline 部署未修改。

启动前逐份验证冻结摘要；Guide/Baseline evaluator digest、共享 runtime lock、评测 seed、原生 AMD64 环境和数据库资源配置完全一致。公开业务及接口契约相同，忽略的只有已有 publicScaffoldRevision 元数据差异。各自历史公开包按原样保留。代码从旧版本迁移而来的开发经历差异仍存在，本次补评并不消除该实验混杂因素。
