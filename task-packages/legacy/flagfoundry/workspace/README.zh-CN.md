# FlagFoundry

从这一故意留空的仓库构建 FlagFoundry。本 README 是完整的产品合同。不要发明合同之外的行为。在做出合同未明确规定的产品决策之前，请先询问。

## 必需技术栈

- Node.js 22、TypeScript、React、PostgreSQL 16、npm 以及预装的 Chromium。
- PostgreSQL 是业务状态、幂等性、租约、事件和排序的唯一权威。
- 生产环境 UI 必须使用公共 HTTP API；不得使用模拟、内存数据库或仅浏览器端状态来提供正确性。
- 使用整数领域数量和 UTC ISO-8601 时间戳。不得对金额、容量、序列、持续时间单位或守恒量使用浮点数。

## 必需的非交互式命令

| 命令 | 合同 |
| --- | --- |
| 'npm run db:migrate' | 反复且安全地应用所有版本化迁移。 |
| 'npm run db:seed -- --file <path>' | 原子性地导入版本化 JSON 种子数据。 |
| 'npm run dev' | 启动开发环境 API 和 UI。 |
| 'npm run build' | 生成生产环境 API、worker、dispatcher 和 UI 资产。 |
| 'npm run start:api' | 启动一个生产环境 API/UI 进程。 |
| 'npm run start:worker' | 启动一个编译任务 worker。 |
| 'npm run start:dispatcher' | 启动领域事件 webhook dispatcher。 |
| 'npm run test:unit' | 运行纯逻辑和边界测试。 |
| 'npm run test:integration' | 运行真实 PostgreSQL 加公共 HTTP 集成测试。 |
| 'npm run test:e2e' | 通过可见控件运行生产构建的 Chromium 测试。 |
| 'npm run test:concurrency' | 针对一个数据库运行至少两个 API 和两个 worker 进程。 |
| 'npm run test:recovery' | 使用可观察屏障、SIGKILL、重启和持久恢复。 |
| 'npm run test:all' | 从干净数据库运行上述所有非性能门禁。 |
| 'npm run test:perf' | 运行固定持续负载并验证所有负载后不变量。 |

每个命令在失败时以非零状态退出，清理自己的子进程，并且不需要任何提示。

## 环境变量

| 变量 | 默认值 | 规则 |
| --- | --- | --- |
| 'DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/flagfoundry' | 生产/开发环境权威。 |
| 'TEST_DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/flagfoundry_test' | 所有有状态测试必需。 |
| 'PORT' | '3000' | 整数 1-65535；API 和生产环境 UI 来源。 |
| 'ADMIN_TOKEN' | 任务本地值 | 仅文档化的管理员变更路由需要；切勿记录。 |
| 'WEBHOOK_URL' | 'http://127.0.0.1:4010/events' | 领域事件投递的 HTTP 端点。 |
| 'WORK_LEASE_SECONDS' | '3' | 整数 1-60；worker 和恢复测试使用的持久租约时长。 |
| 'CHROMIUM_PATH' | '/usr/bin/chromium' | 项目自有 E2E 使用的浏览器可执行文件。 |
| 'MANAGED_DATA_ROOT' | '/tmp/flagfoundry-data' | 暂存或生成字节的可写根目录；切勿直接提供路径。 |
| 'TEST_BARRIER_URL' | 空 | 仅受控恢复测试使用的可选本地主机 HTTP 接收器。 |
| 'TEST_BARRIER_TOKEN' | 空 | 设置 URL 时必需的屏障头值；切勿记录。 |

仅绑定到 '127.0.0.1'。日志不得包含令牌、幂等键、原始种子输入、webhook 主体或私有绝对路径。

## 领域和 V1 行为

| 术语 | 规范定义 | 避免 |
| --- | --- | --- |
| Flag | 由单个 Project 拥有的稳定类型化决策键。 | 开关、设置 |
| Flag 修订版 | 为一个 Environment 捕获的不可变规则、变体和分配。 | 配置、版本 |
| 评估上下文 | 确定性规则评估接受的已发布属性。 | 用户、请求 |
| 编译任务 | 将 Draft 验证并编译为内容寻址 Snapshot 的持久租约工作。 | 作业、构建 |
| Snapshot | 由摘要标识的不可变评估工件。 | 缓存、JSON 文件 |
| 激活 | 活动 Snapshot 指针的原子变更。 | 部署、保存 |

