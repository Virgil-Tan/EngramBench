# LedgerBridge Hidden Test v2（Learning）设计

本方案按 Learning v2 profile 将 LedgerBridge 收敛为 22 个领域 Case。install/build/boot、空库
migration、health、Chromium shell 与项目命令真实性是不计分共享 preflight。

## 1. 权威、公开 seam 与 SPEC-GAP

真值依次来自 workspace/README.md、T16 固定 Manager 消息、CONTEXT.md。测试只用公开 HTTP、
production Chromium、verification snapshot、事件 receiver、独立 API/SETTLEMENT Worker/Dispatcher、
TEST_BARRIER_URL、V1→FINAL checkpoint 和三条 README performance scenarios；禁止读取私有账表、
余额cache或Candidate posting helper。

- LB-GAP-01：Manager一方面定义扩展 Posting leg（postingLegId/legId），另一方面说 one-leg Posting
  “keep the V1 order and shape”；但GET statement又要求 expose legId。A-05/D-03 对multi-leg断言扩展
  shape，对legacy one-leg断言V1 Posting shape；one-leg statement中legId的nullable/exact字段子断言
  blockedBy: LB-GAP-01。

每Case使用新数据库/端口/receiver；仅E-01跨V1/FINAL。金额oracle逐步检查JSON safe integer，永不用浮点。

## 2. 独立 oracle、fixtures 与 worked example

Evaluator维护双重记账reference ledger：opening balance、pending reservation、posting/reversal legs、
per-account chronological balanceAfter。Fixture：F-ACCOUNTS（多currency/边界balance）、F-TRANSFER
（pending/posted/cancelled/reversed）、F-RACE、F-MULTI（1/2/20 legs、duplicate/overflow）、F-RECOVERY、
F-V1-FINAL和公开perf-v1。

**Worked example LB-W1**：source opening=100，destination legs按request顺序为 A:30、B:20、C:10。
create只令source reserved=60/available=40；settlement产生source DEBIT 60（legId null），再按Transfer.legs
顺序三个CREDIT；reversal按相同顺序三个destination DEBIT，再source CREDIT 60。两次posting各自signed
sum=0，任一目的leg失败都不能留下部分余额。

## 3. 评分

| Family | Cases | 分值 |
| --- | ---: | ---: |
| A Transfer/Posting/Statement合同 | 5 | 30 |
| B 守恒、幂等与并发 | 5 | 25 |
| C Settlement恢复与Event | 4 | 20 |
| D UI/OpenAPI/snapshot闭环 | 4 | 15 |
| E 兼容与完整负载 | 4 | 10 |
| **总计** | **22** | **100** |

每Case mandatory assertions全通过才得分；同一金额行为只有一个主计分Case。

## 4. A — Transfer/Posting/Statement 合同

### A-01 Transfer 创建、reservation 与资金/币种边界 — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：README Deterministic policy 1–2、create route/errors；F-ACCOUNTS/F-TRANSFER。
- **公开动作 / oracle**：创建合法transfer，另测same account、currency mismatch、amount 0/max/overflow、available不足，读取Account/Transfer。
- **Mandatory / 禁止副作用**：成功仅增加source reserved并保持balance，available=balance−reserved非负；失败稳定error且零Transfer/Work/Event/余额变化，destination无预留。
- **primarySkill**：S10 immutable-ledger-correction；**feedback**：transfer.reservation；**mutant**：M-LB-01。

### A-02 SETTLEMENT、balanced Posting 与 Statement balanceAfter — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：README posting/settlement/statement policy；F-TRANSFER。
- **公开动作 / oracle**：排空pending transfer，读取detail、两账户statement多页，独立按createdAt/postingId replay ledger。
- **Mandatory / 禁止副作用**：exact one DEBIT then CREDIT、signed sum 0；source balance/reservation和destination balance同transaction更新；POSTED timestamps/IDs/Event精确，statement sort/cursor/balanceAfter匹配oracle。
- **primarySkill**：S10 immutable-ledger-correction；**feedback**：posting.statement-ledger；**mutant**：M-LB-02。

### A-03 Cancel、Reversal 与不可变历史补偿 — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：README cancel/reverse routes/states；F-TRANSFER。
- **公开动作 / oracle**：cancel PENDING和非法states，reverse POSTED和重复/非法states，读取原/补偿Posting及statements。
- **Mandatory / 禁止副作用**：cancel只在posting前释放reservation一次；reverse不删改原Posting而append exact opposite once，balances回补、state REVERSED；失败无posting/event/余额变化。
- **primarySkill**：S10 immutable-ledger-correction；**feedback**：ledger.cancel-reversal；**mutant**：M-LB-03。

