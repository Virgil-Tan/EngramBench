# IncidentRelay Hidden Test v2 详细设计

本任务设计遵循 [`docs/hidden-test-v2-standard.zh-CN.md`](../../../docs/hidden-test-v2-standard.zh-CN.md)；
下文只定义 IncidentRelay 的任务专属合同映射、oracle、fixtures、Cases、Hard Caps 与 mutants。

## 1. 目标与边界

本方案把 H-01～H-13 拆成 **44 个独立、确定性、Harness-owned 黑盒 case**，重点验证 active-key
dedup、immutable policy capture、persisted due/retry、business Notification 与 Domain Event 的分离、terminal
races、Worker fencing，以及 Manager parallel quorum acknowledgement。

所有测试只走 Public Contract 发布的 seam，不读取 Candidate 源码/表/ORM，不把 Candidate test、OpenAPI
或日志声明作为正确性真值。本文不实现 runner，也不改变 README、Manager 变更或性能阈值。

## 2. 权威来源与合同缺口

权威顺序：V1 `workspace/README.md` → T16 固定 Manager 变更 → `workspace/AGENTS.md` → `CONTEXT.md`。

不得由 Evaluator 猜测的 `SPEC-GAP`：

- `SPEC-GAP-01`：Manager 规定 legacy `/acknowledge` 只在 captured Steps 全部 quorum=1 时可用，但没有发布
  对 group policy 调用该 endpoint 的 status/error code。测试只断言它不能创建 acknowledgement 或改变 Incident，
  在补合同前不规定返回 `RESPONDER_NOT_IN_ACTIVE_QUORUM` 或其他 code。
- `SPEC-GAP-02`：Group Step 达到 notification quorum 成为 SENT 后，未 DELIVERED 的其余 NotificationDeliveries
  是否继续 retry 未定义。测试验证已发生 delivery 的 identity/ack eligibility 和 quorum transition，不规定余下通知命运。
- `SPEC-GAP-03`：V1 `nextAttemptAt` 公式使用内部 `attemptCompletedAt`，但该 timestamp 不在公开
  NotificationDelivery shape。Evaluator 可用 receiver 时间窗验证指数退避与上限，不要求不可观察的毫秒值相等。
- `SPEC-GAP-04`：Manager 没有发布 acknowledgement accepted/duplicate 的新 Domain Event type；不得要求
  一个新事件。只有 quorum 首次使 Incident ACKNOWLEDGED 时，才要求既有 `incident.acknowledged` transition event。
- `SPEC-GAP-05`：`/resolve` 明确允许 winner 或 captured policy 中另一 Responder，但没有发布 outsider 在
  Incident 已 ACKNOWLEDGED 时的精确 status/error code。测试要求 outsider 不得改变状态，在补合同前不固定错误码。
- `SPEC-GAP-06`：Manager 要求 resolution 记录 immutable quorum members，但没有发布该记录的 resource、字段或读取
  seam。测试通过已发布且不可撤回的 `acknowledgements[]` 验证成员不可变，不自行发明 resolution record shape。

## 3. 冻结的公开 seams

| Seam | 允许操作 | 禁止操作 |
| --- | --- | --- |
| Public commands | README npm install/migrate/seed/build/start/test | import Candidate 模块/helper |
| HTTP | health、OpenAPI、全部公开业务/read/snapshot routes | 未发布 debug routes |
| Verification snapshot | ADMIN_TOKEN 读取同一 point-in-time | 查询私有 outbox/table |
| Production browser | production Chromium 可见控件 | 页面注入、内部 store/direct API 代替主操作 |
| Business receiver | Responder `deliveryUrl` 接收 Notification，控制 2xx/500/断线/延迟 | 读取内部 delivery client |
| Domain receiver | `WEBHOOK_URL` 接收 Domain Event 并控制 ACK | 混淆为 business notification |
| Recovery barrier | 公开 worker/dispatcher barrier | sleep 猜 claim/commit/ACK |
| Process boundary | 独立双 API/双 Worker/Dispatcher 与 SIGTERM/SIGKILL | 单进程对象冒充 |
| V1→FINAL checkpoint | 冻结 V1 binary 写历史后升级同库 | FINAL 伪造 V1 状态 |

