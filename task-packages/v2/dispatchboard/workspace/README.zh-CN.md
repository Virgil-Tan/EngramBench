# DispatchBoard

从本有意留空的仓库构建 DispatchBoard。本 README 是完整的产品合同。请勿在合同之外发明行为。在做出合同未明确规定的产品选择之前，请先询问。

## 必需技术栈

- Node.js 22、TypeScript、React、PostgreSQL 16、npm 以及预装的 Chromium。
- PostgreSQL 是业务状态、幂等性、租约、事件和排序的唯一权威。
- 生产环境 UI 必须使用公共 HTTP API；不得使用模拟、内存数据库或仅浏览器状态来提供正确性。
- 使用整数领域数量和 UTC ISO-8601 时间戳。不得对金额、容量、序列、持续时间单位或守恒量使用浮点数。

## 必需的非交互式命令

| 命令 | 合同 |
| --- | --- |
| 'npm run db:migrate' | 重复且安全地应用所有版本化迁移。 |
| 'npm run db:seed -- --file <path>' | 原子导入版本化 JSON 种子数据。 |
| 'npm run dev' | 启动开发环境 API 和 UI。 |
| 'npm run build' | 生成生产环境 API、worker、dispatcher 和 UI 资源。 |
| 'npm run start:api' | 启动一个生产环境 API/UI 进程。 |
| 'npm run start:worker' | 启动一个 Offer Task worker。 |
| 'npm run start:dispatcher' | 启动 Domain Event webhook dispatcher。 |
| 'npm run test:unit' | 运行纯逻辑和边界测试。 |
| 'npm run test:integration' | 运行真实 PostgreSQL 加公共 HTTP 集成测试。 |
| 'npm run test:e2e' | 通过可见控件运行生产构建的 Chromium 测试。 |
| 'npm run test:concurrency' | 针对一个数据库运行至少两个 API 和两个 worker 进程。 |
| 'npm run test:recovery' | 使用可观察屏障、SIGKILL、重启和持久恢复。 |
| 'npm run test:all' | 从干净数据库运行上述所有非性能门禁。 |
| 'npm run test:perf' | 运行固定持续负载并验证所有负载后不变量。 |

每个命令在失败时以非零退出，清理自己的子进程，并且不需要任何提示。

## 环境

| 变量 | 默认值 | 规则 |
| --- | --- | --- |
| 'DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/dispatchboard' | 生产/开发环境权威。 |
| 'TEST_DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/dispatchboard_test' | 所有有状态测试必需。 |
| 'PORT' | '3000' | 整数 1-65535；API 和生产 UI 来源。 |
| 'ADMIN_TOKEN' | 任务本地值 | 仅用于文档化的管理变更路由；切勿记录。 |
| 'WEBHOOK_URL' | 'http://127.0.0.1:4010/events' | Domain Event 投递的 HTTP 端点。 |
| 'WORK_LEASE_SECONDS' | '3' | 整数 1-60；worker 和恢复测试使用的持久化租约时长。 |
| 'CHROMIUM_PATH' | '/usr/bin/chromium' | 项目自有 E2E 的浏览器可执行文件。 |
| 'MANAGED_DATA_ROOT' | '/tmp/dispatchboard-data' | 可写的暂存或生成字节根目录；切勿直接提供路径。 |
| 'TEST_BARRIER_URL' | 空 | 仅由受控恢复测试使用的可选 localhost HTTP 接收器。 |
| 'TEST_BARRIER_TOKEN' | 空 | 设置 URL 时必需的屏障头值；切勿记录。 |

仅绑定到 '127.0.0.1'。日志不得包含令牌、幂等键、原始种子输入、webhook 主体或私有绝对路径。

## 领域和 V1 行为

