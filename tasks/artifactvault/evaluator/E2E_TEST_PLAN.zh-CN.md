# ArtifactVault Harness-owned E2E / Concurrency / Recovery / Performance 方案

## 1. 边界与等级

本文件位于 candidate workspace 外，只定义 D1 黑盒评测方案。当前没有 runner、中央 score
manifest、gold 或 calibration 证据，不能声称 D3。Evaluator 只使用公开命令、HTTP、浏览器、
webhook receiver、文件下载和进程信号；不得 import 候选源码、ORM、表名或 'dist' 路径。

## 2. 固定环境

- Node.js 22、PostgreSQL 16、Chromium 和 Docker-compatible OCI；容器限制为 4 logical CPUs、
  8 GiB RAM，两个 API、两个 workers、一个 dispatcher 和 PostgreSQL 共享该限制；
- 每个 scenario 使用新数据库、新端口和独立 managed data directory；
- 两个 API、至少两个 Verification Task workers 和一个 dispatcher 共享同一 PostgreSQL；
- command timeout 60 分钟，project timeout 24 小时；
- 合法随机输入和交错保存私有 seed，失败报告只公开脱敏后的断言与复现 ID。

## 3. Snapshot 与 barrier

T15 后冻结 'V1_SNAPSHOT'，T22 后冻结 'FINAL_SNAPSHOT'。H-09 先用 V1 binary/contract 写入
历史数据、pending work、event 和 idempotency replay，再切换到 FINAL migration。

- unknown HTTP outcome：response shield 收到完整 upstream response 后断开 candidate client；
- unknown webhook ACK：receiver 收到并持久化完整 request 后暂停 ACK，再 SIGKILL dispatcher；
- worker recovery：按公开 'TEST_BARRIER_URL' 协议在 'worker.claimed'、
  'worker.effect-complete' 或 'worker.before-commit' 收到完整 barrier body 后暂停，再 SIGKILL
  worker 并等待 'WORK_LEASE_SECONDS'；
- 不允许随机 sleep 推断 commit、claim、delivery 或 ACK 时点。

## 4. Hidden scenario design

### H-01 Clean install, migration, seed, build, and boot

从 fixture commit 开始执行公开命令；migration 重放；合法 seed、同 digest 重放、冲突版本和随机
非法成员；生产 API/UI/worker/dispatcher 全部启动。断言 OpenAPI 与 runtime 基础状态一致。

### H-02 Contract, validation, query, and browser baseline

随机 UUID、边界整数、未知字段、媒体类型、游标和时间；验证稳定错误、分页、排序、真实 React
页面、键盘路径、移动布局和 refresh 后状态。

### H-03 V1 successful main flow

通过公开 API 和浏览器完成：

- Create resumable Upload Sessions and accept ordered byte ranges with stable retry responses.
- Verify declared size and SHA-256 in a recoverable worker before atomically committing metadata and Blob Reference.
- Deduplicate identical Blobs across Packages without exposing filesystem paths.
- Abandon expired staging safely and collect only unreferenced verified Blobs after a durable grace period.
- Expose package versions, upload progress, verification results, downloads, and audit events in a real UI.

对每个成功状态同时检查响应、查询、历史、异步工作和事件。

### H-04 Atomic rejection and conservation

在每个公开失败边界生成合法但不可满足的请求，断言无 partial aggregate、任务、事件或守恒量
变化。核心断言：

1. A committed Artifact Version has exactly one readable Blob whose size and digest match metadata.
2. A rejected or abandoned Upload creates no Artifact Version or Blob Reference.
3. Package version identifiers are unique and committed content never changes.
4. A Blob with one or more committed references is never garbage-collected.
5. Retrying a byte range with identical bytes is a replay; different bytes for the same range are rejected.

### H-05 Durable idempotency and unknown response

对每个 mutation 测试相同 key replay、语义冲突、20 路并发、response shield、API SIGKILL 和
重启。状态码与语义 JSON 保持原结果，且只出现一次业务效果和事件。

### H-06 Multi-process contention

两个 API 和两个 workers 对同一热点 authority 进行有 seed 的竞争；随机化合法请求数量和顺序，
最后通过公开查询重算全部不变量，不依赖数据库内部结构。

