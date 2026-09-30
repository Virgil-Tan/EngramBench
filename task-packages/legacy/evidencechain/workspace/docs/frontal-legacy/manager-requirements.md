【Product Manager · Maya】

V1 已完成并通过基础验收。本期正式增加“aliquot split and composite lineage”。以下业务规则、wire schema、接口和错误全部是公开增量合同。

业务规则：

1. A verified Collected Item may split into 2-20 Aliquots whose integer quantities sum exactly to the parent quantity.
2. One Intake Scan batch may observe all Aliquots; confirmation creates one Custody Match Group atomically.
3. The parent becomes CONSUMED_BY_SPLIT and can no longer transfer custody independently.
4. Each Aliquot has its own seal, verification, custodian, and transfer chain while retaining immutable parent lineage.
5. Reversing an untransferred split restores the parent and removes active child custody atomically; a transferred child makes reversal illegal.
6. Legacy unsplit items keep singular intakeScan and custody fields; split items expose aliquots[] and singular fields are null.
7. Existing items become unsplit roots without changing labels, custody chains, verification, events, or replay bodies.
8. Pending Verification Tasks retain their target and lease state.
9. Existing one-to-one Custody Matches remain valid Match Groups of one with splitId null, their original collectedItemId populated, aliquotId null, and their exact PROPOSED, CONFIRMED, or REVERSED state and timestamps preserved.
10. The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
11. The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
12. Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
13. Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

新增 wire schema：

- Aliquot = {aliquotId:uuid,parentItemId:uuid,quantity:int,sealCode:string,state:EXPECTED|RECEIVED|VERIFIED|QUARANTINED,currentCustodianId:uuid|null,intakeScanId:uuid|null,revision:int}
- ItemSplit = {splitId:uuid,parentItemId:uuid,totalQuantity:int,aliquots:[Aliquot],state:ACTIVE|REVERSED,createdAt:timestamp,reversedAt:timestamp|null}
- ItemSplitDetail = {split:ItemSplit,parent:CollectedItem,parentTimeline:[EvidenceTimelineItem],aliquotTimelines:[{aliquotId:uuid,items:[EvidenceTimelineItem]}]}; aliquotTimelines follows ItemSplit.aliquots order and every items array sorts by sequence
- CustodyMatchGroup = {custodyMatchGroupId:uuid,splitId:uuid|null,state:PROPOSED|CONFIRMED|REVERSED,members:[{collectedItemId:uuid|null,aliquotId:uuid|null,intakeScanId:uuid}],createdAt:timestamp,confirmedAt:timestamp|null,reversedAt:timestamp|null,sequence:int}; exactly one of collectedItemId and aliquotId is non-null. A split Group has non-null splitId, is created directly as CONFIRMED, contains every active Aliquot once, and sorts by aliquotId; a legacy unsplit Group has splitId null and one member with collectedItemId populated and aliquotId null and preserves its prior state, including PROPOSED with confirmedAt null
- After the Manager change, CollectedItem.state additionally allows CONSUMED_BY_SPLIT; quantity remains immutable and singular currentCustodianId and intakeScanId are null in that state

新增或变更接口：

- POST /api/v1/collected-items/:itemId/splits with {expectedRevision,aliquots:[{aliquotId,quantity,sealCode}]} requires the positive safe-integer quantities to sum exactly to the stored CollectedItem.quantity, atomically changes the parent to CONSUMED_BY_SPLIT, and returns ItemSplit
- POST /api/v1/item-splits/:splitId/reverse with {reason} restores the parent only when no Aliquot has a Custody Transfer
- GET /api/v1/item-splits/:splitId returns the exact ItemSplitDetail with the parent timeline and one ordered timeline for each Aliquot
- POST /api/v1/custody-match-groups with {splitId,members:[{aliquotId,intakeScanId}]} requires every active Aliquot of the split exactly once and distinct current Intake Scans, confirms every pair atomically, and returns 201 CustodyMatchGroup; GET /api/v1/custody-match-groups/:custodyMatchGroupId returns the exact group shape

新增稳定错误：

- 409 ALIQUOT_QUANTITY_MISMATCH: Aliquot positive integer quantities do not sum to parent quantity
- 409 SPLIT_NOT_REVERSIBLE: an Aliquot has transferred custody or split is not ACTIVE
- 409 CUSTODY_MATCH_GROUP_CONFLICT: any Aliquot or Intake Scan is stale or already matched

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

本轮先不要实现。请先说明它会影响哪些领域关系、模块、schema、migration、接口、状态、成功与失败数据流、兼容性、Worker、事件、前端、并发、恢复和性能测试，然后给出分阶段修改计划。