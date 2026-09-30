# MergeBoard Harness-owned E2E / Concurrency / Recovery / Performance 方案

## 1. 边界与等级

本文件位于 candidate workspace 外，只定义 D1 黑盒评测方案。当前没有 runner、中央 score
manifest、gold 或 calibration 证据，不能声称 D3。Evaluator 只使用公开命令、HTTP、浏览器、
webhook receiver、文件下载和进程信号；不得 import 候选源码、ORM、表名或 'dist' 路径。

## 2. 固定环境

- Node.js 22、PostgreSQL 16、Chromium 和 Docker-compatible OCI；容器限制为 4 logical CPUs、
  8 GiB RAM，两个 API、两个 workers、一个 dispatcher 和 PostgreSQL 共享该限制；
- 每个 scenario 使用新数据库、新端口和独立 managed data directory；
- 两个 API、至少两个 Snapshot Task workers 和一个 dispatcher 共享同一 PostgreSQL；
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

- Create Documents and apply exact block insert, replace, move, and delete Changes with optimistic baseRevision.
- Deduplicate offline Changes by document, client, and Client Sequence across instances and restarts.
- Rebase non-overlapping Changes deterministically and persist explicit Conflicts for overlapping edits.
- Generate and verify Snapshots asynchronously while revision reads remain consistent through worker death.
- Expose editing, offline replay, revision history, diffs, conflicts, and event delivery in a real UI.

对每个成功状态同时检查响应、查询、历史、异步工作和事件。

### H-04 Atomic rejection and conservation

在每个公开失败边界生成合法但不可满足的请求，断言无 partial aggregate、任务、事件或守恒量
变化。核心断言：

1. Document revision numbers are contiguous and each applied Change creates exactly one next revision.
2. One client sequence maps to one semantic Change and stable response forever.
3. Replaying the same accepted Change cannot duplicate, lose, or reorder blocks.
4. A Snapshot digest equals the canonical state obtained by replaying its exact operation prefix.
5. A conflicted or rejected Change does not mutate head state or emit document.changed.

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

- Migrate every Document revision, Change, Conflict, Snapshot, event, and replay record to branch main without changing IDs or bodies.
- Pending Snapshot Tasks remain bound to the same revision prefix on main.
- Old clients can continue editing and reading main without branch fields in legacy responses.

### H-10 Manager core behavior

仅在 T16 已发布后按黑盒方式验证：

- A Document may have named Branches, each with its own contiguous head based on an immutable source revision.
- Changes target one Branch and preserve existing client sequence semantics within that Branch.
- A Merge Request captures source and target heads, computes a deterministic merge result, and records explicit conflicts.
- Approval requires 1-5 distinct Reviewers from a captured policy; simultaneous final approval creates one merge eligibility transition.
- Merge succeeds only if target head still matches the reviewed head and creates exactly one target revision; otherwise it becomes STALE.
- The V1 main history becomes branch main; legacy endpoints continue to imply main while new APIs expose branches[] and merge requests.

新增 wire schema 与接口同样属于断言面：

