# CommerceCommand Hidden Test v2 详细设计

> 共享计分、隔离、证据与报告规则见 [`docs/hidden-test-v2-standard.zh-CN.md`](../../../docs/hidden-test-v2-standard.zh-CN.md)；本文件只定义 CommerceCommand 的 task-specific cases、oracles、fixtures 和 contract gaps。公开 Task Contract 优先。

## 1. 目标、权威来源与合同缺口

本方案将 H-01～H-30 拆为 **55 个独立、确定性、Harness-owned 黑盒 case**。所有断言只经过公开 commands、HTTP/OpenAPI、verification snapshot、production browser、webhook、process/recovery boundaries。

权威顺序：`workspace/README.md` V1 → `orchestration/manager-prompt.zh-CN.md` 固定 Manager 需求 → `AGENTS.md`/`CONTEXT.md` → 本文件。

正式实现前必须冻结：

- `CC-GAP-01`：Balanced Ledger 说 capture 使用“documented account names”，但 README 未列 account enum/借贷方向。Evaluator 可断言 journal/currency 平衡、amount 与 transition identity，不能发明 account 名。
- `CC-GAP-02`：Manager 只给 SettlementAdjustment exact shape；SellerAllocation、SellerSettlement、CommerceDispute 的 ID 生成/返回位置、完整 resource shapes、states、GET/read routes、mutation success status/body、snapshot keys/sorts 均未发布。后续 close/resolve 需要的 resource ID 也没有公开取得合同。不能从现有 adapter 或实现反推 hidden contract。
- `CC-GAP-03`：checkout 要处理 provider timeout/connection loss，但没有公开 SANDBOX provider fault-control URL/protocol。可通过 callback/reconcile 的 UNKNOWN 测 convergence；不能私自定义 outbound provider stub seam。
- `CC-GAP-04`：README 要求 Barrier-controlled recovery，却没有发布 barrier points、request body/header、hold/release/lease-loss 语义。C-02～C-08 及任何依赖 claim/response barrier 的性能场景在协议冻结前全部 blocked；不能猜共享任务格式或用 random sleep 代替。
- `CC-GAP-05`：Manager 同时说“更新 seed”而 V1 seed 是 exact closed document，但未发布 FINAL seed 新成员。FINAL tests 应通过 public APIs 创建 Manager state，直到 seed schema 被明确补充。
- `CC-GAP-06`：Notification webhook 的 exact body schema 未发布。Evaluator 只断言首次 body 与 retry byte-identical、event header/order/digest，不规定业务字段。
- `CC-GAP-07`：V1 没有发布 Buyer/Product/Order/Line/Hold/Payment/Fulfillment/Entitlement/Ledger/Event 等完整 wire shape、list wrapper/status，也没有发布 seed 各 member exact schema或 snapshot 每个 array 的独立 sort tuple；“排序发布在 OpenAPI”不能让 Candidate OpenAPI 自证 expected value。A-03/A-05/D-01/D-06 的相关 exact 断言在补充 contract-map 前 blocked。
- `CC-GAP-08`：`offer-versions`、inventory adjustment、fulfillment complete、entitlement revoke、cancel 的 mutation request bodies/success statuses/responses 未发布；refund 也未发布 success response/status。A-06/A-10/A-11/A-12 的成功 mutation 路径在冻结前 blocked。
- `CC-GAP-09`：README 只列 required error codes，除少数段落外未把每个 code 的 exact route/trigger/precedence 映射完整。A-04 只能断言字面发布的 `MALFORMED_JSON`、`INSUFFICIENT_INVENTORY`、`PROVIDER_EVENT_CONFLICT` 等 trigger；其余 mapping blocked。
- `CC-GAP-10`：Manager 没有定义 settlement eligible allocation、fee、refund reserve、dispute reserve 与 net 的计算公式/取整/边界。不得由 Evaluator 发明 settlement 金额 oracle。
- `CC-GAP-11`：Manager 三个新增 performance scenario 没有冻结 deterministic selector、逐请求 body/identity、warm-up、计时起止、成功计数规则和完整 post-load observation protocol；E-11～E-13 在 workload contract 补齐前 blocked。

`blocked_contract` 不是 Candidate `failed`、`invalid` 或 `evaluator_error`。以上缺口未解决时相关 Case 不运行、不计分，且整份 CommerceCommand v2 **不得用于正式 A/B**；不能把 blocked 权重按 0 分计给 Candidate。

## 2. 公开测试 seams

| Seam | 允许操作 | 禁止操作 |
| --- | --- | --- |
| Commands | README 精确 npm commands、exit/process/log | import Candidate internals |
| HTTP/OpenAPI | health、OpenAPI、所有公开 routes | debug/private routes |
| Snapshot | ADMIN_TOKEN 下 deterministic resources/events/work | direct table/ORM reads |
| Browser | production React、系统 Chromium、visible controls/testids | browser store 注入 |
| Webhook receiver | ACK/500/disconnect/unknown ACK、record request | 读 Candidate outbox |
| Recovery barrier | 仅合同最终发布的 points/body/header | random sleep 或私有 hook |
| Processes | 独立多 API/Workers/dispatchers、signals/restart | 同进程对象模拟 |
| Migration | V1 binary 真实造状态，FINAL 同库迁移/blue-green | FINAL 伪造 V1 |

## 3. Runner 与结果接口

每 case 使用独立数据库/ports/receiver/data root；migration/blue-green 保留同库 binary 切换；performance 独占运行且不与其他 evaluator workload 并行。case 声明唯一 `id/dimension/weight/prerequisites`，mandatory assertions all-or-nothing，并保存 submission/fixture/evidence digests。

