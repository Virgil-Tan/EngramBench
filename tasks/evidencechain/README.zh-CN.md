# EvidenceChain 项目设计说明

## 1. 定位

EvidenceChain 是一个从近空白 Git fixture 开始的高难度全栈 Coding Benchmark，主流程是
forensic evidence manifest reconciliation and custody。这是 Learning task；它的 Trajectory 与隐藏测试结果用于 Skill Evolution，不属于 13 个 Transfer/Test task。

本题只用一个主流程承载难度，重点测量：identity reconciliation、custody exclusivity、atomic batch intake、split lineage、offline replay。领域词汇以
[CONTEXT.md](./CONTEXT.md) 为准。

## 2. 可见性

Codex 初始只能看到 'workspace/README.md'、'workspace/AGENTS.md' 和独立 fixture Git 历史。
Manager 变更、Checklist、对话状态机、评测方案和实验 metadata 都在 workspace 外，不能在
开发回合、Session Evolution 或盲审前复制或透露。

## 3. 完整 V1

- Import scanner batches atomically and durably deduplicate scans from intermittently connected devices.
- Suggest and confirm one-to-one Custody Matches using exact published label and seal rules.
- Run recoverable Verification Tasks and quarantine failures without losing original observations.
- Transfer custody with compare-and-set current custodian and immutable handoff history.
- Expose missing, unmatched, quarantined, and custody timelines through real coordinator UI flows.

核心状态：Collected Item: EXPECTED -> RECEIVED -> VERIFIED | QUARANTINED; Custody Match: PROPOSED -> CONFIRMED | REVERSED.

### 可计算不变量

1. An Intake Scan is active in at most one Custody Match.
2. A Collected Item is active in at most one Custody Match in V1.
3. Exactly one custodian owns a received item at an instant and each accepted transfer links to the prior one.
4. A scanner batch is wholly accepted or leaves no scans, tasks, matches, or events.
5. Verification never changes the immutable observed label, seal, device sequence, or scannedAt.

## 4. Manager 固定变更

V1、真实 Browser E2E、双 API/双 Worker 并发与恢复完成后，T16 才发布
“aliquot split and composite lineage”。它改变核心基数、状态或一致性边界：

- A verified Collected Item may split into 2-20 Aliquots whose integer quantities sum exactly to the parent quantity.
- One Intake Scan batch may observe all Aliquots; confirmation creates one Custody Match Group atomically.
- The parent becomes CONSUMED_BY_SPLIT and can no longer transfer custody independently.
- Each Aliquot has its own seal, verification, custodian, and transfer chain while retaining immutable parent lineage.
- Reversing an untransferred split restores the parent and removes active child custody atomically; a transferred child makes reversal illegal.
- Legacy unsplit items keep singular intakeScan and custody fields; split items expose aliquots[] and singular fields are null.

新增 wire schema：

- Aliquot = {aliquotId:uuid,parentItemId:uuid,quantity:int,sealCode:string,state:EXPECTED|RECEIVED|VERIFIED|QUARANTINED,currentCustodianId:uuid|null,intakeScanId:uuid|null,revision:int}
- ItemSplit = {splitId:uuid,parentItemId:uuid,totalQuantity:int,aliquots:[Aliquot],state:ACTIVE|REVERSED,createdAt:timestamp,reversedAt:timestamp|null}
- ItemSplitDetail = {split:ItemSplit,parent:CollectedItem,parentTimeline:[EvidenceTimelineItem],aliquotTimelines:[{aliquotId:uuid,items:[EvidenceTimelineItem]}]}; aliquotTimelines follows ItemSplit.aliquots order and every items array sorts by sequence
- CustodyMatchGroup = {custodyMatchGroupId:uuid,splitId:uuid|null,state:PROPOSED|CONFIRMED|REVERSED,members:[{collectedItemId:uuid|null,aliquotId:uuid|null,intakeScanId:uuid}],createdAt:timestamp,confirmedAt:timestamp|null,reversedAt:timestamp|null,sequence:int}; exactly one of collectedItemId and aliquotId is non-null. A split Group has non-null splitId, is created directly as CONFIRMED, contains every active Aliquot once, and sorts by aliquotId; a legacy unsplit Group has splitId null and one member with collectedItemId populated and aliquotId null and preserves its prior state, including PROPOSED with confirmedAt null
- After the Manager change, CollectedItem.state additionally allows CONSUMED_BY_SPLIT; quantity remains immutable and singular currentCustodianId and intakeScanId are null in that state

新增或变更的公开接口：

- POST /api/v1/collected-items/:itemId/splits with {expectedRevision,aliquots:[{aliquotId,quantity,sealCode}]} requires the positive safe-integer quantities to sum exactly to the stored CollectedItem.quantity, atomically changes the parent to CONSUMED_BY_SPLIT, and returns ItemSplit
- POST /api/v1/item-splits/:splitId/reverse with {reason} restores the parent only when no Aliquot has a Custody Transfer
- GET /api/v1/item-splits/:splitId returns the exact ItemSplitDetail with the parent timeline and one ordered timeline for each Aliquot
- POST /api/v1/custody-match-groups with {splitId,members:[{aliquotId,intakeScanId}]} requires every active Aliquot of the split exactly once and distinct current Intake Scans, confirms every pair atomically, and returns 201 CustodyMatchGroup; GET /api/v1/custody-match-groups/:custodyMatchGroupId returns the exact group shape