Flag 修订版：COMPILING -> READY -> ACTIVE -> SUPERSEDED，或 COMPILING -> REJECTED；激活 READY 会取代该 Flag 和 Environment 先前处于 ACTIVE 状态的修订版。

1. 创建带有序目标规则和整数基点分配的输入化 Flags 和 Draft 修订版。
2. 将 Drafts 异步编译为确定性 Snapshots，并拒绝无效或过期的修订版。
3. 使用预期活动比较并设置语义跨 API 实例激活一个修订版。
4. 确定性评估捕获的 Snapshot，并公开解释轨迹，无需进程本地权威。
5. 至少一次投递激活事件，并在 UI 中展示修订版、差异、评估和审计历史。

### 确定性策略

1. 属性和键区分大小写，为 ASCII 1..64。规则按列表顺序评估；单条规则中的子句进行 AND 运算；EQUALS 比较一个精确字符串，IN 检查排序唯一 1..20 字符串列表中的成员资格。
2. 第一个匹配的规则选择其变体。如果没有匹配，百分比分配使用 SHA-256(snapshotDigest + NUL + flagKey + NUL + subjectKey)，将前八个字节解释为无符号大端整数，并对列出的累积顺序中的变体取模 10000。
3. 每个百分比分配为 0..10000，列表总和恰好为 10000；defaultVariant 和每个规则变体必须存在且匹配 flagType。contextAttributes 排序唯一。snapshotDigest 是精确 FlagSnapshot 对象的 RFC 8785 字节的 SHA-256，保留变体和规则列表顺序。
4. FlagRevisionDiff 比较同一 Flag 和 Environment 的修订版。添加、移除和更改的键/ID 数组按 UTF-8 字节顺序排序；当值或 allocationBasisPoints 不同时，变体被视为已更改；当同一 ruleId 的 RFC 8785 {clauses,variantKey} 不同时，规则被视为已更改。每个 orderChanged 标志在移除双方不存在的成员后比较完整的相应键/ID 序列。
5. 激活使用 expectedActiveRevision 和编译任务捕获的 Environment 上下文模式修订版；过期编译不能更改唯一的活动指针。

## 强制不变量

1. 在任一时刻，一个 Flag 和 Environment 恰好有一个 Flag 修订版处于 ACTIVE 状态。
2. 相同的 Snapshot 摘要和评估上下文始终产生相同的变体和原因。
3. 每个百分比规则的变体分配基点总和恰好为 10,000。
4. 仅当活动修订版和规则模式与编译任务捕获的完全一致时，激活才成功。
5. 非活动、已拒绝或过期的修订版不能通过评估变得可观察。

这些不变量必须在成功、验证失败、未知 HTTP 结果、重复请求、并发请求、worker 或 dispatcher SIGKILL、重启、迁移和持续负载之后仍然成立。

## HTTP 和 OpenAPI 3.1

在 'GET /openapi.json' 提供规范 OpenAPI，在 'GET /healthz' 提供健康检查。OpenAPI 文档和运行时行为必须一致。API 路由使用 JSON，除非明确文档化的原始内容。拒绝不支持的媒体类型返回 415 'UNSUPPORTED_MEDIA_TYPE'，格式错误的 JSON 返回 400 'MALFORMED_JSON'，未知对象键返回 400 'UNKNOWN_FIELD'，没有更具体已发布代码的形状或范围违规返回 400 'INVALID_REQUEST'。语义或状态冲突使用其已发布的 409 代码。在文档化的 ADMIN_TOKEN 路由上，缺失、格式错误或不正确的 Bearer 令牌返回 401 'ADMIN_AUTH_REQUIRED'。

成功的分页集合读取返回 '{items,nextCursor}'。'limit' 默认为 50，为 1 到 100 的整数。游标顺序稳定且不透明；格式错误的游标返回 400 'INVALID_CURSOR'。类型为 'uuid' 的字段是小写 UUID 字符串；未类型化的字符串标识符保留其已发布的语法。时间戳为 UTC，带尾随 'Z'。资源缺失返回 404 'NOT_FOUND'。

错误精确使用：

~~~json
{"error":{"code":"STABLE_CODE","message":"human-readable text","details":{}}}
~~~

