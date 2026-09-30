# ImportWorks — Complete system requirements

Public scope revision: **learning-final-system-2026-09-08.1**. This is a single final-system task, not a historical upgrade benchmark.

## Scope and authority

- Build one complete system from the start. Base features and the formerly named Manager features are required together; there is no intermediate submission, old program, historical workspace, or cross-version upgrade assessment.
- V1 in an API or source description denotes the base feature contract, not a separately running program. The published /api/v1 paths and schemaVersion values do not change.
- Cross-version-only duties are withdrawn: importing an unspecified historical physical database, upgrading an earlier binary, migration-time availability of an earlier binary, and synthesizing migration-only legacy wrappers. Current public resource shapes, base APIs, additional features and their ordinary business relationships remain required.
- Initialize an empty database using the published commands. db:migrate is current-system schema initialization, not an obligation to recognize a hidden old schema. Preserve the original current-system seed validation, atomicity and replay rules.
- Evaluation creates fresh data through the published seed or APIs, then checks actual behavior and durable state. Restart and recovery assertions use this same final system. A snapshot is a read-only observation, not a database backup format.
- Persistence, transactionality, idempotency, concurrency, authorization, real UI, OpenAPI, recovery and explicitly specified performance requirements remain in scope. This policy does not remove an otherwise explicit business or security requirement.
- No external legacy service is required. An isolated receiver or provider simulator is used only for an external interaction actually required by the public product contract; no real account or production service is required.
- Hidden assertions must use published inputs and observable requirements. Unspecified algorithms, exact error strings, control points or performance thresholds cannot silently become requirements. Code defects fail; invalid author fixtures and infrastructure faults are evaluator errors, not zero-score business outcomes.

The original source documents are retained under frontal-legacy/ only for provenance. The complete active business requirements are reproduced below; the withdrawn historical orchestration and cross-version-only clauses are not a second source of obligations. contract/ fixes public representation.

## Base product requirements

# ImportWorks

Build ImportWorks from this intentionally blank repository. This README is the complete public product contract.
Ask before making a product choice that is not settled here.

## Stack and commands

Use Node.js 22, TypeScript, React, PostgreSQL 16, npm, and the installed Chromium. PostgreSQL is the sole
authority for imports, upload progress, validation, committed records, idempotency, work leases, and events.
The production UI must call the public HTTP API.

Provide these non-interactive commands; every command must return a truthful exit code and clean up children:

```text
npm run db:migrate
npm run db:seed -- --file <path>
npm run dev
npm run build
npm run start:api
npm run start:worker
npm run start:dispatcher
npm run test:unit
npm run test:integration
npm run test:e2e
npm run test:concurrency
npm run test:recovery
npm run test:all
npm run test:perf
```

Environment variables are `DATABASE_URL`, `TEST_DATABASE_URL`, `PORT` (default `3000`), `ADMIN_TOKEN`,
`WEBHOOK_URL`, `WORK_LEASE_SECONDS` (default `3`), `MANAGED_DATA_ROOT`, `TEST_BARRIER_URL`, and
`TEST_BARRIER_TOKEN`. Uploaded bytes must remain below `MANAGED_DATA_ROOT`; private paths never appear in APIs.

## Product model

ImportWorks imports tenant-scoped NDJSON datasets through resumable byte-range upload, frozen-schema validation,
selective or atomic commit, deterministic error reports, and background recovery. It is not an ETL scheduler,
spreadsheet editor, data warehouse, or arbitrary transformation runtime.

```text
ImportJob: UPLOADING -> UPLOADED -> VALIDATING -> VALIDATED -> COMMITTING
           -> COMMITTED | PARTIALLY_COMMITTED | REJECTED | CANCELLED
UploadChunk: RECEIVED (immutable)
ErrorReport: PENDING -> READY | FAILED
Work: PENDING -> LEASED -> SUCCEEDED | FAILED | CANCELLED
```

`commitMode` is `ALL_OR_NOTHING` or `VALID_ROWS`. A job freezes `tenantId`, `datasetKey`, `schemaRevision`,
`commitMode`, expected byte count, expected SHA-256, and external-row identity field. Database time controls all
timestamps and leases.

## Exact public shapes

`uuid` is lowercase RFC 4122 text, `timestamp` is UTC ISO-8601 with milliseconds and `Z`, and `sha256` is 64
lowercase hexadecimal characters. Unknown fields are rejected.

```text
ImportJob = {importId:uuid,tenantId:uuid,datasetKey:string,schemaRevision:int,commitMode:ALL_OR_NOTHING|VALID_ROWS,state:string,expectedBytes:int,expectedSha256:sha256,receivedBytes:int,totalRows:int,validRows:int,invalidRows:int,createdAt:timestamp,completedAt:timestamp|null,sequence:int}
UploadChunk = {importId:uuid,chunkNumber:int,start:int,end:int,size:int,sha256:sha256,receivedAt:timestamp}
ValidationFinding = {findingId:uuid,importId:uuid,rowNumber:int,externalRowId:string|null,field:string,code:string,message:string,valueDigest:sha256|null}
CommittedRecord = {recordId:uuid,tenantId:uuid,datasetKey:string,externalRowId:string,sourceImportId:uuid,payload:json,payloadDigest:sha256,committedAt:timestamp}
ErrorReport = {reportId:uuid,importId:uuid,state:PENDING|READY|FAILED,rowCount:int,sha256:sha256|null,createdAt:timestamp,readyAt:timestamp|null}
```

