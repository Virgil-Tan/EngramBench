# QuotaMesh

根据此有意留空的仓库构建 QuotaMesh。本 README 是完整的产品合同。请勿在合同之外发明行为。在做出合同未明确规定的产品决策之前，请先询问。

## 必需的技术栈

- Node.js 22、TypeScript、React、PostgreSQL 16、npm 以及预装的 Chromium。
- PostgreSQL 是业务状态、幂等性、租约、事件和排序的唯一权威。
- 生产环境 UI 必须使用公共 HTTP API；不得使用模拟、内存数据库或仅浏览器端的状态来提供正确性。
- 使用整数域数量和 UTC ISO-8601 时间戳。不得对金额、容量、序列、持续时间单位或守恒量使用浮点数。

## 必需的非交互式命令

| 命令 | 合同 |
| --- | --- |
| 'npm run db:migrate' | 反复且安全地应用所有版本化迁移。 |
| 'npm run db:seed -- --file <path>' | 原子性地导入版本化 JSON 种子数据。 |
| 'npm run dev' | 启动开发环境 API 和 UI。 |
| 'npm run build' | 生成生产环境 API、worker、dispatcher 和 UI 资源。 |
| 'npm run start:api' | 启动一个生产环境 API/UI 进程。 |
| 'npm run start:worker' | 启动一个过期任务 worker。 |
| 'npm run start:dispatcher' | 启动域事件 webhook dispatcher。 |
| 'npm run test:unit' | 运行纯逻辑和边界测试。 |
| 'npm run test:integration' | 运行真实 PostgreSQL 加公共 HTTP 集成测试。 |
| 'npm run test:e2e' | 通过可见控件运行生产构建的 Chromium 测试。 |
| 'npm run test:concurrency' | 针对一个数据库运行至少两个 API 和两个 worker 进程。 |
| 'npm run test:recovery' | 使用可观察屏障、SIGKILL、重启和持久化恢复。 |
| 'npm run test:all' | 从干净的数据库运行上述所有非性能门禁。 |
| 'npm run test:perf' | 运行固定的持续负载并验证所有负载后不变量。 |

每个命令在失败时以非零状态退出，清理自己的子进程，并且不需要任何提示。

## 环境变量

| 变量 | 默认值 | 规则 |
| --- | --- | --- |
| 'DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/quotamesh' | 生产/开发环境的权威。 |
| 'TEST_DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/quotamesh_test' | 所有有状态测试必需。 |
| 'PORT' | '3000' | 整数 1-65535；API 和生产 UI 的来源。 |
| 'ADMIN_TOKEN' | 任务本地值 | 仅文档化的管理员变更路由需要；切勿记录它。 |
| 'WEBHOOK_URL' | 'http://127.0.0.1:4010/events' | 域事件投递的 HTTP 端点。 |
| 'WORK_LEASE_SECONDS' | '3' | 整数 1-60；worker 和恢复测试使用的持久化租约时长。 |
| 'CHROMIUM_PATH' | '/usr/bin/chromium' | 项目自有 E2E 的浏览器可执行文件。 |
| 'MANAGED_DATA_ROOT' | '/tmp/quotamesh-data' | 暂存或生成字节的可写根目录；切勿直接提供路径。 |
| 'TEST_BARRIER_URL' | 空 | 仅受控恢复测试使用的可选本地主机 HTTP 接收器。 |
| 'TEST_BARRIER_TOKEN' | 空 | 当 URL 已设置时必需的屏障头值；切勿记录它。 |

仅绑定到 '127.0.0.1'。日志不得包含令牌、幂等键、原始种子输入、webhook 主体或私有绝对路径。

## 领域和 V1 行为

| 术语 | 规范定义 | 避免使用 |
| --- | --- | --- |
| 配额池 | 租户拥有的、针对已声明维度的整数容量向量。 | 限制、桶 |
| 维度 | 命名单位，如 cpuMillis、memoryMiB 或 storageMiB。 | 资源、字段 |
| 预留 | 对非空容量向量的原子性临时占用。 | 持有、分配 |
| 承诺 | 将已持有容量持久转换为活跃使用。 | 用量、确认 |
| 过期任务 | 在 expiresAt 之后释放未承诺预留的持久化工作。 | 定时器、cron |
| 准入队列 | 针对当前无法容纳的请求的确定性 FIFO 加优先级列表。 | 等待列表、积压 |

