# SchemaHarbor Harness-owned E2E / Concurrency / Recovery / Performance 方案

## 1. 边界与等级

本文件位于 candidate workspace 外，只定义 D1 黑盒评测方案。当前没有 runner、中央 score
manifest、gold 或 calibration 证据，不能声称 D3。Evaluator 只使用公开命令、HTTP、浏览器、
webhook receiver、文件下载和进程信号；不得 import 候选源码、ORM、表名或 'dist' 路径。

## 2. 固定环境

- Node.js 22、PostgreSQL 16、Chromium 和 Docker-compatible OCI；容器限制为 4 logical CPUs、
  8 GiB RAM，两个 API、两个 workers、一个 dispatcher 和 PostgreSQL 共享该限制；
- 每个 scenario 使用新数据库、新端口和独立 managed data directory；
- 两个 API、至少两个 Validation Task workers 和一个 dispatcher 共享同一 PostgreSQL；
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

- Create Subjects and canonical Draft schemas with pinned published Dependencies.
- Run compatibility validation asynchronously against the captured Subject head.
- Publish only if the head and Compatibility Mode still match the validation snapshot.
- Deduplicate semantic JSON content and replay mutation outcomes across instances and restarts.
- Expose diffs, validation findings, histories, dependencies, and publication events in a real UI.

对每个成功状态同时检查响应、查询、历史、异步工作和事件。

### H-04 Atomic rejection and conservation

在每个公开失败边界生成合法但不可满足的请求，断言无 partial aggregate、任务、事件或守恒量
变化。核心断言：

1. A Subject has at most one published Schema Version for each integer version and no gaps.
2. Published canonical content and Dependency pins never change.
3. Publication succeeds only against the exact head and Compatibility Mode validated by its task.
4. Semantically equivalent canonical JSON cannot produce two versions in one Subject.
5. A rejected or stale Validation Task creates no Publication or publication event.

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

- Existing versions, canonical digests, dependencies, modes, and event sequences remain unchanged.
- Pending V1 Validation Tasks either finish under their captured snapshot or fail stale normally.
- Stored idempotency responses for standalone publication replay exactly.

### H-10 Manager core behavior

仅在 T16 已发布后按黑盒方式验证：

- A Release Bundle contains 1-20 Drafts from distinct Subjects and a dependency graph among their prospective versions.
- At creation, capture {subjectId,headVersion,modeRevision} for every member and externally referenced Subject, sorted by subjectId, and validate the complete bundle only against that Catalog Snapshot, including dependencies within the bundle.
- Publish all member versions atomically with each Subject's next number, or publish none.
- Concurrent bundle and standalone publications may produce stale validation but never partial publication or version gaps.
- Bundle publication emits member events followed by one bundle.published event with stable ordering.
- Legacy standalone Draft and Publication APIs remain unchanged; member versions expose optional releaseBundleId.

新增 wire schema 与接口同样属于断言面：

- CompilationFinding = {code:string,path:string,message:string}; findings sort by path then code
- BundleDependency = {kind:PUBLISHED,subjectId:uuid,version:int}|{kind:BUNDLE_MEMBER,subjectId:uuid}; BUNDLE_MEMBER names another Subject in the same Release Bundle and resolves to its prospective version
- CatalogSnapshotEntry = {subjectId:uuid,headVersion:int|null,modeRevision:int}
- ReleaseBundle = {releaseBundleId:uuid,state:VALIDATING|READY|PUBLISHED|REJECTED|STALE,members:[{draftId:uuid,subjectId:uuid,prospectiveVersion:int}],catalogSnapshot:[CatalogSnapshotEntry],canonicalDigest:sha256,findings:[CompilationFinding],createdAt:timestamp,publishedAt:timestamp|null,sequence:int}
- Under the Manager schema SchemaVersion adds releaseBundleId:uuid|null; standalone publication sets null and bundle publication sets the owning releaseBundleId
- POST /api/v1/release-bundles with {members:[{subjectId,expectedHeadVersion,schema,dependencies:[BundleDependency]}]} validates 1..20 distinct Subjects and atomically creates one SchemaDraft with a stable server-assigned draftId for each member plus the VALIDATING ReleaseBundle; it returns the exact bundle with members ordered by subjectId, and retries preserve every draftId
- ReleaseBundle canonicalDigest is SHA-256 of RFC 8785 {members:[{subjectId,expectedHeadVersion,schema,dependencies}],catalogSnapshot}. Members and catalogSnapshot sort by subjectId; each dependency list sorts with BUNDLE_MEMBER before PUBLISHED, then subjectId, then version. Publication requires every captured headVersion and modeRevision still to match
- GET /api/v1/release-bundles/:releaseBundleId returns ReleaseBundle; POST /api/v1/release-bundles/:releaseBundleId/publish with {} atomically changes every member SchemaDraft to PUBLISHED and publishes every READY member
- GET /api/v1/subjects/:subjectId/versions/:version returns the Manager-extended SchemaVersion with releaseBundleId while legacy stored replay bodies remain unchanged
- 409 RELEASE_BUNDLE_STALE: any member Subject head, mode revision, or external dependency changed
- 409 RELEASE_BUNDLE_INCOMPATIBLE: one member or the combined dependency graph fails exact validation
- The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
- The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
- Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
- Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

FINAL snapshot 与性能兼容断言：

