【Product Manager · Maya】

V1 已完成并通过基础验收。本期正式增加“atomic multi-beneficiary milestone settlement”。以下业务规则、wire schema、接口和错误全部是公开增量合同。

业务规则：

1. A Milestone may distribute its amount across 1-20 Beneficiary Shares whose exact integer sum equals that Milestone amount.
2. Each Beneficiary Share has a stable ordinal, beneficiaryId, and amountMinor captured when the Escrow is funded.
3. Accepting or resolving RELEASE creates every beneficiary payout atomically or creates none.
4. One failed or conflicting beneficiary allocation leaves the Milestone SUBMITTED or DISPUTED and Fund Position unchanged.
5. Legacy one-Seller Milestones migrate to one Beneficiary Share and preserve their original Release response byte-for-byte.
6. Refund and expiry never create beneficiary payouts and still refund the complete unreleased Milestone amount.
7. Migrate every V1 Milestone to one Seller Beneficiary Share without changing Escrow, Milestone, Release, event, Work, or replay identity.
8. Pending Expiry Tasks retain their exact deadline, attempt, and lease state.
9. Old clients may continue creating, accepting, resolving, and reading one-Seller Escrows without sending beneficiary fields.
10. The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
11. The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
12. Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
13. Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

新增 wire schema：

- BeneficiaryShare = {beneficiaryShareId:uuid,milestoneId:uuid,ordinal:int,beneficiaryId:uuid,amountMinor:int}; ordinals are contiguous and amounts sum to Milestone.amountMinor
- BeneficiaryPayout = {payoutId:uuid,releaseId:uuid,beneficiaryShareId:uuid,beneficiaryId:uuid,amountMinor:int,createdAt:timestamp}; Release adds payouts:[BeneficiaryPayout] ordered by share ordinal

新增或变更接口：

- POST /api/v1/escrows accepts each Milestone as either legacy {title,amountMinor} or {title,amountMinor,beneficiaries:[{beneficiaryId,amountMinor}]}; mixed Milestone forms are allowed but each beneficiary list must sum exactly.
- GET /api/v1/escrows/:escrowId exposes beneficiaryShares and beneficiaryPayouts; legacy one-Seller responses retain their old fields and semantic replay.
- Every release path locks the current Milestone and all its shares in ordinal order, validates the complete captured allocation, and creates one Release plus all payouts in one transaction.

新增稳定错误：

- 400 INVALID_BENEFICIARY_ALLOCATION: share count, duplicate beneficiary, amount, or exact sum is invalid
- 409 BENEFICIARY_PAYOUT_CONFLICT: an existing payout set differs from the captured canonical shares

FINAL snapshot 与性能兼容合同：

The FINAL verification snapshot 'resources' object has exactly the union of these V1 and Manager resource specifications, with no other keys:

- 'parties' uses exact shape 'Party = {partyId:uuid,displayName:string}' and sorts ascending by scalar field-path tuple 'partyId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'escrows' uses exact shape 'Escrow' and sorts ascending by scalar field-path tuple 'escrowId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'milestones' uses exact shape 'Milestone' and sorts ascending by scalar field-path tuple 'escrowId', 'ordinal', 'milestoneId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'disputes' uses exact shape 'Dispute' and sorts ascending by scalar field-path tuple 'escrowId', 'openedAt', 'disputeId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'releases' uses exact shape 'Release' and sorts ascending by scalar field-path tuple 'escrowId', 'createdAt', 'releaseId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'beneficiaryShares' uses exact shape 'BeneficiaryShare' and sorts ascending by scalar field-path tuple 'milestoneId', 'ordinal', 'beneficiaryShareId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'beneficiaryPayouts' uses exact shape 'BeneficiaryPayout' and sorts ascending by scalar field-path tuple 'releaseId', 'beneficiaryShareId', 'payoutId', then by RFC 8785 canonical JSON as the tie-breaker.

The Manager-added resource specifications are exactly:

- 'beneficiaryShares' uses exact shape 'BeneficiaryShare' and sorts ascending by scalar field-path tuple 'milestoneId', 'ordinal', 'beneficiaryShareId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'beneficiaryPayouts' uses exact shape 'BeneficiaryPayout' and sorts ascending by scalar field-path tuple 'releaseId', 'beneficiaryShareId', 'payoutId', then by RFC 8785 canonical JSON as the tie-breaker.

The FINAL Work kind enum is exactly the union 'ESCROW_EXPIRY'. The Manager-added
Work kinds are exactly (none). All V1 snapshot point-in-time,
recursive '*Token' omission, sorting, Work state/lease/retention/drain, and Domain Event rules remain
mandatory. The FINAL binary reruns exactly these three V1-compatible scenarios:

- 'escrow-detail-read': serve 300 Escrow detail reads/s with p95 <= 140 ms; threshold: At least 300 successful reads/s for 60 seconds and p95 <= 140 ms; mixed revisions and unexpected 5xx are zero.
- 'funded-escrow-create': create 80 funded Escrows/s with p95 <= 500 ms; threshold: At least 80 successful Escrows/s for 60 seconds and p95 <= 500 ms; partial funding and unexpected 5xx counts are zero.
- 'escrow-expiry-recovery': expire and refund 5,000 Escrows within 75 s after worker recovery; threshold: The complete backlog drains in <= 75 seconds after replacement spawn; stale commits, partial refunds, and unexpected failures are zero.

Their published setup, selector, request, concurrency, warm-up, measurement, timer, success condition,
and threshold remain unchanged. This Manager change adds correctness, concurrency, and recovery
assertions only; it does not replace or relax a performance scenario.

本轮先不要实现。请先说明它会影响哪些领域关系、模块、schema、migration、接口、状态、成功与失败数据流、兼容性、Worker、事件、前端、并发、恢复和性能测试，然后给出分阶段修改计划。