## 4. Runner、结果与 Case 约定

建议 `evaluator/v2/{manifest,contract-map,run,lib,fixtures,cases,calibration}`。每 case 独立数据库、端口、
managed root、两个 receiver、barrier 与进程组；只有 migration cases 复用 V1 库；性能 cases 独占固定环境。

下文 Case 标题即唯一 ID/维度/权重，每项含前置 fixture、public-seam 操作与 mandatory 可观察断言。
manifest 对每个 Case 固定唯一私有 failure code：`IR_<CASE_ID>_FAILED`（Case ID 中 `-` 转为 `_`）。公开反馈
只给最小稳定类别：A=`contract`、B=`correctness`、C=`recovery`、D=`cross_layer`、E=`compat_perf`，不泄露
assertion、fixture 或 oracle。Case 内任一 mandatory assertion 失败即 0 分；Candidate `failed`、sample `invalid`、
基础设施 `evaluator_error` 必须分开。

## 5. 独立 oracle 与 fixtures

### 5.1 Escalation / quorum oracle

Evaluator 独立计算：

1. Incident 捕获 create transaction 时 current policy version；每 step `dueAt=createdAt+delaySeconds`，
   `expiresAt=createdAt+expireAfterSeconds`；
2. due ordering 为 `(dueAt,incidentId,stepIndex)`；V1 successful notifications 按 stepIndex 递增；
3. 第 n 次失败后退避秒数为 `min(2^(n-1),60)`，notificationId/body/deliveryUrl 永久来自 captured snapshot；
4. database time `>=expiresAt` 时 expiry 优先于新 delivery/ack；
5. V1 acknowledgement 只允许 lowest-index SENT step targeting responder；一个 winner 后其余 Steps/Deliveries supersede；
6. Manager policy responderIds byte-sort unique，`1<=quorumRequired<=N`；每 responder 一个稳定 Notification；
7. Group Step 在第 quorumRequired 个 distinct notification DELIVERED 时 SENT；
8. acknowledgement uniqueness `(incidentId,stepIndex,responderId)`；只有该 responder 自己的 delivery 已成功且 Step SENT 才能新 ack；
9. 第一个达到 acknowledgement quorum 的 step 独占 winner，记录 stepIndex，其他 Steps 原子 supersede。

区分性 example：step0 targets A/B/C，delivery quorum=2、ack quorum=2。A/B delivered 后 Step SENT；A 的第一次
ack 不得终止 escalation，B ack 才使 Incident ACKNOWLEDGED；A duplicate 在终态后仍 replayed=true 且 count 不增。

### 5.2 确定性与 fixture families

- UUID、dedupKey、notification/outcome identities、时间与 interleaving 来自私有
  `evaluationSeed+caseId+ordinal`；`T0` 取可观察数据库/API time 后安全窗口；并发至少三个固定 seed。

| Fixture | 用途 |
| --- | --- |
| F-EMPTY | clean migrate/boot/validation |
| F-POLICY | V1 policy versions、delay/expiry boundaries、多 Responders |
| F-INCIDENT | OPEN/ACKNOWLEDGED/RESOLVED/EXPIRED 与 dedup lifecycle |
| F-NOTIFICATION | success/500/disconnect/timeout、multiple attempts |
| F-IDEMPOTENCY | 所有 mutation replay/conflict/unknown response |
| F-CONTENTION | active dedup、ack/resolve/expiry、hot Steps |
| F-WORK | ESCALATION_STEP/INCIDENT_EXPIRY 各 lifecycle/attempt/lease |
| F-EVENT | 多 aggregate sequence、未 ACK/重试/已 ACK |
| F-QUORUM | 1/2/N quorum、多 SENT Steps、duplicate vote |
| F-MIGRATION | V1 winners、pending delivery、saved replay、events |
| F-BROWSER | V1 与 quorum 主流程/错误状态 |
| F-PERF-V1 | README 精确 1k services/10k responders/100k incidents/300k steps |

## 6. 评分总览

