# ParcelFlow

构建一个生产级全栈应用，用于将多商品订单分配至仓库库存，并通过持久化后台履约完成订单。从空仓库开始，交付完整的应用程序、数据库迁移、文档和自动化测试。

本 README 是权威的公开产品契约。如果后续用户消息引入了经批准的变更需求，请在该变更中同时更新本 README 和 `openapi.yaml`。

## 1. 必需的技术栈和运行时

- Node.js 22
- 应用程序和测试代码使用 TypeScript
- 浏览器应用程序使用 React
- PostgreSQL 16 作为持久化业务状态的权威存储
- 浏览器端到端测试使用 Chromium

您可以选择 Node.js Web 框架、数据库库、迁移工具、React 构建工具和测试库。运行系统不得依赖 Redis、消息代理、其他数据库、托管服务或外部网络访问。唯一的运行时服务是提供的 PostgreSQL 数据库和由 `WEBHOOK_URL` 配置的本地 HTTP webhook 接收器。

API 进程必须从同一 `PORT` 提供构建后的浏览器 UI 和 `/api/*` 路由。Worker 和 webhook 分发器作为独立进程运行，并共享同一个 PostgreSQL 数据库。

## 2. 必需的命令

为以下所有命令创建 `package.json` 脚本：

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

`npm start` 仅启动生产 API 和构建后的 UI。`npm run worker` 启动一个履约 worker，`npm run dispatcher` 启动一个 webhook 分发器。每个长时间运行的命令必须处理 `SIGTERM`，不接受新工作，并在完成或安全放弃当前工作后十秒内退出。

`npm test` 必须是 `npm run test:all` 的别名。`test:all` 必须运行单元测试、集成测试、浏览器端到端测试、并发测试和恢复测试。性能测试保持为独立命令。

所有命令必须是非交互式的，并通过退出状态传达成功或失败。提交 npm `package-lock.json`；干净检出必须能通过 `npm ci` 成功安装。

## 3. 环境变量

| 名称 | 必需 | 含义 |
| --- | --- | --- |
| `DATABASE_URL` | 是 | API、worker、分发器、迁移和种子导入使用的 PostgreSQL 连接 |
| `TEST_DATABASE_URL` | 测试时 | 所有数据库支持的测试使用的隔离 PostgreSQL 连接 |
| `PORT` | 否 | API 和 UI HTTP 端口；默认为 `3000` |
| `ADMIN_TOKEN` | API 时 | 管理员变更端点接受的 Bearer 令牌 |
| `WEBHOOK_URL` | 分发器时 | 提供的本地 webhook 接收器的绝对 URL |
| `WORKER_POLL_INTERVAL_MS` | 否 | 空闲 worker 轮询间隔，整数 `10..10000`；默认为 `100` |
| `DISPATCH_TASK_TIMEOUT_SECONDS` | 否 | 放弃的派发工作可恢复的时间，整数 `1..300`；默认为 `5` |
| `OUTBOX_POLL_INTERVAL_MS` | 否 | 空闲分发器轮询间隔，整数 `10..10000`；默认为 `100` |
| `WEBHOOK_TIMEOUT_MS` | 否 | 单次 webhook 尝试的超时时间，整数 `100..30000`；默认为 `3000` |

当该命令所需的值缺失或无效时，启动失败并显示可操作的错误。API 不要求 `WEBHOOK_URL`；当没有分发器运行时，已分配的事件可以保持待处理状态。不要在日志或错误消息中打印凭据、授权值或完整的数据库或 webhook URL。

## 4. 产品行为

### 4.1 仓库、SKU 和库存目录

管理员可以创建仓库和 SKU，并设置每个仓库/SKU 库存位置的当前在库数量。缺失的库存位置表示该仓库对该 SKU 的库存为零。客户和操作员可以在没有管理员令牌的情况下浏览、搜索、筛选和游标分页浏览目录和库存。

每个仓库具有唯一代码、显示名称和优先级。数值较小的优先级优先。每个 SKU 具有唯一代码和显示名称。库存位置公开：

- `onHand`：当前物理数量；
- `reserved`：已分配给已分配订单但尚未发货或取消的数量；
- `available`：`onHand - reserved`。