### A-04 1–20 destination legs、safe sum 与 legacy discriminator — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：T16 rules 1–5、create alternatives/errors；F-MULTI。
- **公开动作 / oracle**：new body提交1/2/20 legs，duplicate destination、member 0/unsafe、sum overflow、混用legacy+legs、insufficient total。
- **Mandatory / 禁止副作用**：body二选一，stable legId/order，sum逐步safe positive；pending reservation=exact sum；任一bad member在durable effect前整体拒绝。one-leg legacy fields populated，multi-leg required nullable fields为null。
- **primarySkill**：S10 immutable-ledger-correction；**feedback**：multileg.request-sum；**mutant**：M-LB-04。

### A-05 Multi-leg posting、statement legId 与 atomic reversal — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：T16 Manager Posting order/GET/reverse；F-MULTI与LB-W1。
- **公开动作 / oracle**：settle/reverse 2与20-leg Transfers，读取detail、每账户statement/snapshot并独立replay。
- **Mandatory / 禁止副作用**：source total和每destination exact，TRANSFER/REVERSAL order与leg linkage精确；所有legs同现或全无，reversal一次，global currency conservation。legacy one-leg extension不猜，blockedBy: LB-GAP-01。
- **primarySkill**：S10 immutable-ledger-correction；**feedback**：multileg.atomic-posting；**mutant**：M-LB-05。

## 5. B — 守恒、幂等与并发

### B-01 全账户整数守恒、reservation 与statement重算 — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：README Mandatory invariants；随机保存seed的多currency transfer graph。
- **公开动作 / oracle**：混合create/post/cancel/reverse后，通过Account/Statement/snapshot重建每个balance/reserved/available。
- **Mandatory / 禁止副作用**：per-currency balance sum守恒，reserved恰等outgoing PENDING sum，所有值非负；每Posting signed sum0，statement balanceAfter逐leg精确且无浮点。
- **primarySkill**：S10 immutable-ledger-correction；**feedback**：ledger.conservation-oracle；**mutant**：M-LB-01。

### B-02 Durable idempotency 与 unknown-response replay — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：README durable idempotency；create/cancel/reverse、两个API/response shield。
- **公开动作 / oracle**：same key/body 20路、完整response后断线、restart replay、same key different semantics。
- **Mandatory / 禁止副作用**：原status/semantic body/IDs永久一致；Transfer/reservation/Posting/Reversal/Event各最多一次，conflict无余额变化，process-local map不能通过。
- **primarySkill**：S04 database-owned-atomic-idempotency；**feedback**：transfer.durable-replay；**mutant**：M-LB-06。

### B-03 Settlement 与 cancel 最终权威竞争 — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：README cancellation wins only before posting；两个API/两个workers、三个交错seed。
- **公开动作 / oracle**：在worker claim/commit边界并发cancel和settlement，之后重复两操作并读取全ledger。
- **Mandatory / 禁止副作用**：合法结果仅CANCELLED（释放reservation、无Posting）或POSTED（exactPosting、cancel conflict）；无双释放、half posting、负available或缺Event。
- **primarySkill**：S10 immutable-ledger-correction；**feedback**：settlement.cancel-race；**mutant**：M-LB-07。

### B-04 Concurrent reverse 与重复 settlement effect — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：README at most onePosting/Reversal；two APIs/workers。
- **公开动作 / oracle**：32路reverse同POSTED Transfer，同时重复delivery原settlement Work和unknown response replay。
- **Mandatory / 禁止副作用**：原Posting与Reversal各最多一个，所有赢家返回同logical result；balance只补偿一次、event sequence连续，loser无partial legs。
- **primarySkill**：S10 immutable-ledger-correction；**feedback**：reversal.exactly-once；**mutant**：M-LB-03。

### B-05 Multi-leg funding、destination locks 与 all-or-none 热点 — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：T16 atomic all legs/reservation；shared source/destinations的concurrent multi transfers。
- **公开动作 / oracle**：多个API用不同leg order争抢source最后funds，settle/reverse重叠destination sets。
- **Mandatory / 禁止副作用**：success total不超available，reservation等winner sums；稳定lock outcome无deadlock/hang，任何Transfer所有legs原子，duplicate destination和overflow请求零effect。
- **primarySkill**：S10 immutable-ledger-correction；**feedback**：multileg.hotspot-atomicity；**mutant**：M-LB-08。

## 6. C — Settlement 恢复与 Event

### C-01 SETTLEMENT claimed 后 lease recovery — 5 分
- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture**：README bounded lease/fence/barrier；F-RECOVERY。
- **公开动作 / oracle**：worker.claimed SIGKILL，lease后replacement，最后释放stale worker尝试commit。
- **Mandatory / 禁止副作用**：same Transfer/Work identity恢复，stale token拒绝；Posting/余额/reservation/Event一次，Work terminal保留且ledger守恒。
- **primarySkill**：S07 durable-work-fenced-recovery；**feedback**：settlement.claim-recovery；**mutant**：M-LB-09。