| Dimension | Weight | Case 数 |
| --- | ---: | ---: |
| A. 需求与公共接口覆盖 | 30 | 14 |
| B. 数据正确性、幂等与并发 | 25 | 10 |
| C. Worker、恢复与持久性 | 20 | 8 |
| D. OpenAPI、UI 与跨层闭环 | 15 | 7 |
| E. 迁移、性能与可运维性 | 10 | 5 |
| **Total** | **100** | **44** |

## 7. A — 需求与公共接口覆盖（30 分）

### A-01 Published commands and production boot — 2
- **前置**：空库、无依赖/构建产物、合法环境。
- **操作**：install、重复 migrate、build，独立启动 API/Escalation Worker/Dispatcher，health/OpenAPI 后 SIGTERM。
- **可观察断言**：命令非交互、失败非零；只 bind localhost；进程角色独立且正常清理。

### A-02 Repeatable populated migration — 2
- **前置**：F-INCIDENT/F-NOTIFICATION populated 数据。
- **操作**：迁移两次、seed、HTTP 增加状态，再迁移两次。
- **可观察断言**：Incidents/Steps/Deliveries/Work/Event/replay identity 不变；失败 migration 不暴露 partial behavior。

### A-03 Atomic deterministic seed — 2
- **前置**：合法 seed 和 unknown key、duplicate/missing ref、bad policy/step/body/state/time/int fixtures。
- **操作**：合法导入、same digest replay、same version different content、逐个非法导入。
- **可观察断言**：合法 exact；replay no-op；冲突 `SEED_VERSION_CONFLICT`；非法后业务/Work/Event/idempotency 全不变。

### A-04 OpenAPI 3.1 exact contract — 2
- **前置**：FINAL production API。
- **操作**：独立 contract map 比较 V1/quorum routes、schemas、status/errors、required/nullable/additionalProperties。
- **可观察断言**：live traffic 可验证；V1/Manager policy variants、Incident arrays 与 errors 精确；SPEC-GAP 不被私自填充。

### A-05 Common errors and scalar/cardinality boundaries — 2
- **前置**：合法 Service/Responder/Policy。
- **操作**：media/JSON/unknown/auth/not-found/cursor；dedupKey 1/128、delay 0/86400、strict increase、expiry、
  responderIds/quorum 和 idempotency key 边界。
- **可观察断言**：exact error envelope/code；合法边界成功，非法 policy 为对应稳定 400；所有失败零副作用。

### A-06 Pagination, reads and point-in-time snapshot — 2
- **前置**：collections >110、多状态。
- **操作**：list/detail/current policy/snapshot/events 分页读取。
- **可观察断言**：limit/cursor 无重无漏；exact V1/FINAL keys/shapes/sorts；同一 asOf；递归 omit `*Token`/秘密；Work shape 合法。

### A-07 Immutable policy version CAS — 2
- **前置**：Service 无 policy 与已有 versions 两种。
- **操作**：expected null 创建 v1；正确/错误 expectedCurrentVersion 并发更新。
- **可观察断言**：版本严格 +1 且旧 policy 不变；stale 为 `ESCALATION_POLICY_VERSION_CHANGED`；steps/delays/targets exact。

### A-08 Incident create, active dedup and policy capture — 2
- **前置**：current policy v1，随后可发布 v2。
- **操作**：创建 Incident，相同 active dedup semantics 用 fresh key 重放，不同内容冲突；发布 v2 后读旧 Incident。
- **可观察断言**：201 OPEN、created/due/expiry 正确；active identical 返回同 Incident；conflict
  `INCIDENT_DEDUP_CONFLICT`；旧 Incident 永久捕获 v1。

### A-09 Persisted scheduling and business delivery — 2
- **前置**：多 steps/dueAt，本地 responder receiver。
- **操作**：运行两个 Workers，receiver 先 500/断线再 2xx。
- **可观察断言**：按 due order；每 attempt 同 notificationId/header/body/URL；attemptCount/nextAttemptAt/backoff 可观察一致；
  2xx 后 Step SENT、Delivery DELIVERED，Domain receiver 与 business receiver 完全分离。

### A-10 Acknowledge and resolve V1 — 2
- **前置**：一个 Responder 有多个 Step，只有部分 SENT；captured policy 另有一名 Responder，并准备一名 outsider。
- **操作**：PENDING responder ack、有效 ack、另一 responder ack；分别在独立 fixture 中由 winner、captured alternate、
  outsider 调用 resolve。
