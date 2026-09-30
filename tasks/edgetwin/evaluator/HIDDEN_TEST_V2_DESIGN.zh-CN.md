# EdgeTwin Hidden Test V2 设计

> 黑盒设计稿；不实现 runner。共享 install/build/migrate/boot/health preflight 不计分。设备认证、密钥轮换和固件签名明确 out of scope，因此本题不把 `S18` 作为 primarySkill 或隐藏要求。

## 1. 画像与隔离

- **两项主机制**：desired/reported 双版本与乱序 receipt 的确定性投影；Wave 冻结 fanout、健康暂停与 prior-firmware 补偿闭合。
- **五个 evidence family**：`CONTRACT`（公共接口与主流程）、`DATA`（不变量/幂等/并发）、`RECOVERY`（Work/dispatcher 持久恢复）、`LAYER`（OpenAPI/UI/snapshot）、`OPERATE`（迁移/性能）；对应 dimension A/B/C/D/E，权重 30/25/20/15/10。
- **核心 primarySkill**：`S04` database-owned-atomic-idempotency、`S07` durable-work-fenced-recovery、`S08` deterministic-projection-and-reconciliation、`S17` frozen-fanout-aggregate-closure；identity、ordered authority、迁移、snapshot、性能与跨层能力仅作对应 Case 的 `secondarySkills`。
- **isolation**：每 Case 新 tenant/database/device pool/ports，fixed merge patches、command bytes、receipt permutations；只用 public API/device poll/receiver/barrier/Chromium/snapshot。OPERATE-01..03 每条正式 seed 独立，hard cap 不重复扣分。

## 2. 计分 Case（22 个，100 分）

### CONTRACT-01 Shadow Merge Patch wire、限制与错误语义 — 6 分

- **来源 / fixture / seam 动作**：README invariants 1–2；测试 expected version current/stale/skipped、null delete、nested merge、危险键、深度 32/33、数组 1000/1001、64KiB 边界。
- **独立 oracle / mandatory assertions / 禁止副作用**：独立 RFC7396 模型计算结果/size；成功响应/读取 wire 与错误 envelope 符合公开合同，version 恰+1，非法/冲突原子不变；不得部分 patch、改 reportedVersion、创建 Command/Work/Event 或持久非有限数。
- **dimension / primarySkill / feedback / mutant**：`A` / `S08` / `MERGE_PATCH_PROJECTION` / `ET-M01`。

### CONTRACT-02 offline Command create/poll 与稳定 delivery wire — 6 分

- **来源 / fixture / seam 动作**：README invariants 3–4 与 command/poll/cancel routes；offline device 创建多 commands，修改输入对象/desired shadow，connect 后重复 poll 不同 limit，并在到期前安全余量内 cancel 一条。
- **独立 oracle / mandatory assertions / 禁止副作用**：create/poll/cancel 的 status/shape/error exact；按 `(createdAt,commandId)` 排 eligible，payload/desiredVersion/expiresAt/deliveryIdentity 冻结，重复 poll identity 不变；不得离线丢 command、从内存重建、返回跨 tenant/device command 或把 cancel 当 receipt。
- **dimension / primarySkill / secondarySkills / feedback / mutant**：`A` / `S08` / `S06` / `FROZEN_COMMAND_ORDER` / `ET-M02`。

### CONTRACT-03 receipt 双 identity、结果 wire 与 reported 观察面 — 6 分

- **来源 / fixture / seam 动作**：README invariants 5–6 与 receipt endpoint/read model；提交 current/stale baseVersion、matching/nonmatching deliveryIdentity，重复 receiptId/deviceSequence exact 与异内容，并读取 receipt/Shadow/Command。
- **独立 oracle / mandatory assertions / 禁止副作用**：各公开 status/error/body 与 identity conflict matrix exact；合法 receipt 可见且 reportedVersion 单调，stale receipt 仅为 evidence；不得要求未发布 `projectionStatus` wire、覆盖较新值或泄漏另一 device receipt。
- **dimension / primarySkill / feedback / mutant**：`A` / `S08` / `RECEIPT_PUBLIC_CONTRACT` / `ET-M04`。

