# ExportVault

基于此有意为空的仓库构建 ExportVault。本 README 是完整的产品契约。请勿在契约之外发明行为。在做出契约未明确规定的产品决策之前，请先询问。

## 必需技术栈

- Node.js 22、TypeScript、React、PostgreSQL 16、npm 以及预装的 Chromium。
- PostgreSQL 是业务状态、幂等性、租约、事件和排序的唯一权威。
- 生产环境 UI 必须使用公共 HTTP API；不得使用模拟、内存数据库或仅浏览器端状态来提供正确性。
- 使用整数域数量和 UTC ISO-8601 时间戳。不得对金额、容量、序列、持续时间单位或守恒量使用浮点数。

## 必需的非交互式命令

| 命令 | 契约 |
| --- | --- |
| 'npm run db:migrate' | 反复且安全地应用所有版本化迁移。 |
| 'npm run db:seed -- --file <path>' | 原子化导入版本化 JSON 种子数据。 |
| 'npm run dev' | 启动开发环境 API 和 UI。 |
| 'npm run build' | 生成生产环境 API、worker、dispatcher 和 UI 资产。 |
| 'npm run start:api' | 启动一个生产环境 API/UI 进程。 |
| 'npm run start:worker' | 启动一个导出任务 worker。 |
| 'npm run start:dispatcher' | 启动域事件 webhook dispatcher。 |
| 'npm run test:unit' | 运行纯逻辑和边界测试。 |
| 'npm run test:integration' | 运行真实 PostgreSQL 加公共 HTTP 集成测试。 |
| 'npm run test:e2e' | 通过可见控件运行生产构建的 Chromium 测试。 |
| 'npm run test:concurrency' | 针对一个数据库运行至少两个 API 和两个 worker 进程。 |
| 'npm run test:recovery' | 使用可观察屏障、SIGKILL、重启和持久恢复。 |
| 'npm run test:all' | 从干净数据库运行上述所有非性能门禁。 |
| 'npm run test:perf' | 运行固定持续负载并验证所有负载后不变量。 |

每个命令在失败时以非零状态退出，清理自身的子进程，且无需任何提示。

## 环境

| 变量 | 默认值 | 规则 |
| --- | --- | --- |
| 'DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/exportvault' | 生产/开发环境权威。 |
| 'TEST_DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/exportvault_test' | 所有有状态测试必需。 |
| 'PORT' | '3000' | 整数 1-65535；API 和生产环境 UI 来源。 |
| 'ADMIN_TOKEN' | 任务本地值 | 仅文档化的管理变更路由需要；切勿记录。 |
| 'WEBHOOK_URL' | 'http://127.0.0.1:4010/events' | 域事件投递的 HTTP 端点。 |
| 'WORK_LEASE_SECONDS' | '3' | 整数 1-60；worker 和恢复测试使用的持久化租约时长。 |
| 'CHROMIUM_PATH' | '/usr/bin/chromium' | 项目自有 E2E 使用的浏览器可执行文件。 |
| 'MANAGED_DATA_ROOT' | '/tmp/exportvault-data' | 暂存或生成字节的可写根目录；切勿直接提供路径。 |
| 'TEST_BARRIER_URL' | 空 | 仅受控恢复测试使用的可选 localhost HTTP 接收器。 |
| 'TEST_BARRIER_TOKEN' | 空 | 当 URL 已设置时必需的屏障头值；切勿记录。 |

仅绑定到 '127.0.0.1'。日志不得包含令牌、幂等键、原始种子输入、webhook 主体或私有绝对路径。

## 领域和 V1 行为

| 术语 | 规范定义 | 避免 |
| --- | --- | --- |
| 导出请求 | 针对一个主题和捕获的数据集修订版的范围化请求。 | 下载、报告 |
| 数据集修订版 | 所有导出部分必须遵守的不可变源水印。 | 时间戳、数据库状态 |
| 导出任务 | 从捕获的修订版生成归档的持久化租约工作。 | 作业、查询 |
| 导出对象 | 经过验证的不可变字节，包含摘要、大小、媒体类型和保留截止时间。 | 文件、blob |
| 下载授权 | 授权有界范围读取的短期服务器记录。 | 令牌、URL |
| 删除证明 | 已过期或已取消的导出对象不再可读的不可变事实。 | 日志、墓碑 |

