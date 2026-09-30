# MeterSettle 项目设计说明

## 1. 定位

MeterSettle 是一个从近空白 Git fixture 开始的高难度全栈 Coding Benchmark，主流程是
deduplicated usage ingestion and invoice settlement。这是 transfer task；正式 paired curriculum 为 `ledgerbridge` learning -> `metersettle` transfer。

本题只用一个主流程承载难度，重点测量：event deduplication、integer conservation、watermark finalization、late-arrival recovery、compatible revisions。领域词汇以
[CONTEXT.md](./CONTEXT.md) 为准。

## 2. 可见性

Codex 初始只能看到 'workspace/README.md'、'workspace/AGENTS.md' 和独立 fixture Git 历史。
Manager 变更、Checklist、对话状态机、评测方案和实验 metadata 都在 workspace 外，不能在
开发回合、Session Evolution 或盲审前复制或透露。

## 3. 完整 V1

- Ingest immutable Usage Events in atomic batches and deduplicate them by tenant plus eventId.
- Rate usage with the Rate Plan version effective at occurredAt using integer quantities and minor units.
- Advance a tenant Watermark and asynchronously finalize eligible Statements with recoverable Rating Tasks.
- Reject late events at or before a finalized Watermark without changing usage or totals.
- Expose usage timelines, Statement breakdowns, finalization progress, and Domain Event delivery in the UI.

核心状态：Statement: OPEN -> FINALIZING -> FINALIZED; finalized V1 Statements are immutable.

### 可计算不变量

1. Each tenant eventId contributes to usage and charge totals at most once.
2. A Statement total equals the sum of its immutable rated line amounts in integer minor units.
3. The applied Rate Plan is the version effective at each Usage Event occurredAt, not ingestion time.
4. A Watermark never moves backward and no finalized Statement changes in V1.
5. Batch rejection leaves no Usage Event, Rating Task, Statement mutation, or Domain Event.

## 4. Manager 固定变更

V1、真实 Browser E2E、双 API/双 Worker 并发与恢复完成后，T16 才发布
“retroactive usage corrections and statement revisions”。它改变核心基数、状态或一致性边界：

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

新增 wire schema：

- CorrectionEvent = {correctionId:string,tenantId:uuid,sourceEventId:string,quantityDelta:int,reason:string,occurredAt:timestamp,ingestedAt:timestamp}
- StatementRevision = {statementRevisionId:uuid,statementId:uuid,revision:int,priorTotalMinor:int,deltaMinor:int,effectiveTotalMinor:int,correctionIds:[string],state:FINALIZING|FINALIZED,finalizedAt:timestamp|null}
- StatementDetail = {statement:Statement,revisions:[StatementRevision],effectiveTotalMinor:int,pendingRevision:int|null}; revisions sort by revision ascending, effectiveTotalMinor uses only the latest FINALIZED revision, and pendingRevision is the sole FINALIZING revision number or null

新增或变更的公开接口：

- POST /api/v1/correction-batches with {tenantId,corrections:[{correctionId,sourceEventId,quantityDelta,reason,occurredAt}]} atomically returns {batchId,acceptedCorrectionIds,duplicateCorrectionIds}
- GET /api/v1/statements/:statementId returns the exact StatementDetail; GET /api/v1/statements/:statementId/revisions/:revision returns one revision and its CorrectionEvents

新增稳定错误：

- 409 CORRECTION_ID_CONFLICT: tenantId plus correctionId exists with different semantics
- 409 NEGATIVE_EFFECTIVE_USAGE: all accepted corrections for a source event would make effective quantity negative
- 409 STATEMENT_REVISION_PENDING: an affected finalized Statement already has a FINALIZING Revision
- 400 INVALID_CORRECTION_BATCH: batch cardinality, correction ID, delta, source, or duplicate member is invalid
- 400 CORRECTION_TOTAL_OVERFLOW: a corrected quantity, charge, Statement delta, or effective total is not a JSON safe integer

跨层规则：

- The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
- The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
- Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
- Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

FINAL snapshot 与性能兼容合同：

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

迁移必须同时满足：

- Existing Statements become revision 1 without changing their JSON replay, line IDs, or events.
- Previously rejected late events remain rejected; only the new Correction endpoint can revise history.
- Pending Rating Tasks and tenant Watermarks survive migration exactly.

T16 只要求影响分析和分阶段修改计划，不允许立即实现。T17-T20 才依次处理迁移、后端、
API、UI、并发和恢复回归。

## 5. 评分结构

| Dimension | Weight |
| --- | ---: |
| Clean build, migration, seed, and operation | 5 |
| Contract, validation, and seed semantics | 5 |
| Complete V1 main flow | 10 |
| Atomicity and durable idempotency | 10 |
| Worker, outbox, and crash recovery | 15 |
| Multi-process consistency | 10 |
| Manager-compatible migration | 15 |
| Manager runtime, UI, and concurrency | 10 |
| Project-owned real tests | 8 |
| Sustained performance plus post-load correctness | 7 |
| Persona-fit explanation | 2 |
| Evidence and handoff | 3 |
| **Total** | **100** |

普通 CRUD 和页面数量不构成主要分值。并发、恢复、幂等、兼容迁移和负载后不变量失败会
触发对应高权重项失分；正式 hard cap 方案见 evaluator 文档。

## 6. 当前完成度

当前为 **D1 设计完成**：公开合同、固定 Manager 正文、22 阶段 Dialogue、100 分 Checklist、
环境设计、独立 fixture commit 和 H-01 至 H-13 黑盒方案已完成。当前**没有 hidden runner**、
'score-manifest.v1.json'、gold、mutant、逐题 project smoke 或 baseline，因此不能声称 D2/D3/D4/D5，
也不能把候选项目自己的 'test:all' 当作正式得分。

## 7. D2 以后仍需完成

- 验证共享 environment profile，并完成当前 task 的真实 project smoke；
- 实现 Harness-owned H-01 至 H-13 runner、中央 score manifest 和 Checklist 'testGates'；
- 冻结 V1/FINAL 双快照并接线 paired scripted curriculum；
- 用 gold、定向 mutants、重复 Control baseline 和 flake run 校准阈值。
