# GeoPulse Hidden Test v2（Learning）设计

本文件依 Learning v2 profile 把 GeoPulse 评测收敛为 22 个领域 Case。install/build/boot、空库
migration、health、Chromium shell 和公开命令真实性由共享 preflight 验证，不计分。

## 1. 权威、公开 seam 与 SPEC-GAP

真值只来自 workspace/README.md、orchestration/manager-prompt.zh-CN.md 和 CONTEXT.md。Evaluator
只使用公开 HTTP、production Chromium、verification snapshot、事件 receiver、独立 API/Worker/
Dispatcher、进程信号、V1→FINAL checkpoint 和公开 workload；禁止读取私有 PostGIS/SQL、
缓存、表、源码 geometry helper。

- GP-GAP-01：Manager 对跨 tenant、空成员、未知 RegionVersion 和 effective-time overlap 只发布
  “稳定 400/409 语义错误”，没有发布 code 或每个条件对应状态。A-05/B-04 断言请求失败、类别稳定且
  snapshot 零变化；exact status/code 子断言 blockedBy: GP-GAP-01。
- GP-GAP-02：Manager 明确 Membership 公开 bundleRevisionId，但没有发布 LocationEvent 加字段后的
  exact wire shape，尽管要求接受时冻结。测试以 Membership/Transition/query/重放行为证明 pinning；
  D-03 的 LocationEvent 新字段 exact 断言 blockedBy: GP-GAP-02。
- GP-GAP-03：README 发布了 Work 的 `LEASED`、lease 字段和 fenced final commit，但未发布
  `TEST_BARRIER_URL` 或 claimed/effect-complete/before-commit checkpoint。可执行的恢复测试只能
  启动专用 Worker，轮询公开 snapshot 至目标 Work=`LEASED` 后 `SIGKILL`，再等 lease 到期。
  精确 effect-complete/before-commit 以及释放过期旧 owner 的子断言 blockedBy: GP-GAP-03。

每 Case 独立数据库/端口/receiver；E-01 才跨 binary。所有 concurrency Case 使用三个保存的交错 seed。

## 2. 独立 oracle、fixtures 与 worked example

Evaluator 实现有限平面 point-in-polygon、edge distance、effective interval、hysteresis、dwell 和
按 (observedAt,deviceSequence,eventId) 的 replay reference model；计算不调用 Candidate 空间查询。
Fixture：F-GEOMETRY（edge/vertex/invalid/self-intersection）、F-TIMELINE（inside/boundary/outside/dwell）、
F-LATE（窗口内外乱序）、F-IDENTITY、F-BUNDLE（1..10000 frozen members/revisions）、F-RECOVERY、
F-V1-FINAL 和三条公开性能 seed。

**Worked example GP-W1**：同 Device 对同 Region 的 canonical 顺序为 event 4(outside)、5(boundary)、
6(inside)，随后依到达顺序收到 3(inside)、2(boundary)、1(outside)，且都在 10 分钟窗口内。每次 replay
都从稳定 prefix 重算，最终 Membership/ENTER/DWELL/EXIT 必须与按 1..6 一次顺序处理完全相同；不能仅
反向 patch 最新 Membership。早于 watermark−10 分钟的 event 0 只产生 LATE_IGNORED，不能重写 Transition。

## 3. 评分

| Family | Cases | 分值 |
| --- | ---: | ---: |
| A 领域合同与主流程 | 5 | 30 |
| B 投影不变量、幂等与并发 | 5 | 25 |
| C Work、恢复与 Event | 4 | 20 |
| D UI/OpenAPI/snapshot 闭环 | 4 | 15 |
| E 兼容与合同负载 | 4 | 10 |
| **总计** | **22** | **100** |

任一 mandatory assertion 失败则 Case 为 0；blocked 子断言不执行且不重分配权重。

## 4. A — 领域合同与主流程

### A-01 Polygon、RegionVersion 与 observedAt 有效版本 — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：README geometry bounds、immutable non-overlap revision、invariant 6；F-GEOMETRY。
- **公开动作 / oracle**：创建闭合 polygon、edge/vertex点、相邻 effective intervals及非法 ring；提交 receivedAt 与 observedAt 跨版本的事件。
- **Mandatory / 禁止副作用**：坐标/精度/ring约束、BOUNDARY精确；RegionVersion不可变且时间不重叠；投影选择 observedAt active version，不使用 arrival/current version，非法版本零 Work/Event。
- **primarySkill**：S08 deterministic-projection-and-reconciliation；**feedback**：geometry.version-selection；**mutant**：M-GP-01。

