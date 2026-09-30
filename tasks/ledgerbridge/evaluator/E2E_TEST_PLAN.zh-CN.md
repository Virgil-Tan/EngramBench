# LedgerBridge Harness-owned E2E / Concurrency / Recovery / Performance 方案

## 1. 边界与等级

本文件位于 candidate workspace 外，只定义 D1 黑盒评测方案。当前没有 runner、中央 score
manifest、gold 或 calibration 证据，不能声称 D3。Evaluator 只使用公开命令、HTTP、浏览器、
webhook receiver、文件下载和进程信号；不得 import 候选源码、ORM、表名或 'dist' 路径。

## 2. 固定环境

- Node.js 22、PostgreSQL 16、Chromium 和 Docker-compatible OCI；容器限制为 4 logical CPUs、
  8 GiB RAM，两个 API、两个 workers、一个 dispatcher 和 PostgreSQL 共享该限制；
- 每个 scenario 使用新数据库、新端口和独立 managed data directory；
- 两个 API、至少两个 Settlement Task workers 和一个 dispatcher 共享同一 PostgreSQL；
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

- Create a Transfer from one Account to another using integer minor units and one currency.
- Reserve available source funds atomically and let leased workers post the balanced debit and credit.
- Allow cancellation only while pending and reversal only after posting; competing terminal actions have one winner.
- Expose account statements, transfer history, event history, and a real API-backed operations UI.
- Deliver Domain Events through an at-least-once webhook dispatcher with stable identity and per-Transfer order.

对每个成功状态同时检查响应、查询、历史、异步工作和事件。

### H-04 Atomic rejection and conservation

在每个公开失败边界生成合法但不可满足的请求，断言无 partial aggregate、任务、事件或守恒量
变化。核心断言：

1. For every currency, the sum of Account balanceMinor values is conserved; reservations never participate in that sum.
2. Every posted Transfer has exactly two Posting legs whose signed amounts sum to zero.
3. For each Account, reservedMinor equals the sum of amountMinor for its outgoing PENDING Transfers, availableMinor equals balanceMinor minus reservedMinor, and none of those values is negative.
4. A Transfer has at most one successful Posting and at most one Reversal.
5. A committed state transition has exactly one Domain Event; a rolled-back transition has none.

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

- Upgrade every V1 Transfer to one leg without changing IDs, timestamps, statements, event sequences, or replay bodies.
- Preserve all pending Settlement Tasks and their retry state.
- Old one-leg clients continue to create and read Transfers unchanged.

### H-10 Manager core behavior

仅在 T16 已发布后按黑盒方式验证：

- A new Transfer may contain 1-20 destination legs; V1 single-destination requests remain valid.
- Every destination amountMinor and their exact sum must be positive safe integers; an invalid member or overflowing sum is rejected before any durable effect.
- All destination legs post together or none post; the source is charged exactly the sum of the legs.
- For a pending multi-leg Transfer, the source reservation equals the exact safe-integer sum of its legs until posting or cancellation releases it.
- Duplicate destination account IDs are rejected before any durable effect.
- Each destination leg receives a stable legId and appears in Transfer detail and Account statements.
- Reversal compensates every leg atomically and cannot partially succeed.
- The legacy destinationAccountId and amountMinor response fields remain populated for one-leg Transfers and are null for multi-leg Transfers.

新增 wire schema 与接口同样属于断言面：

- TransferLeg = {legId:uuid,destinationAccountId:uuid,amountMinor:int,postingLegId:uuid|null}; Transfer adds legs:[TransferLeg], while destinationAccountId and amountMinor become required nullable fields
- Manager Posting legs use {postingLegId:uuid,legId:uuid|null,accountId:uuid,direction:DEBIT|CREDIT,amountMinor:int}. A multi-leg TRANSFER orders one source DEBIT with legId null before destination CREDIT legs in Transfer.legs order; a REVERSAL orders destination DEBIT legs in Transfer.legs order before one source CREDIT with legId null. The source leg amount is the exact safe-integer sum of the destination legs. This replaces the V1 exactly-two-leg rule only for multi-leg Transfers; one-leg Postings keep the V1 order and shape
- POST /api/v1/transfers accepts either legacy {sourceAccountId,destinationAccountId,currency,amountMinor} or new {sourceAccountId,currency,legs:[{destinationAccountId,amountMinor}]}, never both; response is the extended Transfer
- GET /api/v1/transfers/:transferId and Account statements expose legId; reverse and cancel endpoints keep their V1 request shapes and act on the complete Transfer
- 400 DUPLICATE_DESTINATION_ACCOUNT: two request legs name the same destinationAccountId
- 400 INVALID_MULTI_LEG_AMOUNT: a destination amountMinor or their exact sum is not a positive safe integer
- 409 MULTI_LEG_INSUFFICIENT_FUNDS: source availableMinor is less than the safe-integer sum of all legs
- The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
- The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
- Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
- Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

