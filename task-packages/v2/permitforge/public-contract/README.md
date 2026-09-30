# PermitForge — V2 fixed public interface

Author scaffold revision 2026-09-08.1: exact decimal validation and incremental seed-file decoding. This is a revised public scaffold, not the unchanged historical evaluation environment. Business requirements and seed scale remain unchanged.

Business requirements: read the COMPLETE ../docs/frontal-legacy/README.md and manager-requirements.md. The files are preserved verbatim. The wire clarifications below override only ambiguous representations, never remove business requirements.
Public author policy revision permitforge-stage-review-v1: read the supplements below in full. They resolve explicitly identified business-policy and test-protocol omissions; only an explicitly named author-approved exception overrides a corresponding original rule, and every other original obligation remains in force. This revision must not be compared as an unchanged historical benchmark.

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
| health | GET /healthz | docs/frontal-legacy/README.md; docs/frontal-legacy/manager-requirements.md; contract/README.md (V2 wire clarification) |
| openapi | GET /openapi.json | docs/frontal-legacy/README.md; docs/frontal-legacy/manager-requirements.md; contract/README.md (V2 wire clarification) |
| production-ui | GET / | docs/frontal-legacy/README.md; docs/frontal-legacy/manager-requirements.md; contract/README.md (V2 wire clarification) |
| list-applications | GET /api/v1/permitApplications | docs/frontal-legacy/README.md; docs/frontal-legacy/manager-requirements.md; contract/README.md (V2 wire clarification) |
| read-application-legacy-path | GET /api/v1/permitApplications/:permitApplicationId | docs/frontal-legacy/README.md; docs/frontal-legacy/manager-requirements.md; contract/README.md (V2 wire clarification) |
| create-application | POST /api/v1/permit-applications | docs/frontal-legacy/README.md; docs/frontal-legacy/manager-requirements.md; contract/README.md (V2 wire clarification) |
| claim-review | POST /api/v1/permit-applications/:applicationId/review-claims | docs/frontal-legacy/README.md; docs/frontal-legacy/manager-requirements.md; contract/README.md (V2 wire clarification) |
| decide-review | POST /api/v1/review-claims/:claimId/decisions | docs/frontal-legacy/README.md; docs/frontal-legacy/manager-requirements.md; contract/README.md (V2 wire clarification) |
| replace-revision | POST /api/v1/permit-applications/:applicationId/revisions | docs/frontal-legacy/README.md; docs/frontal-legacy/manager-requirements.md; contract/README.md (V2 wire clarification) |
| read-application | GET /api/v1/permit-applications/:applicationId | docs/frontal-legacy/README.md; docs/frontal-legacy/manager-requirements.md; contract/README.md (V2 wire clarification) |
| read-revision | GET /api/v1/permit-applications/:applicationId/revisions/:revision | docs/frontal-legacy/README.md; docs/frontal-legacy/manager-requirements.md; contract/README.md (V2 wire clarification) |
| read-stages | GET /api/v1/permit-applications/:applicationId/stages | docs/frontal-legacy/README.md; docs/frontal-legacy/manager-requirements.md; contract/README.md (V2 wire clarification) |
| domain-events | GET /api/v1/domain-events | docs/frontal-legacy/README.md; docs/frontal-legacy/manager-requirements.md; contract/README.md (V2 wire clarification) |
| verification-snapshot | GET /api/v1/verification-snapshot | docs/frontal-legacy/README.md; docs/frontal-legacy/manager-requirements.md; contract/README.md (V2 wire clarification) |

## Explicit V2 wire clarifications

- Source authority is the full public README, Manager requirements and AGENTS. No hidden evaluator data or solution code is imported. This V2 contract fixes wire boundaries; state machines, algorithms, isolation, migrations and performance remain implementation work.
- V2 wire clarification: every route has the closed request/success schema published here; only business inputs occur in creation requests. Omitted success status is 200. Health returns {status:"ok"}; UI returns HTML. Collection nextCursor is string or null, with null denoting completion. Path/query/header parameters and independent request examples are explicit. Examples validate transport only, not eligibility of referenced resources.
- V2 wire clarification: the authenticated verification snapshot is one point-in-time envelope with complete named resource arrays, typed retained Work and ordered DomainEvents. When the legacy source did not specify event fields, V2 uses eventId,aggregateId,sequence,type,occurredAt,schemaVersion,payload; payload remains a JSON object. No hidden event payload is prescribed.
- The seed uses the exact V1 array names and graph references. Repeated identical seed import is a no-op; another digest under the same seedVersion conflicts. Manager resources are derived by migration or created by public operations, never invented V1 seed members.
- V2 wire clarification: both literally documented camelCase read paths and kebab-case detail paths remain public. They return the same detail {permitApplication,applicationRevision,reviewPolicy,reviewClaims,reviewDecisions,approvedPermit}; the approvedPermit is null until approval. Creation/decision return PermitApplication; replacement returns the newly created ApplicationRevision.
- V2 wire clarification: successful claim adds claimToken:string to the closed ReviewClaim response. The token is required to invoke the published decision API and is omitted recursively from snapshots and event evidence; this does not provide the token generation/fencing algorithm.
- Submission and replacement must choose exactly one reviewPolicy or stages. Empty/mixed forms, counts and quotas retain INVALID_REVIEW_POLICY or INVALID_REVIEW_STAGES; JSON schemas publish the possible fields without turning those named domain errors into generic shape errors. Revision replacement captures the selected policy/stages under the same Manager semantics as submission.
- The exact V1 PermitApplication and the exact Manager extension are distinct response alternatives so previously saved one-stage replay bodies remain unchanged. New staged submissions expose currentStageOrdinal and stages. No undocumented media negotiation is required by the V2 scaffold; the original unspecified legacy media-type contract remains a release-audit item.
- The V1 seed is a fully approved single-stage application, with Applicant, Reviewer, matching canonical fields/digest/policy, decided Claim, approval Decision and Permit. Migration derives its completed Stage 1. No Manager-only seed fields are added.
- Smoke uses captured snapshot.asOf plus one hour for a deadline within the public thirty-day rule. All quorum, current-stage fencing, immutable evidence, compatibility, recovery and fixed performance requirements remain implementation obligations.
- ## PermitForge confirmed author policy — permitforge-stage-review-v1

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


## Delivery

Public checks are necessary, not sufficient. Re-read the entire README, audit every observable requirement, and run all required project checks. Guide completion does not mean task completion. Do not return fixture-only responses or empty arrays to simulate completed workflows.