Case 结果必须区分 `passed|failed|excluded|blocked_contract|evaluator_error`：`excluded` 仅用于统一标准允许的非合同排除，`blocked_contract` 仅表示 Public Contract 尚未冻结，既不进入分母也不归因 Candidate。最终结果仍为 `accepted|rejected|invalid|evaluator_error`；只要存在 `blocked_contract`，该 run 只能标记为非正式诊断结果，不得产生正式 A/B 最终判定。正式完整 run 不得默认排除 V1→FINAL 或十条 performance scenarios。

## 4. 独立 oracles 与 fixtures

### 4.1 Inventory/order/payment oracle

Evaluator 独立计算：

- 每 pool `0 <= reserved <= onHand`，`reserved = SUM(HELD holds)`；CONSUMED 同减 onHand/reserved，RELEASED/EXPIRED 只减 reserved；
- allocation 按 `(priority, inventoryPoolId)`，可 split 但 line quantity 精确守恒；
- frozen line total=`quantity*(unitPriceMinor+taxMinor)`，order total 为 line sum，全部为 safe integers/同 currency；
- payment precedence `CAPTURED > DECLINED > UNKNOWN`，同 provider request 至多一次 capture；
- `0 <= refunded <= captured <= orderTotal`；每 journal/currency debit=credit；每 transition 至多一 journal；
- full-refunded digital line 没有 ACTIVE entitlement，physical restock 不超过已捕获且未 prior-restock quantity。

Worked inventory example：Pool A priority 1 available 3、Pool B priority 2 available 5，一条 quantity 6 必须分配 A=3/B=3；并发第二条 quantity 3 只能得到 B 剩余 2 因而整单 `INSUFFICIENT_INVENTORY`，不得留下 B hold。

### 4.2 FINAL marketplace oracle

- 每 OrderLine SellerAllocation quantity/amount 完整守恒、tenant 一致且首次 set immutable；
- captured amount 对任意时刻满足 `refund + dispute reserve <= captured`；
- CLOSED settlement immutable，每 eligible allocation 最多被一个 CLOSED settlement 捕获；
- LOST dispute 只产生一次 balanced chargeback 与 liability adjustment，WON 只释放 reserve；
- CLOSED 后 correction 只 append 下一开放周期 adjustment，`targetPeriodStart >= source.periodEnd`。

### 4.3 Fixtures

- 私有 seed 决定 UUID、money、pool priority、provider event order、periods/interleavings；
- `F-OFFER-STOCK`：physical/digital/mixed、multi-pool、boundary money；
- `F-QUOTE`：1/100 unique lines、TTL boundaries、insufficient stock；
- `F-PAYMENT`：UNKNOWN/DECLINED/CAPTURED duplicate/out-of-order/conflict；
- `F-FULFILLMENT`、`F-ENTITLEMENT-REFUND`、`F-LEDGER-EVENT-NOTIFY`；
- `F-IDEMPOTENCY`：每 mutation replay/conflict/unknown response；
- `F-MARKETPLACE`：multi-seller allocations/settlements/disputes/adjustments；
- `F-MIGRATION`：V1 all states、saved replay、pending/leased Work、unacked notifications；
- `F-BROWSER` 与 README 精确十个 perf datasets。

## 5. 计分

| 维度 | 分值 | cases |
| --- | ---: | ---: |
| A. 需求与公共接口覆盖 | 30 | 15 |
| B. 数据正确性、幂等与并发 | 25 | 10 |
| C. Worker、恢复与持久性 | 20 | 8 |
| D. OpenAPI、UI 与跨层闭环 | 15 | 8 |
| E. 迁移、性能与可运维性 | 10 | 14 |
| **总计** | **100** | **55** |

## 6. A — 需求与公共接口覆盖（30 分）

### A-01 Clean install/build/boot — 2
- 前置：clean checkout、空库。
- 操作：install、migrate×2、build，独立启动 API/Worker/dispatcher。
- 可观察断言：production UI/health/OpenAPI 可达；roles 独立；命令 non-interactive/失败非零；SIGTERM 后无子进程/端口。

### A-02 Repeatable populated migration — 2
- 前置：合法 V1 full-state fixture。
- 操作：空库/有数据 migration×2，再由公开命令启动生产角色并读取公开观察面。
- 可观察断言：Offer/Order/Hold/Payment/Fulfillment/Entitlement/Ledger/Event/Work/Notification/replay identity 不变；重复迁移不新增或改写业务状态。

### A-03 Strict atomic seed [BLOCKED: CC-GAP-07] — 2
- 前置：CC-GAP-07 已冻结所有 V1 seed member exact schemas、references 和 invariants。
- 操作：same version/body replay，逐个注入 unknown member、duplicate、broken ref、stock/order/payment/ledger/state/time invariant error、same version different content。
- 可观察断言：合法 no-op；冲突失败；非法 import 全回滚且不触发 external effects。冻结前本 Case 为 `blocked_contract`，不作为 Candidate 失败。

### A-04 HTTP/OpenAPI/idempotency envelope — 2
- 前置：API ready。
- 操作：逐 mutation 测 missing key、malformed JSON、unknown field、invalid UUID/range/enum、resource miss；逐 route 查看 OpenAPI。
- 可观察断言：字面发布 trigger 的 status/code 与 exact error envelope；first business success/rejection durable；malformed 不建 idempotency record；OpenAPI paths 与已冻结 schema 的 runtime 一致。CC-GAP-09 未解决的 code/trigger/precedence 不计分。

