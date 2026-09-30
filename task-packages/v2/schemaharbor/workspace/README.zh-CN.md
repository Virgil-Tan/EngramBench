# SchemaHarbor

从本空白仓库构建 SchemaHarbor。本 README 是完整的产品契约。请勿在契约之外发明行为。在做出契约未明确规定的产品决策之前，请先询问。

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
| 'npm run build' | 生成生产环境 API、worker、dispatcher 和 UI 资源。 |
| 'npm run start:api' | 启动一个生产环境 API/UI 进程。 |
| 'npm run start:worker' | 启动一个验证任务 worker。 |
| 'npm run start:dispatcher' | 启动领域事件 webhook dispatcher。 |
| 'npm run test:unit' | 运行纯逻辑和边界测试。 |
| 'npm run test:integration' | 运行真实 PostgreSQL 加公共 HTTP 集成测试。 |
| 'npm run test:e2e' | 通过可见控件运行生产构建的 Chromium 测试。 |
| 'npm run test:concurrency' | 针对一个数据库运行至少两个 API 和两个 worker 进程。 |
| 'npm run test:recovery' | 使用可观察屏障、SIGKILL、重启和持久恢复。 |
| 'npm run test:all' | 从干净数据库运行上述所有非性能门禁。 |
| 'npm run test:perf' | 运行固定持续负载并验证所有负载后不变量。 |

每个命令在失败时以非零退出，清理自身的子进程，并且不需要任何提示。

## 环境

| 变量 | 默认值 | 规则 |
| --- | --- | --- |
| 'DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/schemaharbor' | 生产/开发环境权威。 |
| 'TEST_DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/schemaharbor_test' | 所有有状态测试必需。 |
| 'PORT' | '3000' | 整数 1-65535；API 和生产 UI 来源。 |
| 'ADMIN_TOKEN' | 任务本地值 | 仅用于文档化的管理变更路由；切勿记录。 |
| 'WEBHOOK_URL' | 'http://127.0.0.1:4010/events' | 领域事件投递的 HTTP 端点。 |
| 'WORK_LEASE_SECONDS' | '3' | 整数 1-60；worker 和恢复测试使用的持久租约时长。 |
| 'CHROMIUM_PATH' | '/usr/bin/chromium' | 项目自有 E2E 的浏览器可执行文件。 |
| 'MANAGED_DATA_ROOT' | '/tmp/schemaharbor-data' | 暂存或生成字节的可写根目录；切勿直接提供路径。 |
| 'TEST_BARRIER_URL' | 空 | 仅受控恢复测试使用的可选 localhost HTTP 接收器。 |
| 'TEST_BARRIER_TOKEN' | 空 | 设置 URL 时必需的屏障头值；切勿记录。 |

仅绑定到 '127.0.0.1'。日志不得包含令牌、幂等键、原始种子输入、webhook 主体或私有绝对路径。

## 领域和 V1 行为

| 术语 | 规范定义 | 避免 |
| --- | --- | --- |
| 主题 | 一个稳定名称，其 Schema 版本构成一个有序的兼容性历史。 | 主题、表 |
| Schema 版本 | 具有主题本地整数版本的规范 JSON schema 内容。 | 文档、修订 |
| 兼容模式 | 验证开始时捕获的 BACKWARD、FORWARD 或 FULL 规则。 | 策略、检查 |
| 验证任务 | 将草稿与所需已发布历史进行比较的持久租约工作。 | 作业、lint |
| 发布 | 分配下一个版本并使内容可发现的原子转换。 | 保存、上传 |
| 依赖 | 对一个已发布 Schema 版本的固定引用。 | 导入、链接 |

Schema 草稿：VALIDATING -> VALID -> PUBLISHED、VALIDATING -> REJECTED 以及 VALIDATING|VALID -> STALE；发布创建一个不可变的 Schema 版本。

1. 创建主题和具有固定已发布依赖的规范草稿 schema。
2. 针对捕获的主题头部异步运行兼容性验证。
3. 仅当头部和兼容模式仍与验证快照匹配时才发布。
4. 对语义 JSON 内容去重，并在实例和重启之间重放变更结果。
5. 在真实 UI 中展示差异、验证发现、历史、依赖和发布事件。

### 确定性策略

