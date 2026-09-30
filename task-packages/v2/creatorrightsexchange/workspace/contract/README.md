# CreatorRightsExchange — V2 fixed public interface

Author scaffold revision 2026-09-08.1: exact decimal validation and incremental seed-file decoding. This is a revised public scaffold, not the unchanged historical evaluation environment. Business requirements and seed scale remain unchanged.

Business requirements: read the COMPLETE ../docs/frontal-legacy/README.md and manager-requirements.md. The files are preserved verbatim. The wire clarifications below override only ambiguous representations, never remove business requirements.
Public author policy revision creator-royalty-digest-v1: read the supplements below in full. They resolve explicitly identified business-policy and test-protocol omissions; only an explicitly named author-approved exception overrides a corresponding original rule, and every other original obligation remains in force. This revision must not be compared as an unchanged historical benchmark.

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
| ui | GET / | docs/frontal-legacy/README.md §Required stack and processes |
| health | GET /healthz | contract/README.md (V2 public wire clarification) |
| openapi | GET /openapi.json | docs/frontal-legacy/README.md §Common HTTP rules |
| createTenant | POST /api/v1/tenants | contract/README.md (V2 public wire clarification) |
| createCreator | POST /api/v1/creators | contract/README.md (V2 public wire clarification) |
| createWork | POST /api/v1/works | contract/README.md (V2 public wire clarification) |
| setRightsSplits | POST /api/v1/works/:workId/rights-splits | contract/README.md (V2 public wire clarification) |
| createTranscodeProfile | POST /api/v1/transcode-profiles | contract/README.md (V2 public wire clarification) |
| createUpload | POST /api/v1/uploads | docs/frontal-legacy/README.md §2 |
| putUploadChunk | PUT /api/v1/uploads/:uploadId/chunks/:chunkNumber | docs/frontal-legacy/README.md §2 |
| getUpload | GET /api/v1/uploads/:uploadId | docs/frontal-legacy/README.md §2 |
| abortUpload | POST /api/v1/uploads/:uploadId/abort | docs/frontal-legacy/README.md §2 |
| completeUpload | POST /api/v1/uploads/:uploadId/complete | docs/frontal-legacy/README.md §2 |
| recordScanResult | POST /api/v1/scanner/results | docs/frontal-legacy/README.md §3 |
| reconcileScanJob | POST /api/v1/scan-jobs/:scanJobId/reconcile | docs/frontal-legacy/README.md §3 |
| getAsset | GET /api/v1/assets/:assetId | contract/README.md (V2 public wire clarification) |
| listAssetRenditions | GET /api/v1/assets/:assetId/renditions | docs/frontal-legacy/README.md §3 |
| createEdition | POST /api/v1/editions | docs/frontal-legacy/README.md §4 |
| publishEdition | POST /api/v1/editions/:editionId/publish | docs/frontal-legacy/README.md §4 |
| getEdition | GET /api/v1/editions/:editionId | docs/frontal-legacy/README.md §4 |
| createLicenseOffer | POST /api/v1/license-offers | contract/README.md (V2 public wire clarification) |
| getLicenseOffer | GET /api/v1/license-offers/:offerId | docs/frontal-legacy/README.md §5 |
| createPurchase | POST /api/v1/purchases | docs/frontal-legacy/README.md §5 |
| claimReviewCase | POST /api/v1/review-cases/:reviewCaseId/claim | docs/frontal-legacy/README.md §5 |
| decideReviewCase | POST /api/v1/review-cases/:reviewCaseId/decisions | docs/frontal-legacy/README.md §5 |
| recordProviderEvent | POST /api/v1/provider/events | contract/README.md (V2 public wire clarification) |
| reconcilePaymentIntent | POST /api/v1/payment-intents/:paymentIntentId/reconcile | docs/frontal-legacy/README.md §5 |
| getPurchase | GET /api/v1/purchases/:purchaseOrderId | docs/frontal-legacy/README.md §5 |
| getLicense | GET /api/v1/licenses/:licenseId | docs/frontal-legacy/README.md §5 |
| checkEntitlement | GET /api/v1/entitlements/check | docs/frontal-legacy/README.md §5 |
| createRefund | POST /api/v1/licenses/:licenseId/refunds | docs/frontal-legacy/README.md §6 |
| reconcileRefund | POST /api/v1/refunds/:refundId/reconcile | docs/frontal-legacy/README.md §6 |
| getRoyaltyLedger | GET /api/v1/royalty-ledger | docs/frontal-legacy/README.md §7 |
| closeRoyaltyPeriod | POST /api/v1/royalty-periods | docs/frontal-legacy/README.md §7 |
| getRoyaltyPeriod | GET /api/v1/royalty-periods/:royaltyPeriodId | docs/frontal-legacy/README.md §7 |
| recordProviderReceipt | POST /api/v1/provider/receipts | docs/frontal-legacy/README.md §8 |
| reconcileDelivery | POST /api/v1/deliveries/:deliveryId/reconcile | docs/frontal-legacy/README.md §8 |
| verificationSnapshot | GET /api/v1/verification-snapshot | contract/README.md (V2 public wire clarification) |
| createRightsDispute | POST /api/v1/rights-disputes | docs/frontal-legacy/manager-requirements.md |
| getRightsDispute | GET /api/v1/rights-disputes/:rightsDisputeId | docs/frontal-legacy/manager-requirements.md |
| resolveRightsDispute | POST /api/v1/rights-disputes/:rightsDisputeId/resolve | docs/frontal-legacy/manager-requirements.md |
| createLicenseHold | POST /api/v1/license-holds | docs/frontal-legacy/manager-requirements.md |
| releaseLicenseHold | POST /api/v1/license-holds/:licenseHoldId/release | docs/frontal-legacy/manager-requirements.md |
| createRoyaltyAdjustment | POST /api/v1/royalty-adjustments | docs/frontal-legacy/manager-requirements.md |

