# AccessSentinel: public integration contract (taskVersion 4)

The external interface is fixed. The starter implementation is OPTIONAL and REPLACEABLE, not a business implementation.
README and the original Manager requirements still define every business obligation. Explicit v4 wire clarifications below override ONLY ambiguous transport representations in the legacy text, not business rules.

## External interface vs internal implementation

- Fixed: published HTTP methods/paths, request/response/error shapes, command names and arguments, environment variables, seed and snapshot wire formats. Preserve the original README business requirements and runtime constraints.
- Free: source directories, modules, function names, router/framework, build configuration, package module type, npm script BODIES and dependencies. Neither `src/` nor `dist/` nor `execute(operationId, context)` is required by the checker.
- `src/implementation.ts`, `src/lifecycle.ts`, `contract/server.mjs`, `contract/seed.mjs` and `tsconfig.json` are replaceable starter examples. Keep them only if useful; implement actual database-backed business behavior yourself.
- Author-owned specification and checks remain fixed: README/AGENTS, original requirements, contract/README.md, contract.json, openapi.json, seed.example.json, check.mjs, runtime.mjs and protected.json. Do not change these to make an incorrect implementation pass.
- Additional real application routes are allowed; they must not replace or change a published route. The optional starter's publicExtensions hook is one possible implementation, not a required interface.

## Commands and clean environment

Run `npm ci`, then `npm run build`. Preserve a reproducible package-lock.json and the required npm command NAMES; you may replace every command body. The untouched lifecycle stubs deliberately fail, and compilation alone is not delivery.
Run `npm run test:public-contract` in a DISPOSABLE database with DATABASE_URL, TEST_DATABASE_URL and ADMIN_TOKEN set. It replays migration/seed, starts the real roles and probes the live API. It is not safe to point at a valuable database.
The official gate runs the author copy in a new evaluator container on a fresh checkout/database. It does not trust a submitted test script or its reported result.
The checker launches `npm run start:api` with a numeric PORT and waits for a TCP listener, then sends actual HTTP requests. It launches workers/dispatchers via their public npm commands, never imports application modules and does not require Node IPC messages. Long-running role commands must stay alive and honor process termination.
Required commands: `npm run build`, `npm run db:migrate`, `npm run db:seed`, `npm run start:api`, `npm run start:worker`, `npm run start:dispatcher`, `npm run test:public-contract`, `npm run check:contract-source`, `npm run test:unit`, `npm run test:integration`, `npm run test:e2e`, `npm run test:concurrency`, `npm run test:recovery`, `npm run test:perf`, `npm run test:all`.
`npm run check:contract-source` checks file integrity/schema construction ONLY; this is not a live pass.

## Public create → operate → query check

The ordered `smoke` list in contract.json includes real successful writes followed by a query/snapshot of those same resources. `capture` binds response JSON pointers; `${name}` in later requests and expected bodies refers to that actual returned value. Whole-value references retain JSON types; path references are URL-encoded. A missing/wrong response cannot be replaced with a guessed ID. These are public integration examples, not hidden scoring cases.
- 1. health: HTTP 200.
- 2. openapi: HTTP 200.
- 3. listTenants: HTTP 200; capture publicTenantId.
- 4. snapshot: HTTP 200; capture publicObservationTime.
- 5. createPolicyBundle: HTTP 200; capture publicPolicyBundleId, publicExpectedRevision.
- 6. snapshot: HTTP 200.
- 7. publishPolicy: HTTP 200; capture publicPolicyRevisionId, publicPublishedRevision.
- 8. snapshot: HTTP 200.
- 9. createSession: HTTP 400.

## Published operations

