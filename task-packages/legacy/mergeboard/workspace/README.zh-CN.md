# MergeBoard

基于此有意留空的仓库构建 MergeBoard。本 README 是完整的产品契约。请勿在契约之外臆造行为。若契约未明确的产品决策，须先询问。

## 必需技术栈

- Node.js 22、TypeScript、React、PostgreSQL 16、npm 以及预装的 Chromium。
- PostgreSQL 是业务状态、幂等性、租约、事件和排序的唯一权威来源。
- 生产环境 UI 必须使用公共 HTTP API；不得依赖模拟数据、内存数据库或仅浏览器端状态来保证正确性。
- 使用整数领域数量和 UTC ISO-8601 时间戳。不得对金额、容量、序号、时长单位或守恒量使用浮点数。

## 必需的非交互式命令

| 命令 | 契约 |
| --- | --- |
| 'npm run db:migrate' | 重复且安全地应用所有版本化迁移。 |
| 'npm run db:seed -- --file <path>' | 原子化导入版本化 JSON 种子数据。 |
| 'npm run dev' | 启动开发环境 API 和 UI。 |
| 'npm run build' | 生成生产环境 API、worker、dispatcher 和 UI 资源。 |
| 'npm run start:api' | 启动一个生产环境 API/UI 进程。 |
| 'npm run start:worker' | 启动一个 Snapshot Task worker。 |
| 'npm run start:dispatcher' | 启动 Domain Event webhook dispatcher。 |
| 'npm run test:unit' | 运行纯逻辑和边界测试。 |
| 'npm run test:integration' | 运行真实 PostgreSQL 加公共 HTTP 集成测试。 |
| 'npm run test:e2e' | 通过可见控件运行生产构建的 Chromium 测试。 |
| 'npm run test:concurrency' | 针对一个数据库运行至少两个 API 和两个 worker 进程。 |
| 'npm run test:recovery' | 使用可观察屏障、SIGKILL、重启和持久恢复。 |
| 'npm run test:all' | 从干净数据库运行上述所有非性能门禁。 |
| 'npm run test:perf' | 运行固定持续负载并验证所有负载后不变量。 |

每个命令失败时以非零状态退出，清理自身子进程，且无需任何提示。

## 环境变量

| 变量 | 默认值 | 规则 |
| --- | --- | --- |
| 'DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/mergeboard' | 生产/开发环境权威。 |
| 'TEST_DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/mergeboard_test' | 所有有状态测试必需。 |
| 'PORT' | '3000' | 整数 1-65535；API 和生产 UI 来源。 |
| 'ADMIN_TOKEN' | 任务本地值 | 仅文档化的管理员变更路由需要；切勿记录。 |
| 'WEBHOOK_URL' | 'http://127.0.0.1:4010/events' | Domain Event 投递的 HTTP 端点。 |
| 'WORK_LEASE_SECONDS' | '3' | 整数 1-60；worker 和恢复测试使用的持久租约时长。 |
| 'CHROMIUM_PATH' | '/usr/bin/chromium' | 项目自有 E2E 使用的浏览器可执行文件。 |
| 'MANAGED_DATA_ROOT' | '/tmp/mergeboard-data' | 暂存或生成字节的可写根目录；切勿直接提供路径。 |
| 'TEST_BARRIER_URL' | 空 | 仅受控恢复测试使用的可选 localhost HTTP 接收器。 |
| 'TEST_BARRIER_TOKEN' | 空 | 设置 URL 时必需的屏障头值；切勿记录。 |

仅绑定到 '127.0.0.1'。日志不得包含令牌、幂等键、原始种子输入、webhook 请求体或私有绝对路径。

## 领域与 V1 行为

| 术语 | 规范定义 | 避免使用 |
| --- | --- | --- |
| Document | 在 V1 中具有一个头修订版的稳定有序块集合。 | 文件、页面 |
| Revision | 由 documentId 和整数修订号标识的不可变规范 Document 状态。 | 版本、保存 |
| Change | 客户端针对一个 baseRevision 编写的按序排列的块操作列表。 | 补丁、编辑 |
| Conflict | 对 Change 无法安全应用于当前头状态的确定性解释。 | 错误、合并 |
| Snapshot Task | 将操作前缀压缩为已验证 Snapshot 的持久租约工作。 | 作业、备份 |
| Client Sequence | 每个客户端单调递增的数字，用于离线重放。 | 幂等键、时间戳 |

