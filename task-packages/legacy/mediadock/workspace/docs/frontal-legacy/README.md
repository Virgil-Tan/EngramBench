# MediaDock

Build MediaDock from this intentionally blank repository. This README is the complete public product
contract. Ask before making a product choice that the contract does not settle.

## Required stack and commands

- Node.js 22, TypeScript, React, PostgreSQL 16, npm, and the preinstalled Chromium.
- PostgreSQL is authoritative for metadata, idempotency, leases, object references, jobs, grants, cleanup,
  events, and ordering. Bytes live only below `MANAGED_DATA_ROOT` on the local filesystem.
- The production UI must use the public HTTP API; browser-only state is never authoritative.

Required non-interactive commands:

```text
npm run db:migrate
npm run db:seed -- --file <path>
npm run dev
npm run build
npm run start:api
npm run start:worker
npm run start:dispatcher
npm run test:unit
npm run test:integration
npm run test:e2e
npm run test:concurrency
npm run test:recovery
npm run test:all
npm run test:perf
```

Every command must be non-interactive, exit non-zero on failure, and clean up child processes.

## Domain

MediaDock is a tenant-scoped file and media pipeline. Clients upload immutable content in resumable parts;
the system validates and atomically assembles bytes, gates access on virus scanning, creates deterministic
Renditions through leased Transcode jobs, issues temporary download capabilities, and safely removes
unreachable data through explicit Cleanup runs. It exposes a real React operations UI.

The benchmark uses deterministic local Scanner and Transcoder doubles. It evaluates orchestration, byte
integrity, isolation, recovery, and lifecycle safety rather than antivirus quality or codec fidelity.

### Canonical objects

```text
Tenant, UploadSession, UploadPart, BlobObject, MediaAsset, ScanJob, ScanResult,
TranscodeProfile, TranscodeJob, Rendition, AccessGrant, CleanupPolicy, CleanupRun,
CleanupEntry, OutboxEvent, Work
```

### State machines

```text
UploadSession: OPEN -> COMPLETING -> COMPLETED | ABORTED | EXPIRED | FAILED
MediaAsset:    QUARANTINED -> SCANNING -> CLEAN -> PROCESSING -> READY
                            |             |             |
                            +-> INFECTED  +-> FAILED    +-> FAILED
ScanJob:       PENDING -> RUNNING -> CLEAN | INFECTED | UNKNOWN | FAILED
TranscodeJob:  PENDING -> RUNNING -> SUCCEEDED | FAILED | CANCELLED
CleanupRun:    PLANNED -> RUNNING -> COMPLETED | FAILED
```

Only transitions supported by committed facts are allowed. A transition, its durable Work, object-reference
change, and Domain Event are committed in one PostgreSQL transaction.

### Exact public shapes

`uuid` is lowercase RFC 4122 text, `timestamp` is UTC ISO-8601 with millisecond precision and `Z`, `sha256`
is 64 lowercase hexadecimal characters, and `int` is a JSON safe integer.

