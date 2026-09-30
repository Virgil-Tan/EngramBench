# MergeBoard Hidden Test v2（Learning）设计

本文件按 Learning v2 profile 将 MergeBoard 设计为 22 个领域 Case。install/build/boot、空库
migration、health、Chromium shell 与项目命令真实性由共享 preflight 负责，不计分。

## 1. 权威、公开 seam 与 SPEC-GAP

真值依次为 workspace/README.md、T16 固定 Manager 消息、CONTEXT.md。测试只经公开 HTTP、
production Chromium、verification snapshot、事件 receiver、独立 API/SNAPSHOT_COMPACTION Worker/
Dispatcher、TEST_BARRIER_URL、V1→FINAL checkpoint和README三条performance scenarios；禁止读私有
表、operation log、Candidate merge/digest helper或snapshot资产内部路径。

- MB-GAP-01：MergeRequest exact shape要求terminalAt，但Manager未说明CONFLICTED、APPROVED、
  MERGED、STALE各状态何时非空。A-05/D-03验证字段存在与timestamp/null类型，不推定状态对应值；
  exact terminalAt state rule blockedBy: MB-GAP-01。
- MB-GAP-02：迁移要求建立branch main但未规定其branchId、createdAt、sourceBranchId/sourceRevision
  的确定性生成规则。E-01验证每Document恰有一个main及历史映射/legacy兼容，不断言未发布的具体ID/time；
  exact migrated Branch identity blockedBy: MB-GAP-02。

除E-01外每Case独立数据库/端口/asset root；并发Case固定三个interleaving seed，恢复只用公开barrier。

## 2. 独立 oracle、fixtures 与 worked example

Evaluator实现Block operation、precondition/rebase、same-anchor order、RFC8785 revision digest、DocumentDiff、
branch-local revision和Merge preview reference model；Candidate响应不生成预期。Fixture：F-DOC
（empty/1000 blocks/Unicode）、F-OPS（四operation与conflicts）、F-OFFLINE（client sequence/replay）、
F-SNAPSHOT、F-BRANCH（source/target/divergence/review policies）、F-RECOVERY、F-V1-FINAL和perf-v1。

**Worked example MB-W1**：main rev0 blocks[A:a,B:b]，feature从该revision建立local rev0；feature rev1
INSERT X after A，rev2 REPLACE B b→b2。若main仍rev0，MergeOperations顺序是(1,0)后(2,0)，preview
blocks[A,X,B2]且resultDigest按目标next revision重算。若main已把B改成b3，则第二operation产生
TARGET_CHANGED Conflict并整MR为CONFLICTED；X也不得部分写入main。两位reviewer并发达到threshold时只一次
APPROVED；merge前main再前进则STALE且无target revision。

## 3. 评分

| Family | Cases | 分值 |
| --- | ---: | ---: |
| A Document/Change/Branch/Merge合同 | 5 | 30 |
| B revision、identity与并发 | 5 | 25 |
| C Snapshot/Event恢复 | 4 | 20 |
| D UI/OpenAPI/snapshot跨层 | 4 | 15 |
| E 兼容与完整负载 | 4 | 10 |
| **总计** | **22** | **100** |

每Case的mandatory assertions全部通过才得分；blocked子断言不运行、不重分。

## 4. A — Document/Change/Branch/Merge 合同

### A-01 Document revision 0、四类 Operation 与 canonical digest — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：README Domain、Deterministic policy 1/3/5、exact shapes；F-DOC/F-OPS。
- **公开动作 / oracle**：创建empty/ordered blocks Document，分别apply INSERT_AFTER/REPLACE/MOVE_AFTER/DELETE及组合operation。
- **Mandatory / 禁止副作用**：revision0 immutable、title/block bounds与unique IDs精确；operation按array order，revision每APPLIED恰+1，blocks/digest=SHA256 RFC8785 exact；invalid request零revision/event。
- **primarySkill**：S06 ordered-authority-and-frozen-membership；**feedback**：document.operations-digest；**mutant**：M-MB-01。