以下线符号是规范性的：'uuid' 是小写 RFC 4122 文本，'int' 是 JSON 安全整数，'timestamp' 是带毫秒精度和尾随 Z 的 UTC ISO-8601，'date' 是严格的 YYYY-MM-DD，'sha256' 是 64 位小写十六进制，'currency' 是三个大写 ASCII 字母，'json' 是 RFC 8785 接受的任何值。'http-url' 是不带凭据或片段的绝对 http 或 https URL。'interval' 恰好是 '{startAt:timestamp,endAt:timestamp}'，startAt 在 endAt 之前，表示半开区间 '[startAt,endAt)'。'|null' 字段是必需且可空的。每个未列出的字段都被拒绝，数组保留其声明的顺序。响应精确使用这些资源形状：

- Flag = {flagId:uuid, projectId:uuid, key:string, flagType:STRING|BOOLEAN, createdAt:timestamp}
- FlagRule = {ruleId:uuid, clauses:[{attribute:string, operator:EQUALS|IN, value:string|[string]}], variantKey:string}; 子句之间为 AND 关系，规则按列表顺序执行
- FlagRevision = {revisionId:uuid, flagId:uuid, environment:string, revision:int, flagType:STRING|BOOLEAN, defaultVariant:string, variants:[{key:string, value:string|boolean, allocationBasisPoints:int}], rules:[FlagRule], state:COMPILING|READY|ACTIVE|REJECTED|SUPERSEDED, snapshotDigest:sha256|null, createdAt:timestamp, activatedAt:timestamp|null, sequence:int}
- FlagSnapshot = {snapshotVersion:1, projectId:uuid, flagId:uuid, flagKey:string, environment:string, revisionId:uuid, revision:int, flagType:STRING|BOOLEAN, defaultVariant:string, variants:[{key:string, value:string|boolean, allocationBasisPoints:int}], rules:[FlagRule], contextAttributes:[string], contextSchemaRevision:int}
- Evaluation = {projectId:uuid, flagId:uuid, flagKey:string, environment:string, subjectKey:string, variantKey:string, value:string|boolean, revisionId:uuid, snapshotDigest:sha256, reason:DEFAULT|RULE|PERCENTAGE, matchedRuleId:uuid|null}
- FlagRevisionDiff = {flagId:uuid, environment:string, fromRevision:int, toRevision:int, defaultVariantChanged:boolean, addedVariantKeys:[string], removedVariantKeys:[string], changedVariantKeys:[string], variantOrderChanged:boolean, addedRuleIds:[uuid], removedRuleIds:[uuid], changedRuleIds:[uuid], ruleOrderChanged:boolean}
- CompilationFinding = {code:string, path:string, message:string}; 发现项先按路径排序，再按代码排序

公共聚合路由为：

- 'GET /api/v1/flag-revisions?limit&cursor' 和
  'GET /api/v1/flag-revisions/:revisionId'。
- POST /api/v1/flags/:flagId/revisions，请求体为 {environment, flagType, defaultVariant, variants, rules, expectedActiveRevision}；当已知时返回 202 COMPILING 及 snapshotDigest。
- POST /api/v1/flags，请求体为 {projectId, key, flagType}，返回 201 Flag 或 409 FLAG_KEY_EXISTS。
- POST /api/v1/flag-revisions/:revisionId/activate，请求体为 {expectedActiveRevision}，原子性地更改活动指针，否则返回 409 ACTIVE_REVISION_CHANGED。
- POST /api/v1/evaluations，请求体为 {projectId, flagKey, environment, context, snapshotDigest?}，在其 Project 内唯一解析 Flag，并返回精确的 Evaluation。
- GET /api/v1/flags/:flagId/revisions/:revision/diff?against 返回精确的 FlagRevisionDiff，其中 against 为 fromRevision，路径中的 revision 为 toRevision。
- GET /api/v1/flags/:flagId/revisions?environment&limit&cursor 按 revision 升序返回精确的 FlagRevision 对象。
- 'GET /api/v1/domain-events?aggregateId&afterSequence&limit' 按顺序返回已提交的事件。
- 'GET /api/v1/verification-snapshot' 要求 'Authorization: Bearer <ADMIN_TOKEN>'，并返回一个
  可序列化的快照 '{asOf:timestamp,resources:{...},work:[Work],events:[DomainEvent]}'。

### V1 验证快照

完整快照从单个 PostgreSQL 时间点读取；'asOf'、每个资源数组、'work'
以及 'events' 必须描述同一数据库快照。V1 'resources' 对象恰好包含以下键，
且无其他键：

