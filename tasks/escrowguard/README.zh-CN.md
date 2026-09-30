# EscrowGuard 项目设计说明

## 1. 定位

EscrowGuard 是一个从近空白 Git fixture 开始的高难度全栈 Coding Benchmark，主流程是
milestone escrow release, refund, and dispute resolution。这是 transfer task；正式 paired curriculum 为 `ledgerbridge` learning -> `escrowguard` transfer。

本题只用一个主流程承载难度，重点测量：integer conservation、coupled state machines、terminal-action races、recoverable expiry、compatible split settlement。领域词汇以
[CONTEXT.md](./CONTEXT.md) 为准。

## 2. 可见性

Codex 初始只能看到 'workspace/README.md'、'workspace/AGENTS.md' 和独立 fixture Git 历史。
Manager 变更、Checklist、对话状态机、评测方案和实验 metadata 都在 workspace 外，不能在
开发回合、Session Evolution 或盲审前复制或透露。

## 3. 完整 V1

- Create and atomically fund an Escrow whose ordered Milestone amounts sum exactly to totalMinor.
- Submit and accept Milestones in order, releasing each accepted amount exactly once.
- Allow either party to open one Dispute for the current submitted Milestone and let an administrator resolve it to release or refund.
- Refund all remaining available value through a recoverable Expiry Task when no unresolved Dispute exists.
- Expose Escrow progress, Milestone history, Fund Position, Dispute evidence, and Domain Event delivery in a real UI.

核心状态：Escrow: FUNDED -> ACTIVE -> RELEASED | REFUNDED, or ACTIVE -> DISPUTED -> RELEASED | REFUNDED; Milestone: PENDING -> SUBMITTED -> ACCEPTED -> RELEASED, or SUBMITTED -> DISPUTED.

### 可计算不变量

1. For every Escrow, totalMinor equals availableMinor plus releasedMinor plus refundedMinor and every term is a non-negative safe integer.
2. Milestone amounts sum exactly to Escrow totalMinor and their ordinal values are contiguous from 1.
3. At most one Milestone is SUBMITTED or DISPUTED and later Milestones cannot advance before every earlier Milestone is RELEASED.
4. A Milestone amount is released or refunded at most once, never both, and every Release agrees with committed Fund Position.
5. Expiry, acceptance, and dispute resolution have one serialized winner and a stale worker or request cannot change the terminal result.

## 4. Manager 固定变更

V1、真实 Browser E2E、双 API/双 Worker 并发与恢复完成后，T16 才发布
“atomic multi-beneficiary milestone settlement”。它改变核心基数、状态或一致性边界：

- A Milestone may distribute its amount across 1-20 Beneficiary Shares whose exact integer sum equals that Milestone amount.
- Each Beneficiary Share has a stable ordinal, beneficiaryId, and amountMinor captured when the Escrow is funded.
- Accepting or resolving RELEASE creates every beneficiary payout atomically or creates none.
- One failed or conflicting beneficiary allocation leaves the Milestone SUBMITTED or DISPUTED and Fund Position unchanged.
- Legacy one-Seller Milestones migrate to one Beneficiary Share and preserve their original Release response byte-for-byte.
- Refund and expiry never create beneficiary payouts and still refund the complete unreleased Milestone amount.

新增 wire schema：

- BeneficiaryShare = {beneficiaryShareId:uuid,milestoneId:uuid,ordinal:int,beneficiaryId:uuid,amountMinor:int}; ordinals are contiguous and amounts sum to Milestone.amountMinor
- BeneficiaryPayout = {payoutId:uuid,releaseId:uuid,beneficiaryShareId:uuid,beneficiaryId:uuid,amountMinor:int,createdAt:timestamp}; Release adds payouts:[BeneficiaryPayout] ordered by share ordinal

新增或变更的公开接口：

