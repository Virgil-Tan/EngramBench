# EntitlementHub Hidden Test V2 设计

> 黑盒设计，不实现 runner。共享 install/build/migrate/boot/health preflight 不计分。只使用 public HTTP/OpenAPI、provider double、receiver/barrier、SIGKILL、Chromium 与 point-in-time snapshot。

## 1. 画像与隔离

- **两项主机制**：冻结订阅条款/Grant interval 与单调 revocation fence；Pool seat capacity/version 的组织分配与撤权闭合。
- **五个 evidence family**：`CONTRACT`（公共接口与主流程）、`DATA`（不变量/幂等/并发）、`RECOVERY`（Work/dispatcher 持久恢复）、`LAYER`（OpenAPI/UI/snapshot）、`OPERATE`（迁移/性能）；对应 dimension A/B/C/D/E，权重 30/25/20/15/10。
- **核心 primarySkill**：`S05` replay-precedence-and-identity-scope、`S06` ordered-authority-and-frozen-membership、`S07` durable-work-fenced-recovery、`S10` immutable-ledger-correction；数据库幂等、迁移、snapshot、性能与跨层能力仅作对应 Case 的 `secondarySkills`。
- **failure isolation**：每 Case 新 database/tenant/plan family/subjects/provider script/ports；database time 相对 fixture 固定。OPERATE-01..03 每条独立 formal seed。Case 独立计分，hard cap 后置；禁止读 cache/表/源码。

## 2. 计分 Case（22 个，100 分）

### CONTRACT-01 Plan/Revision publish 与 trial/start 公共合同 — 6 分

- **来源 / fixture / seam 动作**：README lifecycle rule 1–2 与 plan/revision/subscription routes；覆盖 create/publish、unpublished/stale/missing revision、trial eligible/ineligible、unknown keys 与标量边界。
- **独立 oracle / mandatory assertions / 禁止副作用**：method/status/body/error exact，published revision 才可 start，返回 Subscription/period/Grant 引用闭合；拒绝路径无 Subscription/Grant/Audit/Work/Event；不得调用未发布 edit/retire/renew seam 或返回候选私有字段。
- **dimension / primarySkill / feedback / mutant**：`A` / `S06` / `PLAN_TRIAL_PUBLIC_CONTRACT` / `EH-M02`。

### CONTRACT-02 upgrade/downgrade/cancel 与 access-check 主流程 — 6 分

- **来源 / fixture / seam 动作**：README rules 2–4/7 与已发布 change/cancel/check routes；执行 immediate upgrade、scheduled downgrade、duplicate/stale change、cancel/admin expire 后 current/stale knownRevocationVersion check；不调用未发布 renewal/suspend/retire seam。
- **独立 oracle / mandatory assertions / 禁止副作用**：每 route 的 status/shape/error 与公开 transition exact，check 返回 entitlement/fence 的 published wire；非法 transition 零副作用；不得发明 proration amount、未发布 trigger 或让旧客户端依赖 Manager 字段。
- **dimension / primarySkill / feedback / mutant**：`A` / `S06` / `SUBSCRIPTION_ACCESS_PUBLIC_FLOW` / `EH-M03`。

### CONTRACT-03 Refund create/provider/reconcile 的公开状态机 — 6 分

- **来源 / fixture / seam 动作**：README rules 5–6 与 refund/provider callback/reconcile routes；覆盖 partial/full、UNKNOWN、duplicate/reordered callback、remainder±1、missing/terminal subscription 与 malformed provider identity。
- **独立 oracle / mandatory assertions / 禁止副作用**：create/result/reconcile 的 published status/body/error 和 allowed transitions exact，partial 与 full 的 access-visible outcome 分流；非法 callback 不留 ProviderEvent/Refund/Audit/Work/Event；不得暴露 provider token/private request。
- **dimension / primarySkill / feedback / mutant**：`A` / `S10` / `REFUND_PUBLIC_STATE_MACHINE` / `EH-M04`。

### CONTRACT-04 Pool create/assign/revoke/list 的 exact wire 与边界 — 6 分

