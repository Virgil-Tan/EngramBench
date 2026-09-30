# NotifyRoute — Complete system requirements

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

# NotifyRoute

Build NotifyRoute from this intentionally blank repository. This README is the complete public product
contract. Ask before making a product choice that the contract does not settle.

## Required stack and commands

- Node.js 22, TypeScript, React, PostgreSQL 16, npm, and the preinstalled Chromium.
- PostgreSQL is the sole authority for routing, preferences, rate limits, idempotency, leases, provider
  receipts, Domain Events, and ordering. Local Email/SMS provider doubles and Webhook receivers are the
  only external boundaries.
- The production UI must use the public HTTP API; browser-only state is never authoritative.

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

Every command must be non-interactive, exit non-zero on failure, and clean up child processes.

## Domain

NotifyRoute is a tenant-scoped notification routing platform. It accepts a logical Notification, freezes
its content and route inputs, selects Email, SMS, or Webhook Deliveries, enforces consent and rate limits,
recovers uncertain provider results, and exposes a real React operations UI.

The Email/SMS provider double can return `ACCEPTED`, `REJECTED`, `TIMEOUT`, or `CONNECTION_RESET`, followed
by delayed, duplicated, or reordered receipts. Webhook receivers can return any HTTP status, delay a
response, close a connection, or acknowledge a request whose response never reaches NotifyRoute. No real
Email or SMS service is used.

### Canonical objects

```text
Tenant, Recipient, ChannelEndpoint, Template, TemplateVersion, RoutePolicy,
RouteStep, RateLimitPolicy, Notification, Delivery, DeliveryAttempt,
Suppression, ProviderReceipt, OutboxEvent, Work
```

### State machines

```text
Notification: ACCEPTED -> ROUTING -> DELIVERING -> DELIVERED | PARTIALLY_DELIVERED | SUPPRESSED | FAILED | CANCELLED
Delivery:     PENDING -> RATE_LIMITED -> SENDING -> ACCEPTED -> DELIVERED | FAILED
                         |                 |            |
                         +-> SUPPRESSED    +-> UNKNOWN -+-> FAILED
                         +-> CANCELLED
ChannelEndpoint: ACTIVE -> UNSUBSCRIBED | DISABLED | BOUNCED
```

Only transitions supported by committed facts are allowed. A state transition, its business effect, Work,
and Domain Event are committed in one transaction.

### Exact public shapes

`uuid` is lowercase RFC 4122 text, `timestamp` is UTC ISO-8601 with millisecond precision and `Z`, and
`int` is a JSON safe integer.

```text
Recipient = {recipientId:uuid,tenantId:uuid,externalRef:string,locale:string,timeZone:string,preferenceRevision:int,createdAt:timestamp}
ChannelEndpoint = {endpointId:uuid,tenantId:uuid,recipientId:uuid,channel:EMAIL|SMS|WEBHOOK,address:string,state:ACTIVE|UNSUBSCRIBED|DISABLED|BOUNCED,revision:int,createdAt:timestamp,terminalAt:timestamp|null}
TemplateVersion = {templateVersionId:uuid,templateId:uuid,version:int,channel:EMAIL|SMS|WEBHOOK,subject:string|null,body:string,contentDigest:sha256,createdAt:timestamp}
RouteStep = {ordinal:int,channel:EMAIL|SMS|WEBHOOK,delaySeconds:int,maxAttempts:int,baseRetrySeconds:int}
RoutePolicy = {routePolicyId:uuid,tenantId:uuid,name:string,revision:int,steps:[RouteStep],createdAt:timestamp}
RateLimitPolicy = {rateLimitPolicyId:uuid,tenantId:uuid,channel:EMAIL|SMS|WEBHOOK,revision:int,windowSeconds:int,tenantLimit:int,recipientLimit:int|null,effectiveFrom:timestamp}
Notification = {notificationId:uuid,tenantId:uuid,recipientId:uuid,category:string,dedupeKey:string,templateVersionId:uuid,routePolicyId:uuid,routePolicyRevision:int,state:ACCEPTED|ROUTING|DELIVERING|DELIVERED|PARTIALLY_DELIVERED|SUPPRESSED|FAILED|CANCELLED,data:object,acceptedAt:timestamp,terminalAt:timestamp|null,sequence:int}
Delivery = {deliveryId:uuid,notificationId:uuid,endpointId:uuid,channel:EMAIL|SMS|WEBHOOK,routeOrdinal:int,state:PENDING|RATE_LIMITED|SENDING|ACCEPTED|DELIVERED|FAILED|UNKNOWN|SUPPRESSED|CANCELLED,attemptCount:int,providerMessageId:string|null,suppressionRevision:int,nextAttemptAt:timestamp|null,createdAt:timestamp,terminalAt:timestamp|null,sequence:int}
DeliveryAttempt = {attemptId:uuid,deliveryId:uuid,attemptNumber:int,providerRequestId:string,outcome:ACCEPTED|REJECTED|TIMEOUT|CONNECTION_RESET|HTTP_ERROR,startedAt:timestamp,finishedAt:timestamp|null}
Suppression = {suppressionId:uuid,tenantId:uuid,recipientId:uuid,channel:EMAIL|SMS|WEBHOOK|ALL,category:string|null,state:ACTIVE|RELEASED,revision:int,reason:string,createdAt:timestamp,releasedAt:timestamp|null}
ProviderReceipt = {providerReceiptId:uuid,channel:EMAIL|SMS|WEBHOOK,providerEventId:string,providerMessageId:string,deliveryId:uuid,outcome:DELIVERED|BOUNCED|COMPLAINED|FAILED,occurredAt:timestamp,receivedAt:timestamp}
```

