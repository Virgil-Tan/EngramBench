# ImportWorks Hidden Test v2（Learning）设计

本文件依据 Learning v2 profile，用 22 个领域 Case 覆盖 ImportWorks。install/build/boot、空库
migration、health、Chromium shell 与公开命令真实性属于共享 preflight，不计分。

## 1. 权威、公开 seam 与 SPEC-GAP

真值只来自 workspace/README.md、orchestration/manager-prompt.zh-CN.md、CONTEXT.md。测试只经公开
HTTP、production Chromium、verification snapshot、事件 receiver、独立 API/Worker/Dispatcher、
TEST_BARRIER_URL（只使用 README 明示的 claimed-worker barrier）、managed upload seam、
V1→FINAL checkpoint 和 README 性能 workload；禁止读
Candidate 私有表、上传目录、parser/schema helper。

- IW-GAP-01：README 发布 ErrorReport metadata 与 GET error-report，并要求 UI “download the error
  report”，但没有发布下载 response/content-type/字节格式。A-03/D-02 断言 metadata、digest、rowCount、
  页面可取得报告；对具体报告 bytes 的 oracle blockedBy: IW-GAP-01。
- IW-GAP-02：Manager 要求更新 production UI，但没有新增 Bundle 查询接口；只能从 mutation responses
  与 FINAL snapshot 观察历史。D-02 不发明 GET Bundle route，refresh 后历史展示子断言
  blockedBy: IW-GAP-02。
- IW-GAP-03：README 只明确 claimed Worker at barriers；未发布 effect-complete、before-commit
  或跨存储 publish checkpoint。C-01～C-03 只使用 claimed-worker barrier，并以公开 snapshot
  的 Work=LEASED 交叉确认；精确 effect/commit 窗口子断言 blockedBy: IW-GAP-03。

除 E-01 外每 Case 独立数据库、端口和 managed root；原始 bytes 只由 Harness 持有，失败报告不回显。

## 2. 独立 oracle、fixtures 与 worked example

Evaluator 自己做 byte interval union、SHA-256、UTF-8/NDJSON parsing、冻结 SchemaRevision validation、
finding sort、external-row identity 与 commit-mode record model。Fixture：F-UPLOAD（0/1MiB、四个乱序
chunks、overlap/gap）、F-NDJSON（valid/invalid UTF-8/JSON/schema/duplicate ID）、F-COMMIT
（两mode与跨Import identity）、F-BUNDLE（多validated jobs/一个bad AON）、F-RECOVERY、
F-V1-FINAL 和三条公开性能 seed。

**Worked example IW-W1**：total bytes 12，依次上传 ranges [8,12)、[0,4)、[4,8)，missing ranges 从
[0,8)→[4,8)→[]；range 端点为半开，不能把相邻块判 overlap。三行 NDJSON 中 row1 valid X、row2
wrong type Y、row3 valid X（duplicate external ID）；finding 稳定按 rowNumber/field/code/findingId。
ALL_OR_NOTHING 零 records，VALID_ROWS 也不能把 duplicate X 两次发布。

## 3. 评分

| Family | Cases | 分值 |
| --- | ---: | ---: |
| A 上传、验证、提交与Bundle合同 | 5 | 30 |
| B 字节/身份不变量、幂等与并发 | 5 | 25 |
| C Work、恢复与Event | 4 | 20 |
| D UI/OpenAPI/snapshot跨层 | 4 | 15 |
| E 兼容与完整负载 | 4 | 10 |
| **总计** | **22** | **100** |

Case 内 mandatory assertions 全通过才得分；blocked子断言不执行且不重分配权重。

## 4. A — 上传、验证、提交与 Bundle 合同

### A-01 冻结 ImportJob 与乱序 resumable chunk coverage — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：README Product model、Upload and resume 1–4；F-UPLOAD。
- **公开动作 / oracle**：创建job后改变current schema，乱序PUT raw chunks，逐步GET ranges/missing ranges并重放相同chunk。
- **Mandatory / 禁止副作用**：tenant/dataset/schemaRevision/mode/expected bytes+digest/external field永不漂移；range union/receivedBytes精确、chunk immutable；bytes仅在managed root且API/log/snapshot无路径。
- **primarySkill**：S01 contract-wire-triangulation；**feedback**：upload.resume-coverage；**mutant**：M-IW-01。

