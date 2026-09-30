# GeoPulse author wire audit

Scope: the existing 22 hidden cases, all fixture/helper/runtime/oracle paths, execution and scoring wrappers. Authority is the frozen `task-packages/v2/geopulse/public-contract/contract.json` and its preserved `workspace/docs/frontal-legacy` business documents. No submissions or trajectories were inspected. Case IDs, weights, manifest, public contract, starter and business requirements are unchanged.

Implemented alignment:

- Every positive core/scaled seed has required bundle arrays. Core geometry now starts with a complete revision-one open interval; the dedicated half-open version test still supplies both adjacent versions.
- Region version mutation bodies omit server-assigned identities, tenant and revision. The UI version workflow no longer requires an editable server-assigned revision field.
- Query requests include the public required `Idempotency-Key`, including performance requests. Existing bundle and collection envelopes remain exact.
- Explicit malformed-wire exceptions are only `A-02` latitude 90.000001 atomic batch, `A-05` empty publication members, and `C-04` latitude 91 batch. Existing HTTP rejection and before/after no-side-effect assertions remain. `allowFailure` is not a schema bypass. Self-intersection, overlap, identity conflicts and CAS losers still pass through normal positive wire validation.
- The old late-event fixture now uses unique positive device sequence 7 while remaining outside the reorder window. It still checks storage plus no Membership/Transition rewrite.
- Generated polygons and request points use integer microdegrees to avoid author-created seventh decimal places. The independent exact-edge oracle accepts valid six-decimal decimal strings even when multiplying their JavaScript binary representation is slightly inexact; it still rejects seventh decimal places.
- Snapshot sorting follows public resource identity, including `eventId`, `regionVersionId`, `transitionId`, bundle revision ID and the tenant/device/region Membership identity. Transition deduplication is per device/region as explicitly required by preserved README invariant 5; multi-region source events are no longer mistaken for duplicate effects.
- Migration comparison projects nullable bundle additions on both sides of the checkpoint, preserving all original fields and exact saved response replay assertions.

Known frozen-public-runtime fault (not a candidate failure):

`public-contract/runtime.mjs` sets Ajv `multipleOfPrecision:9`. Valid coordinates `-9.89` and `-9.8`, declared with `multipleOf:0.000001`, can divide to a quotient with floating-point error above 1e-9. Directly validating the full jitter seed produces 17 false violations, including `/regionVersions/1/polygon/1/0` = -9.89 and `/regionVersions/2/polygon/0/0` = -9.8. The seed's decimal spellings and all polygons pass the independent six-decimal geometry validator.

Affected author case: `E-03` boundary-jitter workload; the same runtime defect can affect valid requests at larger coordinate magnitudes generally. The test `GeoPulse full jitter seed passes the published decimal multipleOf constraint` is an explicit TODO with the original positive validation assertion still executed. Hidden `E-03` is not skipped and has no bypass: it remains `EVALUATOR_PUBLIC_CONTRACT_MISMATCH` in isolated author validation. Parent directed that the already-published runtime and frozen submission remain unchanged pending a separate public runtime revision.

Validation: focused test covers the complete registry/weights, positive seeds and event/schema variants for all cases, all 10,000 spatial region fixtures, exact-edge/seventh-decimal checks, helper envelopes/headers, malformed-negative forwarding and per-region transition identity. Six tests pass; the known runtime false-negative is one executed TODO.

Remaining release-review items:

- Existing `GP-GAP-01` exact invalid-bundle error codes and `GP-GAP-03` precise forced pre-commit fencing remain diagnostic.
- Existing `GP-GAP-02` metadata is stale because V2 publishes nullable bundle fields; it was preserved as required by the frozen manifest.
- `C-03` assumes how old-event Memberships should be rewritten by later bundle reevaluation, but public text does not fully define the reevaluation projection beyond captured revision authority. That policy still needs explicit diagnostic review; no new policy was invented here.
- Parent corrected the shared receiver's HTTP-500 acknowledgement bookkeeping after this audit identified it. Parent owns all live database/browser/recovery/performance validation, packaging/runtime locks and release certification.
