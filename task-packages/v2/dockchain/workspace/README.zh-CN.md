# DockChain

从本刻意留空的仓库构建 DockChain。本 README 是完整的产品契约。请勿在契约之外发明行为。在做出契约未明确规定的产品决策之前，请先询问。

## 必需技术栈

- Node.js 22、TypeScript、React、PostgreSQL 16、npm 以及预装的 Chromium。
- PostgreSQL 是业务状态、幂等性、租约、事件和排序的唯一权威来源。
- 生产环境 UI 必须使用公共 HTTP API；不得使用模拟数据、内存数据库或仅浏览器状态来提供正确性。
- 使用整数领域数量和 UTC ISO-8601 时间戳。不得对金额、容量、序列、持续时间单位或守恒量使用浮点数。

## 必需的非交互式命令

| 命令 | 契约 |
| --- | --- |
| 'npm run db:migrate' | 重复且安全地应用所有版本化迁移。 |
| 'npm run db:seed -- --file <path>' | 原子导入版本化 JSON 种子数据。 |
| 'npm run dev' | 启动开发环境 API 和 UI。 |
| 'npm run build' | 生成生产环境 API、worker、dispatcher 和 UI 资产。 |
| 'npm run start:api' | 启动一个生产环境 API/UI 进程。 |
| 'npm run start:worker' | 启动一个 Clearance Task worker。 |
| 'npm run start:dispatcher' | 启动 Domain Event webhook dispatcher。 |
| 'npm run test:unit' | 运行纯逻辑和边界测试。 |
| 'npm run test:integration' | 运行真实 PostgreSQL 加公共 HTTP 集成测试。 |
| 'npm run test:e2e' | 通过可见控件运行生产构建的 Chromium 测试。 |
| 'npm run test:concurrency' | 针对一个数据库运行至少两个 API 和两个 worker 进程。 |
| 'npm run test:recovery' | 使用可观察屏障、SIGKILL、重启和持久恢复。 |
| 'npm run test:all' | 从干净数据库运行上述所有非性能门禁。 |
| 'npm run test:perf' | 运行固定持续负载并验证所有负载后不变量。 |

每个命令在失败时以非零状态退出，清理自身子进程，且无需任何提示。

## 环境变量

| 变量 | 默认值 | 规则 |
| --- | --- | --- |
| 'DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/dockchain' | 生产/开发环境权威来源。 |
| 'TEST_DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/dockchain_test' | 所有有状态测试必需。 |
| 'PORT' | '3000' | 整数 1-65535；API 和生产 UI 来源。 |
| 'ADMIN_TOKEN' | 任务本地值 | 仅文档化的管理变更路由需要；切勿记录。 |
| 'WEBHOOK_URL' | 'http://127.0.0.1:4010/events' | Domain Event 投递的 HTTP 端点。 |
| 'WORK_LEASE_SECONDS' | '3' | 整数 1-60；worker 和恢复测试使用的持久租约时长。 |
| 'CHROMIUM_PATH' | '/usr/bin/chromium' | 项目自有 E2E 的浏览器可执行文件。 |
| 'MANAGED_DATA_ROOT' | '/tmp/dockchain-data' | 暂存或生成字节的可写根目录；切勿直接提供路径。 |
| 'TEST_BARRIER_URL' | 空 | 仅受控恢复测试使用的可选 localhost HTTP 接收器。 |
| 'TEST_BARRIER_TOKEN' | 空 | 设置 URL 时必需的屏障头值；切勿记录。 |

仅绑定到 '127.0.0.1'。日志不得包含令牌、幂等键、原始种子输入、webhook 请求体或私有绝对路径。

## 领域和 V1 行为

