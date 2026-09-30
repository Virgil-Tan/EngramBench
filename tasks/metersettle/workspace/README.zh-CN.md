# MeterSettle

从本有意留空的仓库构建 MeterSettle。本 README 是完整的产品合同。请勿发明合同之外的行为。在做出合同未明确规定的产品决策之前，请先询问。

## 必需技术栈

- Node.js 22、TypeScript、React、PostgreSQL 16、npm 以及预装的 Chromium。
- PostgreSQL 是业务状态、幂等性、租约、事件和排序的唯一权威。
- 生产环境 UI 必须使用公共 HTTP API；任何模拟、内存数据库或仅浏览器端状态都不得提供正确性。
- 使用整数领域数量和 UTC ISO-8601 时间戳。不得对金额、容量、序列、时长单位或守恒量使用浮点数。

## 必需的非交互式命令

| 命令 | 合同 |
| --- | --- |
| 'npm run db:migrate' | 反复且安全地应用所有版本化迁移。 |
| 'npm run db:seed -- --file <path>' | 原子化导入版本化 JSON 种子数据。 |
| 'npm run dev' | 启动开发环境 API 和 UI。 |
| 'npm run build' | 生成生产环境 API、worker、dispatcher 和 UI 资产。 |
| 'npm run start:api' | 启动一个生产环境 API/UI 进程。 |
| 'npm run start:worker' | 启动一个 Rating Task worker。 |
| 'npm run start:dispatcher' | 启动 Domain Event webhook dispatcher。 |
| 'npm run test:unit' | 运行纯逻辑和边界测试。 |
| 'npm run test:integration' | 运行真实 PostgreSQL 加公共 HTTP 集成测试。 |
| 'npm run test:e2e' | 通过可见控件运行生产构建的 Chromium 测试。 |
| 'npm run test:concurrency' | 针对一个数据库运行至少两个 API 和两个 worker 进程。 |
| 'npm run test:recovery' | 使用可观察屏障、SIGKILL、重启和持久恢复。 |
| 'npm run test:all' | 从干净数据库运行上述所有非性能门禁。 |
| 'npm run test:perf' | 运行固定持续负载并验证所有负载后不变量。 |

每个命令在失败时以非零状态退出，清理自身的子进程，并且不需要任何提示。

## 环境

| 变量 | 默认值 | 规则 |
| --- | --- | --- |
| 'DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/metersettle' | 生产/开发环境权威。 |
| 'TEST_DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/metersettle_test' | 所有有状态测试必需。 |
| 'PORT' | '3000' | 整数 1-65535；API 和生产环境 UI 来源。 |
| 'ADMIN_TOKEN' | 任务本地值 | 仅文档化的管理变更路由需要；切勿记录。 |
| 'WEBHOOK_URL' | 'http://127.0.0.1:4010/events' | Domain Event 投递的 HTTP 端点。 |
| 'WORK_LEASE_SECONDS' | '3' | 整数 1-60；worker 和恢复测试使用的持久化租约时长。 |
| 'CHROMIUM_PATH' | '/usr/bin/chromium' | 项目自有 E2E 使用的浏览器可执行文件。 |
| 'MANAGED_DATA_ROOT' | '/tmp/metersettle-data' | 暂存或生成字节的可写根目录；切勿直接提供路径。 |
| 'TEST_BARRIER_URL' | 空 | 仅受控恢复测试使用的可选 localhost HTTP 接收器。 |
| 'TEST_BARRIER_TOKEN' | 空 | 当 URL 已设置时必需的屏障头值；切勿记录。 |

仅绑定到 '127.0.0.1'。日志不得包含令牌、幂等键、原始种子输入、webhook 主体或私有绝对路径。

## 领域和 V1 行为

| 术语 | 规范定义 | 避免 |
| --- | --- | --- |
| Meter | 租户作用域内单调标识的 Usage Event 来源。 | 计数器、设备 |
| Usage Event | 一个 Meter、eventId 和 occurredAt 时刻的不可变数量。 | 读数、请求 |
| Rate Plan | 随时间生效的整数最小货币单位定价层级版本化集合。 | 价格、费率行 |
| Statement | 一个租户和计费周期的已计费 Usage Event 聚合。 | 发票、账单 |
| Rating Task | 应用正确 Rate Plan 并最终确定 Statement 的持久化租约工作。 | 作业、定时任务 |
| Watermark | 已发布的截止点，证明哪些 occurredAt 时刻可以被最终确定。 | 当前时间 |

