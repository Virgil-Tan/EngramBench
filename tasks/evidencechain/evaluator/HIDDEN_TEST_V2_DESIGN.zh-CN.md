# EvidenceChain Hidden Test V2 设计

> 黑盒设计稿，不实现 runner。共享 install/build/migrate/boot/health preflight 不计分。只使用 public HTTP/OpenAPI、scanner fixture、receiver/barrier、SIGKILL、Chromium 与 verification snapshot，不读取内部 matching/lineage 表。

## 1. 画像与隔离

- **两项主机制**：scanner batch/one-to-one custody authority 的原子重放；Aliquot 拆分、group confirmation 与 child lineage 的冻结 fanout。
- **五个 evidence family**：`CONTRACT`（公共接口与主流程）、`DATA`（不变量/幂等/并发）、`RECOVERY`（Verification/dispatcher 持久恢复）、`LAYER`（OpenAPI/UI/snapshot）、`OPERATE`（迁移/性能）；对应 dimension A/B/C/D/E，权重 30/25/20/15/10。
- **核心 primarySkill**：`S06` ordered-authority-and-frozen-membership、`S07` durable-work-fenced-recovery、`S11` point-in-time-snapshot-audit、`S17` frozen-fanout-aggregate-closure；数据库幂等、迁移、性能与跨层能力仅作对应 Case 的 `secondarySkills`。
- **failure isolation**：每 Case 新 database/case/device/facility/custodian/ports，fixed scans/seals/timestamps/UUIDs。OPERATE-01..03 每场景独立 formal seed；Case setup 互不依赖，hard cap 后置。Manager 未发布的 Aliquot transfer seam 由 SPEC-GAP gate 阻止 runner 猜测。

## 2. 计分 Case（22 个，100 分）

### CONTRACT-01 scanner batch ingest 的 sequence、wire 与错误边界 — 6 分

- **来源 / fixture / seam 动作**：README policy 1/invariant 4 与 batch route/shape/errors；同 device 提交 next/gap/duplicate sequence、空/上限成员、坏 facility/time/unknown keys，并读取 batch/scan 公开观察面。
- **独立 oracle / mandatory assertions / 禁止副作用**：status/body/error、IDs 与 lastBatchSequence 的公开语义 exact；合法 scans 全量可读，任一非法成员整批拒绝；不得留下 Scan/Match/Work/Event、推进 sequence 或回显 raw batch/token。
- **dimension / primarySkill / feedback / mutant**：`A` / `S06` / `BATCH_PUBLIC_CONTRACT` / `EC-M01`。

### CONTRACT-02 match proposal/confirm 与 conflict 公共主流程 — 6 分

- **来源 / fixture / seam 动作**：README policy 2–4 与 proposal/confirm/detail routes；构造 exact/mismatch seals、case-sensitive mismatch、current/stale Item/Scan revisions、missing/foreign IDs 和两个 proposed matches。
- **独立 oracle / mandatory assertions / 禁止副作用**：proposal/confirm/detail 的 status/shape/error exact，确认后 Item/Scan/Match/currentCustodian/verification Work 引用闭合；拒绝路径无 partial state；不得模糊 label、接受 stale revision 或返回私有 matching score。
- **dimension / primarySkill / feedback / mutant**：`A` / `S06` / `MATCH_PUBLIC_FLOW` / `EC-M03`。

### CONTRACT-03 Verification、V1 transfer/timeline 与 Match reversal 合同 — 6 分

- **来源 / fixture / seam 动作**：README policies 4–5、Verification/transfer/timeline/reverse routes；对 exact/mismatch seals 运行 Verification，按 current custodian 连续 V1 transfers，并覆盖 no-verification/no-transfer、有 transfer、有 verification 的 reverse。
- **独立 oracle / mandatory assertions / 禁止副作用**：published states/errors/timeline shape/sequence exact；accepted transfer priorTransferId chain，只有公开可逆条件全满足才恢复 Item/Scan并 fence Work；不得删 history、双 owner、逆时 transfer、已验证后 reverse 或调用 Aliquot transfer。
- **dimension / primarySkill / feedback / mutant**：`A` / `S06` / `CUSTODY_PUBLIC_STATE_MACHINE` / `EC-M05`。

