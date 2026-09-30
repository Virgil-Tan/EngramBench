# MeterSettle Harness-owned E2E / Concurrency / Recovery / Performance 方案

## 1. 边界与等级

本文件位于 candidate workspace 外，只定义 D1 黑盒评测方案。当前没有 runner、中央 score
manifest、gold 或 calibration 证据，不能声称 D3。Evaluator 只使用公开命令、HTTP、浏览器、
webhook receiver、文件下载和进程信号；不得 import 候选源码、ORM、表名或 'dist' 路径。

## 2. 固定环境

- Node.js 22、PostgreSQL 16、Chromium 和 Docker-compatible OCI；容器限制为 4 logical CPUs、
  8 GiB RAM，两个 API、两个 workers、一个 dispatcher 和 PostgreSQL 共享该限制；
- 每个 scenario 使用新数据库、新端口和独立 managed data directory；
- 两个 API、至少两个 Rating Task workers 和一个 dispatcher 共享同一 PostgreSQL；
- command timeout 60 分钟，project timeout 24 小时；
- 合法随机输入和交错保存私有 seed，失败报告只公开脱敏后的断言与复现 ID。

## 3. Snapshot 与 barrier

T15 后冻结 'V1_SNAPSHOT'，T22 后冻结 'FINAL_SNAPSHOT'。H-09 先用 V1 binary/contract 写入
历史数据、pending work、event 和 idempotency replay，再切换到 FINAL migration。

- unknown HTTP outcome：response shield 收到完整 upstream response 后断开 candidate client；
- unknown webhook ACK：receiver 收到并持久化完整 request 后暂停 ACK，再 SIGKILL dispatcher；
- worker recovery：按公开 'TEST_BARRIER_URL' 协议在 'worker.claimed'、
  'worker.effect-complete' 或 'worker.before-commit' 收到完整 barrier body 后暂停，再 SIGKILL
  worker 并等待 'WORK_LEASE_SECONDS'；
- 不允许随机 sleep 推断 commit、claim、delivery 或 ACK 时点。

## 4. Hidden scenario design

### H-01 Clean install, migration, seed, build, and boot

从 fixture commit 开始执行公开命令；migration 重放；合法 seed、同 digest 重放、冲突版本和随机
非法成员；生产 API/UI/worker/dispatcher 全部启动。断言 OpenAPI 与 runtime 基础状态一致。

### H-02 Contract, validation, query, and browser baseline

随机 UUID、边界整数、未知字段、媒体类型、游标和时间；验证稳定错误、分页、排序、真实 React
页面、键盘路径、移动布局和 refresh 后状态。

### H-03 V1 successful main flow

通过公开 API 和浏览器完成：

- Ingest immutable Usage Events in atomic batches and deduplicate them by tenant plus eventId.
- Rate usage with the Rate Plan version effective at occurredAt using integer quantities and minor units.
- Advance a tenant Watermark and asynchronously finalize eligible Statements with recoverable Rating Tasks.
- Reject late events at or before a finalized Watermark without changing usage or totals.
- Expose usage timelines, Statement breakdowns, finalization progress, and Domain Event delivery in the UI.

对每个成功状态同时检查响应、查询、历史、异步工作和事件。

### H-04 Atomic rejection and conservation

在每个公开失败边界生成合法但不可满足的请求，断言无 partial aggregate、任务、事件或守恒量
变化。核心断言：

1. Each tenant eventId contributes to usage and charge totals at most once.
2. A Statement total equals the sum of its immutable rated line amounts in integer minor units.
3. The applied Rate Plan is the version effective at each Usage Event occurredAt, not ingestion time.
4. A Watermark never moves backward and no finalized Statement changes in V1.
5. Batch rejection leaves no Usage Event, Rating Task, Statement mutation, or Domain Event.

### H-05 Durable idempotency and unknown response