Change：PENDING -> APPLIED | CONFLICTED | REJECTED；Document 修订版不可变且严格递增。

1. 创建 Document，并以乐观 baseRevision 应用精确的块插入、替换、移动和删除 Change。
2. 跨实例和重启，按 document、client 和 Client Sequence 对离线 Change 去重。
3. 确定性重定基非重叠 Change，并为重叠编辑持久化显式 Conflict。
4. 异步生成和验证 Snapshot，同时修订版读取在 worker 死亡期间保持一致。
5. 在真实 UI 中提供编辑、离线重放、修订历史、差异、冲突和事件投递。

### 确定性策略

1. Document 标题包含 1..120 个 Unicode 标量值，初始块包含 0..1000 个成员且 blockId 唯一；创建产生不可变修订版 0 及其规范摘要。
2. Change 包含按数组顺序应用的 1..100 个操作。clientSequence 从 1 开始，且必须恰好是该 documentId、clientId 的下一个值；相同的前序序列重放，内容不同则冲突。
3. 在 head=baseRevision 时，INSERT_AFTER 需要现有锚点或 null 起始以及未使用的 blockId；REPLACE/DELETE 需要精确的 expectedText；MOVE 需要两个 ID 不同、存在且当前前驱等于 expectedAfterBlockId。
4. 当 head 已推进时，仅当这些相同前置条件在当前 head 中仍然成立，重定基才能逐操作成功。任何失败都会按 operationIndex 顺序记录所有确定性 Conflict，且不应用该 Change 的任何部分。
5. 共享锚点的并发 INSERT_AFTER 操作按其提交修订号、operationIndex、blockId 排序。修订摘要为 RFC 8785 {documentId,revision,blocks} 的 SHA-256。
6. DocumentDiff 按字节序检查块 ID 的并集。仅 from 或仅 to 的 Block 发出 DELETE 或 INSERT；共享 Block 在文本不同时发出 REPLACE，然后在其零基索引不同时发出 MOVE。条目按 blockId 排序，REPLACE 在 MOVE 之前，可空索引/文本字段精确描述两个选定修订版。

## 强制不变量

1. Document 修订号连续，每个应用的 Change 恰好创建一个下一个修订版。
2. 一个客户端序列映射到一个语义 Change，并永远返回稳定响应。
3. 重放同一已接受 Change 不得重复、丢失或重排块。
4. Snapshot 摘要等于重放其精确操作前缀获得的规范状态。
5. 冲突或拒绝的 Change 不得改变头状态或发出 document.changed。

这些不变量必须在成功、验证失败、未知 HTTP 结果、重复请求、并发请求、worker 或 dispatcher SIGKILL、重启、迁移和持续负载之后仍然成立。

## HTTP 与 OpenAPI 3.1

在 'GET /openapi.json' 提供规范 OpenAPI，在 'GET /healthz' 提供健康检查。OpenAPI 文档与运行时行为必须一致。API 路由使用 JSON，除非明确文档化的原始内容。对不支持的媒体类型返回 415 'UNSUPPORTED_MEDIA_TYPE'，格式错误的 JSON 返回 400 'MALFORMED_JSON'，未知对象键返回 400 'UNKNOWN_FIELD'，形状或范围违规且无更具体的已发布代码时返回 400 'INVALID_REQUEST'。语义或状态冲突使用其已发布的 409 代码。在文档化的 ADMIN_TOKEN 路由上，缺失、格式错误或不正确的 Bearer 令牌返回 401 'ADMIN_AUTH_REQUIRED'。

成功的分页集合读取返回 '{items,nextCursor}'。'limit' 默认为 50，为 1 到 100 的整数。游标顺序稳定且不透明；格式错误的游标返回 400 'INVALID_CURSOR'。类型为 'uuid' 的字段为小写 UUID 字符串；未类型化的字符串标识符保留其已发布的语法。时间戳为 UTC，带尾随 'Z'。资源未命中返回 404 'NOT_FOUND'。

错误精确使用：

~~~json
{"error":{"code":"STABLE_CODE","message":"human-readable text","details":{}}}
~~~