### CONTRACT-04 Split create/reverse 的 quantity、wire 与 legacy 分流 — 6 分

- **来源 / fixture / seam 动作**：Manager rules 1/3/5 与 split/detail/reverse routes；对 VERIFIED parent 测 1/2/20/21 children、0/unsafe quantity、sum±1、duplicate IDs、stale revision，并 reverse 一个明确未发生 child transfer 的 split。
- **独立 oracle / mandatory assertions / 禁止副作用**：request/status/error、ItemSplit/Aliquot/detail 与 legacy singular-null 分流 exact；合法 split 全组出现，无 transfer reverse 原子恢复 parent；非法/冲突 snapshot 不变；不得部分 children/Work/Event 或发明 child transfer route。
- **dimension / primarySkill / feedback / mutant**：`A` / `S17` / `SPLIT_PUBLIC_CONTRACT` / `EC-M06`。

### CONTRACT-05 Match Group、child detail 与公开 lineage 观察面 — 6 分

- **来源 / fixture / seam 动作**：Manager rules 2–4 与 group/detail/list routes；覆盖缺/多/duplicate Aliquot、duplicate/stale/matched Scan、逆序合法 members，并查看每 child 的 verification/custody/timeline（不制造 child transfer）。
- **独立 oracle / mandatory assertions / 禁止副作用**：合法 group 直接 CONFIRMED、members 按 aliquotId，ItemSplitDetail/aliquotTimelines 与 legacy reads 的 published shape/order/IDs exact；失败全无；不得 partial group、混 parent/child timeline、N+1 私有探针或发明 Manager event。
- **dimension / primarySkill / secondarySkills / feedback / mutant**：`A` / `S17` / `S11` / `GROUP_LINEAGE_PUBLIC_CONTRACT` / `EC-M07`。

### DATA-01 batchSequence、canonical digest 与 durable replay 原子性 — 5 分

- **来源 / fixture / seam 动作**：README invariant 4/durable idempotency；独立 canonicalize 相同 batch，same sequence exact/semantic-different，response shield 后 20 路 two APIs/restart/changed key/body，并在最后 member 放非法引用。
- **独立 oracle / mandatory assertions / 禁止副作用**：独立 digest；exact replay 原 status/semantic JSON/IDs，同 key异义或同 sequence异 digest conflict；sequence gap/非法 member 整批零副作用；不得第二 batch/Scan/Work/Event 或 process-local replay。
- **dimension / primarySkill / secondarySkills / feedback / mutant**：`B` / `S06` / `S04,S05` / `BATCH_DURABLE_ATOMICITY` / `EC-M01`。

### DATA-02 deterministic matching、confirm CAS 与 custody contention — 5 分

- **来源 / fixture / seam 动作**：README invariants 1–3/policies 2–4；外部排序模型构造 matching ties，两个 APIs 对共享 Item/Scan 的 confirm/reverse/V1 transfer 及 Facility receiver 修改交错。
- **独立 oracle / mandatory assertions / 禁止副作用**：exact seal 优先且稳定 tie-break，Item/Scan 最多一个 active match，currentCustodian 取 confirm 时权威配置，V1 transfer 单一 owner/prior chain；CAS 败者全无；不得 double match/owner、查询序依赖或 deadlock residue。
- **dimension / primarySkill / feedback / mutant**：`B` / `S06` / `DETERMINISTIC_CUSTODY_CONTENTION` / `EC-M02`。

### DATA-03 split quantity、parent consumption 与 reversal 守恒 — 5 分

- **来源 / fixture / seam 动作**：Manager rules 1/3/5；BigInt boundary split、stale revision、并发 reverse 与 group confirm/parent V1 transfer，对无 child transfer fixture 完成 reverse。
- **独立 oracle / mandatory assertions / 禁止副作用**：children positive integers sum=immutable parent quantity，parent CONSUMED且 singular authority null；每 child 独立；合法 reverse 全组恢复/撤销，竞争败者零副作用；不得 partial children、quantity 漂移、parent/child 双 authority 或删除历史。
- **dimension / primarySkill / feedback / mutant**：`B` / `S17` / `SPLIT_AUTHORITY_CONSERVATION` / `EC-M06`。