将 `onHand` 设置为低于当前 `reserved` 数量必须失败，且不改变库存位置。

### 4.2 原子性单仓库订单分配

订单包含客户引用和 1 至 8 个订单行。一个订单内的 SKU ID 必须唯一。每一行必须全额分配；不允许部分行分配和部分订单分配。

对于有效请求，按以下确定性顺序评估仓库：

1. `priority` 升序；
2. 仓库 UUID 按其规范小写十六进制表示升序。

选择第一个可用库存能够完全满足每个订单行的仓库。其他仓库不得被修改。如果没有一个仓库能够完全满足整个订单，则返回 HTTP `409` 和 `NO_SINGLE_WAREHOUSE_CAPACITY`。该失败不得留下订单、订单行、分配、履约、派发任务、领域事件、幂等副作用或库存变更，除非是该响应的持久化重放记录。

成功的创建是一个原子业务变更。它必须：

- 创建订单和所有订单行；
- 在所选仓库为每个订单行创建一个分配；
- 为订单创建恰好一个履约；
- 为该履约创建恰好一个持久化 `DispatchTask`；
- 将 `reserved` 增加每个分配数量，而不改变 `onHand`；
- 创建 `order.allocated` 领域事件和待处理 outbox 投递；
- 持久化记录幂等结果。

初始订单状态为 `ALLOCATED`，其履约状态为 `PENDING`。已提交的订单必须在 API 重启后和从每个 API 实例中保持可见。

### 4.3 履约 worker 和发货

两个或更多 `npm run worker` 进程可以针对同一数据库运行。工作所有权和进度必须是持久的；进程本地队列或锁不能作为权威。Worker 不得要求向 API 进程发起请求。

完成待处理的履约是一个原子业务变更。它必须：

- 为履约创建至多一个发货；
- 恰好一次结算每个分配；
- 将每个行的 `reserved` 和 `onHand` 同时减少相同的分配数量；
- 将履约和订单标记为 `SHIPPED`；
- 完成对应的派发任务；
- 创建 `order.shipped` 领域事件和待处理 outbox 投递。

两个 worker 竞争同一任务必须产生一个逻辑结果、一个发货、一次库存扣减和一个 `order.shipped` 事件。如果 worker 在接管工作后被终止，幸存的或替代的 worker 必须在其最后一次持久化所有权信号后不迟于 `DISPATCH_TASK_TIMEOUT_SECONDS` 使该工作重新符合条件。恢复不得重复发货或库存扣减。

### 4.4 取消和发货竞争

已分配的订单可以在发货提交之前取消。取消是一个原子变更，将订单和履约标记为 `CANCELLED`，结算分配，将 `reserved` 减少分配数量而不改变 `onHand`，阻止派发任务发货，并创建一个 `order.cancelled` 领域事件和待处理 outbox 投递。

取消已取消的订单返回其现有的逻辑结果。已发货的订单不能取消，并返回 HTTP `409` 和 `ORDER_NOT_CANCELLABLE`。

取消和 worker 发货可能竞争。恰好一个最终结果可以胜出：

- `CANCELLED`，无发货且无在库扣减；或
- `SHIPPED`，有一个发货和一次在库扣减。

在任一成功响应可观察后，不得留下中间或混合结果。

### 4.5 事务性 outbox 和 webhook 投递

业务状态及其领域事件必须一起提交。成功的业务变更绝不能在没有对应持久化事件的情况下可见，回滚的变更不得留下事件。Webhook 投递通过 `npm run dispatcher` 异步进行，不得延迟业务 API 响应。

分发器使用 HTTP `POST` 向 `WEBHOOK_URL` 发送每个事件。任何 HTTP `2xx` 响应标记尝试成功。重定向、其他非 `2xx` 状态、连接失败和超时均为失败，必须重试直到收到 `2xx` 响应。接收器响应体没有业务含义。

投递至少一次。接收器可能观察到重复，但每个事件的每次重试必须使用相同的 `eventId`、事件类型、聚合 ID、序列和语义相同的 JSON 体。事件不得因达到重试限制或分发器重启而被丢弃。

对于一个订单，成功投递必须遵循递增的事件序列：序列 2 不能在序列 1 之前成功投递。不同订单的事件可以并发投递；不承诺全局排序。不承诺 webhook 投递的恰好一次。

