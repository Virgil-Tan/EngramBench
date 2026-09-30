# CreatorRightsExchange

Build a production-shaped, multi-tenant platform that takes a creator's media from resumable upload through
clean transcoding, immutable publication, paid licensing, entitlement delivery, royalty accounting, and ordered
notifications. This repository intentionally contains only this contract and `AGENTS.md`; implement the system
from scratch without replacing any required behavior with mocks or in-memory state.

The challenge is one connected commercial lifecycle. An accepted media byte must remain bound to the exact
Edition, rights split, License, royalty posting, and notification that were derived from it. A retry, process
death, stale lease, unknown provider response, fraud review, refund, or concurrent request must not create a
second commercial fact or expose an entitlement before its authority exists.

## Required stack and processes

- Node.js 22, TypeScript, React, and PostgreSQL 16.
- `start:api`, `start:worker`, and `start:dispatcher` are independent long-running processes. Correctness may not
  depend on process-local queues, maps, locks, clocks, or idempotency caches.
- The production UI is served by `start:api` at `/`; it must use the real HTTP endpoints.
- Do not require Redis, object storage, a browser download, Docker-in-Docker, or any network service other than
  the supplied PostgreSQL and webhook receiver. Media bytes live below `MANAGED_DATA_ROOT` using safe relative
  storage keys, while PostgreSQL owns all metadata and authority.

## Environment

The implementation must honor:

```text
DATABASE_URL
TEST_DATABASE_URL
PORT
ADMIN_TOKEN
WEBHOOK_URL
WORK_LEASE_SECONDS
CHROMIUM_PATH
MANAGED_DATA_ROOT
TEST_BARRIER_URL
TEST_BARRIER_TOKEN
```

Bind HTTP only to `127.0.0.1`. Never print secrets, authorization values, media bytes, provider event bodies,
buyer references, creator payout details, or absolute managed-data paths.

## Common HTTP rules

- Publish OpenAPI 3.1 at `GET /openapi.json`; it must describe every route and response below.
- JSON objects are closed: reject unknown members. Reject malformed JSON as
  `400 {"error":{"code":"MALFORMED_JSON"}}` before any durable side effect.
- Every mutation, including raw chunk upload, requires a non-empty `Idempotency-Key` scoped by tenant, method,
  and canonical route. Persist the status and exact response body in the same transaction as the effect.
- Same key and same canonical request replays the exact response across concurrent API processes and restarts.
  Same key with different request content returns `409 IDEMPOTENCY_CONFLICT` without side effects.
- Domain errors use `{"error":{"code":string,"message":string,"details"?:object}}`. Validation failures are
  400, missing resources 404, stale revision/state and uniqueness conflicts 409, and authentication failures
  401/403. A rejected transaction may create neither resource rows, Work, Event, nor media files.
- UUIDs are lowercase RFC 4122 strings. Timestamps are UTC RFC 3339 strings. Money is integer minor units plus
  uppercase ISO currency. Rights shares are integer basis points.
- List routes use stable `(createdAt,id)` cursors and return `{items,nextCursor}`. Invalid or cross-tenant cursors
  return 400. No response may expose another tenant's identifier or storage key.

## Domain records

The public JSON shapes are:

