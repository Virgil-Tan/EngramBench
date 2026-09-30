# ParcelFlow

Build a production-style full-stack application for allocating multi-item orders to warehouse
inventory and completing them through durable background fulfillment. Start from this empty
repository and deliver the complete application, database migrations, documentation, and automated
tests.

This README is the authoritative public product contract. If a later user message introduces an
approved requirement change, update this README and `openapi.yaml` as part of that change.

## 1. Required stack and runtime

- Node.js 22
- TypeScript for application and test code
- React for the browser application
- PostgreSQL 16 as the durable business-state authority
- Chromium for browser end-to-end tests

You may choose the Node.js web framework, database library, migration tool, React build tool, and
test libraries. The running system must not require Redis, a message broker, another database, a
hosted service, or external network access. The only runtime services are the provided PostgreSQL
database and the local HTTP webhook receiver configured by `WEBHOOK_URL`.

The API process must serve the built browser UI and `/api/*` routes from the same `PORT`. Workers and
the webhook dispatcher run as separate processes and share the same PostgreSQL database.

## 2. Required commands

Create `package.json` scripts for all of these commands:

```sh
npm run db:migrate
npm run seed -- --file /absolute/path/to/seed.v1.json
npm run dev
npm run build
npm start
npm run worker
npm run dispatcher
npm run test:unit
npm run test:integration
npm run test:e2e
npm run test:concurrency
npm run test:recovery
npm run test:all
npm run test:perf
```

`npm start` starts the production API and built UI only. `npm run worker` starts one fulfillment
worker, and `npm run dispatcher` starts one webhook dispatcher. Each long-running command must
handle `SIGTERM` without accepting new work and exit within ten seconds after finishing or safely
abandoning its current work.

`npm test` must be an alias for `npm run test:all`. `test:all` must run unit, integration, browser
E2E, concurrency, and recovery tests. Performance tests remain a separate command.

All commands must be non-interactive and communicate success or failure with their exit status.
Commit an npm `package-lock.json`; a clean checkout must install successfully with `npm ci`.

## 3. Environment variables

| Name | Required | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection used by API, workers, dispatcher, migrations, and seed import |
| `TEST_DATABASE_URL` | for tests | Isolated PostgreSQL connection used by all database-backed tests |
| `PORT` | no | API and UI HTTP port; defaults to `3000` |
| `ADMIN_TOKEN` | for API | Bearer token accepted by administrator mutation endpoints |
| `WEBHOOK_URL` | for dispatcher | Absolute URL of the provided local webhook receiver |
| `WORKER_POLL_INTERVAL_MS` | no | Idle worker polling interval, integer `10..10000`; defaults to `100` |
| `DISPATCH_TASK_TIMEOUT_SECONDS` | no | Time after which abandoned dispatch work is recoverable, integer `1..300`; defaults to `5` |
| `OUTBOX_POLL_INTERVAL_MS` | no | Idle dispatcher polling interval, integer `10..10000`; defaults to `100` |
| `WEBHOOK_TIMEOUT_MS` | no | Timeout for one webhook attempt, integer `100..30000`; defaults to `3000` |

Fail startup with an actionable error when a value required by that command is absent or invalid.
The API does not require `WEBHOOK_URL`; allocated events may remain pending while no dispatcher is
running. Do not print credentials, authorization values, or full database or webhook URLs in logs
or error messages.

## 4. Product behavior

### 4.1 Warehouse, SKU, and inventory catalog

An administrator can create warehouses and SKUs and set the current on-hand quantity for each
warehouse/SKU stock position. A missing stock position means that warehouse has zero stock for that
SKU. Customers and operators can browse, search, filter, and cursor-page through the catalog and
inventory without an administrator token.

Each warehouse has a unique code, a display name, and a priority. Lower numeric priority wins. Each
SKU has a unique code and display name. A stock position exposes:

- `onHand`: the current physical quantity;
- `reserved`: quantity committed to allocated orders but not yet shipped or cancelled;
- `available`: `onHand - reserved`.

Setting `onHand` below the current `reserved` quantity must fail without changing the stock
position.

### 4.2 Atomic single-warehouse order allocation