### A-02 LocationEvent/Batch 原子接受与双 identity — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：README invariants 1–2、batch 1..10000/errors；F-IDENTITY。
- **公开动作 / oracle**：单条与 batch 提交 same/different eventId、tenant+device+sequence 四象限，混合一个 invalid/conflict member。
- **Mandatory / 禁止副作用**：每 identity 永久映射同 canonical event；合法 replay返回原结果，冲突稳定；坏 member使完整 batch 零 LocationEvent/Work/Membership/Transition/Event。
- **primarySkill**：S04 database-owned-atomic-idempotency；**feedback**：location.identity-batch；**mutant**：M-GP-02。

### A-03 Edge hysteresis、ENTER/EXIT 与一次 DWELL — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：README invariants 4–5、8–9；F-TIMELINE 含 tolerance 内外与 dwell 阈值前后1ms。
- **公开动作 / oracle**：按 event 顺序从 outside 穿 edge、抖动、inside、达到 dwell、exit、再次 enter；排空 evaluation。
- **Mandatory / 禁止副作用**：单 Membership revision单调；BOUNDARY不发 transition；只有越过对应 tolerance才 enter/exit；continuous interval只一 DWELL，exit重置；Transition sequence连续。
- **primarySkill**：S08 deterministic-projection-and-reconciliation；**feedback**：membership.hysteresis-dwell；**mutant**：M-GP-03。

### A-04 十分钟乱序 replay 与 LATE_IGNORED frontier — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：README invariant 7、LATE_REPLAY/event type；F-LATE 与 GP-W1。
- **公开动作 / oracle**：以多种到达排列提交相同 canonical timeline，分别在 window内、边界和更旧处插入 event。
- **Mandatory / 禁止副作用**：window内最终状态/Transition identities与reference replay收敛；过旧只存 LATE_IGNORED且不改 published Transition/Membership history；watermark单调。
- **primarySkill**：S08 deterministic-projection-and-reconciliation；**feedback**：late.replay-frontier；**mutant**：M-GP-04。

### A-05 RegionBundle composition、publish/rollback 与 revision pinning — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：Manager RegionBundle resources/routes/CAS/pinning/query；F-BUNDLE。
- **公开动作 / oracle**：创建 bundle，publish sorted/dedup members，accept events/query，再 publish和rollback；重放旧 event并GET revisions。
- **Mandatory / 禁止副作用**：revision immutable、rollback复制 target成员并新建 revision；接受时冻结唯一 bundle revision，Membership公开该ID，query顶层单一ID且输入序稳定；非法成员全零副作用。exact error code blockedBy: GP-GAP-01。
- **primarySkill**：S06 ordered-authority-and-frozen-membership；**feedback**：bundle.revision-pinning；**mutant**：M-GP-05。

## 5. B — 投影不变量、幂等与并发

### B-01 几何、hysteresis 与 dwell 独立 reference model — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：README polygon/transition rules；随机保存 seed 的 rectangles/concave polygons/edge points。
- **公开动作 / oracle**：批量生成短 timeline，经公开 ingest/query，再与 evaluator 几何和状态机逐项比较。
- **Mandatory / 禁止副作用**：match set、Membership state/revision/enteredAt、Transition type/time/source/sequence全等；不以 Candidate query结果生成预期，不允许浮点 epsilon偷换 published tolerance。
- **primarySkill**：S08 deterministic-projection-and-reconciliation；**feedback**：projection.reference-model；**mutant**：M-GP-01。

### B-02 Idempotency-Key、eventId 与 deviceSequence 优先级 — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：README tenant/method/path key scope及两种event identity；response shield、两个API。
- **公开动作 / oracle**：same key/body、same key/different body、新key同eventId、新key同sequence、跨tenant同ID，含unknown response/restart。
- **Mandatory / 禁止副作用**：request replay恢复原status/body；event identities分别执行已发布conflict且不互相误合并；最多一个canonical Event与一组Work，无cross-tenant existence leak。
- **primarySkill**：S04 database-owned-atomic-idempotency；**secondarySkills**：S05；**feedback**：location.identity-precedence；**mutant**：M-GP-06。

