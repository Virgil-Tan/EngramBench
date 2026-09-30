# DispatchBoard Hidden Test V2 设计

> 仅定义黑盒设计。公共 install/build/migrate/boot/health 是共享不计分 preflight。Evaluator 只通过公开 seed 命令、HTTP/OpenAPI、Courier notification receiver、barrier、进程信号、Chromium 和 snapshot 观察。

## 1. 画像与隔离

- **两项主机制**：确定性 Offer Round/首个合法接受；按 role 冻结 team fanout、全员 readiness 与容量释放闭合。
- **五维评分**：`A-01..05` 公开接口合同 30 分；`B-01..05` 数据正确性/幂等/并发 25 分；`C-01..04` Worker/恢复/持久性 20 分；`D-01..04` OpenAPI/UI/snapshot 跨层闭环 15 分；`E-01..04` 迁移/性能/可运维 10 分。
- **核心 primarySkill（4 个）**：`S04` `database-owned-atomic-idempotency`、`S05` `replay-precedence-and-identity-scope`、`S07` `durable-work-fenced-recovery`、`S17` `frozen-fanout-aggregate-closure`。seed/迁移、性能、跨层等相关官方 Skill 仅在对应 Case 作 `secondarySkills`。
- **failure isolation**：每 Case 新 database/zones/couriers/deliveries/receiver；距离矩阵、UUID、窗口和 notification script 固定生成。E-01..03 每场景使用全新正式 seed。禁止读表/源码；Case 独立给分，hard cap 后置。

## 2. 计分 Case（22 个，100 分）

### A-01 Delivery create/read 的 runtime 合同 — 6 分

- **dimension / 权重**：`A` / 6 分。
- **来源 / fixture / seam 动作**：README Delivery create/list/detail/common errors；提交 readyAt≥deliverBy、load 0/1/100/101、missing references、未知字段、错 media/JSON 与无 eligible Courier，并测 limit/cursor/not-found。
- **独立 oracle / mandatory assertions / 禁止副作用**：合法请求精确 202 REQUESTED 和 Delivery shape，恰一 initial OFFER_ISSUANCE Work；无 eligible 精确 `NO_ELIGIBLE_COURIER`，list/detail 的 pagination/order/nullability 与其他稳定 error envelope 精确；所有拒绝不得留 Delivery/Offer/Work/Event 或改 Courier load。
- **primarySkill / secondarySkills / feedback / mutant**：`S17` / `S01,S06` / `A.DELIVERY_CONTRACT` / `DB-M01`。

### A-02 accept 的 Delivery/Offer deadline 优先级 — 6 分

- **dimension / 权重**：`A` / 6 分。
- **来源 / fixture / seam 动作**：README policy 3–4/accept errors；用可观测数据库时间建三个至少 5 秒安全余量的子 fixture：两 deadline 都过、仅 Offer 过但距 deliverBy 仍≥5 秒、两者均距截止≥5 秒；不测临界时刻。
- **独立 oracle / mandatory assertions / 禁止副作用**：两者均过时精确 `DELIVERY_STATE_CONFLICT`，Delivery 变 EXPIRED、所有 open Offers 终止并释放 load；仅 Offer 过时精确 `OFFER_EXPIRED` 且不改 Delivery/load；均未过时返回合同 Assignment；不得 late assignment、复活或双释放。
- **primarySkill / secondarySkills / feedback / mutant**：`S05` / `S01,S06` / `A.DEADLINE_PRECEDENCE` / `DB-M03`。

### A-03 ordinary cancel/pickup/complete 状态合同 — 6 分