### H-07 Worker lease and terminal recovery

分别在 claim 后、外部工作后、commit 前 barrier SIGKILL worker；等待 'WORK_LEASE_SECONDS' 后
启动另一 worker，断言任务可恢复、stale token 失败、终态和副作用最多一次。

### H-08 Transactional outbox and unknown ACK

对成功和回滚业务检查 event existence；receiver 返回 500、断开连接、在完整 body 后暂停 ACK，
dispatcher 重启。重试保持 eventId/body，成功顺序递增，不能丢 event 或制造新身份。

### H-09 Populated V1 to FINAL migration

V1_SNAPSHOT 生成普通、边界、terminal、pending、leased、undelivered 和已保存 replay 数据。
FINAL migration 后逐项验证：

- Migrate each V1 Artifact Version to a one-member default-platform Release without moving or rewriting Blob bytes.
- Existing ETags, download bodies, events, and idempotency replay responses remain exact.
- Pending Verification Tasks and staging expiry deadlines survive migration.

### H-10 Manager core behavior

仅在 T16 已发布后按黑盒方式验证：

- A Release contains 1-20 named platform Artifacts, each with its own Blob, digest, size, and mediaType.
- All member Upload Sessions may verify independently to VERIFIED without creating an Artifact Version or Blob Reference; Release publication commits every member together or none.
- Platform names are unique and a Release manifest has one canonical digest over sorted members.
- Failed or abandoned member uploads leave the Release DRAFT and cannot leak partial package versions.
- Downloads resolve by release version plus platform and preserve content-addressed deduplication.
- Legacy one-Blob versions remain readable through the exact V1 ArtifactVersion and singular content endpoints; multi-platform releases expose artifacts[] only through ReleaseDetail and require the platform content endpoint.
- A Package has at most one Release for a version. Within a Release, Artifact Version identity and uniqueness are packageName plus version plus platform; migrated V1 versions use platform default.

新增 wire schema 与接口同样属于断言面：

- ReleaseArtifact = {platform:string,uploadId:uuid,artifactVersionId:uuid|null,state:STAGING|VERIFYING|VERIFIED|REJECTED|ABANDONED|COMMITTED,blob:{sha256:sha256,size:int,mediaType:string}|null}
- ReleaseManifest = {packageName:string,version:string,artifacts:[{platform:string,sha256:sha256,size:int,mediaType:string}],manifestSha256:sha256}
- Release = {releaseId:uuid,packageName:string,version:string,state:DRAFT|PUBLISHED,manifestSha256:sha256|null,artifacts:[ReleaseArtifact],createdAt:timestamp,publishedAt:timestamp|null,sequence:int}
- ReleaseDetail = {release:Release,manifest:ReleaseManifest|null}; manifest is null exactly while release.state is DRAFT and is populated exactly while release.state is PUBLISHED
- For Release members, UploadSession adds releaseId:uuid and platform:string and its state additionally allows VERIFIED; artifactVersionId remains null in VERIFIED. VerificationResult.outcome additionally allows VERIFIED. Published ArtifactVersion adds platform:string, with default used for migrated V1 versions; legacy V1 response bodies omit this Manager field.
- POST /api/v1/releases with {packageName,version,artifacts:[{platform,expectedSize,expectedSha256,mediaType}]} atomically reserves the unique packageName plus version, creates one DRAFT Release and one STAGING Upload Session per member; artifacts has 1..20 members and platform matches [a-z0-9][a-z0-9._-]{0,63} and is unique.
- POST /api/v1/releases/:releaseId/artifacts/:platform/retry with {} creates a replacement Upload Session only when the current member is REJECTED or ABANDONED; other verified members and Blob identities remain unchanged.
- The existing POST /api/v1/upload-sessions/:uploadId/complete still returns 202 VERIFYING. For a Release member, successful Verification Task completion stores the verified Blob identity and changes UploadSession and ReleaseArtifact to VERIFIED without creating an Artifact Version or Blob Reference; standalone V1 sessions retain their immediate COMMITTED behavior.
- POST /api/v1/releases/:releaseId/publish with {} requires every member VERIFIED, computes manifestSha256 from UTF-8 JSON of [{platform,sha256,size,mediaType}] sorted by platform ASCII ascending with keys in that order and no extra whitespace, then in one transaction creates every packageName/version/platform Artifact Version and Blob Reference, changes every member UploadSession and ReleaseArtifact to COMMITTED, and changes the Release to PUBLISHED.
- GET /api/v1/packages/:packageName/releases/:version returns the exact ReleaseDetail; GET /api/v1/packages/:packageName/releases/:version/artifacts/:platform/content serves the selected committed Blob with existing digest ETag and range behavior.
- The legacy singular content endpoint remains exact for a migrated one-member default-platform Release; using it for a multi-platform Release returns 409 PLATFORM_REQUIRED, and clients read artifacts[] from ReleaseDetail before using the platform endpoint.
- 400 INVALID_RELEASE_ARTIFACTS: member count, platform name or uniqueness, size, digest, or mediaType is invalid
- 409 RELEASE_NOT_READY: publication is requested while a member is not VERIFIED or lacks its verified Blob
- 409 RELEASE_VERSION_EXISTS: Package and version already identify a V1 Artifact Version or any DRAFT or PUBLISHED Release
- 409 PLATFORM_REQUIRED: the singular content endpoint is used for a multi-platform Release
- 404 RELEASE_PLATFORM_NOT_FOUND: the requested platform is not a member of the published Release
- The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
- The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
- Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
- Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

