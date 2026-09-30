# IncidentRelay

根据这个有意留空的仓库构建 IncidentRelay。本 README 是完整的产品合同。不要发明合同之外的行为。在做出合同未明确规定的产品决策之前，请先询问。

## 必需的技术栈

- Node.js 22、TypeScript、React、PostgreSQL 16、npm 以及预装的 Chromium。
- PostgreSQL 是业务状态、幂等性、租约、事件和排序的唯一权威。
- 生产环境 UI 必须使用公共 HTTP API；不允许使用模拟数据、内存数据库或仅浏览器端状态来提供正确性。
- 使用整数领域数量和 UTC ISO-8601 时间戳。不要对金额、容量、序列、持续时间单位或守恒量使用浮点数。

## 必需的非交互式命令

| 命令 | 合同 |
| --- | --- |
| 'npm run db:migrate' | 反复且安全地应用所有版本化迁移。 |
| 'npm run db:seed -- --file <path>' | 原子性地导入版本化 JSON 种子数据。 |
| 'npm run dev' | 启动开发环境 API 和 UI。 |
| 'npm run build' | 生成生产环境 API、worker、dispatcher 和 UI 资产。 |
| 'npm run start:api' | 启动一个生产环境 API/UI 进程。 |
| 'npm run start:worker' | 启动一个升级步骤 worker。 |
| 'npm run start:dispatcher' | 启动领域事件 webhook dispatcher。 |
| 'npm run test:unit' | 运行纯逻辑和边界测试。 |
| 'npm run test:integration' | 运行真实 PostgreSQL 加公共 HTTP 集成测试。 |
| 'npm run test:e2e' | 通过可见控件运行生产构建的 Chromium 测试。 |
| 'npm run test:concurrency' | 针对一个数据库运行至少两个 API 和两个 worker 进程。 |
| 'npm run test:recovery' | 使用可观察屏障、SIGKILL、重启和持久恢复。 |
| 'npm run test:all' | 从干净的数据库运行上述所有非性能门禁。 |
| 'npm run test:perf' | 运行固定的持续负载并验证所有负载后不变量。 |

每个命令在失败时以非零状态退出，清理自己的子进程，并且不需要任何提示。

## 环境变量

| 变量 | 默认值 | 规则 |
| --- | --- | --- |
| 'DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/incidentrelay' | 生产/开发环境权威。 |
| 'TEST_DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/incidentrelay_test' | 所有有状态测试必需。 |
| 'PORT' | '3000' | 整数 1-65535；API 和生产 UI 来源。 |
| 'ADMIN_TOKEN' | 任务本地值 | 仅文档化的管理变更路由需要；切勿记录。 |
| 'WEBHOOK_URL' | 'http://127.0.0.1:4010/events' | 领域事件投递的 HTTP 端点。 |
| 'WORK_LEASE_SECONDS' | '3' | 整数 1-60；worker 和恢复测试使用的持久租约时长。 |
| 'CHROMIUM_PATH' | '/usr/bin/chromium' | 项目自有 E2E 使用的浏览器可执行文件。 |
| 'MANAGED_DATA_ROOT' | '/tmp/incidentrelay-data' | 可写的暂存或生成字节根目录；切勿直接提供路径。 |
| 'TEST_BARRIER_URL' | 空 | 仅受控恢复测试使用的可选 localhost HTTP 接收器。 |
| 'TEST_BARRIER_TOKEN' | 空 | 设置 URL 时必需的屏障头值；切勿记录。 |

仅绑定到 '127.0.0.1'。日志不得包含令牌、幂等键、原始种子输入、webhook 主体或私有绝对路径。

## 领域和 V1 行为

