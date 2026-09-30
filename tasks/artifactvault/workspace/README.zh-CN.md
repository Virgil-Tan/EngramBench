# ArtifactVault

从本刻意留空的仓库构建 ArtifactVault。本 README 是完整的产品契约。请勿在契约之外发明行为。在做出契约未明确规定的产品决策之前，请先询问。

## 必需技术栈

- Node.js 22、TypeScript、React、PostgreSQL 16、npm 以及预装的 Chromium。
- PostgreSQL 是业务状态、幂等性、租约、事件和排序的唯一权威来源。
- 生产环境 UI 必须使用公共 HTTP API；不得使用模拟数据、内存数据库或仅浏览器状态来提供正确性。
- 使用整数领域数量和 UTC ISO-8601 时间戳。不得对金额、容量、序列、持续时间单位或守恒量使用浮点数。

## 必需的非交互式命令

| 命令 | 契约 |
| --- | --- |
| 'npm run db:migrate' | 反复且安全地应用所有版本化迁移。 |
| 'npm run db:seed -- --file <path>' | 原子化导入版本化 JSON 种子数据。 |
| 'npm run dev' | 启动开发环境 API 和 UI。 |
| 'npm run build' | 生成生产环境 API、worker、dispatcher 和 UI 资产。 |
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

每个命令在失败时以非零退出，清理自身子进程，且无需任何提示。

## 环境变量

| 变量 | 默认值 | 规则 |
| --- | --- | --- |
| 'DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/artifactvault' | 生产/开发环境权威来源。 |
| 'TEST_DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/artifactvault_test' | 所有有状态测试必需。 |
| 'PORT' | '3000' | 整数 1-65535；API 和生产 UI 来源。 |
| 'ADMIN_TOKEN' | 任务本地值 | 仅文档化的管理变更路由需要；切勿记录。 |
| 'WEBHOOK_URL' | 'http://127.0.0.1:4010/events' | 领域事件投递的 HTTP 端点。 |
| 'WORK_LEASE_SECONDS' | '3' | 整数 1-60；worker 和恢复测试使用的持久化租约时长。 |
| 'CHROMIUM_PATH' | '/usr/bin/chromium' | 项目自有 E2E 使用的浏览器可执行文件。 |
| 'MANAGED_DATA_ROOT' | '/tmp/artifactvault-data' | 暂存或生成字节的可写根目录；切勿直接提供路径。 |
| 'TEST_BARRIER_URL' | 空 | 仅受控恢复测试使用的可选 localhost HTTP 接收器。 |
| 'TEST_BARRIER_TOKEN' | 空 | 设置 URL 时必需的屏障头值；切勿记录。 |

仅绑定到 '127.0.0.1'。日志不得包含令牌、幂等键、原始种子输入、webhook 主体或私有绝对路径。

## 领域与 V1 行为

| 术语 | 规范定义 | 避免 |
| --- | --- | --- |
| 包 | 拥有有序工件版本的稳定命名空间和名称。 | 项目、仓库 |
| 工件版本 | 不可变元数据加 V1 中一个内容寻址的 Blob。 | 发布、文件 |
| Blob | 由小写 SHA-256 和精确大小标识的字节。 | 工件、上传 |
| 上传会话 | 用于顺序字节范围的持久有界暂存记录。 | 临时文件、请求 |
| 验证任务 | 对暂存字节进行哈希并提交或拒绝版本的持久租约工作。 | 作业、扫描器 |
| Blob 引用 | 防止已提交内容被回收的持久所有权边。 | 路径、指针 |

上传：STAGING -> VERIFYING -> COMMITTED | REJECTED，或 STAGING -> ABANDONED；已提交的工件版本不可变。

1. 创建可恢复的上传会话，并接受具有稳定重试响应的有序字节范围。
2. 在可恢复的 worker 中验证声明的大小和 SHA-256，然后原子提交元数据和 Blob 引用。
3. 跨包去重相同 Blob，而不暴露文件系统路径。
4. 安全地放弃过期的暂存数据，并在持久宽限期后仅回收未被引用的已验证 Blob。
5. 在真实 UI 中展示包版本、上传进度、验证结果、下载和审计事件。

### 确定性策略