```text
UploadSession = {uploadId:uuid,tenantId:uuid,fileName:string,contentType:string,expectedSize:int,expectedSha256:sha256,partSize:int,state:OPEN|COMPLETING|COMPLETED|ABORTED|EXPIRED|FAILED,expiresAt:timestamp,assetId:uuid|null,createdAt:timestamp,completedAt:timestamp|null,sequence:int}
UploadPart = {uploadId:uuid,partNumber:int,start:int,end:int,size:int,sha256:sha256,createdAt:timestamp}
BlobObject = {blobId:uuid,sha256:sha256,size:int,state:STAGING|COMMITTED|QUARANTINED|DELETING|DELETED,createdAt:timestamp,deletedAt:timestamp|null}
MediaAsset = {assetId:uuid,tenantId:uuid,sourceBlobId:uuid,fileName:string,contentType:string,size:int,sha256:sha256,state:QUARANTINED|SCANNING|CLEAN|PROCESSING|READY|INFECTED|FAILED,createdAt:timestamp,readyAt:timestamp|null,sequence:int}
ScanJob = {scanJobId:uuid,assetId:uuid,state:PENDING|RUNNING|CLEAN|INFECTED|UNKNOWN|FAILED,attempt:int,scannerRequestId:string,signature:string|null,createdAt:timestamp,finishedAt:timestamp|null}
TranscodeProfile = {profileId:uuid,tenantId:uuid,name:string,revision:int,operation:COPY|PREFIX,prefixBase64:string|null,maxAttempts:int,createdAt:timestamp}
TranscodeJob = {transcodeJobId:uuid,assetId:uuid,profileId:uuid,profileRevision:int,state:PENDING|RUNNING|SUCCEEDED|FAILED|CANCELLED,attempt:int,renditionId:uuid|null,createdAt:timestamp,finishedAt:timestamp|null}
Rendition = {renditionId:uuid,assetId:uuid,profileId:uuid,profileRevision:int,blobId:uuid,size:int,sha256:sha256,state:READY|FAILED|DELETED,createdAt:timestamp,deletedAt:timestamp|null}
AccessGrant = {grantId:uuid,tenantId:uuid,assetId:uuid,renditionId:uuid|null,expiresAt:timestamp,state:ACTIVE|REVOKED|EXPIRED,createdAt:timestamp,revokedAt:timestamp|null}
CleanupRun = {cleanupRunId:uuid,tenantId:uuid,policyRevision:int,cutoffAt:timestamp,state:PLANNED|RUNNING|COMPLETED|FAILED,plannedCount:int,deletedCount:int,createdAt:timestamp,finishedAt:timestamp|null,sequence:int}
```

Public shapes and snapshots never include filesystem paths, raw grant tokens, token hashes, scanner payloads,
signing keys, temporary filenames, or physical reference counts.

## Multipart upload contract

1. `POST /api/v1/uploads` freezes `expectedSize`, `expectedSha256`, `partSize`, file metadata, and expiry.
   Size is 1..1,073,741,824 bytes; part size is 8,192..8,388,608 bytes; at most 10,000 parts are allowed.
2. `PUT /api/v1/uploads/:uploadId/parts/:partNumber` consumes `application/octet-stream`, exact
   `Content-Range: bytes start-end/total`, `X-Part-SHA256`, and `Idempotency-Key` headers.
3. A part must match its deterministic range. Exact replay returns the same UploadPart; different bytes,
   digest, range, or length for the same part is `UPLOAD_PART_CONFLICT` and leaves the old part unchanged.
4. Parts may arrive in any order and from different API processes. `GET /api/v1/uploads/:uploadId` reports
   the complete sorted part manifest so a client can resume without re-uploading accepted parts.
5. `POST /api/v1/uploads/:uploadId/complete` supplies the ordered `{partNumber,sha256,size}` manifest.
   Completion requires complete non-overlapping coverage, re-hashes assembled bytes, and compares the frozen
   whole-object digest and size.
6. Concurrent complete calls create one BlobObject, one MediaAsset, one ScanJob, and one response identity.
   Assembly uses a staging file and atomic promotion; no partial committed Blob may be observed.
7. Abort or expiry fences later part writes and complete. A completed Upload cannot be aborted or rewritten.

## Blob identity and tenant isolation

1. Committed bytes are content addressed by SHA-256. Identical content may share physical storage, but each
   tenant has independent MediaAsset, authorization, events, grants, and deletion references.
2. Deduplication must not disclose whether another tenant owns matching bytes through response body, timing
   class, errors, snapshot, or UI.
3. All derived paths are internal and rooted below `MANAGED_DATA_ROOT`. Client filenames, tenant IDs, UUIDs,
   headers, and archive names are never interpreted as filesystem paths.
4. Promotion, reference creation, and deletion are crash-safe. A database row may never point at a missing or
   partially written committed Blob.