- **来源 / fixture / seam 动作**：Manager rules 1–3/shapes/list API；对 V1/INDIVIDUAL/ORGANIZATION、feature missing、seatLimit±1、duplicate subject、stale/current expectedPoolVersion、cursor 边界运行 create/assign/revoke/list。
- **独立 oracle / mandatory assertions / 禁止副作用**：仅合法 ORGANIZATION current-period feature 可建；Pool/SeatAssignment exact shape/order/cursor/error，成功 version 恰+1；非法请求无 assignment/grant/fence/work/event；不得自动迁移 INDIVIDUAL 或遗漏 terminal history。
- **dimension / primarySkill / feedback / mutant**：`A` / `S06` / `POOL_PUBLIC_CONTRACT` / `EH-M06`。

### CONTRACT-05 Pool limit/revoke/expire 与 terminal history 主流程 — 6 分

- **来源 / fixture / seam 动作**：Manager rules 4–5 与 pool detail/list/seat routes；降低 feature limit，尝试新 assignment，逐席 revoke 恢复，再以公开 cancel/full refund/admin expire 终结组织订阅并读取 history。
- **独立 oracle / mandatory assertions / 禁止副作用**：OVER_LIMIT/ACTIVE/REVOKED/EXPIRED 的公开 transition、code、Pool version 与历史 shape exact；terminal 后拒绝新分配；不得随机驱逐、隐藏历史、从 terminal 复活或调用未发布 subject suspend/plan retire。
- **dimension / primarySkill / feedback / mutant**：`A` / `S06` / `POOL_TERMINAL_PUBLIC_FLOW` / `EH-M08`。

### DATA-01 trial uniqueness 与 current PlanRevision terms 冻结 — 5 分

- **来源 / fixture / seam 动作**：README rules 1–2；同 subject/planId 两 published revisions 跨两 API争 trial，terminal 后重试；订阅开始后 publish 新 revision 并读取历史/执行公开 change/refund/check。
- **独立 oracle / mandatory assertions / 禁止副作用**：plan family trial consumption 恰一，current period 固定 price/currency/features/limits/trial/grace/refundDays，后发 revision 不改历史 Grant/refund window/audit；败者零副作用；不得按 revision 重置 trial 或混用 terms。
- **dimension / primarySkill / secondarySkills / feedback / mutant**：`B` / `S06` / `S04` / `TRIAL_FROZEN_TERMS` / `EH-M01`。

### DATA-02 Grant interval、downgrade authority 与 revocation fence — 5 分

- **来源 / fixture / seam 动作**：README rules 3–4/7；立即 upgrade、多个 concurrent downgrade、cancel/provider callback 交错，并向两 API 发送 current/stale known fence 与倒序传播。
- **独立 oracle / mandatory assertions / 禁止副作用**：upgrade 同 database timestamp 关闭旧 Grant/开启新 Grant且 fence+1，仅最新 accepted downgrade 生效；所有 API 2s 内 fail-closed，旧传播不 re-enable；不得 gap/overlap、双 change、stale ENABLED 或 fence 回退。
- **dimension / primarySkill / feedback / mutant**：`B` / `S06` / `GRANT_REVOCATION_AUTHORITY` / `EH-M03`。

### DATA-03 Refund reservation、UNKNOWN 与 full-only revoke 守恒 — 5 分

- **来源 / fixture / seam 动作**：README rules 5–6；partial success、UNKNOWN、reordered provider events、reconcile、remainder±1 与 full refund 并发。
- **独立 oracle / mandatory assertions / 禁止副作用**：successful+unresolved reserved≤frozen charge；UNKNOWN 未解决前阻止超额，partial 保持 access，full 原子 REFUNDED+disable；不得超额、重复 provider result、partial 误撤权或 full 仍 allow。
- **dimension / primarySkill / feedback / mutant**：`B` / `S10` / `REFUND_ACCESS_CONSERVATION` / `EH-M04`。

### DATA-04 Pool version/capacity/subject uniqueness 与 OVER_LIMIT — 5 分