对每个 mutation 测试相同 key replay、语义冲突、20 路并发、response shield、API SIGKILL 和
重启。状态码与语义 JSON 保持原结果，且只出现一次业务效果和事件。

### H-06 Multi-process contention

两个 API 和两个 workers 对同一热点 authority 进行有 seed 的竞争；随机化合法请求数量和顺序，
最后通过公开查询重算全部不变量，不依赖数据库内部结构。

### H-07 Worker lease and terminal recovery

分别在 claim 后、外部工作后、commit 前 barrier SIGKILL worker；等待 'WORK_LEASE_SECONDS' 后
启动另一 worker，断言任务可恢复、stale token 失败、终态和副作用最多一次。

### H-08 Transactional outbox and unknown ACK

对成功和回滚业务检查 event existence；receiver 返回 500、断开连接、在完整 body 后暂停 ACK，
dispatcher 重启。重试保持 eventId/body，成功顺序递增，不能丢 event 或制造新身份。

### H-09 Populated V1 to FINAL migration

V1_SNAPSHOT 生成普通、边界、terminal、pending、leased、undelivered 和已保存 replay 数据。
FINAL migration 后逐项验证：

- Existing Statements become revision 1 without changing their JSON replay, line IDs, or events.
- Previously rejected late events remain rejected; only the new Correction endpoint can revise history.
- Pending Rating Tasks and tenant Watermarks survive migration exactly.

### H-10 Manager core behavior

仅在 T16 已发布后按黑盒方式验证：

- Accept Correction Events that reference one existing Usage Event and carry a signed replacement delta.
- A Correction Event is immutable and idempotent; the effective quantity may not become negative.
- The source Usage Event occurredAt selects the billing period and Rate Plan; CorrectionEvent.occurredAt is audit time only. Each correction uses the ratePlanVersion and unitPriceMinor selected for its source Usage Event under V1 rules, and deltaMinor equals quantityDelta times that unitPriceMinor.
- Correction ingestion locks each affected Statement. A correction committed before its base finalization commit updates that Statement normally; a correction committed after FINALIZED creates a numbered Statement Revision rather than mutating history.
- When the base Statement is not yet FINALIZED, its Rating Task computes each source event's effective quantity as UsageEvent.quantity plus every accepted CorrectionEvent.quantityDelta committed before the finalization lock. It writes one RatedLine for that source event with the effective quantity and recomputes totalQuantity and totalMinor from all lines; it creates no StatementRevision.
- One accepted correction batch creates at most one Revision per affected finalized Statement, grouping accepted correctionIds in ascending UTF-8 byte order. Correction batches serialize under the Statement lock; the base Statement has revision 1, the first StatementRevision has revision 2, and every later revision is exactly the prior persisted revision plus one. Duplicate corrections create no Revision.
- For each affected finalized Statement, deltaMinor is the exact safe-integer sum of quantityDelta times the source Usage Event unitPriceMinor for accepted corrections in that batch; priorTotalMinor is the prior revision effectiveTotalMinor or the base totalMinor for revision 2, and effectiveTotalMinor is priorTotalMinor plus deltaMinor. The new Revision starts FINALIZING and may become FINALIZED only after every lower revision is FINALIZED.
- A finalized Statement may have at most one FINALIZING StatementRevision. A batch touching one with a pending Revision is rejected atomically; effectiveTotalMinor remains the latest FINALIZED revision total, or base totalMinor when none is finalized.
- A correction batch contains 1..1000 members with unique correctionId values; quantityDelta is a non-zero safe integer. Validate every source, resulting effective quantity, multiplication, per-Statement delta, and effective total as safe integers before writing anything. Any invalid member, conflict, negative quantity, overflow, or pending Revision rejects the complete batch with no CorrectionEvent, Revision, task, Statement mutation, or event.
- Each Revision contains the prior total, delta, new total, and source correction IDs. Finalizing it emits exactly one statement.revision-finalized event.
- The legacy Statement response remains the original revision; new clients receive revisions[] and effectiveTotalMinor.

