# FlagFoundry Hidden Test v2 详细设计

本任务设计遵循 [`docs/hidden-test-v2-standard.zh-CN.md`](../../../docs/hidden-test-v2-standard.zh-CN.md)；
下文只定义 FlagFoundry 的任务专属合同映射、oracle、fixtures、Cases、Hard Caps 与 mutants。

## 1. 目标与边界

本方案把 H-01～H-13 拆成 **44 个独立、确定性、Harness-owned 黑盒 case**。核心覆盖 immutable
Flag Revision、RFC 8785 Snapshot digest、规则与 percentage evaluation、CAS activation、stale compilation、
Worker/outbox recovery，以及 Manager progressive cohort rollout/automatic rollback。

所有 expected value 来自冻结合同、确定性 fixtures 和 evaluator 独立 digest/evaluation/rollout oracle；不读取
Candidate 源码/ORM/私有表，不让 Candidate 自测、OpenAPI 或日志自证。本文只设计测试，不实现 runner 或修改需求。

## 2. 权威来源与合同缺口

权威顺序：V1 `workspace/README.md` → T16 固定 Manager 变更 → `workspace/AGENTS.md` → `CONTEXT.md`。

以下 `SPEC-GAP` 在合同修订前不得进入计分断言：

- `SPEC-GAP-01`：ProgressiveRollout RUNNING 时 prior/candidate `FlagRevision.state` 与“active pointer”如何投影未发布。
  V1 又声明 inactive revision 不可被 evaluation 观察，而 Manager 明确要求按 bucket 观察 candidate。Evaluator 只能验证
  Evaluation 选择、rollout counters 和最终 routing，不能规定 RUNNING 期间哪条 Revision 必须为 ACTIVE/SUPERSEDED。
- `SPEC-GAP-02`：legacy `/activate` 被描述为“一 Step、10000、零 observation 且保持旧 response shape”，但未说明
  是否必须持久化一个 `ProgressiveRollout` resource。测试保留旧 response/activation 行为，不要求或禁止隐藏 rollout row。
- `SPEC-GAP-03`：Outcome 的 snapshotDigest 不属于当前 Step 实际 evaluation 时应拒绝，但合同没有给这个分支精确错误码；
  测试要求零副作用，在补合同前不规定 `ROLLOUT_STALE`、`SNAPSHOT_MISMATCH` 或 `INVALID_REQUEST`。
- `SPEC-GAP-04`：`outcomeId` 的长度/字符集未发布；只验证 string、batch exact shape、unique semantics，不制造隐藏长度边界。
- `SPEC-GAP-05`：`CompilationFinding` shape 已发布，但没有公开它出现在哪个 response/resource。测试验证 REJECTED 状态和
  deterministic rejection，不要求未发布的 findings endpoint/字段。
- `SPEC-GAP-06`：Manager 没有发布 rollout step transition 的新 Domain Event type。不得要求新 event；只有字面存在的
  V1 activation/supersede transition 才验证 V1 event，且不自行决定其发生在 rollout start 还是 completion。
- `SPEC-GAP-07`：Environment context schema 没有公开 mutation route。Evaluator 可验证 Compilation 捕获 seed 中
  的 schemaRevision，并验证 active-revision stale race；但不能通过私有数据库制造“编译中 schema 变更”竞争。
- `SPEC-GAP-08`：合同发布了 Evaluation `reason: DEFAULT|RULE|PERCENTAGE`，但未定义何时产生 `DEFAULT`；同时未规定
  evaluation context 出现未声明 attribute 时的 status/error。测试不为这两条路径自行指定语义。

## 3. 冻结的公开 seams

