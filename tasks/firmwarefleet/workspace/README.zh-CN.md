# FirmwareFleet

基于此空白仓库构建 FirmwareFleet。本 README 为完整产品契约。请勿在契约之外臆造行为。若契约未明确的产品决策，请先询问。

## 必需技术栈

- Node.js 22、TypeScript、React、PostgreSQL 16、npm 以及预装的 Chromium。
- PostgreSQL 是业务状态、幂等性、租约、事件和排序的唯一权威来源。
- 生产环境 UI 必须使用公共 HTTP API；不得依赖模拟数据、内存数据库或仅浏览器端状态来保证正确性。
- 使用整数领域数量和 UTC ISO-8601 时间戳。不得对金额、容量、序列、时长单位或守恒量使用浮点数。

## 必需的非交互式命令

| 命令 | 契约 |
| --- | --- |
| 'npm run db:migrate' | 重复且安全地应用所有版本化迁移。 |
| 'npm run db:seed -- --file <path>' | 原子化导入版本化 JSON 种子数据。 |
| 'npm run dev' | 启动开发环境 API 和 UI。 |
| 'npm run build' | 生成生产环境 API、worker、dispatcher 和 UI 资源。 |
| 'npm run start:api' | 启动一个生产环境 API/UI 进程。 |
| 'npm run start:worker' | 启动一个 Command Task worker。 |
| 'npm run start:dispatcher' | 启动 Domain Event webhook dispatcher。 |
| 'npm run test:unit' | 运行纯逻辑和边界测试。 |
| 'npm run test:integration' | 运行真实 PostgreSQL 加公共 HTTP 集成测试。 |
| 'npm run test:e2e' | 通过可见控件运行生产构建的 Chromium 测试。 |
| 'npm run test:concurrency' | 针对一个数据库运行至少两个 API 和两个 worker 进程。 |
| 'npm run test:recovery' | 使用可观察屏障、SIGKILL、重启和持久恢复。 |
| 'npm run test:all' | 从干净数据库运行上述所有非性能门禁。 |
| 'npm run test:perf' | 运行固定持续负载并验证所有负载后不变量。 |

每条命令在失败时以非零退出，清理自身子进程，且无需任何提示。

## 环境变量

| 变量 | 默认值 | 规则 |
| --- | --- | --- |
| 'DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/firmwarefleet' | 生产/开发环境权威来源。 |
| 'TEST_DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/firmwarefleet_test' | 所有有状态测试必需。 |
| 'PORT' | '3000' | 整数 1-65535；API 和生产 UI 来源。 |
| 'ADMIN_TOKEN' | 任务本地值 | 仅用于文档化的管理变更路由；切勿记录。 |
| 'WEBHOOK_URL' | 'http://127.0.0.1:4010/events' | Domain Event 投递的 HTTP 端点。 |
| 'WORK_LEASE_SECONDS' | '3' | 整数 1-60；worker 和恢复测试使用的持久化租约时长。 |
| 'CHROMIUM_PATH' | '/usr/bin/chromium' | 项目自有 E2E 使用的浏览器可执行文件。 |
| 'MANAGED_DATA_ROOT' | '/tmp/firmwarefleet-data' | 暂存或生成字节的可写根目录；切勿直接提供路径。 |
| 'TEST_BARRIER_URL' | 空 | 仅受控恢复测试使用的可选 localhost HTTP 接收器。 |
| 'TEST_BARRIER_TOKEN' | 空 | 设置 URL 时必需的屏障头值；切勿记录。 |

仅绑定到 '127.0.0.1'。日志不得包含令牌、幂等键、原始种子输入、webhook 主体或私有绝对路径。

## 领域与 V1 行为

