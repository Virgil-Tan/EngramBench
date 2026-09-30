# FlagFoundry — V2 fixed public interface

Author scaffold revision 2026-09-08.1: exact decimal validation and incremental seed-file decoding. This is a revised public scaffold, not the unchanged historical evaluation environment. Business requirements and seed scale remain unchanged.

Business requirements: read the COMPLETE ../docs/frontal-legacy/README.md and manager-requirements.md. The files are preserved verbatim. The wire clarifications below override only ambiguous representations, never remove business requirements.
Public author policy revision flagfoundry-public-observation-v2: read the supplements below in full. They resolve explicitly identified business-policy and test-protocol omissions; only an explicitly named author-approved exception overrides a corresponding original rule, and every other original obligation remains in force. This revision must not be compared as an unchanged historical benchmark.

## Implementation seam

- Implement all operations behind src/implementation.ts; use src/operation-ids.ts and contract.json for exact IDs, schemas, status codes and examples. Split internal modules freely.
- Implement migrations, database seed, worker/dispatcher roles, real UI build and project-owned verification in src/lifecycle.ts. Throwing stubs are deliberate: compilation is not business completion.
- The API process awaits optional src/implementation.ts exports start() before listening and stop() when terminating. Use these for pools and any background work required inside npm start (notably LaunchPass expiration/promotion). They may delegate to your own lifecycle modules; do not keep them only in the build command.
- contract/ is author-owned. Do not edit its router/checker/contract or the README to make tests pass. You may add modules, dependencies, UI assets and your own tests.
- Raw uploads arrive as RequestContext.stream; consume them incrementally. Raw download responses may be Buffer, string or readable stream. The router does not implement file persistence.
- Additional UI endpoints may use publicExtensions; published operation IDs/method/path cannot be replaced.

## Contract and examples

- contract.json is the single wire source. openapi.json is generated from it, not separately handwritten.
- The fixed HTTP server listens on 127.0.0.1; contract.httpHost preserves any task-specific bind requirement. PORT selects its port.
- transportErrors preserves task-specific HTTP error codes. Otherwise V2 wire defaults are INVALID_REQUEST/400, MALFORMED_JSON/400, UNAUTHORIZED/401, NOT_FOUND/404 and UNSUPPORTED_MEDIA_TYPE/415; domain resource errors still follow the complete README.
- seed.example.json is a legal NONEMPTY seed. Its replay rule and argv are under contract.seed; do not guess db:seed versus seed.
- contract/seed-reader.mjs exports readSeedJsonFile(path): incremental JSON decoding without a whole-file string. The author seed command still validates the entire decoded value against the public schema before invoking your lifecycle. You may reuse this reader in your own importer; foreign keys, digests, duplicate rules and atomic import remain your responsibility. The decoded object tree still occupies memory, and a single JSON string remains subject to the JavaScript engine string limit; this helper is not a database importer.
- operation.example values are independent wire examples, not a complete executable business sequence. smoke contains an ordered public live sequence with captured identifiers.
- A smoke signatures entry constructs a lowercase-hex HMAC-SHA256 request field: {target:["headers"|"body","existingField"],key:"public fixture key",message:"published UTF-8 signing line"}. Captured variables are expanded first; body fields are signed before JSON serialization. This is a public client helper, never server-side authentication or business implementation.
- npm run check:contract-source only verifies author file integrity and schema construction.
- npm run test:public-contract uses a DISPOSABLE database, builds, migrates, imports the seed, starts the real API/roles, then checks nonempty identities and live operations. Do not point it at a valuable database.
- Public failures identify the failed command stage and retain its exit code/stdout/stderr. A probe blocked by an earlier failed identifier capture is reported as blockedBy, not as an independent implementation failure. Fix the first failure, then rerun the public check.
- HTTP probe failures identify method/path, expectedStatus, actualStatus and a named errorCode when available; they do not dump credentials or signatures. The official Harness reruns this author-owned check in an isolated copy before freezing; failed public checks return to the same Coding Agent for repair, while infrastructure errors stop the check without becoming business scores.
- Passing public checks proves only the published example wiring. It does not certify full business requirements, security, recovery, UI or performance, and does not replace the final README audit.
- The official Harness runs the author-owned checker against an isolated copy before freezing. A public failure is feedback, not a hidden business score.

## Published operations