```text
Tenant = {tenantId,name}
Creator = {creatorId,tenantId,displayName,payoutCurrency}
Work = {workId,tenantId,externalRef,title,currentRightsRevision}
RightsSplit = {workId,revision,creatorId,basisPoints,effectiveFrom}

UploadSession = {
  uploadId,tenantId,workId,fileName,mediaType,totalBytes,chunkSize,contentSha256,
  requiredProfileIds,state:OPEN|COMPLETED|ABORTED|EXPIRED,createdAt,expiresAt,completedAt
}
UploadChunk = {uploadId,chunkNumber,startByte,endByte,sizeBytes,sha256,createdAt}
BlobObject = {blobId,tenantId,sha256,sizeBytes,state:QUARANTINED|PROCESSING|READY|REJECTED,createdAt}
ScanJob = {scanJobId,assetId,state:PENDING|RUNNING|CLEAN|INFECTED|FAILED,attempt,leaseOwner,leaseToken,leaseExpiresAt}
ScanResult = {scanResultId,scanJobId,assetId,verdict:CLEAN|INFECTED,engineVersion,contentSha256,createdAt}
TranscodeProfile = {profileId,tenantId,revision,name,operation:COPY|PREFIX_BASE64,prefixBase64:null|string,active}
TranscodeJob = {transcodeJobId,assetId,profileId,profileRevision,state:PENDING|RUNNING|READY|FAILED,attempt,leaseOwner,leaseToken,leaseExpiresAt}
Rendition = {renditionId,assetId,profileId,profileRevision,sha256,sizeBytes,state:READY,createdAt}

Edition = {
  editionId,tenantId,workId,title,revision,state:DRAFT|PUBLISHED,rightsRevision,
  manifestDigest,publishedAt,createdAt
}
EditionAsset = {editionId,ordinal,assetId,renditionId,assetSha256,renditionSha256}
LicenseOffer = {
  offerId,tenantId,editionId,state:ACTIVE|RETIRED,licenseType:STREAM|DOWNLOAD,
  territories:string[],priceMinor,currency,termsVersion,createdAt
}

PurchaseOrder = {
  purchaseOrderId,tenantId,buyerRef,offerId,editionId,priceMinor,currency,termsVersion,
  rightsRevision,state:RISK_PENDING|REVIEW|PAYMENT_PENDING|LICENSED|BLOCKED|FAILED,
  providerRequestId,sequence,createdAt,terminalAt
}
FraudAssessment = {
  assessmentId,purchaseOrderId,rulesVersion,score,recommendation:APPROVE|REVIEW|BLOCK,
  state:PENDING|COMPLETED,createdAt,completedAt
}
ReviewCase = {reviewCaseId,purchaseOrderId,state:OPEN|CLAIMED|DECIDED,reviewerId,leaseToken,leaseExpiresAt,outcome,reasonCode,revision}
PaymentIntent = {paymentIntentId,purchaseOrderId,providerRequestId,amountMinor,currency,state:PENDING|UNKNOWN|SUCCEEDED|FAILED,sequence,createdAt,resolvedAt}
License = {licenseId,tenantId,purchaseOrderId,editionId,buyerRef,licenseType,territories,rightsRevision,state:ACTIVE|REVOKED,grantedAt,revokedAt}
EntitlementGrant = {grantId,tenantId,licenseId,buyerRef,editionId,state:ACTIVE|REVOKED,revision,grantedAt,revokedAt}
Refund = {refundId,licenseId,providerRequestId,amountMinor,currency,state:PENDING|UNKNOWN|SUCCEEDED|FAILED,createdAt,resolvedAt}

RoyaltyAccount = {royaltyAccountId,tenantId,ownerType:PLATFORM|CREATOR,ownerId,currency}
RoyaltyEntry = {
  royaltyEntryId,postingId,tenantId,royaltyPeriodId,royaltyAccountId,ownerId,
  accountRole:PLATFORM_CLEARING|CREATOR_PAYABLE|REFUND_CLEARING,
  direction:DEBIT|CREDIT,amountMinor,currency,sourceType:LICENSE|REFUND,sourceId,createdAt
}
RoyaltyPeriod = {royaltyPeriodId,tenantId,currency,periodStart,periodEnd,state:OPEN|CLOSING|CLOSED,closedAt,snapshotDigest}
Notification = {notificationId,tenantId,aggregateType,aggregateId,sequence,templateKey,payload,state:PENDING|DELIVERED,createdAt}
Delivery = {deliveryId,notificationId,eventId,attempt,state:PENDING|UNKNOWN|DELIVERED,nextAttemptAt,providerReceiptId}
```