| 术语 | 规范定义 | 避免 |
| --- | --- | --- |
| Device | 已注册的硬件单元，包含型号、引导加载程序和已安装固件版本。 | Agent、client |
| Firmware Image | 不可变字节、摘要、大小、型号兼容性和版本。 | Artifact、package |
| Firmware Campaign | 捕获的一组 Device，以单个 Firmware Image 为目标。 | Deployment、rollout |
| Device Update | 一个 Device 的持久化活动状态和当前命令序列。 | Assignment、job |
| Command Task | 针对下载、安装、验证或回滚命令的租约化投递工作。 | Message、queue |
| Device Report | 绑定到单个命令令牌的、带序列号的幂等观察。 | Heartbeat、ack |

Device Update：WAITING -> DOWNLOADING -> INSTALLING -> VERIFYING -> SUCCEEDED，任何活动状态 -> FAILED -> ROLLED_BACK，或 WAITING -> CANCELLED；Campaign：PENDING -> RUNNING -> SUCCEEDED | FAILED，或 PENDING|RUNNING -> CANCELLED。

1. 注册兼容的 Firmware Image，并从不可变 Device 选择器创建单波 Campaign。
2. 按顺序投递下载、安装和验证命令，使用稳定 ID 和 fencing 令牌。
3. 以原子有序批次接受离线 Device Report，并安全重放重复批次。
4. 在精确超时策略下恢复 Command Task，并使更新失败或回滚。
5. 在 UI 中展示固件版本、设备时间线、活动进度、失败和事件投递。

### 确定性策略

1. Firmware Image 仅适用于相同型号且已安装版本列于 compatibleFromVersions 中的情况。版本由 1..8 个点分隔组件组成，每个组件恰好为 0 或 [1-9][0-9]* 且为 JSON 安全整数，总长度 <=64；逐组件比较，缺失组件视为零。
2. Firmware Image 大小为 1..2147483648 字节；downloadPath 匹配 ^/firmware/[a-z0-9][a-z0-9._/-]{0,255}$，不包含空、点或点点段，且唯一。compatibleFromVersions 包含 1..100 个不同的规范版本，且 modelId 加 version 唯一。
3. Campaign 选择器是对精确 modelId 和标签相等性的 AND 运算。目标集按 deviceId 排序并一次性捕获；maxParallel 为 1..1000，计数非终态的活跃 Device Update。
4. 命令使用序列 1 DOWNLOAD、2 INSTALL、3 VERIFY；每个命令在创建后 reportTimeoutSeconds 过期。有效的连续 Device Report 批次可重复相同先前的报告，但不能跳过或重写序列。
5. VERIFY SUCCEEDED 必须在 installedVersion 更改前报告目标镜像摘要。超时或显式失败创建一条 ROLLBACK 命令，使用捕获的 priorVersion 元数据，并仅在终态结果时释放容量。
6. Campaign 在任何 Device Update 开始前为 PENDING，在第一个开始后且任何更新仍非终态时为 RUNNING，仅当所有目标成功时为 SUCCEEDED，当无更新活跃且至少一个为 FAILED 或 ROLLED_BACK 时为 FAILED。从 PENDING 或 RUNNING 取消会原子性地将 Campaign 设为 CANCELLED，将所有 WAITING 更新改为 CANCELLED，保留终态更新，并要求每个活跃更新完成 ROLLBACK 而不发出另一条前向命令。

## 强制不变量

1. 一个 Device 在任一时刻最多执行一个活跃 Device Update 和一个当前命令。
2. 已安装固件仅在针对确切镜像摘要和令牌的有效验证报告后更改。
3. Device Report 序列严格递增；相同的重复批次无第二次效果。
4. Campaign 目标集和 Firmware Image 创建后永不更改。
5. 回滚恰好一次返回到捕获的先前版本，且不能安装无关镜像。

这些不变量必须在成功、验证失败、未知 HTTP 结果、重复请求、并发请求、worker 或 dispatcher SIGKILL、重启、迁移和持续负载后仍然成立。

## HTTP 与 OpenAPI 3.1