## Upload and resume

1. `POST /api/v1/imports` creates one ImportJob and requires `Idempotency-Key`.
2. `PUT /api/v1/imports/:importId/chunks/:chunkNumber` accepts raw bytes plus `Content-Range`,
   `X-Chunk-SHA256`, and `Idempotency-Key`. Ranges must be non-overlapping and cover the declared total exactly.
3. Repeating an identical chunk is a replay. Reusing a chunk number, range, or key with different bytes is
   `CHUNK_CONFLICT` or `IDEMPOTENCY_CONFLICT` and has no durable effect.
4. Chunks may arrive out of order. `GET /api/v1/imports/:importId` returns received ranges and missing ranges so a
   client can resume after process restart.
5. `POST /api/v1/imports/:importId/complete` succeeds only when coverage is contiguous and the assembled byte count
   and SHA-256 match. Failure never creates validation work.
6. Abort is idempotent before commit. A committed job and its source digest are immutable.

## Validation, commit, and reports

Each NDJSON line is one object and has a stable 1-based row number. Validation uses the SchemaRevision frozen when
the job was created, even if a newer schema is later published. Invalid UTF-8, malformed JSON, duplicate external
row IDs, missing required fields, wrong types, and unknown fields create deterministic findings. Findings are sorted
by `(rowNumber, field, code, findingId)` and never expose a raw value; only a digest may be stored.

`ALL_OR_NOTHING` creates no CommittedRecord when any row is invalid. `VALID_ROWS` publishes every valid row exactly
once and creates findings for invalid rows; its terminal state is `PARTIALLY_COMMITTED` when both groups exist.
Concurrent commit calls, unknown HTTP outcomes, duplicate work delivery, and restart must converge on one result.
Within `(tenantId,datasetKey,externalRowId)`, an identical payload is replayed and a different payload is
`ROW_IDENTITY_CONFLICT`; no partial replacement is allowed.

Every accepted business transition writes its DomainEvent in the same transaction. Dispatch is at-least-once but
event ID, aggregate sequence, headers, and body stay byte-identical across unknown ACK retry. Worker final commits
must fence stale leases.

## HTTP contract

```text
POST /api/v1/tenants
POST /api/v1/schemas
POST /api/v1/schemas/:schemaId/revisions
POST /api/v1/imports
GET  /api/v1/imports/:importId
PUT  /api/v1/imports/:importId/chunks/:chunkNumber
POST /api/v1/imports/:importId/complete
POST /api/v1/imports/:importId/commit
POST /api/v1/imports/:importId/cancel
GET  /api/v1/imports/:importId/findings?limit&cursor
GET  /api/v1/imports/:importId/error-report
GET  /api/v1/records?tenantId&datasetKey&limit&cursor
GET  /api/v1/verification-snapshot
```

Also serve `GET /openapi.json` using OpenAPI 3.1 and `GET /healthz`. JSON errors are
`{"error":{"code":"STABLE_CODE","message":"...","details":{}}}`. Published semantic errors are exhaustive:

```text
400 INVALID_IMPORT  400 INVALID_CHUNK  400 MALFORMED_JSON  400 INVALID_REQUEST
409 CHUNK_CONFLICT  409 UPLOAD_INCOMPLETE  409 FILE_DIGEST_MISMATCH
409 IMPORT_NOT_VALIDATED  409 ROW_IDENTITY_CONFLICT  409 IMPORT_TERMINAL
409 IDEMPOTENCY_CONFLICT  404 NOT_FOUND
```

Collections return `{items,nextCursor}` with stable opaque cursors. Every mutation requires durable idempotency
scoped by tenant, method, canonical path, and key.

## Work, events, seed, and snapshot

V1 Work kinds are `UPLOAD_EXPIRY`, `IMPORT_VALIDATE`, `IMPORT_COMMIT`, `ERROR_REPORT`, and `EVENT_DELIVERY`.
Work has `{workId,kind,aggregateId,state,terminal,attempt,leaseOwner,leaseExpiresAt}`. Required events include
`import.created`, `import.uploaded`, `import.validated`, `import.committed`, `import.partially_committed`, and
`import.cancelled`.

The seed shape is exactly:

```json
{"schemaVersion":1,"seedVersion":"...","tenants":[],"schemas":[],"schemaRevisions":[],"imports":[],"uploadChunks":[],"validationFindings":[],"committedRecords":[],"errorReports":[]}
```

Seed import is one transaction. Same version and digest is a no-op; same version with different content is
`SEED_VERSION_CONFLICT`; unknown members or invalid references reject the whole seed.