## Explicit V2 wire clarifications

- Author-approved policy creator-royalty-digest-v1 supplements README section 7: snapshotDigest = lowercaseHex(SHA256(UTF8(RFC8785(entries)))). This is an explicit new digest contract, not a retroactive interpretation of old submissions. See contract.json royaltyDigest for complete rules and fixed input/expectedDigest vectors.
- Royalty digest selection: All committed RoyaltyEntries with entry.tenantId == period.tenantId, entry.currency == period.currency, and periodStart <= createdAt < periodEnd, comparing UTC instants. ownerId and royaltyPeriodId are not extra selection filters; royaltyPeriodId remains an authenticated field. Closing must not rewrite immutable entries to make the selection fit.
- Royalty digest fields: royaltyEntryId, postingId, tenantId, royaltyPeriodId, royaltyAccountId, ownerId, accountRole, direction, amountMinor, currency, sourceType, sourceId, createdAt. A bare JSON array of objects containing exactly the listed public fields. Field values are unchanged except the createdAt normalization above. No period wrapper, period metadata, accountTotals, entryCount, closedAt, snapshotDigest, newline, BOM or internal database columns. Missing public fields are invalid, not silently omitted. The empty array is valid and has the empty-array digest below.
- Royalty digest order: createdAt ascending by UTC instant with all fractional precision; royaltyEntryId ascending by UTF-8 byte order. In the hash projection ONLY: uppercase T/Z, replace +00:00 with Z, remove trailing zeros from the fractional seconds and remove the decimal point if the fraction becomes empty. Preserve all significant fractional digits. Do not use Date.toISOString() to round/truncate submillisecond precision. Do not rewrite stored records or unrelated signed/idempotent payloads.
- Royalty digest seed: A CLOSED period imported through the published seed interface uses this same scope, field projection, ordering and normalization over the seed royaltyEntries. The importer validates this digest and imports atomically; OPEN/CLOSING periods keep snapshotDigest:null. Exact seed replay/conflict rules remain unchanged.
- The service still selects the exact committed rows, closes with a lease fence and transaction, preserves CLOSED periods/entries, and implements idempotency, conservation, recovery and concurrency. These vectors test only digest conformance, not a complete legal seed or business workflow.
- HTTP binds only to 127.0.0.1, as required by the original README. The author-owned transport reads contract.httpHost; PORT selects only the port, not a wider network interface.
- Authority is workspace/README.md plus the original public README and Manager requirements. The Manager closing instruction about delaying code is legacy orchestration metadata, not product behavior.
- Every mutation requires a non-empty Idempotency-Key scoped by tenant, method and canonical route. Exact response/status replay is durable and transactional; changed canonical input returns 409 IDEMPOTENCY_CONFLICT. Unknown JSON members fail before effects. Malformed JSON has the literal code-only error body, unlike other domain errors requiring message.
- V2 public wire clarification: GET /healthz returns 200 {status:"ok"} for API startup readiness. GET/HEAD requests have no body. Entitlement-check requires tenantId, buyerRef and editionId; royalty-ledger requires tenantId and ownerId, with optional cursor; asset-renditions accepts optional cursor. Other query keys are invalid. All path identities are lowercase UUIDs except positive integer chunkNumber. List cursors are opaque stable (createdAt,id) cursors; invalid/cross-tenant cursors return 400.
- PUT chunk bodies are raw bytes and require Content-Range, X-Chunk-Sha256 and Idempotency-Key. The schema contentMediaType marks non-JSON media; range/digest agreement, final-chunk math and disk atomicity remain business obligations.
- V2 public wire clarification resolves the original seed whitelist versus atomic Work/Event import tension: retain all 27 required resource arrays and allow optional top-level work and events arrays using the exact snapshot shapes. Missing work/events means empty. schemaVersion is an integer, seedVersion is a string and optional importedAt is UTC RFC3339. Unknown other fields remain invalid. Import resource/file metadata, durable Work and Events atomically; exact canonical seed replay is a no-op and conflicting seedVersion fails without changes.
- The nonempty public seed contains one linked Tenant, Creator, Work, rights revision summing to 10000 and two immutable profiles with distinct revisions. SeedBlobObject and SeedRendition alone add contentBase64; public records never expose bytes or storage keys. Fixed seed identities are example data, not special-case runtime behavior.
- Profile revision clarification creator-profile-revision-v1: profileId identifies the immutable profile and the returned revision must be preserved in frozen TranscodeJob/Rendition references. Seed import preserves the supplied profileId and revision, including a revision greater than 1; it must not renumber them. The original requirements do not prescribe whether revision allocation is tenant-wide or per profile. Evaluation does not require equal revision numbers across different profiles and does not assert a particular next number; ordinary seed examples use distinct revisions within each tenant. Immutability, exact frozen references, tenant isolation and seed replay/conflict checks remain mandatory.
- contract/README.md (v4 wire clarification) publishes rightsDisputes, licenseHolds and royaltyAdjustments as the three Manager snapshot resource arrays, in addition to the original 27. The original snapshot extension allowance remains. Snapshot Work is DurableWork, distinct from creator catalog Work. Lease values in snapshots must never be usable credentials.
- contract/README.md (v4 wire clarification) defines Tenant creation as {name}; profile creation as {tenantId,name,operation,prefixBase64}, using null prefixBase64 for COPY; rights-split mutation returns Work at the top level; asset detail returns BlobObject, with assetId identifying blobId. termsVersion is an integer and providerEventId is an opaque string, not necessarily a UUID. These clarify transport fields without adding business rules.
- contract/README.md (v4 wire clarification) defines Creator creation as {tenantId,displayName,payoutCurrency} and Work creation as {tenantId,externalRef,title}, returning their named closed records at the top level. Resource IDs and Work.currentRightsRevision are server-owned response fields. The initial rights revision is not fixed; callers pass the returned revision to rights-splits CAS. These public creation payloads clarify the named-record creation routes without prescribing internal module layout or persistence representation.
- V2 public wire clarification: upload completion returns {uploadSession:UploadSession,blobObject:BlobObject}; blobObject.blobId is the public asset identity. Abort and all reconcile operations take the closed empty JSON object {}. Provider events return the exact PaymentIntent for kind PAYMENT or Refund for kind REFUND; no extra event envelope. POST provider/receipts accepts {deliveryId,providerReceiptId}, binding a stable provider receipt to that delivery, and returns Delivery. Receipt replay/unknown ACK/order and no-premature-success requirements remain unchanged.
- V2 public wire clarification: royalty-ledger returns {items:RoyaltyEntry[],nextCursor:string|null,totals:LedgerTotals[]}. Totals cover all committed entries for tenantId+ownerId, independent of page cursor, grouped and sorted by currency. Each total is {currency,debitMinor,creditMinor,balanceMinor}, with nonnegative debit/credit totals and signed balanceMinor=creditMinor-debitMinor. Royalty-period accountTotals is an array of {royaltyAccountId,ownerId,currency,debitMinor,creditMinor,balanceMinor}, sorted by royaltyAccountId, covering exactly the period entries; entryCount is their count. SnapshotDigest and accounting conservation remain original business requirements. Notification/Event payload and domain-error details are explicitly free JSON objects subject to original privacy rules.
- Lifecycle fields such as completedAt, revokedAt, lease fields and pending assessment values have no complete public nullability matrix; these schemas allow null for absent lifecycle values without prescribing defaults.
- V2 public wire clarification: Manager adds PurchaseOrder LICENSE_HELD and License HELD; EntitlementGrant keeps ACTIVE/REVOKED and its authorization read checks Hold authority. Adjustment RoyaltyEntries use sourceType ADJUSTMENT and sourceId=royaltyAdjustmentId; the adjustment links originalPostingId and adjustmentPostingId, while entries retain original accountRole meanings. Original entries/CLOSED periods are never edited. Missing lifecycle values use null exactly where the published schemas allow it.
- evidenceRefs must be sorted, unique, opaque, 1..20 elements and at most 512 UTF-8 bytes each; JSON Schema maxLength counts characters, so byte limits remain runtime validation. References must never be fetched. Territory ISO membership/order, rights sum 10000 and unique creators require semantic validation.
- All explicit mutation successes default to status 200. A named single-resource success uses the exact top-level record; literal multi-resource/enveloped responses are preserved. No {data} or {result} wrapper is authorized.
- The smoke verifies the linked nonempty seed through the admin snapshot, creates independent Tenant/Creator/Work records, submits a 10000-basis-point rights revision and checks the same committed identities. Capture paths are arrays and preserve integer revisions. Each expectContains requires exactly one matching record; an empty list or response-only echo cannot pass. This does not certify media, licensing, concurrency, recovery or performance.
- V2 wire defaults absent from the legacy text are public: invalid wire input uses 400 INVALID_REQUEST, missing Idempotency-Key is invalid input, missing/malformed admin authorization uses 401 UNAUTHORIZED, wrong media type uses 415 UNSUPPORTED_MEDIA_TYPE, and unknown routes use 404 NOT_FOUND. Malformed JSON alone uses the original code-only 400 MALFORMED_JSON body. UTC timestamps may use Z or +00:00 with optional fractional precision. Additional snapshot resource arrays remain allowed; known resources and privacy/invariant checks remain mandatory.
- PostgreSQL 16 owns resources, idempotency, leases/fences, ordering, money and events. Node.js 22/TypeScript/React and independent API/worker/dispatcher processes, production UI at /, loopback binding, supplied Chromium, managed files, and transactional authority are required.
- The six required measured pressure scenarios are multipart-edition-pipeline, license-checkout-uncertainty, fraud-review-release, entitlement-read-storm, royalty-ledger-close and notification-recovery; their exact metrics, durations, real-process/Chromium/SIGKILL conditions and post-load invariants remain in README sections 13–14. Schema smoke is not evidence that those scenarios pass.

## Delivery

Public checks are necessary, not sufficient. Re-read the entire README, audit every observable requirement, and run all required project checks. Guide completion does not mean task completion. Do not return fixture-only responses or empty arrays to simulate completed workflows.