### CONTRACT-04 Campaign target、控制与 firmware success 主流程 — 6 分

- **来源 / fixture / seam 动作**：README invariants 7–8 与 Campaign routes；创建含 duplicate/retired/cross-tenant devices 的 Campaign，执行 pause/resume/cancel，并提交 matching/nonmatching digest receipts。
- **独立 oracle / mandatory assertions / 禁止副作用**：合法 create/control/detail wire 与精确 errors；active devices 去重，只有 ACK+matching digest 显示 SUCCEEDED；不得 dispatch/connect/shadow 即成功、接受非法成员、伪装撤回已执行 command 或返回 Manager-only 字段。
- **dimension / primarySkill / feedback / mutant**：`A` / `S17` / `CAMPAIGN_PUBLIC_FLOW` / `ET-M05`。

### CONTRACT-05 DeploymentWave create/control/rollback 边界与 legacy wire — 6 分

- **来源 / fixture / seam 动作**：Manager create/control/rollback routes 与 legacy compatibility；测试重复 wave name、device 跨 wave、空 wave、observation 0/1/86400/86401、failure 0/100/101、跨 tenant，并跑合法 pause/resume/cancel/rollback。
- **独立 oracle / mandatory assertions / 禁止副作用**：合法 ordinal 从 0、每 device 恰一 wave，success/error exact，旧 Campaign wire 不被 wave 字段污染；非法整组拒绝；不得留部分 DeploymentWave/WaveDevice/Target/Work/Event 或发明 health/event 字段。
- **dimension / primarySkill / secondarySkills / feedback / mutant**：`A` / `S17` / `S01,S06` / `WAVE_PUBLIC_CONTRACT` / `ET-M06`。

### DATA-01 desired/reported CAS、receipt identity 与乱序投影 — 5 分

- **来源 / fixture / seam 动作**：README invariants 1/5/6 与 concurrency；两 API 争 expected desired version，同时打乱 deviceSequence，重复 receiptId/sequence exact 与异内容，交错 cancel/expiry。
- **独立 oracle / mandatory assertions / 禁止副作用**：`receiptId` 与 `(tenant,device,deviceSequence)` identity matrix、desired/reported versions 各自单调且每 authority/version 恰一 successor；非法/竞争失败零副作用；不得按 arrival order 投影、terminal 回退或 stale patch 覆盖新值。
- **dimension / primarySkill / secondarySkills / feedback / mutant**：`B` / `S08` / `S04,S05` / `DUAL_VERSION_RECONCILIATION` / `ET-M04`。

### DATA-02 patch/command/Campaign/Wave control 的 durable replay — 5 分

- **来源 / fixture / seam 动作**：README idempotency 与 Manager controls；response shield 后 20 路跨 API、restart、异 payload，覆盖 patch/command/create/pause/resume/rollback。
- **独立 oracle / mandatory assertions / 禁止副作用**：原 status/semantic JSON/IDs 精确 replay，业务/Work/Event 一效果，异语义 conflict；不得第二 version/command/target/wave transition 或跨 tenant/key 合并。
- **dimension / primarySkill / secondarySkills / feedback / mutant**：`B` / `S04` / `S05` / `DURABLE_IDEMPOTENCY` / `ET-M10`。

### DATA-03 frozen wave partition 与单 RUNNING 健康裁决 — 5 分

- **blockedBy**：`SPEC-GAP-ET-01`；健康公式/推进语义补齐前不得运行或重新归一化。
- **来源 / fixture / seam 动作**：Manager rules 1–3；创建 frozen partition 后改 device set，在算法补齐后构造 failure 比例边界、观察时间前后及 matching/nonmatching receipts。
- **独立 oracle / mandatory assertions / 禁止副作用**：members/target/prior firmware/params 不漂移，仅 matching firmware success，同 campaign 最多一个 RUNNING，并按公开 denominator/rounding/time 一次裁决；不得动态扩员、提前 advance 或并行运行下一 wave。
- **dimension / primarySkill / secondarySkills / feedback / mutant**：`B` / `S17` / `S06` / `FROZEN_WAVE_HEALTH` / `ET-M07`。