### A-05 Tenant isolation, reads and snapshot [BLOCKED: CC-GAP-07] — 2
- 前置：两个 tenants，mixed resources，且 V1 wire/list/snapshot sort contract 已冻结。
- 操作：跨 tenant Buyer/Product/Order IDs 读写，读取所有 collections/detail/snapshot。
- 可观察断言：foreign 如不存在般 `RESOURCE_NOT_FOUND`，无 side effect；stable sort/exact snapshot arrays、single point-in-time、admin auth 与 secret omission。冻结前本 Case 为 `blocked_contract`。

### A-06 Immutable offers and stock adjustments [BLOCKED: CC-GAP-08] — 2
- 前置：physical/digital Products、multiple OfferVersions/Pools，且两个 mutation 的 exact request/success contracts 已冻结。
- 操作：创建/activate new offer、库存 adjustment，随后读取已 frozen Orders。
- 可观察断言：version monotonic、历史 price/tax/currency/kind/effective bounds immutable；onHand/reserved 非负；新 offer 不改旧 OrderLine/replay。冻结前本 Case 为 `blocked_contract`。

### A-07 Frozen quote and allocation — 2
- 前置：multi-pool worked fixture、mixed basket。
- 操作：创建 1/100-line quotes、TTL 30/3600；再测 duplicates/0/101/bad qty/insufficient stock。
- 可观察断言：合法原子生成 Order/Lines/Holds/Event/Notification/QUOTE_EXPIRY Work、frozen totals/allocation order；不足整单零状态与 `INSUFFICIENT_INVENTORY`。

### A-08 Checkout and UNKNOWN payment — 2
- 前置：valid/expired/cancelled quotes。
- 操作：checkout providerRequestId、replay、distinct-key race，并通过 published UNKNOWN path（CC-GAP-03 解决后含 outbound fault）。
- 可观察断言：恰一 PaymentAttempt/provider operation，Order PAYMENT_PENDING；UNKNOWN 不释放库存、不二次 charge，并安排 reconciliation。

### A-09 Callback/reconcile and capture — 2
- 前置：UNKNOWN attempts、physical/digital lines。
- 操作：duplicate/out-of-order UNKNOWN/DECLINED/CAPTURED callback 与 reconcile，conflicting providerEventId。
- 可观察断言：precedence 正确；CAPTURE 原子 PAID、consume holds、建 Fulfillment/Entitlement Work、balanced journal、Event/Notification；conflict 零副作用。

### A-10 Physical fulfillment [BLOCKED: CC-GAP-08] — 2
- 前置：captured physical Orders、plans/work，且 complete mutation contract 已冻结。
- 操作：公开 complete route、Worker delivery/replay。
- 可观察断言：plan frozen allocations；每 plan/physical effect 最多一次；Order 状态合法前进；inventory 不二次 consume；Event/Notification identity 稳定。冻结前本 Case 为 `blocked_contract`。

### A-11 Digital entitlement [BLOCKED: CC-GAP-08] — 2
- 前置：captured digital lines，且 revoke mutation contract 已冻结。
- 操作：grant Work、public revoke、full refund/replay。
- 可观察断言：每 `(orderLineId,grantRevision)` 唯一；ACTIVE/REVOKED 与 final financial state 一致；fully refunded 无 ACTIVE；并发不产生双 grant/revoke event。冻结前本 Case 为 `blocked_contract`。

### A-12 Cancel/refund/restock [BLOCKED: CC-GAP-08/09] — 2
- 前置：QUOTED/PAYMENT_PENDING/PAID/FULFILLED mixed Orders，且 cancel/refund success/error contracts 已冻结。
- 操作：合法/非法 cancel，partial/full refunds，optional restock boundaries。
- 可观察断言：uncaptured cancel/decline releases HELD once；refund 不超 capture、只 restock declared returned units、数字 rights proportional/full revoke；独立 balanced refund journal。冻结前本 Case 为 `blocked_contract`。

### A-13 Ledger, Events and notifications — 2
- 前置：quote/capture/refund/fulfillment histories。
- 操作：读取 ledger/events/work/notifications，触发 rollback/replay。
- 可观察断言：每 journal/currency balance、append-only、amount/transition 对应；Event sequence 单调且 transaction-bound；Notification event/order/digest 一致；CC-GAP-01/06 下不猜 account/body fields。

### A-14 FINAL seller allocation and settlement [BLOCKED: CC-GAP-02/05/10] — 2
- 前置：Manager ID/read/status/shapes、FINAL seed/snapshot additions 与 settlement formulas 全部冻结。
- 操作：提交 conserved allocations，创建/close settlement；测少/多/跨 tenant/late reallocation。
- 可观察断言：line quantity/amount 全守恒、allocation immutable；`ALLOCATION_NOT_CONSERVED` 零状态；CLOSED settlement 冻结 period/currency/eligible/fee/reserves/net，allocation 最多归属一次。冻结前本 Case 为 `blocked_contract`。

### A-15 FINAL dispute and adjustment [BLOCKED: CC-GAP-02/05/10] — 2
- 前置：Manager ID/read/status/shapes、FINAL seed/snapshot additions 与 reserve/target-period formulas 全部冻结。
- 操作：open dispute、WON/LOST duplicate/out-of-order resolve；CLOSED 后 refund/chargeback/manual adjustment。
- 可观察断言：reserve+refund 不超 capture；WON 只 release、LOST 一次 balanced chargeback/liability；CLOSED 不改写，下一 period append exact SettlementAdjustment；published conflicts 零副作用。冻结前本 Case 为 `blocked_contract`。

