# RouteWeave Hidden Test v2 设计

## 边界与权重

- 权威：`workspace/README.md`、Manager fixed prompt、`CONTEXT.md`；旧 E2E 只作 H→Case 索引。
- 22 Case，A/B/C/D/E=30/25/20/15/10，总分 100。核心 primarySkill 聚焦 S06、S07、S08、S17；幂等、迁移、snapshot、性能与跨层能力只作对应 Case 的 secondarySkills；S03/S16 仅可作 observer。
- install/build/migration replay/boot/health/OpenAPI parse/Chromium shell 是不计分 preflight。
- Oracle 从冻结 RoutePlan、公开 precedence、依赖约束及所有 ScanEvent 重放得到；候选 Projection/snapshot 只是被测输出。

## SPEC-GAP

- `SPEC-GAP-RW-01`：Manager 说 consignment GET“同时返回”三种资源但未字面给出 wrapper shape；D-01 断言三个资源的 exact member shape、pieceRef order 与语义内容，不臆造额外 wrapper 严格字段。
- `SPEC-GAP-RW-02`：Manager 未发布 Consignment 专属 event type；不要求自造类型。
- 无 blocked Case。

## Worked example

同一 piece 收到乱序事件：`ARRIVED@10:03`、`DEPARTED@10:02`、`LOSS_REPORTED@10:04`、`FOUND@10:05`、`DELIVERED@10:06`，并重复 ARRIVED。oracle 用 `(observedAt,typePrecedence,scannerEventId)` 全序重放，precedence 按 README `LOSS_REPORTED<FOUND<PICKED_UP<DEPARTED<ARRIVED<DELIVERED`，再检查 leg 依赖与 loss/found fence；重复 scannerEventId 不推进。任意到达顺序必须得到同一 projection/digest。

## Scoring Cases

### A-01 ScanEvent 全序重放与确定性 Projection — 6 分
来源：README「Invariants and projection rules」；Fixture：同 observedAt 的各 type、不同 scannerEventId 与乱序到达；动作：公开 scan/loss/found seam 后读 Projection。
Oracle/Mandatory：严格按发布三元组和 type precedence 重放，current leg/hub/state/lastObservedAt/sequence 精确；禁止副作用：不得用 arrival/insert order 或最后事件直接覆盖。
归因：dimension=A；primarySkill=S08；feedback=A.projection-order；mutant=M01。

### A-02 RoutePlan leg 依赖与终态 fence — 6 分
来源：README domain/invariants；Fixture：跨 leg 跳跃、错误 hub、DELIVERED 后迟到 scan；动作：公开 ScanEvent create/read。
Oracle/Mandatory：只有满足发布 dependency/leg/hub 约束的证据推进，终态不可离开；禁止副作用：非法证据不得改 Projection/Work/Event，原始允许保留与否按发布合同。
归因：dimension=A；primarySkill=S06；feedback=A.route-authority；mutant=M02。

### A-03 LOSS_REPORTED/FOUND/reassign 的目标范围与 fence — 6 分
来源：README loss/found/reassign rules；Fixture：多 shipment 哨兵、lost/found boundary、旧 revision scan；动作：公开 loss/found/reassign。
Oracle/Mandatory：lost 只影响目标 authority，found 只按合法先前 loss 恢复，旧 revision 不能越 reassign fence；禁止副作用：不得改其他 shipment/piece 或抹除 loss evidence。
归因：dimension=A；primarySkill=S06；feedback=A.exception-fence；mutant=M03。

### A-04 Consignment 创建原子冻结 1..100 pieces — 6 分
来源：Manager 规则 1、exact create/resource；Fixture：重复/边界 pieceRefs、合法/非法 legs；动作：`POST /api/v1/consignments`。
Oracle/Mandatory：同事务创建 Consignment、稳定唯一 pieces、共享 RoutePlan revision，first response/replay IDs 精确；禁止副作用：任一非法成员不得留 partial pieces/route/work/event。
归因：dimension=A；primarySkill=S17；secondarySkills=S04；feedback=A.consignment-atomicity；mutant=M04。

