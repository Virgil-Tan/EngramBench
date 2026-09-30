# V2 author wire alignment

Authority: `task-packages/v2/routeweave/public-contract/contract.json` and the preserved public README / Manager requirements. No submission or trajectory was used.

- Inspected all 22 case implementations, task runtime, fixtures, helpers, replay/snapshot oracle, manifest, registry and scoring policy.
- Kept existing V2 paths, positive seed graphs, case IDs, weights, work/recovery/performance assertions and business errors. Shipment/piece loss and scan paths already matched the published contract.
- Explicit invalid-wire declarations now cover duplicate pieceRefs, the 101-piece boundary, unknown fields, malformed JSON, unsupported media type and missing snapshot authorization. They retain rejection/no-side-effect assertions. Disconnected routes and cross-tenant references remain positive-wire business negatives and are still validated before transport.
- Native ConsignmentRoutePlan uses `consignmentId`; native PieceScanEvent uses `pieceId` and `routePlanRevision`, without a nullable `shipmentId`. Nullable loss/found hub/leg fields are accepted as published. Consignment detail now uses its exact wrapper; piece replay follows piece identity or the published legacyShipmentId mapping.
- Added direct public-validator tests for every case's first positive seed (including performance graphs), all mutation helpers and reads, 1/100-piece boundaries, explicit-invalid forwarding, positive author failure, native snapshot shapes and the complete case registry.
- Read-only follow-up found the replay tie-break used scannerEventId. Corrected it to the public README's `(observedAt, typePrecedence, scanEventId)` order and added a regression with opposite caller/server identity ordering in both arrival permutations.

Unresolved review diagnostics:

- A-04 / D-01 retain the public Manager `409 PIECE_REF_CONFLICT` assertion for duplicate pieceRefs. The frozen request schema also has `uniqueItems:true`, whose generic transport validation may reject earlier with `400 INVALID_REQUEST`. This is a public contract precedence conflict, not grounds to change the hidden expected business error or weaken validation.
- The snapshot oracle's historical routePlan sorting uses `(shipmentId, revision)`. Public V2 adds disjoint native ConsignmentRoutePlans but only says “public identity tuple”, without an explicit combined ordering. No replacement ordering was invented. Release review should treat ambiguity here as an author diagnostic if reached.
- The legacy scan output omits routePlanRevision while native piece scans include it. Existing replay uses current revision as a fallback for unchanged legacy scans. Full old-revision replay observability should be reviewed separately from wire-schema acceptance.

This audit does not certify business correctness, live evaluation or release readiness.