## Virus scan gate

1. Completion creates a QUARANTINED MediaAsset and one ScanJob. Source download, AccessGrant issuance, and
   Transcode are forbidden until the ScanJob reaches CLEAN.
2. The deterministic Scanner returns INFECTED when source bytes contain the ASCII marker
   `EICAR-STANDARD-ANTIVIRUS-TEST-FILE`; all other bytes are CLEAN unless a test barrier requests a transient
   timeout or connection reset.
3. Timeout or connection reset becomes UNKNOWN and is reconciled using the stable `scannerRequestId`; it must
   not create a second semantic ScanJob. Duplicate and reordered scanner results commute.
4. INFECTED is terminal, cancels pending Transcode Work and all AccessGrants, and makes source bytes
   cleanup-eligible after the configured quarantine retention. It never produces a Rendition.
5. Scanner request bodies, signatures, and raw diagnostic output are not persisted in public data or events.

## Transcode contract

1. A CLEAN Asset creates one TranscodeJob for each applicable frozen TranscodeProfile revision. The unique
   identity is `(assetId, profileId, profileRevision)`.
2. `COPY` emits bytes identical to the source. `PREFIX` emits decoded `prefixBase64` followed by the source.
   Profiles are immutable after use; later revisions affect only later jobs.
3. A Worker writes output to a unique staging file, verifies expected size and SHA-256, then atomically
   promotes one BlobObject and Rendition in the fenced final transaction.
4. A killed or expired Worker cannot promote after a replacement owns the lease. Retry and concurrent Workers
   may leave temporary staging files, but never duplicate Renditions or expose partial output.
5. Exhausted jobs become FAILED; a READY Asset requires all profiles captured for that Asset to succeed.

## Temporary access contract

1. `POST /api/v1/assets/:assetId/access-grants` selects source or one READY Rendition and accepts an expiry
   no more than 15 minutes in the future. Only READY, CLEAN content is eligible.
2. The response returns `{grant:AccessGrant,url:string,token:string}` once. The token is a deterministic HMAC
   capability derived from grant identity and expiry, so exact idempotent replay is stable without storing the
   raw token. Constant-time verification is required.
3. `GET /media/:grantId?token=...` supports full GET, HEAD, and one RFC 7233 byte range with correct `206`,
   `Content-Range`, `Content-Length`, `ETag`, and `416` behavior. It never redirects to a filesystem path.
4. Expiry and revoke take effect on the next request. A request resolves one immutable Blob before streaming;
   cleanup cannot delete that Blob while the request lease is live.
5. Logs, UI, snapshot, events, Referer-bearing links, and errors must never contain raw tokens or signing keys.

## Cleanup contract

1. CleanupPolicy revisions define retention for expired Upload parts, staging files, infected sources, failed
   Renditions, revoked/expired grants, and unreferenced committed Blobs.
2. A CleanupRun freezes `cutoffAt`, policy revision, and a durable list of candidate identities before deletion.
   Later objects are never swept by that run.
3. Immediately before each deletion, the Worker rechecks all Asset, Rendition, Grant, job, upload, and
   streaming-lease references. A live reference converts that entry to SKIPPED, never deleted.
4. Delete is idempotent and crash-safe: mark DELETING, remove the exact managed object, then commit DELETED.
   Missing already-deleted bytes are success only when identity and prior state prove the same deletion.
5. Cleanup can resume after SIGKILL without broad directory scans, path globs, duplicate events, or deletion of
   shared content still referenced by another tenant.

## Public HTTP surface

