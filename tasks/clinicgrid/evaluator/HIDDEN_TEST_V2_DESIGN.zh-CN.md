# ClinicGrid Hidden Test V2 设计

> 本文只定义领域黑盒 Case。共享 install/build/migrate/boot/health preflight 不计分。计分权威仅为 README、CONTEXT 与固定 Manager 消息；旧 E2E 只用于旧 H 追溯，不产生 expected value；不读取候选内部日历表或锁实现。

## 1. 画像、seam 与 isolation

- **两项主机制**：多资源半开区间的全有或全无占用；CarePlan 冻结多 visit、聚合状态与逐成员恢复闭合。
- **领域 family**：`SLOT`、`PLAN`、`RACE`、`MIGRATE`、`LOAD` 只用于业务定位；评分以每个 Case 的显式 A–E dimension 为准。
- **核心 primarySkill（4 个）**：`S06` ordered-authority-and-frozen-membership、`S17` frozen-fanout-aggregate-closure、`S04` database-owned-atomic-idempotency、`S07` durable-work-fenced-recovery；兼容、性能与跨层验收只列为 `secondarySkills`。
- **seam/isolation**：HTTP/OpenAPI、数据库时间响应、receiver/barrier、SIGKILL、Chromium、verification snapshot；每 Case 独立库/端口/seed，固定 UTC interval 与 UUID。LOAD 各自新库；一个 Case 的 setup 失败不污染其他 Case，hard cap 不重复计分。

## 2. 计分 Case（22 个，100 分）

### SLOT-01 半开区间与 15 分钟对齐边界 — 6 分

- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture / seam 动作**：README policy 1；创建相邻 `[10:00,10:30)`/`[10:30,11:00)`、重叠 1ms、未对齐、duration 不符的 Appointment。
- **独立 oracle / mandatory assertions / 禁止副作用**：外部 interval 模型接受相邻、拒绝 overlap/shape；合法状态与 expiresAt 精确，非法错误稳定；不得占用任何 Clinician/Room/Equipment、创建 Work/Event。
- **primarySkill / feedback / mutant**：`S06` / `HALF_OPEN_INTERVAL` / `CG-M01`。

### SLOT-02 Clinician/Room/Equipment 确定性选择 — 6 分

- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture / seam 动作**：README policy 2；准备同优先级与不同优先级可用 Room/Equipment，创建同一 slot 多次于隔离 fixture。
- **独立 oracle / mandatory assertions / 禁止副作用**：按 requested Clinician、priority asc、ID asc 独立排序并核对完整 interval；不得随机选、只检查起点、重复 equipment type 或跨 appointment 漂移。
- **primarySkill / feedback / mutant**：`S06` / `RESOURCE_ORDER` / `CG-M02`。

### SLOT-03 多资源 hold 全有或全无 — 5 分

- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture / seam 动作**：README invariants 1–2；让最后一个 Equipment 不可用，并同时观察其他资源的可用性。
- **独立 oracle / mandatory assertions / 禁止副作用**：失败前后 snapshot/calendar 差为空，精确 `SLOT_UNAVAILABLE`；不得留下 Appointment、部分 resource assignment、expiry Work、Audit/Event 或幽灵占用。
- **primarySkill / feedback / mutant**：`S06` / `ATOMIC_MULTI_RESOURCE_HOLD` / `CG-M03`。

### SLOT-04 120 秒 expiresAt 与 confirm 安全边界 — 6 分

- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture / seam 动作**：README policy 3；记录公开 expiresAt，在至少 2 秒安全余量的边界前、边界后 confirm，并运行 expiry。
- **独立 oracle / mandatory assertions / 禁止副作用**：公开 expiresAt 与创建 transaction timestamp 相差 120 秒；安全余量内仅严格早于可 CONFIRMED，之后 EXPIRED 唯一胜出且资源释放一次；不得用进程 timer、复活或双释放。公开 seam 无法稳定命中恰好 expiresAt，等点 blockedBy: `SPEC-GAP-CG-03`。
- **primarySkill / feedback / mutant**：`S06` / `EXPIRY_AUTHORITY` / `CG-M04`。

