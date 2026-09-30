# DockChain Hidden Test v2 详细设计

本任务设计遵循 [`docs/hidden-test-v2-standard.zh-CN.md`](../../../docs/hidden-test-v2-standard.zh-CN.md)；
下文只定义 DockChain 的任务专属合同映射、oracle、fixtures、Cases、Hard Caps 与 mutants。

## 1. 目标与边界

本方案把 H-01～H-13 拆成 **44 个独立、确定性、Harness-owned 黑盒 case**。测试只通过 Public
Contract 发布的命令、HTTP、snapshot、production browser、receiver、barrier 与进程信号观察行为；
不得 import Candidate 源码、读取 ORM/私有表或把 Candidate 自测当 expected value。

测试重点是完整资源束原子性、半开区间容量、确定性资源选择、Standby 公平性、Clearance recovery 与
Manager linked movements。本文只设计测试，不修改 README、Manager 合同、性能阈值或 runner。

## 2. 权威来源与合同缺口

权威顺序：V1 `workspace/README.md` → T16 固定 Manager 变更 → `workspace/AGENTS.md` → `CONTEXT.md`。
本文件只能映射这些合同。

不得计分的 `SPEC-GAP`：

- `SPEC-GAP-01`：`ResourceAllocation` wire shape 没有 `portCallId` 或 `movementId`。Evaluator 可由
  PortCall/PortMovement 公开字段和全局 allocation 集合验证容量与全有全无，但不得要求一个未发布的归属字段。
- `SPEC-GAP-02`：V1 `StandbyEntry` 有 `WITHDRAWN` 状态，却没有发布 withdraw mutation。可验证 seed 中
  WITHDRAWN 不再 promotion，但不能要求 UI/API 提供撤回动作。
- `SPEC-GAP-03`：Manager 没有定义 linked ARRIVAL/DEPARTURE 的 Standby request、wire shape 或 promotion
  规则。FINAL 测试继续覆盖 V1 one-movement Standby；不得把两段 movement 字段塞进 Standby。
- `SPEC-GAP-04`：Manager 没有发布 movement 专属 Domain Event type。不得要求新事件名；只有与 V1 相同
  aggregate transition 时才可复用 V1 type，否则不要求事件。
- `SPEC-GAP-05`：`Clearance.checkedRules` 的具体字符串集合未发布。测试验证它是 exact wire field、结果稳定且
  Clearance 基于捕获的 vessel/resource snapshot，不规定隐藏 rule names。

## 3. 冻结的公开 seams

| Seam | 允许操作 | 禁止操作 |
| --- | --- | --- |
| Public commands | README npm install/migrate/seed/build/start/test commands | import 私有模块/helper |
| HTTP | health、OpenAPI、全部公开 `/api/v1` routes | debug/private routes |
| Verification snapshot | ADMIN_TOKEN 读取同一 PostgreSQL point-in-time | 直查表、锁或 ORM |
| Production browser | production build、系统 Chromium、可见控件 | 页面注入或内部 store |
| Webhook receiver | 控制 Domain Event ACK/500/断线 | 读取 outbox |
| Recovery barrier | 公开 worker/dispatcher barrier protocol | sleep 猜 claim/commit |
| Process boundary | 真实双 API/双 Worker/Dispatcher 与 signals | 单进程对象冒充并发 |
| V1→FINAL checkpoint | 冻结 V1 binary 创建历史后升级同一库 | FINAL 伪造 V1 状态 |

若关联关系无法从这些 seam 观察，应先补合同，不得穿透私有数据库。

## 4. Runner、结果与 Case 约定

建议 `evaluator/v2/{manifest,contract-map,run,lib,fixtures,cases,calibration}`。每 case 独立数据库、端口、
managed root、receiver、barrier 与进程组；仅 migration case 复用 V1 数据库；性能 case 独占 4 CPU/8 GiB。

下文 Case 标题给出唯一 ID/维度/权重；每项明确前置 fixture、公开操作、mandatory 可观察断言；第 14.1 节
给出不重叠的合同映射。失败时 private failure code 固定为 `DC_<CASE_ID>_FAILED`（Case ID 中 `-` 转为 `_`）；
最小公开类别固定为 `A=contract`、`B=correctness`、`C=recovery`、`D=cross_layer`、`E=compat_perf`。
Case 内任一 mandatory assertion 失败即 0 分。结果区分 `failed`、`invalid`、`evaluator_error`。