| Seam | 允许操作 | 禁止操作 |
| --- | --- | --- |
| Public commands | README npm install/migrate/seed/build/start/test | import Candidate/private helper |
| HTTP | health、OpenAPI、全部公开 flag/revision/evaluation/rollout routes | debug/private routes |
| Verification snapshot | ADMIN_TOKEN 的 point-in-time snapshot | 直查表、缓存、锁 |
| Production browser | production build、系统 Chromium、可见控件 | 注入页面代码或内部 store |
| Domain receiver | WEBHOOK_URL 控制 ACK/500/断线 | 读取 Candidate outbox |
| Recovery barrier | worker/dispatcher 公开 barrier | random sleep 猜 claim/commit |
| Process boundary | 独立双 API/双 Worker/Dispatcher 与 signals | 单进程对象冒充并发 |
| V1→FINAL checkpoint | 冻结 V1 binary 写数据，再升级同库 | FINAL 伪造 V1 history |

## 4. Runner、结果与 Case 约定

建议 `evaluator/v2/{manifest,contract-map,run,lib,fixtures,cases,calibration}`。每 case 独立数据库、端口、
managed root、receiver、barrier 与进程组；migration 才复用 V1 database；performance 独占固定 4 CPU/8 GiB。

下文标题即唯一 Case ID/维度/权重；每项含前置 fixture、public-seam 操作、mandatory 可观察断言。manifest
对每个 Case 固定唯一私有 failure code：`FF_<CASE_ID>_FAILED`（Case ID 中 `-` 转为 `_`）。公开反馈只给最小
稳定类别：A=`contract`、B=`correctness`、C=`recovery`、D=`cross_layer`、E=`compat_perf`，不泄露 assertion、
fixture 或 oracle。Case 内任一 mandatory assertion 失败即 0 分；`failed`、`invalid`、`evaluator_error` 分开。

## 5. 独立 oracle 与 fixtures

### 5.1 Snapshot / Evaluation / Rollout oracle

Evaluator 不调用 Candidate 代码，独立实现：

1. RFC 8785 canonicalize exact FlagSnapshot，再 SHA-256 得 64 lowercase hex digest；variants/rules 保持 list order，
   contextAttributes sorted unique；
2. rules list-order，clauses AND；EQUALS exact case-sensitive string，IN 对 sorted unique list；first match wins；
3. 无 rule 时计算 `SHA-256(snapshotDigest + NUL + flagKey + NUL + subjectKey)`，前 8 bytes unsigned BE
   modulo 10000，再按 variants listed cumulative basis points；
4. diff arrays 按 UTF-8 bytes；changed 与 orderChanged 按发布定义独立重算；
5. progressive bucket 为 `SHA-256(flagKey + NUL + environment + NUL + subjectKey)`，与 digest 无关；bucket
   `< exposure` 选 candidate，否则 prior；
6. evaluationCount=success+failure，failureBps=`floor(failure*10000/count)`；min=0 立即 pass；
7. Step start/deadline/next step/rollback/STALE 按 database-time precedence 投影；Outcome 以 outcomeId 和完整 semantics 去重。

区分性 examples：同 subject 在 rollout Step 变化后 bucket 必须不变；若 bucket=2499，exposure 2500 选 candidate，
bucket=2500 必须选 prior。10 outcomes 中 1 failure 得 1000 bps，不能浮点四舍五入。

### 5.2 确定性与 fixture families

- UUID、keys、subject/outcome IDs、时间和 interleavings 来自私有 `evaluationSeed+caseId+ordinal`；`T0` 从可观察
  database/API time 派生；并发至少三个固定 seeds。

| Fixture | 用途 |
| --- | --- |
| F-EMPTY | clean migrate/boot/validation |
| F-FLAG | STRING/BOOLEAN flags、projects/environments/schema revisions |
| F-REVISION | COMPILING/READY/ACTIVE/REJECTED/SUPERSEDED、rule/order variants |
| F-EVALUATION | rule/default/percentage、pinned/mismatch digest |
| F-IDEMPOTENCY | mutations replay/conflict/unknown response |
| F-CONTENTION | hot active pointer、stale compilation/activation |
| F-WORK | FLAG_COMPILATION/ROLLOUT_DEADLINE lifecycle/attempt/lease |
| F-EVENT | multi aggregate sequence、未 ACK/重试/已 ACK |
| F-ROLLOUT | 1/10 Steps、min0、pass/fail/deadline/stale、多 outcomes |
| F-MIGRATION | V1 active/saved replay/pending compilation/events |
| F-BROWSER | V1 与 progressive flows/错误状态 |
| F-PERF-V1 | README 精确 100 projects/300 env/5k flags/5k active revisions |

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
- **操作**：install、重复 migrate、build，独立启动 API/Compilation Worker/Dispatcher，health/OpenAPI 后 SIGTERM。
- **可观察断言**：命令非交互、失败非零；只 bind localhost；进程独立且正常清理。