| 术语 | 规范定义 | 避免 |
| --- | --- | --- |
| Delivery | 一个带服务时间窗口的取件到送件请求。 | Order、shipment |
| Courier | 有资格获得 Offer 的注册容量所有者。 | Driver、worker |
| Offer | 邀请一个 Courier 认领一个 Delivery 的限时邀请。 | Bid、notification |
| Offer Round | 一个确定性排序的并发 Offer 组。 | Auction、batch |
| Assignment | V1 中不可变的获胜 Courier 和已接受的 Offer。 | Claim、match |
| Offer Task | 创建或过期 Offer 并启动下一轮的持久化租约工作。 | Job、timer |

Delivery：REQUESTED -> OFFERING -> ASSIGNED -> PICKED_UP -> DELIVERED，或取件前 -> CANCELLED/EXPIRED。

1. 创建 Delivery 请求，并按已发布的距离桶、容量和 ID 对符合条件的 Courier 进行排序。
2. 发布具有持久化过期时间和至少一次通知的确定性 Offer Round。
3. 原子地接受第一个合法 Offer 认领，并使所有竞争者过期，且不产生双重分配。
4. 以单一合法状态序列处理取消、取件、送件、Offer 过期和 worker 死亡。
5. 通过真实 UI 流程公开客户跟踪和 dispatcher 的 offer/assignment 历史。

### 确定性策略

1. readyAt < deliverBy，loadUnits 为 1..100，当数据库时间在取件前达到 deliverBy 时，Delivery 过期。Courier 资格要求 AVAILABLE、两个区域均允许，且 capacityUnits-activeLoadUnits >= loadUnits。
2. 按种子对称 ZoneDistance 表中的取件距离桶、activeLoadUnits 升序、courierId 对符合条件的 Courier 排序。每个 Offer Round 包含前五个未提供过 Offer 的 Courier。
3. Offer 在 round 创建后恰好 30 秒过期。第一个提交的有效接受获胜，保留 Courier 负载，将竞争 Offer 标记为 LOST，并阻止后续 round。
4. Offer 接受事务在 Offer 截止时间之前解决 Delivery 截止时间：当数据库时间 >= deliverBy 时，原子地将取件前的 Delivery 更改为 EXPIRED，使所有开放 Offer 过期，释放任何保留负载，并返回 409 DELIVERY_STATE_CONFLICT。否则，数据库时间 >= Offer.expiresAt 返回 OFFER_EXPIRED，不分配或保留负载。
5. Offer 创建捕获 Courier 的 deliveryUrl 和确切的 OfferNotification 主体；V1 Offer 的 roleIndex 和 role 为 null。每次尝试 POST 相同的 RFC 8785 JSON 主体，Content-Type 为 application/json，超时时间为 5 秒。任何 2xx 标记为 DELIVERED；在失败尝试 n（从 1 开始编号）后，持久化 nextAttemptAt = attemptCompletedAt + min(2^(n-1),8) 秒，并且不在 Offer.expiresAt 或 Offer 变为非 OPEN 之后开始尝试。
6. 如果所有 Offer 都过期，worker 按 deliveryId、round 顺序创建下一轮。取件在 deliverBy 之前合法；完成要求 PICKED_UP 和 6..64 个可见字符的 proofCode。

## 强制不变量

1. 在 V1 中，一个 Delivery 最多有一个活动 Assignment 和一次成功取件。
2. 一个 Offer 只能在其持久化的 expiresAt 之前被接受，且只能接受一次。
3. Courier 的活动分配负载永远不会超过已发布的容量。
4. 已取消的 Delivery 之后不能被取件或送件。
5. 重复或并发的 Offer Task 不能创建具有新身份的重复 round 或通知。

这些不变量必须在成功、验证失败、未知 HTTP 结果、重复请求、并发请求、worker 或 dispatcher SIGKILL、重启、迁移和持续负载之后仍然成立。

## HTTP 和 OpenAPI 3.1