## 5. 独立 oracle 与 fixtures

### 5.1 Bundle allocation oracle

Evaluator 对每个 15 分钟半开 bucket 独立计算：

1. vessel length 必须小于等于 Berth maxLength 且完整 interval 位于 availability；
2. 一个 Berth 在任一 instant 最多一个非 terminal consuming Port Call/Movement；
3. Tug Pool 与 Yard Window 分别按 interval segments 累加 quantity，不得超过 capacity 或小于零；
4. 分别按 Berth `(priority,berthId)`、Tug `(priority,tugPoolId)`、Yard
   `(priority,yardWindowId)` 选择各自第一个满足完整 interval/capacity 的资源，再把三项 allocation 原子提交；
5. linked movements 分别投影两个完整 bundles，但创建 transaction 必须全成或全败；
6. Standby 候选 arrival 每 15 分钟递增，order 为 priority desc、requestedAt asc、ID asc，同 priority
   的 infeasible head 不能被后项绕过。

区分性 worked example：capacity=2 的 Tug Pool 上，Call A `[T0,T1)` 用 2，Call B `[T1,T2)` 用 2，
两者合法；把闭区间或简单“所有重叠总和”实现会错误拒绝。另设最高优先 Berth 可用、最高优先 Tug 不足而
次优 Tug 可用、最高优先 Yard 可用；正确结果保留该 Berth，选择次优 Tug 与首个 Yard，并在一个 transaction
提交三项 allocation。把资源预绑定成三元组并因此跳过首个 Berth 是错误实现。

### 5.2 确定性与 fixture families

- 私有 `evaluationSeed + caseId + ordinal` 生成 UUID、时间、请求 key 与 interleaving；`T0` 取可观察
  当前时间后的安全窗口；同 submission+seed 可复现；并发至少三个固定 seed。

| Fixture | 用途 |
| --- | --- |
| F-EMPTY | clean boot、migration、validation |
| F-RESOURCE-GRID | 多 Berth/Tug/Yard priorities、availability、边界容量 |
| F-PORT-CALL | HELD/CLEARED/IN_SERVICE/terminal 全状态 |
| F-STANDBY | priority/tie/head blocked/promotion/withdrawn |
| F-IDEMPOTENCY | 每 mutation replay/conflict/unknown response |
| F-WORK | 三类 Work、不同 attempt/lease/terminal |
| F-EVENT | 多 aggregate sequence、未 ACK/重试/已 ACK |
| F-LINKED | 两 movement、独立 bundles、gap/expiry/cancel races |
| F-MIGRATION | V1 全状态、saved replay、pending Clearance、events |
| F-BROWSER | V1/linked flows 与错误状态 |
| F-PERF-V1 | README 精确 1k berths/20 tug/20 yard/100k vessels/51.5k calls |

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
- **前置**：空库、无依赖/构建产物、合法 env。
- **操作**：install、重复 migrate、build，独立启动 API/Worker/Dispatcher，访问 health/OpenAPI 后 SIGTERM。
- **可观察断言**：命令非交互、失败非零；仅 127.0.0.1；三个角色独立；正常退出且无遗留子进程。

### A-02 Repeatable populated migration — 2
- **前置**：F-PORT-CALL/F-STANDBY populated database。
- **操作**：迁移两次、seed、经公开 API 增加状态，再迁移两次。
- **可观察断言**：PortCall/allocation/Standby/Clearance/Work/Event 与 replay identity 不变；失败无 partial schema behavior。

### A-03 Atomic deterministic seed — 2
- **前置**：合法 seed 及 unknown key、duplicate ID、missing ref、priority collision、capacity break、bad interval/state/int fixtures。
- **操作**：合法导入、same digest replay、same version different content、逐个非法导入。
- **可观察断言**：合法 exact；replay no-op；冲突 `SEED_VERSION_CONFLICT`；非法导入后 snapshot/Work/Event/idempotency 不变。

### A-04 OpenAPI 3.1 exact contract — 2
- **前置**：FINAL production API。
- **操作**：与冻结 evaluator schema 比较 routes、bodies、responses、errors、nullable/required/additionalProperties。
- **可观察断言**：V1 与 movement APIs 全覆盖，ResourceAllocation 不含未发布归属字段，所有 live shape 可由独立 schema 验证。