## 1. Creator, Work, and rights authority

`POST /api/v1/tenants`, `POST /api/v1/creators`, and `POST /api/v1/works` create their named records.
`Work.externalRef` is unique per tenant. Cross-tenant references are rejected.

`POST /api/v1/works/:workId/rights-splits` accepts:

```json
{
  "expectedRevision": 1,
  "effectiveFrom": "2026-09-01T00:00:00.000Z",
  "splits": [
    {"creatorId": "uuid", "basisPoints": 6000},
    {"creatorId": "uuid", "basisPoints": 4000}
  ]
}
```

Creator IDs must be unique, belong to the Work tenant, and sum to exactly 10,000 basis points. The route uses
`expectedRevision` CAS, stores the normalized rows by ascending `creatorId`, and advances
`Work.currentRightsRevision`. Old revisions are immutable. A published Edition always keeps the revision it
froze; a later Work split never retroactively changes an Edition or its royalty allocation.

`POST /api/v1/transcode-profiles` creates immutable numbered profile revisions. A profile used by any completed
asset cannot be rewritten or deleted.

## 2. Resumable media ingestion

`POST /api/v1/uploads` accepts:

```json
{
  "tenantId":"uuid",
  "workId":"uuid",
  "fileName":"master.mp4",
  "mediaType":"video/mp4",
  "totalBytes":1048576,
  "chunkSize":262144,
  "contentSha256":"64 lowercase hex",
  "requiredProfileIds":["uuid"]
}
```

`totalBytes` is 1..2 GiB, `chunkSize` is 64 KiB..8 MiB, and profile IDs are unique and active in the same
tenant. The response is `{uploadSession:UploadSession}`. Creation schedules durable `UPLOAD_EXPIRY` Work.

`PUT /api/v1/uploads/:uploadId/chunks/:chunkNumber` consumes raw bytes and requires `Content-Range`,
`X-Chunk-Sha256`, and `Idempotency-Key`. Chunk numbers start at 1. The range must exactly match `chunkSize`
except the last chunk; bytes, digest, and range must agree. Same number and same digest replays. Same number with
different bytes or metadata returns `409 CHUNK_CONFLICT`. A bad chunk leaves no row and no file. Write to a
temporary file, fsync, atomically rename below `MANAGED_DATA_ROOT`, then commit metadata; cleanup orphan
temporary files after failure.

`GET /api/v1/uploads/:uploadId` returns `{uploadSession,chunks:[UploadChunk,...]}`. `POST
/api/v1/uploads/:uploadId/abort` changes only OPEN to ABORTED. `POST /api/v1/uploads/:uploadId/complete`
accepts `{contentSha256,chunks:[{chunkNumber,sha256}]}` in ascending order. It locks the session, requires a
gapless exact manifest, streams assembly without loading the whole object into memory, verifies total size and
whole-object digest, and atomically creates one QUARANTINED `BlobObject`, one `VIRUS_SCAN` Work, one Event, and
the COMPLETED session. Concurrent completion converges on the same response. No media is publishable before a
CLEAN scan and all required renditions are READY.

## 3. Scan and transcode pipeline

Workers claim durable Work using `FOR UPDATE SKIP LOCKED`, a random `leaseToken`, `attempt`, and
`leaseExpiresAt`. The claim transaction does not perform external work. Completion uses an ownership-and-token
fence; a late worker after lease expiry may not write a result, rendition, Event, or terminal state.

The built-in scanner streams bytes and reports INFECTED only when it finds the ASCII EICAR marker; otherwise it
reports CLEAN with `engineVersion=creator-rights-scanner-v1`. This deterministic local adapter is the production
implementation for the benchmark and must not load the whole object into memory.