在 'GET /openapi.json' 提供规范 OpenAPI，在 'GET /healthz' 提供健康检查。OpenAPI 文档和运行时行为必须一致。API 路由使用 JSON，除非明确记录的原始内容。拒绝不支持的媒体类型，返回 415 'UNSUPPORTED_MEDIA_TYPE'；拒绝格式错误的 JSON，返回 400 'MALFORMED_JSON'；拒绝未知对象键，返回 400 'UNKNOWN_FIELD'；拒绝没有更具体已发布代码的形状或范围违规，返回 400 'INVALID_REQUEST'。语义或状态冲突使用其已发布的 409 代码。在文档化的 ADMIN_TOKEN 路由上，缺失、格式错误或不正确的 Bearer 令牌返回 401 'ADMIN_AUTH_REQUIRED'。

成功的分页集合读取返回 '{items,nextCursor}'。'limit' 默认为 50，是 1 到 100 的整数。游标顺序稳定且不透明；格式错误的游标返回 400 'INVALID_CURSOR'。类型为 'uuid' 的字段是小写 UUID 字符串；未类型化的字符串标识符保留其已发布的语法。时间戳是 UTC，带尾随 'Z'。资源未命中返回 404 'NOT_FOUND'。

错误使用精确格式：

~~~json
{"error":{"code":"STABLE_CODE","message":"human-readable text","details":{}}}
~~~

以下线符号是规范性的：'uuid' 是小写 RFC 4122 文本，'int' 是 JSON 安全整数，'timestamp' 是带毫秒精度和尾随 Z 的 UTC ISO-8601，'date' 是严格的 YYYY-MM-DD，'sha256' 是 64 位小写十六进制，'currency' 是三个大写 ASCII 字母，'json' 是 RFC 8785 接受的任何值。'http-url' 是不带凭据或片段的绝对 http 或 https URL。'interval' 恰好是 '{startAt:timestamp,endAt:timestamp}'，startAt 在 endAt 之前，表示半开区间 '[startAt,endAt)'。'|null' 字段是必需且可空的。每个未列出的字段都被拒绝，数组保留其声明的顺序。响应精确使用这些资源形状：

- 配送 = {deliveryId:uuid, customerId:uuid, pickupZone:string, dropoffZone:string, readyAt:timestamp, deliverBy:timestamp, loadUnits:int, state:REQUESTED|OFFERING|ASSIGNED|PICKED_UP|DELIVERED|CANCELLED|EXPIRED, assignmentId:uuid|null, currentRound:int, createdAt:timestamp, terminalAt:timestamp|null, sequence:int}
- 报价 = {offerId:uuid, deliveryId:uuid, round:int, courierId:uuid, rank:int, state:OPEN|ACCEPTED|LOST|EXPIRED, createdAt:timestamp, expiresAt:timestamp, notificationId:uuid}
- 报价通知 = {notificationId:uuid, offerId:uuid, courierId:uuid, deliveryUrl:http-url, body:{notificationId:uuid, offerId:uuid, deliveryId:uuid, round:int, roleIndex:int|null, role:string|null, courierId:uuid, expiresAt:timestamp}, state:PENDING|DELIVERED|SUPERSEDED, attemptCount:int, nextAttemptAt:timestamp|null, successfulDeliveryAt:timestamp|null}
- 分配 = {assignmentId:uuid, deliveryId:uuid, courierId:uuid, offerId:uuid, loadUnits:int, assignedAt:timestamp, pickedUpAt:timestamp|null, completedAt:timestamp|null}
- 骑手 = {courierId:uuid, homeZone:string, capacityUnits:int, activeLoadUnits:int, eligibleZones:[string], deliveryUrl:http-url, state:AVAILABLE|PAUSED}

公共聚合路由为：

- 'GET /api/v1/deliveries?limit&cursor' 和
  'GET /api/v1/deliveries/:deliveryId'。
