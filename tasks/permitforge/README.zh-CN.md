# PermitForge 项目设计说明

## 1. 定位

PermitForge 是一个从近空白 Git fixture 开始的高难度全栈 Coding Benchmark，主流程是
revisioned permit applications with role quorum review。这是 transfer task；正式 paired curriculum 为 `schemaharbor` learning -> `permitforge` transfer。

本题只用一个主流程承载难度，重点测量：revision immutability、captured quorum、review lease fencing、deadline races、compatible staged approval。领域词汇以
[CONTEXT.md](./CONTEXT.md) 为准。

## 2. 可见性

Codex 初始只能看到 'workspace/README.md'、'workspace/AGENTS.md' 和独立 fixture Git 历史。
Manager 变更、Checklist、对话状态机、评测方案和实验 metadata 都在 workspace 外，不能在
开发回合、Session Evolution 或盲审前复制或透露。

## 3. 完整 V1

- Submit a Permit Application with immutable Revision 1 and a captured role-based Review Policy.
- Let eligible Reviewers claim role slots through persisted fenced leases and record one Decision per Reviewer and Revision.
- Approve only when every role quota and the total threshold are met, reject on a captured veto, and request changes without mutating the reviewed Revision.
- Create contiguous replacement Revisions after CHANGES_REQUIRED and prevent old Claims or Decisions from affecting the new current Revision.
- Expire undecided Applications through recoverable Deadline Tasks and expose revision, claim, decision, and event history in a real UI.

核心状态：Application: SUBMITTED -> UNDER_REVIEW -> APPROVED | REJECTED | CHANGES_REQUIRED | EXPIRED; CHANGES_REQUIRED creates one next Revision and returns to SUBMITTED.

### 可计算不变量

1. Application Revision numbers are contiguous and every Revision is immutable after submission.
2. Every Claim and Decision names the same captured applicationId, revision, reviewerId, and role.
3. A Reviewer records at most one Decision per Revision and a stale lease token can never commit.
4. APPROVED means every captured role quota and total threshold are satisfied with no veto Decision; no other state may expose an approval result.
5. Revision replacement, final Decision, and Deadline expiry serialize to one winner and rolled-back transitions emit no event.

## 4. Manager 固定变更

V1、真实 Browser E2E、双 API/双 Worker 并发与恢复完成后，T16 才发布
“ordered multi-stage permit approval”。它改变核心基数、状态或一致性边界：

- A Review Policy may contain 1-5 ordered Stages; every Stage has its own V1 role policy.
- Only the current Stage accepts Claims and Decisions; completing it freezes its exact Decisions before activating the next Stage.
- REQUEST_CHANGES or rejection terminates the complete staged review under the V1 semantics and no later Stage activates.
- Final approval occurs only after every Stage completes in ordinal order for the same immutable Revision.
- Stage activation and the final Decision that completes the prior Stage commit atomically.
- Legacy one-stage policies migrate to Stage 1 and preserve Application, Decision, Permit, event, and replay bodies.

新增 wire schema：

- ReviewStage = {stageId:uuid,applicationId:uuid,revision:int,ordinal:int,name:string,state:PENDING|ACTIVE|COMPLETED|TERMINAL,policy:ReviewPolicy,activatedAt:timestamp|null,completedAt:timestamp|null}; ordinals are contiguous from 1
- PermitApplication adds currentStageOrdinal:int|null and stages:[ReviewStage]; legacy one-stage responses may omit these fields on the legacy media type

新增或变更的公开接口：

- POST /api/v1/permit-applications accepts either legacy reviewPolicy or stages:[{name,reviewPolicy}], never both; staged creation returns Revision 1 with Stage 1 ACTIVE and later Stages PENDING.
- Review Claim and Decision endpoints retain their V1 shapes and resolve eligibility only against the current ACTIVE Stage.
- GET /api/v1/permit-applications/:applicationId/stages returns {items:[ReviewStage]} in ordinal order with immutable completed-stage evidence.

新增稳定错误：

- 400 INVALID_REVIEW_STAGES: stage count, name, ordinal, or a nested Review Policy is invalid
- 409 REVIEW_STAGE_CHANGED: a Claim or Decision targets a Stage that is no longer ACTIVE

跨层规则：

- The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
- The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
- Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
- Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

FINAL snapshot 与性能兼容合同：

The FINAL verification snapshot 'resources' object has exactly the union of these V1 and Manager resource specifications, with no other keys:

- 'applicants' uses exact shape 'Applicant = {applicantId:uuid,name:string}' and sorts ascending by scalar field-path tuple 'applicantId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'reviewers' uses exact shape 'Reviewer = {reviewerId:uuid,name:string,roles:[string]}' and sorts ascending by scalar field-path tuple 'reviewerId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'permitApplications' uses exact shape 'PermitApplication' and sorts ascending by scalar field-path tuple 'applicationId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'applicationRevisions' uses exact shape 'ApplicationRevision' and sorts ascending by scalar field-path tuple 'applicationId', 'revision', then by RFC 8785 canonical JSON as the tie-breaker.
- 'reviewClaims' uses exact shape 'ReviewClaim' and sorts ascending by scalar field-path tuple 'applicationId', 'revision', 'claimId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'reviewDecisions' uses exact shape 'ReviewDecision' and sorts ascending by scalar field-path tuple 'applicationId', 'revision', 'decidedAt', 'decisionId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'approvedPermits' uses exact shape 'ApprovedPermit = {permitId:uuid,applicationId:uuid,revision:int,canonicalDigest:sha256,issuedAt:timestamp}' and sorts ascending by scalar field-path tuple 'permitId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'reviewStages' uses exact shape 'ReviewStage' and sorts ascending by scalar field-path tuple 'applicationId', 'revision', 'ordinal', 'stageId', then by RFC 8785 canonical JSON as the tie-breaker.

The Manager-added resource specifications are exactly:

- 'reviewStages' uses exact shape 'ReviewStage' and sorts ascending by scalar field-path tuple 'applicationId', 'revision', 'ordinal', 'stageId', then by RFC 8785 canonical JSON as the tie-breaker.

The FINAL Work kind enum is exactly the union 'PERMIT_DEADLINE'. The Manager-added
Work kinds are exactly (none). All V1 snapshot point-in-time,
recursive '*Token' omission, sorting, Work state/lease/retention/drain, and Domain Event rules remain
mandatory. The FINAL binary reruns exactly these three V1-compatible scenarios:

- 'application-current-read': serve 350 current Application reads/s with p95 <= 120 ms; threshold: At least 350 successful reads/s for 60 seconds and p95 <= 120 ms; mixed revisions and unexpected 5xx are zero.
- 'application-submit': submit 100 Permit Applications/s with p95 <= 350 ms; threshold: At least 100 successful Applications/s for 60 seconds and p95 <= 350 ms; partial revision state and unexpected 5xx are zero.
- 'permit-deadline-recovery': expire 10,000 undecided Applications within 75 s after worker recovery; threshold: The backlog drains in <= 75 seconds after replacement spawn; stale decisions, invented Permits, and unexpected failures are zero.

Their published setup, selector, request, concurrency, warm-up, measurement, timer, success condition,
and threshold remain unchanged. This Manager change adds correctness, concurrency, and recovery
assertions only; it does not replace or relax a performance scenario.

迁移必须同时满足：

- Migrate every V1 current Revision and policy to one Stage without changing IDs, Claims, Decisions, Permits, events, Work, or saved responses.
- Pending Deadline Tasks retain their original applicationId, deadline, attempt, and lease state.
- Old clients continue submitting and reviewing one-stage Applications with unchanged request and response semantics.

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