## 7. B — 数据正确性、幂等与并发（25 分）

### B-01 Allocation and inventory conservation oracle — 2.5
- 前置：10 pools、priority ties、split lines、safe-integer money。
- 操作：多种 basket 创建/expire/cancel/capture/refund。
- 可观察断言：每 commit 后 pool equations、deterministic ordering、line/order totals 与 hold terminal uniqueness 全符合 oracle；失败 snapshot 无差异。

### B-02 Hot-stock quote contention — 2.5
- 前置：容量只允许部分 requests 成功的两个 pools。
- 操作：两 API 160/64-way distinct keys quote。
- 可观察断言：成功/`INSUFFICIENT_INVENTORY` 数量与 oracle 一致；从不 oversell/partial line；每 success 有完整 Work/Event/Notification。

### B-03 Provider callback precedence race — 2.5
- 前置：同 provider request 与 multiple event IDs。
- 操作：两个 API 交错 DECLINED/UNKNOWN/CAPTURED duplicates 与 event conflict。
- 可观察断言：最终 CAPTURED 优先且一次；later decline 不回滚 capture；每 event identity immutable；库存/journal/fulfillment effect 不重复。

### B-04 Unknown-response durable replay — 2.5
- 前置：response shield 覆盖 quote/checkout/callback/reconcile/refund；CC-GAP-02 未冻结前排除 FINAL mutations。
- 操作：完整 upstream response 后断开，restart 后 same key retry。
- 可观察断言：原 status/exact semantic body；Order/Hold/Payment/Ledger/Event/Allocation/Dispute 各最多一个 effect。

### B-05 Same-key authority across APIs — 2.5
- 前置：两个 API 共库。
- 操作：64-way same key/body first use、same key/different body、third API restart replay。
- 可观察断言：首批唯一结果；different body `IDEMPOTENCY_CONFLICT`；process-local map mutant 失败。

### B-06 Checkout/capture terminal race — 2.5
- 前置：valid quote 临近 expiry，多 checkout/callback/reconcile calls。
- 操作：QUOTE_EXPIRY Worker、checkout、capture/decline 确定性交错。
- 可观察断言：一个 serialized financial winner；holds 不同时 consumed/released；Order/Attempt/journal/Event/Work history 自洽。

### B-07 Refund/restock/reserve contention — 2.5
- 前置：captured mixed Order，多个 refundable/restockable lines。
- 操作：12/64-way V1 partial refunds 与 restocks；CC-GAP-02/10 未冻结前不混入 FINAL dispute/settlement。
- 可观察断言：committed refund sum 始终 ≤ capture；restock 不超 returned units；ledger balance；loser 稳定 conflict、零 partial side effect。

### B-08 Fulfillment/entitlement races — 2.5
- 前置：captured physical/digital Orders、多 Workers。
- 操作：complete/reclaim/refund/revoke 交错。
- 可观察断言：每 plan/effect/entitlement transition at most once；fully refunded digital inactive；stale fence 不能写；inventory/financial state 不分叉。

### B-09 Seller allocation/settlement close race [BLOCKED: CC-GAP-02/10] — 2.5
- 前置：两个不同合法 allocation sets、eligible settlements，且 Manager ID/read/status/formula contracts 已冻结。
- 操作：32-way allocation same/different keys 与 32-way close。
- 可观察断言：只一个 immutable allocation set/CLOSED settlement；quantity/amount/net/reserve 守恒；每 allocation 最多捕获一次；replay identity 稳定。冻结前本 Case 为 `blocked_contract`。

### B-10 Dispute/adjustment catastrophe ordering [BLOCKED: CC-GAP-02/10] — 2.5
- 前置：CLOSED settlement、refund/dispute/chargeback/adjustment candidates，且 Manager ID/read/status/formula contracts 已冻结。
- 操作：两个 API/Workers 交错 WON/LOST/provider duplicate/late correction。
- 可观察断言：LOST effect 一次、WON 不扣款；旧 settlement byte-semantic 不变；所有 late effects 进入合法 target period，source references 完整。冻结前本 Case 为 `blocked_contract`。

## 8. C — Worker、恢复与持久性（20 分）

### C-01 Work lifecycle and retention — 2.5
- 前置：公开 V1 Work kinds 的 PENDING/LEASED/terminal fixtures；Manager Work creation 待 CC-GAP-02/05 冻结。
- 操作：claim/reclaim/success/dead/drain。
- 可观察断言：exact public Work fields、attempt/fencing 单调、lease fields 合法、terminal retained、drain 定义正确。

### C-02 SIGKILL after Worker claim [BLOCKED: CC-GAP-04] — 2.5
- 前置：CC-GAP-04 已冻结，held claimed barrier。
- 操作：kill A、lease expiry、start B。
- 可观察断言：B reclaim，A stale fence；业务/ledger/Event/Notification effect 一次；无 open transaction 跨 barrier。冻结前本 Case 为 `blocked_contract`。

### C-03 Expired fencing token [BLOCKED: CC-GAP-04] — 2.5
- 前置：CC-GAP-04 已冻结；A pause 到过期，B reclaim/complete。
- 操作：释放 A 再提交。
- 可观察断言：A 不能改 plan/order/work；attempt/result 只反映 B。合同未把 stale worker completion 映射到 `STALE_FENCE` HTTP response，本 Case 不要求该 code；冻结前为 `blocked_contract`。