An order contains a customer reference and between 1 and 8 order lines. SKU IDs within one order
must be unique. Every line must be allocated in full; partial line allocation and partial order
allocation are not allowed.

For a valid request, evaluate warehouses in this deterministic order:

1. `priority` ascending;
2. warehouse UUID ascending by its canonical lowercase hexadecimal representation.

Choose the first warehouse whose available stock can satisfy every order line in full. Other
warehouses must not be modified. If no one warehouse can satisfy the complete order, return HTTP
`409` and `NO_SINGLE_WAREHOUSE_CAPACITY`. The failure must leave no order, order line, allocation,
fulfillment, dispatch task, domain event, idempotency side effect, or inventory change, apart from a
durable replay record for that response.

A successful create is one atomic business mutation. It must:

- create the order and all order lines;
- create one allocation per order line at the selected warehouse;
- create exactly one fulfillment for the order;
- create exactly one persistent `DispatchTask` for that fulfillment;
- increase `reserved` by each allocated quantity without changing `onHand`;
- create the `order.allocated` domain event and pending outbox delivery;
- durably record the idempotent result.

The initial order status is `ALLOCATED`, and its fulfillment status is `PENDING`. A committed order
must remain visible after API restarts and from every API instance.

### 4.3 Fulfillment workers and shipments

Two or more `npm run worker` processes may operate against the same database. Work ownership and
progress must be durable; a process-local queue or lock cannot be the authority. Workers must not
require requests to the API process.

Completing a pending fulfillment is one atomic business mutation. It must:

- create at most one shipment for the fulfillment;
- settle every allocation exactly once;
- decrease both `reserved` and `onHand` by the same allocated quantity for every line;
- mark the fulfillment and order `SHIPPED`;
- finish the corresponding dispatch task;
- create the `order.shipped` domain event and pending outbox delivery.

Two workers racing on the same task must produce one logical result, one shipment, one inventory
deduction, and one `order.shipped` event. If a worker is killed after taking work, a surviving or
replacement worker must make that work eligible again no later than `DISPATCH_TASK_TIMEOUT_SECONDS`
after its last durable ownership signal. Recovery must not duplicate a shipment or inventory
deduction.

### 4.4 Cancellation and shipping races

An allocated order may be cancelled before shipment commits. Cancellation is one atomic mutation
that marks the order and fulfillment `CANCELLED`, settles the allocations, decreases `reserved` by
the allocated quantities without changing `onHand`, prevents the dispatch task from shipping, and
creates one `order.cancelled` domain event and pending outbox delivery.

Cancelling an already cancelled order returns its existing logical result. A shipped order cannot be
cancelled and returns HTTP `409` with `ORDER_NOT_CANCELLABLE`.

Cancellation and worker shipment may race. Exactly one terminal outcome may win:

- `CANCELLED`, with no shipment and no on-hand deduction; or
- `SHIPPED`, with one shipment and one on-hand deduction.

No intermediate or mixed outcome may remain after either successful response is observable.

### 4.5 Transactional outbox and webhook delivery

Business state and its domain event must commit together. A successful business mutation must never
be visible without its corresponding durable event, and a rolled-back mutation must not leave an
event. Webhook delivery happens asynchronously through `npm run dispatcher` and must not delay the
business API response.

The dispatcher sends each event with HTTP `POST` to `WEBHOOK_URL`. Any HTTP `2xx` response marks an
attempt successful. Redirects, other non-`2xx` statuses, connection failures, and timeouts are
failures and must be retried until a `2xx` response is received. The receiver response body has no
business meaning.

Delivery is at least once. A receiver may observe duplicates, but every retry of one event must use
the same `eventId`, event type, aggregate ID, sequence, and semantically identical JSON body. An
event may not be discarded because a retry limit was reached or because the dispatcher restarted.

For one order, successful delivery must follow increasing event sequence: sequence 2 cannot be
successfully delivered before sequence 1. Events for different orders may be delivered concurrently;
no global ordering is promised. Exactly-once webhook delivery is not promised.

### 4.6 Multiple processes and restarts

