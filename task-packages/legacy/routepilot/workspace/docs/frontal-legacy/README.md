# RoutePilot

Build a production-style, tenant-isolated API gateway control plane and data plane from this intentionally blank repository. The result must be a real TypeScript/Node.js 22 application with PostgreSQL 16, a React operations UI, background workers, and an outbox dispatcher. In-memory state, SQLite, mocks, and fake test commands are not acceptable authorities.

## Required commands

All commands are non-interactive and use exit status for success:

```text
npm run build
npm run db:migrate
npm run db:seed -- --file <absolute-json-path>
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

`start:api` serves the API, OpenAPI, health endpoint, and production UI. Worker and dispatcher are separate long-running processes. Graceful `SIGTERM` must stop every role.

## Environment

| Variable | Required behavior |
| --- | --- |
| `DATABASE_URL` | PostgreSQL authority; no fallback |
| `PORT` | API port, default `3000` |
| `ADMIN_TOKEN` | Bearer token for verification snapshot only |
| `WEBHOOK_URL` | Dispatcher target |
| `UPSTREAM_TIMEOUT_MS` | Per-attempt timeout, default `1000`, range 50..30000 |
| `WORK_LEASE_SECONDS` | Worker lease, default `3`, range 1..300 |
| `TEST_BARRIER_URL`, `TEST_BARRIER_TOKEN` | Optional controlled crash barrier; empty disables it |

Never return or log secrets, authorization/cookie headers, internal origin URLs, `DATABASE_URL`, private paths, or admin tokens.

## Domain model and invariants

Every public resource is tenant-scoped and has a UUID. Timestamps are UTC RFC3339.

- `Tenant {tenantId,name}`.
- `Backend {backendId,tenantId,name,origin,state:ACTIVE|DISABLED}`. `origin` is accepted by admin APIs but redacted to `originRedacted` in ordinary query, event, UI, and snapshot surfaces.
- `RouteDefinition {routeId,tenantId,name,priority}` owns immutable `RouteRevision`s.
- `RouteRevision {routeRevisionId,routeId,revision,pathPattern,methods,headerMatches,backends,rateLimitPolicyId,circuitPolicyId,createdAt}`. Backends contain `{backendId,version,weight}`; weights are positive integers summing to 10000.
- `RateLimitPolicy {rateLimitPolicyId,tenantId,revision,windowSeconds,limit}`.
- `CircuitPolicy {circuitPolicyId,tenantId,revision,sampleSize,failureThresholdPercent,openSeconds,halfOpenMax}`.
- `ConfigRelease {configReleaseId,tenantId,version,state:PENDING|ACTIVE|SUPERSEDED|ROLLED_BACK,routeRevisionIds,priorReleaseId,createdAt,activatedAt}`.
- `GatewayRequest {gatewayRequestId,tenantId,requestKey,configReleaseId,routeRevisionId,backendId,backendVersion,bucket,status:SUCCEEDED|REJECTED|FAILED,responseStatus,createdAt}`.
- `UpstreamAttempt {gatewayRequestId,attempt,backendId,requestIdentity,outcome:SUCCEEDED|FAILED|TIMEOUT,startedAt,finishedAt}`.
- `RateWindow {tenantId,rateLimitPolicyId,windowStart,consumed}` and `CircuitWindow {tenantId,backendId,epoch,state:CLOSED|OPEN|HALF_OPEN,sampleCount,failureCount,openUntil}` are shared database authorities.

Invariants:

1. A Tenant has at most one ACTIVE ConfigRelease. Activation atomically supersedes the previous release; a request observes exactly one complete release.
2. Route selection compares priority descending, then specificity descending, then routeId ascending. Equal priority and specificity for overlapping method/path/header matches is rejected at release creation as `AMBIGUOUS_ROUTE`.
3. Path patterns contain literal segments, `:parameter`, and one terminal `*`; literal beats parameter, parameter beats wildcard. Matching uses the normalized URL path only. Encoded slash, invalid percent encoding, dot traversal, and repeated slash are rejected.
4. Canary selection is `uint32(first 8 hex chars of SHA-256(tenantId + "\n" + routeRevisionId + "\n" + affinityKey)) mod 10000`. The same inputs always select the same weighted interval and version across processes and restarts. `x-route-affinity`, then authenticated subject, then request key supplies affinity.
5. RateWindow consumption is atomic across API processes. An accepted request consumes exactly one token; rejected/invalid requests and retries of the same request key do not consume another token. Over limit returns `429 RATE_LIMITED` with `Retry-After`.
6. Circuit samples and transitions are atomic. Only upstream 5xx, connection reset, and timeout count as failures. OPEN performs no upstream call. HALF_OPEN admits at most `halfOpenMax` probes globally; one failed probe reopens and a full successful probe set closes.
7. A gateway request has one stable `requestIdentity` per backend attempt. Retrying an unknown client response with the same request key returns the committed response and never causes another logical upstream call.
8. Config release, Work, and Domain Event commit together. A failed mutation creates none. Worker lease expiry permits recovery, but a fenced lease cannot activate stale configuration.
9. Rollback creates a new monotonic ConfigRelease version that copies the chosen prior revision set; history is immutable and request audit continues to reference the original release.

## HTTP and OpenAPI

Serve OpenAPI 3.1 at `GET /openapi.json`, health at `GET /healthz`, and JSON under `/api/v1`:

```text
GET/POST /api/v1/tenants
GET/POST /api/v1/backends
GET/POST /api/v1/route-definitions
GET/POST /api/v1/route-revisions
GET/POST /api/v1/rate-limit-policies
GET/POST /api/v1/circuit-policies
GET/POST /api/v1/config-releases
GET      /api/v1/config-releases/:configReleaseId
POST     /api/v1/config-releases/:configReleaseId/rollback
POST     /api/v1/gateway/dispatch
GET      /api/v1/gateway-requests/:gatewayRequestId
GET      /api/v1/verification-snapshot
```

`POST /api/v1/config-releases` accepts `{tenantId,version,routeRevisionIds,expectedActiveVersion}` and returns one stable ConfigRelease. `rollback` accepts `{expectedActiveVersion}`. `POST /api/v1/gateway/dispatch` accepts `{tenantId,method,path,headers,body,requestKey}` and synchronously returns `{gatewayRequestId,routeRevisionId,backendVersion,status,responseStatus,responseHeaders,body}`. It must call the selected local HTTP upstream using the original method/path/body, stripping hop-by-hop and private headers.

Every mutating endpoint requires `Idempotency-Key` (1..128 visible ASCII). Replay with the same canonical request returns the original status and JSON byte semantics across concurrent calls and restarts; different canonical input returns `409 IDEMPOTENCY_CONFLICT`. JSON uses strict content type, rejects unknown fields, duplicate object keys, malformed JSON, unsafe integers, invalid UUID/timestamp/URL, and bodies over 1 MiB. Collections return `{items,nextCursor}` with opaque stable snapshot cursors.

Exhaustive semantic errors for well-formed requests:

```text
400 INVALID_REQUEST
400 MALFORMED_JSON
400 AMBIGUOUS_ROUTE
400 INVALID_ROUTE_PATTERN
400 INVALID_WEIGHT
400 INVALID_POLICY
404 NO_ACTIVE_RELEASE
404 ROUTE_NOT_FOUND
409 IDEMPOTENCY_CONFLICT
409 VERSION_CONFLICT
409 RELEASE_NOT_READY
409 TERMINAL_STATE
429 RATE_LIMITED
503 CIRCUIT_OPEN
504 UPSTREAM_TIMEOUT
```

Durable Work has exact shape `{workId,kind:CONFIG_ACTIVATE|CIRCUIT_RECONCILE,aggregateId,state:PENDING|LEASED|SUCCEEDED|FAILED|CANCELLED,terminal,attempt,leaseOwner,leaseExpiresAt}`. Required event types are `config.release.created`, `config.release.activated`, `config.release.rolled_back`, `gateway.request.completed`, `gateway.request.rejected`, and `circuit.changed`. Events are contiguous per aggregate and dispatched at least once with stable event ID, canonical body, and `X-RoutePilot-Event-Id`.

## Seed and snapshot

The seed is exactly:

```json
{"schemaVersion":1,"seedVersion":"...","importedAt":"...","tenants":[],"backends":[],"routeDefinitions":[],"routeRevisions":[],"rateLimitPolicies":[],"circuitPolicies":[],"configReleases":[],"gatewayRequests":[],"upstreamAttempts":[],"rateWindows":[],"circuitWindows":[]}
```

Import is all-or-nothing. Exact seed version and digest replay is a no-op; the same version with different content fails `SEED_VERSION_CONFLICT`. References, revision uniqueness, release completeness, route ambiguity, weights, policies, states, and timestamps are validated before any write.

`GET /api/v1/verification-snapshot` requires `Authorization: Bearer $ADMIN_TOKEN` and returns `{schemaVersion:1,asOf,resources,work,events}` from one database snapshot. V1 `resources` contains exactly `tenants`, `backends`, `routeDefinitions`, `routeRevisions`, `rateLimitPolicies`, `circuitPolicies`, `configReleases`, `gatewayRequests`, `upstreamAttempts`, `rateWindows`, and `circuitWindows`, each complete and sorted by its documented identity. Secrets and unredacted origins are forbidden.

## Production UI

The production React UI must use the HTTP API and visibly support tenant selection, backend health, ordered route/revision inspection, release creation/activation/rollback, live gateway request decisions, rate-window consumption, circuit state/history, and event/work status. It must show loading, empty, validation, conflict, rate-limit, circuit-open, upstream failure, and retry states. No internal service import or mock data.

## Project-owned verification

- Unit: pattern normalization/specificity, stable canary buckets, state machines, canonicalization.
- Integration: real PostgreSQL/HTTP, atomic seed/release/rollback, strict validation, rate/circuit conservation.
- Browser E2E: production build in real Chromium through real APIs.
- Concurrency: two API processes and four workers share rate windows, circuits, releases, and idempotency.
- Recovery: barrier at `worker.claimed` and `dispatcher.response-received`, real `SIGKILL`, lease expiry, replacement process.
- Performance: actual sustained load and post-load invariant recomputation.
- `test:all`: all non-performance gates.

## Fixed performance contract

Formal scoring uses Linux arm64, 4 vCPU, 8 GiB RAM, PostgreSQL 16, Node 22, production build, two APIs and four workers. Each scenario executes its complete published operation count; recovery deadlines are 60 seconds. `test:perf` must emit machine-readable p50/p95/p99, throughput, status counts, RSS, recovery time, and invariant results.

1. `route-match-steady`: 250 immutable routes and 20 weighted versions, 64 concurrent clients, 100,000 dispatches; >= 700 request/s, p95 <= 180ms, unexpected 5xx=0, every decision matches the frozen route/release and deterministic bucket.
2. `hot-tenant-limit`: two APIs race 50,000 requests against fixed 1,000-token windows; >= 500 request/s, p95 <= 250ms, every window consumes exactly min(eligible,1000), no double consumption, and rejected requests make no upstream call.
3. `breaker-reload-recovery`: 20,000 mixed upstream results while 100 atomic releases/rollbacks occur; after two workers are killed at `worker.claimed`, four replacements activate all eligible work within 60 seconds, no partial release, no excess HALF_OPEN probes, and all events/work drain.

After every scenario, recompute route choice, canary distribution identity, rate/circuit conservation, active release uniqueness, request/attempt uniqueness, event sequence, work terminality, and tenant isolation. Any invariant failure fails the scenario even if latency passes.

## Out of scope

TLS termination, certificate issuance, service discovery, arbitrary scripts/plugins, WebSocket proxying, request-body transformation, OAuth identity provider implementation, billing, multi-region consensus, and external cloud gateway APIs.

## Handoff

Deliver buildable source, migrations, OpenAPI, production UI, all commands, and a findings-first final review. Report exact commands/results, measured metrics, residual risks, and every check not run; never claim a gate passed without running it.

## Successful response contracts

Successful response contracts are closed:

- A mutation route without a literally stated success status returns 200.
- Unless a route literally publishes another object, array, or empty body, a success described by a named resource, named resource state, or named resource fields returns that exact resource shape at the JSON top level. Any response-only fields literally named by the route are additional top-level fields.
- If a mutation publishes no success body, it returns the exact current shape of the single primary resource created or changed by that route at the JSON top level.
- When a route explicitly returns multiple named resources, the body is one object keyed by their lower-camel resource names unless the route publishes another literal shape.
- Wrappers such as `{data:...}`, `{result:...}`, or an extra single-resource envelope are invalid unless the route literally declares them. OpenAPI must publish the same success status and closed response schema as runtime.
