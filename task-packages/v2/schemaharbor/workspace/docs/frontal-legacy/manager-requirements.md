【Product Manager · Maya】

V1 已完成并通过基础验收。本期正式增加“atomic multi-subject release bundles”。以下业务规则、wire schema、接口和错误全部是公开增量合同。

业务规则：

1. A Release Bundle contains 1-20 Drafts from distinct Subjects and a dependency graph among their prospective versions.
2. At creation, capture {subjectId,headVersion,modeRevision} for every member and externally referenced Subject, sorted by subjectId, and validate the complete bundle only against that Catalog Snapshot, including dependencies within the bundle.
3. Publish all member versions atomically with each Subject's next number, or publish none.
4. Concurrent bundle and standalone publications may produce stale validation but never partial publication or version gaps.
5. Bundle publication emits member events followed by one bundle.published event with stable ordering.
6. Legacy standalone Draft and Publication APIs remain unchanged; member versions expose optional releaseBundleId.
7. Existing versions, canonical digests, dependencies, modes, and event sequences remain unchanged.
8. Pending V1 Validation Tasks either finish under their captured snapshot or fail stale normally.
9. Stored idempotency responses for standalone publication replay exactly.
10. The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
11. The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
12. Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
13. Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

新增 wire schema：

- CompilationFinding = {code:string,path:string,message:string}; findings sort by path then code
- BundleDependency = {kind:PUBLISHED,subjectId:uuid,version:int}|{kind:BUNDLE_MEMBER,subjectId:uuid}; BUNDLE_MEMBER names another Subject in the same Release Bundle and resolves to its prospective version
- CatalogSnapshotEntry = {subjectId:uuid,headVersion:int|null,modeRevision:int}
- ReleaseBundle = {releaseBundleId:uuid,state:VALIDATING|READY|PUBLISHED|REJECTED|STALE,members:[{draftId:uuid,subjectId:uuid,prospectiveVersion:int}],catalogSnapshot:[CatalogSnapshotEntry],canonicalDigest:sha256,findings:[CompilationFinding],createdAt:timestamp,publishedAt:timestamp|null,sequence:int}
- Under the Manager schema SchemaVersion adds releaseBundleId:uuid|null; standalone publication sets null and bundle publication sets the owning releaseBundleId

新增或变更接口：

- POST /api/v1/release-bundles with {members:[{subjectId,expectedHeadVersion,schema,dependencies:[BundleDependency]}]} validates 1..20 distinct Subjects and atomically creates one SchemaDraft with a stable server-assigned draftId for each member plus the VALIDATING ReleaseBundle; it returns the exact bundle with members ordered by subjectId, and retries preserve every draftId
- ReleaseBundle canonicalDigest is SHA-256 of RFC 8785 {members:[{subjectId,expectedHeadVersion,schema,dependencies}],catalogSnapshot}. Members and catalogSnapshot sort by subjectId; each dependency list sorts with BUNDLE_MEMBER before PUBLISHED, then subjectId, then version. Publication requires every captured headVersion and modeRevision still to match
- GET /api/v1/release-bundles/:releaseBundleId returns ReleaseBundle; POST /api/v1/release-bundles/:releaseBundleId/publish with {} atomically changes every member SchemaDraft to PUBLISHED and publishes every READY member
- GET /api/v1/subjects/:subjectId/versions/:version returns the Manager-extended SchemaVersion with releaseBundleId while legacy stored replay bodies remain unchanged

新增稳定错误：

- 409 RELEASE_BUNDLE_STALE: any member Subject head, mode revision, or external dependency changed
- 409 RELEASE_BUNDLE_INCOMPATIBLE: one member or the combined dependency graph fails exact validation

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

本轮先不要实现。请先说明它会影响哪些领域关系、模块、schema、migration、接口、状态、成功与失败数据流、兼容性、Worker、事件、前端、并发、恢复和性能测试，然后给出分阶段修改计划。