在 'GET /openapi.json' 提供规范 OpenAPI，在 'GET /healthz' 提供健康检查。OpenAPI 文档与运行时行为必须一致。API 路由使用 JSON，除非明确文档化的原始内容。拒绝不支持的媒体类型返回 415 'UNSUPPORTED_MEDIA_TYPE'，格式错误的 JSON 返回 400 'MALFORMED_JSON'，未知对象键返回 400 'UNKNOWN_FIELD'，无更具体已发布代码的形状或范围违规返回 400 'INVALID_REQUEST'。语义或状态冲突使用其已发布的 409 代码。在文档化的 ADMIN_TOKEN 路由上，缺失、格式错误或不正确的 Bearer 令牌返回 401 'ADMIN_AUTH_REQUIRED'。

成功的分页集合读取返回 '{items,nextCursor}'。'limit' 默认为 50，为 1 到 100 的整数。游标顺序稳定且不透明；格式错误的游标返回 400 'INVALID_CURSOR'。类型为 'uuid' 的字段为小写 UUID 字符串；未类型化的字符串标识符保留其已发布的语法。时间戳为 UTC，带尾随 'Z'。资源缺失返回 404 'NOT_FOUND'。

错误精确使用：

~~~json
{"error":{"code":"STABLE_CODE","message":"human-readable text","details":{}}}
~~~

以下线缆表示法为规范性：'uuid' 为小写 RFC 4122 文本，'int' 为 JSON 安全整数，'timestamp' 为带毫秒精度和尾随 Z 的 UTC ISO-8601，'date' 为严格 YYYY-MM-DD，'sha256' 为 64 位小写十六进制，'currency' 为三个大写 ASCII 字母，'json' 为 RFC 8785 接受的任何值。'http-url' 为无凭据或片段的绝对 http 或 https URL。'interval' 恰好为 '{startAt:timestamp,endAt:timestamp}'，startAt 在 endAt 之前，表示半开区间 '[startAt,endAt)'。'|null' 字段为必需且可空。每个未列出的字段均被拒绝，数组保留其声明的顺序。响应精确使用这些资源形状：

- FirmwareImage = {firmwareImageId:uuid,modelId:uuid,version:string,sha256:sha256,size:int,downloadPath:string,compatibleFromVersions:[string],createdAt:timestamp}
- FirmwareCampaign = {campaignId:uuid,firmwareImageId:uuid,targetCount:int,targetDigest:sha256,maxParallel:int,reportTimeoutSeconds:int,state:PENDING|RUNNING|SUCCEEDED|FAILED|CANCELLED,createdAt:timestamp,completedAt:timestamp|null,sequence:int}
- DeviceUpdate = {deviceUpdateId:uuid,campaignId:uuid,deviceId:uuid,priorVersion:string,targetVersion:string,state:WAITING|DOWNLOADING|INSTALLING|VERIFYING|SUCCEEDED|FAILED|ROLLED_BACK|CANCELLED,currentCommandSequence:int,installedDigest:sha256|null}
- DeviceCommand = {commandId:uuid,deviceUpdateId:uuid,sequence:int,type:DOWNLOAD|INSTALL|VERIFY|ROLLBACK,imageDigest:sha256,commandToken:string,createdAt:timestamp,expiresAt:timestamp}
- DeviceCommandPollResponse = {status:COMMAND|NO_CHANGE,command:DeviceCommand|null}; 当状态为 NO_CHANGE 时，command 恰好为 null
- DeviceReport = {deviceId:uuid,deviceUpdateId:uuid,sequence:int,commandId:uuid,commandToken:string,outcome:SUCCEEDED|FAILED,installedDigest:sha256|null,reportedAt:timestamp}

公共聚合路由为：

- 'GET /api/v1/firmware-campaigns?limit&cursor' 和
  'GET /api/v1/firmware-campaigns/:campaignId'。