- **dimension / 权重**：`A` / 6 分。
- **来源 / fixture / seam 动作**：README cancel/pickup/complete routes/errors；以 REQUESTED/OFFERING/ASSIGNED/PICKED_UP/terminal 状态分别提交合法、foreign courier、proofCode 5/6/64/65 与重复动作。
- **独立 oracle / mandatory assertions / 禁止副作用**：合法路径仅 REQUESTED→OFFERING→ASSIGNED→PICKED_UP→DELIVERED 或 pre-pickup→CANCELLED，输出 shape 与 `DELIVERY_STATE_CONFLICT` 精确；取消结束 open Offers，terminal 后无新 transition；拒绝无 Assignment/Event/load 副作用。
- **primarySkill / secondarySkills / feedback / mutant**：`S04` / `S01,S17` / `A.ORDINARY_LIFECYCLE` / `DB-M05`。

### A-04 team create/detail/offer 增量 wire — 6 分

- **dimension / 权重**：`A` / 6 分。
- **来源 / fixture / seam 动作**：Manager roles/create/detail/TeamOffer wire 与 errors；测 omitted、1/2/4/5 roles、空/duplicate exact names，再读 team Delivery/Offers/notifications。
- **独立 oracle / mandatory assertions / 禁止副作用**：omitted 保持 exact V1 singular shape；合法 team Delivery 的 requiredRoles 保留输入序、assignmentId null，assignments 按 role 序，TeamOffer/notification roleIndex+role 严格；非法精确 `INVALID_TEAM_ROLES` 且无 Delivery/Offer/Work/Event。
- **primarySkill / secondarySkills / feedback / mutant**：`S17` / `S01,S06` / `A.TEAM_WIRE` / `DB-M06`。

### A-05 team accept/ready/pickup/complete/cancel 错误合同 — 6 分

- **dimension / 权重**：`A` / 6 分。
- **来源 / fixture / seam 动作**：Manager mutation routes/stable errors；通过公开 API 分开制造 filled role、same Courier second role、expired claim、not-ready、foreign courier、pre/post-pickup cancel 与合法 terminal 流。
- **独立 oracle / mandatory assertions / 禁止副作用**：`TEAM_ROLE_ALREADY_FILLED`、`COURIER_TEAM_ROLE_CONFLICT`、`TEAM_ROLE_CLAIM_EXPIRED`、`TEAM_NOT_READY`、`TEAM_COURIER_NOT_ASSIGNED` 按各自单一 fixture 精确；成功 response 与 Team/RoleAssignment wire 合同化；任一拒绝无部分 state/load/event 副作用。
- **primarySkill / secondarySkills / feedback / mutant**：`S04` / `S01,S05,S17` / `A.TEAM_MUTATION_CONTRACT` / `DB-M09`。

### B-01 Courier eligibility、排名与冻结 Offer Round — 5 分

- **dimension / 权重**：`B` / 5 分。
- **来源 / fixture / seam 动作**：README policies 1–2/6；准备 PAUSED、zone 不符、容量恰好/少 1 及 distanceBucket/activeLoad/courierId 多级 tie，运行首轮与全过期次轮。
- **独立 oracle / mandatory assertions / 禁止副作用**：外部重算 AVAILABLE+两 zone+容量 eligible set，按 distance/load/ID asc 取未曾 offered 前五；round/rank gapless、members 冻结；不得预留 load、重复前轮 Courier、随机 tie-break、超过五人或 duplicate notification。
- **primarySkill / secondarySkills / feedback / mutant**：`S17` / `S06` / `B.FROZEN_OFFER_RANKING` / `DB-M02`。

### B-02 first claim、capacity 与 ordinary terminal 原子性 — 5 分

- **dimension / 权重**：`B` / 5 分。
- **来源 / fixture / seam 动作**：README policies 3/6 与 mandatory invariants；两 API processes 并发接受五 Offers，与 cancel/pickup/complete 三个固定交错竞争。
- **独立 oracle / mandatory assertions / 禁止副作用**：恰一 Assignment/ACCEPTED，其余 LOST，Courier load 只保留唯一 winner；pickup/complete/cancel 最多一个合法终态后继且只释放一次；不得双 assignment、capacity overflow、deadlock partial state 或 terminal 复活。
- **primarySkill / secondarySkills / feedback / mutant**：`S04` / `S06,S17` / `B.ORDINARY_ATOMICITY` / `DB-M05`。