### C-04 Fulfillment recovery [BLOCKED: CC-GAP-04] — 2.5
- 前置：CC-GAP-04 已冻结；mixed captured plans、4 Workers。
- 操作：多个 claims 后 kill/replacement/drain。
- 可观察断言：shipment/plan/inventory/event/notification 不重复；每 plan terminal；另 Order 不被 head-of-line block。冻结前为 `blocked_contract`。

### C-05 Payment reconciliation recovery [BLOCKED: CC-GAP-04] — 2.5
- 前置：CC-GAP-04 已冻结；UNKNOWN Attempts 与 bounded-backoff Work。
- 操作：kill claimed Worker、duplicate callbacks/reconcile、replacement。
- 可观察断言：UNKNOWN 可重试但不二次 provider operation；CAPTURE/DECLINE convergence 一次；journal/holds 与 final state 一致。冻结前为 `blocked_contract`。

### C-06 FINAL settlement/dispute Work recovery [BLOCKED: CC-GAP-02/04/05/10] — 2.5
- 前置：Manager ID/read/status/formula/seed 与 barrier contracts 均冻结；三类 Manager Work、close/dispute/adjustment candidates。
- 操作：在合同 barrier kill/reclaim，交错 API terminal mutation。
- 可观察断言：fencing 有效；CLOSED/LOST/adjustment effects at most once；obsolete Work 安全 terminalize，不改写 winner。冻结前为 `blocked_contract`。

### C-07 Unknown notification ACK [BLOCKED: CC-GAP-04] — 2.5
- 前置：CC-GAP-04 已冻结；receiver 记录完整 request 后隐藏 ACK。
- 操作：kill dispatcher，500/disconnect/replacement success。
- 可观察断言：stable event header 与 byte-identical body、per-Order sequence、有界 retry、无第二 logical Event/Notification identity。CC-GAP-06 下不规定 body schema；barrier 冻结前为 `blocked_contract`。

### C-08 Transactional event/outbox/ledger ordering [BLOCKED: CC-GAP-04] — 2.5
- 前置：CC-GAP-04 已冻结；success/rollback transitions、多 Orders。
- 操作：并发 mutate，dispatcher response barrier kill/restart。
- 可观察断言：business/Ledger/Event/Notification/Work 同 transaction；rollback 全无；per-Order sequence；跨 Order 不 HOL block；秘密不泄漏。冻结前为 `blocked_contract`。

## 9. D — OpenAPI、UI 与跨层闭环（15 分）

### D-01 OpenAPI validates live traffic [BLOCKED: CC-GAP-02/07] — 2
- 前置：V1/FINAL exact wire/status schemas、Manager routes/IDs/read contracts 已冻结，Evaluator 已有独立 schema。
- 操作：每 route 采 success/published error。
- 可观察断言：OpenAPI 3.1 path/status/body/closed fields/formats 与 runtime 一致；Candidate OpenAPI 不自证 expected value。冻结前本 Case 为 `blocked_contract`。

### D-02 Browser mixed quote/checkout — 2
- 前置：production UI、真实 DB/API。
- 操作：用 stable testids/visible controls 选 tenant/buyer、mixed basket、quote、checkout/UNKNOWN/reconcile，刷新 deep link。
- 可观察断言：frozen prices/holds/totals/payment/fulfillment/entitlement 为 server truth；primary actions 不用 direct API。

### D-03 Browser cancel/refund/ledger — 2
- 前置：可 cancel/refund mixed Orders。
- 操作：UI partial/full refund、restock、查看 entitlement/ledger/events/notifications，reload。
- 可观察断言：金额/库存/rights 跨层一致；validation/conflict/terminal 可见；UI 不伪造平衡或完成。

### D-04 Browser marketplace flow [BLOCKED: CC-GAP-02/10] — 2
- 前置：FINAL UI、multi-seller Order，且 Manager ID/read/status/formula contracts 已冻结。
- 操作：visible controls 编辑 allocations、close settlement、open/resolve dispute、查看 late adjustment。
- 可观察断言：动态 seller/line allocation、守恒 validation、CLOSED immutability、reserve/chargeback/target period 可观察；不硬编码两个 sellers。冻结前为 `blocked_contract`。

### D-05 UI states/accessibility/security — 2
- 前置：loading/empty/expired/UNKNOWN/409/offline/retry/tenant error、desktop/mobile。
- 操作：全键盘走 primary flows。
- 可观察断言：labels/focus/keyboard/viewport/contrast 可用；retry 不重复 effect；ADMIN_TOKEN/provider secret/idempotency/private path 不进 DOM/bundle/log。

### D-06 Snapshot/browser/API cross-check [BLOCKED: CC-GAP-02/05/07/10] — 2
- 前置：复杂 V1+FINAL histories，且 exact V1/FINAL wire、read/snapshot keys/sorts 与 settlement formulas 已冻结。
- 操作：对同 Order 从 browser/detail/snapshot/ledger/events/work/notifications 取证。
- 可观察断言：frozen version、holds、payment、fulfillment/entitlement、money、marketplace state 一一对应且 exact ordering。冻结前为 `blocked_contract`。

### D-07 Project-owned gates not fake green — 2
- 前置：clean DB 与所有公开 test commands。
- 操作：逐个运行 unit/integration/e2e/concurrency/recovery/test:perf/all 并外部观察 seams。
- 可观察断言：integration 真 PostgreSQL/HTTP；e2e production Chromium；concurrency≥2 API+multi Worker；`test:perf` 运行 V1 七场景及冻结后的 FINAL 场景；recovery 的 barrier 真实性待 CC-GAP-04 冻结，未冻结时只标 blocked；0 tests/字符串检查/吞失败均失败。