### DATA-04 pause/resume/cancel 与 terminal 成员闭合 — 5 分

- **来源 / fixture / seam 动作**：Manager rules 4/6；并发 pause/resume/cancel，含已 SUCCEEDED/FAILED、未终态 devices 及重复 control requests。
- **独立 oracle / mandatory assertions / 禁止副作用**：resume 仅继续未终态；cancel fences pending/undelivered 且不伪装撤回已执行 command，单一合法 aggregate state；不得 duplicate target/command、重置成功或 terminal 复活。
- **dimension / primarySkill / feedback / mutant**：`B` / `S17` / `WAVE_CONTROL_CLOSURE` / `ET-M08`。

### DATA-05 prior-firmware rollback affected-set 与唯一补偿 — 5 分

- **来源 / fixture / seam 动作**：Manager rule 5/rollback API；一部分 devices 成功、一部分失败/未确认，乱序重复 receipt 后并发 rollback。
- **独立 oracle / mandatory assertions / 禁止副作用**：affected set 仅已成功 devices，每 device 一冻结 prior firmware compensation target/command，重复收敛；不得 rollback 未成功者、用 current/latest prior 值、重复 target 或提前 ROLLED_BACK。
- **dimension / primarySkill / feedback / mutant**：`B` / `S17` / `FROZEN_WAVE_ROLLBACK` / `ET-M09`。

### RECOVERY-01 command dispatch/expiry 的 claimed 接管与 terminal fence — 5 分

- **来源 / fixture / seam 动作**：README invariants 3–4 与公开 `worker.claimed`；以公开 expiresAt 前后安全余量建 command fixtures，在 dispatch/expire claimed 后 SIGKILL，lease 后四 replacements，并与 poll/cancel/late receipt 交错。
- **独立 oracle / mandatory assertions / 禁止副作用**：数据库时间与 terminal commit 裁决；eligible command stable identity 一次投递，到期/cancel 后 replacement 或 stale owner 均不再投递，late receipt 仅保留 evidence；Work 最终排空；不得 terminal 反转、late delivery 或重复 event。
- **dimension / primarySkill / feedback / mutant**：`C` / `S07` / `COMMAND_WORK_RECOVERY` / `ET-M03`。

### RECOVERY-02 receipt project 的 SIGKILL、乱序重放与版本 fence — 5 分

- **来源 / fixture / seam 动作**：README receipt projection/Recovery 与 `worker.claimed`；对 shuffled/duplicate receipts 在 project claimed 后 SIGKILL，lease 后并行 replacements，再提交 stale/newer receipt。
- **独立 oracle / mandatory assertions / 禁止副作用**：immutable receipt facts 全保留、reportedVersion 确定性单调、每合法 base 一次 effect，Work terminal/attempt 可观察且 stale owner 无提交；不得按 arrival 重建、重复 patch 或覆盖较新 reported state。
- **dimension / primarySkill / feedback / mutant**：`C` / `S07` / `RECEIPT_PROJECT_RECOVERY` / `ET-M04`。

### RECOVERY-03 Campaign fanout、Wave advance 与补偿投递恢复 — 5 分

- **来源 / fixture / seam 动作**：README Recovery 明确公开的 `worker.claimed`、V1 `UPGRADE_FANOUT`/`COMMAND_DISPATCH` 与 Manager `DEPLOYMENT_WAVE_ADVANCE`；分别在 Campaign fanout、Wave advance、explicit rollback 已创建的补偿命令投递 claimed 点杀 worker，lease 后四 replacements；失败阈值裁决受 ET-01 gate 时只运行不依赖该公式的 pause/cancel/explicit rollback fixtures。
- **独立 oracle / mandatory assertions / 禁止副作用**：Work identity/attempt 可追踪并排空，每 device 一 target/command/compensation，frozen affected set 不漂移且 stale owner 无提交；不得 duplicate fanout、越 wave fence、重做终态成员或提前父闭合。
- **dimension / primarySkill / feedback / mutant**：`C` / `S07` / `EDGE_WORK_RECOVERY` / `ET-M03`。

