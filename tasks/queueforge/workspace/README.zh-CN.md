# QueueForge

从本意上为空白仓库构建 QueueForge。本 README 是完整的产品合同。不要发明合同之外的行为。在做出合同未明确规定的产品决策之前，请先询问。

## 必需技术栈

- Node.js 22、TypeScript、React、PostgreSQL 16、npm 以及预装的 Chromium。
- PostgreSQL 是业务状态、幂等性、租约、事件和排序的唯一权威。
- 生产环境 UI 必须使用公共 HTTP API；不得使用模拟、内存数据库或仅浏览器端状态来提供正确性。
- 使用整数域数量和 UTC ISO-8601 时间戳。不得对金额、容量、序列、持续时间单位或守恒量使用浮点数。

## 必需的非交互式命令

| 命令 | 合同 |
| --- | --- |
| 'npm run db:migrate' | 重复且安全地应用所有版本化迁移。 |
| 'npm run db:seed -- --file <path>' | 原子化导入版本化 JSON 种子数据。 |
| 'npm run dev' | 启动开发环境 API 和 UI。 |
| 'npm run build' | 生成生产环境 API、worker、dispatcher 和 UI 资源。 |
| 'npm run start:api' | 启动一个生产环境 API/UI 进程。 |
| 'npm run start:worker' | 启动一个执行租约 worker。 |
| 'npm run start:dispatcher' | 启动域事件 webhook dispatcher。 |
| 'npm run test:unit' | 运行纯逻辑和边界测试。 |
| 'npm run test:integration' | 运行真实 PostgreSQL 加公共 HTTP 集成测试。 |
| 'npm run test:e2e' | 通过可见控件运行生产构建的 Chromium 测试。 |
| 'npm run test:concurrency' | 针对一个数据库运行至少两个 API 和两个 worker 进程。 |
| 'npm run test:recovery' | 使用可观察屏障、SIGKILL、重启和持久恢复。 |
| 'npm run test:all' | 从干净数据库运行上述所有非性能门禁。 |
| 'npm run test:perf' | 运行固定持续负载并验证所有负载后不变量。 |

每个命令在失败时以非零状态退出，清理自己的子进程，并且不需要提示。

## 环境

| 变量 | 默认值 | 规则 |
| --- | --- | --- |
| 'DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/queueforge' | 生产/开发环境权威。 |
| 'TEST_DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/queueforge_test' | 所有有状态测试必需。 |
| 'PORT' | '3000' | 整数 1-65535；API 和生产环境 UI 来源。 |
| 'ADMIN_TOKEN' | 任务本地值 | 仅文档化的管理变更路由需要；切勿记录。 |
| 'WEBHOOK_URL' | 'http://127.0.0.1:4010/events' | 域事件投递的 HTTP 端点。 |
| 'WORK_LEASE_SECONDS' | '3' | 整数 1-60；worker 和恢复测试使用的持久化租约时长。 |
| 'CHROMIUM_PATH' | '/usr/bin/chromium' | 项目自有 E2E 的浏览器可执行文件。 |
| 'MANAGED_DATA_ROOT' | '/tmp/queueforge-data' | 暂存或生成字节的可写根目录；切勿直接提供路径。 |
| 'TEST_BARRIER_URL' | 空 | 仅受控恢复测试使用的可选 localhost HTTP 接收器。 |
| 'TEST_BARRIER_TOKEN' | 空 | 设置 URL 时必需的屏障头值；切勿记录。 |

仅绑定到 '127.0.0.1'。日志不得包含令牌、幂等键、原始种子输入、webhook 主体或私有绝对路径。

## 领域和 V1 行为

| 术语 | 规范定义 | 避免 |
| --- | --- | --- |
| 作业定义 | 不可变的版本化命令描述符和重试策略。 | 任务、脚本 |
| 运行 | 对作业定义版本的一次请求执行。 | 作业、进程 |
| 执行租约 | 一个 worker 尝试的限时所有权记录。 | 锁、声明 |
| 尝试 | 一次运行的一个不可变执行间隔和结果。 | 重试、进程 |
| 队列 | 租户作用域内具有并发容量的有序集合。 | 数组、主题 |
| 运行事件 | 一次运行的一个有序持久事实。 | 日志行、webhook |

运行：QUEUED -> RUNNING -> SUCCEEDED | FAILED | CANCELLED；过期的 RUNNING 租约在尝试耗尽前返回 QUEUED。

