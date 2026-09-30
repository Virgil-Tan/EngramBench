# MeterSettle 多轮用户与 Manager Prompt 协议

## 可见性

本文件只属于 Benchmark Harness，不得复制进 workspace、传给 Codex、Session Evolution 或
盲审 Judge。DS 只根据 workspace 的公开合同、可见对话和当前 scene 推进。

## DS system role

你是一名使用 Codex 完成 MeterSettle 的交付负责人。每轮只提出一个主要目标，用自然简短的中文推进真实开发。可以询问模块职责、接口、状态、数据流、设计取舍和实际验证证据，但绝不能提供代码、伪代码、SQL、命令、补丁、文件或函数定位、表结构、锁、事务、索引、缓存、队列、算法、性能方案、日志分析、Debug 根因或修复提示。Codex 报告失败时只要求其自行定位、修复并重新验证。只使用 README、AGENTS 和已经出现在可见对话中的 Manager 变更，不透露未来阶段或私有评测。

DS 每轮只能返回一个主要用户目标。不能写代码、SQL、命令、补丁、伪代码、文件/函数定位、
表结构、锁、事务、索引、缓存、队列、算法、性能方案或 Debug 提示。它不能透露 Checklist、
权重、hidden scenario、未来 Manager 需求、Control/Treatment 标签或 Frontal 状态。

## 状态协议

- scenes 严格按 T01 到 T22；DS 根据可见证据自行决定重复当前 scene 或前进一格；
- advanceGate 只提供判断依据，Harness 不执行中途硬 Gate；失败时只要求 Codex 自行定位、修复并重新验证；
- T16 第一次访问时由 Harness 原样注入 fixedMessage，后续访问由 DS 自然跟进；
- T16 之前不能出现 Manager-only requirement 或其可识别业务规则；
- 整个 Session 唯一的自动截止条件是 'hardMaxTurns = 60'；达到上限后直接结束，不强制推进 scene；
- 'safeMessage' 只用于 provider 失败后的已审核 fallback，不能据此强制推进。

## Scene map

| Scene | Title | Advance guidance |
| --- | --- | --- |
| T01 | Initial plan | A coherent plan covers deliverables, dependencies, risks, and verification without repository edits. |
| T02 | Module and process ownership | The response defines module dependencies, process boundaries, authority, and responsibilities that stay separate. |
| T03 | Success and failure flows | Both flows identify atomic effects, forbidden records, replay behavior, and visible outcomes. |
| T04 | Public contract first | Canonical public contracts cover every published input, output, state, error, command, and asynchronous result. |
| T05 | Test strategy | The strategy distinguishes unit, real integration, browser, multi-process, recovery, aggregate, and performance evidence. |
| T06 | Runnable skeleton | All public processes start with documented commands, expose health, and stop cleanly. |
| T07 | Migration and seed | Migrations replay safely; valid, replayed, conflicting, and invalid seeds have exact atomic outcomes. |
| T08 | Read model and UI data | Queries, cursors, ordering, states, and UI data come from real PostgreSQL through HTTP. |
| T09 | Atomic V1 mutation | Success, atomic rejection, replay, conflict, and concurrent requests preserve every V1 invariant. |
| T10 | Worker lifecycle and terminal races | Leases recover; stale ownership cannot commit; each effect and terminal state occurs at most once. |
| T11 | Transactional outbox and backend review | Events commit with state, retries preserve identity/body/order, dispatcher recovery passes, and concrete review findings are fixed. |
| T12 | Complete real frontend | The UI completes all V1 flows through visible controls and real API data with correct asynchronous and error states. |
| T13 | Real integration suite | Integration tests cover contract, seed, V1 state, idempotency, worker, outbox, and cleanup and pass repeatably. |
| T14 | Production browser E2E | Project-owned browser tests cover public V1 flows and asynchronous states and pass under one command. |
| T15 | Multi-process recovery and V1 review | Controlled races and crashes preserve all V1 invariants with no unresolved finding. |
| T16 | Harness-owned Manager change | Codex explains domain, schema, migration, API, worker, event, UI, compatibility, concurrency, recovery, and performance impact and gives a staged plan without implementing. |
| T17 | Compatible migration and backend | Populated V1 data and replay remain valid; changed domain/state/worker behavior passes focused tests. |
| T18 | Changed API and integration | New and old contracts agree; migration and replay evidence hold; real HTTP integration passes. |
| T19 | Changed frontend | The UI exposes changed and compatible flows, aggregate/member states, history, errors, accessibility, and responsive behavior. |
| T20 | Changed browser, concurrency, and recovery | Changed browser and crash races are automated and pass without compatibility or invariant failures. |
| T21 | Sustained performance and full regression | Evidence reports environment, scale, duration, throughput, errors, latency, drain, invariants, targets, and passing full regression. |
| T22 | Final review and handoff | No material finding remains; all required gates pass; documentation and handoff accurately state architecture, operation, compatibility, evidence, risks, and unrun checks. |

## Fixed Manager message

<!-- FIXED_MANAGER_MESSAGE_START -->
【Product Manager · Maya】

V1 已完成并通过基础验收。本期正式增加“retroactive usage corrections and statement revisions”。以下业务规则、wire schema、接口和错误全部是公开增量合同。

业务规则：

