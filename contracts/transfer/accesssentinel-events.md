# AccessSentinel immutable Event protocol

Policy revision: `accesssentinel-2026-09-08.1`.

This author-approved supplement defines previously unspecified names/payloads;
it does not change authorization, risk rules, TTLs, review independence, revocation
or performance requirements. Old results are not judged retroactively.

Keep the exact Event envelope:
{eventId,tenantId,aggregateType,aggregateId,sequence,type,occurredAt,payload}.
Each successful transition below atomically emits one corresponding event.
Replays and Work retries never duplicate it. All use aggregateType AccessRequest,
aggregateId accessRequestId. Other required Events may interleave, with their
existing public names, so these events need not occupy fixed sequence numbers.

| Transition | type | Exact payload |
| --- | --- | --- |
| Accept AccessRequest | ACCESS_REQUESTED | {accessRequestId,sessionId,policyRevisionId,riskModelRevisionId,deviceTrustRevisionId} |
| Commit RiskDecision | RISK_DECIDED | {accessRequestId,riskDecisionId,score,level,reasons,policyEffect,inputDigest} |
| Record review | ACCESS_REVIEWED | {accessRequestId,accessReviewId,reviewerId,decision,comment} |
| Issue AccessGrant | ACCESS_GRANTED | {accessRequestId,grantId,policyRevisionId,riskDecisionId,expiresAt} |
| Revoke / expire Grant | ACCESS_REVOKED / ACCESS_EXPIRED | {accessRequestId,grantId,state,revocationEpoch} |

Payloads are closed and contain all listed fields, using their existing resource
types. Copy values from the corresponding committed resource. Do not substitute
later policy/current projections. reasons remains the immutable sorted reason
list. Existing contiguous unique aggregate sequences and transactional invariants
remain mandatory.

Dispatcher POSTs exactly this immutable Event to WEBHOOK_URL with Content-Type
application/json. Canonical JSON sorts object keys recursively in JavaScript
UTF-16 order, preserves arrays, uses JSON.stringify without whitespace and UTF-8.
Freeze bytes once; unknown ACK/restart retries reuse eventId and complete bytes.
Any HTTP 2xx acknowledges; other statuses/connection failures retain retryable
Work under original rules. Events may not contain raw refresh tokens, device
nonces, private keys, credentials, authorization headers or administrator tokens.
