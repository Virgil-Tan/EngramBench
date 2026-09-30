# LaunchPass

Build a production-style full-stack application for reserving limited-capacity event places.
Start from this empty repository and deliver the complete application, database migrations,
documentation, and automated tests.

This README is the authoritative public product contract. If a later user message introduces an
approved requirement change, update this README and `openapi.yaml` as part of that change.

## 1. Required stack and runtime

- Node.js 22
- TypeScript for application and test code
- React for the browser application
- PostgreSQL 16 as the durable business-state authority
- Chromium for browser end-to-end tests

You may choose the Node.js web framework, database library, migration tool, React build tool, and
test libraries. The running application must not require Redis, a message broker, a hosted service,
or any network service other than the provided PostgreSQL database.

The application must serve the built browser UI and `/api/*` routes from the same `PORT`.

## 2. Required commands

Create `package.json` scripts for all of these commands:

```sh
npm run db:migrate
npm run seed -- --file /absolute/path/to/seed.v1.json
npm run dev
npm run build
npm start
npm run test:unit
npm run test:integration
npm run test:e2e
npm run test:concurrency
npm run test:all
npm run test:perf
```

`npm test` must be an alias for `npm run test:all`. `test:all` must run unit, integration, browser
E2E, and concurrency tests. Performance tests remain a separate command.

All commands must be non-interactive and communicate success or failure with their exit status.
Commit an npm `package-lock.json`; a clean checkout must install successfully with `npm ci`.

## 3. Environment variables

| Name | Required | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection used by the application and migrations |
| `TEST_DATABASE_URL` | for tests | Isolated PostgreSQL connection used by integration and E2E tests |
| `PORT` | no | HTTP port; defaults to `3000` |
| `ADMIN_TOKEN` | yes | Bearer token accepted by administrator endpoints |
| `HOLD_TTL_SECONDS` | no | Lifetime of a pending hold; integer `1..3600`, defaults to `120` |

Fail startup with an actionable error when a required value is absent or invalid. Do not print
credentials or full database URLs in logs or error messages.

## 4. Product behavior

### 4.1 Events

An administrator can create an event with a unique slug, title, start time, and fixed capacity.
Customers can browse, search, and cursor-page through events. Event responses include the current
available capacity.

Creating an event requires `Authorization: Bearer <ADMIN_TOKEN>`.

### 4.2 Holds

A customer can place a temporary hold for 1 to 4 places on one event. Creating a hold succeeds only
when all requested places are available. A failed request must not consume any capacity.

A hold begins in `PENDING` and has an `expiresAt` timestamp. It can reach exactly one terminal state:

- `CONFIRMED`: the customer confirms it and an order is created;
- `RELEASED`: the customer explicitly releases it;
- `EXPIRED`: its deadline passes before confirmation or release.

Confirming a pending hold consumes its reserved capacity permanently and creates exactly one order.
Releasing or expiring a pending hold returns its capacity exactly once. Confirmation, release, and
expiration may happen concurrently, but only one transition may win.

Expired holds must become observable and release capacity within two seconds after `expiresAt`, even
when there is no incoming traffic. Restarting the application must not lose pending holds or prevent
their later expiration.

### 4.3 Customer history

A customer can query their holds and confirmed orders using cursor pagination. Refreshing the page or
restarting an application instance must not lose history.

### 4.4 Multiple application instances

A deployment may start two application processes on different ports with the same `DATABASE_URL`.
All invariants must remain correct across both processes. In-process state may be used as a cache or
optimization, but it cannot be the authority for capacity, idempotency, expiration, holds, or orders.

## 5. Business invariants

These invariants always apply:

1. Available capacity is never negative and never greater than event capacity.
2. The sum of pending hold quantities and confirmed order quantities never exceeds event capacity.
3. A failed hold request changes no capacity and creates no partial business record.
4. A hold has at most one terminal transition.
5. A hold creates at most one order.
6. Release and expiration restore capacity at most once.
7. An idempotent retry never repeats a business side effect.
8. Committed state survives process restart and is shared by all application instances.

## 6. HTTP and OpenAPI contract

Create an OpenAPI 3.1 document at `/workspace/openapi.yaml`. It must describe every public endpoint,
request, response, header, error code, and schema implemented by the application. README examples,
OpenAPI, and actual behavior must agree.

### 6.1 Common input rules

- Request bodies use UTF-8 `application/json`.
- A body with an unsupported content type returns HTTP `415` and `UNSUPPORTED_MEDIA_TYPE`.
- Malformed JSON returns HTTP `400` and `INVALID_JSON`.
- Schema-invalid JSON returns HTTP `422` and `VALIDATION_ERROR`.
- Mutation request schemas reject unknown properties.
- IDs are UUID strings.
- Input timestamps are RFC 3339 timestamps with an explicit timezone.
- Output timestamps are RFC 3339 in UTC.
- Strings must not be blank after trimming and must not be silently truncated.
- Pagination uses `limit` and an opaque `cursor`; `limit` defaults to `20` and must be `1..100`.
- A malformed or stale cursor returns HTTP `400` and `INVALID_CURSOR`.