新增稳定错误：

- 409 ALIQUOT_QUANTITY_MISMATCH: Aliquot positive integer quantities do not sum to parent quantity
- 409 SPLIT_NOT_REVERSIBLE: an Aliquot has transferred custody or split is not ACTIVE
- 409 CUSTODY_MATCH_GROUP_CONFLICT: any Aliquot or Intake Scan is stale or already matched

跨层规则：

- The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
- The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
- Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
- Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

FINAL snapshot 与性能兼容合同：

The FINAL verification snapshot 'resources' object has exactly the union of these V1 and Manager resource specifications, with no other keys:

- 'cases' uses exact shape 'Case = {caseId:uuid,caseNumber:string}' and sorts ascending by scalar field-path tuple 'caseId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'caseManifests' uses exact shape 'CaseManifest = {caseId:uuid,version:int,items:[{collectedItemId:uuid,expectedLabel:string,expectedSealCode:string,quantity:int}]}' and sorts ascending by scalar field-path tuple 'caseId', 'version', then by RFC 8785 canonical JSON as the tie-breaker.
- 'facilities' uses exact shape 'Facility = {facilityId:uuid,name:string,receivingCustodianId:uuid}' and sorts ascending by scalar field-path tuple 'facilityId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'custodians' uses exact shape 'Custodian = {custodianId:uuid,name:string}' and sorts ascending by scalar field-path tuple 'custodianId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'deviceRegistrations' uses exact shape 'DeviceRegistration = {deviceId:uuid,facilityId:uuid,lastBatchSequence:int}' and sorts ascending by scalar field-path tuple 'deviceId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'intakeScans' uses exact shape 'IntakeScan' and sorts ascending by scalar field-path tuple 'intakeScanId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'collectedItems' uses exact shape 'CollectedItem' and sorts ascending by scalar field-path tuple 'collectedItemId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'custodyMatches' uses exact shape 'CustodyMatch' and sorts ascending by scalar field-path tuple 'matchId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'custodyTransfers' uses exact shape 'CustodyTransfer' and sorts ascending by scalar field-path tuple 'transferId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'itemSplits' uses exact shape 'ItemSplit' and sorts ascending by scalar field-path tuple 'splitId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'aliquots' uses exact shape 'Aliquot' and sorts ascending by scalar field-path tuple 'aliquotId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'custodyMatchGroups' uses exact shape 'CustodyMatchGroup' and sorts ascending by scalar field-path tuple 'custodyMatchGroupId', then by RFC 8785 canonical JSON as the tie-breaker.

The Manager-added resource specifications are exactly:

- 'itemSplits' uses exact shape 'ItemSplit' and sorts ascending by scalar field-path tuple 'splitId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'aliquots' uses exact shape 'Aliquot' and sorts ascending by scalar field-path tuple 'aliquotId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'custodyMatchGroups' uses exact shape 'CustodyMatchGroup' and sorts ascending by scalar field-path tuple 'custodyMatchGroupId', then by RFC 8785 canonical JSON as the tie-breaker.

The FINAL Work kind enum is exactly the union 'EVIDENCE_VERIFICATION'. The Manager-added
Work kinds are exactly (none). All V1 snapshot point-in-time,
recursive '*Token' omission, sorting, Work state/lease/retention/drain, and Domain Event rules remain
mandatory. The FINAL binary reruns exactly these three V1-compatible scenarios:

- 'scanner-batch-ingest': ingest 100 scanner batches/s with p95 <= 350 ms; threshold: At least 100 complete successful batch responses/s for 60 seconds and p95 <= 350 ms; unexpected 5xx = 0.
- 'custody-timeline-read': serve 200 custody timeline reads/s with p95 <= 180 ms; threshold: At least 200 successful reads/s for 60 seconds and p95 <= 180 ms; unexpected 5xx = 0.
- 'verification-recovery': verify 10,000 scans within 60 s after worker recovery; threshold: All 10,000 Work records become terminal in <= 60 seconds after replacement spawn; stale commits and unexpected failures are zero.

Their published setup, selector, request, concurrency, warm-up, measurement, timer, success condition,
and threshold remain unchanged. This Manager change adds correctness, concurrency, and recovery
assertions only; it does not replace or relax a performance scenario.

迁移必须同时满足：

- Existing items become unsplit roots without changing labels, custody chains, verification, events, or replay bodies.
- Pending Verification Tasks retain their target and lease state.
- Existing one-to-one Custody Matches remain valid Match Groups of one with splitId null, their original collectedItemId populated, aliquotId null, and their exact PROPOSED, CONFIRMED, or REVERSED state and timestamps preserved.

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
