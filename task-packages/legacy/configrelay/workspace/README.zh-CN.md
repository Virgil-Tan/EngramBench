# ConfigRelay

根据这个有意留空的仓库构建 ConfigRelay。本 README 是完整的产品合同。不要发明合同之外的行为。在做出合同未明确规定的产品决策之前，请先询问。

## 必需的技术栈

- Node.js 22、TypeScript、React、PostgreSQL 16、npm 以及预装的 Chromium。
- PostgreSQL 是业务状态、幂等性、租约、事件和排序的唯一权威。
- 生产环境 UI 必须使用公共 HTTP API；任何模拟、内存数据库或仅浏览器端的状态都不得提供正确性。
- 使用整数领域数量和 UTC ISO-8601 时间戳。不得对金额、容量、序列、持续时间单位或守恒量使用浮点数。

## 必需的非交互式命令

| 命令 | 合同 |
| --- | --- |
| 'npm run db:migrate' | 反复且安全地应用所有版本化迁移。 |
| 'npm run db:seed -- --file <path>' | 原子化导入版本化 JSON 种子数据。 |
| 'npm run dev' | 启动开发环境 API 和 UI。 |
| 'npm run build' | 生成生产环境 API、worker、dispatcher 和 UI 资产。 |
| 'npm run start:api' | 启动一个生产环境 API/UI 进程。 |
| 'npm run start:worker' | 启动一个 Delivery Task worker。 |
| 'npm run start:dispatcher' | 启动 Domain Event webhook dispatcher。 |
| 'npm run test:unit' | 运行纯逻辑和边界测试。 |
| 'npm run test:integration' | 运行真实 PostgreSQL 加公共 HTTP 集成测试。 |
| 'npm run test:e2e' | 通过可见控件运行生产构建的 Chromium 测试。 |
| 'npm run test:concurrency' | 针对一个数据库运行至少两个 API 和两个 worker 进程。 |
| 'npm run test:recovery' | 使用可观察屏障、SIGKILL、重启和持久恢复。 |
| 'npm run test:all' | 从干净的数据库运行上述所有非性能门禁。 |
| 'npm run test:perf' | 运行固定的持续负载并验证所有负载后不变量。 |

每个命令在失败时以非零状态退出，清理自己的子进程，并且不需要提示。

## 环境

| 变量 | 默认值 | 规则 |
| --- | --- | --- |
| 'DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/configrelay' | 生产/开发环境权威。 |
| 'TEST_DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/configrelay_test' | 所有有状态测试必需。 |
| 'PORT' | '3000' | 整数 1-65535；API 和生产环境 UI 来源。 |
| 'ADMIN_TOKEN' | 任务本地值 | 仅文档化的管理变更路由需要；切勿记录。 |
| 'WEBHOOK_URL' | 'http://127.0.0.1:4010/events' | Domain Event 投递的 HTTP 端点。 |
| 'WORK_LEASE_SECONDS' | '3' | 整数 1-60；worker 和恢复测试使用的持久化租约时长。 |
| 'CHROMIUM_PATH' | '/usr/bin/chromium' | 项目自有 E2E 的浏览器可执行文件。 |
| 'MANAGED_DATA_ROOT' | '/tmp/configrelay-data' | 暂存或生成字节的可写根目录；切勿直接提供路径。 |
| 'TEST_BARRIER_URL' | 空 | 仅受控恢复测试使用的可选 localhost HTTP 接收器。 |
| 'TEST_BARRIER_TOKEN' | 空 | 设置 URL 时必需的屏障头值；切勿记录。 |

仅绑定到 '127.0.0.1'。日志不得包含令牌、幂等键、原始种子输入、webhook 主体或私有绝对路径。

## 领域和 V1 行为

| 术语 | 规范定义 | 避免 |
| --- | --- | --- |
| Agent | 具有持久 appliedRevision 和单调递增 commandSequence 的已注册端点。 | 客户端、节点 |
| Configuration | 由一个 Fleet 拥有的规范版本化 JSON 内容。 | 设置、负载 |
| Deployment | 使一个 Configuration 修订版成为选定 Agent 期望状态的请求。 | 滚动发布、发布 |
| Assignment | 一个 Agent 的持久期望修订版和投递状态。 | 作业、映射 |
| Delivery Task | 投递一个 Assignment 的租约工作，具有稳定的 deliveryId 和主体。 | 消息、重试 |
| Acknowledgement | Agent 报告，接受或拒绝一个精确修订版和围栏令牌。 | 心跳、响应 |