以下线符号为规范：'uuid' 为小写 RFC 4122 文本，'int' 为 JSON 安全整数，'timestamp' 为带毫秒精度和尾随 Z 的 UTC ISO-8601，'date' 为严格 YYYY-MM-DD，'sha256' 为 64 位小写十六进制，'currency' 为三个大写 ASCII 字母，'json' 为 RFC 8785 接受的任何值。'http-url' 为不带凭据或片段的绝对 http 或 https URL。'interval' 恰好为 '{startAt:timestamp,endAt:timestamp}'，startAt 在 endAt 之前，表示半开区间 '[startAt,endAt)'。'|null' 字段为必需且可空。每个未列出的字段均被拒绝，数组保持其声明的顺序。响应精确使用这些资源形状：

- Block = {blockId:uuid,text:string}; text 为 UTF-8 编码，包含 0 到 10000 个 Unicode 标量值
- Operation = {op:INSERT_AFTER,afterBlockId:uuid|null,block:Block}|{op:REPLACE,blockId:uuid,expectedText:string,newText:string}|{op:MOVE_AFTER,blockId:uuid,afterBlockId:uuid|null,expectedAfterBlockId:uuid|null}|{op:DELETE,blockId:uuid,expectedText:string}
- Document = {documentId:uuid,title:string,headRevision:int,blocks:[Block],canonicalDigest:sha256,createdAt:timestamp,sequence:int}
- Change = {changeId:uuid,documentId:uuid,clientId:uuid,clientSequence:int,baseRevision:int,operations:[Operation],state:APPLIED|CONFLICTED|REJECTED,revision:int|null,conflicts:[Conflict],createdAt:timestamp}
- Conflict = {conflictId:uuid,changeId:uuid,operationIndex:int,code:TARGET_MISSING|TARGET_CHANGED|ANCHOR_MISSING|BLOCK_ID_EXISTS|MOVE_BASE_CHANGED,path:string,baseValue:string|null,headValue:string|null}
- DocumentRevision = {documentId:uuid,revision:int,blocks:[Block],changeId:uuid|null,canonicalDigest:sha256,createdAt:timestamp}
- DocumentDiff = {documentId:uuid,fromRevision:int,toRevision:int,items:[{blockId:uuid,kind:DELETE|INSERT|REPLACE|MOVE,fromIndex:int|null,toIndex:int|null,fromText:string|null,toText:string|null}]}

公共聚合路由为：

- 'GET /api/v1/documents?limit&cursor' 和
  'GET /api/v1/documents/:documentId'。
- POST /api/v1/documents/:documentId/changes，请求体为 {clientId,clientSequence,baseRevision,operations}；返回 201 APPLIED 及 revision 和规范化操作，或返回 409 CHANGE_CONFLICT 及确定性冲突详情。
- POST /api/v1/documents，请求体为 {title,blocks:[Block]}，返回 201 Document（revision 为 0）并发出 document.created 事件。
- POST /api/v1/documents/:documentId/conflicts/:conflictId/resolve，请求体为 {expectedHeadRevision,resolutionOperations}，解决该 Conflict 所属的 Change，并创建一个正常的下一 revision。
- GET /api/v1/documents/:documentId/revisions/:revision 返回规范化块及快照/操作来源信息。
- GET /api/v1/documents/:documentId/diff?fromRevision&toRevision 返回精确的确定性 DocumentDiff。
- GET /api/v1/documents/:documentId/changes?limit&cursor 按 createdAt 后 changeId 的顺序返回精确的 Change 对象。
- 'GET /api/v1/domain-events?aggregateId&afterSequence&limit' 按顺序返回已提交事件。
- 'GET /api/v1/verification-snapshot' 需要 'Authorization: Bearer <ADMIN_TOKEN>'，并返回一个
  可序列化的快照 '{asOf:timestamp,resources:{...},work:[Work],events:[DomainEvent]}'。

### V1 验证快照

完整快照从单个 PostgreSQL 时间点读取；'asOf'、每个资源数组、'work'
和 'events' 必须描述同一数据库快照。V1 'resources' 对象恰好包含以下键，
且不包含其他键：

- 'documents' 使用精确形状 'Document'，并按标量字段路径元组 'documentId' 升序排序，然后以 RFC 8785 规范化 JSON 作为决胜条件。
- 'documentRevisions' 使用精确形状 'DocumentRevision'，并按标量字段路径元组 'documentId'、'revision' 升序排序，然后以 RFC 8785 规范化 JSON 作为决胜条件。
- 'changes' 使用精确形状 'Change'，并按标量字段路径元组 'documentId'、'changeId' 升序排序，然后以 RFC 8785 规范化 JSON 作为决胜条件。
- 'conflicts' 使用精确形状 'Conflict'，并按标量字段路径元组 'changeId'、'operationIndex'、'conflictId' 升序排序，然后以 RFC 8785 规范化 JSON 作为决胜条件。
- 'documentSnapshots' 使用精确形状 'DocumentSnapshot = {documentId:uuid,revision:int,canonicalDigest:sha256,createdAt:timestamp}'，并按标量字段路径元组 'documentId'、'revision' 升序排序，然后以 RFC 8785 规范化 JSON 作为决胜条件。