### A-02 complete、整文件 digest、状态机与 cancel — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：README Upload 5–6、ImportJob states/errors；F-UPLOAD。
- **公开动作 / oracle**：对gap/overlap/wrong chunk digest/wrong assembled digest/complete coverage调用complete，随后在各pre-commit state cancel/replay。
- **Mandatory / 禁止副作用**：只有exact coverage+bytecount+SHA成功并创建一次validate Work/Event；失败无Work，cancel before commit幂等，committed source digest/records不可变。
- **primarySkill**：S09 cross-store-atomic-publication；**feedback**：upload.complete-integrity；**mutant**：M-IW-02。

### A-03 冻结 schema、确定性 Findings 与 ErrorReport — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：README Validation/findings/report；F-NDJSON。
- **公开动作 / oracle**：上传后发布new schema，再validate invalid UTF-8/JSON/duplicate ID/missing/wrong/unknown rows；分页findings并GET report。
- **Mandatory / 禁止副作用**：只用captured schema；row number稳定、findings exact sort/digest且不存raw rejected value；ErrorReport terminal/rowCount/sha稳定。具体download bytes blockedBy: IW-GAP-01。
- **primarySkill**：S01 contract-wire-triangulation；**feedback**：validation.findings-report；**mutant**：M-IW-03。

### A-04 ALL_OR_NOTHING、VALID_ROWS 与 external-row identity — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：README commit modes、ROW_IDENTITY_CONFLICT；F-COMMIT。
- **公开动作 / oracle**：commit全valid/混合valid-invalid jobs，再在同tenant+dataset+external ID提交identical/different payload和跨tenant control。
- **Mandatory / 禁止副作用**：AON有任一finding则零records并REJECTED；VALID_ROWS每valid row exactly once、PARTIALLY_COMMITTED计数守恒；identical replay复用，different conflict不partial replace。
- **primarySkill**：S05 replay-precedence-and-identity-scope；**feedback**：commit.mode-row-identity；**mutant**：M-IW-04。

### A-05 ImportBundle freeze 与跨文件 all-or-none publish — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：Manager rules 1–5、exact shapes/routes/errors；F-BUNDLE。
- **公开动作 / oracle**：create/add ordered validated members/stage，尝试再改member，然后publish success及含bad AON member的Bundle。
- **Mandatory / 禁止副作用**：同tenant、一个nonterminal Bundle/member，position稳定；STAGED后member/schema/source/mode冻结；success所有允许records+events同现，bad AON使整个Bundle REJECTED且零member records。
- **primarySkill**：S09 cross-store-atomic-publication；**feedback**：bundle.atomic-publish；**mutant**：M-IW-05。

## 5. B — 字节/身份不变量、幂等与并发

### B-01 Idempotency-Key、chunk number/range/bytes identity precedence — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：README chunk replay/conflicts及tenant+method+path+key scope；两个API/response shield。
- **公开动作 / oracle**：same key/body、same key/different bytes、new key same chunk/range same bytes、new key reused number/range different bytes，含restart。
- **Mandatory / 禁止副作用**：request replay返回原status/body；chunk semantic conflicts使用正确code，不能被错误层吞掉；最多一个immutable chunk/coverage effect，跨tenant隔离。
- **primarySkill**：S05 replay-precedence-and-identity-scope；**feedback**：chunk.identity-precedence；**mutant**：M-IW-06。

### B-02 Out-of-order chunk 热点与 exact interval conservation — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：README range non-overlap/exact total；同job 64路相邻/overlap chunks。
- **公开动作 / oracle**：两个API固定交错PUT边界相邻、重复、局部overlap chunks并轮询missing ranges，最后complete。
- **Mandatory / 禁止副作用**：accepted interval union无洞无重，receivedBytes等union size；overlap loser零durable effect；assembled bytes/order/digest独立一致，不以arrival顺序拼接。
- **primarySkill**：S09 cross-store-atomic-publication；**feedback**：upload.concurrent-intervals；**mutant**：M-IW-01。