`sha256` is 64 lowercase hexadecimal characters. Contact addresses are normalized: Email domain is
lowercase, SMS uses E.164, and Webhook is an absolute `http` or `https` URL. The snapshot may expose the
normalized address but never endpoint credentials, authorization headers, or signing secrets.

## Routing and content contract

1. A Notification freezes the exact TemplateVersion, request data, RoutePolicy revision, and ordered route
   steps when accepted. Later edits affect only later Notifications.
2. Rendering is deterministic and strict: missing or unknown variables reject the complete Notification
   before Work or Events are created. Rendered output is immutable after acceptance.
3. Each route step may create at most one Delivery for its endpoint. A channel fallback becomes eligible
   only after the earlier step is terminally failed or suppressed; retries are not fallback.
4. Success of a configured terminal step ends further fallback. Late receipts cannot resurrect or duplicate
   a superseded route.
5. The same `(tenantId, recipientId, dedupeKey)` identifies one logical Notification. A different canonical
   payload with the same key is `DEDUPE_CONFLICT`.

## Consent and unsubscribe contract

1. `POST /api/v1/recipients/:recipientId/unsubscribe` creates a monotonic Suppression revision for one
   channel, one category, or all delivery. Exact replay is stable.
2. Every Worker must re-read the current Suppression revision after claiming Work and immediately before an
   external call. A stale lease or cached preference cannot bypass a newer unsubscribe.
3. Unsubscribe wins over an unsent Delivery. A Provider-accepted Delivery records reality and is not
   rewritten as unsent, but no fallback or retry may start after the suppression fence.
4. Resubscribe requires an explicit `consentReference`, releases only the named scope, advances revision,
   and never revives old terminal Deliveries.
5. Bounce or complaint receipts disable the applicable endpoint. A complaint also creates an ALL-category
   channel Suppression before later Work can send.

## Rate limits

1. A RateLimitPolicy defines fixed UTC epoch-aligned windows for a tenant and channel, and optionally a
   stricter recipient and channel limit. Limits are positive safe integers.
2. Capacity is acquired atomically immediately before the external call. All API and Worker processes share
   the same PostgreSQL counters.
3. Retries of the same logical Delivery do not consume an additional logical-notification quota, but each
   real provider call consumes an attempt quota. UNKNOWN reconciliation without a send consumes neither.
4. Exhausted Work becomes `RATE_LIMITED` with the exact next window boundary in `nextAttemptAt`; busy loops,
   early release, and silent drops are forbidden.
5. Window rollover cannot exceed either bound, double-spend capacity, or strand eligible Work.

## Provider uncertainty and duplicate protection

1. Every mutation requires a durable `Idempotency-Key` scoped by method and canonical path.
2. Every Delivery owns one stable `providerRequestId`; every retry of an uncertain external request reuses
   that identity and canonical body. Provider message identity is globally unique per channel.
3. Timeout or connection reset after a possible send sets Delivery to `UNKNOWN`. The system must reconcile
   it and must not create a new provider send until the prior result is known.
4. Provider receipt and active reconcile commute. Duplicated, delayed, reordered, and cross-process receipt
   handling must converge to one semantic result and one event transition.
5. A Webhook send includes stable `Idempotency-Key` and `X-NotifyRoute-Delivery-Id` headers plus an HMAC-SHA256
   signature derived from the configured secret. Retries use the identical canonical body and logical ID.
6. Retry schedules are bounded by the frozen RouteStep. Exhaustion becomes FAILED and may activate only the
   next frozen route step.

## Public HTTP surface