预留：HELD -> COMMITTED | RELEASED | EXPIRED；终态转换互斥。

1. 创建配额池，并在所有请求的维度上原子性地预留向量。
2. 跨 API 实例提交、释放或过期预留，且只有一个终态胜出者。
3. 将拒绝的准入请求排队，并在完整向量可容纳时公平地提升它们。
4. 在 worker 死亡后，不使用进程本地计数器恢复过期和提升。
5. 在 UI 中展示容量、已持有/已承诺数量、队列位置、历史记录和事件投递。

### 确定性策略

1. 维度名称匹配 [a-z][a-zA-Z0-9]{0,31}；容量和数量是 0..9007199254740991 的整数，请求声明 1..20 个由池定义的正维度。
2. 持有在 transactionTime + ttlSeconds 时过期，其中 ttlSeconds 为 1..3600。创建操作比较每个维度，要么递增所有已持有值，要么不改变任何值。
3. 提交将完整向量从已持有移动到已承诺。释放/过期减去已持有；在 V1 中释放承诺超出范围。
4. 准入顺序为优先级降序、requestedAt 升序、admissionEntryId 升序。提升仅评估队首，并原子性地创建具有原始向量和新的已发布 300 秒 ttl 的预留。

## 强制不变量

1. 对于每个池和维度，已持有加已承诺数量永不超过容量，且任何值不为负。
2. 预留拥有其完整的请求向量，或什么都不拥有。
3. 提交、释放或过期对每个维度恰好调整一次。
4. 准入队列条目最多产生一个预留，且不能绕过同等优先级的符合条件的更早条目。
5. 所有变更重放在重启和并发 API 实例之间保持稳定。

这些不变量必须在成功、验证失败、未知 HTTP 结果、重复请求、并发请求、worker 或 dispatcher SIGKILL、重启、迁移和持续负载之后仍然成立。

## HTTP 和 OpenAPI 3.1

在 'GET /openapi.json' 提供规范 OpenAPI，在 'GET /healthz' 提供健康检查。OpenAPI 文档和运行时行为必须一致。API 路由使用 JSON，除非明确文档化的原始内容。对不支持的媒体类型返回 415 'UNSUPPORTED_MEDIA_TYPE'，对格式错误的 JSON 返回 400 'MALFORMED_JSON'，对未知对象键返回 400 'UNKNOWN_FIELD'，对没有更具体已发布代码的形状或范围违规返回 400 'INVALID_REQUEST'。语义或状态冲突使用其已发布的 409 代码。在文档化的 ADMIN_TOKEN 路由上，缺失、格式错误或不正确的 Bearer 令牌返回 401 'ADMIN_AUTH_REQUIRED'。

成功的分页集合读取返回 '{items,nextCursor}'。'limit' 默认为 50，是 1 到 100 的整数。游标顺序稳定且不透明；格式错误的游标返回 400 'INVALID_CURSOR'。类型为 'uuid' 的字段是小写 UUID 字符串；未类型化的字符串标识符保留其已发布的语法。时间戳是带尾随 'Z' 的 UTC。资源未命中返回 404 'NOT_FOUND'。

错误精确使用：

~~~json
{"error":{"code":"STABLE_CODE","message":"human-readable text","details":{}}}
~~~

以下线格式是规范性的：'uuid' 是小写 RFC 4122 文本，'int' 是 JSON 安全整数，'timestamp' 是带毫秒精度和尾随 Z 的 UTC ISO-8601，'date' 是严格的 YYYY-MM-DD，'sha256' 是 64 位小写十六进制，'currency' 是三个大写 ASCII 字母，'json' 是 RFC 8785 接受的任何值。'http-url' 是不带凭据或片段的绝对 http 或 https URL。'interval' 恰好是 '{startAt:timestamp,endAt:timestamp}'，startAt 在 endAt 之前，并表示半开区间 '[startAt,endAt)'。'|null' 字段是必需且可空的。每个未列出的字段都被拒绝，数组保持其声明的顺序。响应精确使用这些资源形状：