### B-03 Complete/commit 与 external-row 热点竞争 — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：README concurrent commit/unknown outcome/row identity；两个jobs竞争same external IDs。
- **公开动作 / oracle**：两个API并发complete/commit/replay，在shared IDs上混合identical/different payload。
- **Mandatory / 禁止副作用**：每job一个terminal result/record set，external identity最多一canonical payload；无duplicate/partial replacement，row/finding/job counts守恒且Event一次。
- **primarySkill**：S05 replay-precedence-and-identity-scope；**feedback**：commit.row-contention；**mutant**：M-IW-07。

### B-04 Schema publish 与 validation freeze 竞争 — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：README frozen SchemaRevision；旧/新schema对同row结论相反。
- **公开动作 / oracle**：accept job与schema revision publish交错，再让两个validation workers竞争。
- **Mandatory / 禁止副作用**：job始终用create transaction捕获revision，finding/valid count稳定；无mixed schema per row、无重验历史或因current schema改变report。
- **primarySkill**：S05 replay-precedence-and-identity-scope；**feedback**：schema.freeze-race；**mutant**：M-IW-03。

### B-05 Bundle add/stage/publish/replay 的唯一冻结集合 — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：Manager concurrency/unknown response/member conflict；两个API、32路操作。
- **公开动作 / oracle**：并发add same/different member、stage、publish与same key replay，固定三组interleaving。
- **Mandatory / 禁止副作用**：最多一个ordered frozen cohort；stage胜出后add稳定BUNDLE_FROZEN，publish一次且saved response稳定；member不能属于两个nonterminal Bundle，失败无partial records/events。
- **primarySkill**：S09 cross-store-atomic-publication；**feedback**：bundle.concurrent-freeze；**mutant**：M-IW-08。

## 6. C — Work、恢复与 Event

### C-01 IMPORT_VALIDATE claimed-barrier 崩溃恢复 — 5 分
- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture**：README fenced worker、claimed Worker at barriers；F-NDJSON/F-RECOVERY。
- **公开动作 / oracle**：在claimed-worker barrier暂停并以snapshot确认目标Work=LEASED；一支SIGKILL后由replacement恢复，另一支等lease过期/replacement完成后再释放旧worker。
- **Mandatory / 禁止副作用**：replacement读取同immutable bytes/schema，findings/counts/reference result exact且一次；stale commit失败，Work terminal、Event identity唯一。
- **primarySkill**：S07 durable-work-fenced-recovery；**feedback**：validation.recovery；**mutant**：M-IW-09。

### C-02 IMPORT_COMMIT 与 ERROR_REPORT claimed-barrier 恢复 — 5 分
- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture**：README duplicate work/restart/report；F-COMMIT/F-RECOVERY。
- **公开动作 / oracle**：两类Work分别在claimed-worker barrier暂停并以snapshot确认LEASED后SIGKILL，再由replacement重试。
- **Mandatory / 禁止副作用**：CommittedRecord/finding/report identity和digest各一次，report不提前公开，terminal job/count/Event保持闭合。artifact完成后/DB commit前的精确窗口子断言 blockedBy: IW-GAP-03。
- **primarySkill**：S07 durable-work-fenced-recovery；**feedback**：commit-report.recovery；**mutant**：M-IW-09。

### C-03 BUNDLE_PUBLISH 中途崩溃的跨成员恢复 — 5 分
- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture**：Manager Work aggregateId、no partial publish、restart；F-BUNDLE。
- **公开动作 / oracle**：在claimed-worker barrier暂停并以FINAL snapshot确认目标Work=LEASED后SIGKILL，replacement排空，期间replay publish。
- **Mandatory / 禁止副作用**：同bundle operation identity；所有member records/events一起可见或全无，PUBLISHED/REJECTED唯一且每member原job历史不被改写。effect-complete/before-commit精确窗口子断言 blockedBy: IW-GAP-03。
- **primarySkill**：S09 cross-store-atomic-publication；**secondarySkills**：S07；**feedback**：bundle.publish-recovery；**mutant**：M-IW-05。