- POST /api/v1/firmware-campaigns，请求体为 {firmwareImageId,selector,maxParallel,reportTimeoutSeconds}；返回 202，包含 targetCount、targetDigest 以及单波次进度。
- POST /api/v1/firmware-images，请求体为 {modelId,version,sha256,size,downloadPath,compatibleFromVersions}；校验已发布的镜像边界，注册一个不可变的 FirmwareImage，并返回 201 及其精确的 FirmwareImage 主体。
- POST /api/v1/devices/:deviceId/commands/poll，请求体为 {lastCommandSequence}；返回 DeviceCommandPollResponse，包含下一个稳定命令；当不存在更大的当前命令时，返回精确的 {status:NO_CHANGE,command:null}。
- POST /api/v1/devices/:deviceId/report-batches，请求体为 {firstSequence,reports:[{sequence,commandId,commandToken,outcome,installedDigest}]}；原子性地接受一个连续批次，并返回存储的 DeviceReport 对象及服务器端 reportedAt 值。
- POST /api/v1/firmware-campaigns/:campaignId/cancel，请求体为 {reason}；应用已发布的 Campaign 取消规则，并返回精确的 CANCELLED FirmwareCampaign。
- GET /api/v1/devices/:deviceId/updates 返回 {items:[DeviceUpdate]}；GET /api/v1/firmware-campaigns/:campaignId/updates 按 deviceId 返回所有目标设备更新。
- 'GET /api/v1/domain-events?aggregateId&afterSequence&limit' 按顺序返回已提交事件。
- 'GET /api/v1/verification-snapshot' 要求 'Authorization: Bearer <ADMIN_TOKEN>'，并返回一个
  可序列化的快照 '{asOf:timestamp,resources:{...},work:[Work],events:[DomainEvent]}'。

### V1 验证快照

完整快照从单个 PostgreSQL 时间点读取；'asOf'、每个资源数组、'work'
以及 'events' 必须描述同一数据库快照。V1 'resources' 对象恰好包含以下键，
且不包含其他键：

- 'deviceModels' 使用精确形状 'DeviceModel = {modelId:uuid,name:string}'，并按标量字段路径元组 'modelId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜排序。
- 'devices' 使用精确形状 'Device = {deviceId:uuid,modelId:uuid,labels:object,installedVersion:string,installedDigest:sha256,lastReportSequence:int}'，并按标量字段路径元组 'deviceId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜排序。
- 'firmwareImages' 使用精确形状 'FirmwareImage'，并按标量字段路径元组 'firmwareImageId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜排序。
- 'firmwareCampaigns' 使用精确形状 'FirmwareCampaign'，并按标量字段路径元组 'campaignId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜排序。
- 'deviceUpdates' 使用精确形状 'DeviceUpdate'，并按标量字段路径元组 'deviceUpdateId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜排序。
- 'deviceCommands' 使用精确形状 'DeviceCommand'，并按标量字段路径元组 'deviceUpdateId'、'sequence' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜排序。
- 'deviceReports' 使用精确形状 'DeviceReport'，并按标量字段路径元组 'deviceUpdateId'、'sequence' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜排序。

每个资源数组恰好包含其声明形状所命名的每个当前或不可变实例一次。每个列出的排序路径解析为标量。标量顺序为：null 优先，然后 false 在 true 之前，整数按数值排序，其他所有字符串形式标量按 UTF-8 字节排序。按完整元组升序排序，然后仅以 RFC 8785 规范 JSON 作为决胜排序。
递归省略每个名称以 'Token' 结尾的对象字段，在所有嵌套深度上。

'Work' 恰好是
'{workId:uuid,kind:COMMAND_DELIVERY|REPORT_TIMEOUT|ROLLBACK,aggregateId:uuid,state:PENDING|LEASED|SUCCEEDED|FAILED|CANCELLED,terminal:boolean,attempt:int,leaseOwner:string|null,leaseExpiresAt:timestamp|null}'。
'kind' 恰好是 'COMMAND_DELIVERY'、'REPORT_TIMEOUT'、'ROLLBACK' 之一。两个租约字段仅在状态为 'LEASED' 时非 null，在所有其他状态下均为 null。'terminal' 仅在状态为 'SUCCEEDED'、'FAILED' 或 'CANCELLED' 时为 true；终止的 Work 被保留。
当没有匹配的 Work 具有 'terminal:false' 时，积压队列恰好被排空。'work' 数组按 workId 排序。