- QuotaPool = {poolId:uuid,tenantId:uuid,name:string,capacity:{dimension:int},held:{dimension:int},committed:{dimension:int},revision:int}
- Reservation = {reservationId:uuid,poolId:uuid,ownerId:uuid,quantities:{dimension:int},state:HELD|COMMITTED|RELEASED|EXPIRED,expiresAt:timestamp,createdAt:timestamp,terminalAt:timestamp|null,sequence:int}
- Commitment = {commitmentId:uuid,reservationId:uuid,poolId:uuid,ownerId:uuid,quantities:{dimension:int},committedAt:timestamp,releasedAt:timestamp|null}
- AdmissionEntry = {admissionEntryId:uuid,poolId:uuid,ownerId:uuid,quantities:{dimension:int},priority:int,state:WAITING|PROMOTED|WITHDRAWN,requestedAt:timestamp,reservationId:uuid|null,position:int|null}

公共聚合路由为：

- 'GET /api/v1/reservations?limit&cursor' 和
  'GET /api/v1/reservations/:reservationId'。
- POST /api/v1/quota-pools/:poolId/reservations 使用 {ownerId,quantities,ttlSeconds}；在验证每个声明的维度后，返回 201 HELD 及 expiresAt，或 409 QUOTA_EXCEEDED 及可选的队列资格。
- POST /api/v1/quota-pools 使用 {tenantId,name,capacity} 返回 201 QuotaPool，且已持有和已承诺向量为零。
- POST /api/v1/reservations/:reservationId/commit 使用 {} 创建一个承诺。
- POST /api/v1/reservations/:reservationId/release 使用 {reason} 返回合法的终态结果。
- POST /api/v1/admission-queue 使用 {poolId,ownerId,quantities,priority} 创建一个排队请求。
- GET /api/v1/quota-pools/:poolId 返回精确的 QuotaPool 总计，GET /api/v1/quota-pools/:poolId/admission-queue 返回带有派生位置的 AdmissionEntry 对象。
- 'GET /api/v1/domain-events?aggregateId&afterSequence&limit' 按顺序返回已提交事件。
- 'GET /api/v1/verification-snapshot' 需要 'Authorization: Bearer <ADMIN_TOKEN>' 并返回一个可序列化的快照 '{asOf:timestamp,resources:{...},work:[Work],events:[DomainEvent]}'。

### V1 验证快照

完整快照从单个 PostgreSQL 时间点读取；'asOf'、每个资源数组 'work' 和 'events' 必须描述同一数据库快照。V1 'resources' 对象恰好包含以下键，且无其他键：

- 'dimensions' 使用精确形状 'Dimension = {name:string,unit:string}'，并按标量字段路径元组 'name' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。
- 'quotaPools' 使用精确形状 'QuotaPool'，并按标量字段路径元组 'poolId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。
- 'reservations' 使用精确形状 'Reservation'，并按标量字段路径元组 'reservationId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。
- 'commitments' 使用精确形状 'Commitment'，并按标量字段路径元组 'commitmentId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。
- 'admissionEntries' 使用精确形状 'AdmissionEntry'，并按标量字段路径元组 'admissionEntryId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。

每个资源数组恰好包含其声明形状所命名的每个当前或不可变实例一次。每个列出的排序路径解析为标量。标量顺序为 null 优先，然后 false 在 true 之前，整数按数值排序，所有其他字符串形式标量按 UTF-8 字节排序。按完整元组升序排序，然后仅以 RFC 8785 规范 JSON 作为决胜条件。递归省略每个名称以 'Token' 结尾的对象字段，无论嵌套深度如何。