1. 创建版本化作业定义，并以优先级和 notBefore 入队运行。
2. 允许多个 worker 公平租用运行，同时尊重每个队列的并发容量。
3. 使用确定性退避重试已发布的失败类别，并在 SIGKILL 后恢复过期租约。
4. 取消排队或运行中的运行，与完成相比只有一个赢家，且没有重复的终止事件。
5. 暴露队列深度、尝试次数、实时状态、历史记录和至少一次运行事件 webhook。

### 确定性策略

1. priority 为 -100..100，maxAttempts 为 1..10，timeoutSeconds 为 1..300，notBefore 最多可提前 30 天。声明顺序为 priority 降序、notBefore 升序、createdAt 升序、runId 升序。
2. ECHO 返回规范输入；SHA256 返回 RFC 8785 规范输入的 {sha256}；SUM_INTEGERS 接受 {values:[int]}，包含 1..10000 个成员，返回 {sum:int}，溢出时拒绝为 PERMANENT_FAILURE。
3. RETRYABLE_FAILURE 调度 notBefore = finishedAt + min(100 * 2^(attempt-1),5000) 毫秒，无抖动。PERMANENT_FAILURE 或耗尽 maxAttempts 使运行变为 FAILED。
4. 队列容量计算未过期的 RUNNING 租约。声明事务最多返回 maxRuns 1..20，且除非容量耗尽，否则不能跳过更早的合格运行。
5. 声明 QUEUED 运行原子化递增 attemptCount，创建该编号的一个尝试且 outcome 为 null，创建其 ExecutionLease，并将运行更改为 RUNNING。当租约过期时，恢复事务在恢复事务时间将该尝试完成为 TIMED_OUT，移除租约，并根据该 finishedAt 应用已发布的退避，或在 maxAttempts 耗尽时将运行更改为 FAILED。
6. 取消 QUEUED 运行不创建尝试。取消 RUNNING 运行原子化围栏并移除其租约，将当前尝试完成为 CANCELLED，并将运行更改为 CANCELLED；并发有效尝试结果和取消恰好有一个赢家。

## 强制不变量

1. 一个运行最多有一个活动执行租约和一个终止结果。
2. 队列中的活动租约不得超过其配置容量。
3. 每个尝试编号对其运行是唯一且严格递增的。
4. 重试使用创建运行时所捕获的不可变作业定义版本。
5. 优先级、notBefore、createdAt 和 ID 在合格运行中产生确定性声明顺序。

这些不变量必须在成功、验证失败、未知 HTTP 结果、重复请求、并发请求、worker 或 dispatcher SIGKILL、重启、迁移和持续负载后成立。

## HTTP 和 OpenAPI 3.1

在 'GET /openapi.json' 提供规范 OpenAPI，在 'GET /healthz' 提供健康检查。OpenAPI 文档和运行时行为必须一致。API 路由使用 JSON，除非明确文档化的原始内容。拒绝不支持的媒体类型，返回 415 'UNSUPPORTED_MEDIA_TYPE'；拒绝格式错误的 JSON，返回 400 'MALFORMED_JSON'；拒绝未知对象键，返回 400 'UNKNOWN_FIELD'；拒绝形状或范围违规且没有更具体的已发布代码，返回 400 'INVALID_REQUEST'。语义或状态冲突使用其已发布的 409 代码。在文档化的 ADMIN_TOKEN 路由上，缺失、格式错误或不正确的 Bearer 令牌返回 401 'ADMIN_AUTH_REQUIRED'。

成功的分页集合读取返回 '{items,nextCursor}'。'limit' 默认为 50，是 1 到 100 的整数。游标顺序稳定且不透明；格式错误的游标返回 400 'INVALID_CURSOR'。类型为 'uuid' 的字段是小写 UUID 字符串；未类型化的字符串标识符保留其已发布的语法。时间戳为 UTC，带尾随 'Z'。资源未命中返回 404 'NOT_FOUND'。

错误精确使用：

~~~json
{"error":{"code":"STABLE_CODE","message":"human-readable text","details":{}}}
~~~

以下线符号是规范性的：'uuid' 是小写 RFC 4122 文本，'int' 是 JSON 安全整数，'timestamp' 是带毫秒精度和尾随 Z 的 UTC ISO-8601，'date' 是严格 YYYY-MM-DD，'sha256' 是 64 位小写十六进制，'currency' 是三个大写 ASCII 字母，'json' 是 RFC 8785 接受的任何值。'http-url' 是不带凭据或片段的绝对 http 或 https URL。'interval' 恰好是 '{startAt:timestamp,endAt:timestamp}'，startAt 在 endAt 之前，表示半开区间 '[startAt,endAt)'。'|null' 字段是必需的且可空。每个未列出的字段都被拒绝，数组保留其声明的顺序。响应精确使用这些资源形状：

