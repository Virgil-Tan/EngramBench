# SeatReserve Hidden Test v2 设计

## 边界与权重

- 权威：`workspace/README.md`、`orchestration/manager-prompt.zh-CN.md`、`CONTEXT.md`；旧 E2E 只作映射。
- 22 个名义 Case，A/B/C/D/E=30/25/20/15/10，总权重 100。核心 primarySkill 聚焦 S04、S05、S07、S17；排序、迁移、snapshot、性能与跨层能力只作对应 Case 的 secondarySkills；S03/S16 仅 observer。
- install/build/migrate replay/boot/health/OpenAPI parse/Chromium shell 为不计分 preflight；oracle 由 harness 的 live-seat owner、冻结价格、provider identity、FIFO/contiguous selection ledger 计算。

## SPEC-GAP 与评分就绪

- `SPEC-GAP-SR-01`：Manager 未发布 WaitlistEntry GET/list，也未发布从 Entry 发现异步 SeatOffer ID 的用户查询 seam；D-03 的“refresh 后发现 offer/进度”子断言 `blockedBy=SPEC-GAP-SR-01`。后台行为可通过公开 verification snapshot 与已知 offerId 检查，但不得把 admin snapshot 当用户 UI 数据源。
- `SPEC-GAP-SR-02`：Manager 未发布 waitlist/offer 专属 event type；不得自造类型。
- blocked 子断言权重不转移；其余 Cases 可执行。

## Worked example

Zone Z 的 row A 空座为 1,2,3,5,6；row B 为 1,2,3。Entry 要 3 席且允许 Z。oracle 按 `(zoneId,row,first number)` 选择 A1–A3，不能拼 A5–A6+B1，也不能先选 B1–B3。三席 current ACTIVE PriceVersion 均不超过 cap 时同事务创建一个 ACTIVE Offer 并占有全部座位；任一席超 cap 则保持 WAITING 且零 partial owner。

## Scoring Cases

### A-01 1..12 SeatHold 原子占有、TTL 与冻结价格 — 6 分
来源：README「Inventory, holds, and pricing」；Fixture：边界 seat count/TTL 30..900、重复/已占 seats、ACTIVE PriceVersion 切换；动作：公开 hold create/read。
Oracle/Mandatory：全部 seats 同事务 live-owned，created DB time+TTL、每席 priceVersion/amount 冻结、total 整数精确；禁止副作用：非法/冲突不得 partial Hold/owner/Work/Event。
归因：dimension=A；primarySkill=S04；feedback=A.hold-atomicity；mutant=M01。

### A-02 Checkout 与 Provider UNKNOWN identity — 6 分
来源：README「Checkout and uncertain payment」；Fixture：HELD hold、provider ACCEPTED/DECLINED/UNKNOWN、stable request identity；动作：公开 checkout/provider seam。
Oracle/Mandatory：order/payment 使用冻结金额，UNKNOWN 保持可 reconcile 的 stable providerRequestId，最多一个真实 charge/order transition；禁止副作用：未知不得当失败重扣或改冻结价格。
归因：dimension=A；primarySkill=S05；feedback=A.payment-uncertainty；mutant=M02。

### A-03 Hold expiry、Order ownership 与 seat conservation — 6 分
来源：README domain/state/work rules；Fixture：到期边界、已 checkout/terminal holds；动作：expiry worker/reads。
Oracle/Mandatory：数据库时钟下仅 live HELD owner 到期释放，Order-owned seat 不释放，所有 Seat 在 Hold/Order owner 中至多一；禁止副作用：不得双释放、terminal回退或删 immutable price/payment history。
归因：dimension=A；primarySkill=S04；feedback=A.seat-conservation；mutant=M03。

### A-04 Waitlist FIFO 与连续座位 deterministic match — 6 分
来源：Manager 第 1–2 段；Fixture：createdAt/ID ties、allowed zones、rows/gaps、price cap、1/8 seats；动作：create Entries、释放 seats、drain `WAITLIST_MATCH`。
Oracle/Mandatory：Entries 按 `(createdAt,waitlistEntryId)`，seat set 同 event/zone/row/strict contiguous，候选按 `(zoneId,row,first number)`；不足/超价保持 WAITING且零partial Offer；禁止副作用：不得跳过更早可满足 Entry、拼接跨 row 座位或留下 partial owner。
归因：dimension=A；primarySkill=S05；secondarySkills=S06；feedback=A.waitlist-order；mutant=M04。