1. 方言仅为上述 RecordSchema；未知键、嵌套值、重复的大小写敏感字段名、循环和自依赖均无效。依赖按 subjectId 然后 version 排序，canonicalDigest 是 RFC 8785 {schema,dependencies} 的 SHA-256。
2. BACKWARD 要求每个旧字段以相同类型保留，允许 required 变为 optional，并且仅允许新增 optional 字段。FORWARD 要求每个旧 required 字段以相同类型保持 required，允许移除 optional 字段，并允许新增字段，因为读取器忽略未知字段。
3. FULL 应用两条规则：现有字段类型和 required 标志不能更改，现有 required 字段不能消失，新字段必须为 optional。针对主题的每个已发布版本（而不仅仅是头部）进行验证。
4. 依赖是精确的已发布固定点，并形成全局无环图。仅当 expectedHeadVersion、模式修订、验证摘要和依赖头部仍与捕获的快照匹配时，发布才分配 headVersion + 1。

## 强制不变量

1. 一个主题对每个整数版本最多有一个已发布的 Schema 版本，且无间隙。
2. 已发布的规范内容和依赖固定点永不更改。
3. 发布仅针对其任务验证的确切头部和兼容模式成功。
4. 语义等价的规范 JSON 不能在一个主题中产生两个版本。
5. 被拒绝或过期的验证任务不产生发布或发布事件。

这些不变量必须在成功、验证失败、未知 HTTP 结果、重复请求、并发请求、worker 或 dispatcher SIGKILL、重启、迁移和持续负载之后仍然成立。

## HTTP 和 OpenAPI 3.1

在 'GET /openapi.json' 提供规范 OpenAPI，在 'GET /healthz' 提供健康检查。OpenAPI 文档和运行时行为必须一致。API 路由使用 JSON，除非明确文档化的原始内容。对不支持的媒体类型返回 415 'UNSUPPORTED_MEDIA_TYPE'，对格式错误的 JSON 返回 400 'MALFORMED_JSON'，对未知对象键返回 400 'UNKNOWN_FIELD'，对没有更具体已发布代码的形状或范围违规返回 400 'INVALID_REQUEST'。语义或状态冲突使用其已发布的 409 代码。在文档化的 ADMIN_TOKEN 路由上，缺失、格式错误或不正确的 Bearer 令牌返回 401 'ADMIN_AUTH_REQUIRED'。

成功的分页集合读取返回 '{items,nextCursor}'。'limit' 默认为 50，是 1 到 100 的整数。游标顺序稳定且不透明；格式错误的游标返回 400 'INVALID_CURSOR'。类型为 'uuid' 的字段是小写 UUID 字符串；未类型化的字符串标识符保留其已发布的语法。时间戳为 UTC，带尾随 'Z'。资源未命中返回 404 'NOT_FOUND'。

错误精确使用：

~~~json
{"error":{"code":"STABLE_CODE","message":"human-readable text","details":{}}}
~~~

以下线格式是规范性的：'uuid' 是小写 RFC 4122 文本，'int' 是 JSON 安全整数，'timestamp' 是带毫秒精度和尾随 Z 的 UTC ISO-8601，'date' 是严格 YYYY-MM-DD，'sha256' 是 64 个小写十六进制，'currency' 是三个大写 ASCII 字母，'json' 是 RFC 8785 接受的任何值。'http-url' 是不带凭据或片段的绝对 http 或 https URL。'interval' 恰好是 '{startAt:timestamp,endAt:timestamp}'，startAt 在 endAt 之前，表示半开区间 '[startAt,endAt)'。'|null' 字段是必需且可空的。每个未列出的字段都被拒绝，数组保留其声明的顺序。响应精确使用这些资源形状：

