# ReconcileHub Harness-owned E2E / Concurrency / Recovery / Performance 方案

## 1. 边界与等级

本文件位于 candidate workspace 外，只定义 D1 黑盒评测方案。当前没有 runner、中央 score
manifest、gold 或 calibration 证据，不能声称 D3。Evaluator 只使用公开命令、HTTP、浏览器、
webhook receiver、文件下载和进程信号；不得 import 候选源码、ORM、表名或 'dist' 路径。

## 2. 固定环境

- Node.js 22、PostgreSQL 16、Chromium 和 Docker-compatible OCI；容器限制为 4 logical CPUs、
  8 GiB RAM，两个 API、两个 workers、一个 dispatcher 和 PostgreSQL 共享该限制；
- 每个 scenario 使用新数据库、新端口和独立 managed data directory；
- 两个 API、至少两个 Suggestion Task workers 和一个 dispatcher 共享同一 PostgreSQL；
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

- Import deterministic Statement Batches atomically with durable file digest replay.
- Generate deterministic one-to-one Match suggestions using only published exact rules.
- Confirm, reject, ignore, or reverse decisions with safe races across two API instances.
- Keep immutable amount, decision, and audit histories with Domain Event delivery.
- Expose batch status, unmatched work queues, side-by-side review, and reconciliation totals in the UI.

对每个成功状态同时检查响应、查询、历史、异步工作和事件。

### H-04 Atomic rejection and conservation

在每个公开失败边界生成合法但不可满足的请求，断言无 partial aggregate、任务、事件或守恒量
变化。核心断言：

1. A confirmed Statement Line belongs to at most one active Match.
2. A confirmed Ledger Entry belongs to at most one active Match.
3. Every confirmed V1 Match has equal currency and amount on both sides.
4. Batch import is all-or-nothing and same digest replays the same IDs and response.
5. Reversal restores both sides exactly once and never deletes audit history.

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

- Migrate every V1 Match to a two-member Match Group whose matchGroupId equals the existing matchId, without changing decisions, audit entries, events, or replay JSON.
- Pending Suggestion Tasks continue against their captured eligible set.
- Historical ignored and reversed lines retain their exact state.

### H-10 Manager core behavior

仅在 T16 已发布后按黑盒方式验证：

- A Match Group may contain 1-20 Statement Lines and 1-20 Ledger Entries in one currency.
- The sum of Statement Line amounts must equal the sum of Ledger Entry amounts before confirmation.
- Every member is reserved and confirmed atomically; any already-active member rejects the whole group.
- Reversal releases the complete Match Group; partial reversal is not supported.
- Suggestions enumerate groups with at most four total members, order each side by date then ID, order combinations lexicographically by member IDs, and choose the first equal-currency equal-sum group after one-to-one candidates.
- Legacy one-to-one Match fields remain populated for groups with one member on each side and are null otherwise.

新增 wire schema 与接口同样属于断言面：

- MatchGroup = {matchGroupId:uuid,matchId:uuid|null,statementLineId:uuid|null,ledgerEntryId:uuid|null,statementLineIds:[uuid],ledgerEntryIds:[uuid],currency:currency,statementTotalMinor:int,ledgerTotalMinor:int,state:PROPOSED|CONFIRMED|REJECTED|REVERSED,createdAt:timestamp,confirmedAt:timestamp|null,reversedAt:timestamp|null,sequence:int}; a one-to-one group has matchId equal to matchGroupId and both singular member IDs populated, while a many-member group requires all three legacy singular fields to be null
- POST /api/v1/match-groups with {statementLineIds:[uuid],ledgerEntryIds:[uuid]} returns 201 PROPOSED after sorting IDs and validating 1..20 members per side
- POST /api/v1/match-groups/:matchGroupId/confirm with {expectedStatementLineRevisions:{statementLineId:int},expectedLedgerEntryRevisions:{ledgerEntryId:int}} atomically confirms every member; the two maps are keyed by the UUIDs of exactly the group's Statement Lines and Ledger Entries, with no missing or extra keys; /reverse with {reason} reverses all
- GET /api/v1/match-groups/:matchGroupId returns exact MatchGroup. GET /api/v1/matches/:matchId is retained only for a group of exactly one member per side, resolves matchId equal to matchGroupId, and returns the exact legacy Match shape with statementLineId and ledgerEntryId rather than MatchGroup
- 409 MATCH_GROUP_IMBALANCED: currency differs or statement and ledger sums are unequal
- 409 MATCH_GROUP_MEMBER_CONFLICT: any member revision changed or belongs to another active group
- The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
- The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
- Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
- Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

FINAL snapshot 与性能兼容断言：

The FINAL verification snapshot 'resources' object has exactly the union of these V1 and Manager resource specifications, with no other keys:

- 'statementBatches' uses exact shape 'StatementBatch' and sorts ascending by scalar field-path tuple 'batchId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'statementLines' uses exact shape 'StatementLine' and sorts ascending by scalar field-path tuple 'statementLineId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'ledgerEntries' uses exact shape 'LedgerEntry' and sorts ascending by scalar field-path tuple 'ledgerEntryId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'matches' uses exact shape 'Match' and sorts ascending by scalar field-path tuple 'matchId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'matchGroups' uses exact shape 'MatchGroup' and sorts ascending by scalar field-path tuple 'matchGroupId', then by RFC 8785 canonical JSON as the tie-breaker.