| 术语 | 规范定义 | 避免 |
| --- | --- | --- |
| Berth | 具有船舶尺寸限制和可用性日历的码头位置。 | Dock、slot |
| Tug Pool | 在移动区间内保留的整数容量资源。 | Boat list、worker |
| Yard Window | 具有集装箱吞吐量容量的区间。 | Storage slot、appointment |
| Port Call | 一次船舶到达，使用一个 Berth、拖轮容量和堆场容量。 | Booking、shipment |
| Clearance Task | 持久的租约验证，将持有的 Port Call 移至 CLEARED。 | Job、approval |
| Standby Entry | 当精确资源组合可用时被提升的优先级请求。 | Waitlist、queue |

Port Call：HELD -> CLEARED -> IN_SERVICE -> COMPLETED，或 HELD/CLEARED -> CANCELLED/EXPIRED。

1. 使用船舶尺寸、Berth 规则、Tug Pool 容量和 Yard Window 容量搜索可行窗口。
2. 为 Port Call 原子持有所有必需资源，并持久地使未确认的持有过期。
3. 在服务开始前运行可恢复的 Clearance Task。
4. 以唯一合法结果解决取消、过期、清关和开始服务的竞争。
5. 按优先级、requestedAt 和 ID 提升 Standby Entry，不得部分分配。

### 确定性策略

1. Port Call 区间为半开区间，对齐到 15 分钟，持续 60..1440 分钟，并且必须满足 Berth 船舶尺寸规则以及整个区间的 Tug Pool 和 Yard Window 容量。
2. 按优先级再 berthId 选择第一个可行 Berth，按优先级再 tugPoolId 选择 Tug Pool，按优先级再 yardWindowId 选择 Yard Window；在一个事务中保留全部三个。
3. 持有在数据库事务时间戳后 180 秒过期。清关仅在确认后开始，并检查 Port Call 捕获的不可变船舶/资源快照。
4. Standby 顺序为优先级降序、requestedAt 升序、standbyEntryId 升序。以 15 分钟增量搜索到达候选，且不得在同等优先级内绕过不可行的队首。

## 强制不变量

1. 一个 Berth 在同一时刻最多服务一个活动 Port Call。
2. 保留的拖轮和堆场容量不得超过区间容量，且不得变为负数。
3. 一个 Port Call 持有其完整的 Berth/拖轮/堆场组合，或不持有任何资源。
4. 每个 Clearance Task 最多成功一次，且一个 Port Call 最多开始服务一次。
5. Standby 排序是确定性的，且在其优先级类内不得绕过不可行的队首。

这些不变量必须在成功、验证失败、未知 HTTP 结果、重复请求、并发请求、worker 或 dispatcher SIGKILL、重启、迁移和持续负载之后仍然成立。

## HTTP 和 OpenAPI 3.1

在 'GET /openapi.json' 提供规范 OpenAPI，在 'GET /healthz' 提供健康检查。OpenAPI 文档和运行时行为必须一致。API 路由使用 JSON，除非明确文档化的原始内容。对不支持的媒体类型返回 415 'UNSUPPORTED_MEDIA_TYPE'，对格式错误的 JSON 返回 400 'MALFORMED_JSON'，对未知对象键返回 400 'UNKNOWN_FIELD'，对没有更具体已发布代码的形状或范围违规返回 400 'INVALID_REQUEST'。语义或状态冲突使用其已发布的 409 代码。在文档化的 ADMIN_TOKEN 路由上，缺失、格式错误或不正确的 Bearer 令牌返回 401 'ADMIN_AUTH_REQUIRED'。

成功的分页集合读取返回 '{items,nextCursor}'。'limit' 默认为 50，为 1 到 100 的整数。游标顺序稳定且不透明；格式错误的游标返回 400 'INVALID_CURSOR'。类型为 'uuid' 的字段是小写 UUID 字符串；无类型字符串标识符保留其已发布的语法。时间戳为 UTC，带尾随 'Z'。资源未命中返回 404 'NOT_FOUND'。

错误精确使用：

~~~json
{"error":{"code":"STABLE_CODE","message":"human-readable text","details":{}}}
~~~

