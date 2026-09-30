# SchemaHarbor 项目设计说明

## 1. 定位

SchemaHarbor 是一个从近空白 Git fixture 开始的高难度全栈 Coding Benchmark，主流程是
versioned schema compatibility publication。这是 learning task，用于形成可迁移的工程经验。

本题只用一个主流程承载难度，重点测量：immutable versioning、compare-and-publish races、async validation recovery、dependency consistency、read snapshot performance。领域词汇以
[CONTEXT.md](./CONTEXT.md) 为准。

## 2. 可见性

Codex 初始只能看到 'workspace/README.md'、'workspace/AGENTS.md' 和独立 fixture Git 历史。
Manager 变更、Checklist、对话状态机、评测方案和实验 metadata 都在 workspace 外，不能在
开发回合、Session Evolution 或盲审前复制或透露。

## 3. 完整 V1

- Create Subjects and canonical Draft schemas with pinned published Dependencies.
- Run compatibility validation asynchronously against the captured Subject head.
- Publish only if the head and Compatibility Mode still match the validation snapshot.
- Deduplicate semantic JSON content and replay mutation outcomes across instances and restarts.
- Expose diffs, validation findings, histories, dependencies, and publication events in a real UI.

核心状态：Schema Draft: VALIDATING -> VALID -> PUBLISHED, VALIDATING -> REJECTED, and VALIDATING|VALID -> STALE; publication creates one immutable Schema Version.

### 可计算不变量

1. A Subject has at most one published Schema Version for each integer version and no gaps.
2. Published canonical content and Dependency pins never change.
3. Publication succeeds only against the exact head and Compatibility Mode validated by its task.
4. Semantically equivalent canonical JSON cannot produce two versions in one Subject.
5. A rejected or stale Validation Task creates no Publication or publication event.

## 4. Manager 固定变更

V1、真实 Browser E2E、双 API/双 Worker 并发与恢复完成后，T16 才发布
“atomic multi-subject release bundles”。它改变核心基数、状态或一致性边界：

- A Release Bundle contains 1-20 Drafts from distinct Subjects and a dependency graph among their prospective versions.
- At creation, capture {subjectId,headVersion,modeRevision} for every member and externally referenced Subject, sorted by subjectId, and validate the complete bundle only against that Catalog Snapshot, including dependencies within the bundle.
- Publish all member versions atomically with each Subject's next number, or publish none.
- Concurrent bundle and standalone publications may produce stale validation but never partial publication or version gaps.
- Bundle publication emits member events followed by one bundle.published event with stable ordering.
- Legacy standalone Draft and Publication APIs remain unchanged; member versions expose optional releaseBundleId.

新增 wire schema：

- CompilationFinding = {code:string,path:string,message:string}; findings sort by path then code
- BundleDependency = {kind:PUBLISHED,subjectId:uuid,version:int}|{kind:BUNDLE_MEMBER,subjectId:uuid}; BUNDLE_MEMBER names another Subject in the same Release Bundle and resolves to its prospective version
- CatalogSnapshotEntry = {subjectId:uuid,headVersion:int|null,modeRevision:int}
- ReleaseBundle = {releaseBundleId:uuid,state:VALIDATING|READY|PUBLISHED|REJECTED|STALE,members:[{draftId:uuid,subjectId:uuid,prospectiveVersion:int}],catalogSnapshot:[CatalogSnapshotEntry],canonicalDigest:sha256,findings:[CompilationFinding],createdAt:timestamp,publishedAt:timestamp|null,sequence:int}
- Under the Manager schema SchemaVersion adds releaseBundleId:uuid|null; standalone publication sets null and bundle publication sets the owning releaseBundleId

新增或变更的公开接口：

- POST /api/v1/release-bundles with {members:[{subjectId,expectedHeadVersion,schema,dependencies:[BundleDependency]}]} validates 1..20 distinct Subjects and atomically creates one SchemaDraft with a stable server-assigned draftId for each member plus the VALIDATING ReleaseBundle; it returns the exact bundle with members ordered by subjectId, and retries preserve every draftId
- ReleaseBundle canonicalDigest is SHA-256 of RFC 8785 {members:[{subjectId,expectedHeadVersion,schema,dependencies}],catalogSnapshot}. Members and catalogSnapshot sort by subjectId; each dependency list sorts with BUNDLE_MEMBER before PUBLISHED, then subjectId, then version. Publication requires every captured headVersion and modeRevision still to match
- GET /api/v1/release-bundles/:releaseBundleId returns ReleaseBundle; POST /api/v1/release-bundles/:releaseBundleId/publish with {} atomically changes every member SchemaDraft to PUBLISHED and publishes every READY member
- GET /api/v1/subjects/:subjectId/versions/:version returns the Manager-extended SchemaVersion with releaseBundleId while legacy stored replay bodies remain unchanged

新增稳定错误：

- 409 RELEASE_BUNDLE_STALE: any member Subject head, mode revision, or external dependency changed
- 409 RELEASE_BUNDLE_INCOMPATIBLE: one member or the combined dependency graph fails exact validation

跨层规则：

- The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
- The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
- Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
- Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

FINAL snapshot 与性能兼容合同：

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

迁移必须同时满足：

- Existing versions, canonical digests, dependencies, modes, and event sequences remain unchanged.
- Pending V1 Validation Tasks either finish under their captured snapshot or fail stale normally.
- Stored idempotency responses for standalone publication replay exactly.

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