'events' 包含精确的域事件对象，按 aggregateId、sequence、eventId 排序。对每个事件负载应用相同的递归 '*Token' 省略。省略认证和业务围栏令牌、幂等键、原始 webhook 主体、私有文件系统路径和机密。这是外部不变量查询面。

以下域错误对于格式良好的请求是穷尽的，此外还包括上述已发布的常见错误，以及 400 'INVALID_REQUEST'、400 'INVALID_CURSOR'、404 'NOT_FOUND' 和 409 'IDEMPOTENCY_CONFLICT'：

| HTTP | 代码 | 精确触发条件 |
| ---: | --- | --- |
| 409 | FIRMWARE_INCOMPATIBLE | 设备型号或已安装版本不受支持 |
| 409 | DEVICE_UPDATE_ACTIVE | 设备已有另一个非终止更新 |
| 409 | DEVICE_REPORT_SEQUENCE_GAP | 批次不是下一个连续序列 |
| 409 | STALE_COMMAND_TOKEN | 报告与当前命令令牌不匹配 |
| 409 | INSTALLED_DIGEST_MISMATCH | VERIFY 报告了另一个摘要 |
| 409 | FIRMWARE_VERSION_EXISTS | modelId 和规范版本已标识另一个固件镜像 |
| 400 | INVALID_FIRMWARE_IMAGE | version、size、path、digest 或 compatibleFromVersions 违反已发布的边界 |

### 持久幂等性

每个变更操作都要求 'Idempotency-Key'，为 1-128 个可见 ASCII 字符。作用域为方法、规范路径和键。在确认成功之前，持久化规范语义请求指纹以及完整状态/主体。相同的重试（包括重启或未知响应丢失后）返回原始状态和语义 JSON，且无第二次效果。使用相同键但不同语义的重试返回 409 'IDEMPOTENCY_CONFLICT'。并发相同请求收敛于一个结果；进程本地映射不是权威。在基准测试期间不要使记录过期，也不要在迁移期间重写已保存的重放主体。

## 种子契约

'npm run db:seed -- --file <path>' 恰好接受：

'{schemaVersion:1,seedVersion,deviceModels,devices,firmwareImages,campaigns,deviceUpdates,commands,reports}; image digests match relative fixture bytes, versions follow the published comparator, and device/report sequences are valid.'

成员模式是精确的：

- deviceModels[] = {modelId:uuid,name:string}; devices[] = {deviceId:uuid,modelId:uuid,labels:object,installedVersion:string,installedDigest:sha256,lastReportSequence:int}
- firmwareImages[] 使用精确的 FirmwareImage 字段，外加相对于 <seed-directory>/assets 的 assetPath；字节、大小、摘要、型号和版本兼容性原子性地验证
- campaigns[]、deviceUpdates[]、commands[] 和 reports[] 使用精确的 FirmwareCampaign、DeviceUpdate、DeviceCommand 和 DeviceReport 模式，并且必须协调序列、活动容量、已安装版本和终止状态

'seedVersion' 是一个非空字符串，最多 64 个字符。导入器记录规范文件摘要。相同版本和摘要是无操作重放；相同版本但内容不同则失败，返回 'SEED_VERSION_CONFLICT'。拒绝未知键、重复 ID、缺失引用、无效状态、破坏的不变量、超出范围的整数和格式错误的时间。任何无效成员都会拒绝整个导入，而不更改业务行、任务、幂等性或域事件。

## 工作器、事件和恢复

工作器使用 'WORK_LEASE_SECONDS' 声明有界持久租约。租约所有权必须在提交结果的短事务内再次证明。在等待 HTTP、文件、时钟或其他进程时，不要持有数据库事务。过期租约可重新声明，但过期令牌无法提交。