- **来源 / fixture / seam 动作**：Manager rules 2–4；填满 pool，duplicate subject/stale-current version/并发末 seat，再降低 limit、并发 assign/revoke 并显式恢复。
- **独立 oracle / mandatory assertions / 禁止副作用**：ACTIVE count≤seatLimit、同 pool subject 唯一、每成功 version 恰+1；降低后 OVER_LIMIT 且不任意驱逐，合法后才 ACTIVE；不得超售、version gap、隐藏超额或 partial assignment/grant/fence/event。
- **dimension / primarySkill / feedback / mutant**：`B` / `S06` / `POOL_CAPACITY_CONCURRENCY` / `EH-M07`。

### DATA-05 durable replay、provider precedence 与 terminal Pool 竞争 — 5 分

- **来源 / fixture / seam 动作**：README durable idempotency/ProviderEvent 与 Manager rule 3；response shield、20 路 two APIs/restart/changed body，覆盖 trial/refund/pool assign/revoke，并让 reordered callback 与 downgrade/cancel/seat revoke 竞争。
- **独立 oracle / mandatory assertions / 禁止副作用**：原 status/semantic JSON/IDs exact replay，按 request key/providerEventId/providerRequestId/resource version 收敛一个结果；Grant/Refund/Pool/fence 串行合法；不得重复 Audit/Work/Event/seat、arrival-order 双执行或 terminal access 复活。
- **dimension / primarySkill / secondarySkills / feedback / mutant**：`B` / `S05` / `S04` / `REPLAY_PRECEDENCE_CONTENTION` / `EH-M01`。

### RECOVERY-01 activate/change/expiry Work 的 claimed SIGKILL 接管 — 5 分

- **来源 / fixture / seam 动作**：README Work kinds 与公开 claimed barrier；在 SUBSCRIPTION_ACTIVATE/PLAN_CHANGE_APPLY/SUBSCRIPTION_EXPIRE claimed 后分别 SIGKILL，lease 后 replacements，并穿插 newer change/cancel。
- **独立 oracle / mandatory assertions / 禁止副作用**：Work attempt/lifecycle/retention 可观察并排空，Grant interval/fence 各一次，manual newer authority 使旧 Work 失效且 stale owner 无提交；不得 duplicate Grant、应用 stale pending change、terminal 复活或 daemon 空闲退出。
- **dimension / primarySkill / feedback / mutant**：`C` / `S07` / `PLAN_GRANT_WORK_RECOVERY` / `EH-M03`。

### RECOVERY-02 Refund UNKNOWN/reconcile 的 claimed 接管 — 5 分

- **来源 / fixture / seam 动作**：README REFUND_RECONCILE Work、provider double 与公开 claimed barrier；让 provider double 按固定脚本返回 UNKNOWN/最终结果，在 Worker claimed 后 SIGKILL，lease 后 replacements，并随后提交 duplicate/reordered callback。
- **独立 oracle / mandatory assertions / 禁止副作用**：同 providerRequestId/Refund identity 重试，successful/unresolved reservation 与最终 ledger 一次收敛，Work terminal/attempt retained；stale owner 无第二 refund/audit/fence；不得换 provider request、遗失 UNKNOWN 或超额。
- **dimension / primarySkill / feedback / mutant**：`C` / `S07` / `REFUND_RECONCILE_RECOVERY` / `EH-M04`。

### RECOVERY-03 Pool reconcile/revoke 的全席位闭合与 fencing — 5 分

- **来源 / fixture / seam 动作**：Manager POOL_RECONCILE/POOL_REVOKE 与 V1 ENTITLEMENT_REVOKE Work、公开 claimed barrier；满池在 downgrade/cancel/full refund/expire 时于 claimed 后 SIGKILL，lease 后 replacements，并发 seat assign/revoke。
- **独立 oracle / mandatory assertions / 禁止副作用**：Pool/seat Grant/fence/Work 事务闭合，全部 subjects fail-closed，replacement 排空且 stale owner 无提交；不得任意驱逐、漏 seat、重复 revoke/version 或 terminal Work 丢失。
- **dimension / primarySkill / feedback / mutant**：`C` / `S07` / `ENTITLEMENT_WORK_RECOVERY` / `EH-M09`。

### RECOVERY-04 outbox unknown ACK 与倒序撤权传播 — 5 分