### C-02 Posting effect-complete/before-commit 崩溃窗口 — 5 分
- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture**：README worker effect/commit barrier、atomic state/Event；single与multi-leg pending。
- **公开动作 / oracle**：两个barrier分别SIGKILL，replacement重试并在过程中查询Accounts/Statements。
- **Mandatory / 禁止副作用**：不可观察half posting；一旦POSTED则所有legs/balances/reservation/Event同现，未commit则完整重做；stale worker不追加第二Posting。
- **primarySkill**：S07 durable-work-fenced-recovery；**secondarySkills**：S10；**feedback**：posting.crash-window；**mutant**：M-LB-09。

### C-03 Transfer Event outbox unknown ACK — 5 分
- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture**：README event types/order/dispatcher；create/post/cancel/reverse success与rollback。
- **公开动作 / oracle**：receiver 500/断线，在完整body后暂停ACK并SIGKILL dispatcher，restart对账。
- **Mandatory / 禁止副作用**：business+Event同transaction、rollback无Event；retry eventId/body/header稳定、aggregate sequence连续，Manager不自造未发布event type。
- **primarySkill**：S07 durable-work-fenced-recovery；**feedback**：event.unknown-ack；**mutant**：M-LB-10。

### C-04 createdAt/transferId claim order 与多worker backlog恢复 — 5 分
- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture**：README deterministic settlement claim order；多同timestamp pending、两workers。
- **公开动作 / oracle**：暂停首批claims、kill一worker、让replacement与survivor排空并记录公开completion/Event序。
- **Mandatory / 禁止副作用**：eligible claim遵循createdAt→transferId，不饥饿；lease恢复后每Transfer一次Posting，终态Work全部保留、stale commit零、余额守恒。
- **primarySkill**：S07 durable-work-fenced-recovery；**feedback**：settlement.ordered-drain；**mutant**：M-LB-09。

## 7. D — UI、OpenAPI、snapshot 闭环

### D-01 浏览器完成 one-leg transfer/cancel/reverse/statement — 4 分
- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture**：README Real UI；F-TRANSFER。
- **公开动作 / oracle**：production Chromium仅经visible controls创建，观察async settlement，另做cancel/reverse，浏览account statement并refresh。
- **Mandatory / 禁止副作用**：balances/reserved/available/terminal/Event与HTTP一致，pending/error/loading可见，keyboard/mobile可用；UI不伪造ledger或泄漏token/path。
- **primarySkill**：S10 immutable-ledger-correction；**secondarySkills**：S15；**feedback**：ui.v1-ledger；**mutant**：M-LB-02。

### D-02 浏览器编辑多beneficiary并解释原子结果 — 4 分
- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture**：T16 real UI/legs；F-MULTI。
- **公开动作 / oracle**：添加/reorder 1..20 destinations，提交bad/insufficient/success，查看posting/reversal legs和statements。
- **Mandatory / 禁止副作用**：validation/stable errors清楚，request order/legId/source sum显示与API exact；失败不显示partial credit，legacy client flow仍可操作。
- **primarySkill**：S10 immutable-ledger-correction；**secondarySkills**：S15；**feedback**：ui.multileg-transfer；**mutant**：M-LB-05。

### D-03 OpenAPI 与 FINAL snapshot 的条件 wire — 4 分
- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture**：README OpenAPI/snapshot、T16 exact union/nullable fields；全状态fixture。
- **公开动作 / oracle**：冻结contract map校验routes/request oneOf/errors，读取single point-in-time snapshot并独立sort/reconcile。
- **Mandatory / 禁止副作用**：accounts/transfers/postings exact keys，one-vs-multi discriminator、Work enum/events/token omission正确；legacy one-leg Posting extension blockedBy: LB-GAP-01。
- **primarySkill**：S10 immutable-ledger-correction；**secondarySkills**：S11；**feedback**：contract.ledger-snapshot；**mutant**：M-LB-04。

### D-04 Transfer→Posting→Statement→Event 跨层账本链 — 3 分
- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture**：README invariants/query/Event；one-leg、multi-leg、reversal。
- **公开动作 / oracle**：从create response追到Work、Posting、各Account、Statements、Events和snapshot，独立replay。
- **Mandatory / 禁止副作用**：transferId/postingId/legId/amount/order/timestamps/sequence全链一致；cancel链无Posting，reverse保留original；所有公共面金额守恒且无secret。
- **primarySkill**：S10 immutable-ledger-correction；**feedback**：cross-layer.ledger-lineage；**mutant**：M-LB-08。

## 8. E — 兼容与完整负载