The FINAL verification snapshot 'resources' object has exactly the union of these V1 and Manager resource specifications, with no other keys:

- 'subjects' uses exact shape 'Subject' and sorts ascending by scalar field-path tuple 'subjectId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'schemaDrafts' uses exact shape 'SchemaDraft' and sorts ascending by scalar field-path tuple 'draftId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'schemaVersions' uses exact shape 'SchemaVersion' and sorts ascending by scalar field-path tuple 'subjectId', 'version', then by RFC 8785 canonical JSON as the tie-breaker.
- 'releaseBundles' uses exact shape 'ReleaseBundle' and sorts ascending by scalar field-path tuple 'releaseBundleId', then by RFC 8785 canonical JSON as the tie-breaker.

The Manager-added resource specifications are exactly:

- 'releaseBundles' uses exact shape 'ReleaseBundle' and sorts ascending by scalar field-path tuple 'releaseBundleId', then by RFC 8785 canonical JSON as the tie-breaker.

The FINAL Work kind enum is exactly the union 'SCHEMA_VALIDATION', 'BUNDLE_VALIDATION'. The Manager-added
Work kinds are exactly 'BUNDLE_VALIDATION'. All V1 snapshot point-in-time,
recursive '*Token' omission, sorting, Work state/lease/retention/drain, and Domain Event rules remain
mandatory. The FINAL binary reruns exactly these three V1-compatible scenarios:

- 'latest-schema-read': serve 500 latest-schema reads/s with p95 <= 80 ms; threshold: At least 500 successful reads/s for 60 seconds and p95 <= 80 ms; unexpected 5xx = 0.
- 'schema-validation': validate 50 schemas/s with p95 queue latency <= 2 s; threshold: At least 50 VALID drafts/s for 60 seconds and terminal validation queue-latency p95 <= 2,000 ms; unexpected 5xx = 0.
- 'gapless-publish': publish 2,000 non-conflicting versions without gaps during a 60 s run; threshold: Exactly 2,000 non-conflicting publishes complete within the 60-second window; unexpected conflict and 5xx counts are zero.

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
worker/dispatcher backlog 与排空时间。固定 dataset 为：seedVersion perf-v1 contains exactly 2,000 subjects and 20,000 publishedVersions, ten contiguous versions per Subject; validation and publication runs create all measured Drafts through the public API.。三个场景是：

### Scenario 'latest-schema-read'

- Target: serve 500 latest-schema reads/s with p95 <= 80 ms
- Mode: 'http'
- Method: 'GET'
- Path: '/api/v1/subjects/:subjectId/versions/latest'
- Setup: Use all seeded Subjects with a published head; reads do not mutate headVersion.
- Selector: Round-robin subjectId values in bytewise order.
- Request: No body or query parameters.
- Concurrency: 64
- Warm-up seconds: 10
- Measure seconds: 60
- Success: Only 200 exact LatestSchemaResponse bodies whose subject and nullable version come from the same point-in-time head count.
- Threshold: At least 500 successful reads/s for 60 seconds and p95 <= 80 ms; unexpected 5xx = 0.
- Timer: The throughput window starts with the first measured request after warm-up; each latency sample runs from request dispatch through the complete response body.

### Scenario 'schema-validation'

- Target: validate 50 schemas/s with p95 queue latency <= 2 s
- Mode: 'http'
- Method: 'POST'
- Path: '/api/v1/subjects/:subjectId/schema-drafts'
- Setup: Prepare separate warm-up and measured draft requests against published Subject heads; each schema has exactly 20 fields and exactly two published dependency pins.
- Selector: Round-robin subjectId bytewise, use its current headVersion, and generate unique schema names and field names from request ordinal.
- Request: {schema:{name,fields:{20 deterministic fields}},dependencies:[two pins],expectedHeadVersion}; use a fresh Idempotency-Key.
- Concurrency: 64
- Warm-up seconds: 10
- Measure seconds: 60
- Success: Only 202 VALIDATING creations whose SCHEMA_VALIDATION Work reaches VALID count; REJECTED or STALE drafts do not count.
- Threshold: At least 50 VALID drafts/s for 60 seconds and terminal validation queue-latency p95 <= 2,000 ms; unexpected 5xx = 0.
- Timer: The throughput window starts at first measured POST; each queue-latency sample starts at that draft's creation commit and ends at its VALID terminal commit.

### Scenario 'gapless-publish'

- Target: publish 2,000 non-conflicting versions without gaps during a 60 s run
- Mode: 'http'
- Method: 'POST'
- Path: '/api/v1/schema-drafts/:draftId/publish'
- Setup: Before timing, create and validate exactly 2,000 measured Drafts, one for each distinct Subject, plus a disjoint warm-up set.
- Selector: Publish Draft IDs round-robin in bytewise subjectId order; no two measured Drafts share a Subject.
- Request: Body {} with one fresh Idempotency-Key per Draft.
- Concurrency: 64
- Warm-up seconds: 10
- Measure seconds: 60
- Success: Every measured request publishes exactly one next SchemaVersion; all 2,000 responses are successful and no Subject has a version gap.
- Threshold: Exactly 2,000 non-conflicting publishes complete within the 60-second window; unexpected conflict and 5xx counts are zero.
- Timer: The throughput window starts with the first measured request after warm-up; each latency sample runs from request dispatch through the complete response body.

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