业务状态及其域事件在一个事务中提交。事件字段为 'eventId'、'aggregateId'、正整数 'sequence'、'type'、'occurredAt'、'schemaVersion:1' 和 'payload'。必需的事件类型：`campaign.created`、`device-update.started`、`firmware.installed`、`device-update.failed`、`device-update.rolled-back`、`campaign.completed`。'payload' 对于每个 V1 事件恰好是 '{}'；后续 Manager 事件也使用 '{}'，除非其已发布契约字面上提供另一种负载形状。回滚不创建事件。序列在每个聚合内是连续的。

调度器发送包含'X-FirmwareFleet-Event-Id'和'X-FirmwareFleet-Event-Type'的JSON。网络错误、超时和非2xx响应将以有界退避无限重试。每次重试保持相同的eventId和语义体。成功投递的顺序是递增的聚合序列。至少一次投递可能重复请求；不得伪造另一个事件身份。

### 受控恢复屏障

当'TEST_BARRIER_URL'为空时，不存在屏障请求。当两个测试变量均被设置时，工作进程在继续执行'worker.claimed'、'worker.effect-complete'和'worker.before-commit'之前先进行POST；调度器在'dispatcher.response-received'处进行POST。确切的JSON为'{schemaVersion:1,processRole:worker|dispatcher,point,workId,aggregateId,attempt,leaseTokenHash}'，头部为'X-Test-Barrier-Token: <TEST_BARRIER_TOKEN>'。ID和点在重试间保持一致；leaseTokenHash是令牌的SHA-256哈希，绝不是令牌本身。204响应释放进程。保持响应使其暂停，且不打开数据库事务。连接丢失或非204响应每100毫秒以相同主体重试，直到租约丢失或进程终止。仅接受localhost URL。

## 真实用户界面

提供桌面和移动端流程，用于创建V1聚合、查看集合和详情、执行每个公开用户操作、观察异步命令任务进度、浏览事件和历史证据，以及在刷新后恢复。展示加载、空、验证、冲突、过期、离线/重试、终止和权限错误状态。使用可见的语义控件、键盘导航、关联标签、焦点管理和WCAG AA对比度。绝不允许通过开发者工具或直接API调用来完成主要流程。

## 项目自有验证

- 单元测试覆盖确定性策略、状态转换、规范化和边界值。
- 集成测试启动真实的PostgreSQL和真实HTTP进程；绝不调用内部服务。
- 浏览器端到端测试使用生产构建、真实Chromium、真实API/数据库/工作进程以及可见控件。
- 并发测试使用至少两个API进程和两个工作进程，针对一个PostgreSQL数据库。
- 恢复测试使用公开的仅测试屏障，在SIGKILL之前观察声明/提交或接收方/ACK边界；随机睡眠不是故障控制。
- 性能测试在以下固定间隔内运行生产构建，报告p50/p95/p99、吞吐量、成功变更、预期冲突、意外5xx、积压排空和加载后不变量。

固定的V1兼容性能场景：

### 场景'device-command-poll'

- 目标：每秒提供3,000次命令轮询，p95 <= 80毫秒
- 模式：'http'
- 方法：'POST'
- 路径：'/api/v1/devices/:deviceId/commands/poll'
- 设置：所有100,000台设备各有一条当前命令。一半的轮询目标报告前一个序列，一半报告当前序列；轮询不消耗命令。
- 选择器：从按字节排序的独立列表中交替选择COMMAND和NO_CHANGE设备ID。
- 请求：{lastCommandSequence}；COMMAND使用current-1，NO_CHANGE使用current。
- 并发数：64
- 预热秒数：10
- 测量秒数：60
- 成功：仅计算200个精确轮询响应；每个完整的100请求块恰好为50个COMMAND和50个NO_CHANGE，且命令令牌绝不跨设备ID。
- 阈值：60秒内至少每秒3,000次成功轮询，且p95 <= 80毫秒；意外5xx = 0。
- 计时器：吞吐量窗口从预热后的第一个测量请求开始；每个延迟样本从请求发送到完整响应体结束。

### 场景'device-report-batch'

