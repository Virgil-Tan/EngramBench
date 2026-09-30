# ReconcileHub 项目设计说明

## 1. 定位

ReconcileHub 是一个从近空白 Git fixture 开始的高难度全栈 Coding Benchmark，主流程是
auditable statement-to-ledger reconciliation。这是 learning task，用于形成可迁移的工程经验。

本题只用一个主流程承载难度，重点测量：batch atomicity、deterministic matching、amount conservation、concurrent decisions、audit recovery。领域词汇以
[CONTEXT.md](./CONTEXT.md) 为准。

## 2. 可见性

Codex 初始只能看到 'workspace/README.md'、'workspace/AGENTS.md' 和独立 fixture Git 历史。
Manager 变更、Checklist、对话状态机、评测方案和实验 metadata 都在 workspace 外，不能在
开发回合、Session Evolution 或盲审前复制或透露。

## 3. 完整 V1

- Import deterministic Statement Batches atomically with durable file digest replay.
- Generate deterministic one-to-one Match suggestions using only published exact rules.
- Confirm, reject, ignore, or reverse decisions with safe races across two API instances.
- Keep immutable amount, decision, and audit histories with Domain Event delivery.
- Expose batch status, unmatched work queues, side-by-side review, and reconciliation totals in the UI.

核心状态：Statement Line: UNMATCHED -> MATCHED | IGNORED; Match: PROPOSED -> CONFIRMED | REJECTED | REVERSED.

### 可计算不变量

1. A confirmed Statement Line belongs to at most one active Match.
2. A confirmed Ledger Entry belongs to at most one active Match.
3. Every confirmed V1 Match has equal currency and amount on both sides.
4. Batch import is all-or-nothing and same digest replays the same IDs and response.
5. Reversal restores both sides exactly once and never deletes audit history.

## 4. Manager 固定变更

V1、真实 Browser E2E、双 API/双 Worker 并发与恢复完成后，T16 才发布
“many-to-many split reconciliation”。它改变核心基数、状态或一致性边界：

- A Match Group may contain 1-20 Statement Lines and 1-20 Ledger Entries in one currency.
- The sum of Statement Line amounts must equal the sum of Ledger Entry amounts before confirmation.
- Every member is reserved and confirmed atomically; any already-active member rejects the whole group.
- Reversal releases the complete Match Group; partial reversal is not supported.
- Suggestions enumerate groups with at most four total members, order each side by date then ID, order combinations lexicographically by member IDs, and choose the first equal-currency equal-sum group after one-to-one candidates.
- Legacy one-to-one Match fields remain populated for groups with one member on each side and are null otherwise.

新增 wire schema：

- MatchGroup = {matchGroupId:uuid,matchId:uuid|null,statementLineId:uuid|null,ledgerEntryId:uuid|null,statementLineIds:[uuid],ledgerEntryIds:[uuid],currency:currency,statementTotalMinor:int,ledgerTotalMinor:int,state:PROPOSED|CONFIRMED|REJECTED|REVERSED,createdAt:timestamp,confirmedAt:timestamp|null,reversedAt:timestamp|null,sequence:int}; a one-to-one group has matchId equal to matchGroupId and both singular member IDs populated, while a many-member group requires all three legacy singular fields to be null

新增或变更的公开接口：

- POST /api/v1/match-groups with {statementLineIds:[uuid],ledgerEntryIds:[uuid]} returns 201 PROPOSED after sorting IDs and validating 1..20 members per side
- POST /api/v1/match-groups/:matchGroupId/confirm with {expectedStatementLineRevisions:{statementLineId:int},expectedLedgerEntryRevisions:{ledgerEntryId:int}} atomically confirms every member; the two maps are keyed by the UUIDs of exactly the group's Statement Lines and Ledger Entries, with no missing or extra keys; /reverse with {reason} reverses all
- GET /api/v1/match-groups/:matchGroupId returns exact MatchGroup. GET /api/v1/matches/:matchId is retained only for a group of exactly one member per side, resolves matchId equal to matchGroupId, and returns the exact legacy Match shape with statementLineId and ledgerEntryId rather than MatchGroup

新增稳定错误：

- 409 MATCH_GROUP_IMBALANCED: currency differs or statement and ledger sums are unequal
- 409 MATCH_GROUP_MEMBER_CONFLICT: any member revision changed or belongs to another active group

跨层规则：

- The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
- The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
- Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
- Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

FINAL snapshot 与性能兼容合同：

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

迁移必须同时满足：

- Migrate every V1 Match to a two-member Match Group whose matchGroupId equals the existing matchId, without changing decisions, audit entries, events, or replay JSON.
- Pending Suggestion Tasks continue against their captured eligible set.
- Historical ignored and reversed lines retain their exact state.

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