- Subject = {subjectId:uuid,name:string,compatibilityMode:BACKWARD|FORWARD|FULL,modeRevision:int,headVersion:int|null,createdAt:timestamp}
- RecordSchema = {name:string,fields:{fieldName:{type:STRING|INTEGER|BOOLEAN|required:boolean}}}; fieldName 匹配 [a-z][a-zA-Z0-9_]{0,63}
- SchemaDraft = {draftId:uuid,subjectId:uuid,expectedHeadVersion:int|null,compatibilityMode:BACKWARD|FORWARD|FULL,modeRevision:int,schema:RecordSchema,dependencies:[{subjectId:uuid,version:int}],canonicalDigest:sha256,state:VALIDATING|VALID|PUBLISHED|REJECTED|STALE,findings:[{code:string,field:string|null,message:string}],createdAt:timestamp}
- SchemaVersion = {schemaVersionId:uuid,subjectId:uuid,version:int,compatibilityMode:BACKWARD|FORWARD|FULL,modeRevision:int,schema:RecordSchema,canonicalDigest:sha256,dependencies:[{subjectId:uuid,version:int}],publishedAt:timestamp,sequence:int}; compatibilityMode 和 modeRevision 是用于验证此版本的不可变值
- LatestSchemaResponse = {subject:Subject,version:SchemaVersion|null}; 当 subject.headVersion 为 null 时，version 恰好为 null
- SchemaDiff = {addedFields:[string],removedFields:[string],typeChanges:[{field:string,from:string,to:string}],requiredChanges:[{field:string,from:boolean,to:boolean}]}; 每个数组按字段排序

公共聚合路由如下：

- 'GET /api/v1/schema-versions?limit&cursor' 和
  'GET /api/v1/schema-versions/:schemaVersionId'。
- POST /api/v1/subjects/:subjectId/schema-drafts，请求体为 {schema,dependencies:[{subjectId,version}],expectedHeadVersion}；返回 202 VALIDATING 及 canonicalDigest。
- POST /api/v1/subjects，请求体为 {name,compatibilityMode}，返回 201 Subject，其中 modeRevision 为 1，headVersion 为 null；若名称已存在则返回 409 SUBJECT_NAME_EXISTS。
- POST /api/v1/schema-drafts/:draftId/publish，请求体为 {}，除非状态为 VALID，否则返回 409 SCHEMA_DRAFT_NOT_PUBLISHABLE 且不产生变更。若状态为 VALID，则重新检查捕获的 Subject head、modeRevision 及依赖 head；若存在不匹配，则原子地将 Draft 状态改为 STALE 并返回 409 SCHEMA_VALIDATION_STALE，且不生成 SchemaVersion；若成功，则返回 201 {draft:SchemaDraft（状态为 PUBLISHED）,version:SchemaVersion}。
- POST /api/v1/subjects/:subjectId/compatibility-mode，请求体为 {mode,expectedRevision}，原子地递增 modeRevision 并返回确切的 Subject；若 expectedRevision 不匹配，则返回 409 SUBJECT_MODE_REVISION_CHANGED 且不改变状态。
- GET /api/v1/subjects/:subjectId/versions/latest 从单个数据库快照返回确切的 LatestSchemaResponse。
- GET /api/v1/subjects/:subjectId/versions/:version/diff?against 返回确定性的结构差异。
- GET /api/v1/subjects/:subjectId/versions?limit&cursor 按版本升序返回确切的 SchemaVersion 对象。
- 'GET /api/v1/domain-events?aggregateId&afterSequence&limit' 按顺序返回已提交的事件。
- 'GET /api/v1/verification-snapshot' 要求 'Authorization: Bearer <ADMIN_TOKEN>'，并返回一个可序列化的快照 '{asOf:timestamp,resources:{...},work:[Work],events:[DomainEvent]}'。

### V1 验证快照

完整快照从单个 PostgreSQL 时间点读取；'asOf'、每个资源数组、'work' 和 'events' 必须描述同一数据库快照。V1 'resources' 对象仅包含以下键，且无其他键：

- 'subjects' 使用精确形状 'Subject'，并按标量字段路径元组 'subjectId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜排序依据。
- 'schemaDrafts' 使用精确形状 'SchemaDraft'，并按标量字段路径元组 'draftId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜排序依据。
- 'schemaVersions' 使用精确形状 'SchemaVersion'，并按标量字段路径元组 'subjectId'、'version' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜排序依据。

每个资源数组恰好包含其声明形状所命名的每个当前或不可变实例一次。每个列出的排序路径均解析为标量。标量顺序为：null 优先，然后 false 在 true 之前，整数按数值排序，其他所有字符串形式标量按 UTF-8 字节排序。按完整元组升序排序，然后仅以 RFC 8785 规范 JSON 作为决胜排序依据。
递归省略每个名称以 'Token' 结尾的对象字段，适用于所有嵌套深度。