- POST /api/v1/deliveries，请求体为 {customerId, pickupZone, dropoffZone, readyAt, deliverBy, loadUnits}；返回 202 REQUESTED 并调度第一个报价任务。
- POST /api/v1/offers/:offerId/accept，请求体为 {courierId}，返回 ASSIGNED 或精确的 409 OFFER_EXPIRED/OFFER_LOST。
- POST /api/v1/deliveries/:deliveryId/cancel，请求体为 {reason}，仅在取件前成功，原子性地将所有未决报价标记为 LOST，恰好一次释放任何已预留的骑手负载，否则返回 409 DELIVERY_STATE_CONFLICT。
- POST /api/v1/deliveries/:deliveryId/pickup，请求体为 {courierId}，要求获胜的分配。
- POST /api/v1/deliveries/:deliveryId/complete，请求体为 {courierId, proofCode}，创建一个终态配送事实。
- GET /api/v1/deliveries/:deliveryId/offers 返回 {items:[Offer]}，先按轮次后按排名排序；GET /api/v1/couriers/:courierId 返回精确的骑手状态。
- 'GET /api/v1/domain-events?aggregateId&afterSequence&limit' 按顺序返回已提交的事件。
- 'GET /api/v1/verification-snapshot' 要求 'Authorization: Bearer <ADMIN_TOKEN>' 并返回一个可序列化的快照 '{asOf:timestamp,resources:{...},work:[Work],events:[DomainEvent]}'。

### V1 验证快照

完整快照从单个 PostgreSQL 时间点读取；'asOf'、每个资源数组、'work' 和 'events' 必须描述同一数据库快照。V1 'resources' 对象恰好具有以下键，且无其他键：

- 'zones' 使用精确形状 'Zone = {zoneId:string,name:string}'，并按标量字段路径元组 'zoneId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。
- 'zoneDistances' 使用精确形状 'ZoneDistance = {fromZone:string,toZone:string,distanceBucket:int}'，并按标量字段路径元组 'fromZone'、'toZone' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。
- 'couriers' 使用精确形状 'Courier'，并按标量字段路径元组 'courierId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。
- 'customers' 使用精确形状 'Customer = {customerId:uuid,name:string}'，并按标量字段路径元组 'customerId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。
- 'deliveries' 使用精确形状 'Delivery'，并按标量字段路径元组 'deliveryId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。
- 'offers' 使用精确形状 'Offer'，并按标量字段路径元组 'deliveryId'、'round'、'rank'、'offerId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。
- 'offerNotifications' 使用精确形状 'OfferNotification'，并按标量字段路径元组 'offerId'、'notificationId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。
- 'assignments' 使用精确形状 'Assignment'，并按标量字段路径元组 'assignmentId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。

每个资源数组恰好包含其声明形状所命名的每个当前或不可变实例一次。每个列出的排序路径解析为标量。标量顺序为 null 优先，然后 false 在 true 之前，整数按数值排序，其他所有字符串形式标量按 UTF-8 字节排序。按完整元组升序排序，然后仅以 RFC 8785 规范 JSON 作为决胜条件。递归省略每个对象字段名以 'Token' 结尾的字段，在所有嵌套深度。

'Work' 恰好是
'{workId:uuid,kind:OFFER_ISSUANCE|OFFER_EXPIRY,aggregateId:uuid,state:PENDING|LEASED|SUCCEEDED|FAILED|CANCELLED,terminal:boolean,attempt:int,leaseOwner:string|null,leaseExpiresAt:timestamp|null}'。
'kind' 恰好是 'OFFER_ISSUANCE'、'OFFER_EXPIRY' 之一。两个租约字段仅在状态为 'LEASED' 时非空，在所有其他状态下均为 null。'terminal' 仅在状态为 'SUCCEEDED'、'FAILED' 或 'CANCELLED' 时为 true；终态工作被保留。当没有匹配的工作具有 'terminal:false' 时，积压队列恰好被排空。'work' 数组按 workId 排序。

