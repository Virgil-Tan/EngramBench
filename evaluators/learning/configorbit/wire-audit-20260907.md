# ConfigOrbit hidden evaluator — V2 author wire audit

Authority: `contracts/learning/configorbit.mjs`, generated public contract and the unchanged original README/manager requirements. No submitted implementation was used to define assertions.

Changes are author-side only:

- Create revision uses exactly environmentId, parentRevisionId, document and schemaRevision. Legacy tenantId/applicationId/authorRef inputs are removed from fixtures, not adapted at runtime.
- Publish includes required startAt. The fixed past timestamp makes immediate publication and exact idempotency replay deterministic.
- Rollout includes required audienceSalt. Workload sizes, race/recovery conditions and canonical assignment oracle are unchanged.
- Only the explicitly malformed Train basis-point body and seed with unpublished promotionTrains member bypass author positive-wire validation. Reversed stages, foreign environment, stale generations and dangling seed references remain wire-valid domain negatives.
- All 22 case IDs, manifest weights, business assertions and thresholds remain. Formatting of author case files has no semantic purpose.
- Existing SPEC-GAP diagnostics remain visible. Intermediate V1 checkpoint cases remain excluded when the frozen checkpoint does not exist. Neither is converted to a passing result or a model zero.

Validation: `test/evaluator-wire-configorbit.test.mjs` covers registry, every baseline seed, full 50,000-client / 100-environment / 100,000-invalidation fixtures, positive operation bodies and explicit negative intent forwarding. Live hidden runs are isolated author-validation until release certification; no formal score is claimed.