每个资源数组恰好包含其声明形状所指定的每个当前或不可变实例一次。每个列出的排序路径解析为标量。标量顺序为：null 优先，然后 false 在 true 之前，整数按数值排序，其他所有字符串形式标量按 UTF-8 字节排序。按完整元组升序排序，然后仅以 RFC 8785 规范化 JSON 作为决胜条件。
递归省略名称以 'Token' 结尾的每个对象字段，在所有嵌套深度。

'Work' 恰好是
'{workId:uuid,kind:SNAPSHOT_COMPACTION,aggregateId:uuid,state:PENDING|LEASED|SUCCEEDED|FAILED|CANCELLED,terminal:boolean,attempt:int,leaseOwner:string|null,leaseExpiresAt:timestamp|null}'。
'kind' 恰好是 'SNAPSHOT_COMPACTION' 之一。两个租约字段仅在状态为
'LEASED' 时非空，在所有其他状态下均为 null。'terminal' 仅在状态为
'SUCCEEDED'、'FAILED' 或 'CANCELLED' 时为 true；终止的 Work 被保留。
当没有匹配的 Work 具有 'terminal:false' 时，积压队列被排空。'work' 数组按
workId 排序。

'events' 包含精确的领域事件对象，按 aggregateId、sequence、eventId 排序。对每个事件负载应用
相同的递归 '*Token' 省略。省略认证和业务防护令牌、幂等键、原始 webhook 主体、私有文件系统路径和机密。这是
外部不变量查询面。

以下领域错误对于格式良好的请求是穷尽的，除上述常见错误外，还包括 400 'INVALID_REQUEST'、400 'INVALID_CURSOR'、404 'NOT_FOUND' 和 409
'IDEMPOTENCY_CONFLICT'：

| HTTP | 代码 | 精确触发条件 |
| ---: | --- | --- |
| 400 | INVALID_DOCUMENT | 标题、初始块数量、块 ID 唯一性或块文本无效 |
| 409 | CLIENT_SEQUENCE_GAP | clientSequence 大于下一个期望值 |
| 409 | CLIENT_SEQUENCE_CONFLICT | 先前序列具有不同的语义内容 |
| 409 | CHANGE_CONFLICT | 一个或多个操作前置条件在当前头部失败 |
| 409 | HEAD_REVISION_CHANGED | 冲突解决的 expectedHeadRevision 已过期 |
| 400 | INVALID_OPERATION | 操作形状、基数、ID 或文本无效 |

### 持久幂等性

每个变更都需要 'Idempotency-Key'，1-128 个可见 ASCII 字符。作用域为方法、规范化
路径和键。在确认成功之前，持久化规范化语义请求
指纹和完整状态/响应体。相同的重试，包括
在重启或未知响应丢失后，返回原始状态和语义 JSON，且无第二次
效果。使用不同语义重用键返回 409 'IDEMPOTENCY_CONFLICT'。并发相同
请求收敛于一个结果；进程本地映射不是权威。在基准测试期间不要
过期记录，或在迁移期间重写保存的重放响应体。

## 种子契约

'npm run db:seed -- --file <path>' 恰好接受：

'{schemaVersion:1,seedVersion,documents,changes,snapshots}; block IDs are unique per Document, seeded revisions are contiguous, client sequences are increasing, and replayed canonical digests must match.'

成员模式是精确的：

- documents[] = {documentId:uuid,title:string,initialBlocks:[Block],createdAt:timestamp}
- changes[] 使用精确的 Change 字段和操作；种子化的已应用 Change 必须重放为连续 revision，冲突的 Change 必须具有 null revision
- snapshots[] = {documentId:uuid,revision:int,canonicalDigest:sha256,assetPath:string}; assetPath 是 <seed-directory>/assets 下的非符号链接相对文件，包含该 revision 的 {documentId,revision,blocks} 的精确 UTF-8 RFC 8785 字节，canonicalDigest 是这些精确字节的 SHA-256