### A-05 Piece→Consignment 可重算聚合与共享 reassign — 6 分
来源：Manager 规则 2–4；Fixture：PLANNED/IN_TRANSIT/DELIVERED/LOST/CANCELLED 混合 pieces；动作：piece scans 与 shared reassign。
Oracle/Mandatory：aggregate 严格由所有 piece states 重算为五态之一；reassign 新 revision 原子应用全部尚未终态 pieces；禁止副作用：不得由最后事件直接设 aggregate、修改 terminal piece 或部分换路线。
归因：dimension=A；primarySkill=S17；feedback=A.aggregate-closure；mutant=M05。

### B-01 Scan mutation durable replay 与 identity scope — 5 分
来源：README idempotency + `(scannerEventId)` identity；Fixture：same key/same scannerEventId、semantic conflicts、shield/restart；动作：跨 API 重放。
Oracle/Mandatory：原 status/body/event identity 保持，`(aggregate,piece,scannerEventId)` 只一个 effect；禁止副作用：冲突不得推进 projection 或创建第二 Work/Event。
归因：dimension=B；primarySkill=S08；secondarySkills=S05；feedback=B.identity-replay；mutant=M06。

### B-02 重复 scannerEventId 并发至多一次 — 5 分
来源：README uniqueness/concurrency + Manager rule 5；Fixture：20 路相同和冲突 payload；动作：两个 API 并发 piece scan。
Oracle/Mandatory：相同语义汇聚、冲突按发布错误，projection sequence 只推进一次；禁止副作用：不得重复 evidence、Work、Event 或跨 piece 误去重。
归因：dimension=B；primarySkill=S08；secondarySkills=S04；feedback=B.scan-uniqueness；mutant=M06。

### B-03 乱序扫描所有交错收敛同一投影 — 5 分
来源：README deterministic projection；Fixture：worked-example 的多种 seeded permutations、双 worker；动作：并发 ingest/排空。
Oracle/Mandatory：所有排列 final Projection/digest/aggregate 相同并等于独立 replay；禁止副作用：不得丢晚到早时刻 evidence 或 sequence 随调度变化。
归因：dimension=B；primarySkill=S08；feedback=B.projection-commutativity；mutant=M01。

### B-04 loss/found 与 reassign 并发按 revision 串行 — 5 分
来源：README/Manager fence rules；Fixture：旧/new revision 与 loss/found 的固定提交交错；动作：并发 reassign 与 target piece events。
Oracle/Mandatory：只接受某个合法提交序列，event 归属/Projection revision 与该序列一致；禁止副作用：旧 lease/event 不得推进新 RoutePlan，其他 pieces 不受目标 loss 影响。
归因：dimension=B；primarySkill=S06；feedback=B.authority-race；mutant=M03。

### B-05 Shared reassign 与 piece terminal 竞争全或无 — 5 分
来源：Manager rule 4、expected revision/error；Fixture：多个 nonterminal pieces，其中一件并发 DELIVERED；动作：以 harness 固定提交次序交错 shared reassign/scan。
Oracle/Mandatory：按提交点冻结 nonterminal cohort，新 revision 对该 cohort 全部应用或整批失败；禁止副作用：不得 partial revision、改 terminal member 或 sequence 缺口。
归因：dimension=B；primarySkill=S17；secondarySkills=S04；feedback=B.batch-linearization；mutant=M07。

### C-01 Projection Work lease reclaim 与 stale token — 5 分
来源：README worker/recovery 与唯一公开 `worker.claimed` barrier；Fixture：短 lease、双 worker；动作：在 `worker.claimed` 持有目标 Work 后 SIGKILL/reclaim。
Oracle/Mandatory：Work 可恢复、旧 token 不能 commit、final projection 等于 event replay；禁止副作用：不得永久 LEASED、重复 sequence/event 或持事务等 barrier。
归因：dimension=C；primarySkill=S07；feedback=C.projection-recovery；mutant=M08。

### C-02 乱序 storm 中 crash/restart 仍确定性 — 5 分
来源：README recovery + deterministic projection；Fixture：大量乱序/20% duplicates、worker kills；动作：只在公开 `worker.claimed` 持有后 SIGKILL并启动 replacements。
Oracle/Mandatory：排空后每 aggregate 与独立 replay 相同，duplicates 不推进、Work terminal retained；禁止副作用：不得全量丢历史、使用 checkpoint 跳过晚到 evidence。
归因：dimension=C；primarySkill=S08；feedback=C.rebuild-recovery；mutant=M09。

