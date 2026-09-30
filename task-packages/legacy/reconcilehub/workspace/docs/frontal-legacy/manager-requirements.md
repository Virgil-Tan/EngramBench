【Product Manager · Maya】

V1 已完成并通过基础验收。本期正式增加“many-to-many split reconciliation”。以下业务规则、wire schema、接口和错误全部是公开增量合同。

业务规则：

1. A Match Group may contain 1-20 Statement Lines and 1-20 Ledger Entries in one currency.
2. The sum of Statement Line amounts must equal the sum of Ledger Entry amounts before confirmation.
3. Every member is reserved and confirmed atomically; any already-active member rejects the whole group.
4. Reversal releases the complete Match Group; partial reversal is not supported.
5. Suggestions enumerate groups with at most four total members, order each side by date then ID, order combinations lexicographically by member IDs, and choose the first equal-currency equal-sum group after one-to-one candidates.
6. Legacy one-to-one Match fields remain populated for groups with one member on each side and are null otherwise.
7. Migrate every V1 Match to a two-member Match Group whose matchGroupId equals the existing matchId, without changing decisions, audit entries, events, or replay JSON.
8. Pending Suggestion Tasks continue against their captured eligible set.
9. Historical ignored and reversed lines retain their exact state.
10. The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
11. The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
12. Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
13. Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

新增 wire schema：

- MatchGroup = {matchGroupId:uuid,matchId:uuid|null,statementLineId:uuid|null,ledgerEntryId:uuid|null,statementLineIds:[uuid],ledgerEntryIds:[uuid],currency:currency,statementTotalMinor:int,ledgerTotalMinor:int,state:PROPOSED|CONFIRMED|REJECTED|REVERSED,createdAt:timestamp,confirmedAt:timestamp|null,reversedAt:timestamp|null,sequence:int}; a one-to-one group has matchId equal to matchGroupId and both singular member IDs populated, while a many-member group requires all three legacy singular fields to be null

新增或变更接口：

- POST /api/v1/match-groups with {statementLineIds:[uuid],ledgerEntryIds:[uuid]} returns 201 PROPOSED after sorting IDs and validating 1..20 members per side
- POST /api/v1/match-groups/:matchGroupId/confirm with {expectedStatementLineRevisions:{statementLineId:int},expectedLedgerEntryRevisions:{ledgerEntryId:int}} atomically confirms every member; the two maps are keyed by the UUIDs of exactly the group's Statement Lines and Ledger Entries, with no missing or extra keys; /reverse with {reason} reverses all
- GET /api/v1/match-groups/:matchGroupId returns exact MatchGroup. GET /api/v1/matches/:matchId is retained only for a group of exactly one member per side, resolves matchId equal to matchGroupId, and returns the exact legacy Match shape with statementLineId and ledgerEntryId rather than MatchGroup

新增稳定错误：

- 409 MATCH_GROUP_IMBALANCED: currency differs or statement and ledger sums are unequal
- 409 MATCH_GROUP_MEMBER_CONFLICT: any member revision changed or belongs to another active group

FINAL snapshot 与性能兼容合同：

The FINAL verification snapshot 'resources' object has exactly the union of these V1 and Manager resource specifications, with no other keys:

- 'statementBatches' uses exact shape 'StatementBatch' and sorts ascending by scalar field-path tuple 'batchId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'statementLines' uses exact shape 'StatementLine' and sorts ascending by scalar field-path tuple 'statementLineId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'ledgerEntries' uses exact shape 'LedgerEntry' and sorts ascending by scalar field-path tuple 'ledgerEntryId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'matches' uses exact shape 'Match' and sorts ascending by scalar field-path tuple 'matchId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'matchGroups' uses exact shape 'MatchGroup' and sorts ascending by scalar field-path tuple 'matchGroupId', then by RFC 8785 canonical JSON as the tie-breaker.

The Manager-added resource specifications are exactly:

- 'matchGroups' uses exact shape 'MatchGroup' and sorts ascending by scalar field-path tuple 'matchGroupId', then by RFC 8785 canonical JSON as the tie-breaker.

The FINAL Work kind enum is exactly the union 'MATCH_SUGGESTION'. The Manager-added
Work kinds are exactly (none). All V1 snapshot point-in-time,
recursive '*Token' omission, sorting, Work state/lease/retention/drain, and Domain Event rules remain
mandatory. The FINAL binary reruns exactly these three V1-compatible scenarios:

- 'statement-batch-import': import 50 batches/s of 100 lines with p95 <= 500 ms; threshold: At least 50 successful batches/s for 60 seconds and p95 <= 500 ms; partial imports and unexpected 5xx are zero.
- 'reconciliation-review': serve 250 review queries/s with p95 <= 180 ms; threshold: At least 250 successful review reads/s for 60 seconds and p95 <= 180 ms; unexpected 5xx = 0.
- 'suggestion-generation': generate suggestions for 20,000 unmatched records within 60 s; threshold: The complete 20,000-record input is processed in <= 60 seconds with zero member reuse or unexpected failure.

Their published setup, selector, request, concurrency, warm-up, measurement, timer, success condition,
and threshold remain unchanged. This Manager change adds correctness, concurrency, and recovery
assertions only; it does not replace or relax a performance scenario.

本轮先不要实现。请先说明它会影响哪些领域关系、模块、schema、migration、接口、状态、成功与失败数据流、兼容性、Worker、事件、前端、并发、恢复和性能测试，然后给出分阶段修改计划。