A deployment may start two API processes on different ports, two or more workers, and one or more
dispatchers with the same `DATABASE_URL`. All invariants must remain correct across them. In-process
state may be used as a cache or optimization, but it cannot be the authority for inventory,
allocation, idempotency, work ownership, shipment, event ordering, or delivery progress.

Stopping all processes and starting them again must not lose committed orders, leave valid work
permanently stuck, reset idempotency, or lose an outbox event.

## 5. Business invariants

These invariants always apply, including during concurrency tests, after process crashes, and after
performance tests:

1. Every quantity is an integer and `0 <= reserved <= onHand` for every stock position.
2. `available` is always exactly `onHand - reserved`.
3. For each warehouse/SKU pair, `reserved` equals the sum of unsettled allocation quantities.
4. Every order line is allocated for its full quantity at the order's one fulfillment warehouse, or
   the order does not exist.
5. An allocation is settled at most once.
6. A fulfillment has at most one logical dispatch result and at most one shipment.
7. Shipping decreases `reserved` and `onHand` by equal allocated quantities exactly once.
8. Cancellation decreases `reserved` only, exactly once.
9. An order with a shipment can never be `CANCELLED`; a cancelled order can never gain a shipment.
10. An idempotent retry never repeats a business side effect and returns the original logical result.
11. Every runtime business mutation and its domain event commit atomically.
12. Event sequence is unique and gap-free within every runtime-created order: allocation is sequence
    1 and its one terminal event is sequence 2.
13. A process crash cannot permanently strand work, lose an event, duplicate inventory settlement,
    or change a completed result.
14. Committed state is shared by all processes and survives process restarts.

## 6. HTTP and OpenAPI contract

Create an OpenAPI 3.1 document at `/workspace/openapi.yaml`. It must describe every public endpoint,
request, response, header, error code, schema, and outbound webhook implemented by the application.
README examples, OpenAPI, and actual behavior must agree.

### 6.1 Common input and output rules

- Request and response bodies use UTF-8 `application/json`.
- A body with an unsupported content type returns HTTP `415` and `UNSUPPORTED_MEDIA_TYPE`.
- Malformed JSON returns HTTP `400` and `INVALID_JSON`.
- Schema-invalid JSON returns HTTP `422` and `VALIDATION_ERROR`.
- Mutation request schemas reject unknown properties.
- An endpoint documented with no body rejects a non-empty body with HTTP `422` and
  `VALIDATION_ERROR`.
- IDs are canonical UUID strings. An invalid path ID returns HTTP `400` and `INVALID_ID`.
- Input timestamps are RFC 3339 timestamps with an explicit timezone.
- Output timestamps are RFC 3339 in UTC.
- Strings must not be blank after trimming and must not be silently truncated.
- JSON integers must be safe integers and within the field's documented range.
- Pagination uses `limit` and an opaque `cursor`; `limit` defaults to `20` and must be `1..100`.
- A malformed or stale cursor returns HTTP `400` and `INVALID_CURSOR`.
- Successful and error responses must not expose stack traces, SQL, credentials, absolute paths, or
  internal implementation data.

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

`details` may be empty. Unknown warehouses, SKUs, orders, or other addressed resources return HTTP
`404` with a stable, resource-specific error code. An absent administrator token returns HTTP `401`
and `ADMIN_AUTH_REQUIRED`; an invalid token returns HTTP `401` and `ADMIN_AUTH_INVALID`.

The required stable error codes are:

| HTTP | Code | Condition |
| --- | --- | --- |
| `400` | `INVALID_JSON` | Request body is not valid JSON |
| `400` | `INVALID_ID` | A path or exact-ID query value is not a UUID |
| `400` | `INVALID_CURSOR` | Cursor is malformed or no longer valid for that query |
| `400` | `IDEMPOTENCY_KEY_REQUIRED` | A write omits `Idempotency-Key` |
| `400` | `INVALID_IDEMPOTENCY_KEY` | The key does not meet the documented format |
| `401` | `ADMIN_AUTH_REQUIRED` | An administrator mutation omits authorization |
| `401` | `ADMIN_AUTH_INVALID` | Administrator authorization is invalid |
| `404` | `WAREHOUSE_NOT_FOUND` | Addressed warehouse does not exist |
| `404` | `SKU_NOT_FOUND` | Addressed SKU does not exist |
| `404` | `ORDER_NOT_FOUND` | Addressed order does not exist |
| `409` | `WAREHOUSE_CODE_CONFLICT` | Warehouse code already exists |
| `409` | `SKU_CODE_CONFLICT` | SKU code already exists |
| `409` | `STOCK_BELOW_RESERVED` | Requested on-hand value is below reserved stock |
| `409` | `NO_SINGLE_WAREHOUSE_CAPACITY` | No warehouse can satisfy every order line |
| `409` | `ORDER_NOT_CANCELLABLE` | Order has already shipped |
| `409` | `IDEMPOTENCY_CONFLICT` | A scoped key is reused for different input |
| `415` | `UNSUPPORTED_MEDIA_TYPE` | A body does not use JSON content type |
| `422` | `VALIDATION_ERROR` | JSON does not satisfy the endpoint schema |
| `503` | `DEPENDENCY_UNAVAILABLE` | Health check cannot reach PostgreSQL |

### 6.2 Idempotency

Every write endpoint requires an `Idempotency-Key` header containing 8 to 128 printable ASCII
characters. A missing key returns HTTP `400` and `IDEMPOTENCY_KEY_REQUIRED`; an invalid key returns
HTTP `400` and `INVALID_IDEMPOTENCY_KEY`.

The key is scoped to the concrete operation and resource. Reusing the same text for a different
operation or resource is allowed. Repeating the same scoped operation with the same key and
semantically identical input must replay the original HTTP status and response body without
repeating side effects. Reusing the same scoped key with different input returns HTTP `409` and
`IDEMPOTENCY_CONFLICT`.

JSON object property order and insignificant whitespace do not affect semantic identity. Order-line
array order also does not affect semantic identity because SKU IDs in an order are unique. All other
values are compared according to their validated JSON meaning.

Concurrent identical requests must converge on the same result, including generated IDs and
timestamps. Idempotency must survive API restarts, work across API instances, and protect a client
that retries after an unknown response outcome. A valid request that reaches business evaluation
must durably replay its original result, including a domain `409` result such as
`NO_SINGLE_WAREHOUSE_CAPACITY`. Transport, content-type, JSON parsing, authentication, missing-key,
and key-format failures occur before business evaluation and need not create a replay record.

### 6.3 Endpoint summary

```text
GET  /api/health

POST /api/admin/warehouses
POST /api/admin/skus
PUT  /api/admin/inventory/{warehouseId}/{skuId}

GET  /api/warehouses
GET  /api/skus
GET  /api/inventory

POST /api/orders
GET  /api/orders
GET  /api/orders/{orderId}
POST /api/orders/{orderId}/cancel
```

`GET /api/health` returns HTTP `200` and `{"status":"ok"}` only when that API process can serve
requests and reach its database. It returns HTTP `503` and `DEPENDENCY_UNAVAILABLE` otherwise.

All paginated endpoints use:

```json
{
  "items": [],
  "nextCursor": null
}
```

### 6.4 Warehouse, SKU, and inventory endpoints

Administrator mutations require `Authorization: Bearer <ADMIN_TOKEN>` in addition to an
`Idempotency-Key`.

Create-warehouse request:

```json
{
  "code": "SHA-01",
  "name": "Shanghai Primary",
  "priority": 10
}
```

Rules:

- `code`: uppercase ASCII letters, digits, and single hyphens; length `2..32`; globally unique;
- `name`: non-blank string; length `1..120` after trimming;
- `priority`: integer `0..1000000`.

A successful create returns HTTP `201`:

```json
{
  "warehouse": {
    "id": "11111111-1111-4111-8111-111111111111",
    "code": "SHA-01",
    "name": "Shanghai Primary",
    "priority": 10,
    "createdAt": "2026-08-05T08:00:00.000Z"
  }
}
```

A duplicate code returns HTTP `409` and `WAREHOUSE_CODE_CONFLICT`.

Create-SKU request:

```json
{
  "code": "KEYBOARD-01",
  "name": "Compact Keyboard"
}
```

Rules:

- `code`: uppercase ASCII letters, digits, periods, underscores, and hyphens; length `2..64`;
  globally unique;
- `name`: non-blank string; length `1..160` after trimming.

A successful create returns HTTP `201`:

```json
{
  "sku": {
    "id": "22222222-2222-4222-8222-222222222222",
    "code": "KEYBOARD-01",
    "name": "Compact Keyboard",
    "createdAt": "2026-08-05T08:00:00.000Z"
  }
}
```

A duplicate code returns HTTP `409` and `SKU_CODE_CONFLICT`.

Set-inventory request for `PUT /api/admin/inventory/{warehouseId}/{skuId}`:

```json
{
  "onHand": 500
}
```

`onHand` must be an integer `0..1000000000`. The operation creates a missing stock position or
updates the existing position without changing its current `reserved` quantity. A value below
`reserved` returns HTTP `409` and `STOCK_BELOW_RESERVED`. Success returns HTTP `200` with the stock
position:

```json
{
  "stockPosition": {
    "warehouseId": "11111111-1111-4111-8111-111111111111",
    "skuId": "22222222-2222-4222-8222-222222222222",
    "onHand": 500,
    "reserved": 0,
    "available": 500,
    "updatedAt": "2026-08-05T08:00:00.000Z"
  }
}
```

`GET /api/warehouses` accepts `q`, `limit`, and `cursor`. Search is case-insensitive against code and
name. Results are ordered by priority ascending and then ID ascending.

`GET /api/skus` accepts `q`, `limit`, and `cursor`. Search is case-insensitive against code and name.
Results are ordered by code ascending and then ID ascending.

`GET /api/inventory` accepts `q`, `warehouseId`, `skuId`, `limit`, and `cursor`. `q` searches SKU code
and name case-insensitively. Exact filters may be combined. Results are ordered by warehouse priority,
warehouse ID, SKU code, and SKU ID, all ascending. Each item uses the `stockPosition` fields shown
above and also includes the warehouse code and SKU code needed by the UI:

```json
{
  "items": [
    {
      "warehouseId": "11111111-1111-4111-8111-111111111111",
      "warehouseCode": "SHA-01",
      "skuId": "22222222-2222-4222-8222-222222222222",
      "skuCode": "KEYBOARD-01",
      "onHand": 500,
      "reserved": 0,
      "available": 500,
      "updatedAt": "2026-08-05T08:00:00.000Z"
    }
  ],
  "nextCursor": null
}
```

### 6.5 Order endpoints

Create-order request:

```json
{
  "customerReference": "customer-1042",
  "lines": [
    {
      "skuId": "22222222-2222-4222-8222-222222222222",
      "quantity": 2
    },
    {
      "skuId": "33333333-3333-4333-8333-333333333333",
      "quantity": 1
    }
  ]
}
```

Rules:

- `customerReference`: non-blank string; length `1..100` after trimming;
- `lines`: array length `1..8`;
- `skuId`: existing SKU UUID, unique within the order;
- `quantity`: integer `1..1000000`.

A successful create returns HTTP `201`. Order responses use this shape:

```json
{
  "order": {
    "id": "44444444-4444-4444-8444-444444444444",
    "customerReference": "customer-1042",
    "status": "ALLOCATED",
    "lines": [
      {
        "id": "55555555-5555-4555-8555-555555555555",
        "skuId": "22222222-2222-4222-8222-222222222222",
        "quantity": 2
      },
      {
        "id": "66666666-6666-4666-8666-666666666666",
        "skuId": "33333333-3333-4333-8333-333333333333",
        "quantity": 1
      }
    ],
    "fulfillment": {
      "id": "77777777-7777-4777-8777-777777777777",
      "warehouseId": "11111111-1111-4111-8111-111111111111",
      "status": "PENDING",
      "shipment": null
    },
    "createdAt": "2026-08-05T08:00:00.000Z",
    "updatedAt": "2026-08-05T08:00:00.000Z"
  }
}
```

Order-line responses are ordered by SKU ID ascending. `status` is `ALLOCATED`, `SHIPPED`, or
`CANCELLED`. Fulfillment `status` is `PENDING`, `SHIPPED`, or `CANCELLED`. A shipped fulfillment has:

