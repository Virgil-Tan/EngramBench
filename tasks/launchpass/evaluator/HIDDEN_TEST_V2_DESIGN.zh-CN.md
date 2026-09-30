# LaunchPass Hidden Test v2（Learning）设计

本设计按 Learning v2 profile 将旧 E2E 与 29 场景 stress suite 合并为 22 个不重复的领域 Case。
install/build/boot、空库 migration、health、Chromium shell 与项目命令真实性由共享 preflight 负责，
不计入 Case 数。

## 1. 权威、公开 seam 与 SPEC-GAP

真值只来自 workspace/README.md、T16 固定 Manager 消息和 CONTEXT.md；旧 E2E/STRESS 只用于覆盖映射，
不能新增行为。允许 seam 仅为公开 HTTP、openapi.yaml、production Chromium、独立 application
process、公开 seed command 和 README 性能命令。合同没有 worker、dispatcher、barrier、event 或
verification snapshot，因此本设计不硬加这些机制。

- LP-GAP-01：Manager 发布 GET/DELETE envelope和语义，但没有明确它们的成功HTTP status。
  A-05/D-04断言2xx、exact body和错误code；exact GET/DELETE success status子断言
  blockedBy: LP-GAP-01。
- LP-GAP-02：Manager只要求“update migration”，没有发布 V1→Manager populated-data/replay
  compatibility语义或checkpoint。不得发明升级 Case；E-01仅测试FINAL binary仍接受字面V1 seed schema。
- LP-GAP-03：Manager未发布waitlist history/list接口，只有单customer GET；UI refresh后只能恢复
  已知eventId+customerId的公开状态，不能要求未发布的队列浏览接口。

每个Case使用新数据库、端口和随机ID；多实例Case启动两个真实OS进程共享DATABASE_URL。

## 2. 独立 oracle、fixtures 与 worked example

Evaluator维护整数capacity ledger：capacity = available + pending holds + confirmed orders，终态按公开
响应建立线性化顺序；不读业务表。Fixture：F-EVENT（search/page/boundaries）、F-HOLD（qty1..4/
short TTL）、F-RACE（hot capacity/terminal）、F-WAITLIST（不同qty/join time/ID）、F-RESTART、
F-SEED（min/invalid/10k+10k+100k）与公开性能dataset。

**Worked example LP-W1**：event capacity=4，已售罄后A(qty3)先入队、B(qty1)后入队。释放2个名额时
不得跳过A晋升B；再释放2个名额时先为A创建一个普通PENDING hold，剩余1个可继续为B创建hold。
两个应用同时观察第二次释放，A/B各最多一个hold；晋升hold使用WAITLIST_HOLD_TTL_SECONDS，不使用
普通HOLD_TTL_SECONDS。

## 3. 评分

| Family | Cases | 分值 |
| --- | ---: | ---: |
| A Event/Hold/Waitlist公共流程 | 5 | 30 |
| B 容量、幂等与并发 | 5 | 25 |
| C 被动到期、崩溃与重启 | 4 | 20 |
| D 浏览器与OpenAPI闭环 | 4 | 15 |
| E Seed与公开性能 | 4 | 10 |
| **总计** | **22** | **100** |

同一行为只有一个主计分Case，mandatory assertions不拆分给分。

## 4. A — Event/Hold/Waitlist 公共流程

### A-01 Event 创建、搜索、排序与 cursor page — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：README 4.1、6.1、6.3；F-EVENT含slug/title case、同startsAt和>100 items。
- **公开动作 / oracle**：admin创建边界events，customer按q/limit/cursor浏览detail并跨页；使用无/错ADMIN_TOKEN controls。
- **Mandatory / 禁止副作用**：exact request/201 body/timestamps/capacity，case-insensitive search，startsAt→id排序，无重漏cursor；slug唯一，admin token不进browser/error/log，invalid输入零event。
- **primarySkill**：S15 cross-layer-acceptance-closure；**feedback**：event.contract-pagination；**mutant**：M-LP-01。