### B-03 role fanout、Courier 互斥与局部 re-offer — 5 分

- **dimension / 权重**：`B` / 5 分。
- **来源 / fixture / seam 动作**：Manager rules 4/7；三 roles 独立 fanout，同 Courier 收多 role Offers 后接受一个，并让数据库时间超过一个 RESERVED claimExpiresAt 至少 5 秒、其他 claims 仍有效。
- **独立 oracle / mandatory assertions / 禁止副作用**：每 unfilled role 独立按 V1 ranking 最多五 Offers；接受后同 Courier 其他 open Offers LOST，role/Courier live assignment 均唯一；过期仅 RELEASE 该 role、恢复其 load、round+1 并仅向该 role re-offer；不得清空全队或重复 release。
- **primarySkill / secondarySkills / feedback / mutant**：`S17` / `S06,S07` / `B.ROLE_LOCAL_CLOSURE` / `DB-M07`。

### B-04 final activation、READY 栅栏与 team terminal 闭合 — 5 分

- **dimension / 权重**：`B` / 5 分。
- **来源 / fixture / seam 动作**：Manager rules 2–5；保留最后两 roles 并发 final claims，逐 role ready，再并发 pickup/complete/cancel。
- **独立 oracle / mandatory assertions / 禁止副作用**：每 role 一 distinct Courier，全 roles 填满时恰一 ACTIVE Team identity，全 live roles READY 后才 READY；pickup/complete 各一 winner，complete/cancel 原子更新父子状态并释放每个 load 一次；不得 partial activation/terminal、提前 READY 或双释放。
- **primarySkill / secondarySkills / feedback / mutant**：`S17` / `S04,S06` / `B.TEAM_AGGREGATE_CLOSURE` / `DB-M08`。

### B-05 durable replay 与跨 Delivery 热点容量竞争 — 5 分

- **dimension / 权重**：`B` / 5 分。
- **来源 / fixture / seam 动作**：README durable idempotency/V1+Manager capacity invariants；response shield 后跨两 API processes 并发 replay/restart/异 payload，覆盖 create/accept/ready/complete，并使同 Couriers 争多个 Delivery/role 的最后容量。
- **独立 oracle / mandatory assertions / 禁止副作用**：每 key 保存原 status/semantic JSON 与一个业务/load/event/work effect，异语义精确 conflict；按所有 live ordinary/role assignments 重算 activeLoad≤capacity，每 Offer/role/Delivery 一 winner；不得 process-local replay、oversubscribe、lost claim 留 load、双释放或 deadlock partial state。
- **primarySkill / secondarySkills / feedback / mutant**：`S04` / `S05,S06,S17` / `B.DURABLE_CAPACITY_CONTENTION` / `DB-M05`。

### C-01 captured OfferNotification 外部投递恢复 — 5 分

- **dimension / 权重**：`C` / 5 分。
- **来源 / fixture / seam 动作**：README policy 5/notification persistence；Offer 后改 Courier deliveryUrl，receiver 持久化 body 后挂 ACK，另回 500/timeout/204，在 1/2/4/8 秒退避及 expiresAt 前后杀投递进程并恢复。
- **独立 oracle / mandatory assertions / 禁止副作用**：每次使用创建时 URL 与 exact RFC8785 body/notificationId，attempt n 的 nextAttemptAt=completion+min(2^(n-1),8)，任一 2xx 后 DELIVERED 且不新 attempt，截止后不发起；不得换 URL/body/identity、重复逻辑效果或网络等待持 DB transaction。
- **primarySkill / secondarySkills / feedback / mutant**：`S07` / `S05,S17` / `C.NOTIFICATION_RECOVERY` / `DB-M04`。

