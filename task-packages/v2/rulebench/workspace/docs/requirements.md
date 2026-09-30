# RuleBench — Complete system requirements

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

# RuleBench

Build RuleBench from this intentionally blank repository. This README is the complete public product
contract. Ask before making a product choice that the contract does not settle.

## Required stack and commands

- Node.js 22, TypeScript, React, PostgreSQL 16, npm, and the preinstalled Chromium.
- PostgreSQL is the sole authority for rules, versions, evaluations, explanations, idempotency, leases,
  Domain Events, and ordering.
- The production UI uses only the public HTTP API. User-supplied executable code is forbidden.

Required non-interactive commands:

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

Commands exit non-zero on failure and clean up all child processes.

## Rule language and deterministic semantics

RuleBench is tenant-scoped. A RuleSet owns immutable RuleSetVersions. Draft input is validated and compiled
into canonical declarative JSON before publication. Published versions never change.

Canonical objects:

```text
Tenant, RuleSet, RuleSetVersion, Rule, Evaluation, ExplanationNode,
ReplayRun, ConflictReport, OutboxEvent, Work
```

`uuid` is lowercase RFC 4122 text, `timestamp` is UTC ISO-8601 with millisecond precision and `Z`, `int` is
a JSON safe integer, and `json` is an RFC 8785-compatible object containing only null, booleans, strings,
safe integers, arrays, and objects. Object keys are compared by raw UTF-16 code units and arrays preserve order.

Expressions use exactly:

```text
{"all":[Expression,...]}
{"any":[Expression,...]}
{"not":Expression}
{"op":"eq|neq|lt|lte|gt|gte|in|exists","path":"$.segment.segment","value":json}
```

`all` and `any` contain 1..100 children. Maximum depth is 20, one version has at most 5,000 Rules, and one
facts object is at most 256 KiB. Paths contain ASCII identifiers only. Missing differs from JSON null.
Ordering comparisons accept safe integers only; `in` requires an array; comparisons never coerce types.
Expressions visit children left-to-right and short-circuit. They cannot use regex, dates, floating point,
environment variables, network, filesystem, SQL, templates, or arbitrary code.

```text
Rule = {ruleId:uuid,ruleSetVersionId:uuid,priority:int,name:string,condition:Expression,effect:{decision:ALLOW|DENY|REVIEW|null,tags:[string]},terminal:boolean}
RuleSetVersion = {ruleSetVersionId:uuid,ruleSetId:uuid,tenantId:uuid,revision:int,state:DRAFT|PUBLISHED|RETIRED,defaultDecision:ALLOW|DENY|REVIEW,rulesDigest:sha256,publishedAt:timestamp|null}
Evaluation = {evaluationId:uuid,tenantId:uuid,ruleSetId:uuid,ruleSetVersionId:uuid,factsDigest:sha256,state:PENDING|RUNNING|COMPLETED|FAILED,decision:ALLOW|DENY|REVIEW|null,tags:[string],matchedRuleIds:[uuid],explanationDigest:sha256|null,createdAt:timestamp,completedAt:timestamp|null,sequence:int}
ExplanationNode = {evaluationId:uuid,ordinal:int,ruleId:uuid,path:string,result:true|false|SKIPPED,reason:string}
ReplayRun = {replayRunId:uuid,evaluationId:uuid,state:PENDING|RUNNING|MATCHED|DIVERGED|FAILED,resultDigest:sha256|null,createdAt:timestamp,completedAt:timestamp|null}
```

Rules execute by ascending `(priority,ruleId)`. Matching nonterminal rules append unique tags and may set the
current decision. A matching terminal rule sets its non-null decision and stops all later rules. If no
terminal decision exists, the last matching non-null decision wins; otherwise use `defaultDecision`.
ExplanationNode records every visited Rule and every visited leaf; skipped rules after a terminal match are
represented by one `SKIPPED` node in priority order. `matchedRuleIds` preserve visit order. Tags are unique
and sorted by their first producing rule order.

Static conflict detection rejects a version before publication when it has duplicate priority, duplicate
ruleId, an unconditional terminal rule followed by any rule, an invalid expression/path/type, a terminal
rule with null decision, or two structurally identical conditions at the same priority with different
decisions. ConflictReport entries are deterministic and sorted by `(priority,ruleId,code)`.

## Required behavior and invariants