### A-02 Hold 创建、容量预留与失败原子性 — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：README 4.2、6.4、business invariants；F-HOLD。
- **公开动作 / oracle**：qty1/4/bounds创建，查询hold/event；在available不足、unknown event/customer、bad input时重复。
- **Mandatory / 禁止副作用**：成功exact PENDING/expiry并一次减少available；INSUFFICIENT_CAPACITY和其他失败无hold/扣减；ledger保持0≤available≤capacity且pending+confirmed≤capacity。
- **primarySkill**：S04 database-owned-atomic-idempotency；**feedback**：hold.capacity-reservation；**mutant**：M-LP-02。

### A-03 Confirm、release、Order 与 customer history — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：README hold terminal/history/routes；F-HOLD。
- **公开动作 / oracle**：分别confirm/reconfirm、release/rerelease及非法cross-terminal，分页读取customer holds/orders并restart一实例。
- **Mandatory / 禁止副作用**：confirm创建exact one order且holdId=hold UUID；release只恢复一次；已确认/释放replay按字面结果或稳定conflict；history sort/cursor和holdId:null seed history精确。
- **primarySkill**：S04 database-owned-atomic-idempotency；**feedback**：hold.terminal-history；**mutant**：M-LP-03。

### A-04 无流量自动 Expiration 与两秒可观察窗口 — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：README passive expiry/restart；短HOLD_TTL_SECONDS的F-HOLD。
- **公开动作 / oracle**：创建后不再发业务请求，分别在expiresAt前和+2秒内查询hold/event/history，另测deadline前confirm。
- **Mandatory / 禁止副作用**：前仍PENDING且capacity保留，容忍窗内EXPIRED且capacity恰恢复一次；无需read触发，expired不可confirm/release，无双terminal/order。
- **primarySkill**：S04 database-owned-atomic-idempotency；**feedback**：hold.passive-expiry；**mutant**：M-LP-04。

### A-05 Waitlist join/query/withdraw 与自动 promotion — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：T16 rules 1–11；F-WAITLIST与LP-W1。
- **公开动作 / oracle**：sold-out join/get/withdraw/replay；容量足够、duplicateWAITING、qty>capacity errors；release/expire后观察PROMOTED hold。
- **Mandatory / 禁止副作用**：exact envelope、WAITING position/holdId、WITHDRAWN/PROMOTED fields；每user+event一个WAITING；promotion创建普通PENDING hold并用waitlist TTL，withdrawn不晋升。GET/DELETE exact status blockedBy: LP-GAP-01。
- **primarySkill**：S06 ordered-authority-and-frozen-membership；**feedback**：waitlist.public-flow；**mutant**：M-LP-05。

## 5. B — 容量、幂等与并发

### B-01 两实例 hot-event oversubscription 守恒 — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：README multi-instance/business invariants/concurrency；小随机capacity、200 distinct requests。
- **公开动作 / oracle**：请求随机分配两ports、qty1..4，TTL足够长；根据所有成功response独立汇总。
- **Mandatory / 禁止副作用**：成功qty≤capacity，available=capacity−success qty且不负；失败hold不可查询、无5xx/hang，任何进程内cache不能成为authority。
- **primarySkill**：S04 database-owned-atomic-idempotency；**feedback**：capacity.multi-instance；**mutant**：M-LP-06。

### B-02 Scoped idempotency、unknown response 与跨重启 replay — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：README 6.2、invariant7；create/confirm/release/event/waitlist mutations。
- **公开动作 / oracle**：64路same key/body跨两实例，完整upstream response后shield断线，kill/restart一实例，再same key different semantics。
- **Mandatory / 禁止副作用**：原status/semantic body/IDs永久重放；每operation/resource scope正确，不同body409；容量、hold/order/waitlist各只有一次effect。
- **primarySkill**：S04 database-owned-atomic-idempotency；**feedback**：idempotency.durable-replay；**mutant**：M-LP-07。