| 术语 | 规范定义 | 避免 |
| --- | --- | --- |
| 服务 | 一个运营所有权范围，具有一个升级策略版本。 | 应用程序、团队 |
| 事件 | 一个需要确认的去重告警发生。 | 警报、工单 |
| 升级策略 | 一个不可变的有序响应者目标和延迟集合。 | 工作流、排班 |
| 升级步骤 | 一个策略级别和一个事件的持久到期工作。 | 作业、定时器 |
| 响应者 | 有资格确认事件的人员或端点。 | 用户、被分配人 |
| 通知投递 | 至少一次 webhook 投递，具有稳定的 notificationId。 | 消息、电子邮件 |

事件：OPEN -> ACKNOWLEDGED -> RESOLVED，或 OPEN -> EXPIRED；升级步骤为 PENDING -> SENT | SUPERSEDED。

1. 使用作用域持久去重摄取警报，并捕获当前的升级策略版本。
2. 根据持久化的 dueAt 在多个 worker 之间调度和租用升级步骤。
3. 以稳定的主体和顺序至少一次地将每个步骤投递到其目标。
4. 接受第一个有效确认并原子性地取代其余步骤。
5. 解决或过期事件，处理合法竞争、时间线 UI 以及 worker 死亡后的恢复。

### 确定性策略

1. dedupKey 是 1..128 个可见 ASCII 字符，按 serviceId 作用域，并且仅在事件处于终态之前保持活跃；在 OPEN 状态下相同的重试会重放，而不同内容则返回冲突。在先前的事件处于终态后，使用相同的 dedupKey 和新的 Idempotency-Key 创建会创建新事件，而重放先前的 Idempotency-Key 仍会返回其保存的响应。
2. 策略延迟是严格递增的整数 0..86400，且 expireAfterSeconds 大于最后一个延迟。事件 dueAt 值使用 createdAt 加上捕获的延迟，expiresAt 等于 createdAt 加上 expireAfterSeconds。
3. Worker 按 dueAt、incidentId、stepIndex 声明到期的 PENDING 步骤。一旦其稳定通知收到 2xx，步骤即为 SENT；后续步骤保持 PENDING 直到其 dueAt，除非事件处于终态。
4. 创建升级步骤会捕获响应者的 deliveryUrl 和精确的 NotificationDelivery 主体。每次尝试 POST 相同的 RFC 8785 JSON 主体，Content-Type 为 application/json，X-IncidentRelay-Notification-Id 等于 notificationId，超时时间为 5 秒。任何 2xx 标记为 DELIVERED；在失败的尝试 n（从 1 开始编号）之后，持久化 nextAttemptAt = attemptCompletedAt + min(2^(n-1),60) 秒。终态事件会在另一次尝试之前取代待处理的投递。
5. 在数据库时间 >= expiresAt 时，过期解析先于新步骤投递和确认：OPEN 事件变为 EXPIRED，所有剩余步骤和业务通知变为 SUPERSEDED。在 expiresAt 之前，来自 SENT 步骤的响应者的第一个确认获胜；PENDING 或 SUPERSEDED 步骤不能授权确认。解决需要该获胜者或捕获策略声明的另一个响应者，并将 ACKNOWLEDGED 恰好一次地更改为 RESOLVED。
6. NotificationDelivery 是发送到其捕获的响应者 deliveryUrl 的业务通知。它不同于由 dispatcher 单独发送到 WEBHOOK_URL 的领域事件 webhook，并且投递记录、重试计划或确认都不能替代另一个。

## 强制不变量

1. 对于一个 serviceId 和 dedupKey，同一时间最多存在一个活跃事件；每个接受的 Idempotency-Key 永远重放其原始稳定结果。
2. 事件捕获一个不可变的升级策略版本。
3. 在 V1 中最多一个响应者赢得确认。
4. 确认或解决后，没有步骤会变为新可投递。
5. 一个事件的成功通知遵循递增的步骤顺序。

这些不变量必须在成功、验证失败、未知 HTTP 结果、重复请求、并发请求、worker 或 dispatcher SIGKILL、重启、迁移和持续负载之后仍然成立。

## HTTP 和 OpenAPI 3.1