导出：REQUESTED -> GENERATING -> READY -> EXPIRED，或 REQUESTED/GENERATING -> CANCELLED | FAILED。

1. 创建去重的导出请求，捕获一个一致的数据集修订版。
2. 通过租约 worker 生成确定性归档，并在 SIGKILL 后安全恢复。
3. 在原子发布一个导出对象之前验证摘要和大小。
4. 签发支持字节范围的可撤销下载授权，并通过持久化清理工作使对象过期。
5. 在 UI 中展示请求进度、部分计数、下载、取消、过期和审计事件。

### 确定性策略

1. scope 是来自 profile、activity、orders、files 的排序唯一 1..20 列表；format 为 JSONL 或 CSV。数据集修订版是在创建事务中捕获的当前租户范围的正整数修订版。
2. 部分使用 scope 顺序，记录按 recordId 排序。JSONL 为 UTF-8 RFC 8785 JSON 加 LF。CSV 具有精确的头部记录 recordId、data 加 LF；每行包含小写 UUID 和 data 的 RFC 8785 JSON 文本，使用 RFC 4180 引用和 LF 编码。
3. 等效的非终止请求共享 subjectId、排序 scope、format 和 datasetRevision，并重放一个导出。发布在 READY 事务之前 fsync 并原子重命名已验证的字节；孤儿字节不可见且可恢复。
4. retentionUntil 为 createdAt + 24 小时。授权持续 60..900 秒，且不能超过 retentionUntil。清理等待直到 retentionUntil 且所有授权过期/撤销，然后删除字节并提交一个删除证明。

## 强制不变量

1. 一个导出中的每个部分都观察相同的捕获数据集修订版。
2. 一个 READY 导出恰好有一个可读对象，其摘要和大小与元数据匹配。
3. 已取消、失败或过期的导出永远不可新下载。
4. 同一主题、scope 和修订版的等效活动请求产生一个导出和稳定重放。
5. 清理永远不会在其保留截止时间之前或存在未过期授权时移除对象。

这些不变量必须在成功、验证失败、未知 HTTP 结果、重复请求、并发请求、worker 或 dispatcher SIGKILL、重启、迁移和持续负载之后仍然成立。

## HTTP 和 OpenAPI 3.1

在 'GET /openapi.json' 提供规范 OpenAPI，在 'GET /healthz' 提供健康检查。OpenAPI 文档和运行时行为必须一致。API 路由使用 JSON，除非明确文档化的原始内容。拒绝不支持的媒体类型，返回 415 'UNSUPPORTED_MEDIA_TYPE'；拒绝格式错误的 JSON，返回 400 'MALFORMED_JSON'；拒绝未知对象键，返回 400 'UNKNOWN_FIELD'；拒绝形状或范围违规且无更具体的已发布代码，返回 400 'INVALID_REQUEST'。语义或状态冲突使用其已发布的 409 代码。在文档化的 ADMIN_TOKEN 路由上，缺失、格式错误或不正确的 Bearer 令牌返回 401 'ADMIN_AUTH_REQUIRED'。

成功的分页集合读取返回 '{items,nextCursor}'。'limit' 默认为 50，为 1 到 100 的整数。游标顺序稳定且不透明；格式错误的游标返回 400 'INVALID_CURSOR'。类型为 'uuid' 的字段是小写 UUID 字符串；未类型化的字符串标识符保留其已发布的语法。时间戳为 UTC，带尾随 'Z'。资源未命中返回 404 'NOT_FOUND'。

错误精确使用：

~~~json
{"error":{"code":"STABLE_CODE","message":"human-readable text","details":{}}}
~~~

以下线符号是规范性的：'uuid' 是小写 RFC 4122 文本，'int' 是 JSON 安全整数，'timestamp' 是带毫秒精度和尾随 Z 的 UTC ISO-8601，'date' 是严格 YYYY-MM-DD，'sha256' 是 64 位小写十六进制，'currency' 是三个大写 ASCII 字母，'json' 是 RFC 8785 接受的任何值。'http-url' 是不含凭据或片段的绝对 http 或 https URL。'interval' 恰好是 '{startAt:timestamp,endAt:timestamp}'，具有 startAt 早于 endAt，表示半开区间 '[startAt,endAt)'。'|null' 字段是必需且可空的。每个未列出的字段都被拒绝，数组保留其声明的顺序。响应精确使用这些资源形状：