'Work' 恰好是 '{workId:uuid,kind:RESERVATION_EXPIRY|ADMISSION_PROMOTION,aggregateId:uuid,state:PENDING|LEASED|SUCCEEDED|FAILED|CANCELLED,terminal:boolean,attempt:int,leaseOwner:string|null,leaseExpiresAt:timestamp|null}'。
'kind' 恰好是 'RESERVATION_EXPIRY'、'ADMISSION_PROMOTION' 之一。两个租约字段仅在状态为 'LEASED' 时非空，在所有其他状态下均为 null。'terminal' 仅在状态为 'SUCCEEDED'、'FAILED' 或 'CANCELLED' 时为 true；终止的 Work 被保留。
当没有匹配的 Work 具有 'terminal:false' 时，积压队列即被排空。'work' 数组按 workId 排序。

'events' 包含精确的领域事件对象，按 aggregateId、sequence、eventId 排序。对每个事件负载应用相同的递归 '*Token' 省略。省略身份验证和业务围栏令牌、幂等键、原始 webhook 主体、私有文件系统路径和机密。这是外部不变量查询面。

以下领域错误对于格式良好的请求是穷尽的，除上述已发布的常见错误外，还包括 400 'INVALID_REQUEST'、400 'INVALID_CURSOR'、404 'NOT_FOUND' 和 409 'IDEMPOTENCY_CONFLICT'：

| HTTP | 代码 | 精确触发条件 |
| ---: | --- | --- |
| 409 | QUOTA_EXCEEDED | 一个或多个维度无法容纳 |
| 409 | RESERVATION_EXPIRED | 提交发生在 expiresAt 或之后 |
| 409 | RESERVATION_NOT_RELEASABLE | Reservation 不是 HELD 状态 |
| 409 | ADMISSION_HEAD_BLOCKED | 后续同优先级条目无法被提升 |
| 400 | INVALID_QUOTA_VECTOR | 维度、基数或整数范围无效 |

### 持久幂等性

每个变更操作都需要 'Idempotency-Key'，1-128 个可见 ASCII 字符。作用域为方法、规范路径和键。在确认成功之前，持久化规范语义请求指纹和完整状态/主体。相同的重试（包括重启或未知响应丢失后）返回原始状态和语义 JSON，且无第二次效果。使用不同语义重用键返回 409 'IDEMPOTENCY_CONFLICT'。并发相同请求收敛于一个结果；进程本地映射不是权威。在基准测试期间不使记录过期，也不在迁移期间重写已保存的重放主体。

## 种子契约

'npm run db:seed -- --file <path>' 恰好接受：

'{schemaVersion:1,seedVersion,dimensions,quotaPools,commitments,reservations,admissionQueue}; all quantities and capacities are bounded non-negative integers and derived held/committed totals must reconcile exactly.'

成员模式是精确的：

- dimensions[] = {name:string,unit:string}; quotaPools[] = {poolId:uuid,tenantId:uuid,name:string,capacity:object}，包含所有声明的维度
- commitments[] 使用精确的 Commitment 字段；reservations[] 使用精确的 Reservation 字段；Admission 条目使用精确的 AdmissionEntry 字段，但派生位置除外
- 对于每个 Pool 和 Dimension，种子化的持有和承诺向量从成员行重新计算，且不能超过容量

'seedVersion' 是非空字符串，最多 64 个字符。导入器记录规范文件摘要。相同版本和摘要是无操作重放；相同版本但内容不同则失败并返回 'SEED_VERSION_CONFLICT'。拒绝未知键、重复 ID、缺失引用、无效状态、破坏的不变量、超出范围的整数和格式错误的时间。任何无效成员拒绝整个导入，而不更改业务行、任务、幂等性或领域事件。

## 工作进程、事件和恢复

工作进程使用 'WORK_LEASE_SECONDS' 声明有界持久租约。租约所有权必须在提交结果的短事务内再次证明。在等待 HTTP、文件、时钟或其他进程时，不持有数据库事务。过期租约可重新声明，但过期令牌无法提交。

业务状态及其领域事件在一个事务中提交。事件字段为 'eventId'、'aggregateId'、正整数 'sequence'、'type'、'occurredAt'、'schemaVersion:1' 和 'payload'。必需事件类型：`reservation.held`、`reservation.committed`、`reservation.released`、`reservation.expired`、`admission.promoted`。'payload' 对每个 V1 事件恰好是 '{}'；后续 Manager 事件也使用 '{}'，除非其已发布契约明确提供其他负载形状。回滚不产生事件。每个聚合的序列是连续的。