'seedVersion' 是一个非空字符串，最多 64 个字符。导入器记录规范化文件摘要。
相同版本和摘要是无操作重放；相同版本但内容不同则失败，返回
'SEED_VERSION_CONFLICT'。拒绝未知键、重复 ID、缺失引用、无效状态、破坏的
不变量、超出范围的整数和格式错误的时间。任何无效成员拒绝整个导入，
而不更改业务行、任务、幂等性或领域事件。

## 工作进程、事件和恢复

工作进程使用 'WORK_LEASE_SECONDS' 声明有界持久租约。租约所有权必须在
提交结果的短事务内再次证明。在等待
HTTP、文件、时钟或其他进程时，不要持有数据库事务。过期租约可重新声明，但过期令牌不能提交。

业务状态及其领域事件在一个事务中提交。事件字段为 'eventId'、'aggregateId'、
正整数 'sequence'、'type'、'occurredAt'、'schemaVersion:1' 和 'payload'。必需事件类型：
`document.created`、`document.changed`、`change.conflicted`、`conflict.resolved`、`snapshot.created`。'payload' 对于每个 V1 事件恰好是 '{}'；后续 Manager 事件也使用 '{}'，除非
其发布的契约字面提供另一个负载形状。回滚不创建事件。序列
每个聚合是连续的。

调度器发送 JSON，包含 'X-MergeBoard-Event-Id' 和 'X-MergeBoard-Event-Type'。网络错误、
超时和非 2xx 响应以有界退避无限重试。每次重试保持相同的
eventId 和语义主体。成功投递顺序是递增的聚合序列。至少一次
投递可能重复请求；它不得发明另一个事件身份。

### 受控恢复屏障

当 'TEST_BARRIER_URL' 为空时，不存在屏障请求。当两个测试变量都设置时，工作进程
在 'worker.claimed'、'worker.effect-complete' 和 'worker.before-commit' 处继续之前 POST；调度器在 'dispatcher.response-received' 处 POST。精确 JSON 为
'{schemaVersion:1,processRole:worker|dispatcher,point,workId,aggregateId,attempt,leaseTokenHash}'，头为
'X-Test-Barrier-Token: <TEST_BARRIER_TOKEN>'。ID 和点在重试间保持相同；
leaseTokenHash 是令牌的 SHA-256，绝不是令牌。204 响应释放进程。保持
响应暂停进程，而不打开数据库事务。连接丢失或非 204 每
100 毫秒重试，使用相同主体，直到租约丢失或进程终止。仅接受 localhost URL。

## 真实 UI

提供桌面端和移动端流程，用于创建V1聚合、查看集合和详情、执行每个公开用户操作、观察异步快照任务进度、浏览事件和历史证据，以及在刷新后恢复。展示加载、空、验证、冲突、过期、离线/重试、终止和权限错误状态。使用可见的语义控件、键盘导航、关联标签、焦点管理和WCAG AA对比度。绝不允许使用开发者工具或直接API调用来完成主流程。

## 项目自有验证

- 单元测试覆盖确定性策略、状态转换、规范化和边界值。
- 集成测试启动真实的PostgreSQL和真实的HTTP进程；它们绝不调用内部服务。
- 浏览器端到端测试使用生产构建、真实Chromium、真实API/数据库/工作进程以及可见控件。
- 并发测试使用至少两个API进程和两个工作进程，针对一个PostgreSQL数据库。
- 恢复测试使用公开的仅测试屏障，在SIGKILL之前观察声明/提交或接收方/ACK边界；随机睡眠不是故障控制。
- 性能测试对以下固定间隔运行生产构建，报告p50/p95/p99、吞吐量、成功变更、预期冲突、意外5xx、积压排空和加载后不变量。

固定的V1兼容性能场景：

### 场景 'non-overlapping-change-apply'

- 目标：以p95 <= 250毫秒应用300个非重叠变更/秒
- 模式：'http'
- 方法：'POST'
- 路径：'/api/v1/documents/:documentId/changes'
- 设置：使用不相交的预热和测量文档集，每个文档集至少有一个专用块。每个文档最多保持一个进行中的变更。
- 选择器：按字节轮询documentId；clientSequence和baseRevision从该文档的前一个成功响应推进。
- 请求：每个变更一个REPLACE操作，针对专用块，具有精确的expectedText和确定性的64 ASCII字节newText；使用新密钥。
- 并发数：64
- 预热秒数：10
- 测量秒数：60
- 成功：仅计算201 APPLIED响应；每个响应创建一个无间隙修订，具有预期的canonicalDigest且无冲突。
- 阈值：至少300个成功变更/秒持续60秒，且p95 <= 250毫秒；冲突、修订间隙和意外5xx为零。
- 计时器：吞吐量窗口从预热后的第一个测量请求开始；每个延迟样本从请求分派到完整响应体结束。

