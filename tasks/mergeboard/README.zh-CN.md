# MergeBoard 项目设计说明

## 1. 定位

MergeBoard 是一个从近空白 Git fixture 开始的高难度全栈 Coding Benchmark，主流程是
revisioned collaborative document changes and merges。这是 learning task，用于形成可迁移的工程经验。

本题只用一个主流程承载难度，重点测量：optimistic concurrency、operation replay、conflict determinism、snapshot recovery、branch migration。领域词汇以
[CONTEXT.md](./CONTEXT.md) 为准。

## 2. 可见性

Codex 初始只能看到 'workspace/README.md'、'workspace/AGENTS.md' 和独立 fixture Git 历史。
Manager 变更、Checklist、对话状态机、评测方案和实验 metadata 都在 workspace 外，不能在
开发回合、Session Evolution 或盲审前复制或透露。

## 3. 完整 V1

- Create Documents and apply exact block insert, replace, move, and delete Changes with optimistic baseRevision.
- Deduplicate offline Changes by document, client, and Client Sequence across instances and restarts.
- Rebase non-overlapping Changes deterministically and persist explicit Conflicts for overlapping edits.
- Generate and verify Snapshots asynchronously while revision reads remain consistent through worker death.
- Expose editing, offline replay, revision history, diffs, conflicts, and event delivery in a real UI.

核心状态：Change: PENDING -> APPLIED | CONFLICTED | REJECTED; Document revisions are immutable and strictly increasing.

### 可计算不变量

1. Document revision numbers are contiguous and each applied Change creates exactly one next revision.
2. One client sequence maps to one semantic Change and stable response forever.
3. Replaying the same accepted Change cannot duplicate, lose, or reorder blocks.
4. A Snapshot digest equals the canonical state obtained by replaying its exact operation prefix.
5. A conflicted or rejected Change does not mutate head state or emit document.changed.

## 4. Manager 固定变更

V1、真实 Browser E2E、双 API/双 Worker 并发与恢复完成后，T16 才发布
“branches and review-gated merges”。它改变核心基数、状态或一致性边界：

- A Document may have named Branches, each with its own contiguous head based on an immutable source revision.
- Changes target one Branch and preserve existing client sequence semantics within that Branch.
- A Merge Request captures source and target heads, computes a deterministic merge result, and records explicit conflicts.
- Approval requires 1-5 distinct Reviewers from a captured policy; simultaneous final approval creates one merge eligibility transition.
- Merge succeeds only if target head still matches the reviewed head and creates exactly one target revision; otherwise it becomes STALE.
- The V1 main history becomes branch main; legacy endpoints continue to imply main while new APIs expose branches[] and merge requests.

新增 wire schema：

- Branch = {branchId:uuid,documentId:uuid,name:string,sourceBranchId:uuid|null,sourceRevision:int,headRevision:int,state:ACTIVE,createdAt:timestamp}; name matches [a-z][a-z0-9-]{0,31} and is unique per Document. A non-main Branch starts at local revision 0 whose blocks equal its immutable source revision
- MergeApproval = {approvalId:uuid,mergeRequestId:uuid,reviewerId:uuid,resultDigest:sha256,approvedAt:timestamp}; approvals are unique by mergeRequestId plus reviewerId and responses sort them by reviewerId
- MergeOperation = {sourceRevision:int,sourceOperationIndex:int,operation:Operation}; the pair is unique and arrays sort by sourceRevision then sourceOperationIndex
- MergeConflict = {sourceRevision:int,sourceOperationIndex:int,code:TARGET_MISSING|TARGET_CHANGED|ANCHOR_MISSING|BLOCK_ID_EXISTS|MOVE_BASE_CHANGED,path:string,baseValue:string|null,headValue:string|null}; the source pair identifies the failing MergeOperation
- MergeRequest = {mergeRequestId:uuid,documentId:uuid,sourceBranchId:uuid,targetBranchId:uuid,sourceHeadRevision:int,targetHeadRevision:int,state:CONFLICTED|IN_REVIEW|APPROVED|MERGED|STALE,reviewPolicy:{reviewerIds:[uuid],requiredApprovals:int},approvals:[MergeApproval],mergeOperations:[MergeOperation],conflicts:[MergeConflict],resultDigest:sha256|null,mergedTargetRevision:int|null,createdAt:timestamp,terminalAt:timestamp|null}
- Change adds branchId:uuid and its baseRevision, revision, and clientSequence are Branch-local; DocumentRevision adds branchId:uuid and mergeRequestId:uuid|null. Legacy endpoints imply main and retain V1 response bodies