新增 wire schema 与接口同样属于断言面：

- CorrectionEvent = {correctionId:string,tenantId:uuid,sourceEventId:string,quantityDelta:int,reason:string,occurredAt:timestamp,ingestedAt:timestamp}
- StatementRevision = {statementRevisionId:uuid,statementId:uuid,revision:int,priorTotalMinor:int,deltaMinor:int,effectiveTotalMinor:int,correctionIds:[string],state:FINALIZING|FINALIZED,finalizedAt:timestamp|null}
- StatementDetail = {statement:Statement,revisions:[StatementRevision],effectiveTotalMinor:int,pendingRevision:int|null}; revisions sort by revision ascending, effectiveTotalMinor uses only the latest FINALIZED revision, and pendingRevision is the sole FINALIZING revision number or null
- POST /api/v1/correction-batches with {tenantId,corrections:[{correctionId,sourceEventId,quantityDelta,reason,occurredAt}]} atomically returns {batchId,acceptedCorrectionIds,duplicateCorrectionIds}
- GET /api/v1/statements/:statementId returns the exact StatementDetail; GET /api/v1/statements/:statementId/revisions/:revision returns one revision and its CorrectionEvents
- 409 CORRECTION_ID_CONFLICT: tenantId plus correctionId exists with different semantics
- 409 NEGATIVE_EFFECTIVE_USAGE: all accepted corrections for a source event would make effective quantity negative
- 409 STATEMENT_REVISION_PENDING: an affected finalized Statement already has a FINALIZING Revision
- 400 INVALID_CORRECTION_BATCH: batch cardinality, correction ID, delta, source, or duplicate member is invalid
- 400 CORRECTION_TOTAL_OVERFLOW: a corrected quantity, charge, Statement delta, or effective total is not a JSON safe integer
- The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
- The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
- Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
- Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

FINAL snapshot 与性能兼容断言：

The FINAL verification snapshot 'resources' object has exactly the union of these V1 and Manager resource specifications, with no other keys:

- 'tenantStates' uses exact shape 'TenantState = {tenantId:uuid,name:string,watermarkThrough:timestamp|null,openPeriodStarts:[timestamp],finalizedThrough:timestamp|null}' and sorts ascending by scalar field-path tuple 'tenantId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'meterDefinitions' uses exact shape 'MeterDefinition = {meterId:uuid,tenantId:uuid,name:string}' and sorts ascending by scalar field-path tuple 'meterId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'ratePlans' uses exact shape 'RatePlan = {tenantId:uuid,version:int,effectiveFrom:timestamp,effectiveTo:timestamp|null,unitPriceMinor:int}' and sorts ascending by scalar field-path tuple 'tenantId', 'version', then by RFC 8785 canonical JSON as the tie-breaker.
- 'usageEvents' uses exact shape 'UsageEvent' and sorts ascending by scalar field-path tuple 'tenantId', 'eventId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'usageBatches' uses exact shape 'UsageBatch' and sorts ascending by scalar field-path tuple 'batchId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'statements' uses exact shape 'Statement' and sorts ascending by scalar field-path tuple 'statementId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'correctionEvents' uses exact shape 'CorrectionEvent' and sorts ascending by scalar field-path tuple 'tenantId', 'correctionId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'statementRevisions' uses exact shape 'StatementRevision' and sorts ascending by scalar field-path tuple 'statementId', 'revision', then by RFC 8785 canonical JSON as the tie-breaker.

The Manager-added resource specifications are exactly:

- 'correctionEvents' uses exact shape 'CorrectionEvent' and sorts ascending by scalar field-path tuple 'tenantId', 'correctionId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'statementRevisions' uses exact shape 'StatementRevision' and sorts ascending by scalar field-path tuple 'statementId', 'revision', then by RFC 8785 canonical JSON as the tie-breaker.

