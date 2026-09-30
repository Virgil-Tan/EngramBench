# CarbonLedger 项目设计说明

## 1. 定位

CarbonLedger 是一个从近空白 Git fixture 开始的高难度全栈 Coding Benchmark，主流程是
carbon credit lot reservation and retirement。这是 transfer task；正式 paired curriculum 为 `quotamesh` learning -> `carbonledger` transfer。

本题只用一个主流程承载难度，重点测量：quantity conservation、provenance authority、atomic retirement、certificate recovery、split-lot migration。领域词汇以
[CONTEXT.md](./CONTEXT.md) 为准。

## 2. 可见性

Codex 初始只能看到 'workspace/README.md'、'workspace/AGENTS.md' 和独立 fixture Git 历史。
Manager 变更、Checklist、对话状态机、评测方案和实验 metadata 都在 workspace 外，不能在
开发回合、Session Evolution 或盲审前复制或透露。

## 3. 完整 V1

- Import verified Credit Lots and create a Retirement from the first eligible single Lot in stable order.
- Reserve integer grams atomically and release or expire unfinished requests exactly once.
- Generate one deterministic Certificate in a recoverable worker before final retirement.
- Prevent competing retirements from over-consuming a Lot across API and worker processes.
- Expose lot provenance, availability, Retirement progress, Certificate download, and Registry Events in the UI.

核心状态：Retirement: RESERVED -> CERTIFYING -> RETIRED, or RESERVED -> RELEASED | EXPIRED | FAILED.

### 可计算不变量

1. For every Credit Lot, issuedGrams = availableGrams + reservedGrams + retiredGrams and all terms are non-negative.
2. A V1 Retirement allocates exactly one eligible Credit Lot or allocates nothing.
3. Each Retirement publishes at most one Certificate whose quantity, beneficiary, Lot, and digest match committed state.
4. Released, expired, or failed Retirements never increase retiredGrams.
5. Registry Events and Certificate publication cannot exist for rolled-back retirement state.

## 4. Manager 固定变更

V1、真实 Browser E2E、双 API/双 Worker 并发与恢复完成后，T16 才发布
“cross-lot retirement with provenance allocations”。它改变核心基数、状态或一致性边界：

- When no single eligible Credit Lot can satisfy a Retirement, allocate across 2-20 Lots in priority descending, projectId ascending, vintage ascending, creditLotId ascending order.
- Use a single Lot whenever possible; otherwise all Lot Allocations commit atomically or none.
- The Certificate lists every Lot Allocation, quantity, provenance digest, and exact total.
- Concurrent Certificate Tasks may read allocations but only one publishes the canonical Certificate and retires all Lots.
- Release or expiry returns every reserved quantity atomically before certification begins.
- Legacy singular lot and allocation fields remain populated for one-Lot Retirements and are null for split Retirements, which expose allocations[].

新增 wire schema：

- LotAllocation = {lotAllocationId:uuid,retirementId:uuid,ordinal:int,creditLotId:uuid,quantityGrams:int,projectId:uuid,vintage:int,methodology:string,provenanceDigest:sha256}; ordinals are contiguous from 1 in selection order
- Retirement adds allocations:[LotAllocation]; legacy allocation remains populated when allocations.length is 1 and is null when allocations.length is greater than 1
- SplitCertificate = {certificateVersion:2,retirementId:uuid,beneficiaryId:uuid,totalQuantityGrams:int,allocations:[{ordinal:int,creditLotId:uuid,quantityGrams:int,projectId:uuid,vintage:int,methodology:string,provenanceDigest:sha256}],retiredAt:timestamp}; bytes are RFC 8785 JSON and certificateDigest is their SHA-256

新增或变更的公开接口：

