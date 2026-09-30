# ExportVault Harness-owned E2E / Concurrency / Recovery / Performance 方案

## 1. 边界与等级

本文件位于 candidate workspace 外，只定义 D1 黑盒评测方案。当前没有 runner、中央 score
manifest、gold 或 calibration 证据，不能声称 D3。Evaluator 只使用公开命令、HTTP、浏览器、
webhook receiver、文件下载和进程信号；不得 import 候选源码、ORM、表名或 'dist' 路径。

## 2. 固定环境

- Node.js 22、PostgreSQL 16、Chromium 和 Docker-compatible OCI；容器限制为 4 logical CPUs、
  8 GiB RAM，两个 API、两个 workers、一个 dispatcher 和 PostgreSQL 共享该限制；
- 每个 scenario 使用新数据库、新端口和独立 managed data directory；
- 两个 API、至少两个 Export Task workers 和一个 dispatcher 共享同一 PostgreSQL；
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

- Create deduplicated Export Requests that capture one consistent Dataset Revision.
- Generate a deterministic archive through leased workers and resume safely after SIGKILL.
- Verify digest and size before atomically publishing one Export Object.
- Issue revocable Download Grants with byte-range support and expire objects through durable cleanup work.
- Expose request progress, section counts, downloads, cancellation, expiry, and audit events in the UI.

对每个成功状态同时检查响应、查询、历史、异步工作和事件。

### H-04 Atomic rejection and conservation

在每个公开失败边界生成合法但不可满足的请求，断言无 partial aggregate、任务、事件或守恒量
变化。核心断言：

1. Every section in one Export observes the same captured Dataset Revision.
2. A READY Export has exactly one readable object whose digest and size match metadata.
3. A cancelled, failed, or expired Export is never newly downloadable.
4. Equivalent active requests for the same Subject, scope, and revision produce one Export and stable replay.
5. Cleanup never removes an object before its retention deadline or while an unexpired grant is active.

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

- Keep every V1 Export as a legacy one-object Export without synthesizing a Shard or Manifest and without rewriting object bytes, ETags, events, or saved download responses.
- Pending V1 Export Tasks continue with their captured Dataset Revision.
- Existing retention deadlines and active Download Grants remain exact.

### H-10 Manager core behavior

仅在 T16 已发布后按黑盒方式验证：

- Large Exports contain 2-100 independently generated Shards selected by a deterministic section and key-range plan.
- Workers may generate Shards concurrently, but the Export becomes READY only after every Shard verifies.
- Publication creates one immutable Manifest whose canonical digest covers ordered Shard digests, sizes, ranges, and media types.
- Failed retries reuse Shard IDs and cannot expose a partial Manifest; cancellation makes every unfinished Shard ineligible for publication.
- Download Grants authorize either the Manifest or one named Shard and cleanup respects active grants across all members.
- Legacy small Exports retain singular object fields; sharded Exports return null there and expose manifest plus shards[].

新增 wire schema 与接口同样属于断言面：

- ExportShard = {shardId:uuid,exportId:uuid,ordinal:int,section:string,range:{afterRecordId:uuid|null,throughRecordId:uuid|null},recordCount:int,state:PENDING|GENERATING|VERIFIED|FAILED|CANCELLED,object:{sha256:sha256,size:int,mediaType:string}|null}; throughRecordId is null exactly when recordCount is zero, and afterRecordId is the prior non-empty Shard boundary or null for a section's first Shard
- ExportManifest = {manifestId:uuid,exportId:uuid,canonicalDigest:sha256,object:{sha256:sha256,size:int,mediaType:application/json},shards:[{shardId:uuid,ordinal:int,section:string,range:{afterRecordId:uuid|null,throughRecordId:uuid},recordCount:int,sha256:sha256,size:int,mediaType:string}],createdAt:timestamp}
- ShardedDownloadGrant = {grantId:uuid,exportId:uuid,target:MANIFEST|SHARD,shardId:uuid|null,expiresAt:timestamp,revokedAt:timestamp|null,createdAt:timestamp}
- Under the Manager schema Export adds manifest:ExportManifest|null and shards:[ExportShard]. A sharded Export has object null, manifest null until every Shard verifies, and shards ordered by ordinal; a legacy one-object Export retains its exact V1 shape
- POST /api/v1/exports keeps the V1 request. A captured selection above 100000 records splits by requested scope order then recordId into at most 100 Shards of at most 100000 records without crossing section boundaries; the complete plan and stable shardIds commit with the Export.
- GET /api/v1/exports/:exportId keeps object populated for legacy one-object Exports; a sharded Export returns object:null plus manifest:ExportManifest|null and shards:[ExportShard] ordered by ordinal.
- Manifest bytes are RFC 8785 JSON of the ordered shards array; canonicalDigest and object.sha256 both equal the SHA-256 of those bytes.
- POST /api/v1/exports/:exportId/download-grants with {target:MANIFEST|SHARD,shardId?,expiresInSeconds} requires the selected Manifest or Shard verified; GET /api/v1/download-grants/:grantId/content serves only that immutable target.
- The legacy download-grant body {expiresInSeconds} remains valid only for a legacy one-object Export and returns the exact V1 DownloadGrant for that object. A sharded Export requires target MANIFEST or SHARD and otherwise returns INVALID_EXPORT_DOWNLOAD_TARGET.
- 409 EXPORT_SHARD_LIMIT_EXCEEDED: the deterministic plan would require more than 100 Shards
- 409 EXPORT_SHARD_NOT_READY: the requested Manifest or Shard is not verified
- 400 INVALID_EXPORT_DOWNLOAD_TARGET: target and shardId do not identify one Manifest or Shard
- The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
- The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
- Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
- Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