Statement：OPEN -> FINALIZING -> FINALIZED；已最终确定的 V1 Statement 不可变。

1. 以原子批次摄取不可变的 Usage Event，并按租户加 eventId 去重。
2. 使用 occurredAt 时刻生效的 Rate Plan 版本，以整数数量和最小货币单位对用量计费。
3. 推进租户 Watermark，并通过可恢复的 Rating Task 异步最终确定符合条件的 Statement。
4. 拒绝在已最终确定 Watermark 时或之前到达的迟到事件，且不改变用量或总计。
5. 在 UI 中展示用量时间线、Statement 明细、最终确定进度和 Domain Event 投递。

### 确定性策略

1. 一个计费周期是一个 UTC 日历月 [monthStart,nextMonthStart)。quantity 是整数 0..1000000000，每个批次包含 1..1000 个具有唯一 eventId 值的事件。
2. Rate Plan 包含不重叠的有效区间和一个平坦的非负 unitPriceMinor。其有效区间包含 occurredAt 的计划对该事件计费；若无计划，则整个批次返回 409 RATE_PLAN_UNAVAILABLE。
3. eventId 按租户作用域。相同 tenant、eventId 内容是重复重放；任何不同的 meterId、occurredAt 或 quantity 均为 409 EVENT_ID_CONFLICT，并拒绝整个批次。
4. 将 Watermark 推进到 t 会最终确定每个 periodEnd <= t 的周期。Watermark 必须严格大于先前值；Statement 按 periodStart 然后 statementId 顺序最终确定。

## 强制不变量

1. 每个租户 eventId 对用量和费用总计的贡献至多一次。
2. Statement 总计等于其不可变计费行金额的整数最小货币单位之和。
3. 应用的 Rate Plan 是每个 Usage Event occurredAt 时刻生效的版本，而非摄取时间。
4. Watermark 永不回退，且 V1 中已最终确定的 Statement 永不改变。
5. 批次拒绝不留下任何 Usage Event、Rating Task、Statement 变更或 Domain Event。

这些不变量必须在成功、验证失败、未知 HTTP 结果、重复请求、并发请求、worker 或 dispatcher SIGKILL、重启、迁移和持续负载之后仍然成立。

## HTTP 和 OpenAPI 3.1

在 'GET /openapi.json' 提供规范 OpenAPI，在 'GET /healthz' 提供健康检查。OpenAPI 文档和运行时行为必须一致。API 路由使用 JSON，除非明确文档化的原始内容。拒绝不支持的媒体类型返回 415 'UNSUPPORTED_MEDIA_TYPE'，格式错误的 JSON 返回 400 'MALFORMED_JSON'，未知对象键返回 400 'UNKNOWN_FIELD'，形状或范围违规且无更具体的已发布代码时返回 400 'INVALID_REQUEST'。语义或状态冲突使用其已发布的 409 代码。在文档化的 ADMIN_TOKEN 路由上，缺失、格式错误或不正确的 Bearer 令牌返回 401 'ADMIN_AUTH_REQUIRED'。

成功的分页集合读取返回 '{items,nextCursor}'。'limit' 默认为 50，是 1 到 100 的整数。游标顺序稳定且不透明；格式错误的游标返回 400 'INVALID_CURSOR'。类型为 'uuid' 的字段是小写 UUID 字符串；未类型化的字符串标识符保留其已发布的语法。时间戳为 UTC，带尾随 'Z'。资源未命中返回 404 'NOT_FOUND'。

错误精确使用：

~~~json
{"error":{"code":"STABLE_CODE","message":"human-readable text","details":{}}}
~~~

以下线格式是规范性的：'uuid' 是小写 RFC 4122 文本，'int' 是 JSON 安全整数，'timestamp' 是带毫秒精度和尾随 Z 的 UTC ISO-8601，'date' 是严格 YYYY-MM-DD，'sha256' 是 64 位小写十六进制，'currency' 是三个大写 ASCII 字母，'json' 是 RFC 8785 接受的任何值。'http-url' 是不含凭据或片段的绝对 http 或 https URL。'interval' 恰好是 '{startAt:timestamp,endAt:timestamp}'，startAt 在 endAt 之前，表示半开区间 '[startAt,endAt)'。'|null' 字段是必需且可空的。每个未列出的字段都被拒绝，数组保持其声明的顺序。响应精确使用这些资源形状：

