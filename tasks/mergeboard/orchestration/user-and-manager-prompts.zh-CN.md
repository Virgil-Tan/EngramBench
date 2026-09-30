# MergeBoard 多轮用户与 Manager Prompt 协议

## 可见性

本文件只属于 Benchmark Harness，不得复制进 workspace、传给 Codex、Session Evolution 或
盲审 Judge。DS 只根据 workspace 的公开合同、可见对话和当前 scene 推进。

## DS system role

你是一名使用 Codex 完成 MergeBoard 的交付负责人。每轮只提出一个主要目标，用自然简短的中文推进真实开发。可以询问模块职责、接口、状态、数据流、设计取舍和实际验证证据，但绝不能提供代码、伪代码、SQL、命令、补丁、文件或函数定位、表结构、锁、事务、索引、缓存、队列、算法、性能方案、日志分析、Debug 根因或修复提示。Codex 报告失败时只要求其自行定位、修复并重新验证。只使用 README、AGENTS 和已经出现在可见对话中的 Manager 变更，不透露未来阶段或私有评测。

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

V1 已完成并通过基础验收。本期正式增加“branches and review-gated merges”。以下业务规则、wire schema、接口和错误全部是公开增量合同。

业务规则：

1. A Document may have named Branches, each with its own contiguous head based on an immutable source revision.
2. Changes target one Branch and preserve existing client sequence semantics within that Branch.
3. A Merge Request captures source and target heads, computes a deterministic merge result, and records explicit conflicts.
4. Approval requires 1-5 distinct Reviewers from a captured policy; simultaneous final approval creates one merge eligibility transition.
5. Merge succeeds only if target head still matches the reviewed head and creates exactly one target revision; otherwise it becomes STALE.
6. The V1 main history becomes branch main; legacy endpoints continue to imply main while new APIs expose branches[] and merge requests.
7. Migrate every Document revision, Change, Conflict, Snapshot, event, and replay record to branch main without changing IDs or bodies.
8. Pending Snapshot Tasks remain bound to the same revision prefix on main.
9. Old clients can continue editing and reading main without branch fields in legacy responses.
10. The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
11. The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
12. Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
13. Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

新增 wire schema：

- Branch = {branchId:uuid,documentId:uuid,name:string,sourceBranchId:uuid|null,sourceRevision:int,headRevision:int,state:ACTIVE,createdAt:timestamp}; name matches [a-z][a-z0-9-]{0,31} and is unique per Document. A non-main Branch starts at local revision 0 whose blocks equal its immutable source revision
- MergeApproval = {approvalId:uuid,mergeRequestId:uuid,reviewerId:uuid,resultDigest:sha256,approvedAt:timestamp}; approvals are unique by mergeRequestId plus reviewerId and responses sort them by reviewerId
- MergeOperation = {sourceRevision:int,sourceOperationIndex:int,operation:Operation}; the pair is unique and arrays sort by sourceRevision then sourceOperationIndex
- MergeConflict = {sourceRevision:int,sourceOperationIndex:int,code:TARGET_MISSING|TARGET_CHANGED|ANCHOR_MISSING|BLOCK_ID_EXISTS|MOVE_BASE_CHANGED,path:string,baseValue:string|null,headValue:string|null}; the source pair identifies the failing MergeOperation
- MergeRequest = {mergeRequestId:uuid,documentId:uuid,sourceBranchId:uuid,targetBranchId:uuid,sourceHeadRevision:int,targetHeadRevision:int,state:CONFLICTED|IN_REVIEW|APPROVED|MERGED|STALE,reviewPolicy:{reviewerIds:[uuid],requiredApprovals:int},approvals:[MergeApproval],mergeOperations:[MergeOperation],conflicts:[MergeConflict],resultDigest:sha256|null,mergedTargetRevision:int|null,createdAt:timestamp,terminalAt:timestamp|null}
- Change adds branchId:uuid and its baseRevision, revision, and clientSequence are Branch-local; DocumentRevision adds branchId:uuid and mergeRequestId:uuid|null. Legacy endpoints imply main and retain V1 response bodies

新增或变更接口：

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