### DATA-04 Group complete membership、shared Scan 与 Verification fanout 原子性 — 5 分

- **来源 / fixture / seam 动作**：Manager rules 2–4；两个 APIs 对共享 Aliquots/Scans 提交 incomplete/duplicate/stale 与两个分别合法的 groups，随后给各 child 制造 exact/mismatch seals。
- **独立 oracle / mandatory assertions / 禁止副作用**：每 active Aliquot exactly once、Scans distinct/current，恰一完整 group 全有或全无；所有 child/scan/custodian/Verification Work 同观察点出现且每 child 独立 terminal；不得 partial group、共享 Scan、父聚合 child 结果或 orphan Work。
- **dimension / primarySkill / feedback / mutant**：`B` / `S17` / `ATOMIC_GROUP_CONTENTION` / `EC-M07`。

### DATA-05 child transfer 后 reversal/timeline authority — 5 分

- **blockedBy**：`SPEC-GAP-EC-01`；Aliquot transfer 公开 seam 补齐前整 Case 不运行、不拆分重分或旁路读表。
- **来源 / fixture / seam 动作**：Manager rules 4–5/ItemSplitDetail；seam 补齐后，先 reverse 无 transfer split，再 transfer 一个 child 后 reverse，并让多个 children 交错 verify/quarantine/transfer 后读 detail。
- **独立 oracle / mandatory assertions / 禁止副作用**：任一 child transfer 后精确 `SPLIT_NOT_REVERSIBLE` 且全图不变；aliquotTimelines 跟 split.aliquots 顺序、每条 sequence contiguous，parent timeline 不混 child facts；不得删 history、混线、泄漏 token/path 或猜测 private transfer wire。
- **dimension / primarySkill / feedback / mutant**：`B` / `S06` / `CHILD_TRANSFER_REVERSAL_AUTHORITY` / `EC-M09`。

### RECOVERY-01 Verification claimed SIGKILL 与 seal evidence 收敛 — 5 分

- **来源 / fixture / seam 动作**：README EVIDENCE_VERIFICATION Work/lifecycle/claimed barrier；exact/mismatch seal 的 Work claimed 后 SIGKILL，lease expiry 后 replacements，并重复启动/空闲。
- **独立 oracle / mandatory assertions / 禁止副作用**：attempt/lease/terminal retention 可观察并排空；exact→VERIFIED、mismatch→QUARANTINED 各一次，observed label/seal/device sequence/scannedAt immutable；stale owner 无提交；不得改原 Scan、错判 seal、重复 timeline/event 或 daemon 空闲退出。
- **dimension / primarySkill / feedback / mutant**：`C` / `S07` / `VERIFICATION_CLAIM_RECOVERY` / `EC-M04`。

### RECOVERY-02 Group child Verification effect-complete 重试闭合 — 5 分

- **来源 / fixture / seam 动作**：Manager group creates one EVIDENCE_VERIFICATION Work per child；三 children 的 exact/mismatch effects 在 `worker.effect-complete` 后分别 SIGKILL/unknown completion，lease 后多 replacements。
- **独立 oracle / mandatory assertions / 禁止副作用**：每 child 的 Work/verification/timeline/event 恰一次，三者独立且 parent/group authority 不变，全部 terminal 后 backlog drained；不得把一个 child result 扩散全组、重复 effect、漏 child 或提前父 completion。
- **dimension / primarySkill / secondarySkills / feedback / mutant**：`C` / `S07` / `S17` / `CHILD_VERIFICATION_RECOVERY` / `EC-M08`。

### RECOVERY-03 Match/split reversal 与 stale Verification before-commit fence — 5 分

- **来源 / fixture / seam 动作**：README Work/barrier；在 claimed/effect-complete/before-commit 杀 Verification worker，同时 reverse V1 match 或未转移 split，lease 后替代；不调用缺失的 Aliquot transfer seam。
- **独立 oracle / mandatory assertions / 禁止副作用**：最终一种合法线性状态，Work terminal/取消对账，stale owner 无验证提交；不得 reverse 后 late verify、双 timeline/event 或修改 observed fields。
- **dimension / primarySkill / feedback / mutant**：`C` / `S07` / `VERIFICATION_RECOVERY` / `EC-M04`。