### A-02 Repeatable populated migration — 2
- **前置**：F-FLAG/F-REVISION populated database。
- **操作**：迁移两次、seed、HTTP 增加状态，再迁移两次。
- **可观察断言**：Flags/Revisions/Snapshots/Work/Event/saved replay identities 不变；失败 migration 无 partial behavior。

### A-03 Atomic deterministic seed — 2
- **前置**：合法 seed；unknown key、duplicate/missing ref、key collision、wrong type、bad allocation/digest/revision/int fixtures。
- **操作**：合法导入、same digest replay、same version different content、逐个非法导入。
- **可观察断言**：合法 exact；replay no-op；冲突 `SEED_VERSION_CONFLICT`；非法后业务/Work/Event/idempotency 不变。

### A-04 OpenAPI 3.1 exact contract — 2
- **前置**：FINAL production API。
- **操作**：独立 contract map 比较 V1/rollout routes、schemas、responses/errors、required/nullable/additionalProperties。
- **可观察断言**：live traffic 可被独立 schema 验证；ProgressiveRollout/Evaluation additions 精确；SPEC-GAP 未被测试私填。

### A-05 Common errors and DSL/cardinality boundaries — 2
- **前置**：最小 Project/Environment/Flag。
- **操作**：media/JSON/unknown/auth/not-found/cursor；ASCII key/attribute 1/64、IN 1/20、allocations、rule refs、
  steps 1/10、exposure/threshold 0/10000、observation 1/86400 边界。
- **可观察断言**：exact error envelope/code；合法边界成功；非法返回发布错误且零 Revision/Work/Event/Rollout effect。

### A-06 Pagination, reads and point-in-time snapshot — 2
- **前置**：每 collection >110，V1/FINAL resources。
- **操作**：revision lists/details/diff/rollout/snapshot/events 翻页读取。
- **可观察断言**：limit/cursor 无重无漏；exact keys/shapes/sorts、同一 asOf、recursive secret omission、Work fields 合法。

### A-07 Flag identity and Draft revision creation — 2
- **前置**：同/跨 Project keys，STRING/BOOLEAN flags，existing active revisions。
- **操作**：创建 Flags 和 revisions，重复 key、type mismatch、stale expectedActiveRevision。
- **可观察断言**：key 仅 Project scoped 且 exact case-sensitive；201 Flag 或 `FLAG_KEY_EXISTS`；202 COMPILING capture
  active/schema revision；invalid rule/allocation `INVALID_FLAG_RULE` 且零副作用。

### A-08 Deterministic Compilation and Snapshot — 2
- **前置**：同 semantic Draft 的确定性 fixtures、invalid/stale Draft。
- **操作**：运行两个 Compilation Workers，读取 Revision/Snapshot/snapshot resource。
- **可观察断言**：valid→READY、digest 与独立 RFC8785 oracle 一致；same exact snapshot same digest；invalid/stale→REJECTED，
  不可 activation/evaluation；Work/Event sequence 合法，不要求未发布 finding surface。

### A-09 Rule Evaluation semantics — 2
- **前置**：ordered rules、multi-clause、EQUALS/IN 与 case variants，所有 context 只含已声明 attributes。
- **操作**：POST evaluations with active/pinned digest。
- **可观察断言**：first matching AND rule、exact case-sensitive string、IN membership、`reason=RULE` 与
  matchedRuleId 均和 oracle 一致；missing subject 返回 `MISSING_SUBJECT_KEY`。DEFAULT 与 unknown context attribute
  按 `SPEC-GAP-08` 不计分。

