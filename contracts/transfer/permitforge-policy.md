## PermitForge confirmed author policy — permitforge-stage-review-v1

This supplement records the user's confirmed product choices. It explicitly changes the Manager multi-stage voting scope; it is not a claim that the original V1 text already allowed that behavior. The original documents remain otherwise binding and unchanged. This package revision must not be compared as an unchanged historical benchmark.

### Reviewer voting scope and compatibility

For Manager multi-stage review, one Reviewer may record at most one Decision per `(applicationId, revision, stageId)`, across all roles in that Stage. The same Reviewer may be eligible and vote again in a later Stage of the same immutable Revision. Prior-stage Decisions never count toward the later Stage's quotas. Each Claim is durably bound to the Stage that was ACTIVE when it was created; that association cannot move on Stage advancement or Claim reclaim. A later Stage's Claim is a distinct Claim identity. A Decision made through a Claim targeting a Stage that is no longer ACTIVE follows the already published `409 REVIEW_STAGE_CHANGED` rule, without changing any current-stage authority. Exact saved idempotency replay still returns the saved response without a new effect.

V1 and legacy one-stage behavior remains one Decision per Reviewer per Revision. Claim and Decision request/resource shapes, old identities, V1 seed members and saved response bodies remain unchanged. Stage binding is implementation-owned durable state, not a new field in those existing resources. The policy supplies no transaction, locking or fencing implementation.

### Stage names and order

A Stage name must contain at least one non-whitespace character: empty strings and whitespace-only strings are rejected with `400 INVALID_REVIEW_STAGES`. Names may repeat, including identical names within one Revision; no extra length limit or uniqueness rule is introduced. Preserve the submitted name rather than normalizing it silently. Stage identity is `stageId`; order is `ordinal`, assigned contiguously from one using the request array order. The existing stages request still contains only `{name,reviewPolicy}` and does not accept a client-supplied ordinal.

### Explicit immutable Stage evidence

The Manager `GET /api/v1/permit-applications/:applicationId/stages` response is now exactly `{items:[ReviewStage],evidence:[StageEvidence]}`. `ReviewStage` retains all original fields. `StageEvidence` is exactly `{stageId:uuid,claimIds:[uuid],decisionIds:[uuid]}`.

There is exactly one evidence item per Stage in `items`, in the same ordinal order. Each ID array is unique and sorted bytewise. It identifies every Claim or Decision bound to that Stage, including historical Claims. A Claim/Decision identity belongs to exactly one Stage. Its application and Revision agree with that Stage, and each Decision is bound to a Claim from that same Stage. All current or historical records belonging to the returned Stages are represented exactly once. Evidence is read atomically with `items`; completing a Stage freezes its Claim/Decision association sets together with the completed-stage evidence. New Stage activity cannot rewrite that history. V1 history migrated to Stage 1 retains its original Claim and Decision identities in Stage 1 evidence.

The evidence IDs refer to the unchanged public Claim/Decision resources exposed by application detail and verification snapshot. They must not be inferred from display names, Reviewer identities or timestamps; two different Stage Decisions can have the same Reviewer, role and timestamp. No token is exposed by this evidence. No new Domain Event type, payload, Work kind, or V1 seed field is introduced.