FINAL snapshot 与性能兼容断言：

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

同时验证每个失败分支整组回滚和重复请求一致。

### H-11 Manager UI, concurrency, and recovery

用 production Chromium 完成新旧流程；两个 API/worker 竞争 Manager 新基数或状态；在可观察
barrier 崩溃并恢复；检查 compatibility fields、聚合状态、成员状态、事件顺序和无重复效果。

### H-12 Sustained performance plus post-load correctness

严格对 FINAL binary 重跑 workspace README 的同三个 V1-compatible scenario，不得改变任何字段或
阈值；Manager 增量只增加 correctness、concurrency 和 recovery 断言。每个 scenario 使用独立新库，
严格执行公开 dataset、setup、selector、request、concurrency、warm-up、measurement、success、
threshold 和 timer，记录 p50/p95/p99、吞吐、成功 mutation、预期冲突、unexpected 5xx、
worker/dispatcher backlog 与排空时间。固定 dataset 为：seedVersion perf-v1 contains exactly 20,000 accounts and 102,000 transfers: 100,000 POSTED and 2,000 PENDING, with exactly one pending Settlement Task per PENDING Transfer.。三个场景是：

### Scenario 'statement-read'

- Target: 150 statement reads/s with p95 <= 150 ms
- Mode: 'http'
- Method: 'GET'
- Path: '/api/v1/accounts/:accountId/statement?limit=50'
- Setup: Use the unchanged perf-v1 seed; reads do not consume data.
- Selector: Choose accountId round-robin from all accounts in verification-snapshot bytewise UUID order; omit cursor on every request.
- Request: No body. Require Authorization only if the public route normally requires it.
- Concurrency: 64
- Warm-up seconds: 10
- Measure seconds: 60
- Success: Only complete 200 StatementPage responses count; every page must have valid order, cursor, leg amounts, and balanceAfterMinor.
- Threshold: At least 150 successful responses/s for 60 seconds and successful-response p95 <= 150 ms; unexpected 5xx = 0.
- Timer: The throughput window starts with the first measured request after warm-up; each latency sample runs from request dispatch through the complete response body.

### Scenario 'transfer-mutation-mix'

- Target: 40 transfer mutations/s with p95 <= 500 ms
- Mode: 'http'
- Method: 'POST'
- Path: '/api/v1/transfers; /api/v1/transfers/:transferId/cancel; /api/v1/transfers/:transferId/reverse'
- Setup: Reserve disjoint warm-up and measured pools of funded same-currency Account pairs, PENDING Transfers, and POSTED Transfers from bytewise-sorted seed IDs.
- Selector: Repeat CREATE, CREATE, CANCEL, REVERSE. Each CANCEL or REVERSE ID is used once; each CREATE uses the next Account pair, amountMinor 1, and a fresh key.
- Request: CREATE uses {sourceAccountId,destinationAccountId,currency,amountMinor:1}; CANCEL uses {}; REVERSE uses {reason:"perf"}. Warm-up and measured IDs never overlap.
- Concurrency: 64
- Warm-up seconds: 10
- Measure seconds: 60
- Success: Only the published 2xx terminal response for each scheduled operation counts; no expected conflict is part of the success numerator.
- Threshold: At least 40 successful mutations/s for 60 seconds and successful-response p95 <= 500 ms; all balances, reservations, postings, and events reconcile afterward.
- Timer: The throughput window starts with the first measured request after warm-up; each latency sample runs from request dispatch through the complete response body.

### Scenario 'settlement-recovery'

- Target: drain 2,000 Settlement Tasks within 45 s after workers restart
- Mode: 'worker'
- Method: 'N/A'
- Path: 'work:SETTLEMENT'
- Setup: Exactly 2,000 PENDING Transfers each have one nonterminal SETTLEMENT Work. Start two workers, hold both at worker.claimed, SIGKILL them, wait for both leases to expire, then start two replacements.
- Selector: Workers claim by the published createdAt,transferId order until no SETTLEMENT Work is nonterminal.
- Request: No measured client request is issued; setup uses only the published seed and public APIs before the worker timer starts.
- Concurrency: 2
- Warm-up seconds: 0
- Measure seconds: 45
- Success: All 2,000 Transfers are POSTED exactly once, no SETTLEMENT Work has terminal=false, stale workers cannot commit, and conservation plus event invariants pass.
- Threshold: The replacement-worker timer is <= 45 seconds and worker unexpected failures = 0.
- Timer: Start when both replacement worker processes are spawned; stop only after one verification snapshot proves the backlog drained and all postconditions.

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