### C-04 Import/Bundle Event unknown ACK — 5 分
- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture**：README byte-identical retry/event sequence与Manager publication events；由Harness控制响应的receiver。
- **公开动作 / oracle**：receiver收完整event后暂不响应，Evaluator SIGKILL已知dispatcher进程；重启、500和断线重试。
- **Mandatory / 禁止副作用**：business/records+Event同transaction、rollback无Event；重投eventId/aggregate sequence/headers/body逐byte相同，单aggregate有序且无raw bytes/rejected values/path。
- **primarySkill**：S07 durable-work-fenced-recovery；**feedback**：event.unknown-ack；**mutant**：M-IW-10。

## 7. D — UI、OpenAPI、snapshot 跨层

### D-01 浏览器完成 create→乱序upload→resume→complete — 4 分
- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture**：README UI upload/resume/progress；F-UPLOAD。
- **公开动作 / oracle**：production Chromium经file/control上传部分chunks，refresh/restart UI后继续，complete并等待validation。
- **Mandatory / 禁止副作用**：received/missing ranges、digest/state与API一致，loading/error/recovery可见，键盘/移动可用；页面不读private path或用browser storage作authority。
- **primarySkill**：S01 contract-wire-triangulation；**secondarySkills**：S15；**feedback**：ui.resumable-upload；**mutant**：M-IW-02。

### D-02 浏览器查看 Findings、commit/cancel、report 与 Bundle — 4 分
- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture**：README UI全流程与Manager production UI；F-NDJSON/F-BUNDLE。
- **公开动作 / oracle**：页面分页findings、下载report、选择mode commit/cancel；创建/add/stage/publish Bundle并显示错误。
- **Mandatory / 禁止副作用**：row counts/findings/records/Bundle state与HTTP一致，raw rejected values/paths不展示；report exact bytes blockedBy: IW-GAP-01；refresh后Bundle GET blockedBy: IW-GAP-02。
- **primarySkill**：S09 cross-store-atomic-publication；**secondarySkills**：S15；**feedback**：ui.commit-bundle；**mutant**：M-IW-05。

### D-03 OpenAPI、FINAL snapshot 与 artifact 隔离 — 4 分
- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture**：README exact shapes/resources/security、Manager snapshot keys/Work；全状态fixture。
- **公开动作 / oracle**：冻结contract map校验routes/schema/errors，activity中读取snapshot并独立排序、扫描sentinel raw bytes/value/path/token。
- **Mandatory / 禁止副作用**：V1+Manager exact keys/shapes、importBundles/bundleMembers、BUNDLE_PUBLISH Work和events一致；snapshot point-in-time且敏感artifact零命中。
- **primarySkill**：S01 contract-wire-triangulation；**secondarySkills**：S11；**feedback**：contract.snapshot-isolation；**mutant**：M-IW-10。

### D-04 Source bytes→Findings→Records→Event 的跨层守恒 — 3 分
- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture**：README validation/commit/snapshot invariants；一组AON、一组VALID_ROWS、一个Bundle。
- **公开动作 / oracle**：从Harness source bytes独立解析每row，追到job counts/findings/record payloadDigest/report/Event/snapshot。
- **Mandatory / 禁止副作用**：total=valid+invalid，published record集合精确，sourceImport/external identity/digest闭合；失败链无records/events，任何公开面不含raw invalid value。
- **primarySkill**：S09 cross-store-atomic-publication；**feedback**：cross-layer.row-conservation；**mutant**：M-IW-04。

## 8. E — 兼容与完整负载

### E-01 V1→FINAL records/replay 与历史发布兼容 — 2.5 分
- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture**：Manager migration rule 6；V1 binary创建全状态、pending Work、unacked Event、saved replay。
- **公开动作 / oracle**：同库FINAL migration后重放old upload/complete/commit，排空pending Work并创建新Bundle。
- **Mandatory / 禁止副作用**：job/chunk/finding/record/report/event/replay IDs/body/digest/count不变；committed job不回写成Bundle member，新resources初始空。
- **primarySkill**：S05 replay-precedence-and-identity-scope；**secondarySkills**：S02；**feedback**：migration.import-compat；**mutant**：M-IW-07。

