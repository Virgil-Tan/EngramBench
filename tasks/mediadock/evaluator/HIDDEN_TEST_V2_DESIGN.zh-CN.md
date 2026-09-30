# MediaDock Hidden Test v2（Learning）设计

本文件按 Learning v2 profile 定义 22 个 MediaDock 领域 Case。install/build/boot、空库 migration、
health、Chromium shell和公开命令真实性由共享preflight负责，不计分。旧H-12中的吞吐阈值未写入
workspace README或Manager文本，因此不作为v2评分真值。

## 1. 权威、公开 seam 与 SPEC-GAP

预期只来自 workspace/README.md、orchestration/manager-prompt.zh-CN.md、CONTEXT.md。允许seam为
公开HTTP、deterministic Scanner/Transcoder doubles、production Chromium、verification snapshot、
事件receiver、独立API/Worker/Dispatcher、进程信号、隔离MANAGED_DATA_ROOT和V1→FINAL
checkpoint；禁止读私有表、路径映射、token hash、staging目录或Candidate digest helper。

- MD-GAP-01：Manager没有发布MediaAlias/PublicationRevision的exact shape，create/publish body和
  response、status、errors或revision字段。D-03/E-04相关wire/CAS Case blockedBy: MD-GAP-01。
- MD-GAP-02：GET /public/media/:aliasId未说明多个requiredProfileIds时返回哪个rendition、响应
  headers/content type/range行为，也没有定义AccessGrant如何公开绑定PublicationRevision。
  D-04的alias bytes/Grant Case blockedBy: MD-GAP-02。
- MD-GAP-03：Manager要求保护“未过保留期的旧revision”，但没有发布retention来源、时长或字段。
  旧publication cleanup eligibility子断言 blockedBy: MD-GAP-03；current/active Grant/live stream
  references仍可按字面验证不删除。
- MD-GAP-04：README没有发布performance workload/threshold；旧私有E2E中的80/s、40/s、90秒
  不得升级为Learning Case。E-02～E-03只验证公开cardinality/并发正确性，不声称性能通过。
- MD-GAP-05：README 未发布 TEST_BARRIER_URL；Manager 只泛称 Barrier/SIGKILL Recovery，
  仍未发布 barrier protocol 或 claimed/effect-complete/before-commit checkpoint。
  C-02/C-03 只能轮询公开 snapshot 至目标 Work=LEASED 后 SIGKILL；
  C-01 的 staging/promotion/DB-commit 精确崩溃点、C-02/C-03 的内部 effect 窗口及释放过期旧 owner
  子断言 blockedBy: MD-GAP-05。

除E-01外每Case独立数据库、managed root和端口；failure evidence只给digest/identity，不泄漏bytes/path/token。

## 2. 独立 oracle、fixtures 与 worked example

Evaluator自行计算deterministic part ranges、interval coverage、SHA-256、COPY/PREFIX bytes、RFC7233 range、
HMAC capability和完整object-reference reachability；Candidate metadata不是真值。Fixture：F-UPLOAD
（乱序/重放/边界parts）、F-SCAN（clean/eicar/unknown）、F-PROFILE（COPY/PREFIX revisions）、
F-GRANT（source/rendition/ranges/expiry）、F-CLEANUP（shared blobs/live refs）、F-RECOVERY、
F-V1-FINAL。

**Worked example MD-W1**：expectedSize=20000、partSize=8192，parts必须是Content-Range
bytes 0-8191/20000、8192-16383/20000、16384-19999/20000；HTTP end为inclusive，而UploadPart
shape的start/end语义必须与公开manifest一致。PREFIX profile的decoded bytes为ABC时rendition exact
bytes为ABC+source，size加3、digest重算；不能只拼metadata或复用source digest。

## 3. 评分

| Family | Cases | 分值 |
| --- | ---: | ---: |
| A Upload/Scan/Transcode/Grant合同 | 5 | 30 |
| B byte/reference不变量、幂等与并发 | 5 | 25 |
| C Work、跨存储恢复与Event | 4 | 20 |
| D UI/OpenAPI/snapshot/publication | 4 | 15 |
| E 兼容与公开边界负载 | 4 | 10 |
| **总计** | **22** | **100** |

Case内mandatory assertions全过才得分；blockedBy Case不执行、不重归一化。

## 4. A — Upload/Scan/Transcode/Grant 合同