```json
{
  "id": "88888888-8888-4888-8888-888888888888",
  "shippedAt": "2026-08-05T08:00:02.000Z"
}
```

as its `shipment` value. Other fulfillment states have `shipment: null`.

`GET /api/orders` accepts `customerReference`, `status`, `warehouseId`, `limit`, and `cursor`. Exact
filters may be combined. Results are ordered by `createdAt` descending and then ID descending.

`GET /api/orders/{orderId}` returns the same order shape.

`POST /api/orders/{orderId}/cancel` has no request body. Cancelling an allocated or already cancelled
order returns HTTP `200` with the final order. Cancelling a shipped order returns HTTP `409` and
`ORDER_NOT_CANCELLABLE`.

### 6.6 Outbound webhook contract

Each delivery uses these headers:

```text
Content-Type: application/json
X-ParcelFlow-Event-Id: <eventId>
X-ParcelFlow-Event-Type: <type>
```

The JSON body is:

```json
{
  "eventId": "99999999-9999-4999-8999-999999999999",
  "type": "order.allocated",
  "aggregateType": "order",
  "aggregateId": "44444444-4444-4444-8444-444444444444",
  "sequence": 1,
  "occurredAt": "2026-08-05T08:00:00.000Z",
  "data": {
    "orderId": "44444444-4444-4444-8444-444444444444",
    "fulfillmentId": "77777777-7777-4777-8777-777777777777",
    "warehouseId": "11111111-1111-4111-8111-111111111111",
    "lines": [
      {
        "skuId": "22222222-2222-4222-8222-222222222222",
        "quantity": 2
      }
    ]
  }
}
```

The event types are:

- `order.allocated`, sequence 1: `data` contains `orderId`, `fulfillmentId`, `warehouseId`, and all
  allocated `lines` ordered by SKU ID;
- `order.shipped`, sequence 2: `data` contains `orderId`, `fulfillmentId`, `warehouseId`,
  `shipmentId`, and `shippedAt`;
- `order.cancelled`, sequence 2: `data` contains `orderId`, `fulfillmentId`, `warehouseId`, and
  `cancelledAt`.

The `X-ParcelFlow-Event-Id` and `X-ParcelFlow-Event-Type` values must match the JSON body. Event bodies
reject implementation-only fields and must not contain credentials or internal paths.

## 7. Seed-file contract

Implement:

```sh
npm run seed -- --file /absolute/path/to/seed.v1.json
```

The command imports an empty database using this versioned JSON shape:

```json
{
  "schemaVersion": 1,
  "warehouses": [
    {
      "id": "11111111-1111-4111-8111-111111111111",
      "code": "SHA-01",
      "name": "Shanghai Primary",
      "priority": 10
    }
  ],
  "skus": [
    {
      "id": "22222222-2222-4222-8222-222222222222",
      "code": "KEYBOARD-01",
      "name": "Compact Keyboard"
    }
  ],
  "stockPositions": [
    {
      "warehouseId": "11111111-1111-4111-8111-111111111111",
      "skuId": "22222222-2222-4222-8222-222222222222",
      "onHand": 500
    }
  ],
  "orders": [
    {
      "id": "44444444-4444-4444-8444-444444444444",
      "customerReference": "historical-customer-1",
      "warehouseId": "11111111-1111-4111-8111-111111111111",
      "fulfillmentId": "77777777-7777-4777-8777-777777777777",
      "shipmentId": "88888888-8888-4888-8888-888888888888",
      "lines": [
        {
          "id": "55555555-5555-4555-8555-555555555555",
          "skuId": "22222222-2222-4222-8222-222222222222",
          "quantity": 2
        }
      ],
      "createdAt": "2026-08-01T09:00:00Z",
      "shippedAt": "2026-08-01T10:00:00Z"
    }
  ]
}
```

The importer must:

- reject unknown fields, unsupported schema versions, duplicate IDs, duplicate codes, duplicate
  warehouse/SKU stock positions, duplicate SKU lines within an order, invalid values, missing
  references, and timestamps where `shippedAt < createdAt`;