### A-05 Common errors and interval boundaries — 2
- **前置**：最小可行 F-RESOURCE-GRID。
- **操作**：非 JSON、坏 JSON、unknown field、auth/not-found/cursor；测试 15 分钟 alignment、60/1440 分钟、
  quantity/int/timestamp 边界和 120 分钟 turnaround gap。
- **可观察断言**：exact error envelope/code；合法边界成功，非法 `INVALID_PORT_CALL_INTERVAL` 或
  `TURNAROUND_GAP_TOO_SHORT`，零资源/Work/Event 副作用。

### A-06 Pagination, reads and snapshot — 2
- **前置**：每个 collection >110 条，多类资源。
- **操作**：list/detail 翻页，读取 schedule、snapshot、events。
- **可观察断言**：limit/cursor 无重无漏；exact keys/shapes/sorts；同一 asOf；递归 omit `*Token`/secret；
  Work terminal/lease fields 正确。

### A-07 Feasible-window search and ordering — 2
- **前置**：F-RESOURCE-GRID 含多个可行/不可行三元组与分页。
- **操作**：按公开 query 搜索七日窗口并翻页。
- **可观察断言**：只返回全 interval 可行窗口；15 分钟递增；完整 `(arrival,berth priority/id,tug priority/id,yard priority/id)` 排序和 cursor 正确。

### A-08 Atomic deterministic Port Call hold — 2
- **前置**：多个候选 bundle，只有部分完整可行。
- **操作**：POST V1 Port Call，随后 detail/schedule/snapshot。
- **可观察断言**：201 HELD、expiresAt=transaction time+180s；选择第一个完整 bundle；三类 allocation 全有；
  expiry Work 与 `port-call.held` event 各一次。无 bundle 时 `WINDOW_UNAVAILABLE` 且全无。

### A-09 Confirm, Clearance and start-service — 2
- **前置**：HELD Call，captured vessel/resource snapshot。
- **操作**：到期前 confirm、运行 Clearance Worker、start-service；另从 HELD 直接 start。
- **可观察断言**：confirm 原子创建一个稳定 Clearance Task；PASSED 后 CLEARED；仅 CLEARED 可 IN_SERVICE；
  HELD 返回 `CLEARANCE_REQUIRED`；Clearance 使用创建时 snapshot，不受 seed 外后续想象状态影响。

### A-10 Complete, cancel and expiry — 2
- **前置**：HELD/CLEARED/IN_SERVICE Calls。
- **操作**：complete、cancel、在 expiresAt 前后 confirm，并让 expiry Worker 运行。
- **可观察断言**：只有 IN_SERVICE 可 COMPLETED；cancel 仅合法状态且资源释放一次；到期确认原子 EXPIRED；
  terminal 重试不复活资源，稳定错误与 events 正确。

### A-11 Standby creation and deterministic promotion — 2
- **前置**：同 priority head blocked、后项可行；另一 priority；可释放 bundle。
- **操作**：创建 WAITING entries，触发 cancel/expiry/completion 释放并运行 promotion Workers。
- **可观察断言**：server requestedAt；排序 priority desc/requestedAt/id；同 priority infeasible head 不被绕过；
  promotion 一次生成完整 PortCall/bundle、Entry=PROMOTED；seed WITHDRAWN 永不 promotion。

### A-12 Schedule and Domain Event query — 2
- **前置**：多 Call/Standby lifecycle。
- **操作**：读取 15 分钟 schedule、按 aggregate/sequence 查询 events，由 receiver 接收。
- **可观察断言**：Berth occupancy、Tug/Yard allocated/capacity 与 oracle 一致；V1 type、payload `{}`、sequence 连续；rollback 无 event。

### A-13 FINAL linked-call creation and compatibility — 3
- **前置**：Manager FINAL、两段各有独立可行 bundle，另有一段不可行和 gap<120 fixtures。
- **操作**：POST two-movement body；并调用冻结 V1 create/read client。
- **可观察断言**：ARRIVAL+DEPARTURE 同 transaction 创建，顺序固定，各自 expiresAt；任一失败全回滚；新 Call
  legacy singular fields 全 null，migrated/V1 Calls 保持 populated；V1 client 行为兼容。