- Export = {exportId:uuid,subjectId:uuid,scope:[string],format:JSONL|CSV,datasetRevision:int,state:REQUESTED|GENERATING|READY|EXPIRED|CANCELLED|FAILED,object:{sha256:sha256,size:int,mediaType:string}|null,retentionUntil:timestamp,createdAt:timestamp,readyAt:timestamp|null,sequence:int}
- ExportSection = {exportId:uuid,name:string,recordCount:int,firstRecordId:uuid|null,lastRecordId:uuid|null,digest:sha256,state:PENDING|WRITTEN|VERIFIED}
- DownloadGrant = {grantId:uuid,exportId:uuid,expiresAt:timestamp,revokedAt:timestamp|null,createdAt:timestamp}
- DeletionProof = {exportId:uuid,objectSha256:sha256,reason:EXPIRED|CANCELLED,deletedAt:timestamp,proofDigest:sha256}

公共聚合路由为：

- 'GET /api/v1/exports?limit&cursor' 和
  'GET /api/v1/exports/:exportId'。
- POST /api/v1/exports，请求体为 {subjectId,scope,format}；返回 202 及精确的 REQUESTED Export，包括其捕获的 datasetRevision 和 retentionUntil，并具备持久幂等性。
- POST /api/v1/exports/:exportId/cancel，请求体为 {reason}，与生成发布安全并发。
- POST /api/v1/exports/:exportId/download-grants，请求体为 {expiresInSeconds}，要求状态为 READY，返回 grantId 和 expiresAt。
- POST /api/v1/download-grants/:grantId/revoke，请求体为 {reason}，原子性地设置一次 revokedAt；完全相同的幂等重放返回原始 DownloadGrant。
- GET /api/v1/download-grants/:grantId/content 支持 ETag、精确范围，并在撤销或过期后返回 410。
- GET /api/v1/exports/:exportId/sections 按请求的 scope 顺序返回 {items:[ExportSection]}。
- 'GET /api/v1/domain-events?aggregateId&afterSequence&limit' 按顺序返回已提交的事件。
- 'GET /api/v1/verification-snapshot' 要求 'Authorization: Bearer <ADMIN_TOKEN>'，并返回一个
  可序列化的快照 '{asOf:timestamp,resources:{...},work:[Work],events:[DomainEvent]}'。

### V1 验证快照

完整快照从单个 PostgreSQL 时间点读取；'asOf'、每个资源数组、'work'
以及 'events' 必须描述同一数据库快照。V1 'resources' 对象仅包含以下键，
无其他键：

- 'subjects' 使用精确形状 'ExportSubject = {subjectId:uuid,name:string,currentDatasetRevision:int}'，并按标量字段路径元组 'subjectId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。
- 'datasetRevisionSummaries' 使用精确形状 'DatasetRevisionSummary = {subjectId:uuid,revision:int,committedAt:timestamp,recordCount:int,recordsDigest:sha256}; recordsDigest is SHA-256 of RFC 8785 records sorted by recordId'，并按标量字段路径元组 'subjectId'、'revision' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。
- 'exports' 使用精确形状 'Export'，并按标量字段路径元组 'exportId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。
- 'exportSections' 使用精确形状 'ExportSection'，并按标量字段路径元组 'exportId'、'name' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。
- 'downloadGrants' 使用精确形状 'DownloadGrant'，并按标量字段路径元组 'grantId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。
- 'deletionProofs' 使用精确形状 'DeletionProof'，并按标量字段路径元组 'exportId'、'objectSha256' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。

每个资源数组恰好包含其声明形状所命名的每个当前或不可变实例一次。每个列出的排序路径解析为标量。标量顺序为 null 优先，然后 false 在 true 之前，整数按数值排序，其他所有字符串形式标量按 UTF-8 字节排序。按完整元组升序排序，然后仅以 RFC 8785 规范 JSON 作为决胜条件。
递归省略每个名称以 'Token' 结尾的对象字段，在所有嵌套深度。

