# CreatorRightsExchange: public integration contract (taskVersion 4)

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
- 3. verificationSnapshot: HTTP 200.
- 4. createTenant: HTTP 400.
- 5. createTenant: HTTP 200; capture publicTenantId.
- 6. createCreator: HTTP 200; capture publicCreatorId.
- 7. createWork: HTTP 200; capture publicWorkId, publicInitialRightsRevision.
- 8. setRightsSplits: HTTP 200; capture publicUpdatedRightsRevision.
- 9. verificationSnapshot: HTTP 200.

## Published operations

| Operation | Method / path | Request schema | Response schema | Source |
| --- | --- | --- | --- | --- |
| ui | GET / | see original text | published | docs/frontal-legacy/README.md §Required stack and processes |
| health | GET /healthz | see original text | see notes/original text | contract/README.md (v4 wire clarification) |
| openapi | GET /openapi.json | see original text | published | docs/frontal-legacy/README.md §Common HTTP rules |
| createTenant | POST /api/v1/tenants | published | published | contract/README.md (v4 wire clarification) |
| createCreator | POST /api/v1/creators | published | published | contract/README.md (v4 wire clarification) |
| createWork | POST /api/v1/works | published | published | contract/README.md (v4 wire clarification) |
| setRightsSplits | POST /api/v1/works/:workId/rights-splits | published | published | contract/README.md (v4 wire clarification) |
| createTranscodeProfile | POST /api/v1/transcode-profiles | published | published | contract/README.md (v4 wire clarification) |
| createUpload | POST /api/v1/uploads | published | published | docs/frontal-legacy/README.md §2 |
| putUploadChunk | PUT /api/v1/uploads/:uploadId/chunks/:chunkNumber | published | published | docs/frontal-legacy/README.md §2 |
| getUpload | GET /api/v1/uploads/:uploadId | see original text | published | docs/frontal-legacy/README.md §2 |
| abortUpload | POST /api/v1/uploads/:uploadId/abort | see original text | published | docs/frontal-legacy/README.md §2 |
| completeUpload | POST /api/v1/uploads/:uploadId/complete | published | see notes/original text | docs/frontal-legacy/README.md §2 |
| recordScanResult | POST /api/v1/scanner/results | published | published | docs/frontal-legacy/README.md §3 |
| reconcileScanJob | POST /api/v1/scan-jobs/:scanJobId/reconcile | see original text | published | docs/frontal-legacy/README.md §3 |
| getAsset | GET /api/v1/assets/:assetId | see original text | published | contract/README.md (v4 wire clarification) |
| listAssetRenditions | GET /api/v1/assets/:assetId/renditions | see original text | published | docs/frontal-legacy/README.md §3 |
| createEdition | POST /api/v1/editions | published | published | docs/frontal-legacy/README.md §4 |
| publishEdition | POST /api/v1/editions/:editionId/publish | published | published | docs/frontal-legacy/README.md §4 |
| getEdition | GET /api/v1/editions/:editionId | see original text | published | docs/frontal-legacy/README.md §4 |
| createLicenseOffer | POST /api/v1/license-offers | published | published | contract/README.md (v4 wire clarification) |
| getLicenseOffer | GET /api/v1/license-offers/:offerId | see original text | published | docs/frontal-legacy/README.md §5 |
| createPurchase | POST /api/v1/purchases | published | published | docs/frontal-legacy/README.md §5 |
| claimReviewCase | POST /api/v1/review-cases/:reviewCaseId/claim | published | published | docs/frontal-legacy/README.md §5 |
| decideReviewCase | POST /api/v1/review-cases/:reviewCaseId/decisions | published | published | docs/frontal-legacy/README.md §5 |
| recordProviderEvent | POST /api/v1/provider/events | published | see notes/original text | contract/README.md (v4 wire clarification) |
| reconcilePaymentIntent | POST /api/v1/payment-intents/:paymentIntentId/reconcile | see original text | published | docs/frontal-legacy/README.md §5 |
| getPurchase | GET /api/v1/purchases/:purchaseOrderId | see original text | published | docs/frontal-legacy/README.md §5 |
| getLicense | GET /api/v1/licenses/:licenseId | see original text | published | docs/frontal-legacy/README.md §5 |
| checkEntitlement | GET /api/v1/entitlements/check | see original text | published | docs/frontal-legacy/README.md §5 |
| createRefund | POST /api/v1/licenses/:licenseId/refunds | published | published | docs/frontal-legacy/README.md §6 |
| reconcileRefund | POST /api/v1/refunds/:refundId/reconcile | see original text | published | docs/frontal-legacy/README.md §6 |
| getRoyaltyLedger | GET /api/v1/royalty-ledger | see original text | see notes/original text | docs/frontal-legacy/README.md §7 |
| closeRoyaltyPeriod | POST /api/v1/royalty-periods | published | published | docs/frontal-legacy/README.md §7 |
| getRoyaltyPeriod | GET /api/v1/royalty-periods/:royaltyPeriodId | see original text | published | docs/frontal-legacy/README.md §7 |
| recordProviderReceipt | POST /api/v1/provider/receipts | see original text | see notes/original text | docs/frontal-legacy/README.md §8 |
| reconcileDelivery | POST /api/v1/deliveries/:deliveryId/reconcile | see original text | published | docs/frontal-legacy/README.md §8 |
| verificationSnapshot | GET /api/v1/verification-snapshot | see original text | published | contract/README.md (v4 wire clarification) |
| createRightsDispute | POST /api/v1/rights-disputes | published | published | docs/frontal-legacy/manager-requirements.md |
| getRightsDispute | GET /api/v1/rights-disputes/:rightsDisputeId | see original text | published | docs/frontal-legacy/manager-requirements.md |
| resolveRightsDispute | POST /api/v1/rights-disputes/:rightsDisputeId/resolve | published | published | docs/frontal-legacy/manager-requirements.md |
| createLicenseHold | POST /api/v1/license-holds | published | published | docs/frontal-legacy/manager-requirements.md |
| releaseLicenseHold | POST /api/v1/license-holds/:licenseHoldId/release | published | published | docs/frontal-legacy/manager-requirements.md |
| createRoyaltyAdjustment | POST /api/v1/royalty-adjustments | published | published | docs/frontal-legacy/manager-requirements.md |