### RECOVERY-04 event unknown ACK、稳定 body 与租户隔离 — 5 分

- **来源 / fixture / seam 动作**：README event/dispatcher；receiver 完整收 body 后挂 ACK/SIGKILL，混合多 devices/tenants 重试。
- **独立 oracle / mandatory assertions / 禁止副作用**：eventId/canonical body/aggregate sequence stable，多 aggregate 不互阻；不得换 identity/顺序、泄漏 deliveryIdentity/token/private endpoint/signing material 或跨 tenant payload。
- **dimension / primarySkill / feedback / mutant**：`C` / `S07` / `EVENT_RECOVERY_ISOLATION` / `ET-M02`。

### LAYER-01 V1 与 Wave OpenAPI/runtime exact wire — 4 分

- **来源 / fixture / seam 动作**：README HTTP/OpenAPI、Manager exact routes/shapes/errors；对 shadow、command、receipt、Campaign 与 DeploymentWave 的成功/错误请求同时读取 `/openapi.json` 和 runtime body。
- **独立 oracle / mandatory assertions / 禁止副作用**：method/path/request/response/nullability/error envelope 与冻结文本逐项一致，V1 wire 不被 Wave 字段污染；不得以候选自定义字段、debug route 或未发布 credential/signing 要求替代合同。
- **dimension / primarySkill / secondarySkills / feedback / mutant**：`D` / `S08` / `S15` / `CROSS_LAYER_API_CONTRACT` / `ET-M08`。

### LAYER-02 浏览器完成 V1 shadow/offline command/Campaign — 4 分

- **来源 / fixture / seam 动作**：README Production UI；Chromium 通过可见控件完成 desired patch、offline command、connect/poll/receipt、Campaign pause/resume/cancel 并 refresh。
- **独立 oracle / mandatory assertions / 禁止副作用**：UI 可见版本、command identity、expiry、target progress 与公开 HTTP/snapshot 一致；不得 mock、调用私有 API、跨 tenant 或显示 secret/private endpoint。
- **dimension / primarySkill / secondarySkills / feedback / mutant**：`D` / `S08` / `S15` / `CROSS_LAYER_V1_UI` / `ET-M02`。

### LAYER-03 浏览器完成 Wave 控制与 rollback lineage — 4 分

- **来源 / fixture / seam 动作**：Manager routes/UI update；Chromium 创建合法 Wave，执行 pause/resume/cancel/rollback，并查看 frozen members、prior firmware 与补偿 Target；不裁决受 ET-01 阻塞的健康公式。
- **独立 oracle / mandatory assertions / 禁止副作用**：UI/HTTP/snapshot 对 wave order、device state、唯一 compensation target 一致，refresh 后不丢状态；不得伪装撤回已执行 command、动态扩员或使用未发布 health 结果。
- **dimension / primarySkill / secondarySkills / feedback / mutant**：`D` / `S17` / `S15` / `CROSS_LAYER_WAVE_UI` / `ET-M09`。

### LAYER-04 FINAL snapshot 单时点 shadow/wave closure — 3 分

- **来源 / fixture / seam 动作**：README snapshot、Manager FINAL resources；并发 patch/receipt/Wave control 时反复抓 authenticated snapshot。
- **独立 oracle / mandatory assertions / 禁止副作用**：resources exact union/sort/tenant scope，Shadow/Command/Receipt/Target/WaveDevice links 来自同一 asOf；不得撕裂版本/链接、泄漏 secret/endpoint/signing material 或把 arrival order 当 authority。
- **dimension / primarySkill / secondarySkills / feedback / mutant**：`D` / `S08` / `S11` / `POINT_IN_TIME_EDGE_SNAPSHOT` / `ET-M10`。

### OPERATE-01 100,000 devices shadow patch ingest — 2.5 分

