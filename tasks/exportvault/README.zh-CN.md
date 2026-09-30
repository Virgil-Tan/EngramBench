# ExportVault 项目设计说明

## 1. 定位

ExportVault 是一个从近空白 Git fixture 开始的高难度全栈 Coding Benchmark，主流程是
recoverable privacy export generation and retention。这是 Learning task；它的 Trajectory 与隐藏测试结果用于 Skill Evolution，不属于 13 个 Transfer/Test task。

本题只用一个主流程承载难度，重点测量：snapshot consistency、durable object generation、digest verification、retention races、sharded compatibility。领域词汇以
[CONTEXT.md](./CONTEXT.md) 为准。

## 2. 可见性

Codex 初始只能看到 'workspace/README.md'、'workspace/AGENTS.md' 和独立 fixture Git 历史。
Manager 变更、Checklist、对话状态机、评测方案和实验 metadata 都在 workspace 外，不能在
开发回合、Session Evolution 或盲审前复制或透露。

## 3. 完整 V1

- Create deduplicated Export Requests that capture one consistent Dataset Revision.
- Generate a deterministic archive through leased workers and resume safely after SIGKILL.
- Verify digest and size before atomically publishing one Export Object.
- Issue revocable Download Grants with byte-range support and expire objects through durable cleanup work.
- Expose request progress, section counts, downloads, cancellation, expiry, and audit events in the UI.

核心状态：Export: REQUESTED -> GENERATING -> READY -> EXPIRED, or REQUESTED/GENERATING -> CANCELLED | FAILED.

### 可计算不变量

1. Every section in one Export observes the same captured Dataset Revision.
2. A READY Export has exactly one readable object whose digest and size match metadata.
3. A cancelled, failed, or expired Export is never newly downloadable.
4. Equivalent active requests for the same Subject, scope, and revision produce one Export and stable replay.
5. Cleanup never removes an object before its retention deadline or while an unexpired grant is active.

## 4. Manager 固定变更

V1、真实 Browser E2E、双 API/双 Worker 并发与恢复完成后，T16 才发布
“sharded export manifests”。它改变核心基数、状态或一致性边界：

- Large Exports contain 2-100 independently generated Shards selected by a deterministic section and key-range plan.
- Workers may generate Shards concurrently, but the Export becomes READY only after every Shard verifies.
- Publication creates one immutable Manifest whose canonical digest covers ordered Shard digests, sizes, ranges, and media types.
- Failed retries reuse Shard IDs and cannot expose a partial Manifest; cancellation makes every unfinished Shard ineligible for publication.
- Download Grants authorize either the Manifest or one named Shard and cleanup respects active grants across all members.
- Legacy small Exports retain singular object fields; sharded Exports return null there and expose manifest plus shards[].

新增 wire schema：

- ExportShard = {shardId:uuid,exportId:uuid,ordinal:int,section:string,range:{afterRecordId:uuid|null,throughRecordId:uuid|null},recordCount:int,state:PENDING|GENERATING|VERIFIED|FAILED|CANCELLED,object:{sha256:sha256,size:int,mediaType:string}|null}; throughRecordId is null exactly when recordCount is zero, and afterRecordId is the prior non-empty Shard boundary or null for a section's first Shard
- ExportManifest = {manifestId:uuid,exportId:uuid,canonicalDigest:sha256,object:{sha256:sha256,size:int,mediaType:application/json},shards:[{shardId:uuid,ordinal:int,section:string,range:{afterRecordId:uuid|null,throughRecordId:uuid},recordCount:int,sha256:sha256,size:int,mediaType:string}],createdAt:timestamp}
- ShardedDownloadGrant = {grantId:uuid,exportId:uuid,target:MANIFEST|SHARD,shardId:uuid|null,expiresAt:timestamp,revokedAt:timestamp|null,createdAt:timestamp}
- Under the Manager schema Export adds manifest:ExportManifest|null and shards:[ExportShard]. A sharded Export has object null, manifest null until every Shard verifies, and shards ordered by ordinal; a legacy one-object Export retains its exact V1 shape

新增或变更的公开接口：

- POST /api/v1/exports keeps the V1 request. A captured selection above 100000 records splits by requested scope order then recordId into at most 100 Shards of at most 100000 records without crossing section boundaries; the complete plan and stable shardIds commit with the Export.
- GET /api/v1/exports/:exportId keeps object populated for legacy one-object Exports; a sharded Export returns object:null plus manifest:ExportManifest|null and shards:[ExportShard] ordered by ordinal.
- Manifest bytes are RFC 8785 JSON of the ordered shards array; canonicalDigest and object.sha256 both equal the SHA-256 of those bytes.
- POST /api/v1/exports/:exportId/download-grants with {target:MANIFEST|SHARD,shardId?,expiresInSeconds} requires the selected Manifest or Shard verified; GET /api/v1/download-grants/:grantId/content serves only that immutable target.
- The legacy download-grant body {expiresInSeconds} remains valid only for a legacy one-object Export and returns the exact V1 DownloadGrant for that object. A sharded Export requires target MANIFEST or SHARD and otherwise returns INVALID_EXPORT_DOWNLOAD_TARGET.