Deployment：PENDING -> DELIVERING -> APPLIED | FAILED | CANCELLED；Agent assignment：WAITING -> SENT -> ACKED | SUPERSEDED。

1. 发布不可变的 Configuration 修订版，并为确定性的 Agent 选择器快照创建 Deployments。
2. 至少一次按递增的 command sequence 和每个 Agent 的非递减 V1 修订版顺序投递 Assignments。
3. 仅接受当前 assignment token 的确认，并保留重复重放。
4. 在 dispatcher 死亡后恢复投递，并协调重新连接且 applied revision 过期的 Agents。
5. 在 UI 中展示舰队漂移、分配进度、失败、每个 Agent 的历史记录和审计事件。

### 确定性策略

1. Configuration 内容是任何 RFC 8785 JSON 值，大小 <=1 MiB，修订版按 Fleet 连续。Agent 标签和选择器键匹配 [a-z][a-z0-9_.-]{0,63}；选择器是精确大小写等式的 AND。
2. 目标 Agents 是在 Deployment 事务时匹配的那些，并按 agentId 排序；targetDigest 是其换行连接的 ID 的 SHA-256，创建后永不改变。
3. Deployment 创建按提交顺序为每个目标 Agent 分配其下一个正 commandSequence。轮询仅返回最低的非终止序列，并重复相同的 deliveryId、主体和令牌，直到收到有效确认。
4. 确认必须匹配 Agent、Deployment、commandSequence、revision、digest 和当前令牌。正常 V1 投递永远不会发送低于 appliedRevision 的修订版；重新连接协调恢复当前更大的期望修订版。

## 强制不变量

1. 对于每个 Agent，某个 commandSequence 的首次接受确认恰好是先前接受的序列加一，并且匹配当前 assignmentToken；相同的重放没有第二次效果，并且没有过期的令牌或序列可以更改期望或应用状态。
2. 一个 Deployment 捕获不可变的选择器结果和 Configuration 摘要。
3. 过期的 assignment token 不能更改当前期望或应用状态。
4. 每个成功的确认都匹配精确投递的修订版摘要。
5. 重复投递保留 deliveryId、语义主体和每个 Agent 的命令顺序。

这些不变量必须在成功、验证失败、未知 HTTP 结果、重复请求、并发请求、worker 或 dispatcher SIGKILL、重启、迁移和持续负载之后仍然成立。

## HTTP 和 OpenAPI 3.1

在 'GET /openapi.json' 提供规范 OpenAPI，在 'GET /healthz' 提供健康检查。OpenAPI 文档和运行时行为必须一致。API 路由使用 JSON，除非明确记录为原始内容。拒绝不支持的媒体类型，返回 415 'UNSUPPORTED_MEDIA_TYPE'；拒绝格式错误的 JSON，返回 400 'MALFORMED_JSON'；拒绝未知对象键，返回 400 'UNKNOWN_FIELD'；拒绝没有更具体已发布代码的形状或范围违规，返回 400 'INVALID_REQUEST'。语义或状态冲突使用其已发布的 409 代码。在文档化的 ADMIN_TOKEN 路由上，缺失、格式错误或不正确的 Bearer 令牌返回 401 'ADMIN_AUTH_REQUIRED'。

成功的分页集合读取返回 '{items,nextCursor}'。'limit' 默认为 50，是 1 到 100 的整数。游标顺序稳定且不透明；格式错误的游标返回 400 'INVALID_CURSOR'。类型为 'uuid' 的字段是小写 UUID 字符串；未类型化的字符串标识符保留其已发布的语法。时间戳是 UTC，带尾随 'Z'。资源未命中返回 404 'NOT_FOUND'。

错误精确使用：

~~~json
{"error":{"code":"STABLE_CODE","message":"human-readable text","details":{}}}
~~~

以下线符号是规范性的：'uuid' 是小写 RFC 4122 文本，'int' 是 JSON 安全整数，'timestamp' 是带毫秒精度和尾随 Z 的 UTC ISO-8601，'date' 是严格的 YYYY-MM-DD，'sha256' 是 64 位小写十六进制，'currency' 是三个大写 ASCII 字母，'json' 是 RFC 8785 接受的任何值。'http-url' 是没有凭据或片段的绝对 http 或 https URL。'interval' 恰好是 '{startAt:timestamp,endAt:timestamp}'，startAt 在 endAt 之前，表示半开区间 '[startAt,endAt)'。'|null' 字段是必需的且可为空。每个未列出的字段都被拒绝，数组保留其声明的顺序。响应精确使用这些资源形状：