### D-08 README-to-evidence closure — 1
- 前置：全部 evidence。
- 操作：建立 `README→HTTP→OpenAPI→UI(适用)→snapshot/ledger/work/event/notification→hidden case` ledger。
- 可观察断言：每节点实际执行；unrun/empty/failed/partial 不冒充 passing；所有 contract gaps 显式标出。

## 10. E — 迁移、性能与可运维性（10 分）

### E-01 Populated V1→FINAL/blue-green migration — 1.5
- 前置：V1 binary 创建 all states/resources、immutable payloads。
- 操作：FINAL migrate×2，旧/新 API 共库并继续 V1 quote/checkout/read。
- 可观察断言：V1 IDs/payloads/semantics 保留；new schema forward-only；old Worker payloads 可处理；unknown enums fail closed。

### E-02 Saved replay/Event/Ledger compatibility — 1
- 前置：V1 saved success/business rejection/unknown response、journals/events/notifications。
- 操作：FINAL replay/read。
- 可观察断言：原 exact response/identity 不改；immutable journals/eventId/body/sequence/notification digest 保留。

### E-03 Pending Work/outbox migration — 1
- 前置：V1 PENDING/LEASED Work、unacked notifications、attempt/fence metadata。
- 操作：migrate、lease expiry、FINAL replacement drain。
- 可观察断言：payloadVersion/aggregate/attempt/lease/order 保留；stale owner 不提交；FINAL roles 处理旧 payload。

### E-04 `quote-read-mix` — 0.5
- 前置：README exact 20k products/stock。
- 操作：64 clients、10s warmup、60s measured 80/20 mix。
- 可观察断言：≥250/s、p95≤300ms；每 accepted quote freeze oracle-valid OfferVersion；post-load stock/money invariants。

### E-05 `checkout-contention` — 0.5
- 前置：2k valid quotes。
- 操作：64 clients、60s duplicate/distinct-key races。
- 可观察断言：≥120/s、p95≤500ms；每 Order ≤1 provider operation/capture。

### E-06 `inventory-hotspot` — 0.5
- 前置：10 pools、50k attempts、two APIs。
- 操作：64 concurrency/60s。
- 可观察断言：≥150/s、p95≤500ms；success/conflict 都可计但 pool equations exact、5xx=0。

### E-07 `payment-unknown-reconcile` — 0.5
- 前置：5k UNKNOWN Attempts。
- 操作：64 concurrency duplicate/out-of-order callbacks 60s，120s convergence。
- 可观察断言：≥100/s、p95≤700ms；all determinable terminal、one capture、balanced journals。

### E-08 `fulfillment-drain` [BLOCKED: CC-GAP-04] — 0.5
- 前置：CC-GAP-04 已冻结；10k captured physical Orders、4 Workers。
- 操作：kill one claim、replacement、300s drain。
- 可观察断言：≥50 terminal plans/s；无 duplicate plan/shipment/inventory/journal/Event。冻结前为 `blocked_contract`。

### E-09 `notification-unknown-ack` [BLOCKED: CC-GAP-04] — 0.5
- 前置：CC-GAP-04 已冻结；10k notifications、2 dispatchers、10% lost ACK。
- 操作：kill response-barrier dispatcher、180s drain。
- 可观察断言：≥100 deliveries/s；retry bytes/identity stable、per-Order order、无第二 Event。冻结前为 `blocked_contract`。

### E-10 `entitlement-revocation-storm` — 0.5
- 前置：20k captured digital lines。
- 操作：64-way grant/refund/revoke 60s。
- 可观察断言：≥150/s、p95≤500ms；fully refunded 无 ACTIVE；transition Event/journal uniqueness。

### E-11 `seller-settlement-close` [BLOCKED: CC-GAP-02/10/11] — 1
- 前置：Manager ID/read/formula 与 workload selector/request/timer contracts 已冻结；50k eligible allocations。
- 操作：64 clients close different seller/period 60s。
- 可观察断言：≥80 settlements/s、p95≤750ms；allocation at most one CLOSED settlement；net/reserves conserved。冻结前为 `blocked_contract`。

### E-12 `refund-dispute-race` [BLOCKED: CC-GAP-02/10/11] — 1
- 前置：Manager ID/read/formula 与 workload selector/request/timer contracts 已冻结；20k captured Orders。
- 操作：64 clients refund/open/resolve 60s。
- 可观察断言：≥100 mutations/s、p95≤750ms；refund+reserve≤capture at all commits；LOST chargeback once。冻结前为 `blocked_contract`。

### E-13 `full-catastrophe-recovery` [BLOCKED: CC-GAP-02/04/10/11] — 0.75
- 前置：Manager ID/read/formula、barrier 与 exact workload contracts 已冻结；10k mixed FINAL entities、continuous all-role load。
- 操作：依次 kill API/Worker/dispatcher、replacement，300s drain。
- 可观察断言：inventory/money/ledger/event/tenant/allocation/settlement/replay 全守恒；Work/outbox 在 300s 内 drain。冻结前为 `blocked_contract`。

### E-14 Operability cleanup and reproducibility — 0.25
- 前置：E-04～E-13 各 workload 已完成、blocked 或稳定失败。
- 操作：正常终止 evaluator-owned process groups，检查端口/managed root/log，并同 seed 重跑一个非性能 Case。
- 可观察断言：无遗留进程、端口或锁；日志无秘密；同 Submission+seed 的非性能结果与 evidence digest 可复现。

## 11. Hard caps、invalid 与 evaluator_error