### A-01 冻结 UploadSession 与确定性 multipart ranges — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：README Multipart 1–4；F-UPLOAD与MD-W1。
- **公开动作 / oracle**：创建upload，乱序PUT binary parts，逐步GET sorted manifest并重放；测size/partSize/10000-part boundaries。
- **Mandatory / 禁止副作用**：expected metadata/expiry冻结，Content-Range/length/part digest/range精确；accepted parts immutable，resume无重漏；invalid/跨tenant/path-like filename不能越managed root或留下part/work/event。
- **primarySkill**：S09 cross-store-atomic-publication；**feedback**：upload.multipart-ranges；**mutant**：M-MD-01。

### A-02 Complete assembly、whole digest 与 atomic Blob/Asset/Scan — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：README Multipart 5–7、Blob identity；完整/缺口/错manifest F-UPLOAD。
- **公开动作 / oracle**：提交ordered manifest并发complete，另测whole size/digest mismatch、abort/expiry fence。
- **Mandatory / 禁止副作用**：成功exact one COMMITTED Blob、QUARANTINED Asset、ScanJob和response identity；staging不可见，DB不指missing/partial bytes；失败无promotion/Work/Event，terminal upload不可改写。
- **primarySkill**：S09 cross-store-atomic-publication；**feedback**：upload.atomic-complete；**mutant**：M-MD-02。

### A-03 Scanner gate、UNKNOWN reconcile 与 INFECTED terminal — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：README Virus scan 1–5；F-SCAN含EICAR/timeout/reset/duplicate results。
- **公开动作 / oracle**：complete后尝试source grant/transcode，提交clean/infected/reordered scanner results并reconcile stable requestId。
- **Mandatory / 禁止副作用**：CLEAN前下载/grant/transcode禁止；UNKNOWN不建第二semantic ScanJob；CLEAN一次放行，INFECTED取消pending transcode/grants且永不rendition；raw scanner body/signature/diagnostic不公开。
- **primarySkill**：S07 durable-work-fenced-recovery；**feedback**：scan.gate-reconcile；**mutant**：M-MD-03。

### A-04 Frozen profile fan-out 与 deterministic Rendition bytes — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：README Transcode 1–5；F-PROFILE含COPY/PREFIX及later revision。
- **公开动作 / oracle**：让Asset变CLEAN，更新profile后排空jobs；下载每READY rendition并按source独立构造expected bytes。
- **Mandatory / 禁止副作用**：每captured (asset,profile,revision) oneJob/oneRendition，later profile不漂移；size/digest/bytes exact，全部captured成功才Asset READY，exhausted失败不发布partial。
- **primarySkill**：S09 cross-store-atomic-publication；**secondarySkills**：S17；**feedback**：transcode.frozen-renditions；**mutant**：M-MD-04。

### A-05 Capability Grant、HMAC、HEAD/Range、expiry/revoke — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：README Temporary access 1–5；F-GRANT。
- **公开动作 / oracle**：source/rendition grant create/replay/revoke；fullGET、HEAD、first/middle/last range、multi-range/416、expiry boundary。
- **Mandatory / 禁止副作用**：仅READY/CLEAN eligible；same replay exact grant/url/token而server不存raw token；constant-time语义不可直接计时推断但wrong token统一拒绝；206/headers/ETag/bytes精确，next request立刻看revoke/expiry。
- **primarySkill**：S09 cross-store-atomic-publication；**feedback**：grant.range-capability；**mutant**：M-MD-05。

## 5. B — byte/reference 不变量、幂等与并发

### B-01 Part/key/bytes identity precedence 与 unknown response — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：README part conflict及mutation idempotency；两个API/response shield。
- **公开动作 / oracle**：same key/body、same key/different bytes、new key same part/range same bytes、new key samepart changed range/digest，含restart。
- **Mandatory / 禁止副作用**：request replay恢复原response；semantic conflict不被错误层吞掉，oldpart不变；最多一coverage effect，无额外staging/Work/Event。
- **primarySkill**：S05 replay-precedence-and-identity-scope；**secondarySkills**：S09；**feedback**：part.identity-precedence；**mutant**：M-MD-06。

### B-02 64路 complete、content dedup 与tenant non-disclosure — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：README concurrent complete/Blob identity；两tenant identical bytes与timing class controls。
- **公开动作 / oracle**：两个API64路complete，同/跨tenant上传same digest，再对一个tenant做logical cleanup并下载另一tenant。
- **Mandatory / 禁止副作用**：每upload oneAsset/Scan，physical sharing不改变tenant-scoped response/error/timing class；删除一引用不删另一bytes，snapshot/UI不披露dedup existence/refcount。
- **primarySkill**：S09 cross-store-atomic-publication；**feedback**：blob.dedup-isolation；**mutant**：M-MD-07。