### 4.6 多进程和重启

一次部署可以在不同端口启动两个 API 进程、两个或更多 worker，以及一个或多个具有相同 `DATABASE_URL` 的 dispatcher。所有不变量必须在它们之间保持正确。进程内状态可用作缓存或优化，但不能作为库存、分配、幂等性、工作所有权、发货、事件排序或交付进度的权威来源。

停止所有进程并重新启动它们，不得丢失已提交的订单、使有效工作永久卡住、重置幂等性或丢失 outbox 事件。

## 5. 业务不变量

以下不变量始终适用，包括在并发测试期间、进程崩溃后以及性能测试之后：

1. 每个数量都是整数，并且每个库存位置的 `0 <= reserved <= onHand` 均成立。
2. `available` 始终恰好等于 `onHand - reserved`。
3. 对于每个仓库/SKU 组合，`reserved` 等于未结算分配数量的总和。
4. 每个订单行都在订单的唯一履行仓库按其全部数量进行分配，否则该订单不存在。
5. 一次分配最多结算一次。
6. 一次履行最多有一个逻辑派发结果和一个发货。
7. 发货恰好一次将 `reserved` 和 `onHand` 减少相等的已分配数量。
8. 取消仅恰好一次减少 `reserved`。
9. 有发货的订单永远不能是 `CANCELLED`；已取消的订单永远不能获得发货。
10. 幂等重试永远不会重复业务副作用，并返回原始逻辑结果。
11. 每个运行时业务变更及其领域事件原子提交。
12. 在每个运行时创建的订单内，事件序列是唯一且无间隙的：分配是序列 1，其唯一终止事件是序列 2。
13. 进程崩溃不能永久搁置工作、丢失事件、重复库存结算或更改已完成的结果。
14. 已提交状态由所有进程共享，并在进程重启后仍然存在。

## 6. HTTP 和 OpenAPI 契约

在 `/workspace/openapi.yaml` 处创建一个 OpenAPI 3.1 文档。它必须描述应用程序实现的每个公共端点、请求、响应、标头、错误代码、模式和出站 webhook。README 示例、OpenAPI 和实际行为必须一致。

### 6.1 通用输入和输出规则

- 请求和响应体使用 UTF-8 `application/json`。
- 具有不受支持的内容类型的请求体返回 HTTP `415` 和 `UNSUPPORTED_MEDIA_TYPE`。
- 格式错误的 JSON 返回 HTTP `400` 和 `INVALID_JSON`。
- 不符合模式的 JSON 返回 HTTP `422` 和 `VALIDATION_ERROR`。
- 变更请求模式拒绝未知属性。
- 文档中声明无请求体的端点拒绝非空请求体，返回 HTTP `422` 和 `VALIDATION_ERROR`。
- ID 是规范的 UUID 字符串。无效的路径 ID 返回 HTTP `400` 和 `INVALID_ID`。
- 输入时间戳是带有显式时区的 RFC 3339 时间戳。
- 输出时间戳是 UTC 格式的 RFC 3339。
- 字符串在修剪后不得为空白，且不得被静默截断。
- JSON 整数必须是安全整数，并且在字段的文档化范围内。
- 分页使用 `limit` 和不透明的 `cursor`；`limit` 默认为 `20`，并且必须是 `1..100`。
- 格式错误或过期的游标返回 HTTP `400` 和 `INVALID_CURSOR`。
- 成功和错误响应不得暴露堆栈跟踪、SQL、凭据、绝对路径或内部实现数据。

