# ConfigOrbit

Build ConfigOrbit from this intentionally blank Git repository. This README is the complete public product contract.

## Required stack and commands

Use Node.js 22, TypeScript, React, PostgreSQL 16, npm, and installed Chromium. PostgreSQL is the sole authority;
process memory and client caches are disposable projections. Provide these non-interactive commands with truthful
exit codes and child cleanup:

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

Environment variables: `DATABASE_URL`, `TEST_DATABASE_URL`, `PORT` (default `3000`), `ADMIN_TOKEN`,
`WEBHOOK_URL`, `WORK_LEASE_SECONDS` (default `3`), `TEST_BARRIER_URL`, and `TEST_BARRIER_TOKEN`.

## Product boundary and state

ConfigOrbit manages tenant-scoped application configuration across `development`, `staging`, and `production`.
It supports immutable revisions, deterministic percentage rollout, instant rollback, long-poll/poll client fetch,
monotonic invalidation, audit history, and a production control UI. It is not a secret vault, feature experiment
analytics system, service mesh, source-code deployment service, or arbitrary template engine. Config values must not
contain credentials; keys matching `password`, `secret`, `token`, or `privateKey` are rejected recursively.

```text
ConfigRevision: DRAFT -> PUBLISHED | ABANDONED
Release: SCHEDULED -> ACTIVE -> SUPERSEDED | ROLLED_BACK | CANCELLED
Invalidation: PENDING -> DELIVERING -> DELIVERED
Work: PENDING -> LEASED -> SUCCEEDED | FAILED | CANCELLED
```

A ConfigRevision freezes one complete JSON object, canonical SHA-256, parent revision, author reference, and schema
revision. Published content is immutable. A Release freezes one environment, revision, percentage `0..10000` basis
points, audience salt, and start time. Database time controls activation, leases, and audit sequence.

## Exact public shapes

`uuid` is lowercase RFC 4122, `timestamp` is UTC ISO-8601 with millisecond precision and `Z`, and `sha256` is 64
lowercase hexadecimal characters. Unlisted fields are rejected.

```text
Application = {applicationId:uuid,tenantId:uuid,key:string,name:string}
Environment = {environmentId:uuid,applicationId:uuid,key:development|staging|production,generation:int,activeReleaseId:uuid|null,createdAt:timestamp}
ConfigRevision = {revisionId:uuid,environmentId:uuid,revision:int,parentRevisionId:uuid|null,state:DRAFT|PUBLISHED|ABANDONED,document:json,documentDigest:sha256,schemaRevision:int,createdAt:timestamp,publishedAt:timestamp|null}
Release = {releaseId:uuid,environmentId:uuid,revisionId:uuid,previousReleaseId:uuid|null,state:string,rolloutBasisPoints:int,audienceSalt:string,generation:int,createdAt:timestamp,activatedAt:timestamp|null,terminalAt:timestamp|null}
ClientObservation = {clientId:string,environmentId:uuid,lastGeneration:int,lastReleaseId:uuid|null,lastSeenAt:timestamp}
Invalidation = {invalidationId:uuid,environmentId:uuid,generation:int,releaseId:uuid,eventId:uuid,state:PENDING|DELIVERING|DELIVERED,createdAt:timestamp,deliveredAt:timestamp|null}
```

## Revision, publish, rollout, and rollback rules

1. Creating a revision requires an exact `parentRevisionId` equal to the environment's newest revision, preventing
   lost updates. The canonical JSON digest ignores object-key order but preserves array order and value types.
2. Publishing validates the complete document, atomically marks the revision PUBLISHED, creates a Release and
   increments the environment generation. Business state, audit entry, Work, and DomainEvent commit together.
3. Rollout assignment is the unsigned value of the first 64 bits of SHA-256 over
   `tenantId:applicationId:environmentId:releaseId:audienceSalt:clientId`, modulo 10000. A client is on the new Release
   when the result is below `rolloutBasisPoints`; the algorithm and salt are frozen for that Release.
4. Changing a percentage creates a new immutable Release generation. Concurrent updates require `expectedGeneration`;
   exactly one succeeds and stale requests return `ENVIRONMENT_GENERATION_CHANGED`.
5. Rollback never edits or deletes a revision. It creates a new Release pointing at an earlier PUBLISHED revision,
   increments generation, invalidates all client caches, and preserves the complete audit chain.
6. Every mutation requires durable `Idempotency-Key` scoped by tenant, method, canonical path, and key. Unknown HTTP
   outcome, replay, another API process, and restart return the exact saved status and JSON.

## Client fetch and cache invalidation

`GET /api/v1/client-config` requires tenant, application key, environment key, and stable `clientId`. It returns
`{releaseId,revisionId,generation,document,documentDigest,etag}`. `If-None-Match` returns 304 only when the client's
resolved release and generation are unchanged. A stale `knownGeneration` must return the current body, never 304.

Invalidations are at-least-once and may arrive duplicated or reordered. Clients apply only a generation greater than
their current generation; an older message can never restore old configuration. API processes may cache documents,
but each fetch must observe the database generation fence. A committed publish or rollback must be externally visible
to polling clients within 5 seconds. Event ID and body stay byte-identical across unknown webhook ACK.