- UsageEvent = {eventId:string,meterId:uuid,tenantId:uuid,occurredAt:timestamp,quantity:int,ingestedAt:timestamp}
- UsageBatch = {batchId:uuid,tenantId:uuid,acceptedEventIds:[string],duplicateEventIds:[string],createdAt:timestamp}
- Statement = {statementId:uuid,tenantId:uuid,periodStart:timestamp,periodEnd:timestamp,state:OPEN|FINALIZING|FINALIZED,revision:int,totalQuantity:int,totalMinor:int,watermarkThrough:timestamp|null,ratePlanVersions:[int],lines:[RatedLine],finalizedAt:timestamp|null,sequence:int}; revision 对不可变基础 Statement 恰好为 1
- RatedLine = {eventId:string,meterId:uuid,quantity:int,ratePlanVersion:int,unitPriceMinor:int,chargeMinor:int}; chargeMinor 等于 quantity 乘以 unitPriceMinor

公共聚合路由是：

- 'GET /api/v1/statements?limit&cursor' 和
  'GET /api/v1/statements/:statementId'。
- POST /api/v1/usage-batches，请求体为 {tenantId,events:[{eventId,meterId,occurredAt,quantity}]}；返回 202，包含已接受和重复的 ID，并原子性地拒绝任何语义冲突的重复项。
- POST /api/v1/tenants/:tenantId/watermark，请求体为 {through}，持久地推进截止点并调度计费任务。
- GET /api/v1/statements/:statementId 返回总计、费率行、应用的费率计划版本和状态。
- GET /api/v1/meters/:meterId/usage?from&to&limit&cursor 返回不可变的用量事件。
- GET /api/v1/tenants/:tenantId/watermark 返回 {tenantId,watermarkThrough,openPeriodStarts,finalizedThrough}。
- 'GET /api/v1/domain-events?aggregateId&afterSequence&limit' 按顺序返回已提交的事件。
- 'GET /api/v1/verification-snapshot' 要求 'Authorization: Bearer <ADMIN_TOKEN>'，并返回一个
  可序列化的快照 '{asOf:timestamp,resources:{...},work:[Work],events:[DomainEvent]}'。

### V1 验证快照

完整快照从单个 PostgreSQL 时间点读取；'asOf'、每个资源数组、'work'
和 'events' 必须描述同一个数据库快照。V1 'resources' 对象恰好包含以下键，
且不包含其他键：

- 'tenantStates' 使用精确形状 'TenantState = {tenantId:uuid,name:string,watermarkThrough:timestamp|null,openPeriodStarts:[timestamp],finalizedThrough:timestamp|null}'，并按标量字段路径元组 'tenantId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜排序依据。
- 'meterDefinitions' 使用精确形状 'MeterDefinition = {meterId:uuid,tenantId:uuid,name:string}'，并按标量字段路径元组 'meterId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜排序依据。
- 'ratePlans' 使用精确形状 'RatePlan = {tenantId:uuid,version:int,effectiveFrom:timestamp,effectiveTo:timestamp|null,unitPriceMinor:int}'，并按标量字段路径元组 'tenantId'、'version' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜排序依据。
- 'usageEvents' 使用精确形状 'UsageEvent'，并按标量字段路径元组 'tenantId'、'eventId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜排序依据。
- 'usageBatches' 使用精确形状 'UsageBatch'，并按标量字段路径元组 'batchId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜排序依据。
- 'statements' 使用精确形状 'Statement'，并按标量字段路径元组 'statementId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜排序依据。

每个资源数组恰好包含其声明形状所指定的每个当前或不可变实例一次。每个列出的排序路径解析为标量。标量顺序为：null 优先，然后 false 在 true 之前，整数按数值排序，其他所有字符串形式的标量按 UTF-8 字节排序。按完整元组升序排序，然后仅以 RFC 8785 规范 JSON 作为决胜排序依据。
递归地省略每个名称以 'Token' 结尾的对象字段，在所有嵌套深度上。