### RECOVERY-04 event unknown ACK 与 item sequence — 5 分

- **来源 / fixture / seam 动作**：README event/dispatcher barrier；receiver 完整收 body 后挂 ACK/SIGKILL，混合 batch/item/custody aggregates 恢复。
- **独立 oracle / mandatory assertions / 禁止副作用**：eventId 相同、解析后的 semantic JSON body 等价、aggregate sequence 连续，timeline committed sequence 与对应事实一致；不得把未发布的字节序列化当 oracle、发明 Manager event type、换 identity、乱序成功或泄漏 private path/token/raw batch。
- **dimension / primarySkill / feedback / mutant**：`C` / `S07` / `OUTBOX_TIMELINE_RECOVERY` / `EC-M05`。

### LAYER-01 V1 与 split/group OpenAPI/runtime exact surface — 4 分

- **来源 / fixture / seam 动作**：README exact wire/routes/errors、Manager split/group routes/shapes；对 batch/match/verification/V1 transfer/timeline 与 split/group/detail/reverse 同时读取 `/openapi.json` 和 runtime body。
- **独立 oracle / mandatory assertions / 禁止副作用**：method/path/request/response/nullability/error envelope 与冻结文本一致，legacy singular fields 与 split null/aliquots 分流正确；不得发明 Aliquot transfer route、Manager event type 或私有 lineage shape。
- **dimension / primarySkill / secondarySkills / feedback / mutant**：`D` / `S06` / `S15` / `CROSS_LAYER_API_CONTRACT` / `EC-M08`。

### LAYER-02 浏览器完成 V1 batch/match/verify/transfer/timeline — 4 分

- **来源 / fixture / seam 动作**：README real UI；Chromium 通过可见控件导入 scanner batch、确认/reverse match、观察 verify/quarantine、执行 V1 Item transfer 并浏览 timeline，refresh。
- **独立 oracle / mandatory assertions / 禁止副作用**：UI 的 observed evidence、custodian/prior chain、timeline sequence 与公开 HTTP/snapshot 一致；不得 mock/private API、修改 scan observation 或跳过 conflict/terminal state。
- **dimension / primarySkill / secondarySkills / feedback / mutant**：`D` / `S06` / `S15` / `CROSS_LAYER_V1_UI` / `EC-M05`。

### LAYER-03 浏览器完成 split/group/detail/untransferred reverse — 4 分

- **来源 / fixture / seam 动作**：Manager UI update 与已发布 routes；Chromium split verified parent、原子确认 complete group、查看 parent/child detail，并 reverse 一个明确未发生 child transfer 的 split；不调用 EC-01 缺失 seam。
- **独立 oracle / mandatory assertions / 禁止副作用**：UI/HTTP/snapshot 对 quantity、complete membership、parent consumed、child custody/verification 与 reverse 后无 active child authority 一致；不得展示伪造 child transfer、partial group 或改变 legacy body。
- **dimension / primarySkill / secondarySkills / feedback / mutant**：`D` / `S17` / `S15` / `CROSS_LAYER_LINEAGE_UI` / `EC-M07`。

### LAYER-04 FINAL snapshot 单时点 custody/lineage closure — 3 分

- **来源 / fixture / seam 动作**：README snapshot、Manager FINAL resources；并发 batch/match/V1 transfer/split/group 时抓 authenticated snapshot。
- **独立 oracle / mandatory assertions / 禁止副作用**：resources exact union/sort，Item/Scan/Match/V1 Transfer/Split/Aliquot/Group links 来自同一 asOf且敏感字段递归过滤；不得撕裂 links、泄漏 token/path 或要求未发布 child transfer。
- **dimension / primarySkill / feedback / mutant**：`D` / `S11` / `POINT_IN_TIME_LINEAGE_SNAPSHOT` / `EC-M10`。

### OPERATE-01 scanner batch ingest 正式负载 — 2.5 分