| ID | Method / path | Source |
| --- | --- | --- |
| health | GET /healthz | V2 public wire clarification (contract notes) |
| openapi | GET /openapi.json | docs/frontal-legacy/README.md#http-and-openapi-31 |
| production-ui | GET / | docs/frontal-legacy/README.md#real-ui |
| domain-events | GET /api/v1/domain-events | V2 public wire clarification (contract notes) |
| verification-snapshot | GET /api/v1/verification-snapshot | docs/frontal-legacy/README.md#http-and-openapi-31 |
| list-revisions | GET /api/v1/flag-revisions | docs/frontal-legacy/README.md#http-and-openapi-31 |
| get-revision | GET /api/v1/flag-revisions/:revisionId | docs/frontal-legacy/README.md#http-and-openapi-31 |
| compilation-findings | GET /api/v1/flag-revisions/:revisionId/findings | V2 public observation clarification (contract notes), original CompilationFinding and stale-compilation requirements |
| update-context-schema | POST /api/v1/projects/:projectId/environments/:environment/context-schema | V2 public observation clarification (contract notes), original captured Environment context schema invariant |
| create-flag | POST /api/v1/flags | docs/frontal-legacy/README.md#http-and-openapi-31 |
| create-revision | POST /api/v1/flags/:flagId/revisions | docs/frontal-legacy/README.md#http-and-openapi-31 |
| activate-revision | POST /api/v1/flag-revisions/:revisionId/activate | docs/frontal-legacy/README.md#http-and-openapi-31 |
| evaluate | POST /api/v1/evaluations | docs/frontal-legacy/README.md#http-and-openapi-31 |
| revision-diff | GET /api/v1/flags/:flagId/revisions/:revision/diff | docs/frontal-legacy/README.md#http-and-openapi-31 |
| flag-revisions | GET /api/v1/flags/:flagId/revisions | docs/frontal-legacy/README.md#http-and-openapi-31 |
| progressive-activate | POST /api/v1/flag-revisions/:revisionId/progressive-activate | docs/frontal-legacy/manager-requirements.md |
| outcome-batch | POST /api/v1/progressive-rollouts/:rolloutId/outcome-batches | docs/frontal-legacy/manager-requirements.md |
| get-rollout | GET /api/v1/progressive-rollouts/:rolloutId | docs/frontal-legacy/manager-requirements.md |

## Explicit V2 wire clarifications