以下线符号是规范性的：'uuid' 是小写 RFC 4122 文本，'int' 是 JSON 安全整数，'timestamp' 是带毫秒精度和尾随 Z 的 UTC ISO-8601，'date' 是严格 YYYY-MM-DD，'sha256' 是 64 位小写十六进制，'currency' 是三个大写 ASCII 字母，'json' 是 RFC 8785 接受的任何值。'http-url' 是不含凭据或片段的绝对 http 或 https URL。'interval' 恰好是 '{startAt:timestamp,endAt:timestamp}'，startAt 在 endAt 之前，表示半开区间 '[startAt,endAt)'。'|null' 字段是必需的且可为空。每个未列出的字段都被拒绝，数组保持其声明的顺序。响应精确使用这些资源形状：

- PortCall = {portCallId:uuid,vesselId:uuid,arrivalAt:timestamp,departureAt:timestamp,requiredTugs:int,containerUnits:int,berthId:uuid,tugPoolId:uuid,yardWindowId:uuid,state:HELD|CLEARED|IN_SERVICE|COMPLETED|CANCELLED|EXPIRED,expiresAt:timestamp,startedAt:timestamp|null,completedAt:timestamp|null,sequence:int}
- ResourceAllocation = {resourceType:BERTH|TUG_POOL|YARD_WINDOW,resourceId:uuid,startAt:timestamp,endAt:timestamp,quantity:int}
- FeasibleWindowPage = {items:[{arrivalAt:timestamp,departureAt:timestamp,berthId:uuid,tugPoolId:uuid,yardWindowId:uuid}],nextCursor:string|null}
- StandbyEntry = {standbyEntryId:uuid,vesselId:uuid,arrivalFrom:timestamp,arrivalTo:timestamp,durationMinutes:int,requiredTugs:int,containerUnits:int,priority:int,state:WAITING|PROMOTED|WITHDRAWN,requestedAt:timestamp,portCallId:uuid|null}
- Clearance = {portCallId:uuid,taskId:uuid,attempt:int,state:PENDING|LEASED|PASSED|FAILED,checkedRules:[string],completedAt:timestamp|null}

公共聚合路由为：

- 'GET /api/v1/port-calls?limit&cursor' 和
  'GET /api/v1/port-calls/:portCallId'。
- POST /api/v1/port-calls，请求体为 {vesselId,arrivalAt,departureAt,requiredTugs,containerUnits}；原子性地返回 201 HELD（含分配的泊位和 expiresAt）或 409 WINDOW_UNAVAILABLE。
- POST /api/v1/port-calls/:portCallId/confirm，请求体为 {}，仅在 HELD 状态且未超过 expiresAt 时合法，并调度一个清关任务；在 expiresAt 或之后调用则原子性地过期并返回 PORT_CALL_EXPIRED，而任何其他状态返回 PORT_CALL_STATE_CONFLICT。
- POST /api/v1/port-calls/:portCallId/start-service，请求体为 {}，仅从 CLEARED 状态返回 IN_SERVICE，从 HELD 状态返回 CLEARANCE_REQUIRED，从所有其他状态返回 PORT_CALL_STATE_CONFLICT。
- POST /api/v1/port-calls/:portCallId/cancel，请求体为 {reason}，是幂等的，并且仅释放一次未消耗的容量。
- POST /api/v1/port-calls/:portCallId/complete，请求体为 {}，仅从 IN_SERVICE 状态返回 COMPLETED，否则返回 PORT_CALL_STATE_CONFLICT。
- POST /api/v1/standby-entries，请求体为 {vesselId,arrivalFrom,arrivalTo,durationMinutes,requiredTugs,containerUnits,priority}，返回 201 WAITING，并带有服务器分配的 requestedAt。
- GET /api/v1/port-resources/feasible-windows?vesselId&arrivalFrom&arrivalTo&durationMinutes&requiredTugs&containerUnits&limit&cursor 返回 FeasibleWindowPage，按 arrivalAt、泊位优先级再按 berthId、拖轮池优先级再按 tugPoolId、堆场窗口优先级再按 yardWindowId 排序；游标编码该完整元组。
- GET /api/v1/port-resources/schedule?from&to 返回泊位占用情况以及拖轮池和堆场窗口在 15 分钟时段内的容量/分配数量。
- 'GET /api/v1/domain-events?aggregateId&afterSequence&limit' 按顺序返回已提交的事件。
- 'GET /api/v1/verification-snapshot' 要求 'Authorization: Bearer <ADMIN_TOKEN>' 并返回一个
  可序列化的快照 '{asOf:timestamp,resources:{...},work:[Work],events:[DomainEvent]}'。