### A-14 Movement lifecycle and aggregate projection — 3
- **前置**：linked Call 的两 Movements，覆盖 confirm/clear/start/complete/cancel/expiry 组合。
- **操作**：调用 movement endpoints 并在每次 transition 后读完整 Call/snapshot。
- **可观察断言**：clearanceTaskId 首次成功 confirm 原子赋值且 replay 稳定；每 movement 最多 start/complete 一次；
  ARRIVED/COMPLETED/CANCELLED/EXPIRED/HELD 严格按发布投影；arrival complete 后 departure cancel 只释放 departure。

## 8. B — 数据正确性、幂等与并发（25 分）

### B-01 Half-open interval and capacity oracle — 2
- **前置**：相邻 `[T0,T1)`/`[T1,T2)` 与 1ms overlap bundles。
- **操作**：创建 Calls、查询 schedule/snapshot。
- **可观察断言**：相邻可各占满；1ms overlap 进行真实冲突；任意 bucket Berth<=1、Tug/Yard 在 0..capacity。

### B-02 Deterministic complete-bundle selection — 2
- **前置**：首个 Berth 可行、首个 Tug 不足而次个 Tug 可行、首个 Yard 可行；另有各资源 ID tie fixtures。
- **操作**：重复搜索与创建。
- **可观察断言**：创建分别选择首个 feasible Berth、Tug、Yard 后原子 reserve；搜索结果仍按 README 发布的完整 tuple 排序；不得把资源预绑定成候选三元组而跳过首个可行资源，重启后稳定。

### B-03 Atomic rejection and no partial allocation — 2
- **前置**：分别让 Berth、Tug、Yard 任一资源不足；混合非法 request。
- **操作**：创建 V1/linked Calls。
- **可观察断言**：稳定 conflict，PortCall/Movement/allocation/Work/Event 全无；既不负容量也不遗留 hold。

### B-04 Unknown-response durable replay — 2
- **前置**：response shield；Create/Confirm/Start/Cancel/Complete/Standby/movement mutations。
- **操作**：完整 upstream response 后断 client，重试并重启 API 后再重试。
- **可观察断言**：原 status/semantic JSON/IDs 不变；每个 aggregate、allocation、Work、event effect 一次。

### B-05 Same-key contention across two APIs — 2
- **前置**：两个 API、共享 PostgreSQL。
- **操作**：64 路同 key/body，并发同 key/different body，第三 API replay。
- **可观察断言**：唯一结果；different semantic 为 `IDEMPOTENCY_CONFLICT`；无双 PortCall 或双 Clearance。

### B-06 Distinct-key hot bundle contention — 3
- **前置**：容量只够一个 Call 的完整 bundle。
- **操作**：两个 API 用不同 keys 并发 64 个请求，三个固定 interleavings。
- **可观察断言**：成功数与 oracle 一致，losers `WINDOW_UNAVAILABLE`；任何瞬间/最终无 Berth double-book 或容量超订。

### B-07 Clearance/start/cancel/expiry races — 3
- **前置**：HELD/CLEARED、expiresAt 附近、两个 Worker。
- **操作**：Confirm vs expiry、Clearance vs cancel、Start vs cancel、Complete vs cancel。
- **可观察断言**：每组一个合法 winner；loser 稳定 conflict；一个 terminal effect、一个资源释放、合法 contiguous events，Call 不复活。

### B-08 Standby fairness under concurrent release — 3
- **前置**：多 priority/tie、infeasible head、两个 release sources、两个 promotion Workers。
- **操作**：并发释放和 claim promotion，三个 interleavings。
- **可观察断言**：严格 order，同 priority head 不被绕过；每 Entry 至多一个 PortCall；同 bundle 无 partial/oversubscription；重复 Work 收敛。

### B-09 Linked two-bundle atomicity and deadlock freedom — 3
- **前置**：Call X 按时间占 A→B，Call Y 反向竞争 B→A，容量只够一个。
- **操作**：两个 API 同时创建 linked Calls，交换输入 ID/时间顺序。
- **可观察断言**：无 deadlock；至多一个完整成功；另一完整失败；不能观察单 movement、单 resource 或 orphan Work/Event。

### B-10 Concurrent movement transitions and aggregate state — 3
- **前置**：两个 CLEARED/IN_SERVICE movements。
- **操作**：并发 complete/cancel/expiry/clearance，含 arrival in-service 时 departure expiry。
- **可观察断言**：每 movement transition once；aggregate 按发布优先规则确定；arrival 已开始时不被 departure expiry 取消；
  各自资源只释放一次，sequence/Clearance identities 合法。