- Branch = {branchId:uuid,documentId:uuid,name:string,sourceBranchId:uuid|null,sourceRevision:int,headRevision:int,state:ACTIVE,createdAt:timestamp}; name matches [a-z][a-z0-9-]{0,31} and is unique per Document. A non-main Branch starts at local revision 0 whose blocks equal its immutable source revision
- MergeApproval = {approvalId:uuid,mergeRequestId:uuid,reviewerId:uuid,resultDigest:sha256,approvedAt:timestamp}; approvals are unique by mergeRequestId plus reviewerId and responses sort them by reviewerId
- MergeOperation = {sourceRevision:int,sourceOperationIndex:int,operation:Operation}; the pair is unique and arrays sort by sourceRevision then sourceOperationIndex
- MergeConflict = {sourceRevision:int,sourceOperationIndex:int,code:TARGET_MISSING|TARGET_CHANGED|ANCHOR_MISSING|BLOCK_ID_EXISTS|MOVE_BASE_CHANGED,path:string,baseValue:string|null,headValue:string|null}; the source pair identifies the failing MergeOperation
- MergeRequest = {mergeRequestId:uuid,documentId:uuid,sourceBranchId:uuid,targetBranchId:uuid,sourceHeadRevision:int,targetHeadRevision:int,state:CONFLICTED|IN_REVIEW|APPROVED|MERGED|STALE,reviewPolicy:{reviewerIds:[uuid],requiredApprovals:int},approvals:[MergeApproval],mergeOperations:[MergeOperation],conflicts:[MergeConflict],resultDigest:sha256|null,mergedTargetRevision:int|null,createdAt:timestamp,terminalAt:timestamp|null}
- Change adds branchId:uuid and its baseRevision, revision, and clientSequence are Branch-local; DocumentRevision adds branchId:uuid and mergeRequestId:uuid|null. Legacy endpoints imply main and retain V1 response bodies
- POST /api/v1/documents/:documentId/branches with {name,sourceBranchId,sourceRevision} returns 201 Branch after verifying the immutable source revision; GET /api/v1/documents/:documentId/branches returns main first then other Branches by name and branchId.
- POST /api/v1/documents/:documentId/branches/:branchId/changes uses V1 Change request and operation rules, scopes clientSequence by documentId,branchId,clientId, and creates exactly one next Branch-local revision.
- POST /api/v1/documents/:documentId/merge-requests with {sourceBranchId,targetBranchId,expectedSourceHeadRevision,expectedTargetHeadRevision,reviewPolicy:{reviewerIds,requiredApprovals}} requires targetBranchId equal the source Branch's immutable sourceBranchId and captures both heads.
- Merge Request creation wraps every canonical operation from source revisions 1 through sourceHeadRevision as MergeOperation, sorts by sourceRevision then sourceOperationIndex, and rebases them onto captured target using V1 preconditions. Failures become MergeConflict objects with the same source pair and sort order and state CONFLICTED; otherwise state is IN_REVIEW and resultDigest is the preview DocumentRevision digest.
- POST /api/v1/merge-requests/:mergeRequestId/approvals with {reviewerId} accepts only a captured Reviewer, stores at most one Approval per Reviewer for resultDigest, and returns MergeRequest. The request reaching requiredApprovals performs exactly one transition to APPROVED and emits one merge-request.approved event.
- POST /api/v1/merge-requests/:mergeRequestId/merge with {} succeeds only from APPROVED while current Branch heads equal captured heads; it creates targetHeadRevision+1 from stored preview blocks, leaves source unchanged, schedules one Snapshot Task, and emits document.changed followed by merge-request.merged.
- GET /api/v1/merge-requests/:mergeRequestId returns captured heads, policy, sorted approvals, operations, conflicts, digest, and merged revision; GET /api/v1/documents/:documentId/branches/:branchId/revisions/:revision returns the Branch-local DocumentRevision.
- 400 INVALID_REVIEW_POLICY: reviewerIds are empty, duplicated, or over 20, or requiredApprovals is outside 1..5 or exceeds reviewer count
- 400 MERGE_TARGET_NOT_SOURCE_BRANCH: targetBranchId is not the source Branch's immutable sourceBranchId
- 409 BRANCH_HEAD_CHANGED: an expected source or target head is stale when creating the Merge Request
- 409 REVIEWER_NOT_ELIGIBLE: reviewerId is not captured or the Merge Request is not reviewable
- 409 MERGE_REQUEST_CONFLICTED: approval or merge is attempted for a conflicted Merge Request
- 409 MERGE_REQUEST_NOT_APPROVED: merge is attempted before the approval threshold
- 409 MERGE_REQUEST_STALE: source or target head changed after review; state becomes STALE with no target revision
- The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
- The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
- Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
- Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

FINAL snapshot 与性能兼容断言：

The FINAL verification snapshot 'resources' object has exactly the union of these V1 and Manager resource specifications, with no other keys:

- 'documents' uses exact shape 'Document' and sorts ascending by scalar field-path tuple 'documentId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'documentRevisions' uses exact shape 'DocumentRevision' and sorts ascending by scalar field-path tuple 'documentId', 'revision', then by RFC 8785 canonical JSON as the tie-breaker.
- 'changes' uses exact shape 'Change' and sorts ascending by scalar field-path tuple 'documentId', 'changeId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'conflicts' uses exact shape 'Conflict' and sorts ascending by scalar field-path tuple 'changeId', 'operationIndex', 'conflictId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'documentSnapshots' uses exact shape 'DocumentSnapshot = {documentId:uuid,revision:int,canonicalDigest:sha256,createdAt:timestamp}' and sorts ascending by scalar field-path tuple 'documentId', 'revision', then by RFC 8785 canonical JSON as the tie-breaker.
- 'branches' uses exact shape 'Branch' and sorts ascending by scalar field-path tuple 'documentId', 'branchId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'mergeRequests' uses exact shape 'MergeRequest' and sorts ascending by scalar field-path tuple 'mergeRequestId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'branchDocumentSnapshots' uses exact shape 'BranchDocumentSnapshot = {documentId:uuid,branchId:uuid,revision:int,canonicalDigest:sha256,createdAt:timestamp}' and sorts ascending by scalar field-path tuple 'documentId', 'branchId', 'revision', then by RFC 8785 canonical JSON as the tie-breaker.

The Manager-added resource specifications are exactly:

- 'branches' uses exact shape 'Branch' and sorts ascending by scalar field-path tuple 'documentId', 'branchId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'mergeRequests' uses exact shape 'MergeRequest' and sorts ascending by scalar field-path tuple 'mergeRequestId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'branchDocumentSnapshots' uses exact shape 'BranchDocumentSnapshot = {documentId:uuid,branchId:uuid,revision:int,canonicalDigest:sha256,createdAt:timestamp}' and sorts ascending by scalar field-path tuple 'documentId', 'branchId', 'revision', then by RFC 8785 canonical JSON as the tie-breaker.