### B-03 同 Device 热点 sequence 与 Transition 唯一竞争 — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：README invariants 1、4、5；两个API/四workers，64路相同时间不同坐标。
- **公开动作 / oracle**：固定交错争抢next sequence、duplicate eventId和相同 source transition，排空后完整replay。
- **Mandatory / 禁止副作用**：只有一个合法canonical event，Membership唯一/revision单调，Transition source+type最多一次且sequence无洞；loser无Work/Event/partial projection。
- **primarySkill**：S08 deterministic-projection-and-reconciliation；**feedback**：device.hotspot-convergence；**mutant**：M-GP-07。

### B-04 Bundle publish/rollback CAS 与跨 API cache invalidation — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：Manager expectedRevision/CAS/cache invalidation；两个API共享数据库。
- **公开动作 / oracle**：相同 expectedRevision 并发不同 publish/rollback，获胜response可见后立即轮询两个API并查询points。
- **Mandatory / 禁止副作用**：恰一新revision/current pointer/Event/Work；loser无partial row且稳定409类别；所有API在可观察commit后使用winner revision，无mixed/旧cache。具体code分支 blockedBy: GP-GAP-01。
- **primarySkill**：S06 ordered-authority-and-frozen-membership；**feedback**：bundle.cas-cache；**mutant**：M-GP-08。

### B-05 已冻结 evaluation 与新 Bundle publication 的竞争 — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：Manager accepted event pinning、BUNDLE_REEVALUATION、old worker rule；F-BUNDLE/F-RECOVERY。
- **公开动作 / oracle**：专用worker处理旧event，轮询snapshot至目标Work=`LEASED`后`SIGKILL`；publish新revision，lease到期后启动replacement、提交新event，再触发late replay。
- **Mandatory / 禁止副作用**：旧/新event分别沿用冻结revision，Transition/Membership不混member sets；reevaluation只按其captured authority收敛，sequence连续。释放已过期旧owner后强制提交的子断言 blockedBy: GP-GAP-03。
- **primarySkill**：S06 ordered-authority-and-frozen-membership；**secondarySkills**：S08；**feedback**：bundle.frozen-work-race；**mutant**：M-GP-05。

## 6. C — Work、恢复与 Event

### C-01 LOCATION_EVALUATION 在公开 LEASED 后崩溃 — 5 分
- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture**：README Work exact shape、bounded lease/fenced final commit；F-RECOVERY。
- **公开动作 / oracle**：单独启动worker，轮询snapshot至目标 `LOCATION_EVALUATION` Work=`LEASED`后`SIGKILL`，lease到期后replacement排空。
- **Mandatory / 禁止副作用**：replacement按同frozen version完成；Membership/Transition/Work/Event各一次且与无故障reference timeline一致。effect-complete/before-commit和旧owner释放子断言 blockedBy: GP-GAP-03。
- **primarySkill**：S07 durable-work-fenced-recovery；**secondarySkills**：S08；**feedback**：evaluation.recovery；**mutant**：M-GP-09。

### C-02 LATE_REPLAY 在公开 LEASED 后恢复与确定性投影重建 — 5 分
- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture**：README reorder replay/watermark/lease；多次会改后续membership的F-LATE。
- **公开动作 / oracle**：单独启动worker，轮询snapshot至目标 `LATE_REPLAY` Work=`LEASED`后`SIGKILL`，replacement从durable facts重跑。
- **Mandatory / 禁止副作用**：最终Membership/Transitions与完整顺序oracle相同，旧published identity不重复、sequence无洞、watermark正确。精确replay effect-complete/before-commit子断言 blockedBy: GP-GAP-03。
- **primarySkill**：S07 durable-work-fenced-recovery；**secondarySkills**：S08；**feedback**：late.rebuild-recovery；**mutant**：M-GP-04。

### C-03 BUNDLE_REEVALUATION cancel/fence 与 revision 一致恢复 — 5 分
- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture**：Manager新Work、frozen revision与旧lease规则；100成员bundle。
- **公开动作 / oracle**：轮询 FINAL snapshot 至目标 `BUNDLE_REEVALUATION` Work=`LEASED`后`SIGKILL`，期间publish下一revision，lease后replacement排空旧Work并处理新Work。
- **Mandatory / 禁止副作用**：每Work只用captured revision，无mixed Membership，一项不会因新revision重复Transition，所有Work有界终态且无第二提交。释放过期旧owner强制提交的子断言 blockedBy: GP-GAP-03。
- **primarySkill**：S07 durable-work-fenced-recovery；**secondarySkills**：S06；**feedback**：bundle.reevaluation-recovery；**mutant**：M-GP-09。