### V1 验证快照

完整快照从单个 PostgreSQL 时间点读取；'asOf'、每个资源数组、'work'
和 'events' 必须描述同一个数据库快照。V1 'resources' 对象恰好具有以下键
且无其他键：

- 'berths' 使用精确形状 'Berth = {berthId:uuid,name:string,priority:int,maxLengthMeters:int,availability:[{startAt:timestamp,endAt:timestamp}]}'，并按标量字段路径元组 'berthId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。
- 'tugPools' 使用精确形状 'TugPool = {tugPoolId:uuid,name:string,priority:int,capacity:int,availability:[{startAt:timestamp,endAt:timestamp}]}'，并按标量字段路径元组 'tugPoolId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。
- 'yardWindows' 使用精确形状 'YardWindow = {yardWindowId:uuid,priority:int,capacityUnits:int,startAt:timestamp,endAt:timestamp}'，并按标量字段路径元组 'yardWindowId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。
- 'vessels' 使用精确形状 'Vessel = {vesselId:uuid,name:string,lengthMeters:int}'，并按标量字段路径元组 'vesselId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。
- 'portCalls' 使用精确形状 'PortCall'，并按标量字段路径元组 'portCallId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。
- 'resourceAllocations' 使用精确形状 'ResourceAllocation'，并按标量字段路径元组 'resourceType'、'resourceId'、'startAt'、'endAt' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。
- 'standbyEntries' 使用精确形状 'StandbyEntry'，并按标量字段路径元组 'standbyEntryId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。
- 'clearances' 使用精确形状 'Clearance'，并按标量字段路径元组 'portCallId'、'taskId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。

每个资源数组恰好包含其声明形状所命名的每个当前或不可变实例一次。每个列出的排序路径都解析为标量。标量顺序为 null 优先，然后 false 在 true 之前，整数按数值排序，所有其他字符串形式标量按 UTF-8 字节排序。按完整元组升序排序，然后仅使用 RFC 8785 规范 JSON 作为决胜条件。
递归省略每个名称以 'Token' 结尾的对象字段，在所有嵌套深度。

'Work' 恰好是
'{workId:uuid,kind:PORT_CALL_EXPIRY|CLEARANCE|STANDBY_PROMOTION,aggregateId:uuid,state:PENDING|LEASED|SUCCEEDED|FAILED|CANCELLED,terminal:boolean,attempt:int,leaseOwner:string|null,leaseExpiresAt:timestamp|null}'。
'kind' 恰好是 'PORT_CALL_EXPIRY'、'CLEARANCE'、'STANDBY_PROMOTION' 之一。两个租约字段仅在
状态为 'LEASED' 时非空，在所有其他状态下均为 null。'terminal' 仅在状态为
'SUCCEEDED'、'FAILED' 或 'CANCELLED' 时为 true；终端工作被保留。
当没有匹配的工作具有 'terminal:false' 时，积压工作恰好被排空。'work' 数组按
workId 排序。

'events' 包含精确的领域事件对象，按 aggregateId、然后 sequence、然后 eventId 排序。对每个事件负载应用
相同的递归 '*Token' 省略。省略身份验证和业务围栏令牌、幂等键、原始 webhook 主体、私有文件系统路径和机密。这是
外部不变量查询面。