'Work' 恰好为
'{workId:uuid,kind:SCHEMA_VALIDATION,aggregateId:uuid,state:PENDING|LEASED|SUCCEEDED|FAILED|CANCELLED,terminal:boolean,attempt:int,leaseOwner:string|null,leaseExpiresAt:timestamp|null}'。
'kind' 恰好是 'SCHEMA_VALIDATION' 之一。两个租约字段仅在状态为 'LEASED' 时非空，在其他所有状态下均为 null。'terminal' 仅在状态为 'SUCCEEDED'、'FAILED' 或 'CANCELLED' 时为 true；终止的 Work 被保留。
当没有匹配的 Work 具有 'terminal:false' 时，积压队列即被排空。'work' 数组按 workId 排序。

'events' 包含确切的领域事件对象，按 aggregateId、sequence、eventId 排序。对每个事件负载应用相同的递归 '*Token' 省略规则。省略认证和业务隔离令牌、幂等键、原始 webhook 主体、私有文件系统路径及机密信息。这是外部不变量查询面。

以下领域错误对于格式良好的请求是穷尽的，除上述已发布的常见错误外，还包括 400 'INVALID_REQUEST'、400 'INVALID_CURSOR'、404 'NOT_FOUND' 和 409 'IDEMPOTENCY_CONFLICT'：

| HTTP | 代码 | 精确触发条件 |
| ---: | --- | --- |
| 409 | SUBJECT_NAME_EXISTS | 另一个 Subject 已使用完全相同的名称 |
| 409 | SCHEMA_HEAD_CHANGED | Subject head 与 expectedHeadVersion 或验证快照不一致 |
| 409 | SCHEMA_INCOMPATIBLE | RecordSchema 违反捕获的兼容性模式 |
| 409 | SCHEMA_CONTENT_EXISTS | 相同的 canonicalDigest 已为该 Subject 发布 |
| 409 | DEPENDENCY_CYCLE | 固定依赖将形成依赖循环 |
| 409 | SUBJECT_MODE_REVISION_CHANGED | expectedRevision 不是 Subject 当前的 modeRevision |
| 409 | SCHEMA_DRAFT_NOT_PUBLISHABLE | SchemaDraft 状态不是 VALID |
| 409 | SCHEMA_VALIDATION_STALE | 验证的 Subject head、modeRevision 或依赖 head 在发布前已变更 |
| 400 | INVALID_RECORD_SCHEMA | schema 超出精确受限方言范围 |

### 持久幂等性

每个变更操作要求 'Idempotency-Key'，为 1-128 个可见 ASCII 字符。作用域为方法、规范路径和键。在确认成功之前，持久化规范语义请求指纹及完整状态/响应体。相同的重试（包括重启或未知响应丢失后）返回原始状态和语义 JSON，且不产生二次影响。使用相同键但不同语义的请求返回 409 'IDEMPOTENCY_CONFLICT'。并发相同请求收敛于一个结果；进程本地映射不具权威性。在基准测试期间不得过期记录，也不得在迁移期间重写已保存的重放响应体。

## 种子契约

'npm run db:seed -- --file <path>' 仅接受：

'{schemaVersion:1,seedVersion,subjects,publishedVersions}; schemas are valid canonicalizable JSON objects, Subject versions are contiguous, and every Dependency exists without cycles.'

成员模式是精确的：

- subjects[] = {subjectId:uuid,name:string,compatibilityMode:BACKWARD|FORWARD|FULL,modeRevision:int}；名称唯一
- publishedVersions[] 使用精确的 SchemaVersion 模式，从版本 1 开始，连续，且具有已验证的 canonicalDigest；每个 Subject 的 modeRevision 值为正、非递减、不大于 Subject 当前的 modeRevision，并编码每次发布所使用的历史兼容性模式
- 所有种子依赖固定必须存在、保持无环，且每个相邻 Subject 版本对必须满足较新版本编码的兼容性模式

'seedVersion' 为非空字符串，最多 64 个字符。导入器记录规范文件摘要。相同版本和摘要是无操作重放；相同版本但内容不同则失败并返回 'SEED_VERSION_CONFLICT'。拒绝未知键、重复 ID、缺失引用、无效状态、破坏的不变量、超出范围的整数及格式错误的时间。任何无效成员将拒绝整个导入，且不改变业务行、任务、幂等性或领域事件。