The Manager-added resource specifications are exactly:

- 'matchGroups' uses exact shape 'MatchGroup' and sorts ascending by scalar field-path tuple 'matchGroupId', then by RFC 8785 canonical JSON as the tie-breaker.

The FINAL Work kind enum is exactly the union 'MATCH_SUGGESTION'. The Manager-added
Work kinds are exactly (none). All V1 snapshot point-in-time,
recursive '*Token' omission, sorting, Work state/lease/retention/drain, and Domain Event rules remain
mandatory. The FINAL binary reruns exactly these three V1-compatible scenarios:

- 'statement-batch-import': import 50 batches/s of 100 lines with p95 <= 500 ms; threshold: At least 50 successful batches/s for 60 seconds and p95 <= 500 ms; partial imports and unexpected 5xx are zero.
- 'reconciliation-review': serve 250 review queries/s with p95 <= 180 ms; threshold: At least 250 successful review reads/s for 60 seconds and p95 <= 180 ms; unexpected 5xx = 0.
- 'suggestion-generation': generate suggestions for 20,000 unmatched records within 60 s; threshold: The complete 20,000-record input is processed in <= 60 seconds with zero member reuse or unexpected failure.

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
worker/dispatcher backlog 与排空时间。固定 dataset 为：seedVersion perf-v1 contains exactly 20,000 ledgerEntries, 200 statementBatches with exactly 100 Lines each, and 10,000 CONFIRMED matches, leaving exactly 10,000 unmatched Ledger Entries and 10,000 unmatched Statement Lines. Each unmatched Statement Line has exactly one unmatched Ledger Entry with equal currency and amount within three days, and no cross-pair satisfies those candidate rules, yielding exactly 10,000 one-to-one suggestions.。三个场景是：

### Scenario 'statement-batch-import'

- Target: import 50 batches/s of 100 lines with p95 <= 500 ms
- Mode: 'http'
- Method: 'POST'
- Path: '/api/v1/statement-batches'
- Setup: Prepare 3,500 disjoint 100-line batches: 500 for warm-up and 3,000 for measurement, with unique source,batchKey and externalId values.
- Selector: Batch ordinal determines source and batchKey; lines sort by bookedAt,externalId and alternate USD/EUR with non-zero amountMinor.
- Request: {source,batchKey,lines:[{externalId,bookedAt,currency,amountMinor,reference} x100]}; every request has a fresh key.
- Concurrency: 64
- Warm-up seconds: 10
- Measure seconds: 60
- Success: Only successful atomic imports with exactly 100 new Statement Lines count; duplicates or conflicts do not count.
- Threshold: At least 50 successful batches/s for 60 seconds and p95 <= 500 ms; partial imports and unexpected 5xx are zero.
- Timer: The throughput window starts with the first measured request after warm-up; each latency sample runs from request dispatch through the complete response body.

### Scenario 'reconciliation-review'

- Target: serve 250 review queries/s with p95 <= 180 ms
- Mode: 'http'
- Method: 'GET'
- Path: '/api/v1/reconciliation-work?state=UNMATCHED&limit=100'
- Setup: Use the unchanged perf-v1 unmatched set; omit cursor so every request reads the stable first page.
- Selector: No ID selection; all clients issue the exact same read-only query.
- Request: No body.
- Concurrency: 64
- Warm-up seconds: 10
- Measure seconds: 60
- Success: Only 200 responses whose lines, entries, suggestions, and nextCursor obey the published deterministic order count.
- Threshold: At least 250 successful review reads/s for 60 seconds and p95 <= 180 ms; unexpected 5xx = 0.
- Timer: The throughput window starts with the first measured request after warm-up; each latency sample runs from request dispatch through the complete response body.

### Scenario 'suggestion-generation'

- Target: generate suggestions for 20,000 unmatched records within 60 s
- Mode: 'worker'
- Method: 'N/A'
- Path: 'work:MATCH_SUGGESTION'
- Setup: Use exactly 10,000 unmatched Statement Lines and 10,000 unmatched Ledger Entries and start two workers; no preexisting PROPOSED Match uses these members.
- Selector: Use the published Statement Line order and candidate rank; one snapshot cannot reuse a member.
- Request: No measured client request is issued; setup uses only the published seed and public APIs before the worker timer starts.
- Concurrency: 2
- Warm-up seconds: 0
- Measure seconds: 60
- Success: Exactly 10,000 PROPOSED Matches cover the 20,000 input records one-to-one, no MATCH_SUGGESTION Work remains nonterminal, and confirmed history is unchanged.
- Threshold: The complete 20,000-record input is processed in <= 60 seconds with zero member reuse or unexpected failure.
- Timer: Start when both workers spawn and stop on the first verification snapshot proving the exact proposal count, coverage, and drained Work.

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