- **来源 / fixture / seam 动作**：README `shadow-patch-ingest`；64 clients、完整 desired/reported operation count，结束后抓独立 snapshot。
- **独立 oracle / mandatory assertions / 禁止副作用**：≥500 patch/s、p95≤300ms、5xx=0；versions contiguous、stored value 等于独立 deterministic replay，event/Work/tenant invariants 仍成立；不得缩放、共用错误 merge helper、只报吞吐或丢 conflict。
- **dimension / primarySkill / secondarySkills / feedback / mutant**：`E` / `S08` / `S14` / `PERFORMANCE_SHADOW` / `ET-M01`。

### OPERATE-02 50,000 offline command/expiry barrier — 2.5 分

- **来源 / fixture / seam 动作**：README `offline-command-expiry`；online/offline mix、two APIs、expiry around published poll barriers，结束后全量对账。
- **独立 oracle / mandatory assertions / 禁止副作用**：≥350 mutation/s、p95≤450ms，无 expired delivered、eligible command 一 logical delivery/stable identity，command/receipt/event/Work 全量一致；不得把 duplicate poll 算 duplicate effect、只报指标或在内存丢 offline queue。
- **dimension / primarySkill / secondarySkills / feedback / mutant**：`E` / `S07` / `S14` / `PERFORMANCE_COMMAND_EXPIRY` / `ET-M03`。

### OPERATE-03 10,000 fleet upgrade recovery — 2.5 分

- **来源 / fixture / seam 动作**：README `fleet-upgrade-recovery`；duplicate shuffled receipts、两 claimed workers kill、四 replacement、60s，结束后全量重算。
- **独立 oracle / mandatory assertions / 禁止副作用**：每 device 一 target/command、matching digest 才 success、Campaign aggregate/events/work terminal且 tenant 隔离；不得 false success、duplicate target、stale commit、抽样代替全量或提前父完成。
- **dimension / primarySkill / secondarySkills / feedback / mutant**：`E` / `S17` / `S14` / `PERFORMANCE_UPGRADE_BACKLOG` / `ET-M05`。

### OPERATE-04 V1 legacy wave、in-flight 与 seed 原子兼容 — 2.5 分

- **来源 / fixture / seam 动作**：Manager rule 8/legacy mapping、README exact seed；以冻结 V1 checkpoint 写入多 Campaign/Target/Command/Receipt/Work/Event/replay，升级两次；另跑 same seed、conflicting seed 及 dangling/cross-tenant refs、duplicate sequence、invalid terminal/expiry/target/digest fixtures。
- **独立 oracle / mandatory assertions / 禁止副作用**：每 Campaign 稳定映射一个 `legacy` wave且 target set/identity/history/replay/lease 不变；same seed no-op，conflict/invalid graph 整体拒绝；不得重新 project receipt、重发 expired command、要求 Manager seed字段或留下部分 rows/Work/Event。
- **dimension / primarySkill / secondarySkills / feedback / mutant**：`E` / `S08` / `S02` / `V1_MIGRATION_SEED_COMPATIBILITY` / `ET-M10`。

## 3. Worked example：DATA-01

Device reportedVersion=5。提交 sequence 7、baseVersion=5 的 receipt B（先到），再提交 sequence 6、baseVersion=5 的 receipt A。外部事实序/基版本 oracle 要求实现保留两个 immutable receipts，但只能让一个与当时 current base 相符的 patch推进 reportedVersion；另一个必须成为 stale evidence，不能覆盖较新值。随后 exact replay 两条均无第二 effect，复用 sequence 7 但改 body 必须 conflict。测试比较最终 JSON 与版本，而不是依赖候选未完整发布的 `projectionStatus` 字段。

## 4. Mutants（10 个）