- 目标：每秒摄入2,000份设备报告，p95 <= 200毫秒
- 模式：'http'
- 方法：'POST'
- 路径：'/api/v1/devices/:deviceId/report-batches'
- 设置：预留70,000条设备命令：10,000条唯一报告用于预热，60,000条用于测量。每个请求恰好包含一份报告。
- 选择器：重复一个新的单报告批次，然后是其精确的幂等重放。每100份唯一报告中，90份为SUCCEEDED，10份为FAILED。
- 请求：{firstSequence,reports:[{sequence,commandId,commandToken,outcome,installedDigest}]}；重放重用键和主体。
- 并发数：64
- 预热秒数：10
- 测量秒数：60
- 成功：首次原子存储批次或精确重放计数；不接受部分批次、序列间隙或跨命令令牌。
- 阈值：60秒内至少每秒2,000次成功的单报告批次响应，且p95 <= 200毫秒；恰好一半请求为重放。
- 计时器：吞吐量窗口从预热后的第一个测量请求开始；每个延迟样本从请求发送到完整响应体结束。

### 场景'command-recovery'

- 目标：重启后180秒内恢复并排空100,000个待处理命令任务
- 模式：'worker'
- 方法：'N/A'
- 路径：'work:COMMAND_DELIVERY'
- 设置：恰好100,000台设备各有一条待处理的COMMAND_DELIVERY工作。将两个工作进程保持在worker.claimed，SIGKILL，等待租约过期，然后启动两个替代进程。
- 选择器：按campaignId、deviceId、命令序列顺序处理，同时尊重每个Campaign的maxParallel限制。
- 请求：不发出测量的客户端请求；设置仅使用已发布的种子和公开API，在工作进程计时器启动之前。
- 并发数：2
- 预热秒数：0
- 测量秒数：180
- 成功：每条选定命令以单一身份持久可轮询，无COMMAND_DELIVERY工作保持非终止状态，且Campaign活动计数绝不超出maxParallel。
- 阈值：替代进程生成后180秒内所有100,000条待处理命令排空；过期提交和意外失败计数为零。
- 计时器：在两个替代进程生成时启动，仅在快照加上代表性轮询响应证明所有后置条件后停止。

固定性能种子：seedVersion perf-v1恰好包含100个deviceModels、100,000台设备、500个firmwareImages、100个campaigns、100,000个deviceUpdates、100,000条当前命令和零报告；每台设备离线且恰好有一条当前命令和一个待处理命令任务。

三个场景是从新迁移的数据库和上述精确种子独立运行的；完成每个场景's Setup before its Timer begins. Mode 'http' means '方法' and '路径'命名唯一测量的公开请求操作，'concurrency'是精确的闭环客户端数量。模式'worker'表示方法'N/A'，'path'命名测量的工作种类，'concurrency'是精确的工作进程数量。精确使用每个场景的选择器和请求；不存在推断的混合工作负载。精确运行'warmupSeconds'秒未测量时间，然后精确运行'measureSeconds'秒测量时间或直到计时器声明的终止条件。有状态预热和测量身份必须不相交。延迟计数完整的HTTP响应体。预期发布的冲突单独报告，除非场景的成功和阈值明确计数它们。

基准容器有4个逻辑CPU和8 GiB RAM；PostgreSQL 16、Chromium、两个API进程、指定的工作进程和一个调度器共享该限制。每个后续兼容二进制必须在不更改任何字段或阈值的情况下重新运行这三个相同场景。

意外5xx计数必须为零。在任一强制不变量为假时满足延迟或吞吐量是失败的性能运行。

## 范围外

- 二进制增量生成
- 设备认证
- CDN
- 硬件证明
- 点对点更新

## 交接

保持README和OpenAPI最新。以发现优先的审查结束，并报告架构、模块和进程所有权、公开接口、成功/失败数据流、事务和租约边界、迁移、兼容性、运行的精确命令、测试和性能结果、恢复证据、已知风险以及每个未运行的检查。不要声称实际未执行的检查。