- **可观察断言**：只选 lowest-index matching SENT；无资格为 `INCIDENT_NOT_ACKNOWLEDGEABLE`；首 winner 原子 ACK，
  其他为 `INCIDENT_ALREADY_ACKNOWLEDGED`；winner 与 captured alternate 均可使 ACKNOWLEDGED→RESOLVED 恰一次，
  remaining work superseded；outsider 必须被拒绝且不改变 Incident/Work/Event，具体 status/error code 按
  `SPEC-GAP-05` 不计分。

### A-11 Expiry and terminal precedence — 2
- **前置**：OPEN Incident 接近 expiresAt，pending delivery/ack。
- **操作**：在 `<expiresAt` 与 `>=expiresAt` 两侧触发 Worker/ack/resolve。
- **可观察断言**：到期优先变 EXPIRED；Steps/Deliveries/Work superseded/terminal；过期无新 business delivery 或 ack；terminal 不复活。

### A-12 Timeline and Domain Events — 2
- **前置**：open→sent→ack→resolve 与 expiry 两条路径。
- **操作**：读取 timeline、event query，并由 Domain receiver 接收。
- **可观察断言**：Timeline sequence/facts 与 snapshot 一致；V1 event types/payload `{}`、per aggregate sequence 连续；rollback 无 event。

### A-13 FINAL group policy and notification quorum — 3
- **前置**：Manager FINAL，1、2、N responder groups 与 invalid quorum fixtures。
- **操作**：创建 group policy/Incident；让部分 receivers 成功、其余失败，逐个跨过 notification quorum。
- **可观察断言**：responderIds byte-sort unique；`notifications` 与 responderIds 等长且
  `notifications[i].responderId == responderIds[i]`，每 responder 一个 stable Delivery；Step 仅在第 quorum 个 distinct
  delivery 成功 transaction 变 SENT，successfulDeliveryAt 对应；invalid 为 `INVALID_QUORUM_POLICY` 且全回滚。

### A-14 FINAL acknowledgement quorum and compatibility — 3
- **前置**：SENT group Step、多个 Responders；migrated quorum1 Incident。
- **操作**：提交独立 acknowledgements、exact duplicate、无 own-delivery responder、终态 replay；quorum 后 resolve 并
  前后读取 acknowledgements；调用 legacy endpoint。
- **可观察断言**：ack uniqueness/排序/count 正确；duplicate 优先 replayed=true；达到 quorum 前 Incident 仍 OPEN，
  达到时一次 ACK 并 supersede others；resolve 前后 `acknowledgements[]` 成员及 identity/timestamp 不变，且不要求
  `SPEC-GAP-06` 未发布的 resolution record；acknowledgedBy 仅 quorum1 populated；legacy quorum1 行为兼容。

## 8. B — 数据正确性、幂等与并发（25 分）

### B-01 Due, expiry and retry arithmetic oracle — 2
- **前置**：delays 0/1/60/86400，多失败 attempts。
- **操作**：创建 Incident 并控制 receiver responses/time boundaries。
- **可观察断言**：dueAt/expiresAt 来源于 createdAt；attempt backoff 1,2,4,...,60 秒封顶；expiry precedence 不被 retry 覆盖。

### B-02 Active dedup lifecycle and eternal replay — 2
- **前置**：同 service+dedupKey 的 OPEN 后 terminal Incident。
- **操作**：active identical/different create；terminal 后 fresh key create；再 replay 老 idempotency key。
- **可观察断言**：active 最多一个；terminal 后 fresh request 得新 ID；老 key 永远返回旧 Incident，不被 active-key reuse 改写。

### B-03 Atomic policy/incident rejection — 2
- **前置**：一个坏 target/delay/member 混入合法 policy 或 create。
- **操作**：提交混合请求并读 snapshot/receiver。
- **可观察断言**：整个 mutation 失败；无 partial Policy/Incident/Step/Delivery/Work/Event 或外部 request。