### E-02 两千 resumable upload 完整 workload — 2.5 分
- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture**：README resumable-upload exact 2k×1MiB/4chunks/64clients。
- **公开动作 / oracle**：BENCH_PERF_SCALE=1原样运行，逐job独立重算coverage/digest及replay。
- **Mandatory / 禁止副作用**：≥40 completed uploads/s、p95≤1500ms、5xx=0；范围/bytes/digest精确，负载后无managed-root逃逸或Work/Event异常。
- **primarySkill**：S09 cross-store-atomic-publication；**secondarySkills**：S14；**feedback**：perf.resumable-upload；**mutant**：M-IW-01。

### E-03 五千 VALID_ROWS partial commit workload — 2.5 分
- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture**：README partial-commit exact 5k×100 rows/10 invalid/32clients。
- **公开动作 / oracle**：完整scale运行并按source重新验证每个row、finding和external identity。
- **Mandatory / 禁止副作用**：≥20 imports/s、p95≤2500ms、恰450000 records/50000 findings；duplicate/partial replace/cross-tenant/5xx=0。
- **primarySkill**：S05 replay-precedence-and-identity-scope；**secondarySkills**：S14；**feedback**：perf.partial-commit；**mutant**：M-IW-04。

### E-04 一万 validation Work SIGKILL 排空 — 2.5 分
- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture**：README validation-recovery exact kill/lease/four replacements/120s。
- **公开动作 / oracle**：两个worker到达claimed barrier且snapshot确认各目标Work=LEASED后SIGKILL，lease到期启动四replacement，完整重算post-load invariants。
- **Mandatory / 禁止副作用**：≤120秒排空；duplicate record/finding/report/event、stale commit、missing Work、5xx均为零，byte coverage/row counts/Event sequence闭合。
- **primarySkill**：S07 durable-work-fenced-recovery；**secondarySkills**：S14；**feedback**：perf.validation-recovery；**mutant**：M-IW-09。

## 9. Mutant calibration（10 个）

| Mutant | 故障 | 主击杀 Case |
| --- | --- | --- |
| M-IW-01 | 按arrival拼chunks或interval端点错一 | A-01、B-02、E-02 |
| M-IW-02 | complete不验assembled digest/coverage | A-02、D-01 |
| M-IW-03 | validation读取current schema或findings乱序 | A-03、B-04 |
| M-IW-04 | VALID_ROWS重复external ID或AON部分commit | A-04、D-04、E-03 |
| M-IW-05 | Bundle逐member publish可见 | A-05、C-03、D-02 |
| M-IW-06 | chunk key/number/range identity优先级错误 | B-01 |
| M-IW-07 | concurrent commit覆盖不同payload | B-03、E-01 |
| M-IW-08 | stage与add非原子、cohort漂移 | B-05 |
| M-IW-09 | validate/commit Work无fence | C-01、C-02、E-04 |
| M-IW-10 | Event跨事务/重投改body或泄漏raw value | C-04、D-03 |

Gold和mutant同seed三次稳定；完整负载后的public snapshot oracle必须杀死吞吐假绿。

## 10. README→Case 与旧 H→Case

| Requirement | Case |
| --- | --- |
| frozen job/chunk resume/complete | A-01、A-02、B-01、B-02 |
| validation/findings/report | A-03、B-04、C-01 |
| commit modes/external identity | A-04、B-03、D-04 |
| ImportBundle freeze/publish | A-05、B-05、C-03 |
| Work/Event recovery | C-01～C-04 |
| UI/OpenAPI/snapshot/security | D-01～D-04 |
| compatibility | E-01 |
| exact performance | E-02～E-04 |

| 旧 H | 新 Case |
| --- | --- |
| H-01 | 不计分preflight；migration归E-01 |
| H-02 | D-01～D-03 |
| H-03 | A-01～A-04 |
| H-04 | A-02、A-03、A-04 |
| H-05 | B-01 |
| H-06 | B-02、B-03 |
| H-07 | C-01、C-02 |
| H-08 | C-04 |
| H-09 | E-01 |
| H-10 | A-05、D-02、D-04 |
| H-11 | B-05、C-03 |
| H-12 | E-02～E-04 |
| H-13 | 不单列计分，项目证据只定位对应Case |

统一 Hard Caps 外：ALL_OR_NOTHING或Bundle部分发布、external identity被覆盖、managed-root逃逸/
raw rejected value泄漏时correctness总分上限30；读取hidden asset为invalid。
