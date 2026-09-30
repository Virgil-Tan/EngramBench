【Product Manager · Maya】

V1 已完成并通过基础验收。本期正式增加“sharded export manifests”。以下业务规则、wire schema、接口和错误全部是公开增量合同。

业务规则：

1. Large Exports contain 2-100 independently generated Shards selected by a deterministic section and key-range plan.
2. Workers may generate Shards concurrently, but the Export becomes READY only after every Shard verifies.
3. Publication creates one immutable Manifest whose canonical digest covers ordered Shard digests, sizes, ranges, and media types.
4. Failed retries reuse Shard IDs and cannot expose a partial Manifest; cancellation makes every unfinished Shard ineligible for publication.
5. Download Grants authorize either the Manifest or one named Shard and cleanup respects active grants across all members.
6. Legacy small Exports retain singular object fields; sharded Exports return null there and expose manifest plus shards[].
7. Keep every V1 Export as a legacy one-object Export without synthesizing a Shard or Manifest and without rewriting object bytes, ETags, events, or saved download responses.
8. Pending V1 Export Tasks continue with their captured Dataset Revision.
9. Existing retention deadlines and active Download Grants remain exact.
10. The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
11. The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
12. Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
13. Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

新增 wire schema：

- ExportShard = {shardId:uuid,exportId:uuid,ordinal:int,section:string,range:{afterRecordId:uuid|null,throughRecordId:uuid|null},recordCount:int,state:PENDING|GENERATING|VERIFIED|FAILED|CANCELLED,object:{sha256:sha256,size:int,mediaType:string}|null}; throughRecordId is null exactly when recordCount is zero, and afterRecordId is the prior non-empty Shard boundary or null for a section's first Shard
- ExportManifest = {manifestId:uuid,exportId:uuid,canonicalDigest:sha256,object:{sha256:sha256,size:int,mediaType:application/json},shards:[{shardId:uuid,ordinal:int,section:string,range:{afterRecordId:uuid|null,throughRecordId:uuid},recordCount:int,sha256:sha256,size:int,mediaType:string}],createdAt:timestamp}
- ShardedDownloadGrant = {grantId:uuid,exportId:uuid,target:MANIFEST|SHARD,shardId:uuid|null,expiresAt:timestamp,revokedAt:timestamp|null,createdAt:timestamp}
- Under the Manager schema Export adds manifest:ExportManifest|null and shards:[ExportShard]. A sharded Export has object null, manifest null until every Shard verifies, and shards ordered by ordinal; a legacy one-object Export retains its exact V1 shape

新增或变更接口：

- POST /api/v1/exports keeps the V1 request. A captured selection above 100000 records splits by requested scope order then recordId into at most 100 Shards of at most 100000 records without crossing section boundaries; the complete plan and stable shardIds commit with the Export.
- GET /api/v1/exports/:exportId keeps object populated for legacy one-object Exports; a sharded Export returns object:null plus manifest:ExportManifest|null and shards:[ExportShard] ordered by ordinal.
- Manifest bytes are RFC 8785 JSON of the ordered shards array; canonicalDigest and object.sha256 both equal the SHA-256 of those bytes.
- POST /api/v1/exports/:exportId/download-grants with {target:MANIFEST|SHARD,shardId?,expiresInSeconds} requires the selected Manifest or Shard verified; GET /api/v1/download-grants/:grantId/content serves only that immutable target.
- The legacy download-grant body {expiresInSeconds} remains valid only for a legacy one-object Export and returns the exact V1 DownloadGrant for that object. A sharded Export requires target MANIFEST or SHARD and otherwise returns INVALID_EXPORT_DOWNLOAD_TARGET.

新增稳定错误：

- 409 EXPORT_SHARD_LIMIT_EXCEEDED: the deterministic plan would require more than 100 Shards
- 409 EXPORT_SHARD_NOT_READY: the requested Manifest or Shard is not verified
- 400 INVALID_EXPORT_DOWNLOAD_TARGET: target and shardId do not identify one Manifest or Shard

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

本轮先不要实现。请先说明它会影响哪些领域关系、模块、schema、migration、接口、状态、成功与失败数据流、兼容性、Worker、事件、前端、并发、恢复和性能测试，然后给出分阶段修改计划。