### SLOT-05 Waitlist head blocking 与最早可行 slot — 6 分

- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture / seam 动作**：README policy 4/invariant 4；构造高优先级不可行 head 与低优先级可行项，随后开放 head 的第二早 slot。
- **独立 oracle / mandatory assertions / 禁止副作用**：按 priority desc/joinedAt/id 和 slot/resource order 重算；head 不可行时后项不绕过，开放后恰一最早 slot；不得跳队、重复 Appointment 或改 joinedAt。
- **primarySkill / feedback / mutant**：`S06` / `HEAD_BLOCKING` / `CG-M05`。

### PLAN-01 2–12 visits 冻结与全组原子 hold — 5 分

- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture / seam 动作**：Manager 规则 1–2、POST care-plans；测试 1/2/12/13 visits，并使第 12 个资源冲突。
- **独立 oracle / mandatory assertions / 禁止副作用**：合法请求保留输入 visitIndex 顺序且所有 Appointment 同时 HELD；任一不可用返回 `CARE_PLAN_UNAVAILABLE`；不得留 CarePlan、任何 visit/assignment/Work/Event。
- **primarySkill / feedback / mutant**：`S17` / `ATOMIC_CARE_PLAN` / `CG-M06`。

### PLAN-02 aggregate state 与 earliest expiresAt — 5 分

- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture / seam 动作**：Manager 规则 3–4；一次原子创建多个 visits，核对每个成员持有自己的 expiresAt 字段，再逐一 confirm；不构造合同无法产生的不同 commit expiry。
- **独立 oracle / mandatory assertions / 禁止副作用**：按成员 states 重算 HELD→PARTIALLY_CONFIRMED→CONFIRMED；仍有 HELD 时 CarePlan.expiresAt 等于这些公开成员 expiresAt 的最小值，最后为 null；不得缓存旧 aggregate 或改成员资源。
- **primarySkill / feedback / mutant**：`S17` / `CARE_PLAN_AGGREGATE` / `CG-M07`。

### PLAN-03 per-visit confirm 保留其他 visit 权威 — 5 分

- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture / seam 动作**：Manager confirm 接口/规则 5；乱序 confirm visitIndex，含相同 replay、非法 index 与已终态访问。
- **独立 oracle / mandatory assertions / 禁止副作用**：只目标 HELD→CONFIRMED，其他成员 identity/resources/expiresAt 不变，聚合/sequence 恰一次；不得批量 confirm、换 visit order 或重复 event。
- **primarySkill / feedback / mutant**：`S17` / `MEMBER_TRANSITION` / `CG-M07`。

### PLAN-04 一 visit cancel/expire 的终止扇出 — 5 分

- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture / seam 动作**：Manager 规则 5；CarePlan 含 CONFIRMED+多个 HELD，分别 cancel/expire 一个 HELD 并与 confirm 竞争。
- **独立 oracle / mandatory assertions / 禁止副作用**：TERMINATED；已 CONFIRMED 保留，所有其他 HELD→CANCELLED、相关资源各释放一次、expiresAt null；不得取消 confirmed、漏成员、重复释放或 partial aggregate。
- **primarySkill / feedback / mutant**：`S17` / `TERMINATION_FANOUT` / `CG-M08`。

### PLAN-05 multi-visit Waitlist 的 UI/Work/snapshot 闭环 — 4 分

- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture / seam 动作**：Manager 规则 6、OpenAPI/UI/snapshot；在 Chromium 创建 multi-visit Waitlist，让每 visit 单独可行但组合冲突，再开放完整组合并观察异步 Work。
- **独立 oracle / mandatory assertions / 禁止副作用**：OpenAPI/live/UI/Work/snapshot 一致；queue head 只在所有 visits 可共同 hold 时一次生成/链接一个 CarePlan，按 visitIndex 取各自最早 slot；不得 partial Appointment、拆成多个队列项、绕过 head或由前端伪造 promotion。
- **primarySkill / secondarySkills / feedback / mutant**：`S17` / `S15` / `MULTI_VISIT_PROMOTION` / `CG-M06`。

### RACE-01 hold/confirm/terminate 的 durable response replay — 5 分

- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture / seam 动作**：README durable idempotency 与 Manager mutations；response shield commit 后断开，20 路跨 API replay/重启/异 payload。
- **独立 oracle / mandatory assertions / 禁止副作用**：保存 status/semantic JSON、Appointment/CarePlan identity 与 sequence 为 oracle；一次业务/Work/Event；不得第二 hold、第二释放、重复 aggregate transition。
- **primarySkill / feedback / mutant**：`S04` / `DURABLE_IDEMPOTENCY` / `CG-M09`。

### RACE-02 热 slot 竞争的 HTTP/UI/calendar 跨层一致性 — 4 分

- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture / seam 动作**：README invariants 1–2、concurrency 与 UI/calendar；两个 API、10 patients 同时争同一完整 resource bundle，并交错邻接 slot，随后经 Chromium 与公开 calendars 检查。
- **独立 oracle / mandatory assertions / 禁止副作用**：live response/OpenAPI、UI、patient/coordinator calendars 与 snapshot 同时证明每冲突 interval 恰一 HELD、邻接可并存、所有资源无 overlap；不得死锁残留、零/多赢家、前端幽灵 hold 或 active allocations 超完整 bundle。
- **primarySkill / secondarySkills / feedback / mutant**：`S06` / `S15` / `RESOURCE_CONTENTION` / `CG-M03`。

### RACE-03 expiry/confirm/plan termination 的 lease fence — 5 分

- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture / seam 动作**：README barrier/Work、Manager rule 5；worker claimed 后 SIGKILL，同时 confirm/terminate，lease 后 replacement。
- **独立 oracle / mandatory assertions / 禁止副作用**：最终为一条合法线性状态，CarePlan/member/resources 全部对账，Work drain；不得 stale worker 提交、confirmed 变 cancelled/expired、重复 release。
- **primarySkill / feedback / mutant**：`S07` / `EXPIRY_RECOVERY` / `CG-M04`。

### RACE-04 outbox unknown ACK 的 Appointment/CarePlan 顺序 — 5 分

- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture / seam 动作**：README events/dispatcher barrier；receiver 收完整 event 后挂 ACK，杀 dispatcher，replacement 重试多 aggregate。
- **独立 oracle / mandatory assertions / 禁止副作用**：解析后的 eventId、type、semantic JSON 与 aggregate sequence；eventId/semantic body 稳定且各 aggregate 顺序连续；不得要求未发布的 JSON 字节序、发明 CarePlan event type、换 identity 或泄漏 token/private path。
- **primarySkill / feedback / mutant**：`S07` / `OUTBOX_RECOVERY` / `CG-M10`。

### MIGRATE-01 V1 Appointment standalone/replay 精确兼容 — 2.5 分

- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture / seam 动作**：Manager 规则 7–8；V1 建立 HELD/CONFIRMED/CANCELLED/EXPIRED 与 saved replay，再 FINAL migration。
- **独立 oracle / mandatory assertions / 禁止副作用**：每个旧 Appointment `carePlanId=null`，V1 response/replay body 与接口精确不变；不得自动建 CarePlan、增 Manager 字段到旧 body 或换 identity。
- **primarySkill / secondarySkills / feedback / mutant**：`S06` / `S02` / `V1_WIRE_MIGRATION` / `CG-M09`。

### MIGRATE-02 assignment、expiry、event 与 Work 原值保留 — 2.5 分

- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture / seam 动作**：Manager 规则 9/14；迁移含 pending/leased expiry、waitlist promotion、历史 resource assignments/events。
- **独立 oracle / mandatory assertions / 禁止副作用**：前后 IDs、resource order、expiresAt、work lease/attempt、event identity/body/sequence 一致，恢复按原 deadline；不得重排、续期、重复 promotion 或 stale commit。
- **primarySkill / secondarySkills / feedback / mutant**：`S07` / `S02` / `INFLIGHT_MIGRATION` / `CG-M09`。

### MIGRATE-03 V1 领域 seed 与在线 migration availability — 6 分

- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture / seam 动作**：README「Seed contract」与 Manager 规则 10；导入合法全资源、同 version+digest replay、异 digest、断引用、resource overlap/priority/state 不变量错误，再在合法大库持续 availability reads 并执行 FINAL migration。
- **独立 oracle / mandatory assertions / 禁止副作用**：合法 seed 完整，replay no-op，冲突精确 `SEED_VERSION_CONFLICT`，任一坏 member 对业务/Work/Event/幂等零影响；migration 期间公开 availability p95≤500ms 且响应正确。每条 statement 的 access-exclusive lock≤2s 无公开 statement 边界，blockedBy: `SPEC-GAP-CG-02`，不得用请求 stall 冒充锁类型证明。
- **primarySkill / secondarySkills / feedback / mutant**：`S06` / `S02` / `SEED_AND_ONLINE_MIGRATION` / `CG-M09`。

### MIGRATE-04 OpenAPI/UI/snapshot 新旧流程闭合 — 4 分

- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture / seam 动作**：Manager wire/API/snapshot/UI；Chromium 完成 standalone Appointment 与 CarePlan/Waitlist 流程并 refresh。
- **独立 oracle / mandatory assertions / 禁止副作用**：OpenAPI/runtime exact shape、snapshot exact union/sort、UI aggregate/member/resources 相互一致；不得使用 mock/私有 API、改变 V1 controls 或展示不可能 aggregate。
- **primarySkill / secondarySkills / feedback / mutant**：`S17` / `S02,S15` / `CROSS_LAYER_COMPATIBILITY` / `CG-M07`。

### LOAD-01 availability-read 正式持续负载 — 2.5 分

- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture / seam 动作**：README `availability-read`；固定 seed、64 clients、10s warm-up+60s measure，完整 24h half-open ranges。
- **独立 oracle / mandatory assertions / 禁止副作用**：≥200 response/s、p95≤180ms、0 unexpected 5xx；slot 顺序/资源 exclusivity 正确；不得缩放、预计算错误 calendar 或把非 200 计成功。
- **primarySkill / secondarySkills / feedback / mutant**：`S06` / `S14` / `PERFORMANCE_AVAILABILITY` / `CG-M02`。

### LOAD-02 180 热 slot×10 contenders — 2.5 分

- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture / seam 动作**：README `competing-holds`；30 个不计分 warm-up slots 运行 10 秒，再以不重用 identity 的 180 个 measured slots、64 concurrency、60 秒，每 slot 十请求。
- **独立 oracle / mandatory assertions / 禁止副作用**：≥30 attempts/s，成功 hold p95≤600ms；每 slot 恰一 201、九个 exact 409；不得零/多赢家、复用 patient-slot 或留下 partial resources。
- **primarySkill / secondarySkills / feedback / mutant**：`S06` / `S14` / `PERFORMANCE_CONTENTION` / `CG-M03`。

### LOAD-03 2,000 expiry/promotion crash backlog — 5 分

- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture / seam 动作**：README `expiry-and-promotion-recovery`；两 claimed worker SIGKILL，lease 后两 replacement，45 秒。
- **独立 oracle / mandatory assertions / 禁止副作用**：1,000 due Appointments EXPIRED once、1,000 eligible entries PROMOTED once、两 Work kind drain；不得 stale commit、head bypass、duplicate Appointment 或 resource overlap。
- **primarySkill / secondarySkills / feedback / mutant**：`S07` / `S14` / `PERFORMANCE_BACKLOG` / `CG-M04`。

### LOAD-04 负载后 calendars/CarePlan/Event 跨层对账 — 3 分

- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture / seam 动作**：README post-load invariants、UI/snapshot 与 Manager compatibility；每条独立负载后抓 snapshot，并经公开 calendars/UI 加入 CarePlan correctness scan。
- **独立 oracle / mandatory assertions / 禁止副作用**：重算所有 interval exclusivity、bundle completeness、release once、waitlist order、CarePlan aggregate/member closure、event/Work；不得只报性能、抽样代替全量不变量或跨场景复库。
- **primarySkill / secondarySkills / feedback / mutant**：`S17` / `S14,S15` / `POST_LOAD_INVARIANTS` / `CG-M08`。

## 3. Worked example：PLAN-04