在 'GET /openapi.json' 提供规范 OpenAPI，在 'GET /healthz' 提供健康检查。OpenAPI 文档和运行时行为必须一致。API 路由使用 JSON，除非明确文档化的原始内容。拒绝不支持的媒体类型，返回 415 'UNSUPPORTED_MEDIA_TYPE'；格式错误的 JSON 返回 400 'MALFORMED_JSON'；未知对象键返回 400 'UNKNOWN_FIELD'；形状或范围违规且没有更具体的已发布代码时返回 400 'INVALID_REQUEST'。语义或状态冲突使用其已发布的 409 代码。在文档化的 ADMIN_TOKEN 路由上，缺失、格式错误或不正确的 Bearer 令牌返回 401 'ADMIN_AUTH_REQUIRED'。

成功的分页集合读取返回 '{items,nextCursor}'。'limit' 默认为 50，是 1 到 100 的整数。游标顺序稳定且不透明；格式错误的游标返回 400 'INVALID_CURSOR'。类型为 'uuid' 的字段是小写 UUID 字符串；未类型化的字符串标识符保留其已发布的语法。时间戳是 UTC，带有尾随 'Z'。资源未命中返回 404 'NOT_FOUND'。

错误精确使用：

~~~json
{"error":{"code":"STABLE_CODE","message":"human-readable text","details":{}}}
~~~

下面的线格式是规范性的：'uuid' 是小写 RFC 4122 文本，'int' 是 JSON 安全整数，
'timestamp' 是 UTC ISO-8601，毫秒精度且尾随 Z，'date' 是严格的 YYYY-MM-DD，
'sha256' 是 64 个小写十六进制，'currency' 是三个大写 ASCII 字母，'json' 是任何
RFC 8785 接受的值。'http-url' 是没有凭据或片段的绝对 http 或 https URL。
'interval' 恰好是 '{startAt:timestamp,endAt:timestamp}'，startAt 在 endAt 之前，表示
半开区间 '[startAt,endAt)'。'|null' 字段是必需的且可空。每个未列出的字段都被
拒绝，数组保留其声明的顺序。响应精确使用这些资源形状：

- EscalationPolicy = {policyId:uuid,version:int,steps:[{stepIndex:int,delaySeconds:int,responderId:uuid}],expireAfterSeconds:int}
- Incident = {incidentId:uuid,serviceId:uuid,dedupKey:string,severity:LOW|MEDIUM|HIGH|CRITICAL,title:string,details:string,state:OPEN|ACKNOWLEDGED|RESOLVED|EXPIRED,policyId:uuid,policyVersion:int,createdAt:timestamp,expiresAt:timestamp,nextEscalationAt:timestamp|null,acknowledgedBy:uuid|null,acknowledgedAt:timestamp|null,resolvedAt:timestamp|null,sequence:int}
- EscalationStep = {incidentId:uuid,stepIndex:int,responderId:uuid,dueAt:timestamp,state:PENDING|SENT|SUPERSEDED,notificationId:uuid,successfulDeliveryAt:timestamp|null}
- NotificationDelivery = {notificationId:uuid,incidentId:uuid,stepIndex:int,responderId:uuid,deliveryUrl:http-url,body:{notificationId:uuid,incidentId:uuid,serviceId:uuid,stepIndex:int,responderId:uuid,severity:LOW|MEDIUM|HIGH|CRITICAL,title:string,details:string},state:PENDING|DELIVERED|SUPERSEDED,attemptCount:int,nextAttemptAt:timestamp|null,successfulDeliveryAt:timestamp|null}
- TimelineItem = {sequence:int,type:string,occurredAt:timestamp,actorId:uuid|null,data:json}

公共聚合路由为：

- 'GET /api/v1/incidents?limit&cursor' 和
  'GET /api/v1/incidents/:incidentId'。
