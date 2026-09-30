# LedgerBridge 项目设计说明

## 1. 定位

LedgerBridge 是一个从近空白 Git fixture 开始的高难度全栈 Coding Benchmark，主流程是
durable double-entry account transfers。这是 learning task，用于形成可迁移的工程经验。

本题只用一个主流程承载难度，重点测量：double-entry conservation、durable idempotency、terminal reversal races、recoverable settlement、transactional events。领域词汇以
[CONTEXT.md](./CONTEXT.md) 为准。

## 2. 可见性

Codex 初始只能看到 'workspace/README.md'、'workspace/AGENTS.md' 和独立 fixture Git 历史。
Manager 变更、Checklist、对话状态机、评测方案和实验 metadata 都在 workspace 外，不能在
开发回合、Session Evolution 或盲审前复制或透露。

## 3. 完整 V1

- Create a Transfer from one Account to another using integer minor units and one currency.
- Reserve available source funds atomically and let leased workers post the balanced debit and credit.
- Allow cancellation only while pending and reversal only after posting; competing terminal actions have one winner.
- Expose account statements, transfer history, event history, and a real API-backed operations UI.
- Deliver Domain Events through an at-least-once webhook dispatcher with stable identity and per-Transfer order.

核心状态：Transfer: PENDING -> POSTED | CANCELLED; POSTED -> REVERSED. CANCELLED and REVERSED are terminal.

### 可计算不变量

1. For every currency, the sum of Account balanceMinor values is conserved; reservations never participate in that sum.
2. Every posted Transfer has exactly two Posting legs whose signed amounts sum to zero.
3. For each Account, reservedMinor equals the sum of amountMinor for its outgoing PENDING Transfers, availableMinor equals balanceMinor minus reservedMinor, and none of those values is negative.
4. A Transfer has at most one successful Posting and at most one Reversal.
5. A committed state transition has exactly one Domain Event; a rolled-back transition has none.

## 4. Manager 固定变更

V1、真实 Browser E2E、双 API/双 Worker 并发与恢复完成后，T16 才发布
“atomic multi-beneficiary transfers”。它改变核心基数、状态或一致性边界：

- A new Transfer may contain 1-20 destination legs; V1 single-destination requests remain valid.
- Every destination amountMinor and their exact sum must be positive safe integers; an invalid member or overflowing sum is rejected before any durable effect.
- All destination legs post together or none post; the source is charged exactly the sum of the legs.
- For a pending multi-leg Transfer, the source reservation equals the exact safe-integer sum of its legs until posting or cancellation releases it.
- Duplicate destination account IDs are rejected before any durable effect.
- Each destination leg receives a stable legId and appears in Transfer detail and Account statements.
- Reversal compensates every leg atomically and cannot partially succeed.
- The legacy destinationAccountId and amountMinor response fields remain populated for one-leg Transfers and are null for multi-leg Transfers.

新增 wire schema：

- TransferLeg = {legId:uuid,destinationAccountId:uuid,amountMinor:int,postingLegId:uuid|null}; Transfer adds legs:[TransferLeg], while destinationAccountId and amountMinor become required nullable fields
- Manager Posting legs use {postingLegId:uuid,legId:uuid|null,accountId:uuid,direction:DEBIT|CREDIT,amountMinor:int}. A multi-leg TRANSFER orders one source DEBIT with legId null before destination CREDIT legs in Transfer.legs order; a REVERSAL orders destination DEBIT legs in Transfer.legs order before one source CREDIT with legId null. The source leg amount is the exact safe-integer sum of the destination legs. This replaces the V1 exactly-two-leg rule only for multi-leg Transfers; one-leg Postings keep the V1 order and shape

新增或变更的公开接口：

- POST /api/v1/transfers accepts either legacy {sourceAccountId,destinationAccountId,currency,amountMinor} or new {sourceAccountId,currency,legs:[{destinationAccountId,amountMinor}]}, never both; response is the extended Transfer
- GET /api/v1/transfers/:transferId and Account statements expose legId; reverse and cancel endpoints keep their V1 request shapes and act on the complete Transfer

新增稳定错误：

- 400 DUPLICATE_DESTINATION_ACCOUNT: two request legs name the same destinationAccountId
- 400 INVALID_MULTI_LEG_AMOUNT: a destination amountMinor or their exact sum is not a positive safe integer
- 409 MULTI_LEG_INSUFFICIENT_FUNDS: source availableMinor is less than the safe-integer sum of all legs

跨层规则：

- The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
- The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
- Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
- Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

FINAL snapshot 与性能兼容合同：

The FINAL verification snapshot 'resources' object has exactly the union of these V1 and Manager resource specifications, with no other keys:

- 'accounts' uses exact shape 'Account' and sorts ascending by scalar field-path tuple 'accountId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'transfers' uses exact shape 'Transfer' and sorts ascending by scalar field-path tuple 'transferId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'postings' uses exact shape 'Posting' and sorts ascending by scalar field-path tuple 'postingId', then by RFC 8785 canonical JSON as the tie-breaker.

The Manager-added resource specifications are exactly:

- No additional resource keys.

The FINAL Work kind enum is exactly the union 'SETTLEMENT'. The Manager-added
Work kinds are exactly (none). All V1 snapshot point-in-time,
recursive '*Token' omission, sorting, Work state/lease/retention/drain, and Domain Event rules remain
mandatory. The FINAL binary reruns exactly these three V1-compatible scenarios:

- 'statement-read': 150 statement reads/s with p95 <= 150 ms; threshold: At least 150 successful responses/s for 60 seconds and successful-response p95 <= 150 ms; unexpected 5xx = 0.
- 'transfer-mutation-mix': 40 transfer mutations/s with p95 <= 500 ms; threshold: At least 40 successful mutations/s for 60 seconds and successful-response p95 <= 500 ms; all balances, reservations, postings, and events reconcile afterward.
- 'settlement-recovery': drain 2,000 Settlement Tasks within 45 s after workers restart; threshold: The replacement-worker timer is <= 45 seconds and worker unexpected failures = 0.

Their published setup, selector, request, concurrency, warm-up, measurement, timer, success condition,
and threshold remain unchanged. This Manager change adds correctness, concurrency, and recovery
assertions only; it does not replace or relax a performance scenario.

迁移必须同时满足：

- Upgrade every V1 Transfer to one leg without changing IDs, timestamps, statements, event sequences, or replay bodies.
- Preserve all pending Settlement Tasks and their retry state.
- Old one-leg clients continue to create and read Transfers unchanged.

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