- **来源 / fixture / seam 动作**：README event retry/revocation；receiver 完整 body 后挂 ACK并杀 dispatcher，把不同 fence 消息倒序重复送两 API。
- **独立 oracle / mandatory assertions / 禁止副作用**：eventId/body byte-identical、aggregate sequence 连续、fence 只增且 2s deny；不得新 event identity、旧 version re-enable、泄漏 provider token/private path。
- **dimension / primarySkill / feedback / mutant**：`C` / `S07` / `REVOCATION_OUTBOX_RECOVERY` / `EH-M05`。

### LAYER-01 V1 与 Pool OpenAPI/runtime exact surface — 4 分

- **来源 / fixture / seam 动作**：README exact shapes/routes/errors、Manager Pool routes/wire；对 plan/subscription/change/refund/check 与 pool/assignment mutations 同时读取 `/openapi.json` 和 runtime body。
- **独立 oracle / mandatory assertions / 禁止副作用**：method/path/request/response/nullability/error envelope 与冻结文本一致，旧 INDIVIDUAL response 不被未发布字段污染；不得要求 EH-01 未补齐的 subscriptionKind response 或调用 EH-04 未发布 routes。
- **dimension / primarySkill / secondarySkills / feedback / mutant**：`D` / `S05` / `S15` / `CROSS_LAYER_API_CONTRACT` / `EH-M06`。

### LAYER-02 浏览器完成个人 trial/change/refund/check — 4 分

- **来源 / fixture / seam 动作**：README production UI；Chromium 通过可见控件 publish plan、start trial、upgrade/downgrade、cancel、refund/reconcile、check entitlement 与审计，refresh。
- **独立 oracle / mandatory assertions / 禁止副作用**：UI 的 PlanRevision、Grant interval、refund、access/fence 与公开 HTTP/snapshot 一致；不得 mock/private API、显示 provider credential 或绕过 stale fence。
- **dimension / primarySkill / secondarySkills / feedback / mutant**：`D` / `S06` / `S15` / `CROSS_LAYER_INDIVIDUAL_UI` / `EH-M03`。

### LAYER-03 浏览器完成组织 Pool/seat/over-limit/revoke — 4 分

- **来源 / fixture / seam 动作**：Manager UI update/routes；Chromium 创建组织订阅与 Pool，分配至容量、触发 downgrade OVER_LIMIT、显式 revoke 并终止 subscription，refresh。
- **独立 oracle / mandatory assertions / 禁止副作用**：UI/HTTP/snapshot 对 Pool version/state、SeatAssignment history、capacity 与 fail-closed access 一致；不得自动驱逐、超售、mock 或只撤 owner。
- **dimension / primarySkill / secondarySkills / feedback / mutant**：`D` / `S06` / `S15` / `CROSS_LAYER_POOL_UI` / `EH-M08`。

### LAYER-04 FINAL snapshot 单时点 Subscription/Pool closure — 3 分

- **来源 / fixture / seam 动作**：README snapshot、Manager FINAL resources；并发 provider event/refund/plan change/pool mutation 时抓 authenticated snapshot并同步 check。
- **独立 oracle / mandatory assertions / 禁止副作用**：V1 resources 与 pools/seats exact union/sort，Subscription/Grant/Refund/fence/Pool/Seat 来自同一观察点；不得撕裂 access decision、泄漏 provider/cache/env 或返回未发布 keys。
- **dimension / primarySkill / secondarySkills / feedback / mutant**：`D` / `S05` / `S11` / `POINT_IN_TIME_ENTITLEMENT_SNAPSHOT` / `EH-M10`。

### OPERATE-01 100,000 subjects entitlement decisions — 2.5 分

- **来源 / fixture / seam 动作**：README `entitlement-decision-read`；128 clients、60s、80% enabled/20% disabled-stale fence，结束后全量 snapshot。
- **独立 oracle / mandatory assertions / 禁止副作用**：≥1,500 check/s、p95≤100ms、stale allow/5xx=0，exact EntitlementView，fence/tenant/audit/event/Work invariant 保持；不得缩放/mix 漂移、只报吞吐或以 cache 绕 fence。
- **dimension / primarySkill / secondarySkills / feedback / mutant**：`E` / `S06` / `S14` / `PERFORMANCE_ACCESS_READ` / `EH-M05`。