- POST /api/v1/incidents，请求体为 {serviceId,dedupKey,severity,title,details}；返回 201 OPEN，并包含捕获的 policyVersion 和 nextEscalationAt。
- POST /api/v1/incidents/:incidentId/acknowledge，请求体为 {responderId}，选择针对该响应者的最低索引 SENT 步骤，并返回第一个获胜者；若无此类步骤或事件已过期，则返回 409 INCIDENT_NOT_ACKNOWLEDGEABLE；若存在不同的先前获胜者，则稳定返回 409 INCIDENT_ALREADY_ACKNOWLEDGED。
- POST /api/v1/incidents/:incidentId/resolve，请求体为 {responderId,resolution}，要求事件处于 ACKNOWLEDGED 状态。
- POST /api/v1/services/:serviceId/escalation-policies，请求体为 {expectedCurrentVersion,steps:[{stepIndex,delaySeconds,responderId}],expireAfterSeconds}，当 expectedCurrentVersion 为 null 且不存在策略时，原子创建不可变版本 1；当 expectedCurrentVersion 与当前版本完全匹配时，原子创建当前版本 + 1；否则返回 409 ESCALATION_POLICY_VERSION_CHANGED。
- GET /api/v1/incidents/:incidentId/timeline 返回有序的状态、步骤和投递事实。
- GET /api/v1/services/:serviceId/escalation-policy 返回精确的当前 EscalationPolicy 形状。
- 'GET /api/v1/domain-events?aggregateId&afterSequence&limit' 按顺序返回已提交的事件。
- 'GET /api/v1/verification-snapshot' 要求 'Authorization: Bearer <ADMIN_TOKEN>'，并返回一个
  可序列化的快照 '{asOf:timestamp,resources:{...},work:[Work],events:[DomainEvent]}'。

### V1 验证快照

完整快照从单个 PostgreSQL 时间点读取；'asOf'、每个资源数组、'work'
以及 'events' 必须描述同一数据库快照。V1 'resources' 对象仅包含以下键，
且无其他键：

- 'services' 使用精确形状 'Service = {serviceId:uuid,name:string,currentPolicyId:uuid,currentPolicyVersion:int}'，并按标量字段路径元组 'serviceId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜排序。
- 'responders' 使用精确形状 'Responder = {responderId:uuid,name:string,deliveryUrl:http-url}'，并按标量字段路径元组 'responderId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜排序。
- 'escalationPolicies' 使用精确形状 'EscalationPolicy'，并按标量字段路径元组 'policyId'、'version' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜排序。
- 'incidents' 使用精确形状 'Incident'，并按标量字段路径元组 'incidentId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜排序。
- 'escalationSteps' 使用精确形状 'EscalationStep'，并按标量字段路径元组 'incidentId'、'stepIndex' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜排序。
- 'notificationDeliveries' 使用精确形状 'NotificationDelivery'，并按标量字段路径元组 'incidentId'、'stepIndex'、'responderId'、'notificationId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜排序。

每个资源数组恰好包含其声明形状所命名的每个当前或不可变实例一次。每个列出的排序路径解析为标量。标量顺序为 null 优先，然后 false 在 true 之前，整数按数值排序，其他所有字符串形式标量按 UTF-8 字节排序。按完整元组升序排序，然后仅以 RFC 8785 规范 JSON 作为决胜排序。
递归省略每个名称以 'Token' 结尾的对象字段，在所有嵌套深度。

'Work' 精确为
'{workId:uuid,kind:ESCALATION_STEP|INCIDENT_EXPIRY,aggregateId:uuid,state:PENDING|LEASED|SUCCEEDED|FAILED|CANCELLED,terminal:boolean,attempt:int,leaseOwner:string|null,leaseExpiresAt:timestamp|null}'。
'kind' 恰好是 'ESCALATION_STEP'、'INCIDENT_EXPIRY' 之一。两个租约字段仅在状态为
'LEASED' 时非 null，在其他所有状态下均为 null。'terminal' 仅在状态为
'SUCCEEDED'、'FAILED' 或 'CANCELLED' 时为 true；终止的 Work 被保留。
当没有匹配的 Work 具有 'terminal:false' 时，积压队列被排空。'work' 数组按
workId 排序。