'Work' 恰好是
'{workId:uuid,kind:EXPORT_GENERATION|EXPORT_CLEANUP,aggregateId:uuid,state:PENDING|LEASED|SUCCEEDED|FAILED|CANCELLED,terminal:boolean,attempt:int,leaseOwner:string|null,leaseExpiresAt:timestamp|null}'。
'kind' 恰好是 'EXPORT_GENERATION'、'EXPORT_CLEANUP' 之一。两个租约字段仅在状态为 'LEASED' 时非空，在其他所有状态下均为 null。'terminal' 仅在状态为
'SUCCEEDED'、'FAILED' 或 'CANCELLED' 时为 true；终止的 Work 被保留。
当没有匹配的 Work 具有 'terminal:false' 时，积压队列被完全排空。'work' 数组按
workId 排序。

'events' 包含精确的 Domain Event 对象，按 aggregateId、sequence、eventId 排序。对每个事件负载应用相同的递归 '*Token' 省略。省略认证和业务围栏令牌、幂等键、原始 webhook 体、私有文件系统路径和机密。这是外部不变量查询表面。

以下领域错误对于格式良好的请求是穷尽的，除上述已发布的常见错误外，还包括 400 'INVALID_REQUEST'、400 'INVALID_CURSOR'、404 'NOT_FOUND' 和 409
'IDEMPOTENCY_CONFLICT'：

| HTTP | 代码 | 精确触发条件 |
| ---: | --- | --- |
| 409 | EXPORT_NOT_READY | 在 READY 之前请求下载授权 |
| 409 | EXPORT_NOT_CANCELLABLE | Export 处于 READY 或终止状态 |
| 410 | DOWNLOAD_GRANT_EXPIRED | 授权已过期或已撤销 |
| 410 | EXPORT_GONE | Export 对象已过期并被删除 |
| 409 | DOWNLOAD_GRANT_NOT_REVOCABLE | 授权已过期或已撤销 |
| 400 | INVALID_EXPORT_SCOPE | scope 为空、重复、未知或过大 |

### 持久幂等性

每个变更操作要求 'Idempotency-Key'，1-128 个可见 ASCII 字符。作用域为方法、规范
路径和键。在确认成功之前持久化规范语义请求
指纹和完整状态/响应体。完全相同的重试，包括
在重启或未知响应丢失后，返回原始状态和语义 JSON，且无第二次效果。使用相同键但不同语义返回 409 'IDEMPOTENCY_CONFLICT'。并发相同请求收敛于一个结果；进程本地映射不是权威。在基准测试期间不使记录过期，也不在迁移期间重写保存的重放响应体。

## 种子契约

'npm run db:seed -- --file <path>' 恰好接受：

'{schemaVersion:1,seedVersion,subjects,datasetRevisions,exports}; record IDs are unique per Subject, revision watermarks are monotonic, and seeded object digests must match relative fixture bytes.'

成员模式是精确的：

- subjects[] = {subjectId:uuid,name:string,currentDatasetRevision:int}
- datasetRevisions[] = {subjectId:uuid,revision:int,committedAt:timestamp,records:[{recordId:uuid,scope:string,data:json}]}；修订是连续的，记录数据是 RFC 8785 可序列化的
- exports[] 使用精确的 Export 模式；READY 对象包含相对于 <seed-directory>/assets 的 assetPath，且必须验证摘要/大小，无符号链接或路径逃逸

'seedVersion' 是非空字符串，最多 64 个字符。导入器记录规范文件摘要。
相同版本和摘要是无操作重放；相同版本但内容不同则失败，错误为
'SEED_VERSION_CONFLICT'。拒绝未知键、重复 ID、缺失引用、无效状态、破坏的
不变量、超出范围的整数和格式错误的时间。任何无效成员拒绝整个导入，
不改变业务行、任务、幂等性或 Domain Events。

## 工作进程、事件和恢复

工作进程使用 'WORK_LEASE_SECONDS' 声明有界持久租约。租约所有权必须在提交结果的短事务内再次证明。在等待
HTTP、文件、时钟或其他进程时，不持有数据库事务。过期租约可重新声明，但过期令牌不能提交。

业务状态及其 Domain Event 在单个事务中提交。事件字段为 'eventId'、'aggregateId'、
正整数 'sequence'、'type'、'occurredAt'、'schemaVersion:1' 和 'payload'。必需事件类型：
`export.requested`、`export.ready`、`export.failed`、`export.cancelled`、`export.expired`、`export.deleted`、`download-grant.revoked`。'payload' 对每个 V1 事件恰好是 '{}'；后续 Manager 事件也使用 '{}'，除非
其发布的契约字面提供另一负载形状。回滚不产生事件。序列
按聚合连续。