以下领域错误对于格式良好的请求是穷尽的，除了上述发布的常见错误以及 400 'INVALID_REQUEST'、400 'INVALID_CURSOR'、404 'NOT_FOUND' 和 409
'IDEMPOTENCY_CONFLICT'：

| HTTP | 代码 | 精确触发条件 |
| ---: | --- | --- |
| 409 | WINDOW_UNAVAILABLE | 没有完整的泊位、拖轮池和堆场窗口组合可匹配 |
| 409 | PORT_CALL_EXPIRED | 确认发生在 expiresAt 或之后 |
| 409 | CLEARANCE_REQUIRED | 在 CLEARED 之前请求开始服务 |
| 409 | PORT_CALL_NOT_CANCELLABLE | 服务已开始或港口调用处于终态 |
| 409 | PORT_CALL_STATE_CONFLICT | 在当前非过期状态下，确认、开始服务或完成是非法的 |
| 400 | INVALID_PORT_CALL_INTERVAL | 对齐、顺序、持续时间或数量无效 |

### 持久幂等性

每个变更操作都要求 'Idempotency-Key'，1-128 个可见 ASCII 字符。作用域为方法、规范
路径和键。在确认成功之前，持久化规范语义请求
指纹和完整的状态/主体。相同的重试，包括
在重启或未知响应丢失后，返回原始状态和语义 JSON，且无第二次
效果。使用不同语义重用键返回 409 'IDEMPOTENCY_CONFLICT'。并发相同的
请求收敛于一个结果；进程本地映射不是权威。在基准测试期间不要过期记录，
或在迁移期间重写保存的重放主体。

## 种子契约

'npm run db:seed -- --file <path>' 恰好接受：

'{schemaVersion:1,seedVersion,berths,tugPools,yardWindows,vessels,portCalls,standbyEntries}; UTC intervals are half-open, resource priorities are unique, and all quantities are bounded integers.'

成员模式是精确的：

- berths[] = {berthId:uuid,name:string,priority:int,maxLengthMeters:int,availability:[interval]}
- tugPools[] = {tugPoolId:uuid,name:string,priority:int,capacity:int,availability:[interval]} 和 yardWindows[] = {yardWindowId:uuid,priority:int,capacityUnits:int,startAt:timestamp,endAt:timestamp}
- vessels[] = {vesselId:uuid,name:string,lengthMeters:int}；种子 portCalls[] 使用精确的 PortCall 模式，所有资源总计必须对账
- standbyEntries[] 使用精确的 StandbyEntry 模式；PROMOTED 条目引用其唯一的港口调用，requestedAt 参与已发布的顺序

'seedVersion' 是一个非空字符串，最多 64 个字符。导入器记录规范文件摘要。
相同版本和摘要是无操作重放；相同版本但内容不同则失败并返回
'SEED_VERSION_CONFLICT'。拒绝未知键、重复 ID、缺失引用、无效状态、破坏的
不变量、超出范围的整数和格式错误的时间。任何无效成员都会拒绝完整导入，
而不更改业务行、任务、幂等性或领域事件。

## 工作进程、事件和恢复

工作进程使用 'WORK_LEASE_SECONDS' 声明有界持久租约。租约所有权必须在
提交结果的短事务内再次证明。在等待
HTTP、文件、时钟或另一个进程时，不要持有数据库事务。过期的租约可以被重新声明，但过期的令牌不能提交。

业务状态及其领域事件在一个事务中提交。事件字段为 'eventId'、'aggregateId'、
正整数 'sequence'、'type'、'occurredAt'、'schemaVersion:1' 和 'payload'。必需的事件类型：
`port-call.held`、`port-call.cleared`、`port-call.started`、`port-call.completed`、`port-call.cancelled`、`port-call.expired`、`standby.created`、`standby.promoted`。'payload' 对于每个 V1 事件恰好是 '{}'；后续的管理器事件也使用 '{}'，除非
其发布的契约字面上提供另一种负载形状。回滚不产生事件。序列
按聚合连续。