### C-03 Consignment cancel/reassign 与旧 Worker fence — 5 分
来源：Manager rules 4–6/Work aggregateId；Fixture：partially projected consignment、在公开 `worker.claimed` 持有的 old lease；动作：cancel/reassign 与 worker 接管并发、kill/restart。
Oracle/Mandatory：终态/route revision 单调，old lease 不能越 fence，aggregate 由最终 members 重算；禁止副作用：不得 cancel terminal piece 或 restart 后复活工作。
归因：dimension=C；primarySkill=S07；feedback=C.aggregate-fence；mutant=M07。

### C-04 Shipment/Consignment event unknown ACK — 5 分
来源：README event/dispatcher + Manager stable events 与唯一公开 `dispatcher.response-received` barrier；Fixture：成功/rollback mutations、receiver 500 或持久化完整 request 后挂 ACK；动作：在 `dispatcher.response-received` SIGKILL/restart。
Oracle/Mandatory：committed effect 有稳定 eventId/body、aggregate sequence 递增成功交付；禁止副作用：rollback 无 event、retry 不换 identity、不要求未发布新 type。
归因：dimension=C；primarySkill=S07；feedback=C.outbox；mutant=M10。

### D-01 V1/Consignment wire、错误、sorting 与 tenant scope — 4 分
来源：README HTTP/OpenAPI + Manager exact routes/shapes/errors；Fixture：unknown fields、1/100/101 pieces、cursor/missing/cross-tenant IDs；动作：仅 HTTP。
Oracle/Mandatory：exact member shapes/codes/envelope，pieces/projections 按 pieceRef，query wrapper 仅断言已发布语义；禁止副作用：GET/拒绝零 mutation。
归因：dimension=D；primarySkill=S06；secondarySkills=S15；feedback=D.api-contract；mutant=M04。

### D-02 浏览器完成 V1 route/scan/loss/reassign 流 — 4 分
来源：README「Production UI」；Fixture：真实 DB/API/workers、桌面移动；动作：visible controls + refresh。
Oracle/Mandatory：timeline 顺序、projection、route revision、loss/found/error/offline 与 HTTP/oracle 一致；禁止副作用：不得 mock、client-side projection 或隐藏乱序 evidence。
归因：dimension=D；primarySkill=S08；secondarySkills=S15；feedback=D.browser-v1；mutant=M02。

### D-03 浏览器呈现多 piece 轨迹与 aggregate — 4 分
来源：Manager UI rule；Fixture：PLANNED/LOST/DELIVERED 混合 consignment；动作：create、piece scans、shared reassign/cancel。
Oracle/Mandatory：每 piece 独立 timeline/projection 与 aggregate 可见，PARTIALLY_DELIVERED/EXCEPTION 精确，refresh 保持；禁止副作用：不得把一件状态复制所有件。
归因：dimension=D；primarySkill=S17；secondarySkills=S15；feedback=D.browser-manager；mutant=M05。

### D-04 FINAL snapshot 单时点 projection closure — 3 分
来源：README snapshot + Manager resources/Work union；Fixture：V1/legacy/new consignments、all Work/events；动作：授权 snapshot。
Oracle/Mandatory：exact keys/shapes/sorts/same asOf/retention/token omission；harness 由 scan ledger 重算每 PieceProjection 和 Consignment；禁止副作用：不得多时点拼接、漏 terminal pieces/work。
归因：dimension=D；primarySkill=S08；secondarySkills=S11；feedback=D.snapshot；mutant=M10。

### E-01 V1 Shipment→legacy Consignment/Piece 兼容迁移 — 3 分
来源：Manager deterministic migration；Fixture：populated V1 Shipment/tracking/ScanEvent/Projection/Event/Work/replay；动作：重复升级恢复重放。
Oracle/Mandatory：每 shipment 恰一稳定 consignment/piece，`legacyShipmentId`、pieceRef、RoutePlan identity/revision 精确，V1 identity/replay 不变；禁止副作用：不得复制 scan/projection 或补业务 event。
归因：dimension=E；primarySkill=S06；secondarySkills=S02；feedback=E.compatibility；mutant=M04。