- 'projects' 使用精确形状 'Project = {projectId:uuid,name:string}'，并按标量字段路径元组 'projectId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜排序。
- 'environments' 使用精确形状 'Environment = {projectId:uuid,name:string,contextAttributes:[string],schemaRevision:int}'，并按标量字段路径元组 'projectId'、'name' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜排序。
- 'flags' 使用精确形状 'Flag'，并按标量字段路径元组 'flagId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜排序。
- 'flagRevisions' 使用精确形状 'FlagRevision'，并按标量字段路径元组 'flagId'、'environment'、'revision' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜排序。
- 'flagSnapshots' 使用精确形状 'FlagSnapshot'，并按标量字段路径元组 'projectId'、'flagId'、'environment'、'revision' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜排序。

每个资源数组恰好包含其声明形状所命名的每个当前或不可变实例一次。每个列出的排序路径解析为标量。标量顺序为 null 优先，然后 false 在 true 之前，整数按数值排序，其他所有字符串形式标量按 UTF-8 字节排序。按完整元组升序排序，然后仅以 RFC 8785 规范 JSON 作为决胜排序。
递归省略名称以 'Token' 结尾的每个对象字段，在所有嵌套深度。

'Work' 恰好是
'{workId:uuid,kind:FLAG_COMPILATION,aggregateId:uuid,state:PENDING|LEASED|SUCCEEDED|FAILED|CANCELLED,terminal:boolean,attempt:int,leaseOwner:string|null,leaseExpiresAt:timestamp|null}'。
'kind' 恰好是 'FLAG_COMPILATION' 之一。两个租约字段仅在状态为 'LEASED' 时非 null，在其他所有状态下均为 null。'terminal' 仅在状态为
'SUCCEEDED'、'FAILED' 或 'CANCELLED' 时为 true；终止的 Work 被保留。
当没有匹配的 Work 具有 'terminal:false' 时，积压队列被完全排空。'work' 数组按
workId 排序。

'events' 包含精确的 Domain Event 对象，按 aggregateId、sequence、eventId 排序。对每个事件负载应用相同的递归 '*Token' 省略。省略认证和业务围栏令牌、幂等键、原始 webhook 主体、私有文件系统路径和机密。这是外部不变量查询面。

以下领域错误对于格式良好的请求是穷尽的，除上述已发布的常见错误外，还包括 400 'INVALID_REQUEST'、400 'INVALID_CURSOR'、404 'NOT_FOUND' 和 409
'IDEMPOTENCY_CONFLICT'：

| HTTP | 代码 | 精确触发条件 |
| ---: | --- | --- |
| 409 | FLAG_KEY_EXISTS | Project 中的另一个 Flag 已使用完全相同的键 |
| 409 | ACTIVE_REVISION_CHANGED | 活动修订与 expectedActiveRevision 不同 |
| 409 | REVISION_NOT_READY | 修订正在编译、已拒绝、活动或已取代 |
| 409 | SNAPSHOT_MISMATCH | 固定的评估摘要不是该 Flag 的活动摘要 |
| 400 | INVALID_FLAG_RULE | 规则 DSL、变体、类型或分配无效 |
| 400 | MISSING_SUBJECT_KEY | 评估没有非空的 subjectKey |

### 持久幂等性

每个变更操作都需要 'Idempotency-Key'，1-128 个可见 ASCII 字符。作用域为方法、规范
路径和键。在确认成功之前，持久化规范语义请求
指纹以及完整的状态/主体。相同的重试，包括
在重启或未知响应丢失后，返回原始状态和语义 JSON，且无第二次
效果。使用不同语义重用键返回 409 'IDEMPOTENCY_CONFLICT'。并发相同
请求收敛于一个结果；进程本地映射不是权威。在基准测试期间不要使记录过期，或在迁移期间重写保存的重放主体。

## 种子契约

'npm run db:seed -- --file <path>' 恰好接受：

'{schemaVersion:1,seedVersion,projects,environments,flags,activeRevisions}; keys are unique per Project, variants match the declared type, rules use only declared context attributes, and allocations are exact integers.'

成员模式是精确的：

- projects[] = {projectId:uuid, name:string}; environments[] = {projectId:uuid, name:string, contextAttributes:[string], schemaRevision:int}
- flags[] = {flagId:uuid, projectId:uuid, key:string, flagType:STRING|BOOLEAN}; 键在每个 Project 内唯一
- activeRevisions[] 使用精确的 FlagRevision 模式，状态为 ACTIVE；规范 Snapshot 摘要、分配总数、规则引用和修订序列必须验证