### C-02 OFFER_ISSUANCE 的三断点接管 — 5 分

- **dimension / 权重**：`C` / 5 分。
- **来源 / fixture / seam 动作**：README Work/barrier；在 `worker.claimed`、`worker.effect-complete`、`worker.before-commit` 持有 OFFER_ISSUANCE 时 SIGKILL，并与 cancel/accept 固定交错，lease 后 replacement 接管。
- **独立 oracle / mandatory assertions / 禁止副作用**：workId/attempt 可追踪、terminal 保留，replacement 仅创建一个合法 round 与冻结 Offers/notifications，stale owner 无提交；不得 terminal Delivery 出新 Offer、duplicate round/identity 或死锁 partial state。
- **primarySkill / secondarySkills / feedback / mutant**：`S07` / `S06,S17` / `C.ISSUANCE_RECOVERY` / `DB-M03`。

### C-03 OFFER_EXPIRY 与 role-local re-offer 恢复 — 5 分

- **dimension / 权重**：`C` / 5 分。
- **来源 / fixture / seam 动作**：README/Manager expiry Work；对 ordinary 全 round 过期与 team 单 role claim 过期，在三 barrier SIGKILL，与 accept/ready/cancel 固定交错，lease 后 replacement 接管。
- **独立 oracle / mandatory assertions / 禁止副作用**：replacement 恰一终止 due Offer/claim；ordinary 仅在无 winner 时生一 next round，team 仅 release/re-offer 已过期 role 并保留其他 claims/load，Work drain 且 stale owner 无提交；不得 late re-offer、全队重建、双释放或 duplicate notification。
- **primarySkill / secondarySkills / feedback / mutant**：`S07` / `S06,S17` / `C.EXPIRY_RECOVERY` / `DB-M09`。

### C-04 Domain Event dispatcher unknown ACK 与持久顺序 — 5 分

- **dimension / 权重**：`C` / 5 分。
- **来源 / fixture / seam 动作**：README event retry/barrier；event receiver 持久化完整 body 后挂 ACK，在 `dispatcher.response-received` 杀 dispatcher，混合多 Delivery sequence 恢复。
- **独立 oracle / mandatory assertions / 禁止副作用**：重试保持 eventId 与语义 JSON body，同 aggregate 成功顺序递增、V1 payload 仍 `{}`，成功后不创建新 identity；不得发明 team event 名、乱序成功、泄漏 token/idempotency key/private path 或持事务等 ACK。
- **primarySkill / secondarySkills / feedback / mutant**：`S07` / `S05` / `C.EVENT_OUTBOX_RECOVERY` / `DB-M04`。

### D-01 Delivery/Team seed→OpenAPI/runtime 合同闭环 — 4 分

- **dimension / 权重**：`D` / 4 分。
- **来源 / fixture / seam 动作**：README OpenAPI 与 Seed contract；用公开 seed 命令导入 exact V1 graph，覆盖 symmetric complete ZoneDistance、Courier activeLoad=所有 ASSIGNED/PICKED_UP Assignments 之和、Delivery/Offer/Notification/Assignment 引用、round/deadline 与 captured URL/body 对账，再用公开 HTTP 读取并与 `/openapi.json` 核对；另行给出同 version+digest replay、同 version 异内容、invalid refs/不完整距离矩阵/断裂 load 守恒/unknown keys fixture。
- **独立 oracle / mandatory assertions / 禁止副作用**：合法 graph 一次导入，runtime/OpenAPI 的 V1 shape、required/nullability/error 一致；同 version+digest 无作用，同 version 异内容精确 `SEED_VERSION_CONFLICT`，任一无效成员使整份导入原子拒绝且不留 business/Work/idempotency/Event；不得使用 Manager-only seed 成员。
- **primarySkill / secondarySkills / feedback / mutant**：`S04` / `S01,S02,S15` / `SEED_WIRE_TRIANGULATION` / `DB-M01`。

