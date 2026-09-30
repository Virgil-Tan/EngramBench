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