'seedVersion' 是一个非空字符串，最多 64 个字符。导入器记录规范文件摘要。
相同版本和摘要是无操作重放；相同版本但内容不同则失败，错误为
'SEED_VERSION_CONFLICT'。拒绝未知键、重复 ID、缺失引用、无效状态、破坏的
不变量、超出范围的整数和格式错误的时间。任何无效成员拒绝整个导入，
而不更改业务行、任务、幂等性或 Domain Events。

## 工作器、事件和恢复

工作器使用 'WORK_LEASE_SECONDS' 声明有界持久租约。租约所有权必须在提交结果的短事务内再次证明。在等待
HTTP、文件、时钟或其他进程时，不要持有数据库事务。过期租约可重新声明，但过期令牌不能提交。

业务状态及其 Domain Event 在一个事务中提交。事件字段为 'eventId'、'aggregateId'、
正整数 'sequence'、'type'、'occurredAt'、'schemaVersion:1' 和 'payload'。必需事件类型：
`flag.compilation-started`、`flag.revision-rejected`、`flag.revision-activated`、`flag.revision-superseded`。'payload' 对于每个 V1 事件恰好是 '{}'；后续 Manager 事件也使用 '{}'，除非
其已发布契约字面上提供另一个负载形状。回滚不产生事件。序列
在每个聚合内是连续的。

调度器发送带有 'X-FlagFoundry-Event-Id' 和 'X-FlagFoundry-Event-Type' 的 JSON。网络错误、
超时和非 2xx 响应以有界退避无限重试。每次重试保持相同的
eventId 和语义主体。成功交付顺序为聚合序列递增。至少一次
交付可能重复请求；不得发明另一个事件身份。

### 受控恢复屏障

当'TEST_BARRIER_URL'为空时，不存在屏障请求。当两个测试变量均已设置时，工作进程在继续执行'worker.claimed'、'worker.effect-complete'和'worker.before-commit'之前执行POST；调度器在'dispatcher.response-received'处执行POST。确切的JSON为'{schemaVersion:1,processRole:worker|dispatcher,point,workId,aggregateId,attempt,leaseTokenHash}'，标头为'X-Test-Barrier-Token: <TEST_BARRIER_TOKEN>'。ID和点在重试期间保持一致；leaseTokenHash是令牌的SHA-256哈希，而非令牌本身。204响应释放进程。保持响应会暂停进程，且不打开数据库事务。连接丢失或非204响应时，每100毫秒使用相同请求体重试，直至租约丢失或进程终止。仅接受localhost URL。

## 真实用户界面

提供用于创建V1聚合、查看集合和详情、执行每项公开用户操作、观察异步编译任务进度、浏览事件和历史证据以及刷新后恢复的桌面和移动端流程。展示加载、空、验证、冲突、过期、离线/重试、终止和权限错误状态。使用可见的语义控件、键盘导航、关联标签、焦点管理和WCAG AA对比度。绝不允许通过开发者工具或直接API调用来完成主要流程。

## 项目自有验证

- 单元测试覆盖确定性策略、状态转换、规范化和边界值。
- 集成测试启动真实的PostgreSQL和真实的HTTP进程；它们绝不调用内部服务。
- 浏览器端到端测试使用生产构建、真实Chromium、真实API/数据库/工作进程以及可见控件。
- 并发测试使用至少两个API进程和两个工作进程，针对一个PostgreSQL数据库。
- 恢复测试使用公开的仅测试屏障来观察声明/提交或接收方/确认边界，然后执行SIGKILL；随机睡眠不属于故障控制。
- 性能测试针对以下固定间隔运行生产构建，报告p50/p95/p99、吞吐量、成功变更、预期冲突、意外5xx、积压排空和加载后不变量。

固定的V1兼容性能场景：

### 场景'flag-evaluation'