- Agent = {agentId:uuid,fleetId:uuid,labels:{key:string},appliedRevision:int,appliedDigest:sha256|null,desiredRevision:int|null,desiredDigest:sha256|null,drift:boolean,lastCommandSequence:int,lastSeenAt:timestamp}
- Configuration = {fleetId:uuid,revision:int,content:json,canonicalDigest:sha256,createdAt:timestamp}
- Deployment = {deploymentId:uuid,fleetId:uuid,configurationRevision:int,selector:{labels:{key:string,value:string}},targetCount:int,targetDigest:sha256,state:PENDING|DELIVERING|APPLIED|FAILED|CANCELLED,createdAt:timestamp,completedAt:timestamp|null,sequence:int}
- Assignment = {assignmentId:uuid,deploymentId:uuid,agentId:uuid,commandSequence:int,revision:int,digest:sha256,state:WAITING|SENT|ACKED|FAILED|SUPERSEDED,deliveryId:uuid,assignmentToken:string,sentAt:timestamp|null,ackedAt:timestamp|null}
- Acknowledgement = {agentId:uuid,deploymentId:uuid,commandSequence:int,revision:int,digest:sha256,assignmentToken:string,outcome:APPLIED|REJECTED,reportedAt:timestamp}
- AgentPollResponse = {status:COMMAND|NO_CHANGE,command:Assignment|null}；当 status 为 NO_CHANGE 时，command 恰好为 null

公共聚合路由是：

- 'GET /api/v1/deployments?limit&cursor' 和
  'GET /api/v1/deployments/:deploymentId'。
- POST /api/v1/deployments，请求体为 {fleetId, configurationRevision, selector, expectedFleetRevision}；返回 202，包含不可变的 targetCount 和 targetDigest。
- POST /api/v1/fleets/:fleetId/configurations，请求体为 {content, expectedFleetRevision}，精确创建下一个不可变 Configuration，并返回 201，包含其 RFC 8785 规范的 canonicalDigest。
- POST /api/v1/agents/:agentId/poll，请求体为 {appliedRevision}，返回 AgentPollResponse，包含当前有序的 Assignment 或精确的 {status: NO_CHANGE, command: null}。
- POST /api/v1/agents/:agentId/acknowledgements，请求体为 {deploymentId, commandSequence, revision, digest, assignmentToken, outcome}，拒绝过期的令牌或序列。
- POST /api/v1/deployments/:deploymentId/cancel，请求体为 {reason}，仅取代未确认的 Assignment。
- GET /api/v1/agents/:agentId 返回精确的 Agent 形状，GET /api/v1/agents/:agentId/assignments 返回精确的 Assignment 历史记录。
- 'GET /api/v1/domain-events?aggregateId&afterSequence&limit' 按顺序返回已提交的事件。
- 'GET /api/v1/verification-snapshot' 需要 'Authorization: Bearer <ADMIN_TOKEN>'，并返回一个
  可序列化的快照 '{asOf:timestamp,resources:{...},work:[Work],events:[DomainEvent]}'。

### V1 验证快照

完整快照从单个 PostgreSQL 时间点读取；'asOf'、每个资源数组、'work'
和 'events' 必须描述同一数据库快照。V1 'resources' 对象恰好包含以下键，
且不包含其他键：

- 'agents' 使用精确形状 'Agent'，并按标量字段路径元组 'agentId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。
- 'configurations' 使用精确形状 'Configuration'，并按标量字段路径元组 'fleetId'、'revision' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。
- 'deployments' 使用精确形状 'Deployment'，并按标量字段路径元组 'deploymentId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。
- 'assignments' 使用精确形状 'Assignment'，并按标量字段路径元组 'assignmentId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。
- 'acknowledgements' 使用精确形状 'Acknowledgement'，并按标量字段路径元组 'agentId'、'deploymentId'、'commandSequence' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。