### A-02 Deterministic rebase、Conflict 与 resolve — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：README policy 3–4、conflict/resolve routes/errors；F-OPS。
- **公开动作 / oracle**：从stale base提交non-overlap和五类precondition failure，GET Change/conflicts，再用fresh/stale expectedHead resolve。
- **Mandatory / 禁止副作用**：non-overlap逐op rebase；failure记录all deterministic conflicts按operationIndex且Change全不apply/no document.changed；resolve是normal next revision，stale head稳定error。
- **primarySkill**：S06 ordered-authority-and-frozen-membership；**feedback**：change.rebase-conflict；**mutant**：M-MB-02。

### A-03 Client Sequence offline replay 与永久 semantic identity — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：README policy2/invariant2、CLIENT_SEQUENCE errors；F-OFFLINE。
- **公开动作 / oracle**：client sequence1/3/2，prior identical/different content，跨restart与另client/document相同sequence。
- **Mandatory / 禁止副作用**：scope=document+client，必须next sequence；identical prior永久sameChange/response，不同semantic conflict，gap不预占sequence；每accepted最多一revision/event。
- **primarySkill**：S04 database-owned-atomic-idempotency；**secondarySkills**：S05；**feedback**：change.client-sequence；**mutant**：M-MB-03。

### A-04 Revision read、DocumentDiff 与 Snapshot provenance — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：README diff policy、revision route、snapshot invariant；多INSERT/REPLACE/MOVE/DELETE timeline。
- **公开动作 / oracle**：读取任意revision/diff双向，排空snapshot并下载/读取公开provenance。
- **Mandatory / 禁止副作用**：revision blocks/changeId/digest精确；diff取blockId union bytewise且REPLACE before MOVE、nullable indices/text exact；Snapshot replay exact operation prefix并匹配digest，不删除history。
- **primarySkill**：S11 point-in-time-snapshot-audit；**feedback**：revision.diff-snapshot；**mutant**：M-MB-04。

### A-05 Branch、Merge preview、review gate 与 merge/stale — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：T16 exact shapes/routes/errors；F-BRANCH与MB-W1。
- **公开动作 / oracle**：create branch/source local changes，create conflict/nonconflict MR，approve eligible reviewers并merge；另在review后advance source/target。
- **Mandatory / 禁止副作用**：branch local revisions contiguous，source revision immutable；MR captures heads/policy/ordered operations/conflicts/digest；threshold一次APPROVED，merge恰一target revision/source不变/Snapshot Task与两events有序；head改变→STALE且零revision。terminalAt state规则 blockedBy: MB-GAP-01。
- **primarySkill**：S06 ordered-authority-and-frozen-membership；**feedback**：merge.review-gate；**mutant**：M-MB-05。

## 5. B — revision、identity 与并发

### B-01 Operation/rebase/diff 独立 reference model — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：README deterministic policy；随机保存seed的小Document操作图。
- **公开动作 / oracle**：通过HTTP生成head/stale-base Changes及revision pairs，与Evaluator逐operation model比较。
- **Mandatory / 禁止副作用**：APPLIED blocks/revision/digest、CONFLICT code/path/base/head与diff items全等；不共享Candidate canonicalizer，单setup失败不级联伪造多Case。
- **primarySkill**：S06 ordered-authority-and-frozen-membership；**feedback**：merge.reference-model；**mutant**：M-MB-01。

### B-02 Idempotency-Key 与 Client Sequence 双重 replay precedence — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：README durable idempotency/client sequence；两个API/response shield四象限。
- **公开动作 / oracle**：same request key same/different body、新key same client sequence same/different Change，unknown response/restart。
- **Mandatory / 禁止副作用**：request replay先恢复saved status/body，client identity再决定semantic replay/conflict；两个scope不误合并，最多一Change/revision/Event且conflict零partial。
- **primarySkill**：S04 database-owned-atomic-idempotency；**secondarySkills**：S05；**feedback**：change.replay-precedence；**mutant**：M-MB-06。

### B-03 Concurrent same-anchor INSERT 与 gapless revision — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：README policy5/invariant1/3；两个API多个clients共享anchor。
- **公开动作 / oracle**：64路INSERT_AFTER、混合MOVE/DELETE导致precondition变化，以三个interleavingseed提交。
- **Mandatory / 禁止副作用**：applied revision contiguous，每shared-anchor insertion按committed revision→opIndex→blockId稳定；conflicted Change无block/event，replay不duplicate/lose/reorder。
- **primarySkill**：S06 ordered-authority-and-frozen-membership；**feedback**：revision.concurrent-order；**mutant**：M-MB-07。

