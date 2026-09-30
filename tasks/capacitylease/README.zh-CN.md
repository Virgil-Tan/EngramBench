# CapacityLease 项目设计说明

## 1. 定位

CapacityLease 是一个从近空白 Git fixture 开始的高难度全栈 Coding Benchmark，主流程是
time-window capacity holds and gang leases。这是 transfer task；正式 paired curriculum 为 `quotamesh` learning -> `capacitylease` transfer。

本题只用一个主流程承载难度，重点测量：interval capacity conservation、hold-confirm-expiry races、deterministic admission、cross-pool atomicity、lease recovery。领域词汇以
[CONTEXT.md](./CONTEXT.md) 为准。

## 2. 可见性

Codex 初始只能看到 'workspace/README.md'、'workspace/AGENTS.md' 和独立 fixture Git 历史。
Manager 变更、Checklist、对话状态机、评测方案和实验 metadata 都在 workspace 外，不能在
开发回合、Session Evolution 或盲审前复制或透露。

## 3. 完整 V1

- Create a temporary Hold for integer units over one Pool interval only when every overlapping Capacity Slice can admit it.
- Confirm, renew, activate, release, or expire the Lease while preserving capacity under concurrent API and worker processes.
- Place unavailable requests into deterministic Admission Entries ordered by priority, requestedAt, and entryId without bypass.
- Promote waiting requests atomically when release or expiry creates capacity and retain the original requested interval.
- Expose Pool timelines, current and future Leases, Admission order, utilization evidence, and Domain Event delivery in a real UI.

核心状态：Capacity Lease: HELD -> CONFIRMED -> ACTIVE -> RELEASED, or HELD -> EXPIRED; confirmed future Leases may be RELEASED before activation.

### 可计算不变量

1. For every Pool and instant, the sum of units for overlapping HELD, CONFIRMED, and ACTIVE Leases never exceeds capacity and is never negative.
2. Lease intervals are half-open and every Capacity Slice boundary comes only from a Lease startAt or endAt.
3. One request is either one capacity-consuming Lease or one WAITING Admission Entry, never both.
4. Confirmation, renewal, release, expiry, and promotion serialize to one state transition per expected revision.
5. A stale worker or hold token cannot consume, release, or restore capacity after another transition wins.

## 4. Manager 固定变更

V1、真实 Browser E2E、双 API/双 Worker 并发与恢复完成后，T16 才发布
“cross-pool all-or-nothing gang leases”。它改变核心基数、状态或一致性边界：

- A Gang Lease contains 2-10 Pool Members sharing one owner, interval, priority, state, hold expiry, and revision.
- Each Member requests positive units from a distinct Pool and every Pool must have capacity for the complete interval.
- Creation locks Pools in poolId byte order and commits every Member Hold or none.
- Confirm, renew, release, and expiry transition every Member atomically; no partial Gang state is externally visible.
- A failed gang request may wait as one Gang Admission Entry and promotes only when all Members fit simultaneously.
- Legacy one-Pool Leases migrate to one Member while keeping old response bodies and endpoints unchanged.

新增 wire schema：

- GangLeaseMember = {memberId:uuid,leaseId:uuid,ordinal:int,poolId:uuid,units:int}; ordinals follow poolId byte order and Pool IDs are unique
- CapacityLease adds members:[GangLeaseMember]; legacy poolId and units remain populated for one Member and are null for a Gang Lease

新增或变更的公开接口：

- POST /api/v1/capacity-leases accepts either legacy poolId plus units or members:[{poolId,units}], never both; a Manager request with 2-10 Members returns one HELD Gang Lease or one WAITING Gang Admission Entry.
- Confirm, renew, release, detail, timeline, and promotion semantics apply to the complete captured Member set and preserve the V1 endpoint shapes.
- GET /api/v1/capacity-leases/:leaseId/members returns {items:[GangLeaseMember]} in immutable ordinal order.

新增稳定错误：

- 400 INVALID_GANG_MEMBERS: member count, duplicate Pool, units, or mixed legacy fields are invalid
- 409 GANG_CAPACITY_UNAVAILABLE: at least one Member Pool cannot cover the complete interval
- 409 GANG_STATE_CONFLICT: persisted Member states differ from the aggregate transition

跨层规则：

- The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
- The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
- Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
- Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

FINAL snapshot 与性能兼容合同：

The FINAL verification snapshot 'resources' object has exactly the union of these V1 and Manager resource specifications, with no other keys:

- 'owners' uses exact shape 'CapacityOwner = {ownerId:uuid,name:string}' and sorts ascending by scalar field-path tuple 'ownerId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'capacityPools' uses exact shape 'CapacityPool' and sorts ascending by scalar field-path tuple 'poolId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'capacityLeases' uses exact shape 'CapacityLease' and sorts ascending by scalar field-path tuple 'leaseId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'admissionEntries' uses exact shape 'AdmissionEntry' and sorts ascending by scalar field-path tuple 'poolId', 'priority', 'requestedAt', 'admissionEntryId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'capacitySlices' uses exact shape 'CapacitySlice' and sorts ascending by scalar field-path tuple 'poolId', 'startAt', 'endAt', then by RFC 8785 canonical JSON as the tie-breaker.
- 'gangLeaseMembers' uses exact shape 'GangLeaseMember' and sorts ascending by scalar field-path tuple 'leaseId', 'ordinal', 'memberId', then by RFC 8785 canonical JSON as the tie-breaker.

The Manager-added resource specifications are exactly:

- 'gangLeaseMembers' uses exact shape 'GangLeaseMember' and sorts ascending by scalar field-path tuple 'leaseId', 'ordinal', 'memberId', then by RFC 8785 canonical JSON as the tie-breaker.

The FINAL Work kind enum is exactly the union 'LEASE_EXPIRY', 'ADMISSION_PROMOTION'. The Manager-added
Work kinds are exactly (none). All V1 snapshot point-in-time,
recursive '*Token' omission, sorting, Work state/lease/retention/drain, and Domain Event rules remain
mandatory. The FINAL binary reruns exactly these three V1-compatible scenarios:

- 'pool-timeline-read': serve 400 Pool timeline reads/s with p95 <= 120 ms; threshold: At least 400 successful timeline reads/s for 60 seconds and p95 <= 120 ms; mixed revisions and unexpected 5xx are zero.
- 'independent-hold-create': create 120 independent Holds/s with p95 <= 350 ms; threshold: At least 120 successful Holds/s for 60 seconds and p95 <= 350 ms; waiting responses and unexpected 5xx do not count.
- 'expiry-promotion-recovery': expire 10,000 Holds and promote 10,000 waiting requests within 90 s after recovery; threshold: Both 10,000-record backlogs drain in <= 90 seconds after replacement spawn; oversubscription, stale commit, and unexpected failure counts are zero.

Their published setup, selector, request, concurrency, warm-up, measurement, timer, success condition,
and threshold remain unchanged. This Manager change adds correctness, concurrency, and recovery
assertions only; it does not replace or relax a performance scenario.

迁移必须同时满足：

- Migrate every V1 Lease to one Member without changing capacity, state, deadline, Admission order, Work, event, or replay identity.
- Pending expiry and promotion Work retains exact aggregateId, attempt, lease, and ordering data.
- Old clients continue creating and managing one-Pool Leases with unchanged request and response semantics.

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