### E-02 `shipment-plan-ingest` 固定负载 — 3 分
来源：README fixed performance 同名场景；Fixture/动作：精确 50k、公开 selector/concurrency/timer HTTP。
Oracle/Mandatory：达到发布 throughput/p95/5xx 阈值且 RoutePlan/Shipment 原子不变量成立；禁止副作用：不得缩 workload、计 warm-up 或绕 HTTP。
归因：dimension=E；primarySkill=S17；secondarySkills=S14；feedback=E.ingest-performance；mutant=M04。

### E-03 `out-of-order-scan-storm` 确定性负载 — 2 分
来源：README fixed performance 同名场景；Fixture：200k scans、20% duplicates、公开并发；动作：ingest/排空。
Oracle/Mandatory：达到阈值且每 projection 等于独立 replay、duplicate 零推进；禁止副作用：不得采样 oracle、丢早时刻 event 或只测吞吐。
归因：dimension=E；primarySkill=S08；secondarySkills=S14；feedback=E.projection-performance；mutant=M01。

### E-04 `loss-reroute-recovery` 恢复负载 — 2 分
来源：README fixed performance 同名场景；Fixture：10k loss/reroute 与公开 kills/replacements；动作：在 `worker.claimed` kill two workers 后启动 four replacements。
Oracle/Mandatory：`<=60s` 闭合、fence/revision/aggregate 不变量成立；禁止副作用：不得 random sleep、缩 backlog 或绕生产 worker。
归因：dimension=E；primarySkill=S07；secondarySkills=S14；feedback=E.recovery-performance；mutant=M09。

## Mutants

| Mutant | 领域缺陷 | 必杀 Case |
|---|---|---|
| M01 | projection 按 arrival/insert order 或 precedence 错 | A-01、B-03、E-03 |
| M02 | 不校 leg/hub dependency 或终态仍推进 | A-02、D-02 |
| M03 | loss/found/reassign 不按目标/revision fence | A-03、B-04 |
| M04 | consignment/pieces 逐条 commit 或 migration 复制 | A-04、D-01、E-01 |
| M05 | aggregate 由最后事件直接覆盖 | A-05、D-03 |
| M06 | scannerEvent 去重 scope/幂等保存错误 | B-01、B-02 |
| M07 | shared reassign/cancel 不 fence terminal/old lease | B-05、C-03 |
| M08 | expired projection worker 仍可 commit | C-01 |
| M09 | recovery checkpoint 跳过晚到 evidence | C-02、E-04 |
| M10 | outbox 非原子或 snapshot 不可重算 | C-04、D-04 |

## Coverage mapping

**README / Manager → Case**

| README/Manager requirement | Cases |
|---|---|
| Scan ordering/dependency/loss/reassign | A-01..A-03、B-01..B-04 |
| Projection Work/recovery/events | C-01..C-04 |
| Consignment/pieces/aggregate/shared reassign | A-04..A-05、B-05、C-03、D-03 |
| HTTP/UI/snapshot | D-01..D-04 |
| Migration/performance | E-01..E-04 |

**旧 H → Case**

| 旧 H family | v2 Cases |
|---|---|
| H-01 | 不计分 preflight |
| H-02..H-04 | A-01..A-03、D-01..D-02 |
| H-05..H-08 | B-01..B-04、C-01..C-02、C-04 |
| H-09 | E-01 |
| H-10..H-11 | A-04..A-05、B-05、C-03、D-03..D-04 |
| H-12 | E-02..E-04 |
| H-13 | D/项目证据，不另计分 |

## Evidence/hard caps

保存 fixture、HTTP、scan/route ledger、仅 `worker.claimed`/`dispatcher.response-received` barrier 与 receiver transcript、独立 replay/aggregate diff、snapshot digest。重复 scan 推进、投影非确定、partial reassign/consignment 或终态回退总分上限 35；幂等第二效果上限 30；stale worker 可提交/Work 丢失上限 40；迁移改 V1 identity/replay 上限 35；性能后不变量失败则 E Case 为 0 并应用 correctness cap。