'events' 包含精确的领域事件对象，按 aggregateId、sequence、eventId 排序。对每个事件负载应用相同的递归 '*Token' 省略。省略认证和业务围栏令牌、幂等键、原始 webhook 主体、私有文件系统路径和机密。这是外部不变量查询面。

以下领域错误对于格式良好的请求是穷尽的，除上述常见错误外，还包括 400 'INVALID_REQUEST'、400 'INVALID_CURSOR'、404 'NOT_FOUND' 和 409
'IDEMPOTENCY_CONFLICT'：

| HTTP | 代码 | 精确触发条件 |
| ---: | --- | --- |
| 409 | INCIDENT_DEDUP_CONFLICT | 活跃的 serviceId 加 dedupKey 具有不同的告警语义 |
| 409 | INCIDENT_ALREADY_ACKNOWLEDGED | 另一个响应者已赢得确认 |
| 409 | INCIDENT_NOT_ACKNOWLEDGEABLE | 事件已终止或响应者没有匹配的 SENT 步骤 |
| 409 | INCIDENT_NOT_RESOLVABLE | 事件不处于 ACKNOWLEDGED 状态 |
| 409 | ESCALATION_POLICY_VERSION_CHANGED | expectedCurrentVersion 不是服务的当前策略版本 |
| 400 | INVALID_ESCALATION_POLICY | 步骤、延迟、目标或过期时间无效 |

### 持久幂等性

每个变更操作要求 'Idempotency-Key'，为 1-128 个可见 ASCII 字符。作用域为方法、规范
路径和键。在确认成功之前，持久化规范语义请求
指纹和完整状态/主体。相同的重试，包括
重启后或未知响应丢失后，返回原始状态和语义 JSON，且无第二次效果。使用相同键但不同语义返回 409 'IDEMPOTENCY_CONFLICT'。并发相同
请求收敛于一个结果；进程本地映射不是权威。在基准测试期间不要过期记录，或在迁移期间重写保存的重放主体。

## 种子契约

'npm run db:seed -- --file <path>' 精确接受：

'{schemaVersion:1,seedVersion,services,responders,escalationPolicies,incidents,escalationSteps,notificationDeliveries}; policy delays are increasing integers, targets exist, and dedup keys are unique within seeded open Incidents.'

成员模式是精确的：

- services[] = {serviceId:uuid,name:string,currentPolicyId:uuid,currentPolicyVersion:int}
- responders[] = {responderId:uuid,name:string,deliveryUrl:http-url}，escalationPolicies[] 使用精确的 EscalationPolicy 模式
- incidents[] 使用精确的 Incident 模式；escalationSteps[] 和 notificationDeliveries[] 使用其精确的线上模式，且必须与捕获的策略、目标 URL 和主体、投递状态、事件状态和序列一致

'seedVersion' 是非空字符串，最多 64 个字符。导入器记录规范文件摘要。
相同版本和摘要是无操作重放；相同版本但不同内容失败，返回
'SEED_VERSION_CONFLICT'。拒绝未知键、重复 ID、缺失引用、无效状态、破坏的
不变量、超出范围的整数和格式错误的时间。任何无效成员拒绝整个导入，
不改变业务行、任务、幂等性或领域事件。

## 工作器、事件和恢复

工作器使用 'WORK_LEASE_SECONDS' 声明有界持久租约。租约所有权必须在提交结果的短事务内再次证明。
在等待 HTTP、文件、时钟或其他进程时，不要持有数据库事务。过期租约可重新声明，但过期令牌不能提交。