### B-04 Unknown-response durable replay — 2
- **前置**：response shield；Incident/Policy/Ack/Resolve/Acknowledgement mutations。
- **操作**：完整 upstream response 后断 client，重试，API restart 后再重试。
- **可观察断言**：原 status/semantic JSON/IDs 稳定；每业务 effect、Work/Event/ack record 一次。

### B-05 Same-key contention across two APIs — 2
- **前置**：两个 API、共享 PostgreSQL。
- **操作**：64 路相同 key/body；同 key different body；第三 API replay。
- **可观察断言**：唯一 saved result；different semantic `IDEMPOTENCY_CONFLICT`；无双 aggregate/effect chain。

### B-06 Distinct-key active-dedup contention — 3
- **前置**：同 service+dedupKey、不同 idempotency keys，identical 与 conflicting semantics。
- **操作**：两个 API 64 路并发，三个固定 interleavings。
- **可观察断言**：identical 收敛同一 active Incident；conflicting 只有一个 winner，其余稳定 conflict；每 winner 一套 captured Steps/Deliveries。

### B-07 Acknowledge, resolve and expiry races — 3
- **前置**：多个 SENT responders，接近 expiresAt。
- **操作**：Ack A vs Ack B、Ack vs expiry、Resolve vs expiry/duplicate Resolve。
- **可观察断言**：V1 最多一个 winner；expiry deadline 优先规则；合法单 terminal state；remaining Steps/Deliveries 不再新发送；events 连续。

### B-08 Step delivery order and terminal suppression — 3
- **前置**：多个 due Steps，第一个 receiver 持续失败，后 steps 变 due；另有 terminal transition。
- **操作**：两个 Workers 并发 claim/retry，期间 ack/resolve。
- **可观察断言**：successful V1 notifications stepIndex 递增；terminal commit 后不再产生新 business request；captured body 永不混用 policy/Responder 新值。

### B-09 Group notification quorum contention — 3
- **前置**：N receivers，quorum q，两个 Workers 同时完成第 q 个附近 deliveries。
- **操作**：确定性释放 ACK/500，三个 interleavings。
- **可观察断言**：每 responder Delivery effect at-most-once in state；Step 只从 PENDING→SENT 一次；successfulDeliveryAt/counter
  不被 later delivery 改写；无 duplicate notification identity。

### B-10 Parallel acknowledgement quorum races — 3
- **前置**：两个 SENT group Steps 均接近各自 ack quorum。
- **操作**：两个 API 同时提交最后 votes、duplicates、wrong-step votes。
- **可观察断言**：第一个达到 quorum 的 Step 独占 acknowledgementStepIndex；另一 Step 原子 supersede；所有已接受 ack immutable；
  duplicate 不加 count；wrong target `RESPONDER_NOT_IN_ACTIVE_QUORUM`；一个 ACK event。

## 9. C — Worker、恢复与持久性（20 分）

### C-01 Work lifecycle, shape and retention — 2
- **前置**：两 Work kinds 各 PENDING/LEASED/terminal。
- **操作**：经公开流程创建/完成并读 snapshot。
- **可观察断言**：exact enum/shape；lease fields 仅 LEASED；attempt/terminal 正确；terminal retained；drain 无 nonterminal。

### C-02 SIGKILL after `worker.claimed` — 2
- **前置**：due Step/expiry Work，claimed barrier held。
- **操作**：杀 Worker A，等 lease expiry，B reclaim。
- **可观察断言**：attempt 增加、effect 一次、A stale 不可提交；等待 barrier 时无开放 DB transaction。

### C-03 SIGKILL after business effect-complete — 2
- **前置**：receiver 已持久化完整 Notification 并返回/将返回 2xx，worker effect-complete barrier。
- **操作**：杀 A，启动 B。
- **可观察断言**：稳定 notification identity/body 可重试；Delivery/Step/Work/Event 最终收敛一次，不因 unknown ACK 永久丢失。

### C-04 SIGKILL at `worker.before-commit` — 2
- **前置**：delivery、expiry、quorum transition 各命中 before-commit。
- **操作**：杀 Worker，replacement 恢复。
- **可观察断言**：transaction 全无或完整一次；无 partial Delivery/Step/Incident/Work/Event。