### B-03 Scanner duplicate/reordered result 与 asset terminal race — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：README stable scannerRequestId/commutative results；clean/infected/unknown竞态。
- **公开动作 / oracle**：两个API固定交错提交duplicate CLEAN、UNKNOWN、late INFECTED和reconcile，workers同时claim。
- **Mandatory / 禁止副作用**：同request identity结果幂等且published state不可被stale result逆转；最多一次clean/infected transition，INFECTED无grant/rendition，events连续。
- **primarySkill**：S07 durable-work-fenced-recovery；**feedback**：scan.result-convergence；**mutant**：M-MD-03。

### B-04 Transcode workers 并发 promotion 与 READY aggregate — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：README unique job/retry/staging/fenced promotion；多profile Asset、四workers。
- **公开动作 / oracle**：重复claim/complete同job、损坏output、一个profile最终失败与全部成功交错。
- **Mandatory / 禁止副作用**：每identity oneRendition/Blob ref，bad digest不READY；Asset只在全部captured success后一次READY，failed member禁止提前aggregate成功。
- **primarySkill**：S09 cross-store-atomic-publication；**secondarySkills**：S17；**feedback**：transcode.concurrent-promotion；**mutant**：M-MD-04。

### B-05 Cleanup frozen candidates 与 live-reference recheck — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：README Cleanup 1–5；F-CLEANUP含shared blob、active grant、live stream、later object。
- **公开动作 / oracle**：plan run后新增references/object，执行delete并在每entry前改变grant/stream state。
- **Mandatory / 禁止副作用**：cutoff/policy/candidate identities冻结，later objects不扫；每delete前完整reference oracle，live→SKIPPED；shared/active stream bytes保留，eligible exact object idempotent删除。
- **primarySkill**：S09 cross-store-atomic-publication；**feedback**：cleanup.reference-safety；**mutant**：M-MD-08。

## 6. C — Work、跨存储恢复与 Event

### C-01 Upload complete unknown outcome 与重启可见性 — 5 分
- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture**：README atomic promotion/crash-safe/idempotent complete；F-RECOVERY。
- **公开动作 / oracle**：用response shield制造complete的unknown HTTP outcome，重启专用API并重放complete，全程经snapshot与下载seam核对可见状态。
- **Mandatory / 禁止副作用**：公开metadata永不指partial/missing Blob，最终oneBlob/Asset/Scan/response，未提交内容不可grant且不越root。staging完成、filesystem promote后和DB commit前的精确SIGKILL子断言 blockedBy: MD-GAP-05。
- **primarySkill**：S09 cross-store-atomic-publication；**feedback**：upload.promotion-recovery；**mutant**：M-MD-02。

### C-02 VIRUS_SCAN/TRANSCODE 在公开 LEASED 后 SIGKILL — 5 分
- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture**：README Work fence、scanner/transcoder doubles；F-SCAN/F-PROFILE。
- **公开动作 / oracle**：每类Work单独启动worker，轮询snapshot至目标Work=LEASED后SIGKILL，lease到期后replacement恢复。
- **Mandatory / 禁止副作用**：stable scannerRequestId/job identity；CLEAN/INFECTED/Rendition各一次，bytes/digest exact，temporary output不公开。scanner返回后、promotion前及旧owner释放子断言 blockedBy: MD-GAP-05。
- **primarySkill**：S07 durable-work-fenced-recovery；**secondarySkills**：S09；**feedback**：pipeline.worker-recovery；**mutant**：M-MD-09。

### C-03 CLEANUP_DELETE 在公开 LEASED 后崩溃恢复 — 5 分
- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture**：README DELETING protocol/missing-byte proof/no broad scans；F-CLEANUP。
- **公开动作 / oracle**：单独启动worker，轮询snapshot至目标 CLEANUP_DELETE Work=LEASED后SIGKILL，lease到期后replacement继续，并经公开资源与控制下载核对reachability。
- **Mandatory / 禁止副作用**：只处理frozen identity，missing bytes仅在同deletion proof下成功；one semantic delete/Event，live/shared refs不删且不发生广域删除。mark后、exact delete后、DB terminal前的精确窗口子断言 blockedBy: MD-GAP-05。
- **primarySkill**：S07 durable-work-fenced-recovery；**secondarySkills**：S09；**feedback**：cleanup.delete-recovery；**mutant**：M-MD-09。