- JobDefinition = {jobDefinitionId:uuid,version:int,operation:ECHO|SHA256|SUM_INTEGERS,maxAttempts:int,timeoutSeconds:int,createdAt:timestamp}
- Run = {runId:uuid,jobDefinitionId:uuid,jobVersion:int,queueId:uuid,priority:int,notBefore:timestamp,input:json,state:QUEUED|RUNNING|SUCCEEDED|FAILED|CANCELLED,attemptCount:int,output:json|null,errorCode:string|null,createdAt:timestamp,startedAt:timestamp|null,terminalAt:timestamp|null,sequence:int}
- ExecutionLease = {runId:uuid,attempt:int,workerId:string,leaseToken:string,leasedAt:timestamp,expiresAt:timestamp}
- Attempt = {runId:uuid,attempt:int,workerId:string,startedAt:timestamp,finishedAt:timestamp|null,outcome:SUCCEEDED|RETRYABLE_FAILURE|PERMANENT_FAILURE|TIMED_OUT|CANCELLED|null,outputDigest:sha256|null}
- AttemptResult = {run:Run,attempt:Attempt}; 一个 SUCCEEDED 结果存储 Run.output 和 Attempt.outputDigest，后者等于其 RFC 8785 字节的 SHA-256；而每个非成功结果的 Run.output 为 null 且 Attempt.outputDigest 为 null
- WorkerClaimResponse = {items:[{run:Run,executionLease:ExecutionLease}]}; items 按已发布的声明顺序排列，每个 Run 处于 RUNNING 状态且 attemptCount 等于 executionLease.attempt，一个空的成功声明恰好是 {items:[]}

公共聚合路由为：

- 'GET /api/v1/runs?limit&cursor' 和
  'GET /api/v1/runs/:runId'。
- POST /api/v1/runs 使用 {jobDefinitionId,jobVersion,queueId,priority,notBefore,input}；返回 202 QUEUED 并具有持久幂等性。
- POST /api/v1/job-definitions 使用 {operation,maxAttempts,timeoutSeconds} 创建版本 1 并返回 201 JobDefinition；POST /api/v1/job-definitions/:jobDefinitionId/versions 使用 {expectedLatestVersion,operation,maxAttempts,timeoutSeconds} 原子地创建恰好下一个版本，或返回 409 JOB_DEFINITION_VERSION_CHANGED。
- POST /api/v1/runs/:runId/cancel 使用 {reason} 与工作程序完成安全竞争。
- POST /api/v1/workers/:workerId/claim 使用 {queueIds,maxRuns} 原子地返回确切的 WorkerClaimResponse；每个返回的 ExecutionLease 都包含尝试结果所需的令牌。
- POST /api/v1/runs/:runId/attempt-result 使用 {attempt,leaseToken,outcome,output,errorCode} 接受结果 SUCCEEDED|RETRYABLE_FAILURE|PERMANENT_FAILURE。SUCCEEDED 需要确切的操作输出且 errorCode 为 null；失败需要 output 为 null 且非空的稳定 errorCode。它验证输出，在服务端计算 outputDigest，拒绝过期的租约，并返回确切的 AttemptResult。
- GET /api/v1/queues/:queueId 返回 {queueId,name,capacity,activeLeaseCount,queuedCount}，GET /api/v1/runs/:runId/attempts 返回 {items:[Attempt]}。
- 'GET /api/v1/domain-events?aggregateId&afterSequence&limit' 按顺序返回已提交的事件。
- 'GET /api/v1/verification-snapshot' 需要 'Authorization: Bearer <ADMIN_TOKEN>' 并返回一个
  可序列化的快照 '{asOf:timestamp,resources:{...},work:[Work],events:[DomainEvent]}'。

### V1 验证快照

完整快照从单个 PostgreSQL 时间点读取；'asOf'、每个资源数组、'work'
和 'events' 必须描述同一个数据库快照。V1 'resources' 对象恰好具有以下键
且没有其他键：