| Operation | Method / path | Request schema | Response schema | Source |
| --- | --- | --- | --- | --- |
| health | GET /healthz | see original text | see notes/original text | docs/frontal-legacy/README.md |
| openapi | GET /openapi.json | see original text | see notes/original text | docs/frontal-legacy/README.md |
| ui | GET / | see original text | see notes/original text | docs/frontal-legacy/README.md |
| listTenants | GET /api/v1/tenants | see original text | published | docs/frontal-legacy/README.md |
| listPrincipals | GET /api/v1/principals | see original text | published | docs/frontal-legacy/README.md |
| listDevices | GET /api/v1/devices | see original text | published | docs/frontal-legacy/README.md |
| getAccessRequest | GET /api/v1/access-requests/:accessRequestId | see original text | published | docs/frontal-legacy/README.md |
| createSession | POST /api/v1/sessions | published | published | docs/frontal-legacy/README.md |
| refreshSession | POST /api/v1/sessions/:sessionId/refresh | published | published | docs/frontal-legacy/README.md |
| revokeSession | POST /api/v1/sessions/:sessionId/revoke | published | published | docs/frontal-legacy/README.md |
| publishTrust | POST /api/v1/devices/:deviceId/trust-revisions | published | published | docs/frontal-legacy/README.md |
| revoke-devices | POST /api/v1/devices/:deviceId/revoke | published | published | docs/frontal-legacy/README.md |
| revoke-principals | POST /api/v1/principals/:principalId/revoke | published | published | docs/frontal-legacy/README.md |
| revoke-tenants | POST /api/v1/tenants/:tenantId/revoke | published | published | docs/frontal-legacy/README.md |
| createPolicyBundle | POST /api/v1/policy-bundles | published | published | docs/frontal-legacy/README.md |
| publishPolicy | POST /api/v1/policy-bundles/:policyBundleId/publish | published | published | docs/frontal-legacy/README.md |
| rollbackPolicy | POST /api/v1/policy-bundles/:policyBundleId/rollback | published | published | docs/frontal-legacy/README.md |
| observeLocation | POST /api/v1/location-observations | published | published | docs/frontal-legacy/README.md |
| createAccessRequest | POST /api/v1/access-requests | published | published | docs/frontal-legacy/README.md |
| batchAccessRequests | POST /api/v1/access-requests:batch | published | see notes/original text | docs/frontal-legacy/README.md |
| reviewAccessRequest | POST /api/v1/access-requests/:accessRequestId/reviews | published | published | docs/frontal-legacy/README.md |
| grantAccessRequest | POST /api/v1/access-requests/:accessRequestId/grant | published | published | docs/frontal-legacy/README.md |
| checkGrant | GET /api/v1/grants/:grantId/check | see original text | published | docs/frontal-legacy/README.md |
| revokeGrant | POST /api/v1/grants/:grantId/revoke | published | published | docs/frontal-legacy/README.md |
| createBreakGlass | POST /api/v1/break-glass-sessions | published | published | docs/frontal-legacy/manager-requirements.md |
| approveBreakGlass | POST /api/v1/break-glass-sessions/:breakGlassSessionId/approvals | published | published | docs/frontal-legacy/manager-requirements.md |
| activateBreakGlass | POST /api/v1/break-glass-sessions/:breakGlassSessionId/activate | published | published | docs/frontal-legacy/manager-requirements.md |
| closeBreakGlass | POST /api/v1/break-glass-sessions/:breakGlassSessionId/close | published | published | docs/frontal-legacy/manager-requirements.md |
| checkBreakGlass | POST /api/v1/break-glass-sessions/:breakGlassSessionId/check | published | published | docs/frontal-legacy/manager-requirements.md |
| quarantineRegion | POST /api/v1/regions/:region/quarantine | published | published | docs/frontal-legacy/manager-requirements.md |
| releaseRegion | POST /api/v1/regions/:region/release | published | published | docs/frontal-legacy/manager-requirements.md |
| reviewRetrospective | POST /api/v1/break-glass-sessions/:breakGlassSessionId/retrospective-reviews | published | published | docs/frontal-legacy/manager-requirements.md |
| snapshot | GET /api/v1/verification-snapshot | see original text | published | docs/frontal-legacy/README.md |

## Wire clarifications and limits

- The original seed header does not state types for schemaVersion/seedVersion/importedAt. This v4 starter publishes 1/string/UTC timestamp and an author-owned single-Tenant fixture as an explicit wire clarification. Its remaining arrays are empty and it contains no secret or hidden test data.
- Batch access request success envelope is not specified. Complete it in the public contract before declaring full interface coverage; no envelope is guessed here.
- Field types not explicitly stated in the source stay unconstrained; business meaning, digests, references, sortedness and transactional invariants are not validated by this schema-only layer.
- Final snapshot uses the lower-camel plural keys for the four Manager resources. No new seed arrays are added to the explicitly closed V1 seed whitelist.
- Policy publication/rollback return the newly created PolicyRevision; subject revocation returns the subject resource, following Successful response contracts.
- The public chain reads its seeded Tenant, creates a PolicyBundle using HTTP, captures the actual policyBundleId/currentRevision, verifies it in the PostgreSQL snapshot, publishes one PolicyRevision using the captured revision and snapshot time, then verifies the committed revision and Bundle pointer in a new snapshot. It does not accept a create-response echo or only empty resource reads as completion.
- v4 wire clarification: a newly created PolicyBundle begins at currentRevision:0 before any PolicyRevision exists. Its first successful publication creates revision:1 and moves currentPolicyRevisionId to that new identity. This fixes the starting representation for the already published revision+1 semantics; it adds no new business transition or route.

## Acceptance boundary

Public checks require a successful create → operation → query chain and verify returned IDs/state through the public snapshot. They prove only the tested integration surface, not exhaustive business correctness, all seed combinations, concurrency, recovery, authorization, UI or performance. Implement and verify the ENTIRE README; no finite smoke test guarantees all hidden cases pass.
A local Guide finishing or public smoke passing does not mean the task is finished. Only submit after full README audit and final verification.
A public gate failure is returned verbatim to the Coding Agent for repair in the same session. Infrastructure failures stop with diagnostics; they are not business test failures. Once the gate passes, the exact checked source is frozen before hidden evaluation.