### B-04 Concurrent reviewer approvals 与 captured policy — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：T16 reviewer uniqueness/1..5 threshold/errors；F-BRANCH含2..10 reviewer IDs。
- **公开动作 / oracle**：两个API并发duplicate/eligible/ineligible approvals，最后两票同时跨threshold。
- **Mandatory / 禁止副作用**：policy创建时冻结，approval按MR+reviewer unique且response reviewerId排序/resultDigest绑定；只有一次IN_REVIEW→APPROVED与approved event，loser无duplicate。
- **primarySkill**：S06 ordered-authority-and-frozen-membership；**feedback**：review.threshold-race；**mutant**：M-MB-08。

### B-05 Merge CAS、source/target head 与 target revision原子性 — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：T16 expected heads/merge prerequisites/STALE；两个API并发merge及target Change。
- **公开动作 / oracle**：APPROVED MR同时20路merge，在target/source head变化交错下读取branches/revisions/MR/events。
- **Mandatory / 禁止副作用**：only captured heads可merge，成功恰一next target revision和snapshot task，preview blocks/digest复用且source不变；任一head stale只一次STALE、零partial target revision。
- **primarySkill**：S06 ordered-authority-and-frozen-membership；**feedback**：merge.head-cas；**mutant**：M-MB-05。

## 6. C — Snapshot/Event 恢复

### C-01 SNAPSHOT_COMPACTION claim 后 lease recovery — 5 分
- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture**：README Work/barrier/fence；F-SNAPSHOT/F-RECOVERY。
- **公开动作 / oracle**：worker.claimed SIGKILL，lease后replacement，再释放stale worker尝试commit。
- **Mandatory / 禁止副作用**：same captured operation prefix/work identity，stale token拒绝；oneSnapshot/digest/event，Work terminal保留，revision reads始终一致。
- **primarySkill**：S07 durable-work-fenced-recovery；**feedback**：snapshot.claim-recovery；**mutant**：M-MB-09。

### C-02 Snapshot asset effect-complete/before-commit 崩溃 — 5 分
- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture**：README snapshot canonical asset/worker barriers；多revision prefix。
- **公开动作 / oracle**：asset写完和DB commit前分别SIGKILL，replacement重放，独立校验asset RFC8785 bytes/digest。
- **Mandatory / 禁止副作用**：公开Snapshot不指missing/partial asset；最终oneidentity、exact prefix，无operation history deletion；stale/duplicate completion不能覆盖正确digest。
- **primarySkill**：S07 durable-work-fenced-recovery；**secondarySkills**：S11；**feedback**：snapshot.asset-recovery；**mutant**：M-MB-09。

### C-03 Document/Merge Event unknown ACK 与顺序 — 5 分
- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture**：README V1 event types/dispatcher barrier、T16 merge event order；receiver。
- **公开动作 / oracle**：receiver500/断线，在dispatcher.response-received暂停并SIGKILL，restart比较deliveries。
- **Mandatory / 禁止副作用**：business+Event同transaction、conflict/rollback按字面有无event；retry eventId/body稳定、aggregate sequence连续，successful merge document.changed先于merge-request.merged。
- **primarySkill**：S07 durable-work-fenced-recovery；**feedback**：event.merge-order-retry；**mutant**：M-MB-10。

### C-04 Merge-created branch Snapshot Task 的崩溃恢复 — 5 分
- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture**：T16 merge schedules one Snapshot Task，Work enum不新增；merged branch revision fixture。
- **公开动作 / oracle**：merge后在Snapshot worker三个barrier分别SIGKILL，期间继续读target/source revisions。
- **Mandatory / 禁止副作用**：只一SNAPSHOT_COMPACTION covering mergedTargetRevision，replacement digest等stored preview/replay；source无task副作用，stale worker不重复Snapshot/Event。
- **primarySkill**：S07 durable-work-fenced-recovery；**feedback**：merge.snapshot-recovery；**mutant**：M-MB-09。