FINAL snapshot 与性能兼容断言：

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

同时验证每个失败分支整组回滚和重复请求一致。

### H-11 Manager UI, concurrency, and recovery

用 production Chromium 完成新旧流程；两个 API/worker 竞争 Manager 新基数或状态；在可观察
barrier 崩溃并恢复；检查 compatibility fields、聚合状态、成员状态、事件顺序和无重复效果。

### H-12 Sustained performance plus post-load correctness

严格对 FINAL binary 重跑 workspace README 的同三个 V1-compatible scenario，不得改变任何字段或
阈值；Manager 增量只增加 correctness、concurrency 和 recovery 断言。每个 scenario 使用独立新库，
严格执行公开 dataset、setup、selector、request、concurrency、warm-up、measurement、success、
threshold 和 timer，记录 p50/p95/p99、吞吐、成功 mutation、预期冲突、unexpected 5xx、
worker/dispatcher backlog 与排空时间。固定 dataset 为：seedVersion perf-v1 contains exactly 100 subjects, 100 datasetRevisions, and 11,000 exports: one measured Dataset Revision alone contains all 5,000,000 records and the other 99 contain zero records; 10,000 READY objects are past retention with no active Grant and 1,000 READY Exports remain live; at least 100 live Exports reference one shared verified object of at least 64 MiB for measured 1 MiB ranges.。三个场景是：

### Scenario 'range-download'

- Target: serve 100 concurrent range downloads at aggregate >= 150 MiB/s
- Mode: 'http'
- Method: 'GET'
- Path: '/api/v1/download-grants/:grantId/content'
- Setup: The perf seed provides at least 100 live READY Exports sharing a verified object of at least 64 MiB. Create one unexpired Grant per Export before warm-up.
- Selector: One closed-loop client owns each of 100 Grants and repeatedly reads its object; Grant IDs are never shared between clients.
- Request: Header Range: bytes=0-1048575 for exactly 1 MiB per 206 response; no conditional header.
- Concurrency: 100
- Warm-up seconds: 10
- Measure seconds: 60
- Success: Only complete 206 responses with Content-Length 1048576, correct Content-Range, ETag, and verified bytes count.
- Threshold: Aggregate verified response-body throughput is >= 150 MiB/s for 60 seconds; wrong bytes, 200 fallback, 5xx, and live-object deletion are zero.
- Timer: The throughput window starts with the first measured request after warm-up; each latency sample runs from request dispatch through the complete response body.

### Scenario 'five-million-record-generation'

- Target: generate 5,000,000 seeded records into verified objects within 120 s
- Mode: 'worker'
- Method: 'N/A'
- Path: 'work:EXPORT_GENERATION'
- Setup: Use one seeded Dataset Revision containing exactly 5,000,000 records across profile, activity, orders, and files, with 1,250,000 recordId-ordered records per scope. Create one JSONL Export covering all four scopes before starting two workers.
- Selector: Write scopes in request order and records by recordId; each line is the exact RFC 8785 record followed by LF.
- Request: No measured client request is issued; setup uses only the published seed and public APIs before the worker timer starts.
- Concurrency: 2
- Warm-up seconds: 0
- Measure seconds: 120
- Success: The Export is READY with all Sections VERIFIED, exact 5,000,000-record coverage, object bytes/digest/size verified, and no EXPORT_GENERATION Work nonterminal.
- Threshold: Generation and verification complete in <= 120 seconds with zero missing, duplicate, reordered, or unexpected-failure record.
- Timer: Start when both workers spawn after the Export request commits; stop only after snapshot and direct object verification prove every postcondition.

### Scenario 'expired-object-cleanup'

- Target: clean 10,000 expired objects within 60 s without deleting live data
- Mode: 'worker'
- Method: 'N/A'
- Path: 'work:EXPORT_CLEANUP'
- Setup: Use exactly 10,000 READY Exports past retention with no live Grant plus 1,000 READY live controls; start two cleanup workers.
- Selector: Process expired Exports by retentionUntil then exportId; recheck Grant liveness inside the delete-publication transaction.
- Request: No measured client request is issued; setup uses only the published seed and public APIs before the worker timer starts.
- Concurrency: 2
- Warm-up seconds: 0
- Measure seconds: 60
- Success: All 10,000 expired objects are deleted with exact DeletionProofs, every live control remains byte-readable, and no cleanup Work is nonterminal.
- Threshold: Cleanup finishes in <= 60 seconds with zero live-data deletion, missing proof, or unexpected failure.
- Timer: Start when both cleanup workers spawn and stop after snapshot plus byte reads of all control-object digests prove the postconditions.

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