调度器发送 JSON，包含 'X-ExportVault-Event-Id' 和 'X-ExportVault-Event-Type'。网络错误、
超时和非 2xx 响应以有界退避无限重试。每次重试保持相同的
eventId 和语义体。成功投递顺序为聚合序列递增。至少一次
投递可能重复请求；不得发明另一事件身份。

### 受控恢复屏障

当 'TEST_BARRIER_URL' 为空时，不存在屏障请求。当两个测试变量都设置时，工作进程
在 'worker.claimed'、'worker.effect-complete' 和 'worker.before-commit' 处继续前 POST；调度器在 'dispatcher.response-received' 处 POST。精确 JSON 为
'{schemaVersion:1,processRole:worker|dispatcher,point,workId,aggregateId,attempt,leaseTokenHash}'，头为
'X-Test-Barrier-Token: <TEST_BARRIER_TOKEN>'。ID 和点跨重试保持相同；
leaseTokenHash 是令牌的 SHA-256，绝不是令牌。204 响应释放进程。保持的
响应暂停进程，不打开数据库事务。连接丢失或非 204 每
100 毫秒重试，使用相同体，直到租约丢失或进程终止。仅接受 localhost URL。

## 真实 UI

提供桌面和移动流程，用于创建 V1 聚合、查看集合和详情、
执行每个公共用户操作、观察异步 Export Task 进度、浏览事件和
历史证据，以及在刷新后恢复。显示加载、空、验证、冲突、过期、
离线/重试、终止和权限错误状态。使用可见语义控件、键盘导航、
关联标签、焦点管理和 WCAG AA 对比度。完成主流程时，绝不要求使用开发者工具或直接 API 调用。

## 项目自有验证

- 单元测试覆盖确定性策略、状态转换、规范化和边界值。
- 集成测试启动真实 PostgreSQL 和真实 HTTP 进程；它们从不调用内部服务。
- 浏览器 E2E 使用生产构建、真实 Chromium、真实 API/数据库/工作进程和可见控件。
- 并发测试使用至少两个 API 进程和两个工作进程，针对一个 PostgreSQL 数据库。
- 恢复测试使用公共仅测试屏障观察声明/提交或接收器/ACK 边界，然后
  SIGKILL；随机睡眠不是故障控制。
- 性能测试运行生产构建，针对以下固定间隔，报告 p50/p95/p99、吞吐量、
  成功变更、预期冲突、意外 5xx、积压排空和加载后不变量。

固定 V1 兼容性能场景：

### 场景 'range-download'

- 目标：在聚合吞吐量 >= 150 MiB/s 的情况下，服务 100 个并发范围下载
- 模式：'http'
- 方法：'GET'
- 路径：'/api/v1/download-grants/:grantId/content'
- 设置：性能种子数据提供至少 100 个活跃的 READY 导出，这些导出共享一个已验证的至少 64 MiB 的对象。在预热前为每个导出创建一个未过期的授权。
- 选择器：每个闭环客户端拥有 100 个授权中的一个，并重复读取其对象；授权 ID 在客户端之间绝不共享。
- 请求：头部范围：bytes=0-1048575，每个 206 响应恰好 1 MiB；无条件头部。
- 并发数：100
- 预热秒数：10
- 测量秒数：60
- 成功标准：仅完整的 206 响应，且 Content-Length 为 1048576，正确的 Content-Range、ETag 和已验证的字节数。
- 阈值：聚合已验证响应体吞吐量在 60 秒内 >= 150 MiB/s；错误字节、200 回退、5xx 和活跃对象删除均为零。
- 计时器：吞吐量窗口从预热后的第一个测量请求开始；每个延迟样本从请求发送到完整响应体结束。

### 场景 'five-million-record-generation'