- POST /api/v1/retirements keeps its V1 request. If one eligible Lot covers quantityGrams, select the first Lot under V1 order; otherwise sort positive eligible Lots by priority descending, projectId ascending, vintage ascending, creditLotId ascending and greedily allocate min(availableGrams,remainingGrams) from the first stable prefix of at most 20 Lots.
- Cross-Lot creation returns 202 only when allocations sum exactly to quantityGrams; every selected Lot moves availableGrams to reservedGrams in one transaction, while insufficient total capacity returns existing CREDIT_UNAVAILABLE with no effect.
- GET /api/v1/retirements/:retirementId returns allocations by ordinal and GET /api/v1/retirements/:retirementId/allocations returns {items:[LotAllocation]} in the same immutable order.
- POST /api/v1/retirements/:retirementId/release with {reason} returns every allocation reservedGrams to availableGrams in one transaction or changes none.
- GET /api/v1/retirements/:retirementId/certificate preserves exact Certificate v1 bytes for every one-Lot Retirement; a split Retirement publishes SplitCertificate only after all Lots move reservedGrams to retiredGrams atomically.

新增稳定错误：

- 409 CROSS_LOT_LIMIT_EXCEEDED: eligible total capacity is sufficient only by consuming more than 20 Credit Lots
- 409 SPLIT_RETIREMENT_NOT_RELEASABLE: a split Retirement is no longer RESERVED, so no Lot Allocation may be released

跨层规则：

- The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
- The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
- Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
- Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

FINAL snapshot 与性能兼容合同：

The FINAL verification snapshot 'resources' object has exactly the union of these V1 and Manager resource specifications, with no other keys:

- 'projects' uses exact shape 'CarbonProject = {projectId:uuid,name:string}' and sorts ascending by scalar field-path tuple 'projectId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'beneficiaries' uses exact shape 'Beneficiary = {beneficiaryId:uuid,name:string}' and sorts ascending by scalar field-path tuple 'beneficiaryId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'creditLots' uses exact shape 'CreditLot' and sorts ascending by scalar field-path tuple 'creditLotId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'retirements' uses exact shape 'Retirement' and sorts ascending by scalar field-path tuple 'retirementId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'certificates' uses exact shape 'Certificate' and sorts ascending by scalar field-path tuple 'retirementId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'lotAllocations' uses exact shape 'LotAllocation' and sorts ascending by scalar field-path tuple 'retirementId', 'ordinal', then by RFC 8785 canonical JSON as the tie-breaker.
- 'splitCertificates' uses exact shape 'SplitCertificate' and sorts ascending by scalar field-path tuple 'retirementId', then by RFC 8785 canonical JSON as the tie-breaker.

The Manager-added resource specifications are exactly:

- 'lotAllocations' uses exact shape 'LotAllocation' and sorts ascending by scalar field-path tuple 'retirementId', 'ordinal', then by RFC 8785 canonical JSON as the tie-breaker.
- 'splitCertificates' uses exact shape 'SplitCertificate' and sorts ascending by scalar field-path tuple 'retirementId', then by RFC 8785 canonical JSON as the tie-breaker.

The FINAL Work kind enum is exactly the union 'CERTIFICATE_GENERATION', 'RETIREMENT_EXPIRY'. The Manager-added
Work kinds are exactly (none). All V1 snapshot point-in-time,
recursive '*Token' omission, sorting, Work state/lease/retention/drain, and Domain Event rules remain
mandatory. The FINAL binary reruns exactly these three V1-compatible scenarios:

- 'lot-and-provenance-read': serve 300 lot/provenance reads/s with p95 <= 140 ms; threshold: At least 300 successful mixed reads/s for 60 seconds and p95 <= 140 ms; unexpected 5xx = 0.
- 'competing-retirement-create': create 80 competing Retirements/s with p95 <= 500 ms; threshold: At least 80 successful Retirements/s for 60 seconds and p95 <= 500 ms; Lot conservation and unexpected 5xx checks pass.
- 'certificate-recovery': generate and publish 5,000 Certificates within 90 s after recovery; threshold: All Certificates publish in <= 90 seconds after replacement spawn; partial objects, stale commits, and unexpected failures are zero.

Their published setup, selector, request, concurrency, warm-up, measurement, timer, success condition,
and threshold remain unchanged. This Manager change adds correctness, concurrency, and recovery
assertions only; it does not replace or relax a performance scenario.

迁移必须同时满足：

- Migrate each V1 Retirement to one Lot Allocation without changing lot totals, Certificate bytes/digest, events, or replay JSON.
- Pending Certificate Tasks continue with their exact Lot and lease state.
- Historical retired quantities and provenance references remain immutable.

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