- **来源 / fixture / seam 动作**：README `scanner-batch-ingest`；64 concurrency、10s warm-up+60s measure、每 batch 20 scans、9 new+1 replay，结束后全量 snapshot。
- **独立 oracle / mandatory assertions / 禁止副作用**：≥100 complete responses/s、p95≤350ms、5xx=0，每十 requests 恰180 new scans、无 partial batch，batch/match/event/Work invariants 保持；不得缩放、改变 mix/sequence、只报吞吐或把失败当成功。
- **dimension / primarySkill / secondarySkills / feedback / mutant**：`E` / `S06` / `S14` / `PERFORMANCE_BATCH_INGEST` / `EC-M01`。

### OPERATE-02 custody timeline sustained read — 2.5 分

- **来源 / fixture / seam 动作**：README `custody-timeline-read`；64 clients、10s warm-up+60s measure、全有 timeline 的 items round-robin，结束后全量对账。
- **独立 oracle / mandatory assertions / 禁止副作用**：≥200 reads/s、p95≤180ms、5xx=0；exact Item/EvidenceTimelineItem、sequence contiguous、custodian chain与event links完整；不得返回 mixed snapshot、错 links、只报指标、缓存漏新事实或修改 custody。
- **dimension / primarySkill / secondarySkills / feedback / mutant**：`E` / `S11` / `S14` / `PERFORMANCE_TIMELINE_READ` / `EC-M05`。

### OPERATE-03 10,000 Verification recovery — 2.5 分

- **来源 / fixture / seam 动作**：README `verification-recovery`；两 claimed workers kill、lease 后两 replacements、60s，结束后全量对账。
- **独立 oracle / mandatory assertions / 禁止副作用**：10,000 exact-match items VERIFIED once、Work drain、custody exclusive、observations immutable、timeline/event terminal且0 stale/unexpected failure；不得缩小 backlog、抽样替代全量、重复 item update 或变 observed evidence。
- **dimension / primarySkill / secondarySkills / feedback / mutant**：`E` / `S07` / `S14` / `PERFORMANCE_VERIFICATION_BACKLOG` / `EC-M04`。

### OPERATE-04 V1 roots/groups、in-flight 与 seed 原子兼容 — 2.5 分

- **来源 / fixture / seam 动作**：Manager rules 7–10/13、README seed；冻结 V1 checkpoint 写入各 Item/Match state、pending/leased Verification、50-transfer chain、Event/replay 后升级两次；另跑 same/conflicting seed、invalid reference/chain/invariant fixtures。
- **独立 oracle / mandatory assertions / 禁止副作用**：旧 item 成 unsplit root且 Match 稳定映射一-member group，labels/custody/verification/Work lease/transfer chain/event/replay identity 不变；same seed no-op，conflict/invalid graph 整体拒绝；不得生成 Aliquot/Split、retarget Work、要求 Manager seed member 或留下部分 rows/Work/Event。
- **dimension / primarySkill / secondarySkills / feedback / mutant**：`E` / `S06` / `S02` / `V1_MIGRATION_SEED_COMPATIBILITY` / `EC-M10`。

## 3. Worked example：DATA-04

Parent quantity=10，split 为三 Aliquots（2/3/5）。准备四个 current Scans。先提交缺第三 child、重复第一 child、两个 children 共用一个 Scan、包含额外 Scan 四种 group 请求；每次失败后 snapshot 必须完全相同。合法请求即使 members 逆序，也必须一次返回 CONFIRMED Group，members 按 aliquotId 排序，三个 child/scan/custodian 与三个 Verification Work 在同一观察点同时出现。只检查 Group state 会漏掉 partial-confirm mutant。

## 4. Mutants（10 个）

