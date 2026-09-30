【Product Manager · Maya】

V1 已完成并通过基础验收。本期正式增加“atomic multi-beneficiary transfers”。以下业务规则、wire schema、接口和错误全部是公开增量合同。

业务规则：

1. A new Transfer may contain 1-20 destination legs; V1 single-destination requests remain valid.
2. Every destination amountMinor and their exact sum must be positive safe integers; an invalid member or overflowing sum is rejected before any durable effect.
3. All destination legs post together or none post; the source is charged exactly the sum of the legs.
4. For a pending multi-leg Transfer, the source reservation equals the exact safe-integer sum of its legs until posting or cancellation releases it.
5. Duplicate destination account IDs are rejected before any durable effect.
6. Each destination leg receives a stable legId and appears in Transfer detail and Account statements.
7. Reversal compensates every leg atomically and cannot partially succeed.
8. The legacy destinationAccountId and amountMinor response fields remain populated for one-leg Transfers and are null for multi-leg Transfers.
9. Upgrade every V1 Transfer to one leg without changing IDs, timestamps, statements, event sequences, or replay bodies.
10. Preserve all pending Settlement Tasks and their retry state.
11. Old one-leg clients continue to create and read Transfers unchanged.
12. The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
13. The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
14. Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
15. Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

新增 wire schema：

- TransferLeg = {legId:uuid,destinationAccountId:uuid,amountMinor:int,postingLegId:uuid|null}; Transfer adds legs:[TransferLeg], while destinationAccountId and amountMinor become required nullable fields
- Manager Posting legs use {postingLegId:uuid,legId:uuid|null,accountId:uuid,direction:DEBIT|CREDIT,amountMinor:int}. A multi-leg TRANSFER orders one source DEBIT with legId null before destination CREDIT legs in Transfer.legs order; a REVERSAL orders destination DEBIT legs in Transfer.legs order before one source CREDIT with legId null. The source leg amount is the exact safe-integer sum of the destination legs. This replaces the V1 exactly-two-leg rule only for multi-leg Transfers; one-leg Postings keep the V1 order and shape

新增或变更接口：

- POST /api/v1/transfers accepts either legacy {sourceAccountId,destinationAccountId,currency,amountMinor} or new {sourceAccountId,currency,legs:[{destinationAccountId,amountMinor}]}, never both; response is the extended Transfer
- GET /api/v1/transfers/:transferId and Account statements expose legId; reverse and cancel endpoints keep their V1 request shapes and act on the complete Transfer

新增稳定错误：

- 400 DUPLICATE_DESTINATION_ACCOUNT: two request legs name the same destinationAccountId
- 400 INVALID_MULTI_LEG_AMOUNT: a destination amountMinor or their exact sum is not a positive safe integer
- 409 MULTI_LEG_INSUFFICIENT_FUNDS: source availableMinor is less than the safe-integer sum of all legs

FINAL snapshot 与性能兼容合同：

The FINAL verification snapshot 'resources' object has exactly the union of these V1 and Manager resource specifications, with no other keys:

- 'accounts' uses exact shape 'Account' and sorts ascending by scalar field-path tuple 'accountId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'transfers' uses exact shape 'Transfer' and sorts ascending by scalar field-path tuple 'transferId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'postings' uses exact shape 'Posting' and sorts ascending by scalar field-path tuple 'postingId', then by RFC 8785 canonical JSON as the tie-breaker.

The Manager-added resource specifications are exactly:

- No additional resource keys.

The FINAL Work kind enum is exactly the union 'SETTLEMENT'. The Manager-added
Work kinds are exactly (none). All V1 snapshot point-in-time,
recursive '*Token' omission, sorting, Work state/lease/retention/drain, and Domain Event rules remain
mandatory. The FINAL binary reruns exactly these three V1-compatible scenarios:

- 'statement-read': 150 statement reads/s with p95 <= 150 ms; threshold: At least 150 successful responses/s for 60 seconds and successful-response p95 <= 150 ms; unexpected 5xx = 0.
- 'transfer-mutation-mix': 40 transfer mutations/s with p95 <= 500 ms; threshold: At least 40 successful mutations/s for 60 seconds and successful-response p95 <= 500 ms; all balances, reservations, postings, and events reconcile afterward.
- 'settlement-recovery': drain 2,000 Settlement Tasks within 45 s after workers restart; threshold: The replacement-worker timer is <= 45 seconds and worker unexpected failures = 0.

Their published setup, selector, request, concurrency, warm-up, measurement, timer, success condition,
and threshold remain unchanged. This Manager change adds correctness, concurrency, and recovery
assertions only; it does not replace or relax a performance scenario.

本轮先不要实现。请先说明它会影响哪些领域关系、模块、schema、migration、接口、状态、成功与失败数据流、兼容性、Worker、事件、前端、并发、恢复和性能测试，然后给出分阶段修改计划。