1. `(tenantId, ruleSetId, revision)` and `ruleSetVersionId` each identify one immutable version.
2. An Evaluation freezes one published RuleSetVersion and canonical facts digest when accepted.
3. Same Idempotency-Key and canonical body returns the original identity/body across response loss, restart,
   and concurrent replay; different canonical body returns `IDEMPOTENCY_CONFLICT`.
4. One Evaluation has exactly one terminal decision and one deterministic explanation digest.
5. Replay uses the original version and facts, never the current version. It must return `MATCHED`; a genuine
   digest mismatch becomes `DIVERGED` and cannot overwrite the original Evaluation.
6. Work leases use fencing, so a stale Worker cannot commit after replacement ownership.
7. A state transition, Work, ExplanationNodes, and Domain Event commit atomically.
8. Events are contiguous per aggregate and dispatch at least once with stable identity and canonical body.

## Public HTTP surface

```text
POST /api/v1/tenants
POST /api/v1/rule-sets
POST /api/v1/rule-sets/:ruleSetId/versions
POST /api/v1/rule-set-versions/:versionId/validate
POST /api/v1/rule-set-versions/:versionId/publish
GET  /api/v1/rule-set-versions/:versionId/conflicts
POST /api/v1/evaluations
GET  /api/v1/evaluations/:evaluationId
GET  /api/v1/evaluations/:evaluationId/explanation
POST /api/v1/evaluations/:evaluationId/replay
GET  /api/v1/replay-runs/:replayRunId
GET  /api/v1/verification-snapshot
GET  /openapi.json
GET  /healthz
```

Every mutation requires `Idempotency-Key` scoped by tenant, method, and canonical path. Collections use
`{items,nextCursor}` with opaque stable cursors. Reject unknown fields and unsupported media types.

Stable semantic errors:

```text
400 INVALID_EXPRESSION
400 FACTS_TOO_LARGE
409 RULE_CONFLICT
409 VERSION_NOT_PUBLISHED
409 VERSION_IMMUTABLE
409 REVISION_CONFLICT
409 IDEMPOTENCY_CONFLICT
```

Durable Work shape is
`{workId:uuid,kind:EVALUATION_EXECUTE|EVALUATION_REPLAY,aggregateId:uuid,state:PENDING|LEASED|SUCCEEDED|FAILED|CANCELLED,terminal:boolean,attempt:int,leaseOwner:string|null,leaseExpiresAt:timestamp|null}`.
Event types are `rule_version.published`, `evaluation.completed`, `evaluation.failed`, `replay.matched`, and
`replay.diverged`. Events and logs may contain IDs and digests but never facts or credentials.

## UI

The real React UI supports RuleSet creation, version editing, conflict validation, publication, Evaluation
submission, decision/explanation inspection, replay, Work status, and stable validation errors. Production
Chromium uses the built application and real PostgreSQL; jsdom and mocked APIs are insufficient.

## Seed and snapshot

The seed is exactly:

```json
{"schemaVersion":1,"seedVersion":"...","importedAt":"...","tenants":[],"ruleSets":[],"ruleSetVersions":[],"rules":[],"evaluations":[],"explanationNodes":[],"replayRuns":[],"conflictReports":[]}
```

Import is atomic. Same version and digest is a no-op; same version with different digest returns
`SEED_VERSION_CONFLICT`. V1 snapshot resources contain exactly `tenants`, `ruleSets`, `ruleSetVersions`,
`rules`, `evaluations`, `explanationNodes`, `replayRuns`, and `conflictReports`, complete and sorted by public
identity. Snapshot also exposes Work and Events but redacts facts, auth, private paths, and environment.

## Performance contract

Formal mode uses 4 logical CPUs, 8 GiB RAM, PostgreSQL 16, two API processes, four Workers, one Dispatcher,
and a warmed production build. Smoke scaling is non-scoring.

1. `evaluation-throughput`: a 200-rule published version, 200,000 mixed Evaluations, 64 clients for 60 seconds;
   acceptance >= 600 evaluations/s, p95 <= 250 ms, unexpected 5xx = 0, then Workers drain within 60 seconds.
2. `deep-short-circuit`: 5,000-rule versions where a rule in the first 10 terminates, 100,000 Evaluations,
   64 clients for 60 seconds; >=400 evaluations/s, p95 <=350 ms, and all later Rules are `SKIPPED`.
After load, recompute decision/explanation determinism, version pinning, replay equality, Work/Event order,
tenant isolation, RSS, and database growth.