### A-05 SeatOffer 冻结、120s 与 lifecycle — 6 分
来源：Manager Offer rules/resources/routes；Fixture：ACTIVE offer、DB time 边界、price later changes；动作：GET/accept/decline/expiry/cancel。
Oracle/Mandatory：全部 items/price/current ACTIVE version 在 create 冻结、expiresAt=createdAt+120s；accept 原子建300s HELD hold+FULFILLED，decline/expiry/cancel按规则释放/回 WAITING；禁止副作用：不得 partial accept、重价或多 live owner。
归因：dimension=A；primarySkill=S04；feedback=A.offer-state；mutant=M05。

### B-01 Hold/checkout mutation durable replay — 5 分
来源：README idempotency；Fixture：same key/semantic conflict、20 concurrent、shield/restart；动作：跨 API create/checkout replay。
Oracle/Mandatory：original status/body/IDs/provider identity 与一个 seat/payment effect；禁止副作用：conflict key 不得占 seat、创建 charge/Work/Event。
归因：dimension=B；primarySkill=S04；feedback=B.idempotency；mutant=M06。

### B-02 Hot seats 多 API Hold 竞争不超卖 — 5 分
来源：README live owner invariant；Fixture：K seats、重叠 multi-seat requests、两个 API；动作：并发 create。
Oracle/Mandatory：成功集合可线性化且每 Seat 至多一 live Hold/Order，失败 request 零 owner；禁止副作用：不得拆单抢部分 seats 或跨 tenant/event 占用。
归因：dimension=B；primarySkill=S04；feedback=B.hold-contention；mutant=M01。

### B-03 Receipt/reconcile/expiry 交换律与 payment 单终态 — 5 分
来源：README uncertain payment/recovery；Fixture：UNKNOWN Payment、provider receipt/reconcile 与 Hold expiry 排列；动作：公开 seams 全排列。
Oracle/Mandatory：相同外部事实最终 Payment/Order/seat ownership 一致，stable provider identity、terminal不回退；禁止副作用：不得 double charge/order 或错误释放 accepted Order seats。
归因：dimension=B；primarySkill=S05；feedback=B.payment-commutativity；mutant=M02。

### B-04 并发 release/match 保持 FIFO 与 owner 唯一 — 5 分
来源：Manager matching/concurrency；Fixture：多个 WAITING Entries、多个释放者/worker；动作：并发 expiry/release与match claim。
Oracle/Mandatory：每个提交点按 FIFO/head eligibility 分配，Entry最多一个 ACTIVE Offer，Seat 在 Hold/Order/Offer 三类 owner 至多一；禁止副作用：不得跳早期可满足 Entry、重复 Offer 或 partial set。
归因：dimension=B；primarySkill=S17；feedback=B.waitlist-contention；mutant=M04。

### B-05 accept/decline/cancel/expiry 竞争单一终态 — 5 分
来源：Manager Offer lifecycle/fence/errors；Fixture：ACTIVE offer at 120s boundary、old workers；动作：四种 mutation/worker 并发。
Oracle/Mandatory：只接受一个合法线性结果；accept winner 产生恰一 Hold，其他 winners按各自精确 state释放/恢复，old lease fenced；禁止副作用：不得双终态、Offer与Hold同时重复 owner或过期accept。
归因：dimension=B；primarySkill=S04；feedback=B.offer-race；mutant=M07。

### C-01 Hold expiry Work reclaim 与 stale fence — 5 分
来源：README Work/events/recovery 与公开 snapshot Work shape；Fixture：short lease、two workers；动作：轮询 snapshot 观察 HOLD_EXPIRY 为 LEASED 后 SIGKILL owner，再 reclaim。
Oracle/Mandatory：合法 expired Hold 一次释放、old token cannot commit、Work terminal retained；禁止副作用：不得永久 occupied、double release/event 或在外部等待期间持事务。
归因：dimension=C；primarySkill=S07；feedback=C.hold-recovery；mutant=M08。