### D-02 ordinary V1 真实 UI 闭环 — 4 分

- **dimension / 权重**：`D` / 4 分。
- **来源 / fixture / seam 动作**：README Real UI 与 Manager legacy compatibility；Chromium 在 desktop/mobile viewport 从可见语义控件创建 ordinary Delivery，观察 round/notification，完成 accept/pickup/complete 及独立 cancel/error 流，refresh 后继续。
- **独立 oracle / mandatory assertions / 禁止副作用**：UI 每个状态与同流程公开 HTTP/receiver 观测一致，ordinary Delivery 保持 exact V1 singular shape 且省略 Manager-only fields，load/event/history 闭合；loading/empty/validation/conflict/stale/offline/terminal/permission 状态、keyboard、label 与 focus 可验证；不得 mock、browser-only state、私有 API 或用文本存在代替真实流程。
- **primarySkill / secondarySkills / feedback / mutant**：`S17` / `S01,S15` / `ORDINARY_UI_ACCEPTANCE` / `DB-M06`。

### D-03 team roles/readiness/terminal 真实 UI 闭环 — 4 分

- **dimension / 权重**：`D` / 4 分。
- **来源 / fixture / seam 动作**：Manager rule 13 与 team wire/API/UI；Chromium 创建 2–4 roles Delivery，观察各 role Offers/独立 claims，记录全员 readiness，完成 pickup/complete 及独立 cancel/expiry/error 流，refresh 后复核 history。
- **独立 oracle / mandatory assertions / 禁止副作用**：UI、runtime Delivery/TeamOffer/RoleAssignment 与 Courier load/snapshot 对同一 identities/order/state 闭合；loading、conflict、terminal 与可访问状态真实；不得 mock、读表、私有 endpoint 或伪造 Manager event。
- **primarySkill / secondarySkills / feedback / mutant**：`S17` / `S06,S15` / `TEAM_UI_ACCEPTANCE` / `DB-M08`。

### D-04 Delivery/Team FINAL point-in-time snapshot 与跨层 shape — 3 分

- **dimension / 权重**：`D` / 3 分。
- **来源 / fixture / seam 动作**：README V1 snapshot 与 Manager FINAL union；混合 ordinary/team、open/terminal Offers、reserved/ready/completed roles、terminal/nonterminal Work 与 events，在并发变更时读 verification snapshot，并与稳定前后时点的公开 detail/courier/event 对照。
- **独立 oracle / mandatory assertions / 禁止副作用**：`resources` 恰为 V1+Manager 十组 union，各 shape、role/tuple+RFC8785 tie-break、Work enum/lease/retention/drain、event order 与递归 `*Token` omission 全精确；同一 `asOf` 下 Delivery/Offer/Assignment/load 守恒，不得 N+1 造成不一致、泄密或多出私有键。
- **primarySkill / secondarySkills / feedback / mutant**：`S17` / `S11,S15` / `FINAL_SNAPSHOT_CLOSURE` / `DB-M06`。

### E-01 Delivery create sustained load — 2.5 分

- **dimension / 权重**：`E` / 2.5 分。
- **来源 / fixture / seam 动作**：README `delivery-create`；64 concurrency、10s warm-up+60s measure、disjoint customers/zones，使用官方 `perf-v1` seed 完整规模。
- **独立 oracle / mandatory assertions / 禁止副作用**：≥100 successful creates/s、p95≤300ms、5xx=0，每 202 恰一 initial issuance Work；计时后全量 snapshot 复核 Delivery/round/Work/event contiguous sequence、无重复 identity 与 Courier load 守恒；不得缩放、复用 id/key 或预建 Offers 算成功。
- **primarySkill / secondarySkills / feedback / mutant**：`S17` / `S11,S14` / `PERFORMANCE_CREATE` / `DB-M01`。

### E-02 1,000 hot Offer claims — 2.5 分