FINAL snapshot 与性能兼容断言：

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

同时验证每个失败分支整组回滚和重复请求一致。

### H-11 Manager UI, concurrency, and recovery

用 production Chromium 完成新旧流程；两个 API/worker 竞争 Manager 新基数或状态；在可观察
barrier 崩溃并恢复；检查 compatibility fields、聚合状态、成员状态、事件顺序和无重复效果。

### H-12 Sustained performance plus post-load correctness

严格对 FINAL binary 重跑 workspace README 的同三个 V1-compatible scenario，不得改变任何字段或
阈值；Manager 增量只增加 correctness、concurrency 和 recovery 断言。每个 scenario 使用独立新库，
严格执行公开 dataset、setup、selector、request、concurrency、warm-up、measurement、success、
threshold 和 timer，记录 p50/p95/p99、吞吐、成功 mutation、预期冲突、unexpected 5xx、
worker/dispatcher backlog 与排空时间。固定 dataset 为：seedVersion perf-v1 contains exactly 100,000 packages and 100,000 artifactVersions whose valid one-byte fixture files share one Blob; upload-run setup creates 20 STAGING 64 MiB sessions, while recovery-run setup creates 32 VERIFYING 64 MiB sessions totaling exactly 2 GiB.。三个场景是：

### Scenario 'concurrent-upload-stream'

- Target: stream 20 concurrent 64 MiB uploads with aggregate >= 120 MiB/s
- Mode: 'http'
- Method: 'PUT'
- Path: '/api/v1/upload-sessions/:uploadId/chunks'
- Setup: Use exactly 20 STAGING measured UploadSessions of 64 MiB each. Their deterministic bytes and expected digests are prepared before timing; this finite scenario has no warm-up.
- Selector: One client owns each UploadSession and sends eight sequential 8 MiB ranges; sessions run concurrently and never share a chunk request.
- Request: Raw application/octet-stream with Content-Range bytes start-end/67108864; each chunk is exactly 8 MiB and carries a fresh Idempotency-Key.
- Concurrency: 20
- Warm-up seconds: 0
- Measure seconds: 60
- Success: Every PUT returns the exact ChunkReceipt and advances nextOffset once; after timing, complete all sessions and verify their digests as a correctness postcondition.
- Threshold: From first measured PUT dispatch through the last complete PUT response, aggregate accepted payload throughput is >= 120 MiB/s; replay, gap, and 5xx errors are zero.
- Timer: Start immediately before dispatching the first 20 chunks and stop after all 160 measured PUT response bodies are complete.

### Scenario 'artifact-metadata-read'