```text
POST /api/v1/tenants
POST /api/v1/transcode-profiles
POST /api/v1/cleanup-policies
POST /api/v1/uploads
GET  /api/v1/uploads/:uploadId
PUT  /api/v1/uploads/:uploadId/parts/:partNumber
POST /api/v1/uploads/:uploadId/complete
POST /api/v1/uploads/:uploadId/abort
GET  /api/v1/assets/:assetId
GET  /api/v1/assets/:assetId/renditions
POST /api/v1/assets/:assetId/access-grants
POST /api/v1/access-grants/:grantId/revoke
GET  /media/:grantId
HEAD /media/:grantId
POST /api/v1/scanner/results
POST /api/v1/scan-jobs/:scanJobId/reconcile
POST /api/v1/cleanup-runs
GET  /api/v1/cleanup-runs/:cleanupRunId
GET  /api/v1/verification-snapshot
```

Serve `GET /openapi.json` and `GET /healthz`. JSON errors use
`{"error":{"code":"STABLE_CODE","message":"...","details":{}}}`. Reject unknown fields and unsupported
media types. Collections use `{items,nextCursor}` with stable opaque cursors.

Published semantic errors are exhaustive for well-formed requests:

```text
409 IDEMPOTENCY_CONFLICT
409 UPLOAD_PART_CONFLICT
409 UPLOAD_INCOMPLETE
409 UPLOAD_TERMINAL
409 OBJECT_DIGEST_MISMATCH
409 ASSET_QUARANTINED
409 SCAN_RESULT_UNKNOWN
409 GRANT_TERMINAL
409 CLEANUP_REFERENCE_CONFLICT
400 INVALID_CONTENT_RANGE
400 INVALID_DIGEST
400 INVALID_REQUEST
```

Durable Work has exact shape
`{workId:uuid,kind:UPLOAD_EXPIRY|VIRUS_SCAN|TRANSCODE|CLEANUP_DELETE,aggregateId:uuid,state:PENDING|LEASED|SUCCEEDED|FAILED|CANCELLED,terminal:boolean,attempt:int,leaseOwner:string|null,leaseExpiresAt:timestamp|null}`.
Workers use bounded leases and fence final commits. Required event types are `upload.created`, `upload.completed`, `asset.clean`,
`asset.infected`, `transcode.succeeded`, `transcode.failed`, `grant.revoked`, `cleanup.started`, and
`cleanup.completed`. Events are contiguous per aggregate and dispatched at least once with stable identity/body.

## Seed and snapshot

The seed is exactly:

```json
{"schemaVersion":1,"seedVersion":"...","importedAt":"...","tenants":[],"uploadSessions":[],"uploadParts":[],"blobObjects":[],"mediaAssets":[],"scanJobs":[],"scanResults":[],"transcodeProfiles":[],"transcodeJobs":[],"renditions":[],"accessGrants":[],"cleanupPolicies":[],"cleanupRuns":[],"cleanupEntries":[]}
```

Seed contains metadata only and cannot create bytes or READY objects. Import is atomic. Replaying the same
version and digest is a no-op; the same version with a different digest returns `SEED_VERSION_CONFLICT`.
The verification snapshot is point-in-time and exposes resources, Work, and Domain Events without raw bytes,
paths, raw tokens, token hashes, scanner payloads, or signing keys. Every array is complete and sorted by its
declared public identity.

## Out of scope

Real antivirus engines, codec quality, FFmpeg, cloud object storage, CDN cache invalidation, DRM, image
recognition, user-supplied executable transforms, archive extraction, and cross-tenant media libraries.

## Successful response contracts

Successful response contracts are closed:

- A mutation route without a literally stated success status returns 200.
- Unless a route literally publishes another object, array, or empty body, a success described by a named resource, named resource state, or named resource fields returns that exact resource shape at the JSON top level. Any response-only fields literally named by the route are additional top-level fields.
- If a mutation publishes no success body, it returns the exact current shape of the single primary resource created or changed by that route at the JSON top level.
- When a route explicitly returns multiple named resources, the body is one object keyed by their lower-camel resource names unless the route publishes another literal shape.
- Wrappers such as `{data:...}`, `{result:...}`, or an extra single-resource envelope are invalid unless the route literally declares them. OpenAPI must publish the same success status and closed response schema as runtime.