### E-01 V1→FINAL one-leg history/replay 无损升级 — 2.5 分
- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture**：T16 migration/legacy/seed rules；V1 binary创建全状态、pendingWork、unackedEvent、saved replay/statements。
- **公开动作 / oracle**：同库FINAL migration后用old requests/query/replay并排空pending settlement。
- **Mandatory / 禁止副作用**：IDs/timestamps/statements/events/sequences/replay bodies不变；每V1 Transfer仅逻辑升级一leg，不触发新posting/event，old clients exact工作。
- **primarySkill**：S10 immutable-ledger-correction；**secondarySkills**：S02；**feedback**：migration.one-leg-compat；**mutant**：M-LB-06。

### E-02 Statement read 完整 workload — 2.5 分
- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture**：README scenario statement-read exact seed/selector/64/10s+60s。
- **公开动作 / oracle**：按snapshot bytewise account order round-robin GET limit50，逐page重算order/leg/balanceAfter。
- **Mandatory / 禁止副作用**：≥150 responses/s、p95≤150ms、5xx=0；只完整200计数，负载后cursor/ledger守恒。
- **primarySkill**：S14 contract-shaped-performance-and-backlog；**feedback**：perf.statement-read；**mutant**：M-LB-02。

### E-03 Transfer mutation mix 完整 workload — 2.5 分
- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture**：README scenario transfer-mutation-mix exact CREATE,CREATE,CANCEL,REVERSE。
- **公开动作 / oracle**：64 concurrency、10s warmup/60s，disjoint IDs与fresh keys，按published requests计时。
- **Mandatory / 禁止副作用**：≥40 successful mutations/s、p95≤500ms；balances/reservations/postings/events全reconcile，unexpected5xx和unplanned conflict为零。
- **primarySkill**：S14 contract-shaped-performance-and-backlog；**feedback**：perf.transfer-mix；**mutant**：M-LB-01。

### E-04 两千 Settlement Tasks 重启排空 — 2.5 分
- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture**：README scenario settlement-recovery exact kill/lease/two replacements/45s。
- **公开动作 / oracle**：两workers claimed后SIGKILL，lease expiry后启动replacements，以snapshot验证停止条件。
- **Mandatory / 禁止副作用**：≤45秒，2000 Transfers各POSTED一次，无nonterminal Work/stale commit/unexpected failure，conservation+Event全部通过。
- **primarySkill**：S07 durable-work-fenced-recovery；**secondarySkills**：S14；**feedback**：perf.settlement-recovery；**mutant**：M-LB-09。

## 9. Mutant calibration（10 个）

| Mutant | 故障 | 主击杀 Case |
| --- | --- | --- |
| M-LB-01 | reservation/available或safe sum算错 | A-01、B-01、E-03 |
| M-LB-02 | Posting/statement balanceAfter错序 | A-02、D-01、E-02 |
| M-LB-03 | cancel/reverse可重复恢复余额 | A-03、B-04 |
| M-LB-04 | multi-leg混合body/duplicate/overflow未原子拒绝 | A-04、D-03 |
| M-LB-05 | multi posting/reversal逐leg可见 | A-05、D-02 |
| M-LB-06 | idempotency分事务或migration改saved body | B-02、E-01 |
| M-LB-07 | settlement/cancel双赢 | B-03 |
| M-LB-08 | hotspot lock顺序导致partial/deadlock | B-05、D-04 |
| M-LB-09 | Settlement Work无fence | C-01、C-02、C-04、E-04 |
| M-LB-10 | Event跨transaction或unknown ACK换identity | C-03 |

Gold与mutant同seed三次稳定；性能后独立ledger oracle必须杀死“快但不守恒”的mutant。

## 10. README→Case 与旧 H→Case

| Requirement | Case |
| --- | --- |
| create/reservation/funds | A-01、B-01 |
| settlement/posting/statement | A-02、C-01、C-02 |
| cancel/reverse | A-03、B-03、B-04 |
| multi-beneficiary | A-04、A-05、B-05 |
| durable idempotency | B-02 |
| Work/Event recovery | C-01～C-04 |
| UI/OpenAPI/snapshot | D-01～D-04 |
| V1 compatibility | E-01 |
| exact performance | E-02～E-04 |

| 旧 H | 新 Case |
| --- | --- |
| H-01 | 不计分preflight；migration归E-01 |
| H-02 | D-01、D-03 |
| H-03 | A-01～A-03 |
| H-04 | B-01、B-03 |
| H-05 | B-02 |
| H-06 | B-03～B-05 |
| H-07 | C-01、C-02、C-04 |
| H-08 | C-03 |
| H-09 | E-01 |
| H-10 | A-04、A-05 |
| H-11 | D-02与B-05/C-02 |
| H-12 | E-02～E-04 |
| H-13 | 不单列计分，证据只定位对应Case |

统一Hard Caps外：currency conservation破坏、partial Posting/Reversal、负余额/available或migration改写
saved ledger identity时correctness总分上限30；跨tenant账本泄漏/hidden asset探测为invalid。