- 'queues' 使用精确形状 'Queue = {queueId:uuid,name:string,capacity:int}'，并按标量字段路径元组 'queueId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜键。
- 'jobDefinitions' 使用精确形状 'JobDefinition'，并按标量字段路径元组 'jobDefinitionId'、'version' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜键。
- 'runs' 使用精确形状 'Run'，并按标量字段路径元组 'runId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜键。
- 'executionLeases' 使用精确形状 'ExecutionLease'，并按标量字段路径元组 'runId'、'attempt' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜键。
- 'attempts' 使用精确形状 'Attempt'，并按标量字段路径元组 'runId'、'attempt' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜键。

每个资源数组恰好包含其声明形状所命名的每个当前或不可变实例一次。每个列出的排序路径解析为标量。标量顺序为 null 优先，然后 false 在 true 之前，整数按数值排序，其他所有字符串形式标量按 UTF-8 字节排序。按完整元组升序排序，然后仅以 RFC 8785 规范 JSON 作为决胜键。
递归省略每个名称以 'Token' 结尾的对象字段，在每个嵌套深度。

'Work' 恰好是
'{workId:uuid,kind:RUN_EXECUTION,aggregateId:uuid,state:PENDING|LEASED|SUCCEEDED|FAILED|CANCELLED,terminal:boolean,attempt:int,leaseOwner:string|null,leaseExpiresAt:timestamp|null}'。
'kind' 恰好是 'RUN_EXECUTION' 之一。两个租约字段仅在状态为
'LEASED' 时非 null，在所有其他状态下均为 null。'terminal' 恰好当状态为
'SUCCEEDED'、'FAILED' 或 'CANCELLED' 时为 true；终止的 Work 被保留。
当没有匹配的 Work 具有 'terminal:false' 时，积压队列恰好被排空。'work' 数组按
workId 排序。

'events' 包含精确的领域事件对象，按 aggregateId、然后 sequence、然后 eventId 排序。对每个事件负载应用相同的递归 '*Token' 省略。省略身份验证和业务防护令牌、幂等键、原始 webhook 主体、私有文件系统路径和机密。这是外部不变量查询表面。

以下领域错误对于格式良好的请求是穷尽的，除了上述已发布的常见错误以及 400 'INVALID_REQUEST'、400 'INVALID_CURSOR'、404 'NOT_FOUND' 和 409
'IDEMPOTENCY_CONFLICT'：

| HTTP | 代码 | 精确触发条件 |
| ---: | --- | --- |
| 409 | JOB_DEFINITION_VERSION_CHANGED | expectedLatestVersion 不是当前的 Job Definition 版本 |
| 409 | QUEUE_CAPACITY_EXHAUSTED | 没有请求的 Queue 具有可用的执行容量 |
| 409 | STALE_EXECUTION_LEASE | 尝试结果令牌不是当前未过期的租约 |
| 409 | RUN_NOT_CANCELLABLE | Run 已终止 |
| 409 | ATTEMPT_RESULT_CONFLICT | 同一尝试已有不同的结果 |
| 400 | INVALID_JOB_INPUT | 输入与捕获的操作契约不匹配 |

### 持久幂等性

每个变更都需要 'Idempotency-Key'，1-128 个可见 ASCII 字符。范围是方法、规范
路径和键。在确认成功之前持久化规范语义请求指纹和完整状态/主体。相同的重试，包括
在重启或未知响应丢失后，返回原始状态和语义 JSON，且无第二次效果。使用相同键但不同语义返回 409 'IDEMPOTENCY_CONFLICT'。并发相同的
请求收敛于一个结果；进程本地映射不是权威。在基准测试期间不要过期记录，或在迁移期间重写保存的重放主体。

## 种子契约

'npm run db:seed -- --file <path>' 恰好接受：

'{schemaVersion:1,seedVersion,queues,jobDefinitions,runs,attempts,executionLeases}; capacities and retry limits are positive bounded integers, versions are unique, and run, Attempt, and ExecutionLease references are valid.'

成员模式是精确的：

- queues[] = {queueId:uuid,name:string,capacity:int}; capacity 为 1..100
- jobDefinitions[] 使用精确的 JobDefinition 模式，且每个 jobDefinitionId 的版本是连续的
- runs[] 使用精确的 Run 模式；attempts[] 使用精确的 Attempt 模式；executionLeases[] 使用精确的 ExecutionLease 模式。每个 RUNNING Run 恰好有一个匹配的当前租约，其他 Run 没有，且 attemptCount 等于其最大的 Attempt 编号，或当没有 Attempt 时为零