- 目标：评估2,000次决策/秒，p95 <= 40毫秒
- 模式：'http'
- 方法：'POST'
- 路径：'/api/v1/evaluations'
- 设置：使用所有已测量的活动Flag/Environment对。上下文恰好包含subjectKey、region和tier，并满足所选Environment模式。
- 选择器：按projectId、flagId、environment字节顺序轮询对；subjectKey为perf-subject-{请求序号模100000}。
- 请求：{projectId,flagKey,environment,context:{subjectKey,region:"us",tier:"pro"}}，无snapshotDigest固定。
- 并发数：64
- 预热秒数：10
- 测量秒数：60
- 成功条件：仅计算匹配活动不可变FlagSnapshot的200评估响应；重复输入必须返回相同的变体和原因。
- 阈值：60秒内至少2,000次成功决策/秒，且p95 <= 40毫秒；混合快照和意外5xx计数为零。
- 计时器：吞吐量窗口从预热后的第一个测量请求开始；每个延迟样本从请求分派到完整响应体结束。

### 场景'revision-compilation'

- 目标：编译100个修订/秒，p95队列延迟 <= 2秒
- 模式：'http'
- 方法：'POST'
- 路径：'/api/v1/flags/:flagId/revisions'
- 设置：在现有Flags上准备不相交的预热和测量请求序号；每个候选有两个变体和十条使用声明属性的单子句规则。
- 选择器：按flagId然后Environment字节顺序轮询；expectedActiveRevision在每次请求前立即读取一次。
- 请求：{environment,flagType,defaultVariant,variants:[两个总计10000],rules:[十条],expectedActiveRevision}，使用新键。
- 并发数：64
- 预热秒数：10
- 测量秒数：60
- 成功条件：仅计算达到READY状态的FLAG_COMPILATION Work的202创建；REJECTED或过期候选不计入。
- 阈值：60秒内至少100个READY修订/秒，且创建提交到READY提交的队列延迟p95 <= 2,000毫秒。
- 计时器：吞吐量窗口从第一次测量的POST开始；每个修订延迟从创建提交开始，到在单个快照中观察到的READY提交结束。

### 场景'disjoint-activation'

- 目标：在60秒内激活500个不相交的修订，且无混合快照读取
- 模式：'http'
- 方法：'POST'
- 路径：'/api/v1/flag-revisions/:revisionId/activate'
- 设置：在计时前，为500个不同的Flag/Environment对创建恰好500个READY测量候选，以及一个不相交的预热集。
- 选择器：按flagId、environment字节顺序激活候选；每对仅定向一次。
- 请求：{expectedActiveRevision}随候选捕获；使用新的Idempotency-Key。
- 并发数：64
- 预热秒数：10
- 测量秒数：60
- 成功条件：所有500个请求成功，每对恰好有一个新的活动指针，并发评估仅看到完整的先前或候选快照。
- 阈值：恰好500个不相交的激活在60秒内完成；冲突、混合快照、间隙和意外5xx为零。
- 计时器：吞吐量窗口从预热后的第一个测量请求开始；每个延迟样本从请求分派到完整响应体结束。

固定性能种子：seedVersion perf-v1包含恰好100个项目、300个环境、5,000个标志和5,000个activeRevisions，每个测量的Flag和Environment对有一个活动修订；编译运行通过公共API创建候选。

三个场景是从新迁移的数据库和上述精确种子独立运行；完成每个场景's Setup before its Timer begins. Mode 'http' means '方法' and '路径'命名仅有的测量公共请求操作，'concurrency'是精确的闭环客户端数量。模式'worker'表示方法'N/A'，'path'命名测量的Work种类，'concurrency'是精确的工作进程数量。精确使用每个场景的选择器和请求；不存在推断的混合工作负载。运行恰好'warmupSeconds'秒未测量，然后恰好'measureSeconds'秒测量，或直到计时器声明的终止条件。有状态预热和测量身份必须不相交。延迟计数完整的HTTP响应体。预期发布的冲突单独报告，除非场景的成功条件和阈值明确计数它们。

基准容器有4个逻辑CPU和8 GiB RAM；PostgreSQL 16、Chromium、两个API进程、指定的工作进程和一个调度器共享该限制。每个后续兼容二进制必须重新运行这三个相同场景，而不更改任何字段或阈值。

意外5xx计数必须为零。在任一强制不变量为假时满足延迟或吞吐量，则性能运行失败。

## 范围外

- SDK分发
- 分析实验
- 用户身份存储
- 远程配置轮询
- 多区域复制

## 交接

保持README和OpenAPI最新。以发现优先的审查结束，并报告架构、模块和进程所有权、公共接口、成功/失败数据流、事务和租约边界、迁移、兼容性、运行的确切命令、测试和性能结果、恢复证据、已知风险以及未运行的每项检查。不要声称实际未执行的检查。
