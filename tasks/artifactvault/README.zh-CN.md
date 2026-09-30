# ArtifactVault 项目设计说明

## 1. 定位

ArtifactVault 是一个从近空白 Git fixture 开始的高难度全栈 Coding Benchmark，主流程是
atomic content-addressed artifact publication。这是 learning task，用于形成可迁移的工程经验。

本题只用一个主流程承载难度，重点测量：database-filesystem atomicity、stream verification、deduplication、cleanup recovery、immutable releases。领域词汇以
[CONTEXT.md](./CONTEXT.md) 为准。

## 2. 可见性

Codex 初始只能看到 'workspace/README.md'、'workspace/AGENTS.md' 和独立 fixture Git 历史。
Manager 变更、Checklist、对话状态机、评测方案和实验 metadata 都在 workspace 外，不能在
开发回合、Session Evolution 或盲审前复制或透露。

## 3. 完整 V1

- Create resumable Upload Sessions and accept ordered byte ranges with stable retry responses.
- Verify declared size and SHA-256 in a recoverable worker before atomically committing metadata and Blob Reference.
- Deduplicate identical Blobs across Packages without exposing filesystem paths.
- Abandon expired staging safely and collect only unreferenced verified Blobs after a durable grace period.
- Expose package versions, upload progress, verification results, downloads, and audit events in a real UI.

核心状态：Upload: STAGING -> VERIFYING -> COMMITTED | REJECTED, or STAGING -> ABANDONED; committed Artifact Versions are immutable.

### 可计算不变量

1. A committed Artifact Version has exactly one readable Blob whose size and digest match metadata.
2. A rejected or abandoned Upload creates no Artifact Version or Blob Reference.
3. Package version identifiers are unique and committed content never changes.
4. A Blob with one or more committed references is never garbage-collected.
5. Retrying a byte range with identical bytes is a replay; different bytes for the same range are rejected.

## 4. Manager 固定变更

V1、真实 Browser E2E、双 API/双 Worker 并发与恢复完成后，T16 才发布
“atomic multi-platform release manifests”。它改变核心基数、状态或一致性边界：

- A Release contains 1-20 named platform Artifacts, each with its own Blob, digest, size, and mediaType.
- All member Upload Sessions may verify independently to VERIFIED without creating an Artifact Version or Blob Reference; Release publication commits every member together or none.
- Platform names are unique and a Release manifest has one canonical digest over sorted members.
- Failed or abandoned member uploads leave the Release DRAFT and cannot leak partial package versions.
- Downloads resolve by release version plus platform and preserve content-addressed deduplication.
- Legacy one-Blob versions remain readable through the exact V1 ArtifactVersion and singular content endpoints; multi-platform releases expose artifacts[] only through ReleaseDetail and require the platform content endpoint.
- A Package has at most one Release for a version. Within a Release, Artifact Version identity and uniqueness are packageName plus version plus platform; migrated V1 versions use platform default.

新增 wire schema：

- ReleaseArtifact = {platform:string,uploadId:uuid,artifactVersionId:uuid|null,state:STAGING|VERIFYING|VERIFIED|REJECTED|ABANDONED|COMMITTED,blob:{sha256:sha256,size:int,mediaType:string}|null}
- ReleaseManifest = {packageName:string,version:string,artifacts:[{platform:string,sha256:sha256,size:int,mediaType:string}],manifestSha256:sha256}
- Release = {releaseId:uuid,packageName:string,version:string,state:DRAFT|PUBLISHED,manifestSha256:sha256|null,artifacts:[ReleaseArtifact],createdAt:timestamp,publishedAt:timestamp|null,sequence:int}
- ReleaseDetail = {release:Release,manifest:ReleaseManifest|null}; manifest is null exactly while release.state is DRAFT and is populated exactly while release.state is PUBLISHED
- For Release members, UploadSession adds releaseId:uuid and platform:string and its state additionally allows VERIFIED; artifactVersionId remains null in VERIFIED. VerificationResult.outcome additionally allows VERIFIED. Published ArtifactVersion adds platform:string, with default used for migrated V1 versions; legacy V1 response bodies omit this Manager field.

新增或变更的公开接口：

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

跨层规则：

- The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
- The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
- Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
- Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

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

迁移必须同时满足：

- Migrate each V1 Artifact Version to a one-member default-platform Release without moving or rewriting Blob bytes.
- Existing ETags, download bodies, events, and idempotency replay responses remain exact.
- Pending Verification Tasks and staging expiry deadlines survive migration.

T16 只要求影响分析和分阶段修改计划，不允许立即实现。T17-T20 才依次处理迁移、后端、
API、UI、并发和恢复回归。

## 5. 评分结构

| Dimension | Weight |
| --- | ---: |
| Clean build, migration, seed, and operation | 5 |
| Contract, validation, and seed semantics | 5 |
| Complete V1 main flow | 10 |
| Atomicity and durable idempotency | 10 |
| Worker, outbox, and crash recovery | 15 |
| Multi-process consistency | 10 |
| Manager-compatible migration | 15 |
| Manager runtime, UI, and concurrency | 10 |
| Project-owned real tests | 8 |
| Sustained performance plus post-load correctness | 7 |
| Persona-fit explanation | 2 |
| Evidence and handoff | 3 |
| **Total** | **100** |

普通 CRUD 和页面数量不构成主要分值。并发、恢复、幂等、兼容迁移和负载后不变量失败会
触发对应高权重项失分；正式 hard cap 方案见 evaluator 文档。

## 6. 当前完成度

当前为 **D1 设计完成**：公开合同、固定 Manager 正文、22 阶段 Dialogue、100 分 Checklist、
环境设计、独立 fixture commit 和 H-01 至 H-13 黑盒方案已完成。当前**没有 hidden runner**、
'score-manifest.v1.json'、gold、mutant、逐题 project smoke 或 baseline，因此不能声称 D2/D3/D4/D5，
也不能把候选项目自己的 'test:all' 当作正式得分。

## 7. D2 以后仍需完成

- 验证共享 environment profile，并完成当前 task 的真实 project smoke；
- 实现 Harness-owned H-01 至 H-13 runner、中央 score manifest 和 Checklist 'testGates'；
- 冻结 V1/FINAL 双快照并接线 paired scripted curriculum；
- 用 gold、定向 mutants、重复 Control baseline 和 flake run 校准阈值。