- **dimension / 权重**：`E` / 2.5 分。
- **来源 / fixture / seam 动作**：README `hot-offer-claims`；200 Deliveries×5 Offers、64 concurrency、5s，使用官方 `perf-v1` seed 完整规模。
- **独立 oracle / mandatory assertions / 禁止副作用**：全部完成≤5s、all-response p95≤350ms；恰 200 winners/800 exact LOST、无 double load/5xx；计时后全量复核每 Delivery 一 Assignment、Offer terminal 状态、Courier capacity/load、event identity/sequence 与 Work drain；不得排除 conflicts、少提交或跨 delivery 混 winner。
- **primarySkill / secondarySkills / feedback / mutant**：`S04` / `S06,S11,S14,S17` / `PERFORMANCE_HOT_CLAIMS` / `DB-M05`。

### E-03 5,000 due Offer recovery — 2.5 分

- **dimension / 权重**：`E` / 2.5 分。
- **来源 / fixture / seam 动作**：README `offer-expiry-recovery`；两 claimed workers SIGKILL，lease 后两 replacements，60s，使用官方 `perf-v1` seed 完整规模。
- **独立 oracle / mandatory assertions / 禁止副作用**：due Offers 终态一次、affected Delivery 一 coherent winner/next round、load 对账、两 Work kinds drain；计时后全量复核 round/rank/notification identity、capacity、event sequence、attempt/lease fence 与所有 terminal Work；不得 stale commit、duplicate notification/round 或 headless state。
- **primarySkill / secondarySkills / feedback / mutant**：`S07` / `S06,S11,S14,S17` / `PERFORMANCE_EXPIRY_BACKLOG` / `DB-M03`。

### E-04 V1 Assignment→DRIVER 的 FINAL 兼容迁移 — 2.5 分

- **dimension / 权重**：`E` / 2.5 分。
- **blockedBy**：`SPEC-GAP-DB-01`；整个 Case 在 DRIVER RoleAssignment 的 FINAL snapshot 表达补齐前不得运行或重新归一化。
- **来源 / fixture / seam 动作**：Manager rules 8–11/14；在本 Case 内用冻结 V1 binary 与符合公开 seed 合同的 exact fixture 独立建立 ASSIGNED/PICKED_UP/DELIVERED/CANCELLED ordinary Deliveries、OPEN Offers、pending notifications、PENDING/LEASED Work 与 saved pickup/complete/cancel replay，记录 HTTP/snapshot/receiver 观测，执行公开升级迁移后恢复/replay/完成。
- **独立 oracle / mandatory assertions / 禁止副作用**：每 V1 Assignment 的公开 FINAL lineage 恰有一个 DRIVER role，同时 ordinary singular wire、state/capacity、offerId/notificationId/semantic body/expiresAt、workId/attempt/lease、event identity/sequence 与 saved status/semantic JSON 不变；已 PICKED_UP 仍按 V1 proofCode 完成；不得要求 readiness、生成 synthetic Team、重排/延期 Offer、stale commit 或改写 replay。
- **primarySkill / secondarySkills / feedback / mutant**：`S05` / `S02,S07,S11` / `V1_DRIVER_COMPATIBILITY` / `DB-M10`。

## 3. Worked example：B-03

三 roles 为 DRIVER/LOADER/ESCORT；前两 role 已 RESERVED，DRIVER 的 claimExpiresAt 先到。expiry runner 必须只把 DRIVER assignment 变 RELEASED、只恢复该 Courier load、保留 LOADER assignment/claim expiry/notification identity，Delivery.currentRound 恰加 1，并仅为 DRIVER 产生下一轮最多五个排序 Offers。若实现清空整个 team 再重建，即使最终能凑齐团队也失败。

## 4. Mutants（10 个）