调度器发送带有 'X-QuotaMesh-Event-Id' 和 'X-QuotaMesh-Event-Type' 的 JSON。网络错误、超时和非 2xx 响应以有界退避无限重试。每次重试保持相同的 eventId 和语义主体。成功投递顺序为递增的聚合序列。至少一次投递可能重复请求；不得发明另一个事件身份。

### 受控恢复屏障

当 'TEST_BARRIER_URL' 为空时，不存在屏障请求。当两个测试变量均设置时，工作进程在 'worker.claimed'、'worker.effect-complete' 和 'worker.before-commit' 处继续之前 POST；调度器在 'dispatcher.response-received' 处 POST。精确 JSON 为 '{schemaVersion:1,processRole:worker|dispatcher,point,workId,aggregateId,attempt,leaseTokenHash}'，头部为 'X-Test-Barrier-Token: <TEST_BARRIER_TOKEN>'。ID 和点在重试间保持相同；leaseTokenHash 是令牌的 SHA-256，而非令牌本身。204 响应释放进程。持有响应暂停进程，且不打开数据库事务。连接丢失或非 204 响应每 100 毫秒以相同主体重试，直到租约丢失或进程终止。仅接受 localhost URL。

## 真实 UI

提供桌面和移动流程，用于创建 V1 聚合、查看集合和详情、执行每个公开用户操作、观察异步过期任务进度、浏览事件和历史证据，以及在刷新后恢复。显示加载、空、验证、冲突、过期、离线/重试、终止和权限错误状态。使用可见语义控件、键盘导航、关联标签、焦点管理和 WCAG AA 对比度。绝不要求使用 devtools 或直接 API 调用来完成主流程。

## 项目自有验证

- 单元测试覆盖确定性策略、状态转换、规范化和边界值。
- 集成测试启动真实 PostgreSQL 和真实 HTTP 进程；绝不调用内部服务。
- 浏览器 E2E 使用生产构建、真实 Chromium、真实 API/数据库/工作进程和可见控件。
- 并发测试使用至少两个 API 进程和两个工作进程，针对一个 PostgreSQL 数据库。
- 恢复测试使用公开的仅测试屏障来观察声明/提交或接收方/ACK 边界，然后 SIGKILL；随机睡眠不是故障控制。
- 性能测试运行生产构建，针对以下固定间隔，报告 p50/p95/p99、吞吐量、成功变更、预期冲突、意外 5xx、积压排空和加载后不变量。

固定 V1 兼容性能场景：

### 场景 'quota-pool-read'

- 目标：提供 500 次配额读取/秒，p95 <= 100 毫秒
- 模式：'http'
- 方法：'GET'
- 路径：'/api/v1/quota-pools/:poolId'
- 设置：使用所有 1,000 个种子化配额池；读取不改变容量向量。
- 选择器：按字节顺序轮询 poolId 值。
- 请求：无主体或查询参数。
- 并发：64
- 预热秒数：10
- 测量秒数：60
- 成功：仅 200 个 QuotaPool 响应，其持有和承诺向量与成员数一致。
- 阈值：至少 500 次成功读取/秒持续 60 秒，且 p95 <= 100 毫秒；不一致向量和意外 5xx 为零。
- 计时器：吞吐量窗口从预热后第一个测量请求开始；每个延迟样本从请求发送到完整响应主体结束。

### 场景 'hot-pool-reservation-race'