1. packageName 匹配 [a-z0-9][a-z0-9._-]{0,127}，version 为 1..64 个可见 ASCII 字符，expectedSize 为 1..2147483648 字节，expectedSha256 为 64 个小写十六进制字符。mediaType 匹配 [a-z0-9][a-z0-9!#$&^_.+-]{0,63}/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}。
2. 块 Content-Range 为 bytes start-end/expectedSize，start 等于 nextOffset，长度除更短的最终块外为 1..8388608，end 为包含式。已精确写入的相同字节范围返回重放；重叠或不同字节则冲突。
3. 暂存字节位于 MANAGED_DATA_ROOT 下且绝不提供。验证以 <=64 MiB 进程 RSS 增长流式读取字节，fsync 并原子重命名为摘要路径，然后提交 ArtifactVersion 和 Blob Reference；崩溃产生的未引用 Blob 保持不可见。
4. 不活动 3600 秒后放弃。垃圾回收仅在 600 秒宽限期和第二次数据库引用检查后删除未引用的摘要；下载可见性始终要求已提交的 Blob 引用。

## 强制不变量

1. 已提交的工件版本恰好有一个可读的 Blob，其大小和摘要与元数据匹配。
2. 被拒绝或放弃的上传不会创建工件版本或 Blob 引用。
3. 包版本标识符唯一，已提交内容永不更改。
4. 具有一个或多个已提交引用的 Blob 永不被垃圾回收。
5. 重试具有相同字节的字节范围是重放；同一范围的不同字节被拒绝。

这些不变量必须在成功、验证失败、未知 HTTP 结果、重复请求、并发请求、worker 或 dispatcher SIGKILL、重启、迁移和持续负载之后仍然成立。

## HTTP 与 OpenAPI 3.1

在 'GET /openapi.json' 提供规范 OpenAPI，在 'GET /healthz' 提供健康检查。OpenAPI 文档与运行时行为必须一致。API 路由使用 JSON，除非明确文档化的原始内容。对不支持的媒体类型返回 415 'UNSUPPORTED_MEDIA_TYPE'，格式错误的 JSON 返回 400 'MALFORMED_JSON'，未知对象键返回 400 'UNKNOWN_FIELD'，形状或范围违规且无更具体的已发布代码时返回 400 'INVALID_REQUEST'。语义或状态冲突使用其已发布的 409 代码。在文档化的 ADMIN_TOKEN 路由上缺失、格式错误或不正确的 Bearer 令牌返回 401 'ADMIN_AUTH_REQUIRED'。

成功的分页集合读取返回 '{items,nextCursor}'。'limit' 默认为 50，为 1 到 100 的整数。游标顺序稳定且不透明；格式错误的游标返回 400 'INVALID_CURSOR'。类型为 'uuid' 的字段是小写 UUID 字符串；未类型化的字符串标识符保留其已发布的语法。时间戳为 UTC，带尾随 'Z'。资源未命中返回 404 'NOT_FOUND'。

错误精确使用：

~~~json
{"error":{"code":"STABLE_CODE","message":"human-readable text","details":{}}}
~~~

以下线符号是规范性的：'uuid' 是小写 RFC 4122 文本，'int' 是 JSON 安全整数，'timestamp' 是带毫秒精度和尾随 Z 的 UTC ISO-8601，'date' 是严格 YYYY-MM-DD，'sha256' 是 64 个小写十六进制字符，'currency' 是三个大写 ASCII 字母，'json' 是 RFC 8785 接受的任何值。'http-url' 是不含凭据或片段的绝对 http 或 https URL。'interval' 恰好是 '{startAt:timestamp,endAt:timestamp}'，startAt 在 endAt 之前，表示半开区间 '[startAt,endAt)'。'|null' 字段为必需且可空。每个未列出的字段都被拒绝，数组保持其声明的顺序。响应精确使用这些资源形状：

- UploadSession = {uploadId:uuid,packageName:string,version:string,mediaType:string,expectedSize:int,expectedSha256:sha256,nextOffset:int,state:STAGING|VERIFYING|COMMITTED|REJECTED|ABANDONED,expiresAt:timestamp,artifactVersionId:uuid|null,createdAt:timestamp}
- ArtifactVersion = {artifactVersionId:uuid,packageName:string,version:string,blob:{sha256:sha256,size:int,mediaType:string},committedAt:timestamp,sequence:int}
- ChunkReceipt = {uploadId:uuid,start:int,endExclusive:int,nextOffset:int,replayed:boolean}
- VerificationResult = {uploadId:uuid,actualSize:int,actualSha256:sha256,outcome:COMMITTED|SIZE_MISMATCH|DIGEST_MISMATCH,completedAt:timestamp}

公共聚合路由为：

- 'GET /api/v1/artifact-versions?limit&cursor' 和
  'GET /api/v1/artifact-versions/:artifactVersionId'。
- POST /api/v1/upload-sessions，请求体为 {packageName,version,mediaType,expectedSize,expectedSha256}；返回 201 及精确的 STAGING UploadSession。
- PUT /api/v1/upload-sessions/:uploadId/chunks，携带 Content-Range 和原始字节，仅接受精确的下一个范围或完全相同的重放。
- POST /api/v1/upload-sessions/:uploadId/complete，请求体为 {}，返回 202 VERIFYING 并调度一个 Verification Task。大小或摘要不匹配是异步结果：工作进程存储带有 SIZE_MISMATCH 或 DIGEST_MISMATCH 的 VerificationResult，将 UploadSession 更改为 REJECTED，并且不创建 ArtifactVersion 或 Blob Reference。
- GET /api/v1/packages/:packageName/versions/:version 返回精确的 ArtifactVersion 元数据，或返回 404 而不读取 Blob 字节。
- GET /api/v1/packages/:packageName/versions/:version/content 支持精确的 Content-Length、ETag 摘要和字节范围。
- GET /api/v1/upload-sessions/:uploadId 返回 UploadSession 及其最新的 VerificationResult|null。
- 'GET /api/v1/domain-events?aggregateId&afterSequence&limit' 按顺序返回已提交的事件。
- 'GET /api/v1/verification-snapshot' 要求 'Authorization: Bearer <ADMIN_TOKEN>' 并返回一个
  可序列化的快照 '{asOf:timestamp,resources:{...},work:[Work],events:[DomainEvent]}'。

### V1 验证快照

完整快照从单个 PostgreSQL 时间点读取；'asOf'、每个资源数组、'work'
和 'events' 必须描述同一数据库快照。V1 'resources' 对象恰好具有以下键
且无其他键：

- 'packages' 使用精确形状 'Package = {packageName:string,displayName:string}'，并按标量字段路径元组 'packageName' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。
- 'uploadSessions' 使用精确形状 'UploadSession'，并按标量字段路径元组 'uploadId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。
- 'artifactVersions' 使用精确形状 'ArtifactVersion'，并按标量字段路径元组 'artifactVersionId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。
- 'verificationResults' 使用精确形状 'VerificationResult'，并按标量字段路径元组 'uploadId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。
- 'blobs' 使用精确形状 'Blob = {sha256:sha256,size:int,mediaType:string,state:STAGED|VERIFIED|COMMITTED|ORPHANED,referenceCount:int}'，并按标量字段路径元组 'sha256' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。
- 'blobReferences' 使用精确形状 'BlobReference = {artifactVersionId:uuid,blobSha256:sha256,createdAt:timestamp}'，并按标量字段路径元组 'artifactVersionId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。

每个资源数组恰好包含其声明形状所命名的每个当前或不可变实例
一次。每个列出的排序路径解析为标量。标量顺序为 null 优先，然后 false 在 true 之前，
整数按数值排序，所有其他字符串形式标量按 UTF-8 字节排序。按完整元组升序排序，
然后仅使用 RFC 8785 规范 JSON 作为决胜条件。
递归省略名称以 'Token' 结尾的每个对象字段，在所有嵌套深度。

'Work' 恰好是
'{workId:uuid,kind:ARTIFACT_VERIFICATION|UPLOAD_EXPIRY|BLOB_GC,aggregateId:uuid,state:PENDING|LEASED|SUCCEEDED|FAILED|CANCELLED,terminal:boolean,attempt:int,leaseOwner:string|null,leaseExpiresAt:timestamp|null}'。
'kind' 恰好是 'ARTIFACT_VERIFICATION'、'UPLOAD_EXPIRY'、'BLOB_GC' 之一。两个租约字段仅在
状态为 'LEASED' 时非空，在所有其他状态下均为 null。'terminal' 仅在状态为
'SUCCEEDED'、'FAILED' 或 'CANCELLED' 时为 true；终止的 Work 被保留。
当没有匹配的 Work 具有 'terminal:false' 时，积压队列恰好被排空。'work' 数组按
workId 排序。

'events' 包含精确的 Domain Event 对象，按 aggregateId、sequence、eventId 排序。对每个事件负载应用
相同的递归 '*Token' 省略。省略认证和业务防护
令牌、幂等键、原始 webhook 主体、私有文件系统路径和机密。这是
外部不变量查询面。

对于格式良好的请求，以下领域错误是穷尽的，除了上述发布的常见错误
加上 400 'INVALID_REQUEST'、400 'INVALID_CURSOR'、404 'NOT_FOUND' 和 409
'IDEMPOTENCY_CONFLICT'：

| HTTP | 代码 | 精确触发条件 |
| ---: | --- | --- |
| 409 | PACKAGE_VERSION_EXISTS | 包加版本已提交 |
| 409 | UPLOAD_RANGE_CONFLICT | 范围非顺序、重叠或重放不同字节 |
| 409 | UPLOAD_INCOMPLETE | 在 nextOffset 等于 expectedSize 之前请求 complete |
| 409 | UPLOAD_NOT_WRITABLE | Upload Session 不再是 STAGING |
| 400 | INVALID_UPLOAD_DECLARATION | packageName、version、mediaType、size 或 digest 违反已发布的边界 |

### 持久幂等性

每个变更都需要 'Idempotency-Key'，1-128 个可见 ASCII 字符。作用域是方法、规范
路径和键。在确认成功之前持久化规范语义请求
指纹和完整状态/主体。相同的重试，包括
在重启或未知响应丢失后，返回原始状态和语义 JSON，且无第二次
效果。使用不同语义重用键返回 409 'IDEMPOTENCY_CONFLICT'。并发相同
请求收敛于一个结果；进程本地映射不是权威。在基准测试期间不要
过期记录，或在迁移期间重写已保存的重放主体。

## 种子契约

'npm run db:seed -- --file <path>' 恰好接受：

'{schemaVersion:1,seedVersion,packages,artifactVersions}; seeded Blob bytes live in declared relative fixture files, each digest and size must match, and import is atomic across database and managed blob directory.'

成员模式是精确的：

- packages[] = {packageName:string,displayName:string}
- artifactVersions[] = {artifactVersionId:uuid,packageName:string,version:string,mediaType:string,assetPath:string,expectedSize:int,expectedSha256:sha256,committedAt:timestamp}；assetPath 相对于同级 assets 目录
- assetPath 必须规范化为 <seed-directory>/assets 内部，无绝对路径、点段、符号链接或非常规文件；所有文件在任何数据库行或托管 Blob 可见之前验证

'seedVersion' 是非空字符串，最多 64 个字符。导入器记录规范文件摘要。
相同版本和摘要是无操作重放；相同版本不同内容失败并返回
'SEED_VERSION_CONFLICT'。拒绝未知键、重复 ID、缺失引用、无效状态、破坏的
不变量、超出范围的整数和格式错误的时间。任何无效成员拒绝完整导入
而不更改业务行、任务、幂等性或 Domain Events。

## 工作进程、事件和恢复

工作进程使用 'WORK_LEASE_SECONDS' 声明有界持久租约。租约所有权必须在
提交结果的短事务内再次证明。在等待
HTTP、文件、时钟或其他进程时不要持有数据库事务。过期租约可重新声明，但过期令牌不能提交。

业务状态及其 Domain Event 在一个事务中提交。事件字段为 'eventId'、'aggregateId'、
正整数 'sequence'、'type'、'occurredAt'、'schemaVersion:1' 和 'payload'。必需事件类型：
`upload.completed`、`artifact.committed`、`artifact.rejected`、`upload.abandoned`、`blob.collected`。'payload' 对于每个 V1 事件恰好是 '{}'；后续 Manager 事件也使用 '{}'，除非
其发布的契约字面上提供另一个负载形状。回滚不创建事件。序列
每个聚合是连续的。

调度器发送带有 'X-ArtifactVault-Event-Id' 和 'X-ArtifactVault-Event-Type' 的 JSON。网络错误、
超时和非 2xx 响应以有界退避无限重试。每次重试保持相同的
eventId 和语义主体。成功投递顺序是递增的聚合序列。至少一次
投递可能重复请求；它不得发明另一个事件身份。

### 受控恢复屏障

当 'TEST_BARRIER_URL' 为空时，不存在屏障请求。当两个测试变量都设置时，工作进程
在 'worker.claimed'、'worker.effect-complete' 和 'worker.before-commit' 处继续之前 POST；调度器在 'dispatcher.response-received' 处 POST。精确 JSON 是
'{schemaVersion:1,processRole:worker|dispatcher,point,workId,aggregateId,attempt,leaseTokenHash}'，头是
'X-Test-Barrier-Token: <TEST_BARRIER_TOKEN>'。ID 和点在重试间保持相同；
leaseTokenHash 是令牌的 SHA-256，绝不是令牌。204 响应释放进程。保持
响应暂停它而不打开数据库事务。连接丢失或非 204 每
100 毫秒重试相同主体，直到租约丢失或进程终止。仅接受 localhost URL。

## 真实 UI

提供桌面和移动流程，用于创建 V1 聚合、查看集合和详情、
执行每个公共用户操作、观察异步 Verification Task 进度、浏览事件和
历史证据，并在刷新后恢复。显示加载、空、验证、冲突、过期、
离线/重试、终止和权限错误状态。使用可见语义控件、键盘导航、
关联标签、焦点管理和 WCAG AA 对比度。绝不需要 devtools 或直接 API 调用来
完成主要流程。

## 项目自有验证

- 单元测试覆盖确定性策略、状态转换、规范化及边界值。
- 集成测试启动真实的 PostgreSQL 和真实的 HTTP 进程；它们从不调用内部服务。
- 浏览器端到端测试使用生产构建、真实 Chromium、真实 API/数据库/工作进程以及可见控件。
- 并发测试使用至少两个 API 进程和两个工作进程，针对同一个 PostgreSQL 数据库。
- 恢复测试使用仅限测试的公共屏障来观察声明/提交或接收方/确认边界，然后发送 SIGKILL；随机睡眠不是故障控制手段。
- 性能测试针对以下固定间隔运行生产构建，报告 p50/p95/p99、吞吐量、成功变更、预期冲突、意外 5xx、积压排空以及负载后不变量。

固定的 V1 兼容性能场景：

### 场景 'concurrent-upload-stream'

- 目标：以聚合速率 >= 120 MiB/s 流式传输 20 个并发 64 MiB 上传
- 模式：'http'
- 方法：'PUT'
- 路径：'/api/v1/upload-sessions/:uploadId/chunks'
- 设置：精确使用 20 个已测量的 STAGING 状态 UploadSession，每个 64 MiB。它们的确定性字节和预期摘要已在计时前准备好；此有限场景无预热。
- 选择器：每个客户端拥有一个 UploadSession，并发送八个连续的 8 MiB 范围；会话并发运行，且从不共享分块请求。
- 请求：原始 application/octet-stream，带 Content-Range 字节 start-end/67108864；每个分块恰好为 8 MiB，并携带新的 Idempotency-Key。
- 并发数：20
- 预热秒数：0
- 测量秒数：60
- 成功条件：每个 PUT 返回精确的 ChunkReceipt，并仅推进一次 nextOffset；计时后，完成所有会话并验证其摘要作为正确性后置条件。
- 阈值：从首次测量的 PUT 派发到最后一个完整的 PUT 响应，聚合接受的有效负载吞吐量 >= 120 MiB/s；重放、间隙和 5xx 错误为零。
- 计时器：在派发前 20 个分块之前立即开始，并在所有 160 个测量的 PUT 响应体完成后停止。

### 场景 'artifact-metadata-read'

- 目标：以 p95 <= 120 ms 提供 200 次元数据读取/秒
- 模式：'http'
- 方法：'GET'
- 路径：'/api/v1/packages/:packageName/versions/:version'
- 设置：使用全部 100,000 个已播种的已提交 ArtifactVersion；读取从不打开内容字节。
- 选择器：按 UTF-8 字节顺序轮询 packageName，然后轮询 version。
- 请求：无请求体、Range 或条件头。
- 并发数：64
- 预热秒数：10
- 测量秒数：60
- 成功条件：仅计算 200 个精确的 ArtifactVersion 元数据响应；blob 摘要、大小、媒体类型和序列必须原子一致。
- 阈值：在 60 秒内至少 200 次成功的元数据读取/秒，且 p95 <= 120 ms；意外 5xx = 0。
- 计时器：吞吐量窗口从预热后的第一个测量请求开始；每个延迟样本从请求派发到完整响应体结束。

### 场景 'verification-recovery'

- 目标：在工作进程恢复后 90 秒内验证 2 GiB 积压，且工作进程峰值 RSS <= 768 MiB
- 模式：'worker'
- 方法：'N/A'
- 路径：'work:ARTIFACT_VERIFICATION'
- 设置：恰好 32 个 VERIFYING 状态的 64 MiB 会话，总计 2 GiB。保持两个工作进程在 worker.claimed 状态，发送 SIGKILL，等待租约过期，然后启动两个替代工作进程；在每个替代工作进程首次声明之前记录其基线 RSS，并每 100 ms 采样 RSS。
- 选择器：按 UploadSession 的 createdAt 然后 uploadId 处理，并流式传输字节而非缓冲对象。
- 请求：不发出测量的客户端请求；设置仅使用已发布的种子和公共 API，在工作进程计时器开始之前。
- 并发数：2
- 预热秒数：0
- 测量秒数：90
- 成功条件：所有 32 个会话恰好达到 COMMITTED 状态，没有验证工作保持非终止状态，每个 Blob 摘要/引用均验证通过，每个替代工作进程的峰值 RSS <= 768 MiB，且峰值减去记录的基线 <= 64 MiB。
- 阈值：在替代工作进程生成后 <= 90 秒内排空 2 GiB 积压，同时满足两个 RSS 界限，且零陈旧提交或意外失败。
- 计时器：在两个替代工作进程生成时开始，仅在快照、托管对象验证和最终 RSS 采样证明所有后置条件后停止。

固定性能种子：seedVersion perf-v1 恰好包含 100,000 个包和 100,000 个 artifactVersion，其有效的一字节夹具文件共享一个 Blob；上传运行设置创建 20 个 STAGING 状态的 64 MiB 会话，而恢复运行设置创建 32 个 VERIFYING 状态的 64 MiB 会话，总计恰好 2 GiB。

这三个场景是从新迁移的数据库和上述精确种子独立运行的；
完成每个场景's Setup before its Timer begins. Mode 'http' means 'method' and 'path' 命名
唯一测量的公共请求操作，'concurrency' 是精确的闭环客户端数量。模式
'worker' 表示方法 'N/A'，'path' 命名测量的工作种类，'concurrency' 是精确的工作进程
数量。精确使用每个场景的选择器和请求；没有推断的混合工作负载。
运行恰好 'warmupSeconds' 秒未测量时间，然后恰好 'measureSeconds' 秒测量时间或直到
计时器声明的终止条件。有状态预热和测量身份必须不相交。计数
完整的 HTTP 响应体以计算延迟。预期发布的冲突单独报告，除非
场景的成功条件和阈值明确计数它们。

基准容器有 4 个逻辑 CPU 和 8 GiB RAM；PostgreSQL 16、Chromium、两个 API 进程、
指定的工作进程和一个调度器共享该限制。每个后续兼容二进制文件必须重新运行
这些相同的三个场景，而不更改任何字段或阈值。

意外 5xx 计数必须为零。在满足延迟或吞吐量但任何强制不变量为假的情况下，
性能运行视为失败。

## 范围外

- 恶意软件检测
- 包依赖解析
- 身份验证
- 外部对象存储
- 内容签名

## 交接

保持 README 和 OpenAPI 最新。以发现优先的审查结束，并报告架构、模块和
进程所有权、公共接口、成功/失败数据流、事务和租约边界、
迁移、兼容性、执行的精确命令、测试和性能结果、恢复证据、已知
风险以及所有未运行的检查。不要声称实际未执行的检查。
