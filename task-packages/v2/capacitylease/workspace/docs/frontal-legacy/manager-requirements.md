【Product Manager · Maya】

V1 已完成并通过基础验收。本期正式增加“cross-pool all-or-nothing gang leases”。以下业务规则、wire schema、接口和错误全部是公开增量合同。

业务规则：

1. A Gang Lease contains 2-10 Pool Members sharing one owner, interval, priority, state, hold expiry, and revision.
2. Each Member requests positive units from a distinct Pool and every Pool must have capacity for the complete interval.
3. Creation locks Pools in poolId byte order and commits every Member Hold or none.
4. Confirm, renew, release, and expiry transition every Member atomically; no partial Gang state is externally visible.
5. A failed gang request may wait as one Gang Admission Entry and promotes only when all Members fit simultaneously.
6. Legacy one-Pool Leases migrate to one Member while keeping old response bodies and endpoints unchanged.
7. Migrate every V1 Lease to one Member without changing capacity, state, deadline, Admission order, Work, event, or replay identity.
8. Pending expiry and promotion Work retains exact aggregateId, attempt, lease, and ordering data.
9. Old clients continue creating and managing one-Pool Leases with unchanged request and response semantics.
10. The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
11. The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
12. Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
13. Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

新增 wire schema：

- GangLeaseMember = {memberId:uuid,leaseId:uuid,ordinal:int,poolId:uuid,units:int}; ordinals follow poolId byte order and Pool IDs are unique
- CapacityLease adds members:[GangLeaseMember]; legacy poolId and units remain populated for one Member and are null for a Gang Lease

新增或变更接口：

- POST /api/v1/capacity-leases accepts either legacy poolId plus units or members:[{poolId,units}], never both; a Manager request with 2-10 Members returns one HELD Gang Lease or one WAITING Gang Admission Entry.
- Confirm, renew, release, detail, timeline, and promotion semantics apply to the complete captured Member set and preserve the V1 endpoint shapes.
- GET /api/v1/capacity-leases/:leaseId/members returns {items:[GangLeaseMember]} in immutable ordinal order.

新增稳定错误：

- 400 INVALID_GANG_MEMBERS: member count, duplicate Pool, units, or mixed legacy fields are invalid
- 409 GANG_CAPACITY_UNAVAILABLE: at least one Member Pool cannot cover the complete interval
- 409 GANG_STATE_CONFLICT: persisted Member states differ from the aggregate transition

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

本轮先不要实现。请先说明它会影响哪些领域关系、模块、schema、migration、接口、状态、成功与失败数据流、兼容性、Worker、事件、前端、并发、恢复和性能测试，然后给出分阶段修改计划。