## 9. C — Worker、恢复与持久性（20 分）

### C-01 Work schema, lifecycle and retention — 2
- **前置**：三 kind 的 PENDING/LEASED/terminal Work。
- **操作**：通过公开流程创建并完成 Work，读取 snapshot。
- **可观察断言**：exact enum/shape；lease fields 只在 LEASED；attempt/terminal 正确；terminal retained；drain 无 `terminal:false`。

### C-02 SIGKILL after `worker.claimed` — 2
- **前置**：CLEARANCE/EXPIRY/PROMOTION 各一个 due Work。
- **操作**：claimed barrier held，杀 A，等 lease expiry，B reclaim。
- **可观察断言**：attempt 增加、effect 一次、stale A 不可 terminal commit；无开放 transaction 等待 barrier。

### C-03 SIGKILL after `worker.effect-complete` — 2
- **前置**：Clearance validation 或 promotion decision 已完成但未 commit。
- **操作**：effect-complete 杀 A，启动 B。
- **可观察断言**：effect 可安全重做或完成，Call/Movement/allocation/Work/Event 不重复且不永久悬挂。

### C-04 SIGKILL at `worker.before-commit` — 2
- **前置**：三 kind 各命中 before-commit barrier。
- **操作**：杀 Worker，replacement 恢复。
- **可观察断言**：原 transaction 全无或完整一次；无 partial bundle、mixed state 或 orphan event。

### C-05 Expired-lease fencing — 3
- **前置**：A 暂停至 lease 过期，B reclaim 并完成。
- **操作**：B commit 后释放 A。
- **可观察断言**：A stale owner/token 不能写 terminal/aggregate/allocation；最终 attempt/effect 只归 B。

### C-06 Manual transitions close obsolete Work — 3
- **前置**：HELD Call 有 expiry，confirm/cancel；WAITING 有 promotion；linked movement 有 Clearance。
- **操作**：人工 transition 与 Worker 竞争后 drain。
- **可观察断言**：无需的 expiry/clearance/promotion Work terminal/cancelled；后到 Worker 不改变 winner；无 immortal backlog。

### C-07 Unknown webhook ACK and ordered retry — 3
- **前置**：receiver 持久化完整 event request 后暂停 ACK。
- **操作**：杀 dispatcher；模拟 500/断线/timeout，replacement 重试。
- **可观察断言**：eventId/type/body 稳定，per aggregate 成功 sequence 递增，ACK 后不创造新 event identity。

### C-08 Transactional events and linked recovery — 3
- **前置**：V1 与 movement lifecycle 的成功/rollback/race。
- **操作**：组合 worker/dispatcher barrier 崩溃和 restart。
- **可观察断言**：成功 V1 aggregate transition 与 event 同 transaction；rollback 无 event；linked 操作即使无新 event type，
  Movement/Call/Work/allocation 仍原子收敛；snapshot/log 不泄露 token/path。

## 10. D — OpenAPI、UI 与跨层闭环（15 分）

### D-01 Independent OpenAPI/live-traffic validation — 2
- **前置**：FINAL production API 与 evaluator contract schema。
- **操作**：每 route 收集 success 和 published error。
- **可观察断言**：live status/body/header 通过独立 schema；nullable legacy fields、movement array 与 runtime 一致。

### D-02 Production-browser V1 lifecycle — 2
- **前置**：production UI/API/PostgreSQL/Workers。
- **操作**：仅可见控件搜索→hold→confirm→clear→start→complete/cancel，查看 schedule/events。
- **可观察断言**：UI 与 HTTP/snapshot 同步、刷新持久、异步进度真实；不得用 direct API 替 primary action。

### D-03 Production-browser Standby and linked movements — 2
- **前置**：容量不足与 Manager FINAL。
- **操作**：UI 创建/观察 V1 Standby promotion；创建 linked Call 并分别操作两个 Movements。
- **可观察断言**：完整 bundle、fair order、两 movement 状态/资源/aggregate 可见；不要求未发布 linked Standby。

### D-04 Loading, empty, conflict, stale, offline and permission — 2
- **前置**：slow/offline/401/409 fixtures。
- **操作**：触发各 UI 状态并 retry。
- **可观察断言**：状态可见且可恢复；retry 不重复 hold/transition；ADMIN_TOKEN 不进 bundle、页面或日志。