- Target: serve 200 metadata reads/s with p95 <= 120 ms
- Mode: 'http'
- Method: 'GET'
- Path: '/api/v1/packages/:packageName/versions/:version'
- Setup: Use all 100,000 seeded committed ArtifactVersions; reads never open content bytes.
- Selector: Round-robin packageName then version by UTF-8 byte order.
- Request: No body, Range, or conditional header.
- Concurrency: 64
- Warm-up seconds: 10
- Measure seconds: 60
- Success: Only 200 exact ArtifactVersion metadata responses count; blob digest, size, mediaType, and sequence must agree atomically.
- Threshold: At least 200 successful metadata reads/s for 60 seconds and p95 <= 120 ms; unexpected 5xx = 0.
- Timer: The throughput window starts with the first measured request after warm-up; each latency sample runs from request dispatch through the complete response body.

### Scenario 'verification-recovery'

- Target: verify a 2 GiB backlog within 90 s after worker recovery with worker peak RSS <= 768 MiB
- Mode: 'worker'
- Method: 'N/A'
- Path: 'work:ARTIFACT_VERIFICATION'
- Setup: Exactly 32 VERIFYING 64 MiB sessions total 2 GiB. Hold two workers at worker.claimed, SIGKILL, wait for lease expiry, then start two replacements; record each replacement baseline RSS before its first claim and sample RSS every 100 ms.
- Selector: Process by UploadSession createdAt then uploadId and stream bytes rather than buffering an object.
- Request: No measured client request is issued; setup uses only the published seed and public APIs before the worker timer starts.
- Concurrency: 2
- Warm-up seconds: 0
- Measure seconds: 90
- Success: All 32 sessions reach COMMITTED exactly once, no verification Work remains nonterminal, every Blob digest/reference verifies, each replacement peak RSS is <= 768 MiB, and peak minus its recorded baseline is <= 64 MiB.
- Threshold: The 2 GiB backlog drains in <= 90 seconds after replacement spawn with both RSS bounds and zero stale commit or unexpected failure.
- Timer: Start when both replacements spawn and stop only after snapshot, managed-object verification, and the final RSS sample prove all postconditions.

负载后重新执行 H-04 的全部不变量；任何不变量失败都使性能 assertion 失败。不得从旧的目标
摘要推断 workload，也不得把 Manager 增量改成第四个性能阈值。

### H-13 Project-owned gates and handoff truthfulness

从干净数据库逐个运行公开 test 命令，检查真实进程、真实 PostgreSQL、真实 Chromium、barrier
故障和 meaningful assertions；交叉核对最终回复所称命令、结果、性能、风险和未运行项。

## 5. 100 分映射

H-01 -> 5；H-02 -> 5；H-03 -> 10；H-04/H-05 -> 10；H-07/H-08 -> 15；
H-06 -> 10；H-09 -> 15；H-10/H-11 -> 10；H-13 tests -> 8；H-12 -> 7；
blind Judge explanation -> 2；evidence/handoff -> 3。最终 D3 必须把每个 assertion ID、唯一权重、
Checklist testGate 和 hard cap 写入一个 'score-manifest.v1.json'，不能重复计分。

## 6. Hard caps 与 invalid sample

- clean build、migration 或 production boot 失败：总分上限 25；
- 任一守恒、非负、唯一终态、at-most-once business effect 或 atomic rejection 不变量失败：上限 35；
- durable idempotency 在并发、未知响应或重启后产生第二效果：上限 30；
- 已提交业务缺 event、回滚业务有 event、event 重试改变身份/正文：上限 40；
- SIGKILL 后合法 pending work 永久丢失或 stale worker 可提交：上限 40；
- migration 丢历史数据、改变已保存 replay 或破坏旧客户端：上限 35；
- 性能后核心不变量失败：性能项 0 且应用相应 correctness cap。

读取 hidden assets、硬编码私有 fixture、访问 workspace 外路径或逃逸隔离标记为 invalid sample，
不是普通低分。

## 7. Calibration gate

实现 runner 后，先准备 gold 以及至少五个 mutants：process-local idempotency、非原子 event、
无 fencing lease、Manager partial migration、只测吞吐不验 invariant。相同 candidate/seed 至少
重复三次；所有 mutant 必须触发预期 assertion/cap，再冻结 image、fixture commit、README、
Manager、dialogue、score manifest、seed generator 和阈值。