| 失败 | 总分上限 |
| --- | ---: |
| clean build/migration/production boot 失败 | 25 |
| inventory/money/refund/ledger/allocation/reserve 守恒或 atomic rejection 失败 | 35 |
| durable idempotency/provider identity 产生第二 effect | 30 |
| business 与 ledger/event/outbox 非事务或 retry 改 identity/body | 40 |
| pending Work 丢失或 stale fencing token 可提交 | 40 |
| migration 丢历史、改 replay 或破坏 V1 client | 35 |
| 性能后核心不变量失败 | 对应 case 0 并应用 correctness cap |

读取 hidden assets、硬编码 fixture/seed、workspace 外私有访问、容器逃逸、伪造 evidence 为 `invalid`。Evaluator 自身 Docker/PostgreSQL/Chromium/receiver/port 故障为 `evaluator_error`。watchdog 只保护 evaluator，不增加产品行为时限。
任何标为 `blocked_contract` 的 Case 不执行 Hard Cap，不进入分母，也不得转换成 Candidate 失败；正式 A/B 必须在所有 blocking gaps 冻结后重新生成完整 100 分 manifest，不能用缩分结果代替。

## 12. Anti-fake-green

1. Candidate tests 只在 D-07 验证 gate 真实性；
2. stock/money/payment/ledger/marketplace expected values来自独立 oracle；
3. Candidate OpenAPI 不自证 runtime；
4. 文件/字符串/test name/log 自述/exit 0 不是行为证据；
5. recovery 只用发布 barrier，多进程必须真实 OS processes；
6. 每个 perf scenario 后重算全部 invariant，吞吐不单独通过；
7. 所有 A/B arms 同 image/seed/cases/weights/thresholds。

## 13. Requirement mapping

| 原 gate | v2 cases |
| --- | --- |
| H-01/H-02 | A-01～A-05、D-01、D-05 |
| H-03/H-04 | A-06～A-13、B-01～B-03 |
| H-05/H-06 | B-04～B-08 |
| H-07/H-08 | C-01～C-08 |
| H-09/H-28 | E-01～E-03 |
| H-10/H-11/H-24～H-27 | A-14～A-15、B-09～B-10、D-04 |
| H-12/H-29/H-30 | E-04～E-14 |
| H-13 | D-07～D-08 |
| H-14～H-23 | B-01～B-08、C-04～C-08、D-02～D-06 |

### 13.1 Case contract-map 与反馈代码

`V1` 指 `workspace/README.md` 对应标题；`MGR` 指 `orchestration/manager-prompt.zh-CN.md`。
私有失败码固定为 `CC_<CASE_ID>_<ASSERTION>`；公开报告只返回下表 category。带 `BLOCKED` 的来源必须先补入
Public Contract，未冻结时只返回 `blocked_contract`，不得泄露 fixture 或换算 Candidate 分数。