### C-02 Provider 已持久化但 response unknown 的 payment recovery — 5 分
来源：README provider uncertainty/recovery；Fixture：Provider double 记录原 providerRequestId 的 effect 后断开 response，且 snapshot 显示 PAYMENT_CAPTURE/RECONCILE LEASED；动作：SIGKILL owner 后 restart/reconcile/replay。
Oracle/Mandatory：使用原 provider identity 收敛一个 Payment/Order outcome，seat owner与真实 charge一致；禁止副作用：不得新 identity重扣或伪造撤回。
归因：dimension=C；primarySkill=S07；feedback=C.payment-recovery；mutant=M02。

### C-03 WAITLIST_MATCH/OFFER_EXPIRY 崩溃后闭合 — 5 分
来源：Manager Work aggregateId/fence/recovery 与公开 snapshot；Fixture：mixed Entries/offers、short lease；动作：观察 WAITLIST_MATCH/OFFER_EXPIRY 为 LEASED 后 kill owner，再 reclaim/replacements/drain。
Oracle/Mandatory：最终 selection等于FIFO/contiguous oracle，每 Entry最多一active/terminal Offer，expired Entry不复活，old lease fenced；禁止副作用：不得漏/重Offer或永久占 seat。
归因：dimension=C；primarySkill=S07；feedback=C.waitlist-recovery；mutant=M09。

### C-04 Seat/payment event unknown ACK — 5 分
来源：README event/dispatcher + Manager stable event compatibility；Fixture：success/rollback transitions、receiver 500，或 receiver 持久化完整 request 后不返回 ACK；动作：dispatcher kill/restart。
Oracle/Mandatory：committed effect有稳定eventId/body、aggregate sequence成功递增；禁止副作用：rollback无event、retry不换identity、自造未发布Offer event type。
归因：dimension=C；primarySkill=S07；feedback=C.outbox；mutant=M10。

### D-01 V1/Waitlist/Offer wire、errors 与 tenant scope — 4 分
来源：README Public HTTP + Manager exact resources/routes/errors；Fixture：unknown fields、count/price/time/ID boundaries、cross tenant；动作：仅HTTP。
Oracle/Mandatory：exact status/body/enums/error envelope、strict JSON/DB-time semantics；禁止副作用：GET/拒绝零mutation、不得接受float/extra key。
归因：dimension=D；primarySkill=S05；secondarySkills=S15；feedback=D.api-contract；mutant=M05。

### D-02 浏览器完成 seat map→Hold→checkout/reconcile — 4 分
来源：README UI/project verification；Fixture：真实DB/API/workers/provider、桌面移动；动作：visible controls + refresh。
Oracle/Mandatory：availability/frozenprice/timer/payment UNKNOWN/terminal 与HTTP/provider ledger一致，keyboard/error/offline可用；禁止副作用：不得mock、client-only lock或隐藏uncertain payment。
归因：dimension=D；primarySkill=S04；secondarySkills=S15；feedback=D.browser-v1；mutant=M01。

### D-03 浏览器完成 waitlist/offer 倒计时与控制 — 4 分
refresh/discovery子断言 blockedBy=`SPEC-GAP-SR-01`；来源：Manager UI clause；Fixture：worked-example、ACTIVE/expired offers；动作：visible create/cancel/accept/decline。
Oracle/Mandatory：冻结seat/price/120s、state/error与HTTP/oracle一致；待公开用户read seam后验证refresh发现offer；禁止副作用：不得用admin snapshot/client memory作生产authority或显示partial offer。
归因：dimension=D；primarySkill=S17；secondarySkills=S15；feedback=D.browser-manager；mutant=M07。

### D-04 FINAL snapshot 单时点 live-owner closure — 3 分
来源：README snapshot + Manager WaitlistEntry/SeatOffer/Work union；Fixture：all seats/holds/orders/payments/entries/offers/work/events；动作：authorized snapshot。
Oracle/Mandatory：exact keys/shapes/sorts/same asOf/Work retention/token omission；harness重算每Seat live owner和所有金额；禁止副作用：不得多时点拼接、漏terminal Work或泄露provider/idempotency tokens。
归因：dimension=D；primarySkill=S04；secondarySkills=S11；feedback=D.snapshot；mutant=M10。

### E-01 Populated V1→Waitlist FINAL 兼容迁移 — 3 分
来源：Manager compatibility migration clause；Fixture：V1 Seat/Hold/Order/Payment/saved replay/pending Work/Event；动作：upgrade/recover/replay。
Oracle/Mandatory：所有V1 identity/price/payment/body/work/event保持，pending按旧fence收敛，新增资源为空直到public API创建；禁止副作用：不得把free seats自动建Offer或改saved response。
归因：dimension=E；primarySkill=S04；secondarySkills=S02；feedback=E.compatibility；mutant=M06。