The FINAL Work kind enum is exactly the union 'SNAPSHOT_COMPACTION'. The Manager-added
Work kinds are exactly (none). All V1 snapshot point-in-time,
recursive '*Token' omission, sorting, Work state/lease/retention/drain, and Domain Event rules remain
mandatory. The FINAL binary reruns exactly these three V1-compatible scenarios:

- 'non-overlapping-change-apply': apply 300 non-overlapping Changes/s with p95 <= 250 ms; threshold: At least 300 successful Changes/s for 60 seconds and p95 <= 250 ms; conflicts, revision gaps, and unexpected 5xx are zero.
- 'document-revision-read': serve 400 revision reads/s with p95 <= 120 ms; threshold: At least 400 successful reads/s for 60 seconds and p95 <= 120 ms; digest mismatch and unexpected 5xx counts are zero.
- 'snapshot-compaction-recovery': compact 1,000,000 operations into verified Snapshots within 120 s after recovery; threshold: Compaction finishes in <= 120 seconds after replacement spawn with zero missing operation, digest mismatch, stale commit, or unexpected failure.

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
worker/dispatcher backlog 与排空时间。固定 dataset 为：seedVersion perf-v1 contains exactly 10,000 documents, 1,000,000 APPLIED changes with one operation each, and zero snapshots; exactly one pending Snapshot Task per Document covers all 1,000,000 operations.。三个场景是：

### Scenario 'non-overlapping-change-apply'

- Target: apply 300 non-overlapping Changes/s with p95 <= 250 ms
- Mode: 'http'
- Method: 'POST'
- Path: '/api/v1/documents/:documentId/changes'
- Setup: Use disjoint warm-up and measured Document sets, each with at least one dedicated Block. Keep at most one in-flight Change per Document.
- Selector: Round-robin documentId bytewise; clientSequence and baseRevision advance from the preceding successful response for that Document.
- Request: One REPLACE operation per Change targeting the dedicated block, with exact expectedText and a deterministic 64-ASCII-byte newText; use a fresh key.
- Concurrency: 64
- Warm-up seconds: 10
- Measure seconds: 60
- Success: Only 201 APPLIED responses count; each creates one gapless revision with the expected canonicalDigest and no Conflict.
- Threshold: At least 300 successful Changes/s for 60 seconds and p95 <= 250 ms; conflicts, revision gaps, and unexpected 5xx are zero.
- Timer: The throughput window starts with the first measured request after warm-up; each latency sample runs from request dispatch through the complete response body.

### Scenario 'document-revision-read'

- Target: serve 400 revision reads/s with p95 <= 120 ms
- Mode: 'http'
- Method: 'GET'
- Path: '/api/v1/documents/:documentId/revisions/:revision'
- Setup: Use all seeded DocumentRevision identities; reads do not trigger compaction.
- Selector: Round-robin documentId then revision in bytewise/numeric order.
- Request: No body or query parameters.
- Concurrency: 64
- Warm-up seconds: 10
- Measure seconds: 60
- Success: Only 200 responses whose Blocks recompute the published canonicalDigest and provenance count.
- Threshold: At least 400 successful reads/s for 60 seconds and p95 <= 120 ms; digest mismatch and unexpected 5xx counts are zero.
- Timer: The throughput window starts with the first measured request after warm-up; each latency sample runs from request dispatch through the complete response body.

### Scenario 'snapshot-compaction-recovery'

- Target: compact 1,000,000 operations into verified Snapshots within 120 s after recovery
- Mode: 'worker'
- Method: 'N/A'
- Path: 'work:SNAPSHOT_COMPACTION'
- Setup: Exactly 10,000 Documents have one pending compaction Work each, covering exactly 100 APPLIED one-operation Changes per Document and 1,000,000 operations total. Hold two workers at worker.claimed, SIGKILL, wait for lease expiry, then start two replacements.
- Selector: Compact by documentId and include Changes through the Work's captured revision without deleting operation history.
- Request: No measured client request is issued; setup uses only the published seed and public APIs before the worker timer starts.
- Concurrency: 2
- Warm-up seconds: 0
- Measure seconds: 120
- Success: Exactly 10,000 verified DocumentSnapshots cover all 1,000,000 operations, no Work remains nonterminal, replay equals each snapshot digest, and stale workers cannot publish.
- Threshold: Compaction finishes in <= 120 seconds after replacement spawn with zero missing operation, digest mismatch, stale commit, or unexpected failure.
- Timer: Start when both replacements spawn and stop only after snapshot files, database snapshot rows, and full replay verification prove every postcondition.

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
