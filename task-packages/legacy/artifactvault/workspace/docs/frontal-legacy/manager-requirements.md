【Product Manager · Maya】

V1 已完成并通过基础验收。本期正式增加“atomic multi-platform release manifests”。以下业务规则、wire schema、接口和错误全部是公开增量合同。

业务规则：

1. A Release contains 1-20 named platform Artifacts, each with its own Blob, digest, size, and mediaType.
2. All member Upload Sessions may verify independently to VERIFIED without creating an Artifact Version or Blob Reference; Release publication commits every member together or none.
3. Platform names are unique and a Release manifest has one canonical digest over sorted members.
4. Failed or abandoned member uploads leave the Release DRAFT and cannot leak partial package versions.
5. Downloads resolve by release version plus platform and preserve content-addressed deduplication.
6. Legacy one-Blob versions remain readable through the exact V1 ArtifactVersion and singular content endpoints; multi-platform releases expose artifacts[] only through ReleaseDetail and require the platform content endpoint.
7. A Package has at most one Release for a version. Within a Release, Artifact Version identity and uniqueness are packageName plus version plus platform; migrated V1 versions use platform default.
8. Migrate each V1 Artifact Version to a one-member default-platform Release without moving or rewriting Blob bytes.
9. Existing ETags, download bodies, events, and idempotency replay responses remain exact.
10. Pending Verification Tasks and staging expiry deadlines survive migration.
11. The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
12. The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
13. Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
14. Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

新增 wire schema：

- ReleaseArtifact = {platform:string,uploadId:uuid,artifactVersionId:uuid|null,state:STAGING|VERIFYING|VERIFIED|REJECTED|ABANDONED|COMMITTED,blob:{sha256:sha256,size:int,mediaType:string}|null}
- ReleaseManifest = {packageName:string,version:string,artifacts:[{platform:string,sha256:sha256,size:int,mediaType:string}],manifestSha256:sha256}
- Release = {releaseId:uuid,packageName:string,version:string,state:DRAFT|PUBLISHED,manifestSha256:sha256|null,artifacts:[ReleaseArtifact],createdAt:timestamp,publishedAt:timestamp|null,sequence:int}
- ReleaseDetail = {release:Release,manifest:ReleaseManifest|null}; manifest is null exactly while release.state is DRAFT and is populated exactly while release.state is PUBLISHED
- For Release members, UploadSession adds releaseId:uuid and platform:string and its state additionally allows VERIFIED; artifactVersionId remains null in VERIFIED. VerificationResult.outcome additionally allows VERIFIED. Published ArtifactVersion adds platform:string, with default used for migrated V1 versions; legacy V1 response bodies omit this Manager field.

新增或变更接口：

- POST /api/v1/releases with {packageName,version,artifacts:[{platform,expectedSize,expectedSha256,mediaType}]} atomically reserves the unique packageName plus version, creates one DRAFT Release and one STAGING Upload Session per member; artifacts has 1..20 members and platform matches [a-z0-9][a-z0-9._-]{0,63} and is unique.
- POST /api/v1/releases/:releaseId/artifacts/:platform/retry with {} creates a replacement Upload Session only when the current member is REJECTED or ABANDONED; other verified members and Blob identities remain unchanged.
- The existing POST /api/v1/upload-sessions/:uploadId/complete still returns 202 VERIFYING. For a Release member, successful Verification Task completion stores the verified Blob identity and changes UploadSession and ReleaseArtifact to VERIFIED without creating an Artifact Version or Blob Reference; standalone V1 sessions retain their immediate COMMITTED behavior.
- POST /api/v1/releases/:releaseId/publish with {} requires every member VERIFIED, computes manifestSha256 from UTF-8 JSON of [{platform,sha256,size,mediaType}] sorted by platform ASCII ascending with keys in that order and no extra whitespace, then in one transaction creates every packageName/version/platform Artifact Version and Blob Reference, changes every member UploadSession and ReleaseArtifact to COMMITTED, and changes the Release to PUBLISHED.
- GET /api/v1/packages/:packageName/releases/:version returns the exact ReleaseDetail; GET /api/v1/packages/:packageName/releases/:version/artifacts/:platform/content serves the selected committed Blob with existing digest ETag and range behavior.
- The legacy singular content endpoint remains exact for a migrated one-member default-platform Release; using it for a multi-platform Release returns 409 PLATFORM_REQUIRED, and clients read artifacts[] from ReleaseDetail before using the platform endpoint.