### C-05 Expired-lease fencing — 3
- **前置**：A 暂停至 lease expired，B reclaim 并完成。
- **操作**：B commit 后释放 A。
- **可观察断言**：A stale owner/token 不可 terminalize 或覆盖 nextAttempt/state；最终 attempt/effect 只归 B。

### C-06 Terminal transition closes obsolete work/delivery — 3
- **前置**：ACK/RESOLVED/EXPIRED Incident 有 pending/leased Step 和 retrying Deliveries。
- **操作**：terminal mutation 与 Workers 竞争后 drain。
- **可观察断言**：remaining Steps/Deliveries SUPERSEDED，Work terminal/cancelled；late Worker 不发送新 request、不改 winner；无 immortal backlog。

### C-07 Unknown Domain Event webhook ACK — 3
- **前置**：Domain receiver 持久化完整 event 后暂停 ACK。
- **操作**：杀 Dispatcher，模拟 500/断线/timeout，由 replacement retry。
- **可观察断言**：Domain eventId/type/body 稳定且与 notificationId/body 不混淆；per aggregate 顺序递增；无新 event identity。

### C-08 Transactional event, ordering and quorum recovery — 3
- **前置**：V1/quorum ACK、expiry、resolve 成功与 rollback。
- **操作**：组合 worker/dispatcher barriers、SIGKILL/restart。
- **可观察断言**：业务 transition 与既有 event 同 transaction；rollback 无 event；quorum winner/Step supersede/Work terminal
  原子恢复；sequence 连续，snapshot/log 不泄密。

## 10. D — OpenAPI、UI 与跨层闭环（15 分）

### D-01 Independent OpenAPI/live-traffic validation — 2
- **前置**：FINAL API 与冻结 evaluator schema。
- **操作**：每 route 采 success 与 published errors 后验证。
- **可观察断言**：V1/quorum live bodies/status/headers 与 schema 一致；Candidate 文档不能自证。

### D-02 Production-browser V1 lifecycle — 2
- **前置**：production full stack、business/Domain receivers。
- **操作**：可见控件创建 Incident、观察 escalation、ack、resolve/expiry、timeline/events。
- **可观察断言**：UI 来源于真实 HTTP/PostgreSQL，异步进度与 receivers/snapshot 一致，刷新持久。

### D-03 Production-browser group/quorum lifecycle — 2
- **前置**：FINAL group policy 与多 Responders。
- **操作**：UI 配置 group step、查看每 notification、提交 votes、观察 quorum winner/supersede。
- **可观察断言**：delivery/ack counts、Step/Incident state、ack list/history 可见并与 snapshot 一致；legacy quorum1 仍可用。

### D-04 Loading, empty, conflict, stale, offline and permission — 2
- **前置**：slow/offline/401/409 fixtures。
- **操作**：逐一触发并 retry。
- **可观察断言**：状态可见、有语义、可恢复；retry 无第二 mutation/vote；token/body/private URL 不泄露。

### D-05 Keyboard, labels, focus and mobile — 2
- **前置**：desktop/mobile Chromium。
- **操作**：键盘完成 V1/quorum primary flows 和 validation error。
- **可观察断言**：控件可达、有 label/name；错误 focus 合理；移动端无不可达 action；关键 contrast WCAG AA。

### D-06 Project-owned gates are not fake green — 2
- **前置**：clean build/database。
- **操作**：逐个公开 test command，并外部观察真实 PostgreSQL/HTTP/Chromium/双 API/双 Worker/barrier/receivers。
- **可观察断言**：非 0 tests、失败不吞、不是字符串/文件检查；business delivery 与 Domain outbox 两边都实际穿过。

### D-07 README-to-evidence closure — 3
- **前置**：固定 requirement ledger。
- **操作**：逐项映射 `README → HTTP → OpenAPI → UI → snapshot/Work/Event/receivers → hidden evidence`。
- **可观察断言**：适用节点全部执行才 passing；SPEC-GAP 标 partial 且不计分；测试名/总 pass count 不能闭环。

## 11. E — 迁移、性能与可运维性（10 分）

### E-01 Populated V1→FINAL acknowledgement migration — 2
- **前置**：真实 V1 binary 创建 OPEN/ACK/RESOLVED/EXPIRED、一个 winning ack。
- **操作**：FINAL migration 后旧/新 APIs/snapshot 读取并重放 migration。
- **可观察断言**：每 V1 winner 恰好一个 acknowledgement record，timestamps/events 不变；V1 policy 映射 responderIds:[id], quorum=1；无 synthetic ack。