### C-04 Pipeline/Cleanup Event unknown ACK — 5 分
- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture**：README required event types/stable delivery；由Harness控制响应的receiver。
- **公开动作 / oracle**：receiver收完并保存body后暂不响应，Evaluator SIGKILL已知dispatcher进程；混入500/断线后restart。
- **Mandatory / 禁止副作用**：transition/reference/Work/Event同transaction、rollback无Event；retry eventId/body/order稳定，无raw bytes/token/scanner payload/path；一个aggregate失败不制造新identity。
- **primarySkill**：S07 durable-work-fenced-recovery；**feedback**：event.delivery-secrecy；**mutant**：M-MD-10。

## 7. D — UI、OpenAPI、snapshot 与 publication

### D-01 浏览器完成 V1 upload→scan→rendition→grant→cleanup — 4 分
- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture**：README Domain明确real React operations UI及全部公开routes；F-UPLOAD/F-SCAN/F-GRANT。
- **公开动作 / oracle**：production Chromium仅经visible controls创建/resume/complete upload，看Scan/Transcode，下载/revoke Grant，plan/observe Cleanup。
- **Mandatory / 禁止副作用**：状态/bytes/digests/Work/errors与HTTP一致，refresh/keyboard/mobile可用；不显示raw token（一次返回后的页面持久层亦无）、path、scanner body或cross-tenant dedup事实。
- **primarySkill**：S15 cross-layer-acceptance-closure；**feedback**：ui.media-pipeline；**mutant**：M-MD-05。

### D-02 真实发布 UI 的 Alias/Revision 流程 — 4 分
- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture**：Manager rule9、rules1–7。
- **公开动作 / oracle**：拟创建Alias、选required profiles、publish READY Asset、并发switch、查看revision和旧Grant。
- **Mandatory / 禁止副作用**：UI应只允许verified complete publication、显示CAS failure且不半切换、旧Grant不漂移。因public shapes/routes body/response和render target缺失，blockedBy: MD-GAP-01, MD-GAP-02。
- **primarySkill**：S15 cross-layer-acceptance-closure；**feedback**：ui.publication-gap；**mutant**：M-MD-10。

### D-03 OpenAPI、point-in-time snapshot 与 secret/path absence — 4 分
- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture**：README exactroutes/shapes/snapshot/security与Manager新resources/work/event；全状态fixture。
- **公开动作 / oracle**：冻结V1 contract map校验OpenAPI，activity中snapshot并独立sort，递归扫描sentinel bytes/path/token/hash/signing/scanner data。
- **Mandatory / 禁止副作用**：V1resources/Work/Events same point-in-time且敏感值零命中；MediaAlias/PublicationRevision/PUBLICATION_SWITCH exact shape blockedBy: MD-GAP-01。
- **primarySkill**：S15 cross-layer-acceptance-closure；**secondarySkills**：S11；**feedback**：snapshot.media-secrecy；**mutant**：M-MD-10。

### D-04 Alias stream、Publication pinning 与 Grant lineage — 3 分
- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture**：Manager rules2–6；两个READY Assets和live download。
- **公开动作 / oracle**：拟publish revision1并grant，stream中切revision2，再用old/newGrant/publicalias下载和cleanup。
- **Mandatory / 禁止副作用**：每response完整属于一个revision、不撕裂digest；oldGrant固定rev1/newGrant固定rev2，current/live refs不删。返回rendition与wire未定义，blockedBy: MD-GAP-01, MD-GAP-02；旧revision retention分支另blockedBy: MD-GAP-03。
- **primarySkill**：S09 cross-store-atomic-publication；**feedback**：publication.stream-gap；**mutant**：M-MD-10。

## 8. E — 兼容与公开边界负载

### E-01 V1→FINAL bytes、lease、replay 与 Cleanup 无损迁移 — 2.5 分
- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture**：Manager rule8；V1 binary创建half upload、UNKNOWN scan、RUNNING transcode、READY rendition、active grant、cleanup、pendingwork、event/replay。
- **公开动作 / oracle**：同库FINAL migration后replay旧API、恢复workers并重新下载所有可达bytes。
- **Mandatory / 禁止副作用**：全部identity/bytes/digest/state/lease/event/replay不变，新Alias resources空；旧worker不能绕开新的reference checks，migration不移动/损坏managed files。
- **primarySkill**：S09 cross-store-atomic-publication；**secondarySkills**：S02；**feedback**：migration.media-compat；**mutant**：M-MD-07。

### E-02 最大公开 multipart cardinality 与 managed-root 边界 — 2.5 分
- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture**：README size/partSize/≤10000 parts与path confinement；合法恰10000 parts及10001拒绝fixture。
- **公开动作 / oracle**：跨两个API乱序提交boundary manifest并resume/complete，同时使用path-like filenames/headers。
- **Mandatory / 禁止副作用**：10000-part coverage/digest exact且能恢复，10001或非法range原子拒绝；所有实际bytes在case managed root，无path disclosure/traversal。无吞吐阈值（MD-GAP-04）。
- **primarySkill**：S09 cross-store-atomic-publication；**feedback**：upload.max-cardinality；**mutant**：M-MD-01。

