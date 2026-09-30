# QuotaMesh 项目设计说明

## 1. 定位

QuotaMesh 是一个从近空白 Git fixture 开始的高难度全栈 Coding Benchmark，主流程是
multi-dimension tenant quota reservation。这是 learning task，用于形成可迁移的工程经验。

本题只用一个主流程承载难度，重点测量：quantity conservation、atomic vector allocation、expiry races、fair admission、hierarchical migration。领域词汇以
[CONTEXT.md](./CONTEXT.md) 为准。

## 2. 可见性

Codex 初始只能看到 'workspace/README.md'、'workspace/AGENTS.md' 和独立 fixture Git 历史。
Manager 变更、Checklist、对话状态机、评测方案和实验 metadata 都在 workspace 外，不能在
开发回合、Session Evolution 或盲审前复制或透露。

## 3. 完整 V1

- Create Quota Pools and atomically reserve vectors across all requested Dimensions.
- Commit, release, or expire Reservations with one terminal winner across API instances.
- Queue rejected admission requests and promote them fairly when complete vectors fit.
- Recover expiry and promotion after worker death without process-local counters.
- Expose capacity, held/committed quantities, queue position, histories, and event delivery in the UI.

核心状态：Reservation: HELD -> COMMITTED | RELEASED | EXPIRED; terminal transitions are mutually exclusive.

### 可计算不变量

1. For each Pool and Dimension, held plus committed quantity never exceeds capacity and no value is negative.
2. A Reservation owns its complete requested vector or owns none.
3. Commit, release, or expiry adjusts each Dimension exactly once.
4. An Admission Queue entry produces at most one Reservation and cannot bypass an eligible earlier entry of equal priority.
5. All mutation replay remains stable across restart and concurrent API instances.

## 4. Manager 固定变更

V1、真实 Browser E2E、双 API/双 Worker 并发与恢复完成后，T16 才发布
“hierarchical organization and project quotas”。它改变核心基数、状态或一致性边界：

- Quota Pools form a two-level Organization -> Project hierarchy, with each Project capacity bounded by its Organization allocation.
- A Project Reservation atomically consumes both Project and Organization available vectors.
- Sibling Projects compete under stable priority and requestedAt ordering; unused Project allocation is not implicitly borrowable.
- Organization capacity changes succeed only when every child allocation and active Reservation remains valid.
- Commit, release, expiry, and promotion update both levels exactly once under concurrency.
- Legacy flat Pools migrate as Organizations with one default Project and retain singular pool fields for default-project queries.

新增 wire schema：

- QuotaOrganization = {organizationId:uuid,tenantId:uuid,name:string,capacity:{dimension:int},allocated:{dimension:int},held:{dimension:int},committed:{dimension:int},revision:int}; allocated is the sum of child Project allocations and available equals capacity-held-committed
- QuotaProject = {projectId:uuid,organizationId:uuid,name:string,allocation:{dimension:int},held:{dimension:int},committed:{dimension:int},revision:int}; available equals allocation-held-committed
- Reservation, Commitment, and AdmissionEntry add organizationId:uuid and projectId:uuid, and their poolId becomes uuid|null. New hierarchy records have poolId null; records migrated from a flat Pool retain poolId and also reference the created Organization and default Project

新增或变更的公开接口：

- POST /api/v1/quota-organizations with {tenantId,name,capacity} returns 201 QuotaOrganization; POST /api/v1/quota-organizations/:organizationId/projects with {name,allocation} returns 201 QuotaProject only when each new allocated total remains <= Organization capacity.
- POST /api/v1/quota-organizations/:organizationId/projects/:projectId/reservations with {ownerId,quantities,ttlSeconds} atomically increments Project and Organization held vectors; Project capacity is checked before Organization capacity and either every Dimension changes or none.
- PUT /api/v1/quota-organizations/:organizationId/capacity with {capacity,expectedRevision} and PUT /api/v1/quota-organizations/:organizationId/projects/:projectId/allocation with {allocation,expectedOrganizationRevision,expectedProjectRevision} use compare-and-set and return exact updated totals.
- GET /api/v1/quota-organizations/:organizationId and GET /api/v1/quota-organizations/:organizationId/projects/:projectId return the exact hierarchy shapes used to recompute both conservation levels.
- POST /api/v1/admission-queue accepts either legacy {poolId,ownerId,quantities,priority} or hierarchy {organizationId,projectId,ownerId,quantities,priority}, never both; hierarchy entries compete within one Organization by priority descending, requestedAt ascending, admissionEntryId ascending and only the first entry is considered for promotion.
- Legacy /api/v1/quota-pools/:poolId routes map to the migrated default Project and retain V1 request and response fields.