The admin-authenticated snapshot contains complete, deterministically sorted `tenants`, `schemas`,
`schemaRevisions`, `imports`, `uploadChunks`, `validationFindings`, `committedRecords`, and `errorReports`, plus
ordered events and Work. It contains no raw file bytes, rejected raw values, tokens, credentials, or paths.

## UI and project-owned verification

The production React UI must let a user create an import, upload/resume chunks, inspect progress and findings,
commit or cancel, download the error report, browse committed records, and see worker/recovery state. Browser tests
must use the production build and real API.

Unit tests cover range/digest/schema rules. Integration uses real PostgreSQL and HTTP. E2E uses production Chromium.
Concurrency uses two API and two Worker processes. Recovery kills a claimed Worker and a dispatcher after an
upstream response, then verifies lease recovery and byte-identical event retry. `test:all` runs every non-performance
gate. `test:perf` runs all fixed performance scenarios and validates post-load invariants.

## Published performance gates

Formal scoring uses the fixed Linux arm64 environment and `BENCH_PERF_SCALE=1`; scaled runs are smoke only.

1. `resumable-upload`: 2,000 independent 1 MiB imports, four out-of-order chunks each, 64 clients; at least 40
   completed uploads/s, p95 <= 1,500 ms, zero unexpected 5xx, and exact digest/coverage after replay.
2. `partial-commit`: 5,000 `VALID_ROWS` imports containing 100 rows with 10 deterministic invalid rows, 32 clients;
   at least 20 committed imports/s, p95 <= 2,500 ms, exactly 450,000 committed rows and 50,000 findings.
3. `validation-recovery`: 10,000 completed imports; kill two claimed workers at barriers, wait for lease expiry, then
   drain with four replacements in <= 120 seconds with no duplicate records, findings, reports, or events.

After every load, recompute byte coverage, row totals, external-row uniqueness, event sequence, tenant isolation, and
Work drain from the public snapshot.

## Out of scope

CSV/XLSX parsing, arbitrary user code, cross-dataset joins, streaming CDC, data visualization, cloud object stores,
and reading files outside `MANAGED_DATA_ROOT` are out of scope.

## Successful response contracts

Successful response contracts are closed:

- A mutation route without a literally stated success status returns 200.
- Unless a route literally publishes another object, array, or empty body, a success described by a named resource, named resource state, or named resource fields returns that exact resource shape at the JSON top level. Any response-only fields literally named by the route are additional top-level fields.
- If a mutation publishes no success body, it returns the exact current shape of the single primary resource created or changed by that route at the JSON top level.
- When a route explicitly returns multiple named resources, the body is one object keyed by their lower-camel resource names unless the route publishes another literal shape.
- Wrappers such as `{data:...}`, `{result:...}`, or an extra single-resource envelope are invalid unless the route literally declares them. OpenAPI must publish the same success status and closed response schema as runtime.

## Additional product requirements — required in the same final system

增加跨文件 ImportBundle 原子发布。
一个 Bundle 冻结同一租户多个 VALIDATED ImportJob；
VALIDATED 表示校验完成且可以包含 findings，带 findings 的 ALL_OR_NOTHING Job 到 commit 或 Bundle publish 时才 REJECTED。
同一 ImportJob 只能属于一个未终结 Bundle。
Bundle 状态为 DRAFT -> STAGED -> PUBLISHING -> PUBLISHED | REJECTED | CANCELLED；
STAGED 后成员、Schema Revision、源摘要和提交模式不可修改。
公开形状为 ImportBundle = {bundleId:uuid,tenantId:uuid,name:string,state:string,createdAt:timestamp,stagedAt:timestamp|null,publishedAt:timestamp|null} 与 BundleMember = {bundleId:uuid,importId:uuid,position:int,schemaRevision:int,sourceSha256:sha256,commitMode:ALL_OR_NOTHING|VALID_ROWS}；
FINAL snapshot 使用 importBundles 与 bundleMembers。
POST /api/v1/import-bundles 使用 {tenantId:uuid,name:string}；
POST /api/v1/import-bundles/:bundleId/members 使用 {importId:uuid}；
POST /api/v1/import-bundles/:bundleId/stage 与 POST /api/v1/import-bundles/:bundleId/publish 使用 {}。
每个 mutation 都要求 durable Idempotency-Key，成功返回完整 Bundle 或 Member。
publish 必须所有允许记录与事件一起成功或全部失败；
ALL_OR_NOTHING 成员有错误时整个 Bundle REJECTED。
稳定错误为 409 BUNDLE_MEMBER_CONFLICT、409 BUNDLE_FROZEN、409 BUNDLE_NOT_STAGEABLE、409 BUNDLE_NOT_PUBLISHABLE、409 IDEMPOTENCY_CONFLICT 和 404 NOT_FOUND，并使用 V1 JSON error envelope。
两个 API、重复请求、未知响应与 Worker 重启必须收敛且不得部分发布。
Bundle publish 使用公开 Work kind BUNDLE_PUBLISH，aggregateId = bundleId。

既有已提交 ImportJob 不得回写。
更新 OpenAPI、Worker、production UI 和所有测试。