```text
POST /api/v1/tenants
POST /api/v1/recipients
POST /api/v1/channel-endpoints
POST /api/v1/templates
POST /api/v1/template-versions
POST /api/v1/route-policies
POST /api/v1/rate-limit-policies
POST /api/v1/notifications
GET  /api/v1/notifications/:notificationId
POST /api/v1/notifications/:notificationId/cancel
POST /api/v1/recipients/:recipientId/unsubscribe
POST /api/v1/recipients/:recipientId/resubscribe
POST /api/v1/provider/receipts
POST /api/v1/deliveries/:deliveryId/reconcile
GET  /api/v1/verification-snapshot
```

Serve `GET /openapi.json` and `GET /healthz`. JSON errors use
`{"error":{"code":"STABLE_CODE","message":"...","details":{}}}`. Reject unknown fields and unsupported
media types. Collections use `{items,nextCursor}` with stable opaque cursors.

Published semantic errors are exhaustive for well-formed requests:

```text
409 IDEMPOTENCY_CONFLICT
409 DEDUPE_CONFLICT
409 PROVIDER_MESSAGE_CONFLICT
409 DELIVERY_RESULT_UNKNOWN
409 TERMINAL_STATE
409 CONSENT_REVISION_CONFLICT
400 TEMPLATE_RENDER_INVALID
400 ROUTE_POLICY_INVALID
400 RATE_LIMIT_INVALID
400 INVALID_REQUEST
```

Durable Work has exact shape
`{workId:uuid,kind:NOTIFICATION_ROUTE|DELIVERY_SEND|DELIVERY_RECONCILE,aggregateId:uuid,state:PENDING|LEASED|SUCCEEDED|FAILED|CANCELLED,terminal:boolean,attempt:int,leaseOwner:string|null,leaseExpiresAt:timestamp|null}`.
Workers use bounded leases and fence the final commit. Required event types are `notification.accepted`,
`notification.terminal`, `delivery.suppressed`, `delivery.accepted`, `delivery.delivered`, `delivery.failed`,
`delivery.unknown`, and `recipient.unsubscribed`. Events are contiguous per aggregate and dispatch at least
once with stable identity and canonical body.

## Seed and snapshot

The seed is exactly:

```json
{"schemaVersion":1,"seedVersion":"...","importedAt":"...","tenants":[],"recipients":[],"channelEndpoints":[],"templates":[],"templateVersions":[],"routePolicies":[],"rateLimitPolicies":[],"notifications":[],"deliveries":[],"deliveryAttempts":[],"suppressions":[],"providerReceipts":[]}
```

Import is atomic. Replaying the same version and digest is a no-op; the same version with a different digest
returns `SEED_VERSION_CONFLICT`. The verification snapshot is point-in-time and exposes resources, durable
Work, and Domain Events without credentials, signing secrets, authorization headers, raw provider bodies,
or private paths. V1 `resources` contains exactly `tenants`, `recipients`, `channelEndpoints`, `templates`,
`templateVersions`, `routePolicies`, `rateLimitPolicies`, `notifications`, `deliveries`, `deliveryAttempts`,
`suppressions`, and `providerReceipts`; each array is complete and sorted by its declared public identity.

## Out of scope

Real Email/SMS vendors, mailbox rendering compatibility, inbound replies, marketing audience analytics,
RBAC/ABAC, contact discovery, arbitrary user-supplied code in templates, and cross-tenant routing.

## Successful response contracts

Successful response contracts are closed:

- A mutation route without a literally stated success status returns 200.
- Unless a route literally publishes another object, array, or empty body, a success described by a named resource, named resource state, or named resource fields returns that exact resource shape at the JSON top level. Any response-only fields literally named by the route are additional top-level fields.
- If a mutation publishes no success body, it returns the exact current shape of the single primary resource created or changed by that route at the JSON top level.
- When a route explicitly returns multiple named resources, the body is one object keyed by their lower-camel resource names unless the route publishes another literal shape.
- Wrappers such as `{data:...}`, `{result:...}`, or an extra single-resource envelope are invalid unless the route literally declares them. OpenAPI must publish the same success status and closed response schema as runtime.

## Additional product requirements — required in the same final system

新增冻结受众的 Broadcast Campaign。
创建时冻结去重后的 recipientIds、TemplateVersion、RoutePolicy revision 和 Suppression revision；
状态为 QUEUED、RUNNING、PAUSED、COMPLETED、CANCELLED；
每个 Campaign+Recipient 最多创建一个 Notification；
pause 阻止新 fan-out，resume 只继续剩余受众，cancel durable fence 必须阻止旧 lease 继续创建或发送，但不能伪装撤回 Provider 已接受的 Delivery。
新增 Campaign、CampaignRecipient、CAMPAIGN_FANOUT Work；
并发 pause/resume/cancel、Worker 崩溃必须保持 V1 身份、Event、Work 与 replay。