### OPERATE-02 20,000 upgrade/refund lifecycle race — 2.5 分

- **来源 / fixture / seam 动作**：README `upgrade-refund-race`；two APIs、64 concurrency、完整 plan-change/cancel/refund operation count，结束后全量对账。
- **独立 oracle / mandatory assertions / 禁止副作用**：≥100 mutation/s、p95≤750ms，无 grant overlap/excess refund/duplicate trial/version regression，period/fence/audit/event一致；不得稀释业务 mix、按未发布 proration 公式判分或只测 HTTP 200。
- **dimension / primarySkill / secondarySkills / feedback / mutant**：`E` / `S10` / `S14` / `PERFORMANCE_LIFECYCLE` / `EH-M04`。

### OPERATE-03 50,000 expiry/revocation recovery — 2.5 分

- **来源 / fixture / seam 动作**：README `expiry-revocation-recovery`；两 claimed workers kill、lease 后四 replacements、90s，结束后全量对账。
- **独立 oracle / mandatory assertions / 禁止副作用**：Work 全排空，所有 expired subjects 在每 commit 后 2s 内所有 API deny，Pool/Seat/fence/event一致；不得 stale commit、漏 subject、抽样替代全量、旧 fence allow 或提前停 worker。
- **dimension / primarySkill / secondarySkills / feedback / mutant**：`E` / `S07` / `S14` / `PERFORMANCE_REVOCATION_BACKLOG` / `EH-M09`。

### OPERATE-04 V1 individual、in-flight 与 seed 原子兼容 — 2.5 分

- **来源 / fixture / seam 动作**：Manager rules 1/6、README seed；冻结 V1 checkpoint 写入多 Subscription/Grant/Refund/pending change/Work/Event/replay 后升级两次；另跑 same/conflicting seed、unknown member 与 invalid reference fixtures。
- **独立 oracle / mandatory assertions / 禁止副作用**：V1/omitted kind 仍按 INDIVIDUAL 解释且 wire/replay/IDs/period/terms/grants/fence/UNKNOWN identity/lease 不变，pools/seats 为空；same seed no-op，conflict/invalid graph 整体拒绝；不得自动 Pool、重新 call provider、重置 fence 或留下部分 rows/Work/Event。
- **dimension / primarySkill / secondarySkills / feedback / mutant**：`E` / `S06` / `S02` / `V1_MIGRATION_SEED_COMPATIBILITY` / `EH-M10`。

## 3. Worked example：DATA-04

Pool seatLimit=5 且有 5 个 ACTIVE subjects。downgrade 把对应 feature limit 改为 3 后，oracle 要求 Pool seatLimit=3/state=OVER_LIMIT，但五个 seats 均保持 ACTIVE，且第六个分配被 `POOL_OVER_LIMIT` 拒绝。显式 revoke 两个 seats 时 version 每次+1；ACTIVE count=3 后 Pool 回 ACTIVE。任何“自动踢掉任意两人”的实现即使容量最终合法也失败。

## 4. Mutants（10 个）

| Mutant | 单一故障 | 必杀 Case |
| --- | --- | --- |
| EH-M01 | trial/idempotency process-local，跨 revision/进程双订阅 | DATA-01/05 |
| EH-M02 | period 使用最新 PlanRevision/terms | CONTRACT-01、DATA-01 |
| EH-M03 | upgrade grants overlap/gap 或 downgrade 多个 pending 生效 | CONTRACT-02、DATA-02、RECOVERY-01、LAYER-02 |
| EH-M04 | UNKNOWN/provider replay 不 reserve 或 full/partial 撤权错 | CONTRACT-03、DATA-03/05、RECOVERY-02 |
| EH-M05 | revocation fence 回退/cache stale allow | DATA-02、RECOVERY-04、OPERATE-01 |
| EH-M06 | INDIVIDUAL 可建 Pool/Pool wire/UI shape 错 | CONTRACT-04、LAYER-01/03 |
| EH-M07 | pool version/capacity 非原子导致最后 seat 超售 | DATA-04 |
| EH-M08 | limit 降低随机驱逐或 OVER_LIMIT 错误恢复 | CONTRACT-05、DATA-04、LAYER-03 |
| EH-M09 | subscription revoke 漏 seats/Pool Work 无 fence | RECOVERY-03、OPERATE-03 |
| EH-M10 | migration 自动建 Pool/改 UNKNOWN reserve/replay | LAYER-04、OPERATE-04 |