`POST /api/v1/scanner/results` accepts an external result identified by `{scanResultId,scanJobId,verdict,
engineVersion,contentSha256}`. The content digest must match the BlobObject. CLEAN schedules one TRANSCODE Work
per frozen `(profileId,profileRevision)`; INFECTED atomically rejects the asset and schedules no transcode.
Duplicate external results replay; contradictory verdicts return `409 SCAN_RESULT_CONFLICT`.

`POST /api/v1/scan-jobs/:scanJobId/reconcile` may recover UNKNOWN scanner outcomes but never bypass the token
fence. `GET /api/v1/assets/:assetId` and `GET /api/v1/assets/:assetId/renditions` expose only metadata. READY
means CLEAN plus every required frozen rendition. Rendition identity is unique by `(assetId,profileId,
profileRevision)`, and digest/size are verified before publication. COPY streams the source bytes unchanged;
PREFIX_BASE64 decodes `prefixBase64`, streams that prefix followed by source bytes, and rejects a prefix larger
than 64 KiB. No native codec or external process is required.

## 4. Immutable Edition publication

`POST /api/v1/editions` accepts `{tenantId,workId,title,assets:[{assetId,renditionId,ordinal}]}`. Assets and
renditions must be READY, same-tenant, belong to the Work upload lineage, have unique ordinals, and be listed in
ascending ordinal order. It creates revision 0 DRAFT and no commercial authority.

`POST /api/v1/editions/:editionId/publish` accepts `{expectedRevision:0}`. In one transaction it:

1. locks the DRAFT and Work;
2. freezes `Work.currentRightsRevision` whose shares sum to 10,000;
3. freezes every asset and rendition digest;
4. computes `manifestDigest = SHA-256(RFC8785({rightsRevision,assets}))`;
5. changes the Edition to PUBLISHED revision 1; and
6. writes one `edition.published` Event.

Published Editions and EditionAssets are immutable. Stale or repeated publication with different input returns
`409 EDITION_REVISION_CONFLICT`. `GET /api/v1/editions/:editionId` returns
`{edition,assets,rightsSplits}` from the frozen revision.

## 5. Offers, risk, payment, and License authority

`POST /api/v1/license-offers` accepts `{tenantId,editionId,licenseType,territories,priceMinor,currency,
termsVersion}`. Edition must be PUBLISHED, territories are unique uppercase ISO-3166 alpha-2 values in ascending
order, and price is positive. `GET /api/v1/license-offers/:offerId` returns `{offer,edition}`.

`POST /api/v1/purchases` accepts:

```json
{
  "tenantId":"uuid",
  "buyerRef":"opaque tenant-local string",
  "offerId":"uuid",
  "providerRequestId":"globally unique provider request",
  "riskContext":{"velocity":1,"country":"US","deviceTrust":"KNOWN"}
}
```

The acceptance transaction freezes offer price, currency, terms, Edition rights revision, and fraud rules
version; creates one PurchaseOrder, FraudAssessment, PaymentIntent, Work, and Event; and returns
`{purchaseOrder,paymentIntent}`. `providerRequestId` is unique and permanently bound to the same purchase.
The API must not claim payment success. RiskContext is accepted for deterministic local assessment but never
returned, snapshotted, emitted, or logged.

Fraud rules version 1 is public and deterministic: add 300 when `velocity >= 50`, 200 when `country == "XX"`,
and 100 when `deviceTrust == "NEW"`. Score below 300 is APPROVE, 300..599 is REVIEW, and >=600 is BLOCK.
Persist the score and version but never the RiskContext.

The fraud Worker produces APPROVE, REVIEW, or BLOCK from the frozen rules version. APPROVE permits payment
processing. REVIEW creates exactly one ReviewCase and freezes payment. BLOCK terminally blocks the order.
`POST /api/v1/review-cases/:reviewCaseId/claim` accepts `{reviewerId,leaseSeconds}` and returns a lease token.
`POST /api/v1/review-cases/:reviewCaseId/decisions` accepts `{reviewerId,leaseToken,outcome:APPROVE|BLOCK,
reasonCode}`. Only the active lease may decide; one immutable decision advances revision exactly once.