### A-10 Percentage Evaluation semantics — 2
- **前置**：无 rule match、多个 ordered allocations 含 0/boundary。
- **操作**：固定 subjects 重复 evaluation、API restart 后重试。
- **可观察断言**：hash input/BE/modulo/cumulative boundaries 精确；同 digest/context 永远同 variant/reason；无 process-local authority。

### A-11 CAS Activation and stale compilation — 2
- **前置**：一个 ACTIVE、两个 READY、一个 REJECTED/COMPILING/SUPERSEDED。
- **操作**：正确/错误 expectedActiveRevision activate，随后 evaluate old/new pinned digest。
- **可观察断言**：精确一个 active pointer；winner ACTIVE、prior SUPERSEDED；stale 为 `ACTIVE_REVISION_CHANGED`，
  非 READY 为 `REVISION_NOT_READY`；inactive digest `SNAPSHOT_MISMATCH`，无 mixed snapshot。

### A-12 Revision diff and V1 Domain Events — 2
- **前置**：variants/rules add/remove/change/reorder revisions 和 lifecycle。
- **操作**：读取 diff、event query，由 receiver 接收。
- **可观察断言**：diff arrays/orderChanged 与独立 oracle 一致；V1 published event type/payload `{}`/contiguous sequence；rollback 无 event。

### A-13 FINAL progressive activation and deterministic routing — 3
- **前置**：prior ACTIVE、candidate READY，1/10 valid Steps 与 invalid ordering。
- **操作**：progressive-activate，跨 exposure Steps 对固定 subjects evaluation。
- **可观察断言**：202 exact Rollout；steps strictly increasing to 10000；first startedAt/deadline；bucket 与 digest 无关且
  `< exposure` boundary 正确；每 Evaluation 含 rolloutId/stepIndex；invalid `INVALID_ROLLOUT_STEPS` 全回滚。

### A-14 Outcome batches, step advancement and rollback — 3
- **前置**：RUNNING rollout，min0、pass、failure threshold、deadline fixtures。
- **操作**：提交 SUCCESS/FAILURE batches，读取 counters；触发 pass→next、complete、fail/timeout rollback。
- **可观察断言**：accepted/duplicate IDs 集合正确；counts/failureBps floor；min0 immediate；下一 Step 仅 predecessor pass transaction
  启动；失败/不足 deadline 原子 ROLLED_BACK，成功最终 COMPLETED；终态后的非重复 outcome 不得改变 counters/state/routing。

## 8. B — 数据正确性、幂等与并发（25 分）

### B-01 RFC8785 digest and immutability oracle — 2
- **前置**：key order 不同但 semantic exact、list order 不同的 Snapshots。
- **操作**：编译并读取 digest/snapshot。
- **可观察断言**：object key order canonicalized；variants/rules list order preserved and changes digest；published Snapshot 永不改写。

### B-02 Rule order, type and diff correctness — 2
- **前置**：overlapping rules、STRING/BOOLEAN values、reordered common members。
- **操作**：evaluate 与 diff。
- **可观察断言**：first rule wins、type exact、default/rule refs valid；changed/order arrays 按 published algorithm/UTF-8 排序。

### B-03 Allocation and bucket boundary correctness — 2
- **前置**：可找到 hash buckets 0、boundary-1、boundary、9999 的确定性 subjects。
- **操作**：V1 percentage 与 progressive routing 两套 evaluations。
- **可观察断言**：allocation total=10000；V1 使用 digest-inclusive hash，rollout 使用 digest-independent hash；`<` 非 `<=`；无浮点。

### B-04 Unknown-response durable replay — 2
- **前置**：response shield；Flag/Revision/Activate/Progressive/Outcome mutations。
- **操作**：完整 upstream response 后断 client，重试，API restart 后再重试。
- **可观察断言**：原 status/semantic JSON/IDs 固定；每 aggregate/Work/Event/Rollout/Outcome effect 一次。

### B-05 Same-key contention across two APIs — 2
- **前置**：两个 API、共享 PostgreSQL。
- **操作**：64 路同 key/body；same key different semantics；第三 API replay。
- **可观察断言**：唯一 saved result；different semantic `IDEMPOTENCY_CONFLICT`；无重复 Revision/Rollout/outcomes。