## Out of scope

Arbitrary code, regex, floating-point arithmetic, temporal DSLs, machine-learning inference, remote data
lookups, side effects inside evaluation, cross-tenant rules, and automatic promotion without operator action.

## Successful response contracts

Successful response contracts are closed:

- A mutation route without a literally stated success status returns 200.
- Unless a route literally publishes another object, array, or empty body, a success described by a named resource, named resource state, or named resource fields returns that exact resource shape at the JSON top level. Any response-only fields literally named by the route are additional top-level fields.
- If a mutation publishes no success body, it returns the exact current shape of the single primary resource created or changed by that route at the JSON top level.
- When a route explicitly returns multiple named resources, the body is one object keyed by their lower-camel resource names unless the route publishes another literal shape.
- Wrappers such as `{data:...}`, `{result:...}`, or an extra single-resource envelope are invalid unless the route literally declares them. OpenAPI must publish the same success status and closed response schema as runtime.

## Additional product requirements — required in the same final system

新增 Shadow ComparisonRun。
ComparisonRun={comparisonRunId,tenantId,ruleSetId,baselineVersionId,candidateVersionId,evaluationIds,corpusDigest,state:PENDING|RUNNING|COMPLETED|CANCELLED|FAILED,revision,resultCounts:{MATCH,DIFF,ERROR},createdAt,startedAt,completedAt,cancelledAt,promotedAt}。
创建时冻结同一 RuleSet 的两个已发布版本，将 1..100,000 个 completed Evaluation ID 去重后按 UUID 升序保存；
corpusDigest 是该 ID 数组的 RFC 8785-compatible canonical JSON SHA-256。
ComparisonResult={comparisonRunId,evaluationId,ordinal,status:MATCH|DIFF|ERROR,baseline:{decision,tags,explanationDigest}|null,candidate:{decision,tags,explanationDigest}|null,errorCode:string|null,resultDigest}。
resultDigest 是除自身外这些字段的 canonical JSON SHA-256。
MATCH 表示两侧 decision、tags 和 explanationDigest 全部相同；
DIFF 表示两侧均成功但至少一项不同；
ERROR 表示任一侧无法产生合法确定性结果，例如排序比较读取到非 safe-integer facts。
ERROR 不可由 Worker 或客户端标记为已解释；
本版本没有豁免 API，因此只要 resultCounts.ERROR > 0 就禁止 promotion。
新增 HTTP 合同：POST /api/v1/comparison-runs，request {tenantId,ruleSetId,baselineVersionId,candidateVersionId,evaluationIds}，response {run:ComparisonRun}；
POST /api/v1/comparison-runs/:comparisonRunId/start，request {expectedRevision}，response {run:ComparisonRun}；
POST /api/v1/comparison-runs/:comparisonRunId/cancel，request {expectedRevision}，response {run:ComparisonRun}；
POST /api/v1/comparison-runs/:comparisonRunId/promote，request {expectedRevision}，response {run:ComparisonRun,ruleSet:RuleSet}；
GET /api/v1/comparison-runs/:comparisonRunId，response {run:ComparisonRun,results:[ComparisonResult,...]}。
所有 mutation 要求 Idempotency-Key，未知字段仍须拒绝。
start 通过 CAS 从 PENDING 进入 RUNNING；
cancel 是 durable fence，旧 lease 此后不得提交 Result。
Worker 必须读取存储的 facts，分别用冻结版本求值，生成每个 corpus Evaluation 恰好一个不可变 Result，绝不能修改原 Evaluation。
completed run 只有在 expectedRevision 匹配且 ERROR 为零时才能 promote；
promotion 只把 RuleSet 的 currentPublishedVersionId 指向 candidate 并增加 publicationRevision，绝不修改 RuleSetVersion。
状态冲突返回 409 COMPARISON_REVISION_CONFLICT，存在 ERROR 返回 409 COMPARISON_HAS_ERRORS，且两者都无副作用。
新增 COMPARISON_EXECUTE Work 和 comparison.started、comparison.completed、comparison.cancelled、comparison.promoted Events；

UI 增加 corpus、进度、diff、cancel 和 promote。
正式 comparison-recovery 场景使用 50,000 个 frozen inputs，SIGKILL 两个已 claim Worker，再启动四个 replacement；
必须在 60 秒内完成，每个 corpus Evaluation 恰好一个 Result，不能有 digest drift 或重复 Event。