## 工作进程、事件与恢复

工作进程使用 'WORK_LEASE_SECONDS' 声明有界持久租约。租约所有权必须在提交结果的短事务内再次证明。在等待 HTTP、文件、时钟或其他进程时，不得持有数据库事务。过期租约可被重新声明，但过期令牌无法提交。

业务状态及其领域事件在单个事务中提交。事件字段为 'eventId'、'aggregateId'、正整数 'sequence'、'type'、'occurredAt'、'schemaVersion:1' 和 'payload'。必需的事件类型：`schema.validation-started`、`schema.rejected`、`schema.published`、`subject.mode-changed`。'payload' 对于每个 V1 事件恰好为 '{}'；后续 Manager 事件也使用 '{}'，除非其发布的契约明确提供其他负载形状。回滚不产生事件。每个聚合的序列是连续的。

调度器发送带有 'X-SchemaHarbor-Event-Id' 和 'X-SchemaHarbor-Event-Type' 的 JSON。网络错误、超时和非 2xx 响应以有界退避无限重试。每次重试保持相同的 eventId 和语义主体。成功投递顺序为聚合序列递增。至少一次投递可能重复请求；不得发明另一个事件身份。

### 受控恢复屏障

当 'TEST_BARRIER_URL' 为空时，不存在屏障请求。当两个测试变量均设置时，工作进程在继续之前于 'worker.claimed'、'worker.effect-complete' 和 'worker.before-commit' 处 POST；调度器在 'dispatcher.response-received' 处 POST。精确 JSON 为 '{schemaVersion:1,processRole:worker|dispatcher,point,workId,aggregateId,attempt,leaseTokenHash}'，头部为 'X-Test-Barrier-Token: <TEST_BARRIER_TOKEN>'。ID 和点在重试间保持一致；leaseTokenHash 是令牌的 SHA-256，而非令牌本身。204 响应释放进程。保持的响应暂停进程，且不打开数据库事务。连接丢失或非 204 响应每 100 毫秒以相同主体重试，直至租约丢失或进程终止。仅接受 localhost URL。

## 真实 UI

提供桌面和移动端流程，用于创建 V1 聚合、查看集合和详情、执行每个公开用户操作、观察异步验证任务进度、浏览事件和历史证据，以及刷新后恢复。展示加载、空、验证、冲突、过期、离线/重试、终止和权限错误状态。使用可见的语义控件、键盘导航、关联标签、焦点管理和 WCAG AA 对比度。完成主要流程时，不得要求使用开发者工具或直接 API 调用。

## 项目自有验证

- 单元测试覆盖确定性策略、状态转换、规范化及边界值。
- 集成测试启动真实的 PostgreSQL 和真实的 HTTP 进程；它们从不调用内部服务。
- 浏览器端到端测试使用生产构建、真实 Chromium、真实 API/数据库/工作进程以及可见控件。
- 并发测试使用至少两个 API 进程和两个工作进程，针对一个 PostgreSQL 数据库。
- 恢复测试使用仅限测试的公共屏障来观察声明/提交或接收方/确认边界，然后执行 SIGKILL；随机睡眠不是故障控制。
- 性能测试针对以下固定间隔运行生产构建，报告 p50/p95/p99、吞吐量、成功变更、预期冲突、意外 5xx、积压排空以及负载后不变量。

固定的 V1 兼容性能场景：

### 场景 'latest-schema-read'

- 目标：以 p95 <= 80 毫秒提供 500 次/秒的最新模式读取
- 模式：'http'
- 方法：'GET'
- 路径：'/api/v1/subjects/:subjectId/versions/latest'
- 设置：使用所有已播种的主题，并带有已发布的头部；读取不会改变 headVersion。
- 选择器：按字节顺序轮询 subjectId 值。
- 请求：无请求体或查询参数。
- 并发数：64
- 预热秒数：10
- 测量秒数：60
- 成功：仅计算 200 个精确的 LatestSchemaResponse 响应体，其主题和可空版本来自同一时间点的头部计数。
- 阈值：在 60 秒内至少 500 次成功读取/秒，且 p95 <= 80 毫秒；意外 5xx = 0。
- 计时器：吞吐量窗口从预热后的第一个测量请求开始；每个延迟样本从请求分发到完整响应体结束。