'Work' 恰好是
'{workId:uuid,kind:RATING,aggregateId:uuid,state:PENDING|LEASED|SUCCEEDED|FAILED|CANCELLED,terminal:boolean,attempt:int,leaseOwner:string|null,leaseExpiresAt:timestamp|null}'。
'kind' 恰好是 'RATING' 之一。两个租约字段仅在状态为 'LEASED' 时非空，在其他所有状态下均为 null。'terminal' 仅在状态为 'SUCCEEDED'、'FAILED' 或 'CANCELLED' 时为 true；终止的工作被保留。
当没有匹配的工作具有 'terminal:false' 时，积压队列即被排空。'work' 数组按 workId 排序。

'events' 包含精确的领域事件对象，按 aggregateId、sequence、eventId 排序。对每个事件负载应用相同的递归 '*Token' 省略规则。省略身份验证和业务防护令牌、幂等键、原始 webhook 主体、私有文件系统路径和机密。这是外部不变量查询面。

以下领域错误对于格式良好的请求是穷尽的，除了上述已发布的常见错误，以及 400 'INVALID_REQUEST'、400 'INVALID_CURSOR'、404 'NOT_FOUND' 和 409 'IDEMPOTENCY_CONFLICT'：

| HTTP | 代码 | 精确触发条件 |
| ---: | --- | --- |
| 409 | EVENT_ID_CONFLICT | 现有租户 eventId 具有不同语义 |
| 409 | LATE_USAGE_EVENT | occurredAt 在已定稿的水印处或之前 |
| 409 | RATE_PLAN_UNAVAILABLE | 没有费率计划覆盖事件的 occurredAt |
| 409 | WATERMARK_NOT_ADVANCING | through 不大于当前水印 |
| 400 | INVALID_USAGE_BATCH | 批次大小、数量、时间或重复成员无效 |

### 持久幂等性

每个变更操作要求 'Idempotency-Key'，1-128 个可见 ASCII 字符。作用域为方法、规范路径和键。在确认成功之前，持久化规范语义请求指纹和完整状态/响应体。相同的重试，包括重启或未知响应丢失后，返回原始状态和语义 JSON，且无二次效果。使用不同语义重用键返回 409 'IDEMPOTENCY_CONFLICT'。并发相同请求收敛于一个结果；进程本地映射不是权威。在基准测试期间不要过期记录，或在迁移期间重写保存的重放响应体。

## 种子契约

'npm run db:seed -- --file <path>' 恰好接受：

'{schemaVersion:1,seedVersion,importedAt,tenants,meterDefinitions,ratePlans,usageEvents}; importedAt is one UTC timestamp, Rate Plan intervals do not overlap, quantities and prices are non-negative integers, and event IDs are unique per tenant.'

成员模式是精确的：

- tenants[] = {tenantId:uuid,name:string,watermarkThrough:timestamp|null}；name 为 1..120 个 UTF-8 字符
- meterDefinitions[] = {meterId:uuid,tenantId:uuid,name:string}；meterId 全局唯一
- ratePlans[] = {tenantId:uuid,version:int,effectiveFrom:timestamp,effectiveTo:timestamp|null,unitPriceMinor:int}；版本为正数，区间不重叠
- usageEvents[] 使用精确的 UsageEvent 线上字段，但 ingestedAt 除外，它等于作为顶层 importedAt 提供的确定性种子导入时间

'seedVersion' 是一个非空字符串，最多 64 个字符。导入器记录规范文件摘要。相同版本和摘要是无操作重放；相同版本但内容不同则失败，返回 'SEED_VERSION_CONFLICT'。拒绝未知键、重复 ID、缺失引用、无效状态、破坏的不变量、超出范围的整数和格式错误的时间。任何无效成员都会拒绝整个导入，而不更改业务行、任务、幂等性或领域事件。

## 工作进程、事件和恢复

工作进程使用 'WORK_LEASE_SECONDS' 声明有界的持久租约。租约所有权必须在提交结果的短事务内再次证明。在等待 HTTP、文件、时钟或其他进程时，不要持有数据库事务。过期的租约可重新声明，但过期的令牌无法提交。