新增稳定错误：

- 400 INVALID_RELEASE_ARTIFACTS: member count, platform name or uniqueness, size, digest, or mediaType is invalid
- 409 RELEASE_NOT_READY: publication is requested while a member is not VERIFIED or lacks its verified Blob
- 409 RELEASE_VERSION_EXISTS: Package and version already identify a V1 Artifact Version or any DRAFT or PUBLISHED Release
- 409 PLATFORM_REQUIRED: the singular content endpoint is used for a multi-platform Release
- 404 RELEASE_PLATFORM_NOT_FOUND: the requested platform is not a member of the published Release

FINAL snapshot 与性能兼容合同：

The FINAL verification snapshot 'resources' object has exactly the union of these V1 and Manager resource specifications, with no other keys:

- 'packages' uses exact shape 'Package = {packageName:string,displayName:string}' and sorts ascending by scalar field-path tuple 'packageName', then by RFC 8785 canonical JSON as the tie-breaker.
- 'uploadSessions' uses exact shape 'UploadSession' and sorts ascending by scalar field-path tuple 'uploadId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'artifactVersions' uses exact shape 'ArtifactVersion' and sorts ascending by scalar field-path tuple 'artifactVersionId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'verificationResults' uses exact shape 'VerificationResult' and sorts ascending by scalar field-path tuple 'uploadId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'blobs' uses exact shape 'Blob = {sha256:sha256,size:int,mediaType:string,state:STAGED|VERIFIED|COMMITTED|ORPHANED,referenceCount:int}' and sorts ascending by scalar field-path tuple 'sha256', then by RFC 8785 canonical JSON as the tie-breaker.
- 'blobReferences' uses exact shape 'BlobReference = {artifactVersionId:uuid,blobSha256:sha256,createdAt:timestamp}' and sorts ascending by scalar field-path tuple 'artifactVersionId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'releases' uses exact shape 'Release' and sorts ascending by scalar field-path tuple 'releaseId', then by RFC 8785 canonical JSON as the tie-breaker.

The Manager-added resource specifications are exactly:

- 'releases' uses exact shape 'Release' and sorts ascending by scalar field-path tuple 'releaseId', then by RFC 8785 canonical JSON as the tie-breaker.

The FINAL Work kind enum is exactly the union 'ARTIFACT_VERIFICATION', 'UPLOAD_EXPIRY', 'BLOB_GC'. The Manager-added
Work kinds are exactly (none). All V1 snapshot point-in-time,
recursive '*Token' omission, sorting, Work state/lease/retention/drain, and Domain Event rules remain
mandatory. The FINAL binary reruns exactly these three V1-compatible scenarios:

- 'concurrent-upload-stream': stream 20 concurrent 64 MiB uploads with aggregate >= 120 MiB/s; threshold: From first measured PUT dispatch through the last complete PUT response, aggregate accepted payload throughput is >= 120 MiB/s; replay, gap, and 5xx errors are zero.
- 'artifact-metadata-read': serve 200 metadata reads/s with p95 <= 120 ms; threshold: At least 200 successful metadata reads/s for 60 seconds and p95 <= 120 ms; unexpected 5xx = 0.
- 'verification-recovery': verify a 2 GiB backlog within 90 s after worker recovery with worker peak RSS <= 768 MiB; threshold: The 2 GiB backlog drains in <= 90 seconds after replacement spawn with both RSS bounds and zero stale commit or unexpected failure.

Their published setup, selector, request, concurrency, warm-up, measurement, timer, success condition,
and threshold remain unchanged. This Manager change adds correctness, concurrency, and recovery
assertions only; it does not replace or relax a performance scenario.

本轮先不要实现。请先说明它会影响哪些领域关系、模块、schema、migration、接口、状态、成功与失败数据流、兼容性、Worker、事件、前端、并发、恢复和性能测试，然后给出分阶段修改计划。