### B-06 Distinct-key activation contention — 3
- **前置**：同 Flag/Environment 两 READY candidates、同 expected active。
- **操作**：两个 API 并发 activate，三个 fixed interleavings，并发 evaluation。
- **可观察断言**：恰一个 winner，loser `ACTIVE_REVISION_CHANGED`；readers 只见完整 prior 或 winner Snapshot；一个 active pointer。

### B-07 Compilation versus schema/active changes — 3
- **前置**：Compilation 已捕获 seed 中的 schemaRevision 与 active revision；另一 READY candidate 可改变 active。
- **操作**：两个 Workers 与另一 API activation 交错完成 compilation，并从 READY Snapshot 检查 captured context schema。
- **可观察断言**：Snapshot 的 contextAttributes/schemaRevision 等于创建时公开 Environment；active 已改变的 candidate
  不得越过 CAS 成为 active，必须 stale REJECTED 或 activation conflict；stale digest 永不成为 V1 evaluation result。

### B-08 Outcome batch atomicity and semantic dedupe — 3
- **前置**：batch 包含 duplicate、conflicting outcomeId、wrong step/digest、合法 members。
- **操作**：两个 API 并发提交 overlapping batches。
- **可观察断言**：exact duplicate 不增 counters；different semantics `OUTCOME_ID_CONFLICT`；任一 invalid member 整批零副作用；
  accepted IDs 对 counters 一一对应，safe integers。

### B-09 Outcome versus deadline resolution race — 3
- **前置**：current Step 临近 observationDeadlineAt，counts 在 pass/fail boundary。
- **操作**：Outcome commit 与两个 ROLLOUT_DEADLINE Workers 三种交错。
- **可观察断言**：`>=deadline` deadline precedence；late batch `OUTCOME_WINDOW_CLOSED`；一次 pass/fail/rollback；
  next step/deadline/active routing 不出现 mixed transition。

### B-10 Progressive versus immediate activation race — 3
- **前置**：RUNNING rollout 与另一 READY revision。
- **操作**：并发 legacy activate、outcome/step advance/evaluation，多 API/Workers。
- **可观察断言**：immediate winner 使 rollout STALE；后续 outcomes `ROLLOUT_STALE` 且不改 counters/routing；
  evaluations 只见合法 complete Snapshot；无 rollback 覆盖较新的 activation。

## 9. C — Worker、恢复与持久性（20 分）

### C-01 Work schema, lifecycle and retention — 2
- **前置**：FLAG_COMPILATION/ROLLOUT_DEADLINE 的 PENDING/LEASED/terminal。
- **操作**：公开流程创建/完成并读 snapshot。
- **可观察断言**：exact enum/shape；lease fields 只 LEASED；attempt/terminal 正确；terminal retained；drain 无 nonterminal。

### C-02 SIGKILL after `worker.claimed` — 2
- **前置**：两 kind due Work、claimed barrier held。
- **操作**：杀 A，等 lease expiry，B reclaim。
- **可观察断言**：attempt 增加、effect 一次；A stale 不能 commit；等待 barrier 无开放 transaction。

### C-03 SIGKILL after `worker.effect-complete` — 2
- **前置**：digest/validation 或 deadline decision 已计算、尚未 commit。
- **操作**：effect-complete 杀 A，B 恢复。
- **可观察断言**：deterministic effect 可重做；Snapshot/Rollout/Work/Event 不重复，不永久悬挂。

### C-04 SIGKILL at `worker.before-commit` — 2
- **前置**：READY/REJECTED 或 step pass/fail 即将 commit。
- **操作**：before-commit 杀 Worker，replacement 恢复。
- **可观察断言**：transaction 全无或完整一次；无 digest 无 Snapshot、counter 已变 state 未变等 partial 状态。

### C-05 Expired-lease fencing — 3
- **前置**：A 暂停至 lease expired，B reclaim 并完成。
- **操作**：B commit 后释放 A。
- **可观察断言**：A stale owner/token 不能覆盖 Revision/Rollout/Work；最终 attempt/effect 只归 B。