- validate the complete file before committing any business data;
- make no partial database change on failure;
- refuse to import into non-empty application tables;
- import every listed historical order as `SHIPPED` with one completed fulfillment and shipment;
- treat stock-position `onHand` as the current physical quantity after all historical activity and
  initialize every `reserved` quantity to zero;
- avoid creating dispatch tasks, domain events, or webhook deliveries for historical imports;
- print one JSON summary line on success with `schemaVersion`, `warehouses`, `skus`,
  `stockPositions`, `orders`, and `orderLines` counts;
- print a concise diagnostic to stderr and exit nonzero on failure;
- handle at least 100 warehouses, 20000 SKUs, 1000000 stock positions, 200000 historical orders,
  and 1000000 historical order lines within the target environment.

The importer must support any data that conforms to this public schema, regardless of array order or
specific values. Seeded IDs and values must be observable through the same public query APIs as
runtime-created data.

## 8. Browser application

Provide these user-visible flows against the real API:

- warehouse and SKU catalog browsing with search, cursor pagination, loading, empty, and error
  states;
- inventory browsing with warehouse, SKU, and text filters and visible on-hand, reserved, and
  available quantities;
- an order composer with a customer reference and 1 to 8 accessible SKU/quantity rows;
- clear allocation success showing the selected warehouse and every accepted line;
- clear `NO_SINGLE_WAREHOUSE_CAPACITY`, validation, idempotency-conflict, and unexpected-error
  feedback without pretending a failed order exists;
- an order detail view that automatically refreshes while `ALLOCATED`, then shows shipment or
  cancellation details;
- a cancel action with clear success, conflict, disabled, and retry states;
- searchable/filterable order history and navigation back to a durable order after full refresh;
- usable layouts at 390px and 1280px viewport widths;
- keyboard-operable controls, associated labels, visible focus, and meaningful status announcements.

Do not expose `ADMIN_TOKEN` in browser code. Test setup may create catalog and inventory records
through administrator APIs before opening the operator UI.

## 9. Automated tests owned by the project

### 9.1 Unit tests

Cover focused pure behavior such as validation, deterministic warehouse selection, state-transition
decisions, event payload construction, and retry classification. Unit tests alone are not sufficient
for completion.

### 9.2 Integration tests

`npm run test:integration` must use `TEST_DATABASE_URL`, real migrations, a real PostgreSQL database,
and real HTTP server, worker, dispatcher, and local webhook receiver processes as relevant. Do not
mock PostgreSQL, replace HTTP with repository calls, or replace the dispatcher receiver with a
function call.

At minimum, cover input validation, seed validation and atomicity, catalog APIs, single-warehouse
selection, multi-line allocation atomicity, durable idempotency, shipment settlement, cancellation,
event transactionality, webhook retry, and per-order event order.

### 9.3 Browser E2E tests

`npm run test:e2e` must build and start the production application, prepare isolated PostgreSQL data,
start a real worker and dispatcher, and drive Chromium through the real browser UI. It must cover:

1. browse catalog and inventory, compose a multi-SKU order, observe allocation, and observe shipment;
2. create an order without complete single-warehouse capacity and observe an atomic failure;
3. create and cancel an allocated order, then observe restored available inventory;
4. refresh an allocated or completed order and continue from durable server state;
5. browse and filter historical and runtime-created orders.

### 9.4 Concurrency tests

`npm run test:concurrency` must send real HTTP requests to two API processes and run two worker
processes sharing one database. At minimum, cover hot-stock contention, concurrent identical and
conflicting idempotency requests, two workers racing for fulfillment, and cancellation racing with
shipment. Assert final state through public APIs and verify all business invariants.

### 9.5 Crash and recovery tests

`npm run test:recovery` must use real processes and `SIGKILL`, not simulated exceptions. It must
demonstrate recovery when:

1. a worker dies after taking a dispatch task but before shipment commits;
2. a worker dies around completion and another worker attempts the same task;
3. a dispatcher dies after the receiver accepts an event but before local delivery progress is
   known, allowing a duplicate but never a changed or lost event;
4. API, worker, and dispatcher processes all stop and restart with committed work pending;
5. a client loses an order-create response and retries through another API instance.