'seedVersion' 是一个非空字符串，最多 64 个字符。导入器记录规范文件摘要。
相同版本和摘要是无操作重放；相同版本但不同内容失败并返回
'SEED_VERSION_CONFLICT'。拒绝未知键、重复 ID、缺失引用、无效状态、破坏的
不变量、超出范围的整数和格式错误的时间。任何无效成员拒绝完整导入
而不更改业务行、任务、幂等性或领域事件。

## 工作程序、事件和恢复

工作程序使用 'WORK_LEASE_SECONDS' 声明有界持久租约。租约所有权必须在提交结果的
短事务内再次证明。在等待 HTTP、文件、时钟或另一个进程时不要持有数据库事务。过期租约可重新声明，但过期令牌无法提交。

业务状态及其领域事件在一个事务中提交。事件字段为 'eventId'、'aggregateId'、
正整数 'sequence'、'type'、'occurredAt'、'schemaVersion:1' 和 'payload'。必需的事件类型：
`run.queued`、`run.started`、`run.retry-scheduled`、`run.succeeded`、`run.failed`、`run.cancelled`。'payload' 对于每个 V1 事件恰好是 '{}'；后续 Manager 事件也使用 '{}'，除非
其已发布的契约字面提供另一个负载形状。回滚不创建事件。序列
每个聚合是连续的。

调度器发送 JSON，包含 'X-QueueForge-Event-Id' 和 'X-QueueForge-Event-Type'。网络错误、
超时和非 2xx 响应以有界退避无限重试。每次重试保持相同的
eventId 和语义主体。成功交付顺序是递增的聚合序列。至少一次
交付可能重复请求；它不得发明另一个事件身份。

### 受控恢复屏障

当'TEST_BARRIER_URL'为空时，不存在屏障请求。当两个测试变量均被设置时，工作进程在'worker.claimed'、'worker.effect-complete'和'worker.before-commit'处继续之前执行POST；调度器在'dispatcher.response-received'处执行POST。确切的JSON为'{schemaVersion:1,processRole:worker|dispatcher,point,workId,aggregateId,attempt,leaseTokenHash}'，头部为'X-Test-Barrier-Token: <TEST_BARRIER_TOKEN>'。ID和点在重试之间保持一致；leaseTokenHash是令牌的SHA-256哈希，而非令牌本身。204响应释放进程。保持响应暂停进程，且不打开数据库事务。连接丢失或非204响应时，每100毫秒使用相同请求体重试，直到租约丢失或进程终止。仅接受localhost URL。

## 真实用户界面

提供桌面和移动端流程，用于创建V1聚合、查看集合和详情、执行每个公开用户操作、观察异步执行租约进度、浏览事件和历史证据，以及在刷新后恢复。展示加载、空、验证、冲突、过期、离线/重试、终止和权限错误状态。使用可见的语义控件、键盘导航、关联标签、焦点管理和WCAG AA对比度。绝不允许使用开发者工具或直接API调用来完成主要流程。

## 项目自有验证

- 单元测试覆盖确定性策略、状态转换、规范化和边界值。
- 集成测试启动真实的PostgreSQL和真实的HTTP进程；它们绝不调用内部服务。
- 浏览器端到端测试使用生产构建、真实Chromium、真实API/数据库/工作进程以及可见控件。
- 并发测试使用至少两个API进程和两个工作进程，针对一个PostgreSQL数据库。
- 恢复测试使用公开的仅测试屏障，在SIGKILL之前观察声明/提交或接收方/ACK边界；随机睡眠不是故障控制。
- 性能测试对以下固定间隔运行生产构建，报告p50/p95/p99、吞吐量、成功变更、预期冲突、意外5xx、积压排空和加载后不变量。

固定的V1兼容性能场景：

### 场景 'run-enqueue'

- 目标：以p95 <= 250毫秒的速度入队300个运行/秒
- 模式：'http'
- 方法：'POST'
- 路径：'/api/v1/runs'
- 设置：选择一个已播种的ECHO作业定义和具有未使用测量容量的队列；预热和测量运行ID由服务器从不相交的幂等键生成。
- 选择器：按queueId轮询队列；使用优先级50和notBefore等于设置事务时间戳。
- 请求：{jobDefinitionId,jobVersion,queueId,priority:50,notBefore,input:{value:"64个ASCII字节，按请求序号固定"}}。
- 并发数：64
- 预热秒数：10
- 测量秒数：60
- 成功：仅202 QUEUED响应计数；每个运行精确捕获请求的作业定义版本。
- 阈值：至少300次成功入队/秒持续60秒，且p95 <= 250毫秒；意外5xx = 0。
- 计时器：吞吐量窗口从预热后的第一个测量请求开始；每个延迟样本从请求发送到完整响应体结束。