All errors use this envelope:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "A concise human-readable message",
    "details": []
  }
}
```

`details` may be empty. Validation details must not expose stack traces, SQL, credentials, absolute
paths, or internal implementation data.

### 6.2 Idempotency

Every write endpoint requires an `Idempotency-Key` header containing 8 to 128 printable ASCII
characters.

The key is scoped to the concrete operation and resource. Repeating the same operation with the same
key and semantically identical input must replay the original status and response without repeating
side effects. Reusing the same scoped key with different input returns HTTP `409` and
`IDEMPOTENCY_CONFLICT`.

Idempotency records must work across application instances and process restarts.

### 6.3 Event endpoints

```text
GET  /api/health
POST /api/admin/events
GET  /api/events
GET  /api/events/{eventId}
```

`GET /api/health` returns HTTP `200` and `{"status":"ok"}` only when the process can serve
requests and reach its database.

Create-event request:

```json
{
  "slug": "summer-launch",
  "title": "Summer Launch",
  "startsAt": "2027-06-01T09:00:00Z",
  "capacity": 100
}
```

Rules:

- `slug`: lowercase letters, digits, and single hyphens; length `3..64`; globally unique.
- `title`: non-blank string; length `1..120` after trimming.
- `startsAt`: valid RFC 3339 timestamp with timezone.
- `capacity`: integer `1..1000000`.

A successful create returns HTTP `201`:

```json
{
  "event": {
    "id": "2fd846d8-2652-4bd2-97e7-37a863d305b6",
    "slug": "summer-launch",
    "title": "Summer Launch",
    "startsAt": "2027-06-01T09:00:00.000Z",
    "capacity": 100,
    "availableCapacity": 100,
    "createdAt": "2026-08-05T08:00:00.000Z"
  }
}
```

`GET /api/events` accepts `q`, `limit`, and `cursor`. Search is case-insensitive against title and
slug. Results are ordered by `startsAt` ascending and then `id` ascending. List responses use:

```json
{
  "items": [],
  "nextCursor": null
}
```

The same shape is used by all paginated endpoints.

### 6.4 Hold and order endpoints

```text
POST   /api/holds
GET    /api/holds/{holdId}
POST   /api/holds/{holdId}/confirm
DELETE /api/holds/{holdId}
GET    /api/customers/{customerId}/holds
GET    /api/customers/{customerId}/orders
```

Customer hold history is ordered by `createdAt` descending and then `id` descending. Order history
is ordered by `confirmedAt` descending and then `id` descending.

Create-hold request:

```json
{
  "eventId": "2fd846d8-2652-4bd2-97e7-37a863d305b6",
  "customerId": "2e990641-6a51-4c85-86d9-cd92d86cd935",
  "quantity": 2
}
```

`quantity` must be an integer from 1 through 4. A successful create returns HTTP `201`:

```json
{
  "hold": {
    "id": "6ddd129f-1155-45b2-b535-68b5c00baa84",
    "eventId": "2fd846d8-2652-4bd2-97e7-37a863d305b6",
    "customerId": "2e990641-6a51-4c85-86d9-cd92d86cd935",
    "quantity": 2,
    "status": "PENDING",
    "expiresAt": "2026-08-05T08:02:00.000Z",
    "createdAt": "2026-08-05T08:00:00.000Z"
  }
}
```

Insufficient capacity returns HTTP `409` and `INSUFFICIENT_CAPACITY` without any partial change.

`POST /api/holds/{holdId}/confirm` has no request body. Confirming a pending hold returns HTTP `200`
with both the final hold and its order. Confirming an already confirmed hold returns the same logical
order. Confirming a released or expired hold returns HTTP `409` and `HOLD_NOT_CONFIRMABLE`.

`DELETE /api/holds/{holdId}` has no request body. Releasing a pending or already released hold returns
HTTP `200` with the final hold. Releasing a confirmed or expired hold returns HTTP `409` and
`HOLD_NOT_RELEASABLE`.

Order responses include `id`, `eventId`, `customerId`, `holdId`, `quantity`, and `confirmedAt`.
Orders created by confirming a hold use that hold's UUID. Historical orders imported by the seed
command use `holdId: null`, because the public seed schema intentionally does not contain holds.

An unknown event, hold, customer, or order resource returns HTTP `404` with a stable, specific error
code.

## 7. Seed-file contract

Implement:

```sh
npm run seed -- --file /absolute/path/to/seed.v1.json
```

The command imports an empty database using this versioned JSON shape:

```json
{
  "schemaVersion": 1,
  "events": [
    {
      "id": "2fd846d8-2652-4bd2-97e7-37a863d305b6",
      "slug": "summer-launch",
      "title": "Summer Launch",
      "startsAt": "2027-06-01T09:00:00Z",
      "capacity": 100
    }
  ],
  "customers": [
    {
      "id": "2e990641-6a51-4c85-86d9-cd92d86cd935",
      "displayName": "Test Customer"
    }
  ],
  "orders": [
    {
      "id": "275f5c6d-0568-4e5a-bea9-8b63a5944e91",
      "eventId": "2fd846d8-2652-4bd2-97e7-37a863d305b6",
      "customerId": "2e990641-6a51-4c85-86d9-cd92d86cd935",
      "quantity": 2,
      "confirmedAt": "2026-08-01T10:00:00Z"
    }
  ]
}
```

The importer must:

- reject unknown fields, duplicate IDs, duplicate slugs, invalid values, missing references, and
  total confirmed quantity above event capacity;
- validate the complete file before committing any business data;
- make no partial database change on failure;
- refuse to import into non-empty application tables;
- print one JSON summary line on success and a concise diagnostic to stderr on failure;
- handle at least 10000 events, 10000 customers, and 100000 historical orders.

Seeded historical orders have no corresponding hold record and are returned through order APIs with
`holdId: null`. Runtime confirmation still always creates an order with a non-null hold UUID.

The importer must support any data that conforms to this public schema, regardless of value or order.

## 8. Browser application

Provide these user-visible flows:

- an event list with search, cursor pagination, loading, empty, and error states;
- an event detail page showing capacity and an accessible quantity control;
- a way to enter or select a customer UUID for the current session;
- create-hold feedback with status and an expiry countdown;
- confirm and release actions with clear success, conflict, and retry feedback;
- customer hold history and order history;
- correct behavior after a full browser refresh;
- usable layouts at 390px and 1280px viewport widths;
- keyboard-operable controls, associated labels, visible focus, and meaningful status announcements.

Do not expose `ADMIN_TOKEN` in browser code. Test setup may create events through the administrator
API before opening the customer UI.

## 9. Automated tests owned by the project

### 9.1 Unit tests

Cover focused pure behavior such as validation and state-transition decisions. Unit tests alone are
not sufficient for completion.

### 9.2 Integration tests

`npm run test:integration` must use `TEST_DATABASE_URL`, real migrations, a real PostgreSQL database,
and a real HTTP server. Do not mock the database or call repository internals in place of HTTP.

At minimum, cover validation, idempotency, hold lifecycle, expiration, input atomicity, and restart
recovery.

### 9.3 Browser E2E tests

`npm run test:e2e` must build and start the production application, prepare isolated PostgreSQL data,
and drive Chromium through the real browser UI. It must cover:

1. browse events, open details, create a hold, confirm it, and observe the order;
2. create a hold, release it, and observe restored capacity;
3. create a short-lived hold, observe expiration, and observe restored capacity;
4. refresh during a pending hold and continue from durable server state.

### 9.4 Concurrency tests

`npm run test:concurrency` must send real HTTP requests to two application processes sharing one
database. At minimum, cover oversubscription, concurrent idempotent retries, and confirm/release/
expiration races. Assert final database-visible business invariants through public APIs.

### 9.5 Test isolation

Tests must prepare, migrate, seed, and clean their own isolated data. They must not depend on execution
order, the developer database, external network access, files outside this repository, or fixed
external IDs.

## 10. Performance target

The target environment has 4 vCPUs, 8 GiB RAM, local PostgreSQL 16, and two application instances.
Measure a production build after a 10-second warm-up.

- With 10000 events and 100000 historical orders, event search/list requests must have
  `p95 <= 250 ms`.
- With 100 concurrent clients contending for a hot event, hold and confirm requests must have
  `p95 <= 500 ms`.
- The mixed run must sustain at least 150 completed requests per second.
- Unexpected HTTP 5xx responses must be zero. Expected product conflicts such as sold-out responses
  are not counted as server errors.
- All business invariants must still hold after the load test.

`npm run test:perf` must report scenario size, duration, throughput, status counts, and p50/p95/p99
latency as machine-readable JSON plus a concise human-readable summary.

## 11. Delivery requirements

Before handoff:

- update this README with the final architecture and any approved requirement changes;
- keep `openapi.yaml` synchronized with behavior;
- run `npm run build`, `npm run test:all`, and `npm run test:perf`;
- remove debug-only routes, hard-coded fixtures, secrets, generated test output, and temporary files;
- report exact commands and results, plus any remaining risks or unmet requirements.

## 12. Out of scope

Do not add customer authentication, payment processing, email delivery, seat maps, third-party event
integrations, distributed tracing infrastructure, or unrelated administrator features. Build the
smallest system that fully satisfies this contract.

## Successful response contracts

Successful response contracts are closed:

- A mutation route without a literally stated success status returns 200.
- Unless a route literally publishes another object, array, or empty body, a success described by a named resource, named resource state, or named resource fields returns that exact resource shape at the JSON top level. Any response-only fields literally named by the route are additional top-level fields.
- If a mutation publishes no success body, it returns the exact current shape of the single primary resource created or changed by that route at the JSON top level.
- When a route explicitly returns multiple named resources, the body is one object keyed by their lower-camel resource names unless the route publishes another literal shape.
- Wrappers such as `{data:...}`, `{result:...}`, or an extra single-resource envelope are invalid unless the route literally declares them. OpenAPI must publish the same success status and closed response schema as runtime.