### C-06 Obsolete compilation/deadline Work convergence — 3
- **前置**：Revision 已因 active revision stale；Rollout 已 COMPLETED/ROLLED_BACK/STALE，但旧 Work pending/leased。
- **操作**：人工 activation/terminal transition 与 Worker 竞争后 drain。
- **可观察断言**：obsolete Work terminal/cancelled；late Worker 不复活 Revision/Rollout、不改 routing/counters；无 immortal backlog。

### C-07 Unknown Domain Event ACK — 3
- **前置**：receiver 持久化完整 V1 event request 后暂停 ACK。
- **操作**：杀 Dispatcher，500/断线/timeout，replacement retry。
- **可观察断言**：eventId/type/body 稳定，per aggregate 成功顺序递增，ACK 后不创建新 event identity。

### C-08 Transactional events and rollout recovery — 3
- **前置**：README 明确的四类 V1 event transition 与 Manager step transitions。
- **操作**：组合 worker/dispatcher barrier、SIGKILL/restart。
- **可观察断言**：只对 `flag.compilation-started`、`flag.revision-rejected`、`flag.revision-activated`、
  `flag.revision-superseded` 四个已发布 V1 event 验证 business transition 与 event 同 transaction、rollback 无 event；
  不要求其他 V1/Manager event。Rollout/Outcome/Work 必须原子恢复；sequence 连续，snapshot/log 不泄密。

## 10. D — OpenAPI、UI 与跨层闭环（15 分）

### D-01 Independent OpenAPI/live-traffic validation — 2
- **前置**：FINAL production API 与 evaluator schema。
- **操作**：每 route 采集 success/error live responses 并独立校验。
- **可观察断言**：status/header/body、V1/rollout nullable fields 完全匹配；Candidate OpenAPI 不自证。

### D-02 Production-browser V1 lifecycle — 2
- **前置**：production full stack。
- **操作**：可见控件创建 Flag/Revision、观察 compilation、activate、evaluate、diff/events。
- **可观察断言**：真实 HTTP/PostgreSQL/Worker，刷新持久；Evaluation trace/digest/state 与 snapshot 一致。

### D-03 Production-browser progressive lifecycle — 2
- **前置**：prior/candidate Snapshots 和 Manager FINAL。
- **操作**：UI 配 Steps、启动 rollout、对固定 subjects 评估、提交 outcomes、观察 pass/rollback/stale。
- **可观察断言**：exposure/counters/deadline/current step/terminal routing 可见且与 HTTP/snapshot 一致；legacy activation 仍可操作。

### D-04 Loading, empty, conflict, stale, offline and permission — 2
- **前置**：slow/offline/401/ACTIVE_CHANGED/ROLLOUT_STALE fixtures。
- **操作**：逐一触发并 retry。
- **可观察断言**：状态可见、有语义、可恢复；retry 不重复 activation/outcomes；ADMIN_TOKEN/digest private fixture 不泄露。

### D-05 Keyboard, labels, focus and mobile — 2
- **前置**：desktop/mobile Chromium。
- **操作**：键盘完成 V1/progressive primary flows，触发 validation/conflict。
- **可观察断言**：控件可达、有 label/name；错误 focus 合理；移动端无不可达 action；关键 contrast WCAG AA。

### D-06 Project-owned gates are not fake green — 2
- **前置**：clean database/build。
- **操作**：逐个公开 test command，外部观察 PostgreSQL/HTTP/Chromium/双 API/双 Worker/barrier。
- **可观察断言**：非 0 tests、失败不吞、不是字符串/文件检查；真实 digest、CAS、multi-process、SIGKILL 被执行。

### D-07 README-to-evidence closure — 3
- **前置**：固定 requirement ledger。
- **操作**：映射 `README → HTTP → OpenAPI → UI → snapshot/Work/Event → hidden evidence`。
- **可观察断言**：所有适用节点实际执行才 passing；SPEC-GAP 为 partial 且不计分；测试名/aggregate pass 不算闭环。

## 11. E — 迁移、性能与可运维性（10 分）