- 目标：在 120 秒内生成 5,000,000 条种子记录到已验证对象中
- 模式：'worker'
- 方法：'N/A'
- 路径：'work:EXPORT_GENERATION'
- 设置：使用一个种子数据集修订版，其中恰好包含 5,000,000 条记录，分布在 profile、activity、orders 和 files 中，每个范围有 1,250,000 条按 recordId 排序的记录。在启动两个工作进程前，创建一个覆盖所有四个范围的 JSONL 导出。
- 选择器：按请求顺序写入范围，按 recordId 写入记录；每行是精确的 RFC 8785 记录后跟 LF。
- 请求：不发出测量的客户端请求；设置仅使用已发布的种子和公共 API，在工作进程计时器启动前完成。
- 并发数：2
- 预热秒数：0
- 测量秒数：120
- 成功标准：导出为 READY 状态，所有部分均为 VERIFIED，精确覆盖 5,000,000 条记录，对象字节/摘要/大小已验证，且无 EXPORT_GENERATION 工作非终止状态。
- 阈值：生成和验证在 <= 120 秒内完成，零缺失、重复、乱序或意外失败的记录。
- 计时器：在两个工作进程在导出请求提交后生成时启动；仅在快照和直接对象验证证明所有后置条件后停止。

### 场景 'expired-object-cleanup'

- 目标：在 60 秒内清理 10,000 个过期对象，不删除活跃数据
- 模式：'worker'
- 方法：'N/A'
- 路径：'work:EXPORT_CLEANUP'
- 设置：使用恰好 10,000 个超过保留期且无活跃授权的 READY 导出，加上 1,000 个 READY 活跃控制对象；启动两个清理工作进程。
- 选择器：按 retentionUntil 然后 exportId 处理过期导出；在删除发布事务内重新检查授权活跃性。
- 请求：不发出测量的客户端请求；设置仅使用已发布的种子和公共 API，在工作进程计时器启动前完成。
- 并发数：2
- 预热秒数：0
- 测量秒数：60
- 成功标准：所有 10,000 个过期对象被删除，具有精确的 DeletionProofs，每个活跃控制对象保持字节可读，且无清理工作非终止状态。
- 阈值：清理在 <= 60 秒内完成，零活跃数据删除、缺失证明或意外失败。
- 计时器：在两个清理工作进程生成时启动，并在快照加上所有控制对象摘要的字节读取证明后置条件后停止。

固定性能种子：seedVersion perf-v1 包含恰好 100 个主体、100 个数据集修订版和 11,000 个导出：一个测量的数据集修订版单独包含所有 5,000,000 条记录，其余 99 个包含零条记录；10,000 个 READY 对象超过保留期且无活跃授权，1,000 个 READY 导出保持活跃；至少 100 个活跃导出引用一个共享的已验证的至少 64 MiB 对象，用于测量的 1 MiB 范围。

这三个场景是从全新迁移的数据库和上述精确种子独立运行的；
完成每个场景's Setup before its Timer begins. Mode 'http' means 'method' and 'path' 命名唯一的测量公共请求操作，'concurrency' 是精确的闭环客户端数量。模式
'worker' 表示方法 'N/A'，'path' 命名测量的工作种类，'concurrency' 是精确的工作进程
数量。精确使用每个场景的选择器和请求；没有推断的混合工作负载。
运行恰好 'warmupSeconds' 秒未测量时间，然后恰好 'measureSeconds' 秒测量时间或直到
计时器声明的终止条件。有状态预热和测量身份必须不相交。计数
完整的 HTTP 响应体以计算延迟。预期发布的冲突单独报告，除非
场景的成功标准和阈值明确计数它们。

基准容器有 4 个逻辑 CPU 和 8 GiB RAM；PostgreSQL 16、Chromium、两个 API 进程、
指定的工作进程和一个调度器共享该限制。每个后续兼容二进制文件必须
在不更改任何字段或阈值的情况下重新运行这三个相同场景。

意外 5xx 计数必须为零。在满足延迟或吞吐量但任何强制不变量为假的情况下
是失败的性能运行。

## 范围外

- 电子邮件投递
- 云对象存储
- 加密密钥管理
- 数据脱敏策略设计
- 跨区域复制

## 交接

保持 README 和 OpenAPI 最新。以发现优先的审查结束，并报告架构、模块和
进程所有权、公共接口、成功/失败数据流、事务和租约边界、
迁移、兼容性、运行的精确命令、测试和性能结果、恢复证据、已知
风险和每个未运行的检查。不要声称实际未执行的检查。