### E-02 `seat-hold-ingest` 固定负载 — 3 分
来源：README/project verification fixed scenario；Fixture：50,000 holds、公开seed/concurrency/timer；动作：public hold HTTP。
Oracle/Mandatory：`>=250/s`、p95 `<=400ms`、5xx=0，post-load owner/price/idempotency invariants；禁止副作用：不得缩dataset、计warmup或只数accepted request。
归因：dimension=E；primarySkill=S04；secondarySkills=S14；feedback=E.hold-performance；mutant=M01。

### E-03 `hot-seat-contention` 竞争负载 — 2 分
来源：README fixed scenario；Fixture：20,000 attempts/1,000 seats、公开并发；动作：规定HTTP workload。
Oracle/Mandatory：`>=300/s`、p95 `<=500ms`、每Seat最多一live owner、expected conflicts独立统计；禁止副作用：不得per-process owner或把conflict算5xx。
归因：dimension=E；primarySkill=S04；secondarySkills=S14；feedback=E.contention-performance；mutant=M01。

### E-04 `payment-expiry-recovery` 恢复负载 — 2 分
来源：README fixed scenario；Fixture：5,000 items、kill2 workers+4 replacements；动作：public snapshot 观察两个目标 Work 为 LEASED 后杀 owner并开始 timer。
Oracle/Mandatory：`<=90s`闭合、payment/expiry/seat owner无重复遗漏、stale token零提交；禁止副作用：不得random sleep、缩backlog或绕production workers。
归因：dimension=E；primarySkill=S07；secondarySkills=S14；feedback=E.recovery-performance；mutant=M09。

## Mutants

| Mutant | 领域缺陷 | 必杀 Case |
|---|---|---|
| M01 | multi-seat hold逐席commit/并发超卖 | A-01、B-02、E-02、E-03 |
| M02 | UNKNOWN重试换provider identity/double charge | A-02、B-03、C-02 |
| M03 | expiry释放Order-owned或double release | A-03 |
| M04 | waitlist跳FIFO/拼跨row/noncontiguous seats | A-04、B-04 |
| M05 | Offer不冻price/120s错/accept partial | A-05、D-01 |
| M06 | 幂等保存晚于effect/迁移改saved body | B-01、E-01 |
| M07 | accept/decline/cancel/expiry不串行 | B-05、D-03 |
| M08 | expired Hold worker仍可commit | C-01 |
| M09 | match/offer expiry crash后重复或漏成员 | C-03、E-04 |
| M10 | outbox非原子或snapshot漏live owner | C-04、D-04 |

## Coverage mapping

**README / Manager → Case**

| README/Manager requirement | Cases |
|---|---|
| Hold/price/checkout/payment/expiry | A-01..A-03、B-01..B-03、C-01..C-02 |
| Waitlist/contiguous Offer/lifecycle | A-04..A-05、B-04..B-05、C-03、D-03 |
| Events/recovery | C-01..C-04 |
| HTTP/UI/snapshot | D-01..D-04 |
| Migration/performance | E-01..E-04 |

**旧 H → Case**

| 旧 H family | v2 Cases |
|---|---|
| H-01 | 不计分 preflight |
| H-02..H-04 | A-01..A-03、D-01..D-02 |
| H-05..H-08 | B-01..B-03、C-01..C-02、C-04 |
| H-09 | E-01 |
| H-10..H-11 | A-04..A-05、B-04..B-05、C-03、D-03..D-04（D-03部分blocked） |
| H-12 | E-02..E-04 |
| H-13 | D/项目证据，不另计分 |

## Evidence/hard caps

保存fixture、HTTP/provider/seat-owner ledger、DB-time/snapshot/进程信号/receiver transcript、独立FIFO/contiguous/price oracle、snapshot digest。超卖、partial Hold/Offer、double charge、terminal回退或atomic rejection失败总分上限35；幂等第二effect上限30；stale worker可提交/Work丢失上限40；迁移改V1 identity/replay上限35；性能后不变量失败使对应E Case为0并应用correctness cap。SR-01 blocked子断言不得改权或用admin seam冒充用户合同。