### B-03 Confirm/release/expire 唯一 terminal race — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：README terminal race invariants；短TTL holds、三个固定交错。
- **公开动作 / oracle**：两个实例在deadline附近并发confirm、DELETE，并让passive expiry运行；部分轮次kill一个进程。
- **Mandatory / 禁止副作用**：CONFIRMED/RELEASED/EXPIRED恰一赢家，order≤1，capacity按赢家恢复0或1次；loser返回合法replay/conflict，无中间状态/5xx。
- **primarySkill**：S04 database-owned-atomic-idempotency；**feedback**：hold.terminal-race；**mutant**：M-LP-03。

### B-04 Strict FIFO、head-of-line blocking 与连续 promotion — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：T16 rules 3–5；不同joinedAt/ID/qty的F-WAITLIST与LP-W1。
- **公开动作 / oracle**：分步释放1..capacity并在每步GET所有entries/holds/event；同joinedAt用ID tie-break fixture。
- **Mandatory / 禁止副作用**：joinedAt→ID稳定FIFO，队首无法完全满足时不得bypass；每次release可连续promote多个可满足队首，停止点精确，capacity ledger持续守恒。
- **primarySkill**：S06 ordered-authority-and-frozen-membership；**feedback**：waitlist.strict-fifo；**mutant**：M-LP-08。

### B-05 双实例 promotion exactly-once 与 withdraw竞争 — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：T16 rules 2、6、8；两个实例同时处理同一capacity release。
- **公开动作 / oracle**：并发release/expiry触发promotion，同时DELETE队首、重复GET/POST，使用三个固定交错。
- **Mandatory / 禁止副作用**：每entry最多一次PROMOTED/一个hold，WAITING或WITHDRAWN只能按合法提交序；无duplicatehold/oversell/position乱序，普通hold terminal后可继续下一轮FIFO。
- **primarySkill**：S06 ordered-authority-and-frozen-membership；**feedback**：waitlist.promotion-race；**mutant**：M-LP-09。

## 6. C — 被动到期、崩溃与重启

### C-01 Hold response后进程崩溃的durable reservation — 5 分
- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture**：README committed state survives restart；response shield与两个app。
- **公开动作 / oracle**：上游完整201后断client连接并SIGKILL处理实例，从另一实例GET event/hold/history，再replay。
- **Mandatory / 禁止副作用**：reservation和savedresponse同时durable，capacity只扣一次；不能出现响应已生成但hold/ledger缺失，另一实例立即看同状态。
- **primarySkill**：S04 database-owned-atomic-idempotency；**feedback**：hold.commit-restart；**mutant**：M-LP-07。

### C-02 创建实例退出后的 passive expiration recovery — 5 分
- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture**：README expiration survives restart/no incoming traffic；F-RESTART。
- **公开动作 / oracle**：创建pending hold后停止该实例，保持零traffic越过deadline，启动replacement并在两秒窗口内查询。
- **Mandatory / 禁止副作用**：replacement无需触发式read即可恢复到EXPIRED，capacity恰一次；restart不延长TTL、不丢history、不创建order。
- **primarySkill**：S04 database-owned-atomic-idempotency；**feedback**：expiry.restart-recovery；**mutant**：M-LP-04。

### C-03 Confirm/release unknown outcome 的跨实例恢复 — 5 分
- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture**：README idempotency/terminal invariants；response shield在terminal response后断线。
- **公开动作 / oracle**：分别confirm/release成功后kill实例，在另port同key replay并发相反terminal请求。
- **Mandatory / 禁止副作用**：saved terminal response、order/capacity副作用原子；replay无第二order/restore，相反请求稳定失败，history与event availability一致。
- **primarySkill**：S04 database-owned-atomic-idempotency；**feedback**：terminal.unknown-outcome；**mutant**：M-LP-03。

### C-04 Promotion 期间实例终止后的 FIFO 恢复 — 5 分
- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture**：T16 auto promotion/two instances；多entry队列、release/expiry触发点。
- **公开动作 / oracle**：释放容量请求完成或断线时SIGKILL一实例，让另一实例/restart继续，反复GET entries/holds。
- **Mandatory / 禁止副作用**：队列最终达到与无故障FIFO oracle相同的stable prefix；无lost/duplicatepromotion，hold TTL来自waitlist配置，capacity守恒且不需人工再次release。
- **primarySkill**：S06 ordered-authority-and-frozen-membership；**feedback**：promotion.restart-recovery；**mutant**：M-LP-09。

