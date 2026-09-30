# PermitForge Harness-owned E2E / Concurrency / Recovery / Performance 方案

## 1. 边界与等级

本文件位于 candidate workspace 外，只定义 D1 黑盒评测方案。当前没有 runner、中央 score
manifest、gold 或 calibration 证据，不能声称 D3。Evaluator 只使用公开命令、HTTP、浏览器、
webhook receiver、文件下载和进程信号；不得 import 候选源码、ORM、表名或 'dist' 路径。

## 2. 固定环境

- Node.js 22、PostgreSQL 16、Chromium 和 Docker-compatible OCI；容器限制为 4 logical CPUs、
  8 GiB RAM，两个 API、两个 workers、一个 dispatcher 和 PostgreSQL 共享该限制；
- 每个 scenario 使用新数据库、新端口和独立 managed data directory；
- 两个 API、至少两个 Permit Deadline Task workers 和一个 dispatcher 共享同一 PostgreSQL；
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

- Submit a Permit Application with immutable Revision 1 and a captured role-based Review Policy.
- Let eligible Reviewers claim role slots through persisted fenced leases and record one Decision per Reviewer and Revision.
- Approve only when every role quota and the total threshold are met, reject on a captured veto, and request changes without mutating the reviewed Revision.
- Create contiguous replacement Revisions after CHANGES_REQUIRED and prevent old Claims or Decisions from affecting the new current Revision.
- Expire undecided Applications through recoverable Deadline Tasks and expose revision, claim, decision, and event history in a real UI.

对每个成功状态同时检查响应、查询、历史、异步工作和事件。

### H-04 Atomic rejection and conservation

在每个公开失败边界生成合法但不可满足的请求，断言无 partial aggregate、任务、事件或守恒量
变化。核心断言：

1. Application Revision numbers are contiguous and every Revision is immutable after submission.
2. Every Claim and Decision names the same captured applicationId, revision, reviewerId, and role.
3. A Reviewer records at most one Decision per Revision and a stale lease token can never commit.
4. APPROVED means every captured role quota and total threshold are satisfied with no veto Decision; no other state may expose an approval result.
5. Revision replacement, final Decision, and Deadline expiry serialize to one winner and rolled-back transitions emit no event.

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

- Migrate every V1 current Revision and policy to one Stage without changing IDs, Claims, Decisions, Permits, events, Work, or saved responses.
- Pending Deadline Tasks retain their original applicationId, deadline, attempt, and lease state.
- Old clients continue submitting and reviewing one-stage Applications with unchanged request and response semantics.

### H-10 Manager core behavior

仅在 T16 已发布后按黑盒方式验证：

- A Review Policy may contain 1-5 ordered Stages; every Stage has its own V1 role policy.
- Only the current Stage accepts Claims and Decisions; completing it freezes its exact Decisions before activating the next Stage.
- REQUEST_CHANGES or rejection terminates the complete staged review under the V1 semantics and no later Stage activates.
- Final approval occurs only after every Stage completes in ordinal order for the same immutable Revision.
- Stage activation and the final Decision that completes the prior Stage commit atomically.
- Legacy one-stage policies migrate to Stage 1 and preserve Application, Decision, Permit, event, and replay bodies.

新增 wire schema 与接口同样属于断言面：

- ReviewStage = {stageId:uuid,applicationId:uuid,revision:int,ordinal:int,name:string,state:PENDING|ACTIVE|COMPLETED|TERMINAL,policy:ReviewPolicy,activatedAt:timestamp|null,completedAt:timestamp|null}; ordinals are contiguous from 1
- PermitApplication adds currentStageOrdinal:int|null and stages:[ReviewStage]; legacy one-stage responses may omit these fields on the legacy media type
- POST /api/v1/permit-applications accepts either legacy reviewPolicy or stages:[{name,reviewPolicy}], never both; staged creation returns Revision 1 with Stage 1 ACTIVE and later Stages PENDING.
- Review Claim and Decision endpoints retain their V1 shapes and resolve eligibility only against the current ACTIVE Stage.
- GET /api/v1/permit-applications/:applicationId/stages returns {items:[ReviewStage]} in ordinal order with immutable completed-stage evidence.
- 400 INVALID_REVIEW_STAGES: stage count, name, ordinal, or a nested Review Policy is invalid
- 409 REVIEW_STAGE_CHANGED: a Claim or Decision targets a Stage that is no longer ACTIVE
- The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
- The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
- Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
- Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