所有错误使用以下信封：

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "A concise human-readable message",
    "details": []
  }
}
```

`details` 可以为空。未知的仓库、SKU、订单或其他被寻址的资源返回 HTTP `404`，并带有稳定的、特定于资源的错误代码。缺少管理员令牌返回 HTTP `401` 和 `ADMIN_AUTH_REQUIRED`；无效令牌返回 HTTP `401` 和 `ADMIN_AUTH_INVALID`。

必需的稳定错误代码如下：

| HTTP | 代码 | 条件 |
| --- | --- | --- |
| `400` | `INVALID_JSON` | 请求体不是有效的 JSON |
| `400` | `INVALID_ID` | 路径或精确 ID 查询值不是 UUID |
| `400` | `INVALID_CURSOR` | 游标格式错误或对该查询不再有效 |
| `400` | `IDEMPOTENCY_KEY_REQUIRED` | 写入操作省略了 `Idempotency-Key` |
| `400` | `INVALID_IDEMPOTENCY_KEY` | 键不符合文档化格式 |
| `401` | `ADMIN_AUTH_REQUIRED` | 管理员变更操作省略了授权 |
| `401` | `ADMIN_AUTH_INVALID` | 管理员授权无效 |
| `404` | `WAREHOUSE_NOT_FOUND` | 被寻址的仓库不存在 |
| `404` | `SKU_NOT_FOUND` | 被寻址的 SKU 不存在 |
| `404` | `ORDER_NOT_FOUND` | 被寻址的订单不存在 |
| `409` | `WAREHOUSE_CODE_CONFLICT` | 仓库代码已存在 |
| `409` | `SKU_CODE_CONFLICT` | SKU 代码已存在 |
| `409` | `STOCK_BELOW_RESERVED` | 请求的现有库存值低于预留库存 |
| `409` | `NO_SINGLE_WAREHOUSE_CAPACITY` | 没有仓库可以满足每个订单行 |
| `409` | `ORDER_NOT_CANCELLABLE` | 订单已发货 |
| `409` | `IDEMPOTENCY_CONFLICT` | 作用域键被用于不同的输入 |
| `415` | `UNSUPPORTED_MEDIA_TYPE` | 请求体未使用 JSON 内容类型 |
| `422` | `VALIDATION_ERROR` | JSON 不满足端点模式 |
| `503` | `DEPENDENCY_UNAVAILABLE` | 健康检查无法访问 PostgreSQL |

### 6.2 幂等性

每个写入端点都需要一个 `Idempotency-Key` 标头，包含 8 到 128 个可打印 ASCII 字符。缺少键返回 HTTP `400` 和 `IDEMPOTENCY_KEY_REQUIRED`；无效键返回 HTTP `400` 和 `INVALID_IDEMPOTENCY_KEY`。

该键作用于具体操作和资源。对不同的操作或资源重用相同的文本是允许的。使用相同键和语义相同输入重复相同的作用域操作必须重放原始 HTTP 状态和响应体，而不重复副作用。使用相同的作用域键但输入不同返回 HTTP `409` 和 `IDEMPOTENCY_CONFLICT`。

JSON 对象属性顺序和无关紧要的空白不影响语义身份。订单行数组顺序也不影响语义身份，因为订单中的 SKU ID 是唯一的。所有其他值根据其验证后的 JSON 含义进行比较。

并发相同请求必须收敛到相同结果，包括生成的 ID 和时间戳。幂等性必须在 API 重启后仍然存在，跨 API 实例工作，并保护在未知响应结果后重试的客户端。到达业务评估的有效请求必须持久重放其原始结果，包括领域 `409` 结果，例如 `NO_SINGLE_WAREHOUSE_CAPACITY`。传输、内容类型、JSON 解析、身份验证、缺少键和键格式失败发生在业务评估之前，不需要创建重放记录。

### 6.3 端点摘要

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

`GET /api/health` 仅当该 API 进程可以服务请求并访问其数据库时返回 HTTP `200` 和 `{"status":"ok"}`。否则返回 HTTP `503` 和 `DEPENDENCY_UNAVAILABLE`。

所有分页端点使用：

```json
{
  "items": [],
  "nextCursor": null
}
```

### 6.4 仓库、SKU 和库存端点

管理员变更操作除了 `Idempotency-Key` 外，还需要 `Authorization: Bearer <ADMIN_TOKEN>`。

创建仓库请求：

```json
{
  "code": "SHA-01",
  "name": "Shanghai Primary",
  "priority": 10
}
```

规则：

- `code`：大写 ASCII 字母、数字和单个连字符；长度 `2..32`；全局唯一；
- `name`：非空白字符串；修剪后长度 `1..120`；
- `priority`：整数 `0..1000000`。

成功创建返回 HTTP `201`：

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

重复代码返回 HTTP `409` 和 `WAREHOUSE_CODE_CONFLICT`。

创建 SKU 请求：

```json
{
  "code": "KEYBOARD-01",
  "name": "Compact Keyboard"
}
```

规则：

- `code`：大写 ASCII 字母、数字、句点、下划线和连字符；长度 `2..64`；全局唯一；
- `name`：非空白字符串；修剪后长度 `1..160`。

成功创建返回 HTTP `201`：

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

重复代码返回 HTTP `409` 和 `SKU_CODE_CONFLICT`。

针对 `PUT /api/admin/inventory/{warehouseId}/{skuId}` 的设置库存请求：

```json
{
  "onHand": 500
}
```

`onHand` 必须是整数 `0..1000000000`。该操作创建缺失的库存位置或更新现有位置，而不更改其当前 `reserved` 数量。低于 `reserved` 的值返回 HTTP `409` 和 `STOCK_BELOW_RESERVED`。成功返回 HTTP `200` 及库存位置：

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

`GET /api/warehouses` 接受 `q`、`limit` 和 `cursor`。搜索对代码和名称不区分大小写。结果按优先级升序，然后按 ID 升序排列。

`GET /api/skus` 接受 `q`、`limit` 和 `cursor`。搜索对代码和名称不区分大小写。结果按代码升序，然后按 ID 升序排列。

`GET /api/inventory` 接受 `q`、`warehouseId`、`skuId`、`limit` 和 `cursor`。`q` 对 SKU 代码和名称进行不区分大小写的搜索。精确过滤器可以组合。结果按仓库优先级、仓库 ID、SKU 代码和 SKU ID 全部升序排列。每个项目使用上面显示的 `stockPosition` 字段，并且还包括 UI 所需的仓库代码和 SKU 代码：

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

### 6.5 订单端点

创建订单请求：

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

规则：

- `customerReference`：非空字符串；修剪后长度为 `1..100`；
- `lines`：数组长度为 `1..8`；
- `skuId`：现有 SKU UUID，在订单内唯一；
- `quantity`：整数 `1..1000000`。

成功创建返回 HTTP `201`。订单响应使用以下形状：

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

订单行响应按 SKU ID 升序排列。`status` 为 `ALLOCATED`、`SHIPPED` 或
`CANCELLED`。履约 `status` 为 `PENDING`、`SHIPPED` 或 `CANCELLED`。已发货的履约具有：

```json
{
  "id": "88888888-8888-4888-8888-888888888888",
  "shippedAt": "2026-08-05T08:00:02.000Z"
}
```

作为其 `shipment` 值。其他履约状态具有 `shipment: null`。

`GET /api/orders` 接受 `customerReference`、`status`、`warehouseId`、`limit` 和 `cursor`。精确
筛选条件可以组合。结果按 `createdAt` 降序，然后按 ID 降序排列。

`GET /api/orders/{orderId}` 返回相同的订单形状。

`POST /api/orders/{orderId}/cancel` 没有请求体。取消已分配或已取消的
订单返回 HTTP `200` 及最终订单。取消已发货的订单返回 HTTP `409` 和
`ORDER_NOT_CANCELLABLE`。

### 6.6 出站 Webhook 契约

每次投递使用以下标头：

```text
Content-Type: application/json
X-ParcelFlow-Event-Id: <eventId>
X-ParcelFlow-Event-Type: <type>
```

JSON 主体为：

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

事件类型为：

- `order.allocated`，序列 1：`data` 包含 `orderId`、`fulfillmentId`、`warehouseId` 以及所有
  按 SKU ID 排序的已分配 `lines`；
- `order.shipped`，序列 2：`data` 包含 `orderId`、`fulfillmentId`、`warehouseId`、
  `shipmentId` 和 `shippedAt`；
- `order.cancelled`，序列 2：`data` 包含 `orderId`、`fulfillmentId`、`warehouseId` 和
  `cancelledAt`。

`X-ParcelFlow-Event-Id` 和 `X-ParcelFlow-Event-Type` 值必须与 JSON 主体匹配。事件主体
拒绝仅实现字段，且不得包含凭据或内部路径。

## 7. 种子文件契约

实现：

```sh
npm run seed -- --file /absolute/path/to/seed.v1.json
```

该命令使用以下版本化 JSON 形状导入空数据库：

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

导入器必须：

- 拒绝未知字段、不支持的架构版本、重复 ID、重复代码、重复
  仓库/SKU 库存位置、订单内重复 SKU 行、无效值、缺失
  引用以及 `shippedAt < createdAt` 的时间戳；
- 在提交任何业务数据之前验证完整文件；
- 失败时不做任何部分数据库更改；
- 拒绝导入到非空应用程序表；
- 将每个列出的历史订单导入为 `SHIPPED`，并附带一个已完成的履约和发货；
- 将库存位置 `onHand` 视为所有历史活动后的当前物理数量，并初始化每个
  `reserved` 数量为零；
- 避免为历史导入创建派发任务、领域事件或 Webhook 投递；
- 成功时打印一行 JSON 摘要，包含 `schemaVersion`、`warehouses`、`skus`、
  `stockPositions`、`orders` 和 `orderLines` 计数；
- 失败时向 stderr 打印简明诊断信息并以非零状态退出；
- 在目标环境中处理至少 100 个仓库、20000 个 SKU、1000000 个库存位置、200000 个历史订单
  和 1000000 个历史订单行。

导入器必须支持符合此公共架构的任何数据，无论数组顺序或
具体值如何。种子 ID 和值必须通过与运行时创建的数据相同的公共查询 API 可观察。

## 8. 浏览器应用程序

针对真实 API 提供以下用户可见流程：

- 仓库和 SKU 目录浏览，支持搜索、游标分页、加载、空和错误
  状态；
- 库存浏览，支持仓库、SKU 和文本筛选，并显示可见的现有量、预留量和
  可用量；
- 订单编辑器，包含客户参考和 1 到 8 个可访问的 SKU/数量行；
- 清晰的分配成功，显示所选仓库和每个接受的订单行；
- 清晰的 `NO_SINGLE_WAREHOUSE_CAPACITY`、验证、幂等冲突和意外错误
  反馈，不假装失败的订单存在；
- 订单详情视图，在 `ALLOCATED` 期间自动刷新，然后显示发货或
  取消详情；
- 取消操作，具有清晰的成功、冲突、禁用和重试状态；
- 可搜索/可筛选的订单历史记录，并在完全刷新后导航回持久订单；
- 在 390px 和 1280px 视口宽度下可用的布局；
- 可通过键盘操作的控制、关联标签、可见焦点和有意义的状态公告。

不要在浏览器代码中暴露 `ADMIN_TOKEN`。测试设置可以在打开操作员 UI 之前通过管理员 API
创建目录和库存记录。

## 9. 项目拥有的自动化测试

### 9.1 单元测试

涵盖聚焦的纯行为，如验证、确定性仓库选择、状态转换
决策、事件负载构建和重试分类。仅单元测试不足以
完成。

### 9.2 集成测试

`npm run test:integration` 必须使用 `TEST_DATABASE_URL`、真实迁移、真实 PostgreSQL 数据库、
真实 HTTP 服务器、工作进程、派发进程和本地 Webhook 接收进程（如相关）。不要
模拟 PostgreSQL、用仓库调用替换 HTTP，或用函数调用替换派发接收器。

至少涵盖输入验证、种子验证和原子性、目录 API、单仓库
选择、多行分配原子性、持久幂等性、发货结算、取消、
事件事务性、Webhook 重试和每订单事件顺序。

### 9.3 浏览器端到端测试

`npm run test:e2e` 必须构建并启动生产应用程序，准备隔离的 PostgreSQL 数据，
启动真实工作进程和派发进程，并通过真实浏览器 UI 驱动 Chromium。它必须涵盖：

1. 浏览目录和库存，组合多 SKU 订单，观察分配，并观察发货；
2. 创建没有完整单仓库容量的订单并观察原子失败；
3. 创建并取消已分配订单，然后观察恢复的可用库存；
4. 刷新已分配或已完成的订单并从持久服务器状态继续；
5. 浏览和筛选历史及运行时创建的订单。

### 9.4 并发测试

`npm run test:concurrency` 必须向两个 API 进程发送真实 HTTP 请求，并运行两个工作
进程共享一个数据库。至少涵盖热库存争用、并发相同和
冲突的幂等请求、两个工作进程竞争履约，以及取消与
发货竞争。通过公共 API 断言最终状态并验证所有业务不变量。

### 9.5 崩溃和恢复测试

`npm run test:recovery` 必须使用真实进程和 `SIGKILL`，而不是模拟异常。它必须
演示以下情况下的恢复：

1. 工作进程在领取派发任务后但在发货提交前死亡；
2. 工作进程在完成前后死亡，另一个工作进程尝试同一任务；
3. 派发进程在接收器接受事件后但在本地投递进度
   已知前死亡，允许重复但绝不允许更改或丢失事件；
4. API、工作进程和派发进程全部停止并重启，且有已提交工作待处理；
5. 客户端丢失订单创建响应并通过另一个 API 实例重试。

测试可以使用确定性的、仅测试的进程屏障，但不得添加生产调试路由、
削弱生产事务边界，或使正确性依赖于这些屏障。

### 9.6 测试隔离

测试必须准备、迁移、种子化并清理自己的隔离数据。它们不得依赖执行
顺序、开发数据、外部网络访问、此仓库之外的文件、固定示例 ID
或时序运气。通过的脚本必须包含有意义的断言；仅启动进程或
从嵌套占位符接收退出代码零是不够的。

## 10. 性能目标

目标环境具有 4 个 vCPU、8 GiB 内存、本地 PostgreSQL 16、两个 API 进程、两个工作
进程、一个派发进程和一个本地 Webhook 接收器。测试生产构建。预热每个
延迟/吞吐量场景 15 秒，然后测量 90 秒。每个场景运行
三次并评估中位数运行。

大数据集包含 100 个仓库、20000 个 SKU、1000000 个库存位置、200000 个历史
订单和 1000000 个历史订单行。

### 10.1 目录和历史查询

64 个并发客户端对大数据集发出分页库存、SKU 搜索、订单历史和订单详情
请求：

- 聚合查询 `p95 <= 250 ms`；
- 吞吐量至少为每秒 250 个已完成请求。

### 10.2 热库存变更

8 个仓库、32 个热 SKU 和 200 个并发客户端发出持续混合的多行
订单创建、符合条件的取消和公共读取：

- 变更 `p95 <= 750 ms`；
- 聚合吞吐量至少为每秒 120 个已完成请求；
- 成功的订单创建和取消响应总计至少每秒 60 个。

预期的产品冲突被计数和报告，但不视为成功的变更。

### 10.3 工作进程和出站箱恢复积压

从 5000 个到期派发任务和 5000 个到期出站箱投递开始。运行两个工作进程和派发进程。
接收器在前 10 秒返回 HTTP `503`，然后返回 HTTP `204`。

从第一个`204`响应开始衡量恢复情况。在60秒内，至少95%的5000个订单必须完成发货，并且所有相应的分配和发货事件必须成功送达。在120秒内，全部5000个订单必须完成发货，且所有相应事件均已送达。

### 10.4 报告与正确性

在任何场景下，意外的HTTP `5xx`响应必须为零。预期的文档化产品冲突不属于服务器错误。每次负载运行后，所有业务不变量必须仍然成立。

`npm run test:perf`必须以机器可读的JSON格式报告数据集大小、进程数、预热时间、持续时间、并发数、吞吐量、成功与状态计数、Webhook尝试/重复计数、积压进度以及p50/p95/p99延迟，并附上简明的人类可读摘要。当目标或负载后不变量失败时，它必须以非零状态退出。

## 11. 交付要求

在交接之前：

- 使用最终架构和任何已批准的变更更新本README；
- 保持`openapi.yaml`与行为同步，包括出站Webhook；
- 在干净的数据库上运行迁移和版本化种子数据；
- 运行`npm run build`、`npm run test:all`和`npm run test:perf`；
- 验证两个API进程、两个工作进程、重启恢复以及本地Webhook投递；
- 移除仅用于调试的路由、硬编码的测试数据、密钥、生成的报告和临时文件；
- 报告确切的命令和结果，以及任何剩余风险或未满足的要求。

## 12. 不在范围内

除管理员令牌外，不要添加身份验证、支付、承运商集成、标签生成、退货、采购、仓库调拨、库存预测、消息代理、分布式追踪基础设施、托管服务或无关的管理员功能。构建完全满足本合同的最小系统。