每个资源数组恰好包含其声明形状所命名的每个当前或不可变实例一次。每个列出的排序路径解析为标量。标量顺序为 null 优先，然后 false 在 true 之前，整数按数值排序，其他所有字符串形式标量按 UTF-8 字节排序。按完整元组升序排序，然后仅以 RFC 8785 规范 JSON 作为决胜条件。
递归省略每个名称以 'Token' 结尾的对象字段，在所有嵌套深度。

'Work' 恰好是
'{workId:uuid,kind:ASSIGNMENT_DELIVERY,aggregateId:uuid,state:PENDING|LEASED|SUCCEEDED|FAILED|CANCELLED,terminal:boolean,attempt:int,leaseOwner:string|null,leaseExpiresAt:timestamp|null}'。
'kind' 恰好是 'ASSIGNMENT_DELIVERY' 之一。两个租约字段仅在状态为
'LEASED' 时非 null，在其他所有状态下均为 null。'terminal' 仅在状态为
'SUCCEEDED'、'FAILED' 或 'CANCELLED' 时为 true；终止的 Work 被保留。
当没有匹配的 Work 具有 'terminal:false' 时，积压队列恰好被排空。'work' 数组按
workId 排序。

'events' 包含精确的领域事件对象，按 aggregateId、然后 sequence、然后 eventId 排序。对每个事件负载应用相同的递归 '*Token' 省略。省略认证和业务围栏令牌、幂等键、原始 webhook 主体、私有文件系统路径和机密。这是外部不变量查询表面。

以下领域错误对于格式良好的请求是穷尽的，除了上述发布的常见错误，加上 400 'INVALID_REQUEST'、400 'INVALID_CURSOR'、404 'NOT_FOUND' 和 409
'IDEMPOTENCY_CONFLICT'：

| HTTP | 代码 | 精确触发条件 |
| ---: | --- | --- |
| 409 | FLEET_REVISION_CHANGED | expectedFleetRevision 已过期 |
| 409 | STALE_ASSIGNMENT_TOKEN | 确认令牌不再是当前的 |
| 409 | ACKNOWLEDGEMENT_CONFLICT | 同一分配具有另一个语义结果 |
| 409 | DEPLOYMENT_NOT_CANCELLABLE | 部署已终止 |
| 400 | INVALID_AGENT_SELECTOR | 标签选择器键、值或基数无效 |

### 持久幂等性

每个变更都需要 'Idempotency-Key'，1-128 个可见 ASCII 字符。范围是方法、规范
路径和键。在确认成功之前，持久化规范语义请求
指纹和完整状态/主体。相同的重试，包括
重启或未知响应丢失后，返回原始状态和语义 JSON，且无第二次
效果。使用不同语义重用键返回 409 'IDEMPOTENCY_CONFLICT'。并发相同
请求收敛于一个结果；进程本地映射不是权威。在基准测试期间不要过期记录，或在迁移期间重写保存的重放主体。

## 种子契约

'npm run db:seed -- --file <path>' 恰好接受：

'{schemaVersion:1,seedVersion,fleets,agents,configurations,deployments,assignments}; revisions and command sequences are contiguous per authority, canonical digests match content, and Agent capabilities use declared keys only.'

成员模式是精确的：

- fleets[] = {fleetId: uuid, name: string, currentRevision: int}; agents[] = {agentId: uuid, fleetId: uuid, labels: object, appliedRevision: int, appliedDigest: sha256|null, lastCommandSequence: int, lastSeenAt: timestamp}
- configurations[] 使用精确的 Configuration 模式，具有连续的修订和验证的 canonicalDigest
- deployments[] 和 assignments[] 使用精确的线上模式；目标成员资格、摘要、期望/应用修订和终止计数必须协调一致

'seedVersion' 是一个非空字符串，最多 64 个字符。导入器记录规范文件摘要。
相同版本和摘要是无操作重放；相同版本但内容不同则失败，返回
'SEED_VERSION_CONFLICT'。拒绝未知键、重复 ID、缺失引用、无效状态、破坏的
不变量、超出范围的整数和格式错误的时间。任何无效成员拒绝整个导入，
而不更改业务行、任务、幂等性或领域事件。

## 工作进程、事件和恢复

工作进程使用 'WORK_LEASE_SECONDS' 声明有界持久租约。租约所有权必须在
提交结果的短事务内再次证明。在等待 HTTP、文件、时钟或另一个进程时，不要持有数据库事务。过期租约可重新声明，但过期令牌不能提交。