`POST /api/v1/provider/events` accepts `{providerEventId,providerRequestId,kind:PAYMENT|REFUND,
outcome:SUCCEEDED|FAILED|UNKNOWN,occurredAt}`. `providerEventId` is globally unique. Duplicate exact events
replay; conflicting reuse returns 409. State is monotonic by provider sequence and outcome authority: a late
UNKNOWN or FAILED event cannot undo SUCCEEDED. UNKNOWN remains non-terminal and schedules reconcile Work.
`POST /api/v1/payment-intents/:paymentIntentId/reconcile` is idempotent and respects the same ordering rule.

Only a completed APPROVE plus SUCCEEDED PaymentIntent may atomically create one ACTIVE License, one ACTIVE
EntitlementGrant, frozen royalty postings, notifications, and events, then mark PurchaseOrder LICENSED. Unique
constraints cover `purchaseOrderId`, `providerRequestId`, and grant authority. No crash point may expose only a
License, only an entitlement, or an unbalanced posting.

`GET /api/v1/purchases/:purchaseOrderId` returns `{purchaseOrder,fraudAssessment,reviewCase,paymentIntent,
license}`. `GET /api/v1/licenses/:licenseId` returns `{license,grant,offer,edition}`.

`GET /api/v1/entitlements/check?tenantId=&buyerRef=&editionId=` returns
`{allowed,licenseId|null,grantRevision|null}`. It is a strongly consistent authority read. Once a revocation
transaction commits, later reads on every API process must return `allowed:false`; caches may not outlive the
revision fence.

## 6. Refunds and entitlement revocation

`POST /api/v1/licenses/:licenseId/refunds` accepts `{amountMinor,reason,providerRequestId}`. Positive cumulative
PENDING, UNKNOWN, and SUCCEEDED refund amounts may not exceed captured price. Concurrent requests serialize.
The request creates Refund and processing Work but never predicts a provider result.

`POST /api/v1/refunds/:refundId/reconcile` and REFUND provider events use the same unknown-outcome ordering.
On SUCCEEDED, one transaction posts an exact royalty reversal against frozen original allocations. A full
refund also revokes the License and EntitlementGrant and advances the grant revision. Partial refunds preserve
the License. Replays and late events never double-reverse or re-enable access.

## 7. Royalty ledger and periods

Every posting contains at least two immutable RoyaltyEntries with one currency and equal debit/credit totals.
License revenue is allocated from the Edition's frozen RightsSplit. Compute integer floors, then distribute
remaining minor units by descending fractional remainder and ascending creatorId. The same input must always
produce the same entries; for 10,001 split 3333/3333/3334, creator C receives 3,335.

`GET /api/v1/royalty-ledger?tenantId=&ownerId=&cursor=` returns immutable entries and running totals. The route
may not derive balances from mutable License state.

`POST /api/v1/royalty-periods` accepts `{tenantId,currency,periodStart,periodEnd}` and creates or advances the
unique period to CLOSING. The close Worker uses a lease fence, includes exactly the entries in `[periodStart,
periodEnd)`, stores an RFC8785 SHA-256 snapshot digest, and changes to CLOSED atomically. CLOSED periods and
their included entries are immutable. `GET /api/v1/royalty-periods/:royaltyPeriodId` returns
`{period,accountTotals,entryCount}`.

## 8. Notifications and delivery

License grant, refund/revocation, Edition publication, and royalty close create Notifications in the same
transaction as their domain fact. Sequence is gapless per `(tenantId,aggregateType,aggregateId)`. Payloads use
frozen public identifiers and amounts only; they exclude media bytes, riskContext, payout data, and provider
payloads.