'events' 包含精确的领域事件对象，按 aggregateId、然后 sequence、然后 eventId 排序。对每个事件负载应用相同的递归 '*Token' 省略。省略认证和业务围栏令牌、幂等键、原始 webhook 主体、私有文件系统路径和机密。这是外部不变量查询面。

以下领域错误对于格式良好的请求是穷尽的，除了上述发布的常见错误以及 400 'INVALID_REQUEST'、400 'INVALID_CURSOR'、404 'NOT_FOUND' 和 409 'IDEMPOTENCY_CONFLICT'：

| HTTP | 代码 | 精确触发条件 |
| ---: | --- | --- |
| 409 | NO_ELIGIBLE_COURIER | 没有当前骑手能够适配该配送 |
| 409 | OFFER_EXPIRED | 数据库时间已达到或超过 expiresAt |
| 409 | OFFER_LOST | 另一个报价已赢得该配送 |
| 409 | COURIER_CAPACITY_CHANGED | 骑手不再具有足够的容量 |
| 409 | DELIVERY_STATE_CONFLICT | 在当前状态下取件、完成或取消是非法的 |

### 持久幂等性

每个变更操作要求 'Idempotency-Key'，1-128 个可见 ASCII 字符。作用域为方法、规范路径和键。在确认成功之前，持久化规范语义请求指纹和完整状态/响应体。相同的重试，包括重启或未知响应丢失后，返回原始状态和语义 JSON，且无第二次效果。使用相同键但不同语义返回 409 'IDEMPOTENCY_CONFLICT'。并发相同请求收敛于一个结果；进程本地映射不是权威。在基准测试期间不要使记录过期，或在迁移期间不要重写保存的重放响应体。

## 种子契约

'npm run db:seed -- --file <path>' 恰好接受：

'{schemaVersion:1,seedVersion,zones,zoneDistances,couriers,customers,deliveries,offers,offerNotifications,assignments}; capacity and load are positive integers, windows are valid UTC intervals, and eligibility references exist.'

成员模式是精确的：

- zones[] = {zoneId:string, name:string}；zoneDistances[] = {fromZone:string, toZone:string, distanceBucket:int}，且矩阵是对称且完整的
- couriers[] 使用精确的 Courier 模式；每个 activeLoadUnits 等于其 ASSIGNED 或 PICKED_UP 分配的 loadUnits 之和。customers[] = {customerId:uuid, name:string}
- deliveries[]、offers[]、offerNotifications[] 和 assignments[] 使用精确的线上模式，并且必须协调骑手活跃负载、捕获的配送 URL/主体、配送状态、轮次和截止时间

'seedVersion' 是一个非空字符串，最多 64 个字符。导入器记录规范文件摘要。相同版本和摘要是无操作重放；相同版本但不同内容失败并返回 'SEED_VERSION_CONFLICT'。拒绝未知键、重复 ID、缺失引用、无效状态、破坏的不变量、超出范围的整数和格式错误的时间。任何无效成员拒绝整个导入，而不更改业务行、任务、幂等性或领域事件。

## 工作进程、事件和恢复

工作进程使用 'WORK_LEASE_SECONDS' 声明有界持久租约。租约所有权必须在提交结果的短事务内再次证明。在等待 HTTP、文件、时钟或其他进程时，不要持有数据库事务。过期租约可重新声明，但过期令牌无法提交。

业务状态及其领域事件在一个事务中提交。事件字段为 'eventId'、'aggregateId'、正整数 'sequence'、'type'、'occurredAt'、'schemaVersion:1' 和 'payload'。必需的事件类型：`delivery.requested`、`offer.round-opened`、`delivery.assigned`、`delivery.picked-up`、`delivery.completed`、`delivery.cancelled`、`delivery.expired`。'payload' 对于每个 V1 事件恰好是 '{}'；后续 Manager 事件也使用 '{}'，除非其发布的契约明确提供另一种负载形状。回滚不产生事件。每个聚合的序列是连续的。