## 5. SPEC-GAP

- `SPEC-GAP-EH-01`：Manager 只给创建请求新增 `subscriptionKind`，但没有更新 exact Subscription response/snapshot shape 来表明 INDIVIDUAL/ORGANIZATION。CONTRACT-04 通过后续 Pool creation authority 区分，不要求候选返回未发布字段；应在冻结 runner 前补 wire。
- `SPEC-GAP-EH-02`：Manager 没有发布 Pool/Seat 对应 Domain Event type；不得私设名称，只验证 V1 event history 与撤权语义。
- `SPEC-GAP-EH-03`：Manager 说 upgrade/downgrade 调整 Pool seatLimit，但未说明同一 Subscription/feature 是否最多一个 Pool。V2 不额外施加唯一性；每个已公开 Pool 独立满足容量/状态合同。
- `SPEC-GAP-EH-04`：README rule 2/7 提到 renewal、subject suspension 与 PlanRevision retirement/edit，但 Public HTTP surface 没有对应 mutation/trigger。CONTRACT-01/02/05 与 DATA-02 不调用这些动作，也不把它们计分；补公开 seam 后再另行解除缺口。
- `SPEC-GAP-EH-05`：README 只说 deterministic integer proration，未给 day-count、公式与 rounding。CONTRACT-02、DATA-02 与 OPERATE-02 不裁精确 proration amount，只验证 Grant interval、PlanChange authority、fence 与已发布守恒；精确金额在合同补齐前不得计分。

## 6. README → Case contract-map

| 合同 | Cases |
| --- | --- |
| Plan/Subscription/Refund/Pool 公共接口与主流程 | CONTRACT-01..05 |
| trial/Grant/refund/Pool 不变量、幂等与并发 | DATA-01..05 |
| Plan/Refund/Pool Work 与撤权 outbox 恢复 | RECOVERY-01..04 |
| OpenAPI/runtime/UI/snapshot 跨层 | LAYER-01..04 |
| 三条 fixed performance 与逐场景 post-load | OPERATE-01..03 |
| V1 migration/in-flight/seed compatibility | OPERATE-04 |

## 7. 旧 H → V2 Case

| 旧 H | V2 Cases |
| --- | --- |
| H-01 | 共享 preflight（不计分）；领域 seed=OPERATE-04 |
| H-02 | CONTRACT-01..05、LAYER-01/04 |
| H-03 | CONTRACT-01..03、DATA-01..03 |
| H-04 | CONTRACT-01/03/04、DATA-01/03/04 |
| H-05 | DATA-01/03/05 |
| H-06 | DATA-02/04/05 |
| H-07 | RECOVERY-01..03 |
| H-08 | RECOVERY-04 |
| H-09 | OPERATE-04 |
| H-10 | CONTRACT-04/05、DATA-04/05、RECOVERY-03 |
| H-11 | DATA-02/04/05、RECOVERY-01..03、LAYER-01..04 |
| H-12 | OPERATE-01..03 |
| H-13 | 共享 preflight（不计分）；逐场景领域闭合 OPERATE-01..03 |

## 8. 评分

`A/CONTRACT 30 + B/DATA 25 + C/RECOVERY 20 + D/LAYER 15 + E/OPERATE 10 = 100`，共 **22 Case**。重复 trial、refund 超额、grant overlap、revocation 后 allow、Pool 超售/terminal 复活、幂等第二效果、stale Work commit、迁移自动建 Pool/改 replay 适用领域 hard cap。primarySkill 仅 S05/S06/S07/S10；S03/S16 不作计分 primarySkill。