The FINAL Work kind enum is exactly the union 'RATING'. The Manager-added
Work kinds are exactly (none). All V1 snapshot point-in-time,
recursive '*Token' omission, sorting, Work state/lease/retention/drain, and Domain Event rules remain
mandatory. The FINAL binary reruns exactly these three V1-compatible scenarios:

- 'usage-batch-ingest': ingest 1,000 Usage Events/s for 60 s with p95 <= 400 ms per 100-event batch; threshold: At least 10 successful batches/s (1,000 accepted Usage Events/s) for 60 seconds and batch p95 <= 400 ms; unexpected 5xx = 0.
- 'statement-read': serve 200 Statement reads/s with p95 <= 150 ms; threshold: At least 200 successful responses/s for 60 seconds and p95 <= 150 ms; unexpected 5xx = 0.
- 'rating-recovery': finalize 10,000 rated lines within 60 s after recovery; threshold: Recovery completes in <= 60 seconds with no duplicate line, gap, or unexpected worker failure.

Their published setup, selector, request, concurrency, warm-up, measurement, timer, success condition,
and threshold remain unchanged. This Manager change adds correctness, concurrency, and recovery
assertions only; it does not replace or relax a performance scenario.

同时验证每个失败分支整组回滚和重复请求一致。

### H-11 Manager UI, concurrency, and recovery

用 production Chromium 完成新旧流程；两个 API/worker 竞争 Manager 新基数或状态；在可观察
barrier 崩溃并恢复；检查 compatibility fields、聚合状态、成员状态、事件顺序和无重复效果。

### H-12 Sustained performance plus post-load correctness

严格对 FINAL binary 重跑 workspace README 的同三个 V1-compatible scenario，不得改变任何字段或
阈值；Manager 增量只增加 correctness、concurrency 和 recovery 断言。每个 scenario 使用独立新库，
严格执行公开 dataset、setup、selector、request、concurrency、warm-up、measurement、success、
threshold 和 timer，记录 p50/p95/p99、吞吐、成功 mutation、预期冲突、unexpected 5xx、
worker/dispatcher backlog 与排空时间。固定 dataset 为：seedVersion perf-v1 uses importedAt 2026-01-01T00:00:00.000Z and contains exactly 100 tenants, 10,000 meterDefinitions, 100 ratePlans, and 1,000,000 usageEvents; exactly 10,000 events are in closed unfinalized periods and all others are in open periods.。三个场景是：

### Scenario 'usage-batch-ingest'

- Target: ingest 1,000 Usage Events/s for 60 s with p95 <= 400 ms per 100-event batch
- Mode: 'http'
- Method: 'POST'
- Path: '/api/v1/usage-batches'
- Setup: Prepare 700 disjoint 100-event batches: 100 for warm-up and 600 for measurement. Events target existing meters in open periods and use unique deterministic eventIds.
- Selector: Round-robin tenants by tenantId and meters by meterId in bytewise order; one batch contains one tenant and exactly 100 consecutive IDs.
- Request: {tenantId,events:[{eventId,meterId,occurredAt,quantity:1} x100]}; measured eventId values have prefix perf-measured and warm-up values have prefix perf-warmup.
- Concurrency: 64
- Warm-up seconds: 10
- Measure seconds: 60
- Success: Only 202 responses accepting all 100 IDs count; duplicates and 409 responses do not count.
- Threshold: At least 10 successful batches/s (1,000 accepted Usage Events/s) for 60 seconds and batch p95 <= 400 ms; unexpected 5xx = 0.
- Timer: The throughput window starts with the first measured request after warm-up; each latency sample runs from request dispatch through the complete response body.

### Scenario 'statement-read'