业务状态及其领域事件在一个事务中提交。事件字段为 'eventId'、'aggregateId'、
正整数 'sequence'、'type'、'occurredAt'、'schemaVersion:1' 和 'payload'。必需的事件类型：
`usage.batch-accepted`、`watermark.advanced`、`statement.finalized`。'payload' 恰好是每个 V1 事件的 '{}'；后续的管理器事件也使用 '{}'，除非
其发布的契约字面上提供了另一种负载形状。回滚不产生事件。每个聚合的序列是连续的。

调度器发送带有 'X-MeterSettle-Event-Id' 和 'X-MeterSettle-Event-Type' 的 JSON。网络错误、
超时和非 2xx 响应以有界退避无限重试。每次重试保持相同的 eventId 和语义主体。成功投递顺序为聚合序列递增。至少一次投递可能重复请求；它不得发明另一个事件身份。

### 受控恢复屏障

当 'TEST_BARRIER_URL' 为空时，不存在屏障请求。当两个测试变量都设置时，工作进程在继续之前 POST，位置为 'worker.claimed'、'worker.effect-complete' 和 'worker.before-commit'；调度器在 'dispatcher.response-received' 处 POST。精确 JSON 为
'{schemaVersion:1,processRole:worker|dispatcher,point,workId,aggregateId,attempt,leaseTokenHash}'，头为
'X-Test-Barrier-Token: <TEST_BARRIER_TOKEN>'。ID 和点跨重试保持相同；leaseTokenHash 是令牌的 SHA-256，绝不是令牌。204 响应释放进程。保持的响应暂停进程，而不打开数据库事务。连接丢失或非 204 响应每 100 毫秒重试一次，使用相同主体，直到租约丢失或进程终止。仅接受 localhost URL。

## 真实 UI

提供桌面和移动端流程，用于创建 V1 聚合、查看集合和详情、执行每个公共用户操作、观察异步计费任务进度、浏览事件和历史证据，以及在刷新后恢复。显示加载、空、验证、冲突、过期、离线/重试、终止和权限错误状态。使用可见的语义控件、键盘导航、关联标签、焦点管理和 WCAG AA 对比度。绝不允许通过开发者工具或直接 API 调用来完成主要流程。

## 项目自有验证

- 单元测试覆盖确定性策略、状态转换、规范化和边界值。
- 集成测试启动真实的 PostgreSQL 和真实的 HTTP 进程；它们绝不调用内部服务。
- 浏览器端到端测试使用生产构建、真实 Chromium、真实 API/数据库/工作进程和可见控件。
- 并发测试使用至少两个 API 进程和两个工作进程，针对一个 PostgreSQL 数据库。
- 恢复测试使用公共的仅测试屏障来观察声明/提交或接收方/ACK 边界，然后 SIGKILL；随机睡眠不是故障控制。
- 性能测试在以下固定间隔内运行生产构建，报告 p50/p95/p99、吞吐量、成功变更、预期冲突、意外 5xx、积压排空和加载后不变量。

固定的 V1 兼容性能场景：

### 场景 'usage-batch-ingest'

- 目标：以 p95 ≤ 400 毫秒/100 事件批次的速度，在 60 秒内摄取 1,000 个使用事件/秒
- 模式：'http'
- 方法：'POST'
- 路径：'/api/v1/usage-batches'
- 设置：准备 700 个不相交的 100 事件批次：100 个用于预热，600 个用于测量。事件针对处于开启期间的现有计量表，并使用唯一的确定性 eventId。
- 选择器：按 tenantId 轮询租户，按 meterId 字节顺序轮询计量表；一个批次包含一个租户和恰好 100 个连续的 ID。
- 请求：{tenantId,events:[{eventId,meterId,occurredAt,quantity:1} x100]}；测量的 eventId 值具有前缀 perf-measured，预热值具有前缀 perf-warmup。
- 并发：64
- 预热秒数：10
- 测量秒数：60
- 成功：仅接受所有 100 个 ID 的 202 响应计入；重复项和 409 响应不计入。
- 阈值：在 60 秒内至少 10 个成功批次/秒（1,000 个已接受的使用事件/秒），且批次 p95 ≤ 400 毫秒；意外 5xx = 0。
- 计时器：吞吐量窗口从预热后的第一个测量请求开始；每个延迟样本从请求分发到完整响应体结束。