| Case | 唯一 Public Contract 来源 | public feedback category |
| --- | --- | --- |
| A-01 | V1 `Required stack and delivery`、commands/environment | `command_boot` |
| A-02 | V1 repeatable migration、migration compatibility | `migration_repeatability` |
| A-03 | V1 `Seed and verification snapshot`；BLOCKED CC-GAP-07 | `seed_atomicity` |
| A-04 | V1 HTTP paths/idempotency/error envelope；CC-GAP-09 limits mapping | `http_contract` |
| A-05 | V1 tenant isolation/read/snapshot；BLOCKED CC-GAP-07 | `read_snapshot` |
| A-06 | V1 OfferVersion/inventory mutations；BLOCKED CC-GAP-08 | `offer_inventory` |
| A-07 | V1 quote body/allocation/hold transition | `quote_creation` |
| A-08 | V1 checkout/UNKNOWN rules；CC-GAP-03 limits outbound fault | `checkout_payment` |
| A-09 | V1 callback/reconcile/capture transition | `payment_capture` |
| A-10 | V1 fulfillment mutation；BLOCKED CC-GAP-08 | `fulfillment` |
| A-11 | V1 entitlement revoke mutation；BLOCKED CC-GAP-08 | `entitlement` |
| A-12 | V1 cancel/refund/restock；BLOCKED CC-GAP-08/09 | `refund_cancel` |
| A-13 | V1 ledger/Event/Notification transaction；CC-GAP-01/06 limits fields | `ledger_events` |
| A-14 | MGR rules 1-3/mutations；BLOCKED CC-GAP-02/05/10 | `seller_settlement` |
| A-15 | MGR rules 4-6/mutations；BLOCKED CC-GAP-02/05/10 | `commerce_dispute` |
| B-01 | V1 inventory/order/payment conservation | `inventory_correctness` |
| B-02 | V1 quote atomicity/hot inventory contention | `inventory_concurrency` |
| B-03 | V1 callback precedence/provider identity | `payment_concurrency` |
| B-04 | V1 durable replay；Manager paths excluded by CC-GAP-02 | `idempotency_replay` |
| B-05 | V1 idempotency across API processes | `idempotency_concurrency` |
| B-06 | V1 checkout/capture/quote-expiry serialization | `payment_concurrency` |
| B-07 | V1 refund/restock conservation；Manager reserve excluded | `refund_concurrency` |
| B-08 | V1 fulfillment/entitlement state convergence | `fulfillment_concurrency` |
| B-09 | MGR allocation/settlement race；BLOCKED CC-GAP-02/10 | `settlement_concurrency` |
| B-10 | MGR dispute/adjustment ordering；BLOCKED CC-GAP-02/10 | `dispute_concurrency` |
| C-01 | V1 Work shape/lifecycle；Manager kinds excluded by CC-GAP-02/05 | `work_lifecycle` |
| C-02 | V1 Barrier-controlled claimed recovery；BLOCKED CC-GAP-04 | `worker_recovery` |
| C-03 | V1 fencing invariant；BLOCKED CC-GAP-04 | `worker_fencing` |
| C-04 | V1 fulfillment recovery；BLOCKED CC-GAP-04 | `fulfillment_recovery` |
| C-05 | V1 payment reconciliation recovery；BLOCKED CC-GAP-04 | `payment_recovery` |
| C-06 | MGR Work recovery；BLOCKED CC-GAP-02/04/05/10 | `manager_recovery` |
| C-07 | V1 dispatcher response recovery；BLOCKED CC-GAP-04 | `notification_recovery` |
| C-08 | V1 transactional recovery ordering；BLOCKED CC-GAP-04 | `transaction_recovery` |
| D-01 | V1+MGR OpenAPI/live traffic；BLOCKED CC-GAP-02/07 | `openapi_runtime` |
| D-02 | V1 production UI quote/checkout/reconcile | `browser_checkout` |
| D-03 | V1 production UI cancel/refund/ledger | `browser_refund` |
| D-04 | MGR marketplace UI；BLOCKED CC-GAP-02/10 | `browser_marketplace` |
| D-05 | V1 UI states/accessibility/security | `ui_accessibility` |
| D-06 | V1+MGR cross-layer exact evidence；BLOCKED CC-GAP-02/05/07/10 | `cross_layer_evidence` |
| D-07 | V1 all `test:*` commands including `test:perf`；recovery partial CC-GAP-04 | `project_gates` |
| D-08 | V1 project verification/handoff evidence | `evidence_closure` |
| E-01 | V1 migration/blue-green compatibility + MGR preservation | `migration_compatibility` |
| E-02 | V1 saved replay/Event/Ledger/Notification identity | `migration_replay` |
| E-03 | V1 pending Work/outbox migration | `migration_pending_work` |
| E-04 | V1 `quote-read-mix` | `performance_quote` |
| E-05 | V1 `checkout-contention` | `performance_checkout` |
| E-06 | V1 `inventory-hotspot` | `performance_inventory` |
| E-07 | V1 `payment-unknown-reconcile` | `performance_payment` |
| E-08 | V1 `fulfillment-drain`；BLOCKED CC-GAP-04 | `performance_fulfillment` |
| E-09 | V1 `notification-unknown-ack`；BLOCKED CC-GAP-04 | `performance_notification` |
| E-10 | V1 `entitlement-revocation-storm` | `performance_entitlement` |
| E-11 | MGR `seller-settlement-close`；BLOCKED CC-GAP-02/10/11 | `performance_settlement` |
| E-12 | MGR `refund-dispute-race`；BLOCKED CC-GAP-02/10/11 | `performance_dispute` |
| E-13 | MGR `full-catastrophe-recovery`；BLOCKED CC-GAP-02/04/10/11 | `performance_catastrophe` |
| E-14 | V1 command cleanup/log secrecy + v2 reproducibility standard | `operability_cleanup` |

## 14. Calibration mutants

| Mutant | 必须命中 |
| --- | --- |
| process-local idempotency | B-04、B-05 |
| pool allocation 忽略 priority/tie-break | A-07、B-01 |
| insufficient quote 保留 partial holds | A-07、B-02 |
| DECLINED 覆盖 CAPTURED | A-09、B-03 |
| UNKNOWN 触发第二 provider charge | A-08、B-04 |
| capture business 与 ledger/event 分 transaction | A-09、C-08 |
| refund 超 capture/restock twice | A-12、B-07 |
| full refund 保留 ACTIVE entitlement | A-11、B-08 |
| Work 无 fencing | C-02～C-06 |
| notification retry 新 body/event ID | C-07 |
| seller allocation 少 1 minor unit | A-14、B-09 |
| settlement close 改写旧 allocation | A-14、B-09 |
| LOST dispute 重复 chargeback | A-15、B-10 |
| late adjustment 写回 CLOSED settlement | A-15、B-10 |
| migration 改 saved replay/journal identity | E-01～E-03 |
| OpenAPI 只列 paths | D-01 |
| UI mock payment/ledger | D-02～D-04 |
| project tests 只检查字符串 | D-07 |
| perf 只报 throughput | E-04～E-13 |

## 15. 实施顺序与完成标准

1. A-01/A-03/A-07 打通 command→HTTP→snapshot 与 stock oracle；
2. B-03/B-04/B-05 打通 provider precedence、response shield、多 API；
3. 先解决 CC-GAP-04，再实现 C-02～C-08 与依赖 barrier 的性能场景；
4. A-09/A-12/C-08 校准 money/ledger/event oracle；
5. 解决 CC-GAP-02/05/10/11 后实现 A-14/A-15/B-09/B-10/E-11～E-13；
6. D-01～D-04 接 contract validator/Chromium；
7. E-01～E-03 接真实 V1 checkpoint，最后逐条实现 10 perf scenarios、独立 cleanup、caps/reports/mutants。

正式 A/B 前：55 cases 唯一且总分精确 100；CC-GAP-01～11 全部冻结并从 contract-map 生成无 `blocked_contract` 的 100 分 manifest；gold 全过、mutants 被定向捕获、三次 calibration 无功能 flake；实验 arm 不改变 evaluator 行为。任一 blocking gap 未解决时，CommerceCommand v2 不得进入正式 A/B。