## 7. D — UI、OpenAPI、snapshot 跨层

### D-01 浏览器完成 V1 edit/replay/conflict/diff/history — 4 分
- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture**：README Real UI；F-DOC/F-OPS/F-OFFLINE。
- **公开动作 / oracle**：production Chromium仅经visible controls创建Document、四类edit、offline replay、resolve conflict、看revisions/diff/Snapshot progress并refresh。
- **Mandatory / 禁止副作用**：blocks/digest/conflicts/diff/history与HTTP一致，loading/stale/offline/permission反馈可见，keyboard/mobile/WCAG满足；UI不直调内部store。
- **primarySkill**：S06 ordered-authority-and-frozen-membership；**secondarySkills**：S15；**feedback**：ui.v1-editor；**mutant**：M-MB-02。

### D-02 浏览器完成 Branch/MR/review/merge/stale — 4 分
- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture**：T16 update real UI及Manager flows；F-BRANCH。
- **公开动作 / oracle**：创建branch、编辑、create MR、查看preview/conflicts、approve/merge；另让target变化显示STALE。
- **Mandatory / 禁止副作用**：branch-local head、captured heads/policy/approvals/operations/conflicts/digest与API exact；threshold/merge一次，legacy main UI仍保持V1 response流程。
- **primarySkill**：S06 ordered-authority-and-frozen-membership；**secondarySkills**：S15；**feedback**：ui.branch-review-merge；**mutant**：M-MB-08。

### D-03 OpenAPI 与 FINAL point-in-time snapshot 联合合同 — 4 分
- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture**：README OpenAPI/snapshot、T16 exact union/resources/Work/Event；全状态fixture。
- **公开动作 / oracle**：冻结contract map校验routes/shapes/errors，activity中读取snapshot并独立sort/replay/digest。
- **Mandatory / 禁止副作用**：V1+Branch/MR/branchSnapshots exact keys/shapes/sorts，branchId/mergeRequestId compatibility、Work enum/token omission正确；terminalAt规则 blockedBy: MB-GAP-01。
- **primarySkill**：S11 point-in-time-snapshot-audit；**feedback**：contract.branch-snapshot；**mutant**：M-MB-04。

### D-04 Source operations→preview→target revision→diff/Event 闭环 — 3 分
- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture**：T16 canonical merge operation/rebase/digest；nonconflict与conflict MR。
- **公开动作 / oracle**：从source revision history重建MergeOperations和preview，追到approval、merged revision、Snapshot、diff、Events/snapshot。
- **Mandatory / 禁止副作用**：source pair/order/preconditions/resultDigest/blocks/provenance全链一致；conflict链无target mutation，success只一revision且legacy main read看到同blocks。
- **primarySkill**：S11 point-in-time-snapshot-audit；**secondarySkills**：S06；**feedback**：cross-layer.merge-lineage；**mutant**：M-MB-05。

## 8. E — 兼容与完整负载

### E-01 V1 main history到Branch FINAL的无损升级 — 2.5 分
- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture**：T16 migration/legacy rules；V1 binary创建all Changes/Conflicts/Snapshots/events/replays/pending lease。
- **公开动作 / oracle**：同库FINAL migration后old endpoints/replay/edit/read，排空pendingSnapshot并GETbranches/new APIs。
- **Mandatory / 禁止副作用**：IDs/bodies/digests/sequences/replay/asset prefix不变，所有V1 history映射main且old response无branch fields；pending Work绑定原prefix。main exact generated identity blockedBy: MB-GAP-02。
- **primarySkill**：S06 ordered-authority-and-frozen-membership；**secondarySkills**：S02；**feedback**：migration.main-branch-compat；**mutant**：M-MB-06。

### E-02 Non-overlapping Change apply 完整 workload — 2.5 分
- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture**：README scenario non-overlapping-change-apply exact setup/selector/request/64/10s+60s。
- **公开动作 / oracle**：每Document一in-flight，deterministic64ASCII replacement与fresh key，逐response重算digest。
- **Mandatory / 禁止副作用**：≥300 APPLIED/s、p95≤250ms；conflict/revisiongap/5xx=0，负载后blocks/client sequences/events闭合。
- **primarySkill**：S06 ordered-authority-and-frozen-membership；**secondarySkills**：S14；**feedback**：perf.change-apply；**mutant**：M-MB-07。