| Mutant | 单一故障 | 必杀 Case |
| --- | --- | --- |
| ET-M01 | Merge Patch/limits/version CAS 错或测试复用实现 helper | CONTRACT-01、OPERATE-01 |
| ET-M02 | offline command 未冻结/跨 tenant 或 event 泄漏 identity | CONTRACT-02、RECOVERY-04、LAYER-02 |
| ET-M03 | expiry/poll 无 DB fence，stale worker 可 deliver | RECOVERY-01、OPERATE-02 |
| ET-M04 | receipt 只按 arrival/receiptId，reportedVersion 回退 | CONTRACT-03、DATA-01、RECOVERY-02 |
| ET-M05 | Campaign dispatch 即成功或 fanout 动态成员 | CONTRACT-04、OPERATE-03 |
| ET-M06 | wave partition不原子/legacy wave identity 每迁移改变 | CONTRACT-05、OPERATE-04 |
| ET-M07 | 多 RUNNING/失败阈值不暂停或父 aggregate 提前完成 | DATA-03、RECOVERY-03 |
| ET-M08 | resume 重做终态成员/cancel 伪装撤回/UI 状态漂移 | DATA-04、LAYER-01/03 |
| ET-M09 | rollback 使用 current firmware 或重复/扩张 affected set | DATA-05、RECOVERY-03、LAYER-03 |
| ET-M10 | process-local idem/迁移重放 receipt 或换 identity | DATA-02、LAYER-04、OPERATE-04 |

## 5. SPEC-GAP

- `SPEC-GAP-ET-01`（runner freeze blocker）：Manager 未定义 maximumFailurePercent 的 denominator、取整方式、观察期结束时 missing device 如何计数、成功 wave 何时/如何推进下一 wave。DATA-03 的健康裁决以及 RECOVERY-03 中依赖该裁决的推进路径只能在公开补齐算法后实现，evaluator 不得自行选择公式。
- `SPEC-GAP-ET-02`：Manager 要求 legacy DeploymentWave identity“确定性”，但未给 ID derivation。OPERATE-04 只断言重复 migration identity 稳定和 1:1 mapping，不要求某个私造 UUID。
- `SPEC-GAP-ET-03`：README 说 stale receipt 保留 `projectionStatus=STALE`，但公开 CommandReceipt shape/snapshot 未列该字段。CONTRACT-03/DATA-01 只断言 receipt 可见且无投影副作用，不要求未发布 wire 字段。
- `SPEC-GAP-ET-04`：device authentication、credential rotation、firmware signing 明确 out of scope。本题不能作为 S18 的充分 Learning 证据；若课程需要 S18，应由 IdentityMesh/补充题覆盖。

## 6. README → Case contract-map

| 合同 | Cases |
| --- | --- |
| 公共 shadow/command/receipt/Campaign/Wave 合同 | CONTRACT-01..05 |
| 核心不变量、幂等与 Wave 竞争闭合 | DATA-01..05（03 受 SPEC-GAP） |
| command/project/fanout/rollback Work 与 outbox 恢复 | RECOVERY-01..04 |
| OpenAPI/runtime/UI/snapshot 跨层 | LAYER-01..04 |
| 三条 fixed performance 与逐场景 post-load | OPERATE-01..03 |
| legacy migration/in-flight/seed compatibility | OPERATE-04 |

## 7. 旧 H → V2 Case

| 旧 H | V2 Cases |
| --- | --- |
| H-01 | 共享 preflight（不计分）；领域 seed=OPERATE-04 |
| H-02 | CONTRACT-01/03/05、LAYER-01/04 |
| H-03 | CONTRACT-01..04 |
| H-04 | CONTRACT-01..05、DATA-01 |
| H-05 | DATA-01/02 |
| H-06 | DATA-01/03/04/05 |
| H-07 | RECOVERY-01..03 |
| H-08 | RECOVERY-04 |
| H-09 | OPERATE-04 |
| H-10 | CONTRACT-05、DATA-03..05、RECOVERY-03 |
| H-11 | DATA-01、RECOVERY-01..03、LAYER-01..04 |
| H-12 | OPERATE-01..03 |
| H-13 | 共享 preflight（不计分）；逐场景领域闭合 OPERATE-01..03 |

## 8. 评分

`A/CONTRACT 30 + B/DATA 25 + C/RECOVERY 20 + D/LAYER 15 + E/OPERATE 10 = 100`，共 **22 Case**。version regression、expired delivery、receipt 重复投影、false firmware success、Wave 多权威/rollback 漂移、幂等第二效果、stale Work commit、迁移改 identity 适用领域 hard cap。primarySkill 仅 S04/S07/S08/S17；S03/S16/S18 不作为本题计分 primarySkill。