| Mutant | 单一故障 | 必杀 Case |
| --- | --- | --- |
| EC-M01 | batch sequence/replay/业务 idempotency 非原子 | CONTRACT-01、DATA-01、OPERATE-01 |
| EC-M02 | matching 模糊 label/不稳定排序/复用成员 | DATA-02 |
| EC-M03 | confirm/transfer 无 revision/CAS，双 match/owner | CONTRACT-02、DATA-02 |
| EC-M04 | Verification 修改 scan/无 lease fence/重复终态 | RECOVERY-01/03、OPERATE-03 |
| EC-M05 | transfer/reversal/timeline 链断或 event retry 漂移 | CONTRACT-03、RECOVERY-04、LAYER-02、OPERATE-02 |
| EC-M06 | split quantity 用浮点/部分 child commit | CONTRACT-04、DATA-03 |
| EC-M07 | Match Group 接受 subset/duplicate Scan 或部分确认 | CONTRACT-05、DATA-04、LAYER-03 |
| EC-M08 | parent/child 状态混写、timeline 混线、UI lineage 假绿 | RECOVERY-02、LAYER-01/03 |
| EC-M09 | 任一 child transfer 后仍可 reverse/删除 history | DATA-05 |
| EC-M10 | migration 改 Match/Work/replay 或要求 Manager seed | LAYER-04、OPERATE-04 |

## 5. SPEC-GAP

- `SPEC-GAP-EC-01`（runner freeze blocker）：Manager 要求每个 Aliquot 有独立 transfer chain，但没有发布 Aliquot transfer endpoint，也未说明 V1 `/collected-items/:itemId/transfers` 是否接受 aliquotId。DATA-05 必须先补公开 seam；CONTRACT-01..05、DATA-01..04、RECOVERY-01..04 与 LAYER-01..04 已明确只用 V1 Item transfer 或未转移 split，不以旁路测试 child transfer。
- `SPEC-GAP-EC-02`：split reverse “removes active child custody”未说明 REVERSED Aliquot/Group 是保留为 immutable history、从 snapshot 移除还是增加 terminal state。Cases 只断言 parent 恢复、无 active child authority、历史不得被破坏；冻结 exact snapshot oracle 前需补形状。
- `SPEC-GAP-EC-03`：Manager 未发布新 Domain Event type，也未说明 Aliquot Verification 如何形成公开 timeline event；不得由 evaluator 私设名称。
- `SPEC-GAP-EC-04`：Manager 接口要求 split parent VERIFIED，与业务规则一致；但 group confirmation后 Verification Work 的 aggregateId/target shape未公开。V2 只经公开 child states/snapshot断言 effect，不读取 Work payload。

## 6. README → Case contract-map

| 合同 | Cases |
| --- | --- |
| batch/match/verification/transfer/split/group 公共合同 | CONTRACT-01..05 |
| batch/custody/split/group 不变量、幂等与并发 | DATA-01..05（05 受 SPEC-GAP） |
| Verification claimed/effect/reversal fence 与 outbox 恢复 | RECOVERY-01..04 |
| OpenAPI/runtime/UI/snapshot 跨层 | LAYER-01..04 |
| 三条 fixed performance 与逐场景 post-load | OPERATE-01..03 |
| V1 migration/in-flight/seed compatibility | OPERATE-04 |

## 7. 旧 H → V2 Case

| 旧 H | V2 Cases |
| --- | --- |
| H-01 | 共享 preflight（不计分）；领域 seed=OPERATE-04 |
| H-02 | CONTRACT-01..05、LAYER-01/04 |
| H-03 | CONTRACT-01..03 |
| H-04 | CONTRACT-01..05、DATA-01..04 |
| H-05 | DATA-01 |
| H-06 | DATA-02..04 |
| H-07 | RECOVERY-01..03 |
| H-08 | RECOVERY-04 |
| H-09 | OPERATE-04 |
| H-10 | CONTRACT-04/05、DATA-03..05、RECOVERY-02/03 |
| H-11 | DATA-02..04、RECOVERY-01..03、LAYER-01..04 |
| H-12 | OPERATE-01..03 |
| H-13 | 共享 preflight（不计分）；逐场景领域闭合 OPERATE-01..03 |

## 8. 评分

`A/CONTRACT 30 + B/DATA 25 + C/RECOVERY 20 + D/LAYER 15 + E/OPERATE 10 = 100`，共 **22 Case**。partial batch/group、double match/owner、observed evidence 改写、quantity 不守恒、非法 split reversal、幂等第二效果、stale Verification commit、迁移改 Match/Work/replay 适用领域 hard cap。primarySkill 仅 S06/S07/S11/S17；S03/S16 不作计分 primarySkill。