### E-02 Saved replay and delivery identity migration — 2
- **前置**：V1 acknowledge/create success/conflict/unknown replay，pending/retrying Notifications。
- **操作**：迁移、API/Worker restart 后 replay/retry。
- **可观察断言**：old status/body/IDs 仍有效；notificationId/body/URL/attempt 保留；旧 acknowledgement endpoint 行为兼容。

### E-03 Pending Work and Domain delivery continuity — 2
- **前置**：V1 PENDING/LEASED Steps/expiry，不同 lease/attempt；未 ACK Domain events。
- **操作**：迁移并由 replacement Worker/Dispatcher drain。
- **可观察断言**：Work/due/retry/event identity exact 保留；stale token fenced；最终 Incident/Step/Delivery/Event 收敛一次。

### E-04 HTTP sustained performance — 2
- **前置**：README `perf-v1` 精确 dataset、独占固定容器。
- **操作**：严格运行 `deduplicated-incident-ingest` 与 `incident-timeline-read` 的 selector/request/64 clients/10s+60s。
- **可观察断言**：ingest >=200/s p95<=250ms 且每十请求恰九 Incidents；timeline >=250/s p95<=150ms 且 contiguous；5xx=0；负载后 dedup/ordering oracle 全过。

### E-05 Escalation recovery performance and operability — 2
- **前置**：精确 3000 due Steps，两 Workers claimed 后 SIGKILL，receiver 204。
- **操作**：lease expiry 后两 replacements，按 45s timer；cleanup/repro/log audit。
- **可观察断言**：3000 Steps SENT、stable notification contract、无 nonterminal Work、<=45s、无 worker/receiver error；
  无遗留进程/端口/锁，日志无秘密，同 seed 功能结果一致。

## 12. Hard Caps、invalid 与 evaluator_error

| Failure | Cap |
| --- | ---: |
| clean build/migration/production boot 失败 | 25 |
| active dedup 唯一性、单 winner、terminal suppression 或 atomic rejection 失败 | 35 |
| replay/unknown/restart 产生第二 effect/vote | 30 |
| 成功业务缺 event、rollback 有 event、retry 改 event identity/body | 40 |
| SIGKILL 后 Work/Delivery 丢失或 stale Worker 可提交 | 40 |
| quorum partial winner、duplicate 增 count 或多 Step 同时获胜 | 35 |
| migration 丢 ack/delivery/replay/旧客户端 | 35 |
| 性能后核心不变量失败 | 性能 case 0，并应用 correctness cap |

读取 hidden/env、硬编码私有 fixture/seed/case、workspace 外访问、修改 evaluator、容器逃逸或伪造 evidence
为 `invalid`。Docker/PostgreSQL/Chromium/receiver/port 等 Harness 故障为 `evaluator_error`。watchdog 仅保护
Evaluator，不是 Coding Harness turn timeout，也不新增业务 deadline。

## 13. Anti-fake-green

1. due/retry/quorum/dedup expected 来自独立 oracle；
2. business Notification receiver 与 Domain Event receiver 分开记录和断言；
3. Candidate tests/OpenAPI 不自证，只用于 D-06 gate 真实性；
4. 不把 route/file/test-name/log 当行为证据；
5. recovery 必须 barrier+signal+replacement，并发必须独立 processes；
6. performance 只统计完整且通过 oracle 的响应，负载后重跑 dedup/Work/Event invariants；
7. Incident state 至少由 HTTP、snapshot、receiver/timeline 中两个 seam 交叉验证。

## 14. Requirement mapping

### 14.1 Compact contract-map

每个 Case 只在下表出现一次；该行列出的合同条款共同构成该 Case 的唯一 expected-value 来源，`SPEC-GAP`
仅限定不计分边界，不补写要求。