### C-04 Location/Transition/Bundle Event unknown ACK — 5 分
- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture**：README exact event types/privacy/order与Manager两个event；由Harness控制响应的receiver。
- **公开动作 / oracle**：500/断线，receiver收完并保存body后暂不响应，Evaluator `SIGKILL` 已知dispatcher进程；重启并比较每次eventId/body/aggregate sequence。
- **Mandatory / 禁止副作用**：business+Work+Event同事务，rollback无Event；retry identity/body稳定、每aggregate顺序连续，一个失败aggregate不阻塞其他；body不含完整coordinates/secret。
- **primarySkill**：S07 durable-work-fenced-recovery；**secondarySkills**：S06；**feedback**：event.delivery-privacy；**mutant**：M-GP-10。

## 7. D — UI、OpenAPI、snapshot 闭环

### D-01 浏览器完成 Region、Device、timeline 与 point query — 4 分
- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture**：README UI；F-GEOMETRY/F-TIMELINE/F-LATE。
- **公开动作 / oracle**：production Chromium经可见控件创建/version Region、register Device、ingest event、看Membership/Transition/late/Work并batch query。
- **Mandatory / 禁止副作用**：timestamps/version/late/error与HTTP一致，refresh保持；键盘/移动可用，页面不直连DB、不隐藏boundary/dwell状态或泄漏其他tenant。
- **primarySkill**：S08 deterministic-projection-and-reconciliation；**secondarySkills**：S15；**feedback**：ui.location-timeline；**mutant**：M-GP-03。

### D-02 浏览器完成 Bundle composition、publish、rollback — 4 分
- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture**：Manager UI revision-consistent query；F-BUNDLE。
- **公开动作 / oracle**：页面选择RegionVersions、publish、立即query，再rollback并查看revision history与old event。
- **Mandatory / 禁止副作用**：composition排序/去重、current revision、CAS error、query顶层revision和matches exact；旧event仍指旧authority，页面不伪造cache refresh。
- **primarySkill**：S06 ordered-authority-and-frozen-membership；**secondarySkills**：S15；**feedback**：ui.bundle-revisions；**mutant**：M-GP-08。

### D-03 OpenAPI 与 FINAL snapshot 的 bundle 联合合同 — 4 分
- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture**：README HTTP/seed/snapshot、Manager routes/resources/Work/Event；全状态fixture。
- **公开动作 / oracle**：冻结contract map校验OpenAPI，读取同一point-in-time snapshot并独立核对keys/shapes/sorts/token/coordinate redaction。
- **Mandatory / 禁止副作用**：V1资源exact，RegionBundle/Revision、Membership bundleRevisionId、Work enum和Events一致；LocationEvent新增字段exact断言blockedBy: GP-GAP-02。
- **primarySkill**：S06 ordered-authority-and-frozen-membership；**secondarySkills**：S11；**feedback**：contract.bundle-snapshot；**mutant**：M-GP-05。

### D-04 Event→Bundle→Membership→Transition→Query 跨层闭环 — 3 分
- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture**：README invariants与Manager pinning/query；旧/新bundle各一event。
- **公开动作 / oracle**：保存accept response，追踪Work、Membership、Transition、Event、snapshot和相同at point query，独立重算member matches。
- **Mandatory / 禁止副作用**：全链tenant/device/region/version/source/sequence一致，单响应不mixed revision；LATE_IGNORED链无历史改写，Event不泄漏raw location。
- **primarySkill**：S08 deterministic-projection-and-reconciliation；**feedback**：cross-layer.revision-lineage；**mutant**：M-GP-07。

## 8. E — 兼容与合同负载

### E-01 V1→Bundle FINAL 的无损迁移 — 2.5 分
- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture**：Manager migration规则；V1 binary创建乱序events、membership/transitions、pending lease、saved replay、unacked event/cursor。
- **公开动作 / oracle**：同库FINAL migration，旧client replay/query并排空old Work，再创建第一个bundle。
- **Mandatory / 禁止副作用**：V1 identity/state/watermark/sequence/lease/replay/cursor/event不变；新bundle资源初始空，旧Work不被强制写入混合revision。
- **primarySkill**：S06 ordered-authority-and-frozen-membership；**secondarySkills**：S02；**feedback**：migration.bundle-compat；**mutant**：M-GP-05。