新增稳定错误：

- 409 PROJECT_QUOTA_EXCEEDED: the complete vector does not fit Project allocation or current available quantities
- 409 ORGANIZATION_QUOTA_EXCEEDED: the vector fits the Project but not Organization available quantities
- 409 QUOTA_HIERARCHY_REVISION_CHANGED: an expected Organization or Project revision is stale
- 409 ORGANIZATION_CAPACITY_CONFLICT: new capacity is below usage or allocated child totals
- 409 PROJECT_ALLOCATION_CONFLICT: new allocation makes child totals exceed Organization capacity or is below Project usage

跨层规则：

- The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
- The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
- Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
- Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

FINAL snapshot 与性能兼容合同：

The FINAL verification snapshot 'resources' object has exactly the union of these V1 and Manager resource specifications, with no other keys:

- 'dimensions' uses exact shape 'Dimension = {name:string,unit:string}' and sorts ascending by scalar field-path tuple 'name', then by RFC 8785 canonical JSON as the tie-breaker.
- 'quotaPools' uses exact shape 'QuotaPool' and sorts ascending by scalar field-path tuple 'poolId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'reservations' uses exact shape 'Reservation' and sorts ascending by scalar field-path tuple 'reservationId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'commitments' uses exact shape 'Commitment' and sorts ascending by scalar field-path tuple 'commitmentId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'admissionEntries' uses exact shape 'AdmissionEntry' and sorts ascending by scalar field-path tuple 'admissionEntryId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'quotaOrganizations' uses exact shape 'QuotaOrganization' and sorts ascending by scalar field-path tuple 'organizationId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'quotaProjects' uses exact shape 'QuotaProject' and sorts ascending by scalar field-path tuple 'projectId', then by RFC 8785 canonical JSON as the tie-breaker.

The Manager-added resource specifications are exactly:

- 'quotaOrganizations' uses exact shape 'QuotaOrganization' and sorts ascending by scalar field-path tuple 'organizationId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'quotaProjects' uses exact shape 'QuotaProject' and sorts ascending by scalar field-path tuple 'projectId', then by RFC 8785 canonical JSON as the tie-breaker.

The FINAL Work kind enum is exactly the union 'RESERVATION_EXPIRY', 'ADMISSION_PROMOTION'. The Manager-added
Work kinds are exactly (none). All V1 snapshot point-in-time,
recursive '*Token' omission, sorting, Work state/lease/retention/drain, and Domain Event rules remain
mandatory. The FINAL binary reruns exactly these three V1-compatible scenarios:

- 'quota-pool-read': serve 500 quota reads/s with p95 <= 100 ms; threshold: At least 500 successful reads/s for 60 seconds and p95 <= 100 ms; inconsistent vectors and unexpected 5xx are zero.
- 'hot-pool-reservation-race': process 200 hot-pool Reservation races/s with p95 <= 400 ms; threshold: At least 200 complete attempts/s for 60 seconds and all-response p95 <= 400 ms with exact 80% 201 and 20% expected 409 over each 100 attempts.
- 'expiry-and-admission-recovery': expire 20,000 HELD Reservations and promote 20,000 Admission Entries within 60 s after recovery; threshold: Both 20,000-record backlogs drain in <= 60 seconds after replacement spawn; oversubscription, stale commit, and unexpected failure counts are zero.

Their published setup, selector, request, concurrency, warm-up, measurement, timer, success condition,
and threshold remain unchanged. This Manager change adds correctness, concurrency, and recovery
assertions only; it does not replace or relax a performance scenario.

迁移必须同时满足：

- Existing Reservations, Commitments, queue order, expiry instants, events, and replay bodies remain unchanged.
- Pending Expiry Tasks continue against the default Project created by migration.
- No migration step may temporarily over-allocate an Organization or Project.

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