- Target: serve 200 Statement reads/s with p95 <= 150 ms
- Mode: 'http'
- Method: 'GET'
- Path: '/api/v1/statements/:statementId'
- Setup: Before warm-up, advance Watermarks through the public API and wait until the 10,000 seeded closed-period events produce FINALIZED Statements; exclude setup time and do not mutate them during measurement.
- Selector: Round-robin statementId values in bytewise UUID order.
- Request: No body and no optional query parameters.
- Concurrency: 64
- Warm-up seconds: 10
- Measure seconds: 60
- Success: Only 200 responses whose lines sum to totalQuantity and totalMinor count.
- Threshold: At least 200 successful responses/s for 60 seconds and p95 <= 150 ms; unexpected 5xx = 0.
- Timer: The throughput window starts with the first measured request after warm-up; each latency sample runs from request dispatch through the complete response body.

### Scenario 'rating-recovery'

- Target: finalize 10,000 rated lines within 60 s after recovery
- Mode: 'worker'
- Method: 'N/A'
- Path: 'work:RATING'
- Setup: Advance the required tenant Watermarks through the public API so exactly 10,000 closed, previously unfinalized Usage Events are covered. Hold two Rating workers at worker.claimed, SIGKILL, wait for lease expiry, then start two replacements.
- Selector: Process eligible Statements by periodStart then statementId and retain every terminal Work record.
- Request: No measured client request is issued; setup uses only the published seed and public APIs before the worker timer starts.
- Concurrency: 2
- Warm-up seconds: 0
- Measure seconds: 60
- Success: Exactly 10,000 RatedLine members are committed once, every covered Statement is FINALIZED, no RATING Work remains nonterminal, and totals use the occurredAt Rate Plan.
- Threshold: Recovery completes in <= 60 seconds with no duplicate line, gap, or unexpected worker failure.
- Timer: Start when both replacement workers are spawned; stop on the first point-in-time verification snapshot proving all stated postconditions.

负载后重新执行 H-04 的全部不变量；任何不变量失败都使性能 assertion 失败。不得从旧的目标
摘要推断 workload，也不得把 Manager 增量改成第四个性能阈值。

### H-13 Project-owned gates and handoff truthfulness

从干净数据库逐个运行公开 test 命令，检查真实进程、真实 PostgreSQL、真实 Chromium、barrier
故障和 meaningful assertions；交叉核对最终回复所称命令、结果、性能、风险和未运行项。

## 5. 100 分映射

H-01 -> 5；H-02 -> 5；H-03 -> 10；H-04/H-05 -> 10；H-07/H-08 -> 15；
H-06 -> 10；H-09 -> 15；H-10/H-11 -> 10；H-13 tests -> 8；H-12 -> 7；
blind Judge explanation -> 2；evidence/handoff -> 3。最终 D3 必须把每个 assertion ID、唯一权重、
Checklist testGate 和 hard cap 写入一个 'score-manifest.v1.json'，不能重复计分。

## 6. Hard caps 与 invalid sample

- clean build、migration 或 production boot 失败：总分上限 25；
- 任一守恒、非负、唯一终态、at-most-once business effect 或 atomic rejection 不变量失败：上限 35；
- durable idempotency 在并发、未知响应或重启后产生第二效果：上限 30；
- 已提交业务缺 event、回滚业务有 event、event 重试改变身份/正文：上限 40；
- SIGKILL 后合法 pending work 永久丢失或 stale worker 可提交：上限 40；
- migration 丢历史数据、改变已保存 replay 或破坏旧客户端：上限 35；
- 性能后核心不变量失败：性能项 0 且应用相应 correctness cap。

读取 hidden assets、硬编码私有 fixture、访问 workspace 外路径或逃逸隔离标记为 invalid sample，
不是普通低分。

## 7. Calibration gate

实现 runner 后，先准备 gold 以及至少五个 mutants：process-local idempotency、非原子 event、
无 fencing lease、Manager partial migration、只测吞吐不验 invariant。相同 candidate/seed 至少
重复三次；所有 mutant 必须触发预期 assertion/cap，再冻结 image、fixture commit、README、
Manager、dialogue、score manifest、seed generator 和阈值。