- Authority: the complete original public README and Manager requirements. This contract uses no private evaluator cases or submitted implementation. Wire validation does not establish workflow, recovery or performance correctness.
- V2 wire clarification: unspecified health body is exactly {status:"ok"}; production UI is HTML at /. GET domain-events returns {items:[DomainEvent]} with aggregateId required and optional afterSequence (default 0), limit (default 50, range 1..100), ordered by sequence. No other query keys are accepted.
- Original error details is an exact empty object. Every mutation requires its published Idempotency-Key. Only documented admin routes require ADMIN_TOKEN. Output timestamps retain the original UTC millisecond precision.
- The FINAL snapshot has exactly its published resource keys and explicitly typed Work/DomainEvent records. It is one database snapshot; recursive *Token omission, stable ordering, retained terminal Work and event identity remain business requirements. Manager-only data is created by public APIs, never inserted through the V1 seed.
- Examples are independent public transport examples, not a required stateful sequence. A success requires the state/time/lease/revision prerequisites in the original public documents. Smoke checks identity and a separate write/read path, not every operation or concurrency invariant.
- Author-confirmed business policy flagfoundry-rollout-authority-v1: while a progressive rollout is RUNNING, its captured prior revision remains the sole ACTIVE revision and its captured candidate remains READY with activatedAt null. The official active pointer and expectedActiveRevision compare-and-set still refer to the prior revision, including a final cohort at 10000 exposure while observations remain incomplete.
- The RUNNING rollout alone authorizes evaluation of its captured READY candidate Snapshot according to the published cohort bucket; this is the explicit Manager exception to the V1 invariant that an inactive revision cannot be evaluated. Non-selected, unrelated READY, REJECTED and stale revisions gain no evaluation authority. Every progressive Evaluation still names its rolloutId and current stepIndex.
- Only the transaction that passes all rollout steps marks the rollout COMPLETED, supersedes the prior revision and makes the candidate the sole ACTIVE revision. Candidate activatedAt is that completion transaction timestamp, equal to rollout terminalAt; immutable prior and candidate Snapshot contents and digests do not change. A failed threshold or deadline instead marks the rollout ROLLED_BACK without activating the candidate: prior remains ACTIVE, candidate remains READY with activatedAt null, and subsequent fresh evaluations use the prior Snapshot.
- The confirmed authority rule applies at the observed RUNNING or terminal transition, not as a permanent condition on historical terminal rollout rows. A later legitimate activation may supersede that active revision. A concurrent immediate activation makes a RUNNING rollout STALE and owns the new active pointer; old rollout work cannot restore its prior. Saved V1 replies and seeded history remain unchanged.
- Author clarification flagfoundry-public-observation-v2 preserves flagfoundry-rollout-authority-v1 and all original business requirements. ASCII 1..64 means U+0000 through U+007F inclusive, length 1..64, case-sensitive, with no trimming or visible-character-only restriction. This is distinct from the visible-ASCII Idempotency-Key header rule.
- GET /api/v1/flag-revisions/:revisionId/findings returns the complete CompilationFinding array, sorted by path then code using UTF-8 byte order, without a wrapper or pagination. It is a read-only durable explanation of that Compilation result, not another snapshot resource key. Unknown revision returns 404 NOT_FOUND. COMPILING and successfully compiled revisions return []; a REJECTED revision has one or more nonempty code/path/message findings explaining the rejected rule or captured prerequisite. Findings use JSON Pointer paths into the revision request and remain stable after completion; no new error-code enum is imposed on findings.
- POST /api/v1/projects/:projectId/environments/:environment/context-schema is an ADMIN_TOKEN mutation using the ordinary durable Idempotency-Key contract. Body is exactly {contextAttributes:[ASCII name]}; names must be sorted unique and unsorted names return 400 INVALID_REQUEST. It updates only an existing Environment and returns its exact Environment shape; missing Project/Environment returns 404 NOT_FOUND. A changed attribute list increments schemaRevision by one in the same transaction; an identical list is a no-op and replay never increments again. Existing Snapshots and captured Compilation inputs remain immutable. This publishes the mutation needed to observe the original captured-schema invariant, not an automatic activation, a schema-edit workflow, or a new event. A READY revision compiled against an older schema cannot activate (409 ACTIVE_REVISION_CHANGED); an unfinished stale Compilation becomes REJECTED with explanatory findings. The existing active Snapshot remains authority until a valid new activation.
- For fresh legacy /activate requests, the Manager one-Step 10000/zero-observation description is semantic equivalence to immediate activation: keep the exact old FlagRevision response and create no new ProgressiveRollout, EvaluationOutcome, or ROLLOUT_DEADLINE Work. Existing RUNNING rollouts may become STALE as already required. Imported history and saved legacy replay bodies acquire no synthetic rollout rows or activations.
- An Outcome for a well-formed but wrong Snapshot digest in its otherwise current open rollout Step returns 409 SNAPSHOT_MISMATCH. Wrong current Step or superseded authority retains 409 ROLLOUT_STALE; deadline precedence retains 409 OUTCOME_WINDOW_CLOSED. A failed member rejects the complete batch with no accepted IDs, counter increments, or side effects. outcomeId is the original unrestricted JSON string: do not impose an unpublished UUID, nonempty, ASCII, or maximum-length requirement.
- V2 public wire clarification: outcome batches return the closed object {acceptedIds:[string],duplicateIds:[string]}, each preserving input order. These are the outcomeId values accepted or replayed, not counters or private record identifiers.
- V2 public wire clarification: revision-diff requires against (positive integer). Optional environment disambiguates per-environment revision numbers; omitting it is valid only when exactly one Environment contains both revisions. Ambiguous requests return 400 INVALID_REQUEST, never compare revisions across Environments. Flag-specific revision lists require environment.
- V2 compatibility clarification: ordinary and saved legacy Evaluation responses retain the original shape; evaluations participating in a progressive activation include both rolloutId and stepIndex. If an implementation includes the two fields outside a rollout they are both null. The union allows old replay bodies, never an extra wrapper.
- The Evaluation context is an explicitly open map of published ASCII attribute names to string values; subjectKey is the intrinsic required bucketing input and need not also occur in contextAttributes. Other supplied keys must occur in the captured Environment attribute whitelist. Missing nonempty subjectKey uses MISSING_SUBJECT_KEY and a non-intrinsic unknown attribute uses INVALID_FLAG_RULE. Rules, variant type agreement, allocation totals and progressive-step bounds retain the business errors published in README/Manager.
- The V1 seed keeps only projects, environments, flags and activeRevisions. The linked public example has one exact RFC 8785 Snapshot digest. Seed flags have no createdAt field; their public createdAt is the earliest imported revision createdAt, or the import transaction time if none exists, and replay never changes it. No rollout or outcome state may be seeded.

## Delivery

Public checks are necessary, not sufficient. Re-read the entire README, audit every observable requirement, and run all required project checks. Guide completion does not mean task completion. Do not return fixture-only responses or empty arrays to simulate completed workflows.
