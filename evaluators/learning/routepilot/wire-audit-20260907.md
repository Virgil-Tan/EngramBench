# V2 author wire alignment

Authority: `task-packages/v2/routepilot/public-contract/contract.json` and the preserved public README / Manager requirements. No submission or trajectory was inspected.

- Inspected all 22 cases, fixture families, runtime, helpers, routing/circuit oracles, registry, manifest and scoring policy.
- Replaced legacy `headerMatches:[]` with the published string map in base, browser and performance fixtures. The independent routing oracle reads the map with case-insensitive header names and exact values.
- ConfigRelease helper uses the required integer `expectedActiveVersion:0` and version 1 when there is no release. Existing active-release behavior remains unchanged.
- D-01 ConfigRelease collections now carry the required tenantId. The two seeded tenants are read with an allowed collection limit so a random UUID sort cannot hide the target tenant; ConfigRelease pagination still uses limit 1 and verifies stable replay.
- D-04 requires `originRedacted:true`. Rollout fixture now exposes its actual seeded rate/circuit policies and other tenant, preventing a fixture dereference failure before schema validation.
- Only existing malformed JSON, duplicate-object-key, unknown-property and stage-range negative requests are marked `contractExpectation:'invalid'`. Their rejection/resource/work/event assertions remain. Route normalization errors, empty release sets, conflicts and terminal controls remain positive-wire business negatives.
- Retained all case IDs, weights, thresholds, recovery assertions, and existing A-05/C-03/D-03 `SPEC-GAP-RP-01` diagnostics. No event types or stage readiness input were invented.
- B-01 now recognizes the public nullable route identity for `ROUTE_NOT_FOUND`. Every request still retains a known frozen release; matched routes must belong to that release, while null-route publication requests must be REJECTED/404 with no UpstreamAttempt. The regression accepts a public-schema-valid rejected record and rejects unknown releases, successful null-route records, upstream side effects, incorrect rejection status and foreign route revisions.

Validation: `node --test test/evaluator-wire-routepilot.test.mjs` checks every fixture family, all 22 first case seeds (including performance graphs), cross-tenant circuit references, complete registry/scoring, request helpers, first-release fields, exact header matching, redaction type, command-boundary positive seed rejection and publication request authority. This is author wire validation, not a live business pass or release certification.

Remaining diagnostics for release review: public Manager requirements do not publish a controllable stage health/readiness input. Existing fail-closed diagnostics remain. Scenario assumptions about global versus regional active-release state are unchanged and require business review if reached; the public contract permits region-specific dispatch selection via `x-route-region`.