### E-01 Populated V1→FINAL migration — 2
- **前置**：真实 V1 binary 创建 ACTIVE/SUPERSEDED/READY/REJECTED 与 immutable Snapshots。
- **操作**：FINAL migration 后旧/新 API/snapshot 读取并重放 migration。
- **可观察断言**：existing active revisions/digests byte-identical、无 synthetic activation；旧 Evaluation 结果保持；
  只有新 progressive actions 出 rollout fields。

### E-02 Saved replay and event identity migration — 2
- **前置**：V1 evaluation/activation success/conflict/unknown saved responses 与 events。
- **操作**：迁移、重启 API/Dispatcher 后 replay。
- **可观察断言**：old status/body/digest/revision/eventId/body/sequence 不变；legacy response 不被 rollout fields 改写。

### E-03 Pending Compilation continuity — 2
- **前置**：V1 PENDING/LEASED FLAG_COMPILATION，captured active/schema，不同 attempt/lease；未 ACK events。
- **操作**：迁移并由 replacement Worker/Dispatcher 完成。
- **可观察断言**：captured data/Work/event identity exact 保留；正常 READY 或 stale REJECTED；stale token fenced；无 duplicate Snapshot。

### E-04 Evaluation/compilation sustained performance — 2
- **前置**：README perf-v1 精确 dataset、独占容器。
- **操作**：严格执行 `flag-evaluation` 与 `revision-compilation` 的 selector/request/64 clients/10s+60s。
- **可观察断言**：evaluation >=2000/s p95<=40ms 且无 mixed snapshot；compilation >=100 READY/s、queue p95<=2s；
  只统计通过独立 digest/evaluation oracle 的响应，5xx=0。

### E-05 Disjoint activation performance and operability — 2
- **前置**：精确 500 READY candidates/500 disjoint pairs 与 warm-up set。
- **操作**：64 clients、10s warmup、60s 内 activation；并发 evaluations；之后 cleanup/repro/log audit。
- **可观察断言**：恰 500 成功、无 conflicts/mixed/gaps/5xx、全部<=60s；post-load active/digest/Work/Event oracle 全过；
  无遗留进程/端口/锁，日志无秘密，同 seed 功能结果一致。

## 12. Hard Caps、invalid 与 evaluator_error

| Failure | Cap |
| --- | ---: |
| clean build/migration/production boot 失败 | 25 |
| 多 active pointer、错误 digest/evaluation、inactive/stale V1 可见或 atomic rejection 失败 | 35 |
| replay/unknown/restart 产生第二 effect/outcome | 30 |
| 四个已发布 V1 event transition 缺对应 event、rollback 有 event、retry 改 event | 40 |
| SIGKILL 后 Work 丢失或 stale Worker 可提交 | 40 |
| rollout mixed routing、重复 step transition、rollback 覆盖新 activation | 35 |
| migration 改 digest/replay/event/旧客户端 | 35 |
| 性能后核心不变量失败 | 性能 case 0，并应用 correctness cap |

读取 hidden/env、硬编码私有 fixture/seed/case、workspace 外访问、修改 evaluator、容器逃逸或伪造 evidence
为 `invalid`。Docker/PostgreSQL/Chromium/receiver/port 故障为 `evaluator_error`。watchdog 只保护 Evaluator，
不是 Coding Harness turn timeout，也不新增业务 deadline。

## 13. Anti-fake-green

1. digest/rule/bucket/failureBps/diff expected 全由独立 oracle；
2. Candidate tests/OpenAPI 不自证，只用于 D-06 gate 真实性；
3. 不把文件/route/test-name/log 声明当行为证据；
4. recovery 必须 barrier+signal+replacement，并发必须独立 processes；
5. performance 只统计完整且通过 semantic oracle 的响应，load 后复验 active/Work/Event/replay；
6. Evaluation 至少由 HTTP response 与 snapshot active/rollout resource 交叉验证；
7. SPEC-GAP 不通过 source inspection 偷补。

## 14. Requirement mapping

### 14.1 Compact contract-map

每个 Case 只在下表出现一次；该行列出的合同条款共同构成该 Case 的唯一 expected-value 来源，`SPEC-GAP`
仅限定不计分边界，不补写要求。