Tests may use deterministic, test-only process barriers, but must not add production debug routes,
weaken the production transaction boundaries, or make correctness depend on those barriers.

### 9.6 Test isolation

Tests must prepare, migrate, seed, and clean their own isolated data. They must not depend on execution
order, development data, external network access, files outside this repository, fixed sample IDs,
or timing luck. A passing script must contain meaningful assertions; merely starting processes or
receiving exit code zero from a nested placeholder is not sufficient.

## 10. Performance target

The target environment has 4 vCPUs, 8 GiB RAM, local PostgreSQL 16, two API processes, two worker
processes, one dispatcher, and one local webhook receiver. Test the production build. Warm each
latency/throughput scenario for 15 seconds, then measure it for 90 seconds. Run each of those
scenarios three times and evaluate the median run.

The large dataset contains 100 warehouses, 20000 SKUs, 1000000 stock positions, 200000 historical
orders, and 1000000 historical order lines.

### 10.1 Catalog and history queries

With 64 concurrent clients issuing paginated inventory, SKU search, order history, and order-detail
requests against the large dataset:

- aggregate query `p95 <= 250 ms`;
- throughput is at least 250 completed requests per second.

### 10.2 Hot inventory mutations

With 8 warehouses, 32 hot SKUs, and 200 concurrent clients issuing a sustained mix of multi-line
order creates, eligible cancellations, and public reads:

- mutation `p95 <= 750 ms`;
- aggregate throughput is at least 120 completed requests per second;
- successful order-create and cancellation responses total at least 60 per second.

Expected product conflicts are counted and reported but are not successful mutations.

### 10.3 Worker and outbox recovery backlog

Begin with 5000 due dispatch tasks and 5000 due outbox deliveries. Run two workers and the dispatcher.
The receiver returns HTTP `503` for its first 10 seconds and then returns HTTP `204`.

Measure recovery from the first `204` response. Within 60 seconds, at least 95 percent of the 5000
orders must be shipped and have all corresponding allocation and shipment events successfully
delivered. Within 120 seconds, all 5000 must be shipped and all corresponding events delivered.

### 10.4 Reporting and correctness

Unexpected HTTP `5xx` responses must be zero in every scenario. Expected documented product
conflicts are not server errors. All business invariants must still hold after every load run.

`npm run test:perf` must report dataset size, process counts, warm-up, duration, concurrency,
throughput, success and status counts, webhook attempt/duplicate counts, backlog progress, and
p50/p95/p99 latency as machine-readable JSON plus a concise human-readable summary. It must exit
nonzero when a target or post-load invariant fails.

## 11. Delivery requirements

Before handoff:

- update this README with the final architecture and any approved requirement changes;
- keep `openapi.yaml` synchronized with behavior, including outbound webhooks;
- run migrations and the versioned seed against a clean database;
- run `npm run build`, `npm run test:all`, and `npm run test:perf`;
- verify two API processes, two workers, restart recovery, and local webhook delivery;
- remove debug-only routes, hard-coded fixtures, secrets, generated reports, and temporary files;
- report exact commands and results, plus any remaining risks or unmet requirements.

## 12. Out of scope

Do not add authentication beyond the administrator token, payments, carrier integrations, label
generation, returns, procurement, warehouse transfers, inventory forecasting, a message broker,
distributed tracing infrastructure, hosted services, or unrelated administrator features. Build the
smallest system that fully satisfies this contract.

## Successful response contracts

Successful response contracts are closed:

- A mutation route without a literally stated success status returns 200.
- Unless a route literally publishes another object, array, or empty body, a success described by a named resource, named resource state, or named resource fields returns that exact resource shape at the JSON top level. Any response-only fields literally named by the route are additional top-level fields.
- If a mutation publishes no success body, it returns the exact current shape of the single primary resource created or changed by that route at the JSON top level.
- When a route explicitly returns multiple named resources, the body is one object keyed by their lower-camel resource names unless the route publishes another literal shape.
- Wrappers such as `{data:...}`, `{result:...}`, or an extra single-resource envelope are invalid unless the route literally declares them. OpenAPI must publish the same success status and closed response schema as runtime.