The dispatcher leases pending deliveries, POSTs JSON to `WEBHOOK_URL`, and sends a stable event ID header and
aggregate sequence header. It records delivery only after ACK. Connection loss after the receiver accepted the
body is UNKNOWN: retry the byte-identical body and event ID with a later attempt. `POST /api/v1/provider/receipts`
and `POST /api/v1/deliveries/:deliveryId/reconcile` deduplicate provider receipts and cannot reorder aggregate
sequences.

## 9. Work, Event, barriers, and migration

Work and Event are durable PostgreSQL records. All Work claims use leases and tokens. Every worker and
dispatcher must expose the test-only barrier only when both `TEST_BARRIER_URL` and `TEST_BARRIER_TOKEN` are
non-empty. POST `{point,kind,workId,aggregateId,attempt,leaseToken}` immediately after claim and immediately
after each external response, before commit. A barrier error or timeout fails the attempt safely; it is not a
reason to bypass fencing.

Events have stable `eventId`, aggregate sequence, canonical payload, and commit with the aggregate. Migrations
are forward-only and repeatable. They preserve resources, Work, Events, media storage keys, idempotency response
bytes, attempts, lease authority, rights revisions, and closed-period digests.

## 10. Verification snapshot

`GET /api/v1/verification-snapshot` requires `Authorization: Bearer ${ADMIN_TOKEN}` and returns:

```text
{
  schemaVersion:1,
  asOf,
  resources:{
    tenants,creators,works,rightsSplits,uploadSessions,uploadChunks,blobObjects,
    scanJobs,scanResults,transcodeProfiles,transcodeJobs,renditions,editions,editionAssets,
    licenseOffers,purchaseOrders,paymentIntents,fraudAssessments,reviewCases,licenses,
    entitlementGrants,refunds,royaltyAccounts,royaltyEntries,royaltyPeriods,notifications,deliveries
  },
  work:[{workId,kind,aggregateId,state,attempt,leaseOwner,leaseToken,leaseExpiresAt,terminal}],
  events:[{eventId,aggregateType,aggregateId,sequence,type,payload,createdAt}]
}
```

Arrays use the sort order implied by their identifiers and never contain storage keys, local paths, secrets,
raw bytes, riskContext, provider bodies, or lease tokens usable as credentials. A FINAL migration may add keys
to `resources`; it may not remove or rewrite V1 values.

## 11. Seed contract

`npm run db:seed -- --file <json>` accepts exactly `schemaVersion`, `seedVersion`, optional `importedAt`, and
these arrays:

```text
tenants creators works rightsSplits uploadSessions uploadChunks blobObjects scanJobs scanResults
transcodeProfiles transcodeJobs renditions editions editionAssets licenseOffers purchaseOrders
paymentIntents fraudAssessments reviewCases licenses entitlementGrants refunds royaltyAccounts
royaltyEntries royaltyPeriods notifications deliveries
```

Unknown top-level or nested members fail. Validate every reference, tenant, state, digest, range, frozen
revision, rights total, money conservation, ledger balance, sequence, and uniqueness before writing anything.
Same `seedVersion` and canonical digest replays exactly; reuse with different content returns non-zero without
changes. Import resources, Work, Events, and file metadata in one atomic boundary. An empty valid seed is valid.
Seeded `BlobObject` and `Rendition` records additionally require `contentBase64`; the importer decodes beneath a
derived safe storage key and verifies `sizeBytes` and `sha256`. `contentBase64` and the derived key are never
returned by HTTP, snapshot, Event, or logs.

## 12. Production UI

The React UI must provide real API-backed views for:

- upload creation, chunk progress, resume, abort, scan/transcode state, and safe failure details;
- Work rights history and immutable Edition creation/publication;
- offers, checkout, fraud review queue, payment uncertainty, License, entitlement, and refund state;
- balanced royalty ledger, creator totals, period close status, and snapshot digest; and
- notification/delivery attempts and recovery state.