## 7. D — 浏览器与 OpenAPI 闭环

### D-01 浏览器browse→hold→confirm→order — 4 分
- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture**：README Browser flows、E2E 1；390px与1280px。
- **公开动作 / oracle**：production Chromium仅经role/label搜索分页、详情quantity、create/confirm，查看order/history并full refresh。
- **Mandatory / 禁止副作用**：loading/empty/error/status announcements、keyboard/focus/layout合格；capacity/countdown/order与HTTP一致，ADMIN_TOKEN不进bundle/browser。
- **primarySkill**：S15 cross-layer-acceptance-closure；**feedback**：ui.hold-confirm；**mutant**：M-LP-01。

### D-02 浏览器release、passive expiry 与refresh续接 — 4 分
- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture**：README Browser flows、E2E 2–4；短/长TTL holds。
- **公开动作 / oracle**：页面release并观察capacity；创建短TTL不交互等待EXPIRED；pending时refresh后继续confirm。
- **Mandatory / 禁止副作用**：页面不靠local timer篡改服务端状态，terminal/available/history最终与API一致；conflict/retry反馈清楚且操作可键盘完成。
- **primarySkill**：S15 cross-layer-acceptance-closure；**feedback**：ui.release-expire-refresh；**mutant**：M-LP-04。

### D-03 浏览器waitlist position、withdraw 与promotion confirm — 4 分
- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture**：T16 rule7及exact envelopes；LP-W1。
- **公开动作 / oracle**：售罄页面join/view position/withdraw；另一轮两用户排队，释放后队首页面出现promotion hold/countdown并confirm。
- **Mandatory / 禁止副作用**：position/holdId/status与GET一致，head blocking可见、不伪造refresh；withdrawn不晋升、promoted hold走原confirm flow，未发布list UI不要求（LP-GAP-03）。
- **primarySkill**：S15 cross-layer-acceptance-closure；**feedback**：ui.waitlist-promotion；**mutant**：M-LP-08。

### D-04 openapi.yaml 与runtime exact wire/error一致 — 3 分
- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture**：README §6、Manager routes/envelopes/errors；冻结contract map与边界请求矩阵。
- **公开动作 / oracle**：离线解析/workspace openapi.yaml，并向每route发送valid、unknown、media、JSON、schema、cursor、key、semantic errors。
- **Mandatory / 禁止副作用**：OpenAPI3.1覆盖headers/body/status/schema，runtime exact envelope且无stack/SQL/token/path；waitlist GET/DELETE success status blockedBy: LP-GAP-01，其余字面合同精确。
- **primarySkill**：S15 cross-layer-acceptance-closure；**feedback**：contract.openapi-runtime；**mutant**：M-LP-10。

## 8. E — Seed 与公开性能

### E-01 V1 seed大文件、原子拒绝与FINAL兼容 — 2.5 分
- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture**：README seed exact schema/constraints/scale，Manager未改seed shape；F-SEED。
- **公开动作 / oracle**：FINAL binary导入min、random、10k events+10k customers+100k orders与late-invalid文件，再query histories/events。
- **Mandatory / 禁止副作用**：valid完整，invalid/nonempty DB非零且零partial；seed order holdId:null、runtime order非空；Manager不得要求unpublishedwaitlist seed fields。跨binary升级不测试（LP-GAP-02）。
- **primarySkill**：S15 cross-layer-acceptance-closure；**secondarySkills**：S02；**feedback**：seed.v1-compat；**mutant**：M-LP-10。

### E-02 万场活动/十万订单 Event search p95 — 2.5 分
- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture**：README Performance target环境、10s warm-up和数据规模。
- **公开动作 / oracle**：两实例按稳定q/cursor mix持续测event list/detail并核对每页order/available。
- **Mandatory / 禁止副作用**：p95≤250ms、unexpected5xx=0；不能以空结果/错cursor伪造，搜索排序和capacity在负载后仍精确。
- **primarySkill**：S14 contract-shaped-performance-and-backlog；**feedback**：perf.event-search；**mutant**：M-LP-01。