调度器发送带有 'X-DispatchBoard-Event-Id' 和 'X-DispatchBoard-Event-Type' 的 JSON。网络错误、超时和非 2xx 响应以有界退避无限重试。每次重试保持相同的 eventId 和语义主体。成功投递顺序是递增的聚合序列。至少一次投递可能重复请求；它不得发明另一个事件身份。

### 受控恢复屏障

当'TEST_BARRIER_URL'为空时，不存在障碍请求。当两个测试变量均被设置时，工作人员在'worker.claimed'、'worker.effect-complete'和'worker.before-commit'处继续之前先进行POST；调度器在'dispatcher.response-received'处发布。确切的JSON为'{schemaVersion:1,processRole:worker|dispatcher,point,workId,aggregateId,attempt,leaseTokenHash}'，头部为'X-Test-Barrier-Token: <TEST_BARRIER_TOKEN>'。ID和点在重试期间保持不变；leaseTokenHash是令牌的SHA-256哈希，而非令牌本身。204响应释放进程。保持响应会暂停进程，且不打开数据库事务。连接丢失或非204响应时，每100毫秒使用相同请求体重试，直到租约丢失或进程终止。仅接受localhost URL。

## 真实用户界面

提供桌面和移动端流程，用于创建V1聚合、查看集合和详情、执行每项公开用户操作、观察异步Offer任务进度、浏览事件和历史证据，以及在刷新后恢复。展示加载、空、验证、冲突、过期、离线/重试、终止和权限错误状态。使用可见的语义控件、键盘导航、关联标签、焦点管理和WCAG AA对比度。绝不允许通过开发者工具或直接API调用来完成主要流程。

## 项目自有验证

- 单元测试覆盖确定性策略、状态转换、规范化和边界值。
- 集成测试启动真实的PostgreSQL和真实的HTTP进程；它们绝不调用内部服务。
- 浏览器端到端测试使用生产构建、真实Chromium、真实API/数据库/工作人员以及可见控件。
- 并发测试使用至少两个API进程和两个工作人员，针对一个PostgreSQL数据库。
- 恢复测试使用公开的仅测试障碍来观察声明/提交或接收方/ACK边界，然后进行SIGKILL；随机睡眠不是故障控制。
- 性能测试在以下固定间隔内运行生产构建，报告p50/p95/p99、吞吐量、成功变更、预期冲突、意外5xx、积压排空和加载后不变量。

固定的V1兼容性能场景：

### 场景 'delivery-create'

- 目标：以p95 <= 300毫秒创建100个配送/秒
- 模式：'http'
- 方法：'POST'
- 路径：'/api/v1/deliveries'
- 设置：准备不相交的预热和测量的客户ID以及有效的区域对；readyAt为设置时间加10分钟，deliverBy为readyAt加60分钟。
- 选择器：按字节轮询customerId和完整的区域对；loadUnits为1。
- 请求：{customerId,pickupZone,dropoffZone,readyAt,deliverBy,loadUnits:1}，带有新的Idempotency-Key。
- 并发数：64
- 预热秒数：10
- 测量秒数：60
- 成功标准：仅202 REQUESTED响应，且每个响应恰好调度一个初始OFFER_ISSUANCE工作计数。
- 阈值：至少100次成功创建/秒持续60秒，且p95 <= 300毫秒；意外5xx = 0。
- 计时器：吞吐量窗口从预热后的第一个测量请求开始；每个延迟样本从请求发送到完整响应体结束。

### 场景 'hot-offer-claims'