- POST /api/v1/escrows accepts each Milestone as either legacy {title,amountMinor} or {title,amountMinor,beneficiaries:[{beneficiaryId,amountMinor}]}; mixed Milestone forms are allowed but each beneficiary list must sum exactly.
- GET /api/v1/escrows/:escrowId exposes beneficiaryShares and beneficiaryPayouts; legacy one-Seller responses retain their old fields and semantic replay.
- Every release path locks the current Milestone and all its shares in ordinal order, validates the complete captured allocation, and creates one Release plus all payouts in one transaction.

新增稳定错误：

- 400 INVALID_BENEFICIARY_ALLOCATION: share count, duplicate beneficiary, amount, or exact sum is invalid
- 409 BENEFICIARY_PAYOUT_CONFLICT: an existing payout set differs from the captured canonical shares

跨层规则：

- The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
- The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
- Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
- Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

FINAL snapshot 与性能兼容合同：

The FINAL verification snapshot 'resources' object has exactly the union of these V1 and Manager resource specifications, with no other keys:

- 'parties' uses exact shape 'Party = {partyId:uuid,displayName:string}' and sorts ascending by scalar field-path tuple 'partyId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'escrows' uses exact shape 'Escrow' and sorts ascending by scalar field-path tuple 'escrowId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'milestones' uses exact shape 'Milestone' and sorts ascending by scalar field-path tuple 'escrowId', 'ordinal', 'milestoneId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'disputes' uses exact shape 'Dispute' and sorts ascending by scalar field-path tuple 'escrowId', 'openedAt', 'disputeId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'releases' uses exact shape 'Release' and sorts ascending by scalar field-path tuple 'escrowId', 'createdAt', 'releaseId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'beneficiaryShares' uses exact shape 'BeneficiaryShare' and sorts ascending by scalar field-path tuple 'milestoneId', 'ordinal', 'beneficiaryShareId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'beneficiaryPayouts' uses exact shape 'BeneficiaryPayout' and sorts ascending by scalar field-path tuple 'releaseId', 'beneficiaryShareId', 'payoutId', then by RFC 8785 canonical JSON as the tie-breaker.

The Manager-added resource specifications are exactly:

- 'beneficiaryShares' uses exact shape 'BeneficiaryShare' and sorts ascending by scalar field-path tuple 'milestoneId', 'ordinal', 'beneficiaryShareId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'beneficiaryPayouts' uses exact shape 'BeneficiaryPayout' and sorts ascending by scalar field-path tuple 'releaseId', 'beneficiaryShareId', 'payoutId', then by RFC 8785 canonical JSON as the tie-breaker.

The FINAL Work kind enum is exactly the union 'ESCROW_EXPIRY'. The Manager-added
Work kinds are exactly (none). All V1 snapshot point-in-time,
recursive '*Token' omission, sorting, Work state/lease/retention/drain, and Domain Event rules remain
mandatory. The FINAL binary reruns exactly these three V1-compatible scenarios:

- 'escrow-detail-read': serve 300 Escrow detail reads/s with p95 <= 140 ms; threshold: At least 300 successful reads/s for 60 seconds and p95 <= 140 ms; mixed revisions and unexpected 5xx are zero.
- 'funded-escrow-create': create 80 funded Escrows/s with p95 <= 500 ms; threshold: At least 80 successful Escrows/s for 60 seconds and p95 <= 500 ms; partial funding and unexpected 5xx counts are zero.
- 'escrow-expiry-recovery': expire and refund 5,000 Escrows within 75 s after worker recovery; threshold: The complete backlog drains in <= 75 seconds after replacement spawn; stale commits, partial refunds, and unexpected failures are zero.

Their published setup, selector, request, concurrency, warm-up, measurement, timer, success condition,
and threshold remain unchanged. This Manager change adds correctness, concurrency, and recovery
assertions only; it does not replace or relax a performance scenario.

迁移必须同时满足：

- Migrate every V1 Milestone to one Seller Beneficiary Share without changing Escrow, Milestone, Release, event, Work, or replay identity.
- Pending Expiry Tasks retain their exact deadline, attempt, and lease state.
- Old clients may continue creating, accepting, resolving, and reading one-Seller Escrows without sending beneficiary fields.

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