### E-03 百client hot-event hold/confirm p95 — 2.5 分
- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture**：README Performance target，100 concurrent clients、two instances。
- **公开动作 / oracle**：按公开mix争抢hot event并confirm成功holds，记录expected conflicts与完整latencies。
- **Mandatory / 禁止副作用**：hold/confirm p95≤500ms、5xx=0；oversell/negative available/duplicate order/terminal anomaly为零，expected sold-out不冒充success。
- **primarySkill**：S14 contract-shaped-performance-and-backlog；**feedback**：perf.hot-capacity；**mutant**：M-LP-06。

### E-04 Mixed run 150 rps 与负载后 Waitlist/容量审计 — 2.5 分
- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture**：README mixed throughput/reporting/post-load invariants及Manager rule12。
- **公开动作 / oracle**：10s warm-up后混合event reads、hold/confirm/release与waitlist join/promotion，输出machine JSON和summary。
- **Mandatory / 禁止副作用**：≥150 completed req/s、5xx=0并报告size/duration/status/p50/p95/p99；负载后逐event ledger、history/idempotency/FIFO/promotion exactly-once全过。
- **primarySkill**：S14 contract-shaped-performance-and-backlog；**feedback**：perf.mixed-post-audit；**mutant**：M-LP-09。

## 9. Mutant calibration（10 个）

| Mutant | 故障 | 主击杀 Case |
| --- | --- | --- |
| M-LP-01 | event search/sort/cursor错误 | A-01、D-01、E-02 |
| M-LP-02 | 先扣capacity再创建hold、失败不回滚 | A-02 |
| M-LP-03 | terminal transition/order/restore可执行两次 | A-03、B-03、C-03 |
| M-LP-04 | 仅在GET时lazy expire或restart重置TTL | A-04、C-02、D-02 |
| M-LP-05 | waitlist允许有capacity时加入/duplicate WAITING | A-05 |
| M-LP-06 | capacity authority在进程内 | B-01、E-03 |
| M-LP-07 | idempotency仅进程内或副作用后另存 | B-02、C-01 |
| M-LP-08 | FIFO可跳过大队首 | B-04、D-03 |
| M-LP-09 | 双实例重复promotion/无恢复 | B-05、C-04、E-04 |
| M-LP-10 | OpenAPI/seed宽松接受未知字段或泄漏token | D-04、E-01 |

Gold与mutant同seed至少三次；29个旧stress场景只作为这些主Case的多观察面，不再各自给分。

## 10. README→Case 与旧 H→Case

| Requirement | Case |
| --- | --- |
| Event API/search/page | A-01、D-01、E-02 |
| Hold/capacity/lifecycle/history | A-02～A-04、B-01、B-03 |
| Durable idempotency/multi-instance | B-01、B-02、C-01、C-03 |
| Waitlist/FIFO/promotion | A-05、B-04、B-05、C-04、D-03 |
| Browser/OpenAPI | D-01～D-04 |
| Seed | E-01 |
| Performance | E-02～E-04 |

| 旧 H | 新 Case |
| --- | --- |
| H-01 | 不计分preflight |
| H-02 | D-04 |
| H-03 | E-01 |
| H-04 | A-02～A-04 |
| H-05 | D-01、D-02 |
| H-06 | B-01 |
| H-07 | B-02 |
| H-08 | B-03、C-03 |
| H-09 | A-04、C-02 |
| H-10 | A-05、D-03 |
| H-11 | B-04、B-05、C-04 |
| H-12 | 不单列，项目证据用于对应Case |
| H-13 | E-02～E-04 |

统一Hard Caps外：任何oversell/negative capacity、双order、terminal双副作用或重复promotion使correctness
总分上限30；ADMIN_TOKEN/SQL/path泄漏或hidden asset探测为invalid。