FINAL snapshot 与性能兼容断言：

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

同时验证每个失败分支整组回滚和重复请求一致。

### H-11 Manager UI, concurrency, and recovery

用 production Chromium 完成新旧流程；两个 API/worker 竞争 Manager 新基数或状态；在可观察
barrier 崩溃并恢复；检查 compatibility fields、聚合状态、成员状态、事件顺序和无重复效果。

### H-12 Sustained performance plus post-load correctness

严格对 FINAL binary 重跑 workspace README 的同三个 V1-compatible scenario，不得改变任何字段或
阈值；Manager 增量只增加 correctness、concurrency 和 recovery 断言。每个 scenario 使用独立新库，
严格执行公开 dataset、setup、selector、request、concurrency、warm-up、measurement、success、
threshold 和 timer，记录 p50/p95/p99、吞吐、成功 mutation、预期冲突、unexpected 5xx、
worker/dispatcher backlog 与排空时间。固定 dataset 为：seedVersion perf-v1 contains exactly 20,000 applicants, 2,000 reviewers, 20,000 permitApplications, 20,000 applicationRevisions, 20,000 reviewClaims, and 10,000 due PERMIT_DEADLINE Work items; 10,000 Applications are stable read targets and 10,000 are undecided and due.。三个场景是：

### Scenario 'application-current-read'

- Target: serve 350 current Application reads/s with p95 <= 120 ms
- Mode: 'http'
- Method: 'GET'
- Path: '/api/v1/permit-applications/:applicationId'
- Setup: Use exactly 10,000 stable nonterminal Applications with immutable current Revisions and captured policies.
- Selector: Round-robin applicationId values in bytewise order.
- Request: No body or query parameters.
- Concurrency: 64
- Warm-up seconds: 10
- Measure seconds: 60
- Success: Only 200 responses whose current Revision, policy, Claims, Decisions, and aggregate state form one revision count.
- Threshold: At least 350 successful reads/s for 60 seconds and p95 <= 120 ms; mixed revisions and unexpected 5xx are zero.
- Timer: The throughput window starts with the first measured request after warm-up; each latency sample runs from request dispatch through the complete response body.

### Scenario 'application-submit'

- Target: submit 100 Permit Applications/s with p95 <= 350 ms
- Mode: 'http'
- Method: 'POST'
- Path: '/api/v1/permit-applications'
- Setup: Use disjoint warm-up and measured Application identities with the fixed Applicant, Reviewer, and policy sets.
- Selector: Advance Applicant and policy combinations bytewise and use unique canonical fields.
- Request: {applicantId,permitType,fields,deadlineAt,reviewPolicy} with a fresh Idempotency-Key.
- Concurrency: 64
- Warm-up seconds: 10
- Measure seconds: 60
- Success: Only 201 SUBMITTED responses creating immutable Revision 1 with one captured policy count.
- Threshold: At least 100 successful Applications/s for 60 seconds and p95 <= 350 ms; partial revision state and unexpected 5xx are zero.
- Timer: The throughput window starts with the first measured request after warm-up; each latency sample runs from request dispatch through the complete response body.

### Scenario 'permit-deadline-recovery'

- Target: expire 10,000 undecided Applications within 75 s after worker recovery
- Mode: 'worker'
- Method: 'N/A'
- Path: 'work:PERMIT_DEADLINE'
- Setup: Exactly 10,000 undecided current Revisions are due with one nonterminal Deadline Work each. Hold two workers at worker.claimed, SIGKILL, wait for lease expiry, then start replacements.
- Selector: Expire by deadlineAt then applicationId after locking and rechecking current Revision and quorum state.
- Request: No measured client request is issued; setup uses only the published seed and public APIs before the worker timer starts.
- Concurrency: 2
- Warm-up seconds: 0
- Measure seconds: 75
- Success: All 10,000 Applications become EXPIRED once, no Permit is issued, and no PERMIT_DEADLINE Work remains nonterminal.
- Threshold: The backlog drains in <= 75 seconds after replacement spawn; stale decisions, invented Permits, and unexpected failures are zero.
- Timer: Start when both replacement workers spawn and stop on the first point-in-time snapshot proving terminal state and revision invariants.

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