新增稳定错误：

- 409 EXPORT_SHARD_LIMIT_EXCEEDED: the deterministic plan would require more than 100 Shards
- 409 EXPORT_SHARD_NOT_READY: the requested Manifest or Shard is not verified
- 400 INVALID_EXPORT_DOWNLOAD_TARGET: target and shardId do not identify one Manifest or Shard

跨层规则：

- The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
- The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
- Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
- Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

FINAL snapshot 与性能兼容合同：

The FINAL verification snapshot 'resources' object has exactly the union of these V1 and Manager resource specifications, with no other keys:

- 'subjects' uses exact shape 'ExportSubject = {subjectId:uuid,name:string,currentDatasetRevision:int}' and sorts ascending by scalar field-path tuple 'subjectId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'datasetRevisionSummaries' uses exact shape 'DatasetRevisionSummary = {subjectId:uuid,revision:int,committedAt:timestamp,recordCount:int,recordsDigest:sha256}; recordsDigest is SHA-256 of RFC 8785 records sorted by recordId' and sorts ascending by scalar field-path tuple 'subjectId', 'revision', then by RFC 8785 canonical JSON as the tie-breaker.
- 'exports' uses exact shape 'Export' and sorts ascending by scalar field-path tuple 'exportId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'exportSections' uses exact shape 'ExportSection' and sorts ascending by scalar field-path tuple 'exportId', 'name', then by RFC 8785 canonical JSON as the tie-breaker.
- 'downloadGrants' uses exact shape 'DownloadGrant' and sorts ascending by scalar field-path tuple 'grantId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'deletionProofs' uses exact shape 'DeletionProof' and sorts ascending by scalar field-path tuple 'exportId', 'objectSha256', then by RFC 8785 canonical JSON as the tie-breaker.
- 'exportShards' uses exact shape 'ExportShard' and sorts ascending by scalar field-path tuple 'exportId', 'ordinal', 'shardId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'exportManifests' uses exact shape 'ExportManifest' and sorts ascending by scalar field-path tuple 'exportId', 'manifestId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'shardedDownloadGrants' uses exact shape 'ShardedDownloadGrant' and sorts ascending by scalar field-path tuple 'grantId', then by RFC 8785 canonical JSON as the tie-breaker.

The Manager-added resource specifications are exactly:

- 'exportShards' uses exact shape 'ExportShard' and sorts ascending by scalar field-path tuple 'exportId', 'ordinal', 'shardId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'exportManifests' uses exact shape 'ExportManifest' and sorts ascending by scalar field-path tuple 'exportId', 'manifestId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'shardedDownloadGrants' uses exact shape 'ShardedDownloadGrant' and sorts ascending by scalar field-path tuple 'grantId', then by RFC 8785 canonical JSON as the tie-breaker.

The FINAL Work kind enum is exactly the union 'EXPORT_GENERATION', 'EXPORT_CLEANUP'. The Manager-added
Work kinds are exactly (none). All V1 snapshot point-in-time,
recursive '*Token' omission, sorting, Work state/lease/retention/drain, and Domain Event rules remain
mandatory. The FINAL binary reruns exactly these three V1-compatible scenarios:

- 'range-download': serve 100 concurrent range downloads at aggregate >= 150 MiB/s; threshold: Aggregate verified response-body throughput is >= 150 MiB/s for 60 seconds; wrong bytes, 200 fallback, 5xx, and live-object deletion are zero.
- 'five-million-record-generation': generate 5,000,000 seeded records into verified objects within 120 s; threshold: Generation and verification complete in <= 120 seconds with zero missing, duplicate, reordered, or unexpected-failure record.
- 'expired-object-cleanup': clean 10,000 expired objects within 60 s without deleting live data; threshold: Cleanup finishes in <= 60 seconds with zero live-data deletion, missing proof, or unexpected failure.

Their published setup, selector, request, concurrency, warm-up, measurement, timer, success condition,
and threshold remain unchanged. This Manager change adds correctness, concurrency, and recovery
assertions only; it does not replace or relax a performance scenario.

迁移必须同时满足：

- Keep every V1 Export as a legacy one-object Export without synthesizing a Shard or Manifest and without rewriting object bytes, ETags, events, or saved download responses.
- Pending V1 Export Tasks continue with their captured Dataset Revision.
- Existing retention deadlines and active Download Grants remain exact.

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