业务状态及其领域事件在一个事务中提交。事件字段为 'eventId'、'aggregateId'、
正整数 'sequence'、'type'、'occurredAt'、'schemaVersion:1' 和 'payload'。必需的事件类型：
`deployment.created`、`assignment.sent`、`assignment.acknowledged`、`assignment.failed`、`deployment.completed`、`deployment.cancelled`。'payload' 对于每个 V1 事件恰好是 '{}'；后续 Manager 事件也使用 '{}'，除非
其发布的契约字面提供另一个负载形状。回滚不创建事件。序列
每个聚合是连续的。

调度器发送 JSON，包含 'X-ConfigRelay-Event-Id' 和 'X-ConfigRelay-Event-Type'。网络错误、
超时和非 2xx 响应以有界退避无限重试。每次重试保持相同的
eventId 和语义主体。成功交付顺序是递增的聚合序列。至少一次
交付可能重复请求；它不得发明另一个事件身份。

### 受控恢复屏障

当 'TEST_BARRIER_URL' 为空时，不存在屏障请求。当两个测试变量都设置时，工作进程
在 'worker.claimed'、'worker.effect-complete' 和 'worker.before-commit' 处继续之前 POST；调度器在 'dispatcher.response-received' 处发布。精确 JSON 是
'{schemaVersion:1,processRole:worker|dispatcher,point,workId,aggregateId,attempt,leaseTokenHash}'，头是 'X-Test-Barrier-Token: <TEST_BARRIER_TOKEN>'。ID 和点跨重试保持相同；
leaseTokenHash 是令牌的 SHA-256，绝不是令牌。204 响应释放进程。保持
响应暂停进程，而不打开数据库事务。连接丢失或非 204 每
100 毫秒重试，使用相同主体，直到租约丢失或进程终止。仅接受 localhost URL。

## 真实 UI

提供桌面和移动流程，用于创建 V1 聚合、查看集合和详情、
执行每个公共用户操作、观察异步交付任务进度、浏览事件和
历史证据，并在刷新后恢复。显示加载、空、验证、冲突、过期、
离线/重试、终止和权限错误状态。使用可见语义控件、键盘导航、
关联标签、焦点管理和 WCAG AA 对比度。绝不需要开发工具或直接 API 调用来
完成主要流程。

## 项目拥有的验证

- 单元测试覆盖确定性策略、状态转换、规范化和边界值。
- 集成测试启动真实 PostgreSQL 和真实 HTTP 进程；它们从不调用内部服务。
- 浏览器 E2E 使用生产构建、真实 Chromium、真实 API/数据库/工作进程和可见控件。
- 并发测试使用至少两个 API 进程和两个工作进程，针对一个 PostgreSQL 数据库。
- 恢复测试使用公共仅测试屏障来观察声明/提交或接收器/ACK 边界，然后
  SIGKILL；随机睡眠不是故障控制。
- 性能测试运行生产构建，针对以下固定间隔，报告 p50/p95/p99、吞吐量、
  成功变更、预期冲突、意外 5xx、积压排空和加载后不变量。

固定的 V1 兼容性能场景：

### 场景 'agent-poll'

- 目标：每秒处理 2,000 个 Agent 轮询，p95 ≤ 80 毫秒
- 模式：'http'
- 方法：'POST'
- 路径：'/api/v1/agents/:agentId/poll'
- 设置：使用 50,000 个 Agent，其中每个 Agent 有一个当前的 WAITING 分配，另有 50,000 个 Agent 没有更新的分配；该场景不确认命令。
- 选择器：交替选择 COMMAND 合格和 NO_CHANGE 的 Agent ID，每个子组按字节轮询。
- 请求：{appliedRevision} 等于种子 Agent 的值；COMMAND Agent 提交最后已知的应用修订，NO_CHANGE Agent 为当前值。
- 并发数：64
- 预热秒数：10
- 测量秒数：60
- 成功标准：仅精确的 200 个 AgentPollResponse 响应体计入；在每 100 个请求的完整块中，测量混合比例必须恰好为 50% COMMAND 和 50% NO_CHANGE。
- 阈值：在 60 秒内至少 2,000 次成功轮询/秒，且 p95 ≤ 80 毫秒；令牌混淆和意外 5xx 错误为零。
- 计时器：吞吐量窗口从预热后的第一个测量请求开始；每个延迟样本从请求发送到完整响应体接收完毕。

### 场景 'acknowledgement-ingest'