调度器发送带有 'X-DockChain-Event-Id' 和 'X-DockChain-Event-Type' 的 JSON。网络错误、
超时和非 2xx 响应以有界退避无限重试。每次重试保持相同的
eventId 和语义主体。成功投递顺序是递增的聚合序列。至少一次
投递可能重复请求；它不得发明另一个事件身份。

### 受控恢复屏障

当 'TEST_BARRIER_URL' 为空时，不存在屏障请求。当两个测试变量都设置时，工作进程
在 'worker.claimed'、'worker.effect-complete' 和 'worker.before-commit' 处继续之前 POST；调度器在 'dispatcher.response-received' 处 POST。精确的 JSON 是
'{schemaVersion:1,processRole:worker|dispatcher,point,workId,aggregateId,attempt,leaseTokenHash}'，头是
'X-Test-Barrier-Token: <TEST_BARRIER_TOKEN>'。ID 和点在重试之间保持相同；
leaseTokenHash 是令牌的 SHA-256，绝不是令牌。204 响应释放进程。保持
响应暂停进程而不打开数据库事务。连接丢失或非 204 每
100 毫秒重试一次，使用相同的主体，直到租约丢失或进程终止。仅接受 localhost URL。

## 真实 UI

提供桌面端和移动端流程，用于创建 V1 聚合、查看集合和详情、执行每个公开用户操作、观察异步清关任务进度、浏览事件和历史证据，以及在刷新后恢复。展示加载、空、验证、冲突、过期、离线/重试、终止和权限错误状态。使用可见的语义控件、键盘导航、关联标签、焦点管理和 WCAG AA 对比度。绝不要要求使用开发者工具或直接 API 调用来完成主流程。

## 项目自有验证

- 单元测试覆盖确定性策略、状态转换、规范化和边界值。
- 集成测试启动真实的 PostgreSQL 和真实的 HTTP 进程；它们绝不调用内部服务。
- 浏览器端到端测试使用生产构建、真实 Chromium、真实 API/数据库/工作进程以及可见控件。
- 并发测试使用至少两个 API 进程和两个工作进程，针对一个 PostgreSQL 数据库。
- 恢复测试使用公开的仅测试屏障，在 SIGKILL 之前观察声明/提交或接收方/ACK 边界；随机睡眠不是故障控制。
- 性能测试针对以下固定间隔运行生产构建，报告 p50/p95/p99、吞吐量、成功变更、预期冲突、意外 5xx、积压排空以及加载后不变量。

固定的 V1 兼容性能场景：

### 场景 'feasible-window-read'

- 目标：120 次可行窗口查询/秒，p95 <= 220 毫秒
- 模式：'http'
- 方法：'GET'
- 路径：'/api/v1/port-resources/feasible-windows?vesselId=:vesselId&arrivalFrom=:arrivalFrom&arrivalTo=:arrivalTo&durationMinutes=120&requiredTugs=1&containerUnits=1'
- 设置：选择至少有一个可行两小时窗口的已播种船舶；使用每艘船舶最早完整的七天可用性范围。
- 选择器：按字节轮询 vesselId；在此只读场景中范围是不可变的。
- 请求：无请求体；arrivalFrom/arrivalTo 是精确的 UTC 毫秒时间戳，相隔七天。
- 并发：64
- 预热秒数：10
- 测量秒数：60
- 成功：仅计算返回 200 且窗口在已发布候选和资源顺序中的响应。
- 阈值：60 秒内至少 120 次成功响应/秒，且 p95 <= 220 毫秒；意外 5xx = 0。
- 计时器：吞吐量窗口从预热后的第一个测量请求开始；每个延迟样本从请求分派到完整响应体结束。

### 场景 'port-call-create'