| Mutant | 单一故障 | 必杀 Case |
| --- | --- | --- |
| DB-M01 | eligibility/window/load 校验后置、seed graph 失真或 create 无单一 Work | A-01、B-01、D-01、E-01 |
| DB-M02 | Courier ranking 缺 bucket/load/ID tie-break 或重复前轮成员 | B-01 |
| DB-M03 | deadline precedence 错/issuance-expiry Work 无 fence | A-02、C-02/03、E-03 |
| DB-M04 | notification/event retry 用新 body/新 identity | C-01/04 |
| DB-M05 | accept/terminal/idempotency 非原子，双 assignment/load | A-03、B-02/05、E-02 |
| DB-M06 | roles 未冻结/ordinary 或 FINAL wire 被 Team 字段污染 | A-04、D-01/02/04 |
| DB-M07 | 同 Courier 可占多 role/跨 Delivery 超 capacity | B-03/05 |
| DB-M08 | final claim 双 activation或父聚合提前完成 | B-04、D-03 |
| DB-M09 | readiness/expiry/cancel 漏成员或重复释放 | A-05、B-03/04、C-03 |
| DB-M10 | migration 换 Offer/deadline/replay 或强制旧 pickup 走 team | E-04 |

## 5. SPEC-GAP

- `SPEC-GAP-DB-01`：Manager 同时说 legacy ordinary 保留 singular fields、又说每个 V1 Assignment 迁移为 DRIVER role，但未说明该 RoleAssignment 是否出现在 `teamAssignments` snapshot，也没有另一个公开 lineage 观察面。`E-04` 整个 Case 依赖该表达并已 `blockedBy`；冻结 runner 前必须补齐，不得偷读内部表或只删 lineage 断言。
- `SPEC-GAP-DB-02`：TeamAssignment 有 FORMING state，但规则说“final required claim atomically activates one TeamAssignment”，未明确首 claim 时是否已有同一 TeamAssignment。Cases 只断言 final activation 唯一和公开 Delivery 字段，不猜 FORMING identity 创建时点。
- `SPEC-GAP-DB-03`：Manager 未发布新 event type；不得私设 team event 名。

## 6. README → Case contract-map

| 合同 | Cases |
| --- | --- |
| V1/Manager runtime wire、route、边界与错误 | A-01..05 |
| Offer/role 冻结、capacity、幂等与并发闭合 | B-01..05 |
| notification、issuance/expiry Work 与 event dispatcher 恢复 | C-01..04 |
| seed/OpenAPI、ordinary UI、team UI、FINAL snapshot | D-01..04 |
| 三条 fixed performance、负载后可运维闭合与 V1→FINAL DRIVER 兼容迁移 | E-01..04 |

## 7. 旧 H → V2 Case

| 旧 H | V2 Cases |
| --- | --- |
| H-01 | 共享 preflight（不计分）；领域 seed=D-01 |
| H-02 | A-01..05、D-01/04 |
| H-03 | A-01..03、B-01/02 |
| H-04 | A-01/02/04/05、B-01..03 |
| H-05 | B-05 |
| H-06 | B-02/04/05 |
| H-07 | C-01..03 |
| H-08 | C-04 |
| H-09 | E-04 |
| H-10 | A-04/05、B-03/04 |
| H-11 | C-02/03、D-02..04 |
| H-12 | E-01..03 |
| H-13 | 共享 preflight（不计分）；负载后领域闭合已并入 E-01..03 |

## 8. 评分

`A 30 + B 25 + C 20 + D 15 + E 10 = 100`，共 **22 Case**。A 仅评公开 runtime 合同，B 评数据不变量/幂等/并发，C 评 notification、Offer Work 与 dispatcher 恢复，D 评 seed→OpenAPI/runtime、两条真实 UI 与 snapshot 跨层，E 评三条正式性能场景、负载后可运维闭合与兼容迁移。double assignment/capacity overflow、deadline 后接受、team partial activation/terminal、幂等第二效果、stale Work commit、迁移改 identity/replay 均触发领域 hard cap。S03/S16 不作计分 primarySkill。