### D-05 Keyboard, labels, focus and mobile — 2
- **前置**：desktop/mobile Chromium。
- **操作**：键盘执行 V1/linked primary flows 和 validation error。
- **可观察断言**：控件可达、有 label/name；错误 focus 合理；移动端无不可达 action；关键 contrast 达 WCAG AA。

### D-06 Project-owned gates are not fake green — 2
- **前置**：clean database/build。
- **操作**：逐个执行公开测试 command，并外部观察真实 PostgreSQL/HTTP/Chromium/双 API/双 Worker/barrier。
- **可观察断言**：非 0 tests、失败不吞；不是字符串/文件检查；concurrency/recovery 真正命中资源竞争和 signals。

### D-07 README-to-evidence closure — 3
- **前置**：固定 requirement ledger。
- **操作**：映射 `README → HTTP → OpenAPI → UI → snapshot/Work/Event → hidden evidence`。
- **可观察断言**：所有适用节点实际执行才 passing；SPEC-GAP 节点标 partial/excluded 且不计分；test name 不算证据。

## 11. E — 迁移、性能与可运维性（10 分）

### E-01 Populated V1→FINAL movement migration — 2
- **前置**：真实 V1 binary 创建每个 Call state（含 EXPIRED）、allocations/history。
- **操作**：FINAL migration 后旧/新 API 与 snapshot 读取并重放 migration。
- **可观察断言**：每 V1 Call 恰好一个 ARRIVAL Movement，state exact；aggregate/singular fields/resource history/events 不变；无 synthetic transition。

### E-02 Saved replay and event identity migration — 2
- **前置**：V1 create/confirm/cancel success/conflict/unknown responses 与 webhook history。
- **操作**：迁移、重启后 replay。
- **可观察断言**：saved JSON byte-equivalent、IDs/status 不变；committed event identity/body/sequence 不改；旧客户端继续工作。

### E-03 Pending Clearance and delivery continuity — 2
- **前置**：V1 PENDING/LEASED Clearance，不同 attempt/lease；未 ACK events。
- **操作**：迁移并由 replacement Worker/Dispatcher 完成。
- **可观察断言**：Work 关联迁移 ARRIVAL、claim/notification identity 保留；stale token fenced；最终 Call state/资源/事件一次。

### E-04 Read/create sustained performance — 2
- **前置**：README 精确 perf-v1 数据与独占固定容器。
- **操作**：严格执行 `feasible-window-read` 与 `port-call-create` 的 setup/selector/64 clients/10s+60s。
- **可观察断言**：read >=120/s、p95<=220ms；create >=25/s、p95<=700ms；5xx=0；只统计完整且通过 bundle oracle 的响应；负载后无超订。

### E-05 Clearance recovery performance and operability — 2
- **前置**：精确 1500 HELD+pending Clearance，两 Workers claimed 后 SIGKILL。
- **操作**：lease expiry 后两 replacements，按 60s timer；再做 cleanup/repro/log audit。
- **可观察断言**：1500 Calls exactly-once CLEARED、backlog drain<=60s、stale 不提交、capacity 全正确；无遗留进程/端口/锁，日志无秘密，同 seed 功能结果一致。

## 12. Hard Caps、invalid 与 evaluator_error

| Failure | Cap |
| --- | ---: |
| clean build/migration/production boot 失败 | 25 |
| Berth double-book、Tug/Yard 超订/负数或 bundle partial | 35 |
| replay/unknown/restart 产生第二业务效果 | 30 |
| 成功 V1 transition 缺 event、rollback 有 event、retry 改 event | 40 |
| SIGKILL 后 Work 丢失或 stale Worker 可提交 | 40 |
| linked Call partial Movement/allocation 或 aggregate 非法 | 35 |
| migration 丢状态/资源历史/replay/旧客户端 | 35 |
| 性能后核心不变量失败 | 性能 case 0，并应用 correctness cap |

读取 hidden/env、硬编码私有 fixture/seed/case、访问 workspace 外、修改 evaluator、容器逃逸或伪造 evidence
为 `invalid`。Harness 的 Docker/PostgreSQL/Chromium/receiver/端口故障为 `evaluator_error`。watchdog 只防
evaluator 永久失联，不是 Agent turn timeout，也不新增产品 deadline。