### E-03 Document revision read 完整 workload — 2.5 分
- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture**：README scenario document-revision-read exact seed/selector/64/10s+60s。
- **公开动作 / oracle**：按documentId/revision round-robin读取完整body，逐次重算blocks digest/provenance。
- **Mandatory / 禁止副作用**：≥400 reads/s、p95≤120ms、digest mismatch/5xx=0；不能以current head代替requested immutable revision。
- **primarySkill**：S11 point-in-time-snapshot-audit；**secondarySkills**：S14；**feedback**：perf.revision-read；**mutant**：M-MB-04。

### E-04 百万operations Snapshot recovery 完整 workload — 2.5 分
- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture**：README scenario snapshot-compaction-recovery exact10k docs/1m ops/kill/timer。
- **公开动作 / oracle**：两workers claimed后SIGKILL，lease expiry启动两replacement，流式replay每prefix。
- **Mandatory / 禁止副作用**：≤120秒，exact10000 verified Snapshots cover1m ops，无missing/digest mismatch/stale commit/nonterminal Work/unexpected failure。
- **primarySkill**：S07 durable-work-fenced-recovery；**secondarySkills**：S14；**feedback**：perf.snapshot-recovery；**mutant**：M-MB-09。

## 9. Mutant calibration（10 个）

| Mutant | 故障 | 主击杀 Case |
| --- | --- | --- |
| M-MB-01 | operation次序或RFC8785 digest错误 | A-01、B-01 |
| M-MB-02 | stale rebase部分apply/只记录首Conflict | A-02、D-01 |
| M-MB-03 | client sequence仅进程内或scope缺document | A-03 |
| M-MB-04 | diff/snapshot/revision读取current head | A-04、D-03、E-03 |
| M-MB-05 | MR partial apply或head stale仍merge | A-05、B-05、D-04 |
| M-MB-06 | request replay/client sequence/migration改saved body | B-02、E-01 |
| M-MB-07 | concurrent revisions有gap/same-anchor按arrival排序 | B-03、E-02 |
| M-MB-08 | duplicate reviewer计票或threshold event两次 | B-04、D-02 |
| M-MB-09 | Snapshot Work无fence或metadata先于asset | C-01、C-02、C-04、E-04 |
| M-MB-10 | Event跨transaction/unknown ACK改identity/order | C-03 |

Gold与mutant同seed三次稳定；完整负载后reference replay必须杀死吞吐假绿。

## 10. README→Case 与旧 H→Case

| Requirement | Case |
| --- | --- |
| Document/operations/revisions/digest | A-01、B-01 |
| rebase/conflicts/resolve | A-02、B-03 |
| client sequence/idempotency | A-03、B-02 |
| diff/Snapshot | A-04、C-01、C-02 |
| Branch/MR/review/merge | A-05、B-04、B-05、C-04 |
| Event recovery | C-03 |
| UI/OpenAPI/snapshot | D-01～D-04 |
| V1 compatibility | E-01 |
| exact performance | E-02～E-04 |

| 旧 H | 新 Case |
| --- | --- |
| H-01 | 不计分preflight；migration归E-01 |
| H-02 | D-01、D-03 |
| H-03 | A-01～A-04 |
| H-04 | A-01、A-02、B-03 |
| H-05 | A-03、B-02 |
| H-06 | B-03～B-05 |
| H-07 | C-01、C-02、C-04 |
| H-08 | C-03 |
| H-09 | E-01 |
| H-10 | A-05、D-04 |
| H-11 | B-04、B-05、D-02 |
| H-12 | E-02～E-04 |
| H-13 | 不单列计分，项目证据只定位对应Case |

统一Hard Caps外：revision gap、conflicted Change部分apply、client sequence双effect、Snapshot digest错误、
或STALE MR仍写target时correctness总分上限30；history/token/path泄漏或hidden asset探测为invalid。