- 目标：每秒摄取 1,000 个确认，p95 ≤ 180 毫秒
- 模式：'http'
- 方法：'POST'
- 路径：'/api/v1/agents/:agentId/acknowledgements'
- 设置：在计时前轮询 35,000 个不重叠的当前分配以获取其精确令牌。保留 5,000 个用于预热，30,000 个用于测量。
- 选择器：重复两请求对：一个新确认，然后一个精确的幂等重放。在唯一请求中，90% 结果为 APPLIED，10% 为 REJECTED。
- 请求：{deploymentId,commandSequence,revision,digest,assignmentToken,outcome}；每次重放复用原始键和字节相同的请求体。
- 并发数：64
- 预热秒数：10
- 测量秒数：60
- 成功标准：首次存储的确认或精确重放计入；过期令牌/序列响应不计入，每个唯一分配状态仅变更一次。
- 阈值：在 60 秒内至少 1,000 次成功响应/秒，且 p95 ≤ 180 毫秒，请求混合比例精确为 45% APPLIED、5% REJECTED、50% 重放。
- 计时器：吞吐量窗口从预热后的第一个测量请求开始；每个延迟样本从请求发送到完整响应体接收完毕。

### 场景 'assignment-delivery-recovery'

- 目标：在 120 秒内恢复并交付 50,000 个待处理分配
- 模式：'worker'
- 方法：'N/A'
- 路径：'work:ASSIGNMENT_DELIVERY'
- 设置：恰好 50,000 个位于不同 Agent 上的 WAITING 分配有待交付工作。将两个工作进程保持在 worker.claimed 状态，发送 SIGKILL，等待租约过期，然后启动两个替代进程。
- 选择器：按部署的 createdAt、deploymentId、agentId 交付，并在重试时保留每个 commandSequence 和 deliveryId。
- 请求：不发出测量的客户端请求；设置仅使用已发布的种子和公共 API，在工作者计时器启动前完成。
- 并发数：2
- 预热秒数：0
- 测量秒数：120
- 成功标准：每个选定的分配达到 SENT 状态，并具有稳定的交付身份，没有 ASSIGNMENT_DELIVERY 工作保持非终止状态，且 Agent 期望状态和部署计数保持一致；不要求 ACKED。
- 阈值：所有 50,000 个分配在替代进程启动后 ≤ 120 秒内达到 SENT；过期提交和意外失败为零。
- 计时器：在两个替代进程启动时开始，在证明 SENT 状态、工作排空和所有计数器的即时快照时停止。

固定性能种子：seedVersion perf-v1 恰好包含 100 个舰队、100,000 个 Agent、1,000 个配置、500 个部署和 50,000 个 WAITING 分配，其中 50,000 个不同 Agent 各有一个当前分配。

三个场景是从新迁移的数据库和上述精确种子独立运行的；
完成每个场景's Setup before its Timer begins. Mode 'http' means '方法' and '路径' 命名
唯一测量的公共请求操作，'concurrency' 是精确的闭环客户端数量。模式
'worker' 表示方法 'N/A'，'path' 命名测量的工作种类，'concurrency' 是精确的工作进程
数量。精确使用每个场景的选择器和请求；没有推断的混合工作负载。
运行精确 'warmupSeconds' 秒的未测量时间，然后精确 'measureSeconds' 秒的测量时间，或直到
计时器声明的终止条件。有状态预热和测量身份必须不重叠。计数
完整 HTTP 响应体以计算延迟。预期发布的冲突单独报告，除非
场景的成功标准和阈值明确计入它们。

基准容器有 4 个逻辑 CPU 和 8 GiB RAM；PostgreSQL 16、Chromium、两个 API 进程、
指定的工作进程和一个调度器共享该限制。每个后续兼容二进制文件必须重新运行
这三个相同场景，不更改任何字段或阈值。

意外 5xx 计数必须为零。在满足延迟或吞吐量但任何强制不变量为假时
视为性能运行失败。

## 范围外

- 配置模式设计
- Agent 软件更新
- 多区域复制
- 密钥分发
- 点对点交付

## 交接

保持 README 和 OpenAPI 最新。以发现优先的审查结束，并报告架构、模块和
进程所有权、公共接口、成功/失败数据流、事务和租约边界、
迁移、兼容性、执行的精确命令、测试和性能结果、恢复证据、已知
风险以及所有未运行的检查。不要声称实际未执行的检查。