新增或变更的公开接口：

- POST /api/v1/documents/:documentId/branches with {name,sourceBranchId,sourceRevision} returns 201 Branch after verifying the immutable source revision; GET /api/v1/documents/:documentId/branches returns main first then other Branches by name and branchId.
- POST /api/v1/documents/:documentId/branches/:branchId/changes uses V1 Change request and operation rules, scopes clientSequence by documentId,branchId,clientId, and creates exactly one next Branch-local revision.
- POST /api/v1/documents/:documentId/merge-requests with {sourceBranchId,targetBranchId,expectedSourceHeadRevision,expectedTargetHeadRevision,reviewPolicy:{reviewerIds,requiredApprovals}} requires targetBranchId equal the source Branch's immutable sourceBranchId and captures both heads.
- Merge Request creation wraps every canonical operation from source revisions 1 through sourceHeadRevision as MergeOperation, sorts by sourceRevision then sourceOperationIndex, and rebases them onto captured target using V1 preconditions. Failures become MergeConflict objects with the same source pair and sort order and state CONFLICTED; otherwise state is IN_REVIEW and resultDigest is the preview DocumentRevision digest.
- POST /api/v1/merge-requests/:mergeRequestId/approvals with {reviewerId} accepts only a captured Reviewer, stores at most one Approval per Reviewer for resultDigest, and returns MergeRequest. The request reaching requiredApprovals performs exactly one transition to APPROVED and emits one merge-request.approved event.
- POST /api/v1/merge-requests/:mergeRequestId/merge with {} succeeds only from APPROVED while current Branch heads equal captured heads; it creates targetHeadRevision+1 from stored preview blocks, leaves source unchanged, schedules one Snapshot Task, and emits document.changed followed by merge-request.merged.
- GET /api/v1/merge-requests/:mergeRequestId returns captured heads, policy, sorted approvals, operations, conflicts, digest, and merged revision; GET /api/v1/documents/:documentId/branches/:branchId/revisions/:revision returns the Branch-local DocumentRevision.

新增稳定错误：

- 400 INVALID_REVIEW_POLICY: reviewerIds are empty, duplicated, or over 20, or requiredApprovals is outside 1..5 or exceeds reviewer count
- 400 MERGE_TARGET_NOT_SOURCE_BRANCH: targetBranchId is not the source Branch's immutable sourceBranchId
- 409 BRANCH_HEAD_CHANGED: an expected source or target head is stale when creating the Merge Request
- 409 REVIEWER_NOT_ELIGIBLE: reviewerId is not captured or the Merge Request is not reviewable
- 409 MERGE_REQUEST_CONFLICTED: approval or merge is attempted for a conflicted Merge Request
- 409 MERGE_REQUEST_NOT_APPROVED: merge is attempted before the approval threshold
- 409 MERGE_REQUEST_STALE: source or target head changed after review; state becomes STALE with no target revision

跨层规则：

- The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
- The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
- Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
- Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

FINAL snapshot 与性能兼容合同：

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

迁移必须同时满足：

- Migrate every Document revision, Change, Conflict, Snapshot, event, and replay record to branch main without changing IDs or bodies.
- Pending Snapshot Tasks remain bound to the same revision prefix on main.
- Old clients can continue editing and reading main without branch fields in legacy responses.

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