### 场景 'schema-validation'

- 目标：以 p95 队列延迟 <= 2 秒验证 50 个模式/秒
- 模式：'http'
- 方法：'POST'
- 路径：'/api/v1/subjects/:subjectId/schema-drafts'
- 设置：针对已发布的主题头部准备独立的预热和测量草稿请求；每个模式恰好有 20 个字段和恰好两个已发布的依赖固定点。
- 选择器：按字节顺序轮询 subjectId，使用其当前 headVersion，并根据请求序号生成唯一的模式名称和字段名称。
- 请求：{schema:{name,fields:{20 个确定性字段}},dependencies:[两个固定点],expectedHeadVersion}；使用新的 Idempotency-Key。
- 并发数：64
- 预热秒数：10
- 测量秒数：60
- 成功：仅计算 202 个 VALIDATING 创建，其 SCHEMA_VALIDATION 工作达到 VALID 计数；REJECTED 或 STALE 草稿不计入。
- 阈值：在 60 秒内至少 50 个 VALID 草稿/秒，且终端验证队列延迟 p95 <= 2,000 毫秒；意外 5xx = 0。
- 计时器：吞吐量窗口从第一次测量的 POST 开始；每个队列延迟样本从该草稿的创建提交开始，到其 VALID 终端提交结束。

### 场景 'gapless-publish'

- 目标：在 60 秒运行期间无间隙发布 2,000 个非冲突版本
- 模式：'http'
- 方法：'POST'
- 路径：'/api/v1/schema-drafts/:draftId/publish'
- 设置：在计时前，为每个不同的主题创建并验证恰好 2,000 个测量草稿，外加一个不相交的预热集。
- 选择器：按字节顺序的 subjectId 顺序轮询发布草稿 ID；没有两个测量草稿共享一个主题。
- 请求：请求体 {}，每个草稿使用一个新的 Idempotency-Key。
- 并发数：64
- 预热秒数：10
- 测量秒数：60
- 成功：每个测量请求恰好发布一个下一个 SchemaVersion；所有 2,000 个响应均成功，且没有主题存在版本间隙。
- 阈值：在 60 秒窗口内恰好完成 2,000 次非冲突发布；意外冲突和 5xx 计数为零。
- 计时器：吞吐量窗口从预热后的第一个测量请求开始；每个延迟样本从请求分发到完整响应体结束。

固定性能种子：seedVersion perf-v1 恰好包含 2,000 个主题和 20,000 个已发布版本，每个主题十个连续版本；验证和发布运行通过公共 API 创建所有测量草稿。

这三个场景是从新迁移的数据库和上述精确种子独立运行的；每个场景's Setup before its Timer begins. Mode 'http' means 'method' and 'path' 命名唯一的测量公共请求操作，'concurrency' 是精确的闭环客户端数量。模式 'worker' 表示方法 'N/A'，'path' 命名测量的工作种类，'concurrency' 是精确的工作进程数量。精确使用每个场景的选择器和请求；没有推断的混合工作负载。精确运行 'warmupSeconds' 未测量的秒数，然后精确运行 'measureSeconds' 测量的秒数，或直到计时器声明的终端条件。有状态预热和测量身份必须不相交。延迟计数完整的 HTTP 响应体。预期发布的冲突单独报告，除非场景的成功和阈值明确计数它们。

基准容器有 4 个逻辑 CPU 和 8 GiB RAM；PostgreSQL 16、Chromium、两个 API 进程、指定的工作进程和一个调度器共享该限制。每个后续兼容二进制文件必须在不更改任何字段或阈值的情况下重新运行这三个相同场景。

意外 5xx 计数必须为零。在满足延迟或吞吐量但任何强制不变量为假的情况下，性能运行视为失败。

## 范围外

- 代码生成
- 消息代理
- 任意可执行验证器
- 模式数据存储
- 跨集群复制

## 交接

保持 README 和 OpenAPI 最新。以发现优先的审查结束，并报告架构、模块和进程所有权、公共接口、成功/失败数据流、事务和租约边界、迁移、兼容性、运行的确切命令、测试和性能结果、恢复证据、已知风险以及每个未运行的检查。不要声称实际未执行的检查。