- 目标：25 次原子港口停靠创建/秒，p95 <= 700 毫秒
- 模式：'http'
- 方法：'POST'
- 路径：'/api/v1/port-calls'
- 设置：预留不相交的预热和测量船舶/时间捆绑集合，使任何请求都不会有意冲突。
- 选择器：按字节使用 vesselId 和最早剩余的可行 120 分钟窗口；requiredTugs 和 containerUnits 均为 1。
- 请求：{vesselId,arrivalAt,departureAt,requiredTugs:1,containerUnits:1}；每个请求都有新的 Idempotency-Key。
- 并发：64
- 预热秒数：10
- 测量秒数：60
- 成功：仅计算 201 HELD 响应；409 结果不计入，且每个响应必须暴露规范资源捆绑。
- 阈值：60 秒内至少 25 次成功创建/秒，且 p95 <= 700 毫秒；无容量超额订阅或意外 5xx。
- 计时器：吞吐量窗口从预热后的第一个测量请求开始；每个延迟样本从请求分派到完整响应体结束。

### 场景 'clearance-recovery'

- 目标：60 秒内恢复并清空 1,500 个任务
- 模式：'worker'
- 方法：'N/A'
- 路径：'work:CLEARANCE'
- 设置：恰好 1,500 个 HELD 港口停靠具有待处理的清关工作。将两个工作进程保持在 worker.claimed，SIGKILL，等待租约过期，然后启动两个替换进程。
- 选择器：按港口停靠创建顺序和 portCallId 声明；仅验证捕获的不可变船舶/资源快照。
- 请求：不发出测量客户端请求；设置仅使用已发布的种子和公共 API，在工作进程计时器启动之前。
- 并发：2
- 预热秒数：0
- 测量秒数：60
- 成功：所有 1,500 个停靠恰好变为 CLEARED 一次，没有清关工作保持非终止状态，过期工作进程无法提交，且每个容量不变量成立。
- 阈值：恢复积压在 <= 60 秒内排空，意外工作进程失败 = 0。
- 计时器：在两个替换工作进程生成时启动，并在证明每个后置条件的第一个时间点快照处停止。

固定性能种子：seedVersion perf-v1 恰好包含 1,000 个泊位、20 个拖轮池、20 个堆场窗口、100,000 艘船舶和 51,500 个港口停靠：50,000 个 COMPLETED 历史停靠加上 1,500 个具有待处理清关任务的 HELD 停靠。

三个场景是从新迁移的数据库和上述精确种子独立运行的；完成每个场景's Setup before its Timer begins. Mode 'http' means 'method' and 'path' 命名唯一测量的公共请求操作，'concurrency' 是精确的闭环客户端数量。模式 'worker' 表示方法 'N/A'，'path' 命名测量的工作种类，'concurrency' 是精确的工作进程数量。精确使用每个场景的选择器和请求；没有推断的混合工作负载。精确运行 'warmupSeconds' 未测量秒数，然后精确运行 'measureSeconds' 测量秒数或直到计时器声明的终止条件。有状态预热和测量身份必须不相交。延迟计数完整的 HTTP 响应体。预期发布的冲突单独报告，除非场景的成功和阈值明确计数它们。

基准容器有 4 个逻辑 CPU 和 8 GiB RAM；PostgreSQL 16、Chromium、两个 API 进程、指定的工作进程和一个调度器共享该限制。每个后续兼容二进制文件必须在不更改任何字段或阈值的情况下重新运行这三个相同场景。

意外 5xx 计数必须为零。在满足延迟或吞吐量但任何强制不变量为假的情况下，性能运行失败。

## 范围外

- 海关申报
- 货物计费
- 天气预测
- 船舶跟踪
- 跨港口路由

## 交接

保持 README 和 OpenAPI 最新。以发现优先的审查结束，并报告架构、模块和进程所有权、公共接口、成功/失败数据流、事务和租约边界、迁移、兼容性、运行的精确命令、测试和性能结果、恢复证据、已知风险以及每个未运行的检查。不要声称实际未执行的检查。