## Wire clarifications and limits

- Authority is workspace/README.md plus the original public README and Manager requirements. The Manager closing instruction about delaying code is legacy orchestration metadata, not product behavior.
- Every mutation requires a non-empty Idempotency-Key scoped by tenant, method and canonical route. Exact response/status replay is durable and transactional; changed canonical input returns 409 IDEMPOTENCY_CONFLICT. Unknown JSON members fail before effects. Malformed JSON has the literal code-only error body, unlike other domain errors requiring message.
- The original README publishes no health route. contract/README.md (v4 wire clarification) defines GET /healthz returning 200 for API startup readiness, without imposing a response body. No additional resource collection routes are inferred. The entitlement-check query names are tenantId, buyerRef and editionId; royalty-ledger query names are tenantId, ownerId and cursor. List cursors are stable (createdAt,id), and invalid/cross-tenant cursors return 400.
- PUT chunk bodies are raw bytes and require Content-Range, X-Chunk-Sha256 and Idempotency-Key. The schema contentMediaType marks non-JSON media; range/digest agreement, final-chunk math and disk atomicity remain business obligations.
- The seed explicitly permits only schemaVersion, seedVersion, optional importedAt, and the 27 published resource arrays. It simultaneously requires atomic import of Work and Events but publishes no top-level carrier for those records. Do not add work/events or Manager resource arrays to the accepted seed without clarifying this tension. The public text does not fix seed version value formats; the example uses 1 and a string label.
- Seed examples are empty resource arrays. SeedBlobObject and SeedRendition alone add contentBase64; public records never expose that content or storage keys. Seed atomicity, reference validation, canonical digest replay and non-zero rejection remain required.
- contract/README.md (v4 wire clarification) publishes rightsDisputes, licenseHolds and royaltyAdjustments as the three Manager snapshot resource arrays, in addition to the original 27. The original snapshot extension allowance remains. Snapshot Work is DurableWork, distinct from creator catalog Work. Lease values in snapshots must never be usable credentials.
- contract/README.md (v4 wire clarification) defines Tenant creation as {name}; profile creation as {tenantId,name,operation,prefixBase64}, using null prefixBase64 for COPY; rights-split mutation returns Work at the top level; asset detail returns BlobObject, with assetId identifying blobId. termsVersion is an integer and providerEventId is an opaque string, not necessarily a UUID. These clarify transport fields without adding business rules.
- contract/README.md (v4 wire clarification) defines Creator creation as {tenantId,displayName,payoutCurrency} and Work creation as {tenantId,externalRef,title}, returning their named closed records at the top level. Resource IDs and Work.currentRightsRevision are server-owned response fields. The initial rights revision is not fixed; callers pass the returned revision to rights-splits CAS. These public creation payloads clarify the named-record creation routes without prescribing internal module layout or persistence representation.
- Upload completion has no unique extractable response shape: asset identity can be obtained from the subsequent public scanJobs snapshot. Provider-event/provider-receipt success records are also unspecified. Their omitted schemas record a specification gap, not permission to implement an empty stub.
- Royalty-ledger publishes entries plus running totals but no names or shape for totals; royalty-period accountTotals has no item shape. No total fields or envelopes are invented. Notification/Event payload and domain-error details likewise have no published member schema.
- Lifecycle fields such as completedAt, revokedAt, lease fields and pending assessment values have no complete public nullability matrix; these schemas allow null for absent lifecycle values without prescribing defaults.
- Manager explicitly adds PurchaseOrder LICENSE_HELD and License HELD. EntitlementGrant gains no published HELD state. RoyaltyAdjustment creates new entries, but no additional RoyaltyEntry sourceType/accountRole literals are supplied; their V1 enums are retained pending clarification.
- evidenceRefs must be sorted, unique, opaque, 1..20 elements and at most 512 UTF-8 bytes each; JSON Schema maxLength counts characters, so byte limits remain runtime validation. References must never be fetched. Territory ISO membership/order, rights sum 10000 and unique creators require semantic validation.
- All explicit mutation successes default to status 200. A named single-resource success uses the exact top-level record; literal multi-resource/enveloped responses are preserved. No {data} or {result} wrapper is authorized.
- Smoke begins with an empty imported database, then creates a Tenant, Creator and Work, submits a 10000-basis-point rights revision, and verifies their committed resource rows through the admin snapshot. It captures all generated IDs and revisions from successful responses; whole-value placeholders preserve integer revisions. ADMIN_TOKEN is substituted in headers, string bodies are literal wire bytes, and expectBody uses structural comparison with exact array lengths. This exercises a real creation/update/read chain but does not prove the complete media, licensing, recovery or performance lifecycle.
- PostgreSQL 16 owns resources, idempotency, leases/fences, ordering, money and events. Node.js 22/TypeScript/React and independent API/worker/dispatcher processes, production UI at /, loopback binding, supplied Chromium, managed files, and transactional authority are required.
- The six required measured pressure scenarios are multipart-edition-pipeline, license-checkout-uncertainty, fraud-review-release, entitlement-read-storm, royalty-ledger-close and notification-recovery; their exact metrics, durations, real-process/Chromium/SIGKILL conditions and post-load invariants remain in README sections 13–14. Schema smoke is not evidence that those scenarios pass.

## Acceptance boundary

Public checks require a successful create → operation → query chain and verify returned IDs/state through the public snapshot. They prove only the tested integration surface, not exhaustive business correctness, all seed combinations, concurrency, recovery, authorization, UI or performance. Implement and verify the ENTIRE README; no finite smoke test guarantees all hidden cases pass.
A local Guide finishing or public smoke passing does not mean the task is finished. Only submit after full README audit and final verification.
A public gate failure is returned verbatim to the Coding Agent for repair in the same session. Infrastructure failures stop with diagnostics; they are not business test failures. Once the gate passes, the exact checked source is frozen before hidden evaluation.
