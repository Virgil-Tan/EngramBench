# Creator 账期摘要公开策略与复测

## 范围

用户批准补齐 `creator-royalty-digest-v1`，解决 README §7 未定义确切哈希输入的问题。原 README、Manager requirements 和 Frozen Plan 保持不变；根 README 引用同一份公开补充契约。不是对历史分数的追溯解释。

- 同租户、同币种、左闭右开账期内的已提交 RoyaltyEntry。
- 只取公开的 13 个字段；不包裹 period、accountTotals 或 entryCount。
- 按真实 UTC 时间、royaltyEntryId 排序。只在哈希投影中规范化等价 UTC 写法，保留有效小数精度，不修改业务记录。
- 对数组做 RFC8785 canonical JSON → UTF-8 → SHA-256 → 小写 hex。
- CLOSED seed 与关闭账期使用同一规则；OPEN/CLOSING 的 snapshotDigest 仍为 null。
- 7 组公开固定向量覆盖空数组、排序、UTC 等价表示、金额变化、亚毫秒精度、租户/币种/时间边界。向量不是完整 seed 或业务实现。

作者源：`contracts/transfer/creator-royalty-digest-policy.mjs`。生成后的 `workspace/contract/contract.json` 包含完整策略与样例，`contract/README.md` 包含规则。私有 fixture 与 A-14/B-08/C-04/E-08 的 digest oracle 同步；不增加提交专属 Adapter。

## 续跑约束

Creator r1/r2/r3 均从已完成的 V2 workspace 继续：保留模型 GPT-5.5 medium、Guide、Skill Bank、Frozen Plan 和原实验配置；迁移入口先完整备份，再只安装作者公开契约。模型自行调整实现，操作者不手改生成的业务代码。

原冻结提交、结果和轨迹保留。新交付冻结后，三份均使用同一新版完整 evaluator；不能把新策略分数记作旧提交原分。

## 环境与验证

固定使用 `environments/evaluator-execution.v1.json` 的服务器原生 Linux AMD64 环境与已有 evaluator 入口。镜像、数据库资源配置不变。本修订不涉及新的环境例外。

验证记录（2026-09-08）：

- 本地 `npm test`：775 通过、3 跳过、0 失败；`npm run check`：43 个包通过。
- 服务器原生 Node：相关回归 11/11 通过；公开源完整性、运行时锁、固定镜像 AMD64 校验通过。
- 服务器从已验证的 `superhard-v2-pure-contract-20260908/runtime` 独立复制部署，不携带本地其他工作中的脚手架更新；逐字段确认公开契约只增加本策略，旧 router/server/seed/check 字节保持不变。
- 原始需求目录摘要：`b8a9fdb8750eb8854821c8b7ac6478c359f7d3c45c9bb5cb5b33f028595e6e2a`；Frozen Plan：`067693dee1c2084efabfdca31a239a30970f5981134c2b8dfa0179b795d28619`，均未改变。
- 服务器本轮包摘要：`d7d62b1e444c0d89a2d27478f495cfbd129555177768d0ae47c5a10013425c1b`；完整评测 54 项。

部署：`<private-run-root>/evaluation-inputs/creator-royalty-digest-v1-20260908/runtime`。

| 新续跑 ID | 原实现来源 |
| --- | --- |
| creatorrightsexchange-digest-v1-r1-20260908 | creatorrightsexchange-v2-align-r1-20260908 的 workspace |
| creatorrightsexchange-digest-v1-r2-20260908 | creatorrightsexchange-v2-align-r2-20260908 的 workspace |
| creatorrightsexchange-digest-v1-r3-20260908 | creatorrightsexchange-v2-complete-r3-20260908 使用的原 in-place workspace |

完整备份位于部署父目录的 `private-backups/<新续跑 ID>/workspace`。旧冻结摘要分别为 r1 `67a056529250499ef0a4eceb9ed0b81f957feb39df4fb70174d121303b5d4d6f`、r2 `a086fc198e537a763ac43079f896b1857163e4096144de6c8da867c9b5652a9e`、r3 `5238f933be2cb74a0b387a6653d07f6b35bbd5b74793bd1eb5972283c49a1eb2`，启动前已验证不变。

评测输出预定为 `<private-run-root>/evaluations/creator-royalty-digest-v1-20260908/r1`、`r2`、`r3`，沿用上一轮共同 seed `41fc1ba05159cf805fffa7290fbd6abeb2c7b6af9ca59e23bc19f57d234e1d86`。既有 `evaluate-when-frozen.mjs` 在新交付通过公开 gate 并冻结后运行全部 54 项。单元验证通过不等于三份业务提交通过，最终分数须以各自 result.json 为准。