CarePlan 含三个 visits：visit 1 已 CONFIRMED，visit 2/3 HELD 且各占独立资源。取消 visit 2 后，oracle 要求 Plan=TERMINATED、visit 1 仍 CONFIRMED 且资源不释放、visit 2 和 visit 3 均 CANCELLED、两者资源各释放一次、Plan.expiresAt=null。随后对 visit 3 的旧 confirm 与 expiry Work 都必须无副作用。只检查 Plan 状态而不对成员/日历逐一核对不算通过。

## 4. Mutants（10 个）

| Mutant | 单一故障 | 必杀 Case |
| --- | --- | --- |
| CG-M01 | 区间用闭区间或不校验 15 分钟对齐 | SLOT-01 |
| CG-M02 | Room/Equipment 选择缺 priority/ID 稳定序 | SLOT-02、LOAD-01 |
| CG-M03 | 多资源逐个 commit/锁序漂移造成 partial 或 double hold | SLOT-03、RACE-02、LOAD-02 |
| CG-M04 | process timer/无 lease fence 让 expiry 双赢 | SLOT-04、RACE-03、LOAD-03 |
| CG-M05 | Waitlist 跳过不可行 head | SLOT-05 |
| CG-M06 | CarePlan/多 visit promotion 部分创建 | PLAN-01/05 |
| CG-M07 | aggregate/expiresAt 缓存不随成员正确更新 | PLAN-02/03、MIGRATE-04 |
| CG-M08 | termination 取消 confirmed 或漏 cancel/release HELD | PLAN-04、LOAD-04 |
| CG-M09 | process-local idempotency 或迁移改 replay/deadline | RACE-01、MIGRATE-01..03 |
| CG-M10 | dispatcher retry 换 event identity/body | RACE-04 |

## 5. SPEC-GAP

- `SPEC-GAP-CG-01`：Manager 未发布新的 Domain Event 名称；不得要求猜测 `care-plan.*`，只验证 V1 同 transition 的事件规则、旧身份不变和无虚构名称。
- `SPEC-GAP-CG-02`：Manager 给出“每条 migration statement”access-exclusive lock≤2s，但没有公开 statement 边界或锁观察 seam；该内部锁断言 blocked，不能以 HTTP stall 代理。公开的 migration 期间 availability p95≤500ms 仍独立执行。
- `SPEC-GAP-CG-03`：没有可冻结 confirm transaction timestamp 的公开 seam，无法稳定发出恰好等于 expiresAt 的请求；计分使用至少 2 秒安全余量，等点不以 sleep 猜测。

## 6. README → Case contract-map

| 合同 | Cases |
| --- | --- |
| V1 interval/resource/expiry/waitlist | SLOT-01..05 |
| Manager CarePlan/member/promotion | PLAN-01..05 |
| idempotency/contention/lease/outbox | RACE-01..04 |
| V1→FINAL、在线迁移、wire/UI/snapshot | MIGRATE-01..04 |
| 三条 fixed performance/post-load | LOAD-01..04 |

## 7. 旧 H → V2 Case

| 旧 H | V2 Cases |
| --- | --- |
| H-01 | 共享 preflight（不计分）；领域 seed 语义由 MIGRATE-03 独立覆盖 |
| H-02 | SLOT-01/02、MIGRATE-04 |
| H-03 | SLOT-01..05 |
| H-04 | SLOT-01/03/04、PLAN-01/04 |
| H-05 | RACE-01 |
| H-06 | RACE-02、PLAN-04 |
| H-07 | RACE-03 |
| H-08 | RACE-04 |
| H-09 | MIGRATE-01/02/03 |
| H-10 | PLAN-01..05 |
| H-11 | RACE-02/03、MIGRATE-04 |
| H-12 | LOAD-01..04 |
| H-13 | 共享 preflight（不计分）；领域真实性 LOAD-04 |

## 8. 评分

按显式 dimension 汇总为 `A=30、B=25、C=20、D=15、E=10`，共 **22 Case / 100 分**；领域 family 不决定维度。任何资源 overlap/partial bundle、CarePlan partial create/错误 termination、Waitlist bypass、幂等第二效果、stale Work 提交、迁移改历史或负载后不变量失败适用旧计划 hard cap。S03/S16 不作计分 primarySkill。