- 目标：在5秒内处理200个热门配送上的1,000个竞争性Offer声明，p95 <= 350毫秒
- 模式：'http'
- 方法：'POST'
- 路径：'/api/v1/offers/:offerId/accept'
- 设置：恰好使用200个热门配送，每个配送有五个OPEN Offer。所有1,000个Offer在计时开始时均在expiresAt和deliverBy之前；历史Offer不被选择。
- 选择器：按deliveryId、round、rank、offerId顺序提交每个Offer一次，每个Offer使用自己的courierId；客户端可以竞争同一配送的Offer。
- 请求：{courierId}，每个Offer使用一个新的Idempotency-Key。
- 并发数：64
- 预热秒数：0
- 测量秒数：5
- 成功标准：每个配送恰好一个声明返回成功的Assignment结果；每个后续声明返回精确的409 OFFER_LOST。已完成尝试的吞吐量包括两个已发布的结果。
- 阈值：所有1,000个声明在<= 5秒内完成，且所有响应的p95 <= 350毫秒；恰好200个获胜者，无双重负载，意外5xx = 0。
- 计时器：吞吐量窗口从预热后的第一个测量请求开始；每个延迟样本从请求发送到完整响应体结束。

### 场景 'offer-expiry-recovery'

- 目标：在60秒内恢复并结算5,000个到期的Offer
- 模式：'worker'
- 方法：'N/A'
- 路径：'work:OFFER_EXPIRY,OFFER_ISSUANCE'
- 设置：恰好5,000个Offer到期。在worker.claimed处保持两个工作人员，SIGKILL，等待租约过期，然后启动两个替换工作人员。
- 选择器：按expiresAt、deliveryId、round、rank过期，并确定性地发出任何合法的下一轮。
- 请求：不发出测量的客户端请求；设置仅使用已发布的种子和公共API，在工作人员计时器开始之前。
- 并发数：2
- 预热秒数：0
- 测量秒数：60
- 成功标准：每个到期的Offer恰好终止一次，每个受影响的配送有一个连贯的获胜者或下一轮，Courier负载一致，且两种工作类型均不保持非终止状态。
- 阈值：所有5,000个到期的Offer在替换工作人员启动后<= 60秒内结算；陈旧提交和意外失败为零。
- 计时器：在两个替换工作人员启动时开始，并在证明所有到期Offer已结算且每个负载不变量成立的快照时停止。

固定性能种子：seedVersion perf-v1恰好包含100个区域、10,000个区域距离、10,000个快递员、100,000个客户、5,200个配送、30,000个Offer和零个分配；恰好1,000个OPEN Offer分布在200个热门配送中，每个配送最多五个，且恰好5,000个其他Offer到期。

这三个场景是从新迁移的数据库和上述精确种子独立运行的；完成每个场景's Setup before its Timer begins. Mode 'http' means '方法' and '路径'命名仅有的测量公共请求操作，'concurrency'是精确的闭环客户端数量。模式'worker'表示方法'N/A'，'path'命名测量的工作类型，'concurrency'是精确的工作人员进程数。精确使用每个场景的选择器和请求；没有推断的混合工作负载。运行精确的'warmupSeconds'未测量秒数，然后精确的'measureSeconds'测量秒数或直到计时器声明的终止条件。有状态的预热和测量身份必须不相交。计数完整的HTTP响应体以计算延迟。预期发布的冲突单独报告，除非场景的成功标准和阈值明确计数它们。

基准容器有4个逻辑CPU和8 GiB RAM；PostgreSQL 16、Chromium、两个API进程、指定的工作人员和一个调度器共享该限制。每个后续兼容二进制必须重新运行这三个相同场景，而不更改任何字段或阈值。

意外5xx计数必须为零。在满足延迟或吞吐量但任何强制不变量为假的情况下，性能运行失败。

## 范围外

- 路线优化
- 地图
- 支付
- 聊天
- 证明图像存储

## 交接

保持README和OpenAPI最新。以发现优先的审查结束，并报告架构、模块和进程所有权、公共接口、成功/失败数据流、事务和租约边界、迁移、兼容性、运行的确切命令、测试和性能结果、恢复证据、已知风险以及每个未运行的检查。不要声称实际未执行的检查。
