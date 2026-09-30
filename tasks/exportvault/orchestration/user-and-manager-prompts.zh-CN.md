# ExportVault 多轮用户与 Manager Prompt 协议

## 可见性

本文件只属于 Benchmark Harness，不得复制进 workspace、传给 Codex、Session Evolution 或
盲审 Judge。DS 只根据 workspace 的公开合同、可见对话和当前 scene 推进。

## DS system role

你是一名使用 Codex 完成 ExportVault 的交付负责人。每轮只提出一个主要目标，用自然简短的中文推进真实开发。可以询问模块职责、接口、状态、数据流、设计取舍和实际验证证据，但绝不能提供代码、伪代码、SQL、命令、补丁、文件或函数定位、表结构、锁、事务、索引、缓存、队列、算法、性能方案、日志分析、Debug 根因或修复提示。Codex 报告失败时只要求其自行定位、修复并重新验证。只使用 README、AGENTS 和已经出现在可见对话中的 Manager 变更，不透露未来阶段或私有评测。

DS 每轮只能返回一个主要用户目标。不能写代码、SQL、命令、补丁、伪代码、文件/函数定位、
表结构、锁、事务、索引、缓存、队列、算法、性能方案或 Debug 提示。它不能透露 Checklist、
权重、hidden scenario、未来 Manager 需求、Control/Treatment 标签或 Frontal 状态。

## 状态协议

- scenes 严格按 T01 到 T22；DS 根据可见证据自行决定重复当前 scene 或前进一格；
- advanceGate 只提供判断依据，Harness 不执行中途硬 Gate；失败时只要求 Codex 自行定位、修复并重新验证；
- T16 第一次访问时由 Harness 原样注入 fixedMessage，后续访问由 DS 自然跟进；
- T16 之前不能出现 Manager-only requirement 或其可识别业务规则；
- 整个 Session 唯一的自动截止条件是 'hardMaxTurns = 60'；达到上限后直接结束，不强制推进 scene；
- 'safeMessage' 只用于 provider 失败后的已审核 fallback，不能据此强制推进。

## Scene map

| Scene | Title | Advance guidance |
| --- | --- | --- |
| T01 | Initial plan | A coherent plan covers deliverables, dependencies, risks, and verification without repository edits. |
| T02 | Module and process ownership | The response defines module dependencies, process boundaries, authority, and responsibilities that stay separate. |
| T03 | Success and failure flows | Both flows identify atomic effects, forbidden records, replay behavior, and visible outcomes. |
| T04 | Public contract first | Canonical public contracts cover every published input, output, state, error, command, and asynchronous result. |
| T05 | Test strategy | The strategy distinguishes unit, real integration, browser, multi-process, recovery, aggregate, and performance evidence. |
| T06 | Runnable skeleton | All public processes start with documented commands, expose health, and stop cleanly. |
| T07 | Migration and seed | Migrations replay safely; valid, replayed, conflicting, and invalid seeds have exact atomic outcomes. |
| T08 | Read model and UI data | Queries, cursors, ordering, states, and UI data come from real PostgreSQL through HTTP. |
| T09 | Atomic V1 mutation | Success, atomic rejection, replay, conflict, and concurrent requests preserve every V1 invariant. |
| T10 | Worker lifecycle and terminal races | Leases recover; stale ownership cannot commit; each effect and terminal state occurs at most once. |
| T11 | Transactional outbox and backend review | Events commit with state, retries preserve identity/body/order, dispatcher recovery passes, and concrete review findings are fixed. |
| T12 | Complete real frontend | The UI completes all V1 flows through visible controls and real API data with correct asynchronous and error states. |
| T13 | Real integration suite | Integration tests cover contract, seed, V1 state, idempotency, worker, outbox, and cleanup and pass repeatably. |
| T14 | Production browser E2E | Project-owned browser tests cover public V1 flows and asynchronous states and pass under one command. |
| T15 | Multi-process recovery and V1 review | Controlled races and crashes preserve all V1 invariants with no unresolved finding. |
| T16 | Harness-owned Manager change | Codex explains domain, schema, migration, API, worker, event, UI, compatibility, concurrency, recovery, and performance impact and gives a staged plan without implementing. |
| T17 | Compatible migration and backend | Populated V1 data and replay remain valid; changed domain/state/worker behavior passes focused tests. |
| T18 | Changed API and integration | New and old contracts agree; migration and replay evidence hold; real HTTP integration passes. |
| T19 | Changed frontend | The UI exposes changed and compatible flows, aggregate/member states, history, errors, accessibility, and responsive behavior. |
| T20 | Changed browser, concurrency, and recovery | Changed browser and crash races are automated and pass without compatibility or invariant failures. |
| T21 | Sustained performance and full regression | Evidence reports environment, scale, duration, throughput, errors, latency, drain, invariants, targets, and passing full regression. |
| T22 | Final review and handoff | No material finding remains; all required gates pass; documentation and handoff accurately state architecture, operation, compatibility, evidence, risks, and unrun checks. |

## Fixed Manager message

<!-- FIXED_MANAGER_MESSAGE_START -->
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
<!-- FIXED_MANAGER_MESSAGE_END -->

两份正文的唯一来源是 task generator；'dialogue-script.json' 的 'fixedMessage' 必须逐字相同。
T16 只做影响分析和计划，不能把“已开始实现”视为通过。

## Decision output

DS 决策输出必须是一个 JSON object：

~~~json
{"decision":"continue|accept|abort","sceneId":"T01","message":"one user message","state":{"turn":1,"lastScene":"T01","visits":{"T01":1}}}
~~~

只有 T22 advanceGate 已满足、'minimumTurns' 已达到且当前没有未解决失败时才能 'accept'。
达到 hard limit、公开合同不可完成或隔离被破坏时才能 'abort'。