### 场景 'document-revision-read'

- 目标：以p95 <= 120毫秒提供400次修订读取/秒
- 模式：'http'
- 方法：'GET'
- 路径：'/api/v1/documents/:documentId/revisions/:revision'
- 设置：使用所有种子化的DocumentRevision身份；读取不触发压缩。
- 选择器：按字节/数字顺序轮询documentId，然后轮询revision。
- 请求：无请求体或查询参数。
- 并发数：64
- 预热秒数：10
- 测量秒数：60
- 成功：仅计算200响应，其块重新计算发布的canonicalDigest和来源计数。
- 阈值：至少400次成功读取/秒持续60秒，且p95 <= 120毫秒；摘要不匹配和意外5xx计数为零。
- 计时器：吞吐量窗口从预热后的第一个测量请求开始；每个延迟样本从请求分派到完整响应体结束。

### 场景 'snapshot-compaction-recovery'

- 目标：恢复后120秒内将1,000,000个操作压缩为已验证的快照
- 模式：'worker'
- 方法：'N/A'
- 路径：'work:SNAPSHOT_COMPACTION'
- 设置：恰好10,000个文档各有一个待处理的压缩工作，每个文档覆盖恰好100个已应用的单操作变更，总计1,000,000个操作。将两个工作进程保持在worker.claimed，SIGKILL，等待租约过期，然后启动两个替换进程。
- 选择器：按documentId压缩，并包括通过工作捕获的修订的变更，而不删除操作历史。
- 请求：不发出测量的客户端请求；设置仅使用发布的种子和公共API，在工作进程计时器开始之前。
- 并发数：2
- 预热秒数：0
- 测量秒数：120
- 成功：恰好10,000个已验证的DocumentSnapshot覆盖所有1,000,000个操作，没有工作保持非终止状态，重放等于每个快照摘要，且过期工作进程无法发布。
- 阈值：压缩在替换进程生成后<= 120秒内完成，零缺失操作、摘要不匹配、过期提交或意外失败。
- 计时器：在两个替换进程生成时开始，仅在快照文件、数据库快照行和完整重放验证证明每个后置条件后停止。

固定性能种子：seedVersion perf-v1包含恰好10,000个文档、1,000,000个已应用的变更（每个一个操作）和零快照；每个文档恰好一个待处理的快照任务覆盖所有1,000,000个操作。

三个场景是从新迁移的数据库和上述精确种子独立运行；完成每个场景's Setup before its Timer begins. Mode 'http' means '方法' and '路径'命名唯一测量的公共请求操作，'concurrency'是精确的闭环客户端数量。模式'worker'表示方法'N/A'，'path'命名测量的工作种类，'concurrency'是精确的工作进程数量。精确使用每个场景的选择器和请求；没有推断的混合工作负载。精确运行'warmupSeconds'未测量秒数，然后精确运行'measureSeconds'测量秒数或直到计时器声明的终止条件。有状态预热和测量身份必须不相交。计算完整的HTTP响应体以获取延迟。预期发布的冲突单独报告，除非场景的成功和阈值明确计数它们。

基准容器有4个逻辑CPU和8 GiB RAM；PostgreSQL 16、Chromium、两个API进程、指定的工作进程和一个调度器共享该限制。每个后续兼容二进制必须重新运行这三个相同场景，而不更改任何字段或阈值。

意外5xx计数必须为零。在满足延迟或吞吐量但任何强制不变量为假的情况下，性能运行失败。

## 范围外

- 富文本渲染
- 存在性光标
- 实时套接字
- 二进制附件
- 访问控制

## 交接

保持README和OpenAPI最新。以发现优先的审查结束，并报告架构、模块和进程所有权、公共接口、成功/失败数据流、事务和租约边界、迁移、兼容性、运行的精确命令、测试和性能结果、恢复证据、已知风险以及每个未运行的检查。不要声称实际未执行的检查。