## 13. Anti-fake-green

1. expected bundle/capacity/order 来自独立 oracle；
2. Candidate tests 只证明 D-06 自有 gate，不能代替 hidden assertions；
3. Candidate OpenAPI 不自证；Evaluator 用冻结 schema 验 live traffic；
4. 文件、route 字符串、测试名、日志自述都不是业务证据；
5. recovery 用 barrier+signal+replacement，并发用独立进程；
6. performance 后重跑 allocation、Work、Event、replay 全不变量；
7. 至少两个公开观察面交叉验证 Call/Movement/resources。

## 14. Requirement mapping

### 14.1 Compact contract-map

下表范围互不重叠；每个 Case 只以所在行的冻结条款集合决定 expected value。

| Case range | 唯一 Public Contract 条款集合 |
| --- | --- |
| A-01～A-03 | V1 README「Required stack/commands」「Environment」「Seed contract」「Handoff」 |
| A-04～A-06 | V1 README「HTTP and OpenAPI 3.1」「V1 verification snapshot」 |
| A-07～A-12 | V1 README「Domain and V1 behavior」「Deterministic policy」「public aggregate routes」「Workers, events, and recovery」 |
| A-13～A-14 | 固定 Manager 规则 1～16、PortMovement wire schema、changed APIs/errors |
| B-01～B-03 | V1 README「Deterministic policy」「Mandatory invariants」与 atomic hold/rejection routes |
| B-04～B-05 | V1 README「Durable idempotency」 |
| B-06～B-08 | V1 README multi-process invariants、terminal races 与 Standby promotion 规则 |
| B-09～B-10 | 固定 Manager linked-movement atomicity、state projection 与 race 规则 |
| C-01～C-06 | V1 README Worker lease/barrier 合同及 Manager movement Work/fencing 规则 |
| C-07～C-08 | V1 README Domain Event/dispatcher 合同与 Manager event compatibility 规则 |
| D-01～D-07 | V1 README OpenAPI、Real UI、project-owned verification、Handoff 及 Manager 规则 15 |
| E-01～E-03 | 固定 Manager migration/replay/pending Work 规则 10～13、16 |
| E-04～E-05 | V1 README 三个 fixed performance scenarios 与 Manager 性能兼容合同 |

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
| 闭区间而非半开 | B-01 |
| 把 Berth/Tug/Yard 预绑定为三元组并跳过某类首个 feasible resource | A-07、A-08、B-02 |
| allocation 分步提交 | B-03、B-09 |
| process-local idempotency | B-04、B-05 |
| 无数据库唯一性导致 Berth double-book | B-06 |
| cancel/expiry 重复释放 capacity | A-10、B-07 |
| Standby 跳过同 priority infeasible head | A-11、B-08 |
| linked movements 分两 transaction 创建 | A-13、B-09 |
| movement expiry 错误取消已 IN_SERVICE arrival | A-14、B-10 |
| 无 Work fencing | C-02～C-05 |
| dispatcher retry 新 eventId | C-07 |
| event 业务 transaction 外插入 | A-12、C-08 |
| migration 不保留 EXPIRED state/singular fields | E-01 |
| migration 改写 saved replay | E-02 |
| OpenAPI nullable/array 与 live 不符 | D-01 |
| UI/项目测试只检查字符串 | D-02、D-03、D-06 |
| 只报吞吐不验 capacity | E-04、E-05 |

Gold 全通过；每 mutant 被预期 case 定向捕获且同 seed 三次一致。冻结 image、V1/FINAL binaries、
contract map、fixture generator、manifest、oracle 和性能分布后才能正式 A/B。

## 16. 实施顺序与完成标准

按 vertical slices：A-01/A-03/A-08 → B-01/B-02 → B-04/B-05 → C-02/C-05 → D-01/D-02 →
A-13/A-14/B-09 → E-01～E-03 → E-04/E-05 → 其余 cases/mutants。每 slice 先让定向 mutant 红，再让 gold 绿。

正式启用条件：44 个唯一 case、五维和总权重精确、只走第 3 节 seams、SPEC-GAP 不计分、真实 V1 checkpoint、
gold/mutant/multi-seed calibration 完整；Baseline/Native/Guide 使用同一 frozen submission、seed、image、cases、
权重与阈值，Evaluator 不读取实验 arm、Skill Bank、Guide exposure 或 trajectory。