1. Accept Correction Events that reference one existing Usage Event and carry a signed replacement delta.
2. A Correction Event is immutable and idempotent; the effective quantity may not become negative.
3. The source Usage Event occurredAt selects the billing period and Rate Plan; CorrectionEvent.occurredAt is audit time only. Each correction uses the ratePlanVersion and unitPriceMinor selected for its source Usage Event under V1 rules, and deltaMinor equals quantityDelta times that unitPriceMinor.
4. Correction ingestion locks each affected Statement. A correction committed before its base finalization commit updates that Statement normally; a correction committed after FINALIZED creates a numbered Statement Revision rather than mutating history.
5. When the base Statement is not yet FINALIZED, its Rating Task computes each source event's effective quantity as UsageEvent.quantity plus every accepted CorrectionEvent.quantityDelta committed before the finalization lock. It writes one RatedLine for that source event with the effective quantity and recomputes totalQuantity and totalMinor from all lines; it creates no StatementRevision.
6. One accepted correction batch creates at most one Revision per affected finalized Statement, grouping accepted correctionIds in ascending UTF-8 byte order. Correction batches serialize under the Statement lock; the base Statement has revision 1, the first StatementRevision has revision 2, and every later revision is exactly the prior persisted revision plus one. Duplicate corrections create no Revision.
7. For each affected finalized Statement, deltaMinor is the exact safe-integer sum of quantityDelta times the source Usage Event unitPriceMinor for accepted corrections in that batch; priorTotalMinor is the prior revision effectiveTotalMinor or the base totalMinor for revision 2, and effectiveTotalMinor is priorTotalMinor plus deltaMinor. The new Revision starts FINALIZING and may become FINALIZED only after every lower revision is FINALIZED.
8. A finalized Statement may have at most one FINALIZING StatementRevision. A batch touching one with a pending Revision is rejected atomically; effectiveTotalMinor remains the latest FINALIZED revision total, or base totalMinor when none is finalized.
9. A correction batch contains 1..1000 members with unique correctionId values; quantityDelta is a non-zero safe integer. Validate every source, resulting effective quantity, multiplication, per-Statement delta, and effective total as safe integers before writing anything. Any invalid member, conflict, negative quantity, overflow, or pending Revision rejects the complete batch with no CorrectionEvent, Revision, task, Statement mutation, or event.
10. Each Revision contains the prior total, delta, new total, and source correction IDs. Finalizing it emits exactly one statement.revision-finalized event.
11. The legacy Statement response remains the original revision; new clients receive revisions[] and effectiveTotalMinor.
12. Existing Statements become revision 1 without changing their JSON replay, line IDs, or events.
13. Previously rejected late events remain rejected; only the new Correction endpoint can revise history.
14. Pending Rating Tasks and tenant Watermarks survive migration exactly.
15. The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
16. The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
17. Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
18. Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

新增 wire schema：

- CorrectionEvent = {correctionId:string,tenantId:uuid,sourceEventId:string,quantityDelta:int,reason:string,occurredAt:timestamp,ingestedAt:timestamp}
- StatementRevision = {statementRevisionId:uuid,statementId:uuid,revision:int,priorTotalMinor:int,deltaMinor:int,effectiveTotalMinor:int,correctionIds:[string],state:FINALIZING|FINALIZED,finalizedAt:timestamp|null}
- StatementDetail = {statement:Statement,revisions:[StatementRevision],effectiveTotalMinor:int,pendingRevision:int|null}; revisions sort by revision ascending, effectiveTotalMinor uses only the latest FINALIZED revision, and pendingRevision is the sole FINALIZING revision number or null

新增或变更接口：

- POST /api/v1/correction-batches with {tenantId,corrections:[{correctionId,sourceEventId,quantityDelta,reason,occurredAt}]} atomically returns {batchId,acceptedCorrectionIds,duplicateCorrectionIds}
- GET /api/v1/statements/:statementId returns the exact StatementDetail; GET /api/v1/statements/:statementId/revisions/:revision returns one revision and its CorrectionEvents

新增稳定错误：

- 409 CORRECTION_ID_CONFLICT: tenantId plus correctionId exists with different semantics
- 409 NEGATIVE_EFFECTIVE_USAGE: all accepted corrections for a source event would make effective quantity negative
- 409 STATEMENT_REVISION_PENDING: an affected finalized Statement already has a FINALIZING Revision
- 400 INVALID_CORRECTION_BATCH: batch cardinality, correction ID, delta, source, or duplicate member is invalid
- 400 CORRECTION_TOTAL_OVERFLOW: a corrected quantity, charge, Statement delta, or effective total is not a JSON safe integer

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

本轮先不要实现。请先说明它会影响哪些领域关系、模块、schema、migration、接口、状态、成功与失败数据流、兼容性、Worker、事件、前端、并发、恢复和性能测试，然后给出分阶段修改计划。
<!-- FIXED_MANAGER_MESSAGE_END -->

两份正文的唯一来源是 task generator；'dialogue-script.json' 的 'fixedMessage' 必须逐字相同。
T16 只做影响分析和计划，不能把“已开始实现”视为通过。

## Decision output

DS 决策输出必须是一个 JSON object：

~~~json
{"decision":"continue|accept|abort","sceneId":"T01","message":"one user message","state":{"turn":1,"lastScene":"T01","visits":{"T01":1}}}
~~~

只有 T22 advanceGate 已满足、'minimumTurns' 已达到且当前没有未解决失败时才能 'accept'。
达到 hard limit、公开合同不可完成或隔离被破坏时才能 'abort'。