Every control has a visible label, pending state, success/error result, and keyboard access. Refreshing or using
a second browser must show committed server state. Do not hide missing backend behavior behind optimistic UI.

## 13. Required commands

`package.json` must publish non-interactive commands:

```text
npm run build
npm run db:migrate
npm run db:seed -- --file <path>
npm run start:api
npm run start:worker
npm run start:dispatcher
npm run test:unit
npm run test:integration
npm run test:e2e
npm run test:concurrency
npm run test:recovery
npm run test:perf
npm run test:all
```

Unit tests cover canonicalization, integer allocation, state transitions, and range math. Integration tests use
real PostgreSQL and managed files. E2E uses production build plus `CHROMIUM_PATH`. Concurrency uses at least two
API and two Worker processes. Recovery uses barriers and real SIGKILL. Tests use `TEST_DATABASE_URL`, unique
temporary directories, and clean every process/file they create.

## 14. Six required pressure scenarios

`npm run test:perf` owns these exact scenarios and reports scenario ID, fixture size, concurrency, throughput,
p50/p95/p99, status counts, duration, process RSS, and post-load invariants. A failure exits non-zero.

1. **`multipart-edition-pipeline`** — 240 two-chunk media assets, 32 upload clients, four Workers. Complete CLEAN
   scan and one frozen rendition for every asset at at least 20 assets/minute. No duplicate blob, scan result,
   rendition, temporary file, or stale lease completion; RSS per process stays below 768 MiB.
2. **`license-checkout-uncertainty`** — 64 clients, 10-second warmup and 60-second measure, at least 150 accepted
   purchases/second with p95 <= 500 ms. Ten percent receive an unknown provider response followed by duplicate
   and out-of-order events. Exactly one PaymentIntent and at most one License authority exist per purchase.
3. **`fraud-review-release`** — 1,000 REVIEW purchases, 64 reviewers, four Workers. Freeze one rules result and
   complete at least 20 decisions/second with no double decision, premature payment, or lease bypass.
4. **`entitlement-read-storm`** — seed 20,000 active grants; 128 clients, 10-second warmup and 60-second measure.
   Sustain at least 2,000 checks/second with p95 <= 80 ms while revocation fences become visible across two API
   processes. No false allow may occur after the committed fence.
5. **`royalty-ledger-close`** — close 100,000 balanced entries with four Workers in <= 60 seconds. Kill one
   claimant after `worker.claimed`; a replacement must close once, preserve every posting, and reproduce the
   snapshot digest.
6. **`notification-recovery`** — drain 10,000 pending notifications with two dispatchers in <= 45 seconds while
   one response ACK is made unknown. Every aggregate remains ordered, and retry reuses exact event ID/body.

Throughput alone never passes. After each scenario verify resource counts, uniqueness, frozen digests, no
pending expired leases, balanced money, entitlement fences, ordered Events, and no leaked temporary files.

## Definition of done

The system is done only when a clean checkout installs, builds, migrates twice, accepts/replays/rejects seeds,
boots all roles, drives the production UI in Chromium, passes every published test command, and reports real
metrics. Unsupported shortcuts, placeholder tests, source-importing evaluator hooks, process-local correctness,
or claims without command evidence are incomplete.

## Successful response contracts

Successful response contracts are closed:

- A mutation route without a literally stated success status returns 200.
- Unless a route literally publishes another object, array, or empty body, a success described by a named resource, named resource state, or named resource fields returns that exact resource shape at the JSON top level. Any response-only fields literally named by the route are additional top-level fields.
- If a mutation publishes no success body, it returns the exact current shape of the single primary resource created or changed by that route at the JSON top level.
- When a route explicitly returns multiple named resources, the body is one object keyed by their lower-camel resource names unless the route publishes another literal shape.
- Wrappers such as `{data:...}`, `{result:...}`, or an extra single-resource envelope are invalid unless the route literally declares them. OpenAPI must publish the same success status and closed response schema as runtime.