- 目标：以 p95 ≤ 400 毫秒处理 200 个热池预订竞争/秒
- 模式：'http'
- 方法：'POST'
- 路径：'/api/v1/quota-pools/:poolId/reservations'
- 设置：在预热前，通过公共 API 创建十个测量池和十个预热池。每个池均包含全部五个维度；八个测量备用池每个维度的容量为 20,000，另外两个池已饱和。
- 选择器：重复八次备用池请求，然后两次饱和池请求，在每个子组内按 poolId 轮询。
- 请求：{ownerId, quantities:{每个声明的维度:1}, ttlSeconds:300}；ownerId 和键在每个新请求中唯一。
- 并发数：64
- 预热秒数：10
- 测量秒数：60
- 成功：备用目标返回 201 HELD，饱和目标返回精确的 409 QUOTA_EXCEEDED；完成尝试的吞吐量包括两者，而只有 201 计入成功预订。
- 阈值：在 60 秒内至少 200 次完整尝试/秒，且所有响应的 p95 ≤ 400 毫秒，每 100 次尝试中精确包含 80% 的 201 和 20% 的预期 409。
- 计时器：吞吐量窗口从预热后的第一个测量请求开始；每个延迟样本从请求分发到完整响应体结束。

### 场景 'expiry-and-admission-recovery'

- 目标：在恢复后 60 秒内过期 20,000 个 HELD 预订并提升 20,000 个准入条目
- 模式：'worker'
- 方法：'N/A'
- 路径：'work:RESERVATION_EXPIRY,ADMISSION_PROMOTION'
- 设置：恰好有 20,000 个 HELD 预订到期，且恰好有 20,000 个 WAITING 准入条目在释放后有资格。将两个工作进程保持在 worker.claimed，发送 SIGKILL，等待租约过期，然后启动两个替换进程。
- 选择器：按 expiresAt,reservationId 过期，并按优先级降序、requestedAt、admissionEntryId 提升每个池，不绕过。
- 请求：不发出测量的客户端请求；设置仅使用已发布的种子和公共 API，在工作进程计时器启动之前完成。
- 并发数：2
- 预热秒数：0
- 测量秒数：60
- 成功：所有 20,000 个预订变为 EXPIRED，所有 20,000 个条目变为 PROMOTED，两种工作类型均无非终止状态，且每个维度均保持容量守恒。
- 阈值：两个 20,000 条记录的积压在替换进程生成后 ≤ 60 秒内排空；超额订阅、陈旧提交和意外失败计数均为零。
- 计时器：在两个替换进程生成时启动，并在首次证明所有 40,000 个终止转换和不变量成立的时间点快照时停止。

固定性能种子：seedVersion perf-v1 恰好包含 5 个维度、1,000 个配额池、1,000 个承诺、100,000 个预订和 20,000 个准入队列条目；恰好有 20,000 个 HELD 预订到期，且每个排队条目在释放后有资格。

这三个场景是从新迁移的数据库和上述精确种子独立运行的；
完成每个场景's Setup before its Timer begins. Mode 'http' means '方法' and '路径' 名称是
唯一测量的公共请求操作，'concurrency' 是精确的闭环客户端数量。模式
'worker' 表示方法 'N/A'，'path' 命名测量的工作类型，'concurrency' 是精确的工作进程
数量。精确使用每个场景的选择器和请求；不存在推断的混合工作负载。
精确运行 'warmupSeconds' 秒的未测量时间，然后精确运行 'measureSeconds' 秒的测量时间，或直到
计时器声明的终止条件。有状态预热和测量身份必须不相交。计数
完整的 HTTP 响应体以计算延迟。预期的已发布冲突单独报告，除非
场景的成功和阈值明确将其计入。

基准容器具有 4 个逻辑 CPU 和 8 GiB RAM；PostgreSQL 16、Chromium、两个 API 进程、
指定的工作进程和一个调度器共享该限制。每个后续兼容二进制文件必须重新运行
相同的这三个场景，不更改任何字段或阈值。

意外 5xx 计数必须为零。在满足延迟或吞吐量的同时，任何强制不变量为假
则视为性能运行失败。

## 范围外

- 云资源调配
- 计费
- 跨区域共识
- 浮点数量
- 超过两个层级

## 交接

保持 README 和 OpenAPI 最新。以发现优先的审查结束，并报告架构、模块和
进程所有权、公共接口、成功/失败数据流、事务和租约边界、
迁移、兼容性、执行的精确命令、测试和性能结果、恢复证据、已知
风险以及所有未运行的检查。不要声称实际未执行的检查。