## Public HTTP surface

```text
POST /api/v1/tenants
POST /api/v1/applications
POST /api/v1/environments
POST /api/v1/config-revisions
GET  /api/v1/config-revisions/:revisionId
POST /api/v1/config-revisions/:revisionId/publish
POST /api/v1/environments/:environmentId/rollout
POST /api/v1/environments/:environmentId/rollback
GET  /api/v1/environments/:environmentId/releases?limit&cursor
GET  /api/v1/client-config?tenantId&applicationKey&environmentKey&clientId&knownGeneration
POST /api/v1/client-observations
GET  /api/v1/audit?tenantId&limit&cursor
GET  /api/v1/verification-snapshot
```

Serve `GET /openapi.json` with OpenAPI 3.1 and `GET /healthz`. JSON errors use
`{"error":{"code":"STABLE_CODE","message":"...","details":{}}}`. Exhaustive well-formed semantic errors:

```text
400 INVALID_CONFIG  400 INVALID_ROLLOUT  400 INVALID_REQUEST  400 MALFORMED_JSON
409 REVISION_PARENT_CHANGED  409 REVISION_IMMUTABLE  409 ENVIRONMENT_GENERATION_CHANGED
409 RELEASE_NOT_ACTIVE  409 ROLLBACK_TARGET_INVALID  409 IDEMPOTENCY_CONFLICT  404 NOT_FOUND
```

Collections use `{items,nextCursor}` and stable opaque cursors.

## Seed, Work, events, and snapshot

Seed shape is exactly:

```json
{"schemaVersion":1,"seedVersion":"...","tenants":[],"applications":[],"environments":[],"configRevisions":[],"releases":[],"clientObservations":[],"invalidations":[],"auditEntries":[]}
```

Import is atomic; exact version+digest replay is a no-op; different content is `SEED_VERSION_CONFLICT`; unknown
members and invalid references reject everything. V1 Work kinds are `DRAFT_EXPIRY`, `RELEASE_ACTIVATE`,
`CACHE_INVALIDATE`, and `EVENT_DELIVERY`. Work uses the public leased shape and fenced final commit. Required events
include `revision.created`, `revision.published`, `release.activated`, `release.rollout_changed`, and
`release.rolled_back`.

The authenticated point-in-time snapshot exposes complete sorted `tenants`, `applications`, `environments`,
`configRevisions`, `releases`, `clientObservations`, `invalidations`, and `auditEntries`, plus ordered events and Work.
It excludes credentials, environment variables, private paths, and internal cache contents.

## UI and project-owned tests

The React production UI must browse applications/environments/history, edit a full draft document, review a diff,
publish with a rollout, change rollout, rollback, inspect deterministic client resolution, and display generation and
invalidation state. It must use only the public API.

Unit covers canonical JSON and assignment. Integration uses real PostgreSQL and HTTP. Chromium drives the production
UI. Concurrency starts two API and two Worker processes. Recovery kills a claimed worker and dispatcher at barriers.
`test:all` runs all non-performance gates; `test:perf` runs the three fixed scenarios and post-load invariants.

## Published performance gates

Formal scoring uses fixed Linux arm64 and `BENCH_PERF_SCALE=1`; scaled runs are smoke only.

1. `client-fetch-mix`: 50,000 registered clients and 80% current ETag / 20% stale generation traffic for 60 seconds,
   128 clients; >= 800 request/s, p95 <= 150ms, zero wrong 304 and zero unexpected 5xx.
2. `rollout-rollback-contention`: 10,000 rollout/rollback attempts across two APIs and 100 environments, 64 clients;
   >= 100 mutation/s, p95 <= 500ms, exactly one release per accepted generation and deterministic assignment.
3. `invalidation-recovery`: 100,000 invalidations; kill two claimed workers at observable barriers, wait for lease
   expiry, and recover with four workers in <= 90 seconds; all environments converge within 5 seconds with no stale re-enable.

After each load, verify one active release per environment, monotonic generations, immutable digests, deterministic
assignment, continuous audit/event order, tenant isolation, and Work drain.

## Out of scope

Secrets, binary assets, dynamic code execution, experiment analytics, service discovery, application deployment,
cross-tenant sharing, and client-specific overrides outside deterministic rollout are out of scope.

## Successful response contracts

Successful response contracts are closed:

- A mutation route without a literally stated success status returns 200.
- Unless a route literally publishes another object, array, or empty body, a success described by a named resource, named resource state, or named resource fields returns that exact resource shape at the JSON top level. Any response-only fields literally named by the route are additional top-level fields.
- If a mutation publishes no success body, it returns the exact current shape of the single primary resource created or changed by that route at the JSON top level.
- When a route explicitly returns multiple named resources, the body is one object keyed by their lower-camel resource names unless the route publishes another literal shape.
- Wrappers such as `{data:...}`, `{result:...}`, or an extra single-resource envelope are invalid unless the route literally declares them. OpenAPI must publish the same success status and closed response schema as runtime.