### E-02 五十万 ordered ingest 公开 workload — 2.5 分
- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture**：README ordered-location-ingest exact 500k/100k devices/64 clients/60s。
- **公开动作 / oracle**：完整scale运行并按device重算identity/sequence及随机timeline投影。
- **Mandatory / 禁止副作用**：≥500 events/s、p95≤250ms、5xx=0；sequence/eventId唯一，Work排空，Membership revision/Event order/tenant isolation流后成立。
- **primarySkill**：S08 deterministic-projection-and-reconciliation；**secondarySkills**：S14；**feedback**：perf.ordered-ingest；**mutant**：M-GP-02。

### E-03 十万 boundary jitter 收敛 workload — 2.5 分
- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture**：README boundary-jitter-convergence exact dataset/window。
- **公开动作 / oracle**：2k devices围绕100edges、64clients、60s，以evaluator tolerance oracle检查每条transition。
- **Mandatory / 禁止副作用**：≥300 events/s、p95≤350ms，无spurious ENTER/EXIT pair；revision/sequence/hysteresis和Work/Event流后闭合。
- **primarySkill**：S08 deterministic-projection-and-reconciliation；**secondarySkills**：S14；**feedback**：perf.boundary-jitter；**mutant**：M-GP-03。

### E-04 一百万 point 的 revision-consistent query — 2.5 分
- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture**：README bulk-spatial-query exact 10k regions/1m points/batch1000/60s。
- **公开动作 / oracle**：按输入序提交batch，在publication边界附近运行独立几何抽查并统计。
- **Mandatory / 禁止副作用**：≥20000 points/s、p95 batch≤700ms、稳定input order、一个response一个bundle revision、5xx=0；不能以空matches伪造吞吐。
- **primarySkill**：S06 ordered-authority-and-frozen-membership；**secondarySkills**：S14；**feedback**：perf.spatial-query；**mutant**：M-GP-08。

## 9. Mutant calibration（10 个）

| Mutant | 故障 | 主击杀 Case |
| --- | --- | --- |
| M-GP-01 | 用receivedAt/current RegionVersion或edge算INSIDE | A-01、B-01 |
| M-GP-02 | batch逐条commit或identity仅eventId | A-02、E-02 |
| M-GP-03 | BOUNDARY触发transition/无hysteresis | A-03、D-01、E-03 |
| M-GP-04 | late event只patch当前Membership | A-04、C-02 |
| M-GP-05 | event/Work读取最新bundle而非冻结revision | A-05、B-05、D-03、E-01 |
| M-GP-06 | request replay与event identity优先级错误 | B-02 |
| M-GP-07 | hotspot产生重复Transition或revision回退 | B-03、D-04 |
| M-GP-08 | bundle CAS非原子或API保留旧cache | B-04、D-02、E-04 |
| M-GP-09 | Work完成无lease fence | C-01、C-03 |
| M-GP-10 | Event跨transaction或含raw coordinates | C-04 |

Gold和mutant同seed三次稳定，且完整负载不变量检查能杀死吞吐假绿后才冻结。

## 10. README→Case 与旧 H→Case

| Requirement | Case |
| --- | --- |
| geometry/effective RegionVersion | A-01、B-01 |
| LocationEvent identity/atomic batch | A-02、B-02、B-03 |
| Membership/Transition/hysteresis/dwell | A-03、B-01、D-04 |
| late replay/frontier | A-04、C-02 |
| RegionBundle/CAS/pinning/query | A-05、B-04、B-05 |
| Work/Event recovery | C-01～C-04 |
| UI/OpenAPI/snapshot | D-01～D-04 |
| V1 compatibility | E-01 |
| exact performance | E-02～E-04 |

| 旧 H | 新 Case |
| --- | --- |
| H-01 | 不计分preflight；migration行为归E-01 |
| H-02 | A-01、D-01、D-03 |
| H-03 | A-03、A-04、B-01 |
| H-04 | A-02 |
| H-05 | B-02 |
| H-06 | B-03 |
| H-07 | C-01、C-02 |
| H-08 | C-04 |
| H-09 | E-01 |
| H-10 | A-05、D-02、D-04 |
| H-11 | B-04、B-05、C-03 |
| H-12 | E-02～E-04 |
| H-13 | 不单列计分，证据只诊断对应Case |

统一 Hard Caps 外：跨tenant位置泄漏、错误revision重写已发布Transition、或migration破坏watermark/
replay时 correctness总分上限30；读取hidden assets或内部GIS为invalid。
