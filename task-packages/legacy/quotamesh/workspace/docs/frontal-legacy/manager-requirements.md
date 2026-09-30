【Product Manager · Maya】

V1 已完成并通过基础验收。本期正式增加“hierarchical organization and project quotas”。以下业务规则、wire schema、接口和错误全部是公开增量合同。

业务规则：

1. Quota Pools form a two-level Organization -> Project hierarchy, with each Project capacity bounded by its Organization allocation.
2. A Project Reservation atomically consumes both Project and Organization available vectors.
3. Sibling Projects compete under stable priority and requestedAt ordering; unused Project allocation is not implicitly borrowable.
4. Organization capacity changes succeed only when every child allocation and active Reservation remains valid.
5. Commit, release, expiry, and promotion update both levels exactly once under concurrency.
6. Legacy flat Pools migrate as Organizations with one default Project and retain singular pool fields for default-project queries.
7. Existing Reservations, Commitments, queue order, expiry instants, events, and replay bodies remain unchanged.
8. Pending Expiry Tasks continue against the default Project created by migration.
9. No migration step may temporarily over-allocate an Organization or Project.
10. The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
11. The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
12. Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
13. Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

新增 wire schema：

- QuotaOrganization = {organizationId:uuid,tenantId:uuid,name:string,capacity:{dimension:int},allocated:{dimension:int},held:{dimension:int},committed:{dimension:int},revision:int}; allocated is the sum of child Project allocations and available equals capacity-held-committed
- QuotaProject = {projectId:uuid,organizationId:uuid,name:string,allocation:{dimension:int},held:{dimension:int},committed:{dimension:int},revision:int}; available equals allocation-held-committed
- Reservation, Commitment, and AdmissionEntry add organizationId:uuid and projectId:uuid, and their poolId becomes uuid|null. New hierarchy records have poolId null; records migrated from a flat Pool retain poolId and also reference the created Organization and default Project

新增或变更接口：

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

本轮先不要实现。请先说明它会影响哪些领域关系、模块、schema、migration、接口、状态、成功与失败数据流、兼容性、Worker、事件、前端、并发、恢复和性能测试，然后给出分阶段修改计划。