| Case range | 唯一 Public Contract 条款 |
| --- | --- |
| A-01～A-03 | README commands/env、migration、seed validation/atomicity |
| A-04～A-06 | README HTTP/OpenAPI/errors、pagination、verification snapshot |
| A-07～A-12 | README V1 Flag/Draft/Compilation/Snapshot/Evaluation/activation/diff/events |
| A-13～A-14 | FINAL Manager progressive rollout、deterministic routing、outcomes、rollback/compatibility |
| B-01～B-03 | README RFC8785 digest、rule/order/type/diff、percentage buckets；FINAL rollout bucket |
| B-04～B-05 | README durable idempotency replay、fingerprint、two-API same-key contention |
| B-06～B-07 | README active-pointer CAS、Compilation captured schema/active fencing |
| B-08～B-10 | FINAL Manager outcome atomicity/dedup、deadline precedence、activation-rollout races |
| C-01～C-06 | README Work lifecycle、barriers、lease recovery/fencing；FINAL obsolete deadline convergence |
| C-07～C-08 | README four V1 events、transactional outbox/dispatcher ordering；FINAL Manager event compatibility |
| D-01～D-07 | README OpenAPI/live traffic、production UI、accessibility、project tests/handoff；FINAL UI flows |
| E-01～E-03 | FINAL migration rules：V1 snapshots/active pointer、saved replay/events、pending Compilation |
| E-04～E-05 | README fixed perf-v1 workloads、correctness-under-load、operability |

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
| H-10 | A-13、A-14、B-08～B-10 |
| H-11 | C-02～C-08、D-03 |
| H-12 | E-04、E-05 |
| H-13 | D-06、D-07、E-05 |

## 15. Calibration mutants

| Mutant | 必须命中的 cases |
| --- | --- |
| 非 RFC8785 或排序 lists | A-08、B-01 |
| EQUALS case-insensitive / clauses OR | A-09、B-02 |
| percentage hash endian/modulo/`<=` 错误 | A-10、B-03 |
| rollout bucket 错误包含 digest | A-13、B-03 |
| process-local idempotency | B-04、B-05 |
| CAS 无数据库保护导致双 ACTIVE | A-11、B-06 |
| stale compilation 仍 READY/可 evaluate | A-08、B-07 |
| Outcome batch 逐 member 提交 | B-08 |
| duplicate outcome 重复计数 | A-14、B-08 |
| failureBps 浮点四舍五入 | A-14、B-09 |
| deadline 后 Outcome 先提交 | B-09 |
| immediate activation 后 rollout 仍推进/回滚 | B-10 |
| 无 Work fencing | C-02～C-05 |
| 四个已发布 V1 event 事务外或 retry 新 ID | A-12、C-07、C-08 |
| migration 重算 digest/改 replay | E-01、E-02 |
| OpenAPI 仅 paths 无 rollout schema | D-01 |
| UI/项目 tests 字符串假绿 | D-02、D-03、D-06 |
| 只报吞吐不验 mixed snapshot | E-04、E-05 |

Gold 全通过；每 mutant 被预期 cases 定向捕获且同 seed 三次一致。冻结 evaluator image、V1/FINAL binaries、
contract map、fixture generator、oracle、manifest 与性能分布后才可正式 A/B。

## 16. 实施顺序与完成标准

按 vertical slices：A-01/A-03/A-08 → B-01/B-03 → B-04/B-05 → C-02/C-05 → D-01/D-02 →
A-13/A-14/B-09 → E-01～E-03 → E-04/E-05 → 其余 cases/mutants；每 slice 先让定向 mutant 红，再让 gold 绿。

正式启用条件：44 个唯一 case、五维与总分精确、只走第 3 节 seams、SPEC-GAP 不计分、真实 V1 checkpoint、
gold/mutants/multi-seed calibration 完整；Baseline/Native/Guide 共用 frozen submission、seed、image、cases、
权重与阈值，Evaluator 不读取实验 arm、Skill Bank、Guide exposure 或 trajectory。
