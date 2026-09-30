【Product Manager · Maya】

V1 已完成并通过基础验收。本期正式增加“cross-lot retirement with provenance allocations”。以下业务规则、wire schema、接口和错误全部是公开增量合同。

业务规则：

1. When no single eligible Credit Lot can satisfy a Retirement, allocate across 2-20 Lots in priority descending, projectId ascending, vintage ascending, creditLotId ascending order.
2. Use a single Lot whenever possible; otherwise all Lot Allocations commit atomically or none.
3. The Certificate lists every Lot Allocation, quantity, provenance digest, and exact total.
4. Concurrent Certificate Tasks may read allocations but only one publishes the canonical Certificate and retires all Lots.
5. Release or expiry returns every reserved quantity atomically before certification begins.
6. Legacy singular lot and allocation fields remain populated for one-Lot Retirements and are null for split Retirements, which expose allocations[].
7. Migrate each V1 Retirement to one Lot Allocation without changing lot totals, Certificate bytes/digest, events, or replay JSON.
8. Pending Certificate Tasks continue with their exact Lot and lease state.
9. Historical retired quantities and provenance references remain immutable.
10. The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
11. The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
12. Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
13. Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

新增 wire schema：

- LotAllocation = {lotAllocationId:uuid,retirementId:uuid,ordinal:int,creditLotId:uuid,quantityGrams:int,projectId:uuid,vintage:int,methodology:string,provenanceDigest:sha256}; ordinals are contiguous from 1 in selection order
- Retirement adds allocations:[LotAllocation]; legacy allocation remains populated when allocations.length is 1 and is null when allocations.length is greater than 1
- SplitCertificate = {certificateVersion:2,retirementId:uuid,beneficiaryId:uuid,totalQuantityGrams:int,allocations:[{ordinal:int,creditLotId:uuid,quantityGrams:int,projectId:uuid,vintage:int,methodology:string,provenanceDigest:sha256}],retiredAt:timestamp}; bytes are RFC 8785 JSON and certificateDigest is their SHA-256

新增或变更接口：

- POST /api/v1/retirements keeps its V1 request. If one eligible Lot covers quantityGrams, select the first Lot under V1 order; otherwise sort positive eligible Lots by priority descending, projectId ascending, vintage ascending, creditLotId ascending and greedily allocate min(availableGrams,remainingGrams) from the first stable prefix of at most 20 Lots.
- Cross-Lot creation returns 202 only when allocations sum exactly to quantityGrams; every selected Lot moves availableGrams to reservedGrams in one transaction, while insufficient total capacity returns existing CREDIT_UNAVAILABLE with no effect.
- GET /api/v1/retirements/:retirementId returns allocations by ordinal and GET /api/v1/retirements/:retirementId/allocations returns {items:[LotAllocation]} in the same immutable order.
- POST /api/v1/retirements/:retirementId/release with {reason} returns every allocation reservedGrams to availableGrams in one transaction or changes none.
- GET /api/v1/retirements/:retirementId/certificate preserves exact Certificate v1 bytes for every one-Lot Retirement; a split Retirement publishes SplitCertificate only after all Lots move reservedGrams to retiredGrams atomically.

新增稳定错误：

- 409 CROSS_LOT_LIMIT_EXCEEDED: eligible total capacity is sufficient only by consuming more than 20 Credit Lots
- 409 SPLIT_RETIREMENT_NOT_RELEASABLE: a split Retirement is no longer RESERVED, so no Lot Allocation may be released

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

本轮先不要实现。请先说明它会影响哪些领域关系、模块、schema、migration、接口、状态、成功与失败数据流、兼容性、Worker、事件、前端、并发、恢复和性能测试，然后给出分阶段修改计划。