### 场景 'statement-read'

- 目标：以 p95 ≤ 150 毫秒的速度提供 200 次 Statement 读取/秒
- 模式：'http'
- 方法：'GET'
- 路径：'/api/v1/statements/:statementId'
- 设置：在预热之前，通过公共 API 推进 Watermarks，并等待 10,000 个已播种的关闭期间事件产生 FINALIZED Statements；排除设置时间，并且在测量期间不修改它们。
- 选择器：按字节顺序的 UUID 顺序轮询 statementId 值。
- 请求：无请求体且无可选查询参数。
- 并发：64
- 预热秒数：10
- 测量秒数：60
- 成功：仅行总和等于 totalQuantity 且 totalMinor 计入的 200 响应计入。
- 阈值：在 60 秒内至少 200 个成功响应/秒，且 p95 ≤ 150 毫秒；意外 5xx = 0。
- 计时器：吞吐量窗口从预热后的第一个测量请求开始；每个延迟样本从请求分发到完整响应体结束。

### 场景 'rating-recovery'

- 目标：恢复后在 60 秒内完成 10,000 个评级行的定稿
- 模式：'worker'
- 方法：'N/A'
- 路径：'work:RATING'
- 设置：通过公共 API 推进所需租户的 Watermarks，以便恰好覆盖 10,000 个已关闭、先前未定稿的使用事件。将两个评级工作进程保持在 worker.claimed，SIGKILL，等待租约到期，然后启动两个替换进程。
- 选择器：按 periodStart 然后 statementId 处理符合条件的 Statements，并保留每个终态 Work 记录。
- 请求：不发出测量的客户端请求；设置仅使用已发布的种子和公共 API，在工作进程计时器启动之前完成。
- 并发：2
- 预热秒数：0
- 测量秒数：60
- 成功：恰好 10,000 个 RatedLine 成员被提交一次，每个覆盖的 Statement 均为 FINALIZED，没有 RATING Work 保持非终态，并且总计使用 occurredAt 费率计划。
- 阈值：恢复在 ≤ 60 秒内完成，没有重复行、间隙或意外的工作进程故障。
- 计时器：在两个替换工作进程生成时启动；在证明所有声明的后置条件的第一个时间点验证快照时停止。

固定性能种子：seedVersion perf-v1 使用 importedAt 2026-01-01T00:00:00.000Z，并包含恰好 100 个租户、10,000 个 meterDefinitions、100 个 ratePlans 和 1,000,000 个 usageEvents；恰好 10,000 个事件处于关闭的未定稿期间，所有其他事件处于开启期间。

这三个场景是从新迁移的数据库和上述确切种子独立运行的；
完成每个场景's Setup before its Timer begins. Mode 'http' means '方法' and '路径' 命名
唯一测量的公共请求操作，'concurrency' 是确切的闭环客户端数量。模式
'worker' 表示方法 'N/A'，'path' 命名测量的 Work 种类，'concurrency' 是确切的工作进程
数量。精确使用每个场景的选择器和请求；没有推断的混合工作负载。
精确运行 'warmupSeconds' 个未测量的秒数，然后精确运行 'measureSeconds' 个测量的秒数，或直到
计时器声明的终态条件。有状态的预热和测量的身份必须不相交。计数
完整的 HTTP 响应体以计算延迟。预期的已发布冲突单独报告，除非
场景的成功和阈值明确将其计入。

基准容器具有 4 个逻辑 CPU 和 8 GiB RAM；PostgreSQL 16、Chromium、两个 API 进程、
指定的工作进程和一个调度程序共享该限制。每个后续兼容的二进制文件必须重新运行
这三个相同的场景，而不更改任何字段或阈值。

意外 5xx 计数必须为零。在满足延迟或吞吐量但任何强制不变量为假的情况下
是失败的性能运行。

## 范围外

- 税收
- 付款收款
- 货币兑换
- 预测性计费
- 跨租户聚合

## 交接

保持 README 和 OpenAPI 最新。以发现优先的审查结束，并报告架构、模块和
进程所有权、公共接口、成功/失败数据流、事务和租约边界、
迁移、兼容性、运行的精确命令、测试和性能结果、恢复证据、已知
风险以及每个未运行的检查。不要声称实际未执行的检查。