业务状态及其领域事件在一个事务中提交。事件字段为 'eventId'、'aggregateId'、
正整数 'sequence'、'type'、'occurredAt'、'schemaVersion:1' 和 'payload'。必需事件类型：
`incident.opened`、`escalation.sent`、`incident.acknowledged`、`incident.resolved`、`incident.expired`。'payload' 对每个 V1 事件精确为 '{}'；后续 Manager 事件也使用 '{}'，除非
其发布的契约字面提供另一个负载形状。回滚不产生事件。序列
按聚合连续。

调度器发送 JSON，包含 'X-IncidentRelay-Event-Id' 和 'X-IncidentRelay-Event-Type'。网络错误、
超时和非 2xx 响应以有界退避无限重试。每次重试保持相同的
eventId 和语义主体。成功投递顺序为递增的聚合序列。至少一次
投递可能重复请求；不得发明另一个事件身份。

### 受控恢复屏障

当'TEST_BARRIER_URL'为空时，不存在屏障请求。当两个测试变量均已设置时，工作进程在继续执行'worker.claimed'、'worker.effect-complete'和'worker.before-commit'之前先进行POST；调度器在'dispatcher.response-received'处进行POST。确切的JSON为'{schemaVersion:1,processRole:worker|dispatcher,point,workId,aggregateId,attempt,leaseTokenHash}'，头部为'X-Test-Barrier-Token: <TEST_BARRIER_TOKEN>'。ID和点在重试期间保持不变；leaseTokenHash是令牌的SHA-256哈希值，绝不是令牌本身。204响应释放进程。保持响应会暂停进程，且不打开数据库事务。连接丢失或非204响应时，每100毫秒使用相同请求体重试，直至租约丢失或进程终止。仅接受localhost URL。

## 真实用户界面

提供桌面端和移动端流程，用于创建V1聚合、查看集合和详情、执行每项公开用户操作、观察异步升级步骤进度、浏览事件和历史证据，以及在刷新后恢复。展示加载、空、验证、冲突、过期、离线/重试、终止和权限错误状态。使用可见的语义控件、键盘导航、关联标签、焦点管理和WCAG AA对比度。绝不允许通过开发者工具或直接API调用来完成主要流程。

## 项目自有验证

- 单元测试覆盖确定性策略、状态转换、规范化和边界值。
- 集成测试启动真实的PostgreSQL和真实的HTTP进程；它们绝不调用内部服务。
- 浏览器端到端测试使用生产构建、真实Chromium、真实API/数据库/工作进程以及可见控件。
- 并发测试使用至少两个API进程和两个工作进程，针对一个PostgreSQL数据库。
- 恢复测试使用仅限测试的公共屏障来观察声明/提交或接收方/确认边界，然后执行SIGKILL；随机睡眠不属于故障控制。
- 性能测试针对以下固定间隔运行生产构建，报告p50/p95/p99、吞吐量、成功变更、预期冲突、意外5xx、积压排空和加载后不变量。

固定的V1兼容性能场景：

### 场景'deduplicated-incident-ingest'

- 目标：以p95 <= 250毫秒的速度摄取200条去重告警/秒
- 模式：'http'
- 方法：'POST'
- 路径：'/api/v1/incidents'
- 设置：准备不相交的预热流和测量流。每十个请求中，九个使用新的serviceId、dedupKey对，第十个以新的幂等键重复前一个告警语义，以测试活动键去重。
- 选择器：按字节轮询serviceId；dedupKey为perf-{phase}-{ordinal}；严重级别循环为LOW、MEDIUM、HIGH、CRITICAL。
- 请求：{serviceId,dedupKey,severity,title:"perf incident",details:"fixed 64-byte ASCII detail"}。
- 并发数：64
- 预热秒数：10
- 测量秒数：60
- 成功标准：新的201 OPEN或文档化的稳定去重重放计数；语义冲突不计入。每十个请求恰好存在九个事件。
- 阈值：60秒内至少200个完整成功响应/秒，且p95 <= 250毫秒；意外5xx = 0。
- 计时器：吞吐量窗口从预热后的第一个测量请求开始；每个延迟样本从请求发送到完整响应体接收完毕。