### 场景 'short-run-execution'

- 目标：在60秒内使用四个工作进程声明并完成5,000个短运行
- 模式：'http'
- 方法：'POST'
- 路径：'/api/v1/workers/:workerId/claim; /api/v1/runs/:runId/attempt-result'
- 设置：精确使用5,000个QUEUED ECHO运行，其输入JSON <= 128字节；其队列中没有其他符合条件的运行。
- 选择器：四个工作进程客户端从相同的字节序queueId列表中声明maxRuns:25，并立即返回确切的回显值，结果为SUCCEEDED。
- 请求：声明体为{queueIds,maxRuns:25}；结果体为{attempt,leaseToken,outcome:"SUCCEEDED",output:{value},errorCode:null}；服务计算并存储outputDigest。
- 并发数：4
- 预热秒数：0
- 测量秒数：60
- 成功：所有5,000个运行达到SUCCEEDED，且有一个成功的尝试，没有租约超过队列容量，且没有运行保持QUEUED或RUNNING状态。
- 阈值：完整集合在<= 60秒内完成；过期租约响应和意外5xx为零。
- 计时器：在四个客户端发出首次声明之前立即开始，并在验证快照证明所有5,000个终止结果时停止。

### 场景 'expired-lease-recovery'

- 目标：在45秒内恢复2,000个过期租约，且不超出容量
- 模式：'worker'
- 方法：'N/A'
- 路径：'work:RUN_EXECUTION'
- 设置：精确使用2,000个已播种的RUNNING运行，其唯一执行租约已过期。启动四个工作进程，使用已发布的队列容量限制。
- 选择器：按优先级降序、notBefore、createdAt、runId顺序回收，并执行每个捕获的操作一次。
- 请求：不发出测量客户端请求；设置仅使用已发布的种子和公共API，在工作进程计时器开始之前。
- 并发数：4
- 预热秒数：0
- 测量秒数：45
- 成功：所有2,000个运行通过一个新尝试变为终止状态，过期令牌无法提交，且活动租约不超过任何队列容量。
- 阈值：所有过期租约在<= 45秒内恢复；意外工作进程失败 = 0。
- 计时器：在所有四个恢复工作进程生成时开始，并在第一个验证快照证明没有选定的运行处于非终止状态时停止。

固定性能种子：seedVersion perf-v1精确包含100个队列、1,000个作业定义、27,000个运行、22,000个尝试和2,000个执行租约：20,000个SUCCEEDED运行、5,000个QUEUED运行和2,000个RUNNING运行，其唯一租约已过期。

三个场景是从新迁移的数据库和上述精确种子独立运行的；完成每个场景's Setup before its Timer begins. Mode 'http' means '方法' and '路径'命名唯一的测量公共请求操作，'concurrency'是精确的闭环客户端数量。模式'worker'表示方法'N/A'，'path'命名测量的工作种类，'concurrency'是精确的工作进程数量。精确使用每个场景的选择器和请求；没有推断的混合工作负载。精确运行'warmupSeconds'未测量秒数，然后精确运行'measureSeconds'测量秒数或直到计时器声明的终止条件。有状态预热和测量身份必须不相交。延迟计数完整的HTTP响应体。预期发布的冲突单独报告，除非场景的成功和阈值明确计数它们。

基准容器有4个逻辑CPU和8 GiB RAM；PostgreSQL 16、Chromium、两个API进程、指定的工作进程和一个调度器共享该限制。每个后续兼容二进制必须重新运行这三个相同场景，而不更改任何字段或阈值。

意外5xx计数必须为零。在满足延迟或吞吐量但任何强制不变量为假的情况下，性能运行失败。

## 范围外

- 执行任意不受信任的shell
- 容器编排
- cron表达式
- 计费
- 跨数据库队列

## 交接

保持README和OpenAPI最新。以发现优先的审查结束，并报告架构、模块和进程所有权、公共接口、成功/失败数据流、事务和租约边界、迁移、兼容性、运行的精确命令、测试和性能结果、恢复证据、已知风险以及每个未运行的检查。不要声称实际未执行的检查。