| Case range | 唯一 Public Contract 条款 |
| --- | --- |
| A-01～A-03 | README commands/env、migration、seed validation/atomicity |
| A-04～A-06 | README HTTP/OpenAPI/errors、pagination、verification snapshot |
| A-07～A-12 | README V1 policy/Incident/dedup/due/delivery/ack/resolve/expiry/timeline/events |
| A-13～A-14 | FINAL Manager group policy、ordered notifications、delivery/ack quorum、legacy compatibility |
| B-01～B-03 | README due/retry/expiry arithmetic、active dedup、atomic rejection |
| B-04～B-05 | README durable idempotency replay、fingerprint、two-API same-key contention |
| B-06～B-08 | README active-key uniqueness、terminal races、ordered notification/suppression |
| B-09～B-10 | FINAL Manager delivery quorum、parallel acknowledgement quorum、immutable acknowledgements |
| C-01～C-06 | README Work lifecycle、barriers、lease recovery/fencing、notification retry、terminal convergence |
| C-07～C-08 | README five V1 events、transactional outbox/dispatcher ordering；FINAL Manager event compatibility |
| D-01～D-07 | README OpenAPI/live traffic、production UI、accessibility、project tests/handoff；FINAL UI flows |
| E-01～E-03 | FINAL migration rules：V1 winner、pending retry、saved replay/event identity |
| E-04～E-05 | README fixed perf-v1 workloads、correctness-under-load、operability |

### 14.2 旧 H Gates 映射

| 旧 Gate | v2 cases |
| --- | --- |
| H-01 | A-01～A-03、E-05 |
| H-02 | A-04～A-07、D-01、D-04、D-05 |
| H-03 | A-08～A-12 |
| H-04 | A-05、B-01～B-03 |
| H-05 | B-04、B-05 |
| H-06 | B-06～B-10 |
| H-07 | C-01～C-06 |
| H-08 | C-07、C-08 |
| H-09 | E-01～E-03 |
| H-10 | A-13、A-14、B-09、B-10 |
| H-11 | C-02～C-08、D-03 |
| H-12 | E-04、E-05 |
| H-13 | D-06、D-07、E-05 |

## 15. Calibration mutants

| Mutant | 必须命中的 cases |
| --- | --- |
| dedupKey 全历史唯一，terminal 后不能 reuse | B-02 |
| Incident 动态读取 current policy | A-08、B-08 |
| retry 新建 notificationId/body | A-09、C-03 |
| expiry 晚于 ack/delivery 执行 | A-11、B-01、B-07 |
| process-local idempotency | B-04、B-05 |
| 无 active-key DB 唯一性 | B-06 |
| ack 第一票即 supersede（quorum>1） | A-14、B-10 |
| Group Step 第一 delivery 即 SENT | A-13、B-09 |
| duplicate ack 在 terminal 后 conflict/增 count | A-14、B-10 |
| terminal 后 Worker 仍发送 Notification | B-08、C-06 |
| 无 Work fencing | C-02～C-05 |
| 混淆 business Notification 与 Domain Event | A-09、C-07 |
| event 事务外插入或 retry 新 ID | A-12、C-07、C-08 |
| migration 丢 pending retry/old ack replay | E-01～E-03 |
| OpenAPI 仅 paths 无 group schema | D-01 |
| UI/项目测试只字符串假绿 | D-02、D-03、D-06 |
| 只报吞吐不验 exact 9/10 dedup | E-04 |

Gold 全通过；每 mutant 由预期 case 定向捕获且同 seed 三次一致。冻结 evaluator image、V1/FINAL binaries、
contract map、fixtures、oracle、manifest 与性能分布后才可正式 A/B。

## 16. 实施顺序与完成标准

按 vertical slices：A-01/A-03/A-08 → B-01/B-02 → B-04/B-05 → C-02/C-05 → D-01/D-02 →
A-13/A-14/B-10 → E-01～E-03 → E-04/E-05 → 其余 cases/mutants；每 slice 先 mutant 红，再 gold 绿。

正式启用条件：44 个唯一 case、五维与总分精确、只走第 3 节 seams、SPEC-GAP 不计分、真实 V1 checkpoint、
gold/mutants/multi-seed calibration 完整；Baseline/Native/Guide 共用 frozen submission、seed、image、case、
权重与阈值，Evaluator 不读取实验 arm、Skill Bank、Guide exposure 或 trajectory。