### 场景'incident-timeline-read'

- 目标：以p95 <= 150毫秒的速度提供250次时间线读取/秒
- 模式：'http'
- 方法：'GET'
- 路径：'/api/v1/incidents/:incidentId/timeline'
- 设置：使用所有已播种的事件ID；读取不改变升级状态。
- 选择器：按字节顺序轮询incidentId值。
- 请求：无请求体或查询参数。
- 并发数：64
- 预热秒数：10
- 测量秒数：60
- 成功标准：仅200个响应，其TimelineItems具有连续序列，并与事件及升级步骤状态计数一致。
- 阈值：60秒内至少250次成功读取/秒，且p95 <= 150毫秒；意外5xx = 0。
- 计时器：吞吐量窗口从预热后的第一个测量请求开始；每个延迟样本从请求发送到完整响应体接收完毕。

### 场景'escalation-recovery'

- 目标：重启后45秒内排空3,000个到期的升级步骤
- 模式：'worker'
- 方法：'N/A'
- 路径：'work:ESCALATION_STEP'
- 设置：恰好有3,000个待处理的升级步骤到期。将两个工作进程保持在worker.claimed状态，执行SIGKILL，等待租约过期，然后启动两个替换工作进程；本地测试接收方返回204。
- 选择器：按dueAt、incidentId、stepIndex顺序处理；投递重试保留notificationId和请求体。
- 请求：不发出测量的客户端请求；设置仅使用已发布的种子和公共API，在工作进程计时器启动之前完成。
- 并发数：2
- 预热秒数：0
- 测量秒数：45
- 成功标准：所有3,000个步骤在业务状态中恰好发送一次，没有ESCALATION_STEP工作保持非终止状态，且接收方观察到具有稳定重试的精确通知契约。
- 阈值：替换工作进程生成后，积压在<= 45秒内排空；意外的工作进程或接收方失败 = 0。
- 计时器：在两个替换工作进程生成时启动，仅在验证快照和接收方日志证明所有后置条件后停止。

固定性能种子：seedVersion perf-v1恰好包含1,000个服务、10,000个响应者、1,000个升级策略、100,000个事件和300,000个升级步骤；在测量开始时恰好有3,000个待处理的步骤到期。

三个场景是从新迁移的数据库和上述精确种子独立运行的；每个场景's Setup before its Timer begins. Mode 'http' means '方法' and '路径'命名唯一的测量公共请求操作，'concurrency'是精确的闭环客户端数量。模式'worker'表示方法'N/A'，'path'命名测量的工作种类，'concurrency'是精确的工作进程数量。精确使用每个场景的选择器和请求；不存在推断的混合工作负载。精确运行'warmupSeconds'秒未测量时间，然后精确运行'measureSeconds'秒测量时间，或直到计时器声明的终止条件。有状态的预热和测量身份必须不相交。延迟计数完整的HTTP响应体。预期的已发布冲突单独报告，除非场景的成功标准和阈值明确将其计入。

基准容器具有4个逻辑CPU和8 GiB RAM；PostgreSQL 16、Chromium、两个API进程、指定的工作进程和一个调度器共享该限制。每个后续兼容二进制文件必须在不更改任何字段或阈值的情况下重新运行这三个相同场景。

意外5xx计数必须为零。在满足延迟或吞吐量但任何强制不变量为假的情况下，性能运行视为失败。

## 范围外

- 电话或短信提供商
- 值班日历生成
- 聊天
- 根本原因分析
- 事件计费

## 交接

保持README和OpenAPI最新。以发现优先的审查结束，并报告架构、模块和进程所有权、公共接口、成功/失败数据流、事务和租约边界、迁移、兼容性、执行的精确命令、测试和性能结果、恢复证据、已知风险以及所有未运行的检查。不要声称实际未执行的检查。