### E-03 多live stream lease 与 Cleanup reachability — 2.5 分
- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture**：README Temporary access4/Cleanup3；source/rendition/shared blob和并发GET。
- **公开动作 / oracle**：开启多个慢stream并固定已解析Blob，在revoke/expiry/cleanup期间逐byte读取，结束后再run cleanup。
- **Mandatory / 禁止副作用**：每live response完整且digest精确，期间blob不删；next request遵守revoke/expiry，所有lease结束后eligible object才可删，共享tenant control仍可读。无自造throughput阈值。
- **primarySkill**：S09 cross-store-atomic-publication；**feedback**：stream.cleanup-lease；**mutant**：M-MD-08。

### E-04 Concurrent Publication CAS 与 PUBLICATION_SWITCH recovery — 2.5 分
- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture**：Manager rules3/7；两个API、独立Worker、两个READY Asset。
- **公开动作 / oracle**：若wire补齐，拟同expectedRevision并发publish；仅在FINAL snapshot观察到 PUBLICATION_SWITCH Work=LEASED后SIGKILL并恢复。
- **Mandatory / 禁止副作用**：恰一immutable revision/current pointer/event，另一CAS失败；恢复不半切换/duplicate revision。因wire/state/error/shape未发布，blockedBy: MD-GAP-01；精确内部崩溃点另 blockedBy: MD-GAP-05。
- **primarySkill**：S09 cross-store-atomic-publication；**secondarySkills**：S07；**feedback**：publication.cas-gap；**mutant**：M-MD-10。

## 9. Mutant calibration（10 个）

| Mutant | 故障 | 主击杀 Case |
| --- | --- | --- |
| M-MD-01 | Content-Range端点/最后part/10000边界错误 | A-01、E-02 |
| M-MD-02 | metadata COMMITTED先于atomic byte promotion | A-02、C-01 |
| M-MD-03 | UNKNOWN建新Scan或stale INFECTED/CLEAN覆写 | A-03、B-03 |
| M-MD-04 | profile读取latest或部分jobs即READY | A-04、B-04 |
| M-MD-05 | Grant不验gate/range或泄漏raw token | A-05、D-01 |
| M-MD-06 | part key/range/bytes identity优先级错 | B-01 |
| M-MD-07 | dedup暴露跨tenant或migration丢blob ref | B-02、E-01 |
| M-MD-08 | cleanup忽略live/shared/stream reference | B-05、E-03 |
| M-MD-09 | scan/transcode/cleanup Work无fence | C-02、C-03 |
| M-MD-10 | Event/publication非原子或public面泄密 | C-04；blocked D-02～D-04/E-04 |

前9个active mutants必须同seed三次稳定被杀；M-MD-10的publication变体待SPEC补齐后进入freeze gate。

## 10. README→Case 与旧 H→Case

| Requirement | Case |
| --- | --- |
| multipart/resume/complete | A-01、A-02、B-01、C-01 |
| scan gate/reconcile | A-03、B-03、C-02 |
| transcode/profile/rendition | A-04、B-04、C-02 |
| grant/range/stream | A-05、E-03 |
| cleanup/reachability | B-05、C-03、E-03 |
| Event/UI/OpenAPI/snapshot | C-04、D-01、D-03 |
| Alias/Publication | D-02、D-04、E-04（blocked） |
| compatibility | E-01 |
| public cardinality boundary | E-02 |

| 旧 H | 新 Case |
| --- | --- |
| H-01 | 不计分preflight；migration归E-01 |
| H-02 | D-01、D-03、B-02 |
| H-03 | A-01～A-04 |
| H-04 | A-01、A-02 |
| H-05 | B-01、A-05 |
| H-06 | B-02、B-04 |
| H-07 | A-03、C-02 |
| H-08 | C-03、C-04 |
| H-09 | E-01 |
| H-10 | A-05、D-04 |
| H-11 | B-05、E-04 |
| H-12 | 不映射：阈值只在旧私有计划，非公开合同 |
| H-13 | 不单列计分，证据只定位对应Case |

统一Hard Caps外：公开metadata指向missing/partial bytes、quarantine bypass、cross-tenant byte/token/path
泄漏或cleanup删除live/shared blob时correctness总分上限25；hidden asset/私有路径探测为invalid。
