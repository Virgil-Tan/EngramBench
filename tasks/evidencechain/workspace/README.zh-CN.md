# EvidenceChain

从本空白仓库构建 EvidenceChain。本 README 是完整的产品合同。请勿在合同之外发明行为。在做出合同未明确规定的产品决策之前，请先询问。

## 必需技术栈

- Node.js 22、TypeScript、React、PostgreSQL 16、npm 以及预装的 Chromium。
- PostgreSQL 是业务状态、幂等性、租约、事件和排序的唯一权威来源。
- 生产环境 UI 必须使用公共 HTTP API；不得使用模拟、内存数据库或仅浏览器状态来提供正确性。
- 使用整数领域数量和 UTC ISO-8601 时间戳。不得对金额、容量、序列、持续时间单位或守恒量使用浮点数。

## 必需的非交互式命令

| 命令 | 合同 |
| --- | --- |
| 'npm run db:migrate' | 重复且安全地应用所有版本化迁移。 |
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

每个命令在失败时以非零退出，清理其自身的子进程，并且不需要任何提示。

## 环境

| 变量 | 默认值 | 规则 |
| --- | --- | --- |
| 'DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/evidencechain' | 生产/开发权威。 |
| 'TEST_DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/evidencechain_test' | 所有有状态测试必需。 |
| 'PORT' | '3000' | 整数 1-65535；API 和生产 UI 来源。 |
| 'ADMIN_TOKEN' | 任务本地值 | 仅文档化的管理变更路由需要；切勿记录。 |
| 'WEBHOOK_URL' | 'http://127.0.0.1:4010/events' | 领域事件投递的 HTTP 端点。 |
| 'WORK_LEASE_SECONDS' | '3' | 整数 1-60；worker 和恢复测试使用的持久化租约时长。 |
| 'CHROMIUM_PATH' | '/usr/bin/chromium' | 项目自有 E2E 的浏览器可执行文件。 |
| 'MANAGED_DATA_ROOT' | '/tmp/evidencechain-data' | 暂存或生成字节的可写根目录；切勿直接提供路径。 |
| 'TEST_BARRIER_URL' | 空 | 仅受控恢复测试使用的可选 localhost HTTP 接收器。 |
| 'TEST_BARRIER_TOKEN' | 空 | 设置 URL 时必需的屏障头值；切勿记录。 |

仅绑定到 '127.0.0.1'。日志不得包含令牌、幂等键、原始种子输入、webhook 主体或私有绝对路径。

## 领域和 V1 行为

| 术语 | 规范定义 | 避免 |
| --- | --- | --- |
| 案件清单 | 一个案件预期收集项的不可变列表。 | 检查表、订单 |
| 收集项 | 案件清单预期的一个唯一标记的证据项。 | 样本、对象 |
| 入库扫描 | 来自一个扫描仪批次的不可变观察标签、封条、时间戳和设施。 | 读数、上传 |
| 保管匹配 | V1 中预期收集项与入库扫描之间确认的关联。 | 链接、配对 |
| 保管转移 | 由恰好一个当前保管人接受的不可变移交。 | 移动、状态 |
| 验证任务 | 检查封条、标签和清单规则的持久化租约工作。 | 作业、检查 |

收集项：预期 -> 已接收 -> 已验证 | 已隔离；保管匹配：已提议 -> 已确认 | 已反转。

1. 原子化导入扫描仪批次，并对间歇性连接设备的扫描进行持久化去重。
2. 使用精确发布的标签和封条规则建议并确认一对一保管匹配。
3. 运行可恢复的验证任务并隔离失败，而不丢失原始观察。
4. 使用比较并设置当前保管人和不可变移交历史来转移保管权。
5. 通过真实的协调器 UI 流程暴露缺失、未匹配、已隔离和保管时间线。

### 确定性策略

1. 设备批次序列是正整数连续整数。具有相同 deviceId、sequence 和规范摘要的重放返回原始批次；间隙或不同摘要被原子化拒绝。
2. 建议候选要求精确区分大小写的标签相等。精确封条相等排名第一；封条不匹配可被提议为第二，但验证确定性地将其隔离。
3. 按 caseId、expectedLabel、collectedItemId 处理未匹配的收集项，按 scannedAt、deviceId、scanId 处理扫描；每个快照中的每个成员只能使用一次。
4. 确认分配接收设施的已配置保管人。转移要求 fromCustodianId 等于 currentCustodianId，且 occurredAt 不早于上次接受的转移。
5. 保管匹配反转仅在收集项保持已接收、未提交验证结果且未接受保管转移时，从已确认状态合法。它原子化地将项恢复为预期并将入库扫描恢复为未匹配，清除项的入库和保管人字段，围栏待处理的验证工作，并发出 custody-match.reversed。

## 强制不变量

1. 一个入库扫描最多在一个保管匹配中处于活动状态。
2. 一个收集项在 V1 中最多在一个保管匹配中处于活动状态。
3. 在任一时刻恰好一个保管人拥有一个已接收项，且每次接受的转移都链接到前一次。
4. 一个扫描仪批次要么被完全接受，要么不留下扫描、任务、匹配或事件。
5. 验证永远不会改变不可变的观察标签、封条、设备序列或 scannedAt。

这些不变量必须在成功、验证失败、未知 HTTP 结果、重复请求、并发请求、worker 或 dispatcher SIGKILL、重启、迁移和持续负载之后仍然成立。

## HTTP 和 OpenAPI 3.1

在 'GET /openapi.json' 提供规范 OpenAPI，在 'GET /healthz' 提供健康检查。OpenAPI 文档和运行时行为必须一致。API 路由使用 JSON，除非明确记录的原始内容。拒绝不支持的媒体类型返回 415 'UNSUPPORTED_MEDIA_TYPE'，格式错误的 JSON 返回 400 'MALFORMED_JSON'，未知对象键返回 400 'UNKNOWN_FIELD'，没有更具体发布代码的形状或范围违规返回 400 'INVALID_REQUEST'。语义或状态冲突使用其发布的 409 代码。在文档化的 ADMIN_TOKEN 路由上，缺失、格式错误或不正确的 Bearer 令牌返回 401 'ADMIN_AUTH_REQUIRED'。

成功的分页集合读取返回 '{items,nextCursor}'。'limit' 默认为 50，是 1 到 100 的整数。游标顺序稳定且不透明；格式错误的游标返回 400 'INVALID_CURSOR'。类型为 'uuid' 的字段是小写 UUID 字符串；未类型化的字符串标识符保留其发布的语法。时间戳是 UTC，带尾随 'Z'。资源缺失返回 404 'NOT_FOUND'。

错误精确使用：

~~~json
{"error":{"code":"STABLE_CODE","message":"human-readable text","details":{}}}
~~~

以下线符号是规范性的：'uuid' 是小写 RFC 4122 文本，'int' 是 JSON 安全整数，'timestamp' 是带毫秒精度和尾随 Z 的 UTC ISO-8601，'date' 是严格的 YYYY-MM-DD，'sha256' 是 64 位小写十六进制，'currency' 是三个大写 ASCII 字母，'json' 是 RFC 8785 接受的任何值。'http-url' 是不带凭据或片段的绝对 http 或 https URL。'interval' 恰好是 '{startAt:timestamp,endAt:timestamp}'，startAt 在 endAt 之前，表示半开区间 '[startAt,endAt)'。'|null' 字段是必需且可空的。每个未列出的字段都被拒绝，数组保持其声明的顺序。响应精确使用这些资源形状：

- IntakeScan = {intakeScanId:uuid,scanId:string,deviceId:uuid,batchSequence:int,label:string,sealCode:string,scannedAt:timestamp,facilityId:uuid,state:UNMATCHED|MATCHED,revision:int}
- CollectedItem = {collectedItemId:uuid,caseId:uuid,expectedLabel:string,expectedSealCode:string,quantity:int,state:EXPECTED|RECEIVED|VERIFIED|QUARANTINED,currentCustodianId:uuid|null,intakeScanId:uuid|null,revision:int,sequence:int}; quantity 为正安全整数
- CustodyMatch = {matchId:uuid,collectedItemId:uuid,intakeScanId:uuid,state:PROPOSED|CONFIRMED|REVERSED,createdAt:timestamp,confirmedAt:timestamp|null,reversedAt:timestamp|null}
- CustodyTransfer = {transferId:uuid,collectedItemId:uuid,fromCustodianId:uuid,toCustodianId:uuid,occurredAt:timestamp,acceptedAt:timestamp,priorTransferId:uuid|null}
- EvidenceTimelineItem = {sequence:int,type:MATCH_CONFIRMED|MATCH_REVERSED|ITEM_VERIFIED|ITEM_QUARANTINED|CUSTODY_TRANSFERRED,occurredAt:timestamp,matchId:uuid|null,transferId:uuid|null,fromCustodianId:uuid|null,toCustodianId:uuid|null}; 每个字段均为必填，matchId 仅对 MATCH 事件非空，transferId 及两个保管人 ID 仅对 CUSTODY_TRANSFERRED 非空，occurredAt 为 Match 转换时间、验证完成时间或 CustodyTransfer.acceptedAt，sequence 为已提交的 Collected Item 转换序列

公共聚合路由为：

- 'GET /api/v1/custody-matches?limit&cursor' 和
  'GET /api/v1/custody-matches/:matchId'。
- POST /api/v1/intake-batches，请求体为 {deviceId,batchSequence,scans:[{scanId,label,sealCode,scannedAt,facilityId}]}；返回 202 及稳定 ID，或拒绝整个批次。
- POST /api/v1/custody-matches，请求体为 {collectedItemId,intakeScanId}，创建 PROPOSED 匹配。
- POST /api/v1/custody-matches/:matchId/confirm，请求体为 {expectedItemRevision,expectedScanRevision}，原子性地预留两者。
- POST /api/v1/custody-matches/:matchId/reverse，请求体为 {reason}，原子性地恢复两个成员并返回 REVERSED，或返回 409 CUSTODY_MATCH_NOT_REVERSIBLE。
- POST /api/v1/collected-items/:itemId/transfers，请求体为 {fromCustodianId,toCustodianId,occurredAt}，要求当前保管人。
- GET /api/v1/collected-items/:itemId/timeline 返回 {item:CollectedItem,items:[EvidenceTimelineItem]}；items 中每个已提交的 Item 转换恰好对应一条记录，按 sequence 升序排列且无重复 sequence。
- 'GET /api/v1/domain-events?aggregateId&afterSequence&limit' 按顺序返回已提交事件。
- 'GET /api/v1/verification-snapshot' 要求 'Authorization: Bearer <ADMIN_TOKEN>' 并返回一个
  可序列化快照 '{asOf:timestamp,resources:{...},work:[Work],events:[DomainEvent]}'。

### V1 验证快照

完整快照从单个 PostgreSQL 时间点读取；'asOf'、每个资源数组、'work'
和 'events' 必须描述同一数据库快照。V1 'resources' 对象恰好包含以下键
且无其他键：

- 'cases' 使用精确形状 'Case = {caseId:uuid,caseNumber:string}'，并按标量字段路径元组 'caseId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜排序。
- 'caseManifests' 使用精确形状 'CaseManifest = {caseId:uuid,version:int,items:[{collectedItemId:uuid,expectedLabel:string,expectedSealCode:string,quantity:int}]}'，并按标量字段路径元组 'caseId'、'version' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜排序。
- 'facilities' 使用精确形状 'Facility = {facilityId:uuid,name:string,receivingCustodianId:uuid}'，并按标量字段路径元组 'facilityId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜排序。
- 'custodians' 使用精确形状 'Custodian = {custodianId:uuid,name:string}'，并按标量字段路径元组 'custodianId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜排序。
- 'deviceRegistrations' 使用精确形状 'DeviceRegistration = {deviceId:uuid,facilityId:uuid,lastBatchSequence:int}'，并按标量字段路径元组 'deviceId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜排序。
- 'intakeScans' 使用精确形状 'IntakeScan'，并按标量字段路径元组 'intakeScanId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜排序。
- 'collectedItems' 使用精确形状 'CollectedItem'，并按标量字段路径元组 'collectedItemId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜排序。
- 'custodyMatches' 使用精确形状 'CustodyMatch'，并按标量字段路径元组 'matchId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜排序。
- 'custodyTransfers' 使用精确形状 'CustodyTransfer'，并按标量字段路径元组 'transferId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜排序。

每个资源数组恰好包含其声明形状所命名的每个当前或不可变实例一次。每个列出的排序路径解析为标量。标量顺序为 null 优先，然后 false 在 true 之前，整数按数值排序，其他所有字符串形式标量按 UTF-8 字节排序。按完整元组升序排序，然后仅以 RFC 8785 规范 JSON 作为决胜排序。
递归省略每个名称以 'Token' 结尾的对象字段，在所有嵌套深度。

'Work' 恰好是
'{workId:uuid,kind:EVIDENCE_VERIFICATION,aggregateId:uuid,state:PENDING|LEASED|SUCCEEDED|FAILED|CANCELLED,terminal:boolean,attempt:int,leaseOwner:string|null,leaseExpiresAt:timestamp|null}'。
'kind' 恰好是 'EVIDENCE_VERIFICATION' 之一。两个租约字段仅在
状态为 'LEASED' 时非空，在其他所有状态下均为 null。'terminal' 仅在状态为
'SUCCEEDED'、'FAILED' 或 'CANCELLED' 时为 true；终止的 Work 被保留。
当没有匹配的 Work 具有 'terminal:false' 时，积压队列恰好被排空。'work' 数组按
workId 排序。

'events' 包含精确的领域事件对象，按 aggregateId、然后 sequence、然后 eventId 排序。对每个事件负载应用相同的递归 '*Token' 省略。省略认证和业务围栏令牌、幂等键、原始 webhook 主体、私有文件系统路径和机密。这是外部不变量查询表面。

以下领域错误对于格式良好的请求是穷尽的，除上述已发布的常见错误外，还包括 400 'INVALID_REQUEST'、400 'INVALID_CURSOR'、404 'NOT_FOUND' 和 409
'IDEMPOTENCY_CONFLICT'：

| HTTP | 代码 | 精确触发条件 |
| ---: | --- | --- |
| 409 | DEVICE_SEQUENCE_GAP | batchSequence 不是下一个值 |
| 409 | INTAKE_BATCH_CONFLICT | 重放的设备序列具有另一个摘要 |
| 409 | CUSTODY_MATCH_CONFLICT | Item 或 Scan 修订已更改或已匹配 |
| 409 | CUSTODY_MATCH_NOT_REVERSIBLE | Match 不是 CONFIRMED、Item 不是 RECEIVED、验证结果已提交或存在 Custody Transfer |
| 409 | CUSTODIAN_CHANGED | fromCustodianId 不再是当前保管人 |
| 400 | INVALID_INTAKE_BATCH | 批次成员、标签、封条、设施或时间无效 |

### 持久幂等性

每个变更操作要求 'Idempotency-Key'，1-128 个可见 ASCII 字符。作用域为方法、规范
路径和键。在确认成功之前持久化规范语义请求
指纹和完整状态/主体。相同的重试（包括重启或未知响应丢失后）返回原始状态和语义 JSON，且无第二次
效果。使用相同键但不同语义返回 409 'IDEMPOTENCY_CONFLICT'。并发相同
请求收敛于一个结果；进程本地映射不是权威。在基准测试期间不要过期记录，或在迁移期间重写已保存的重放主体。

## 种子契约

'npm run db:seed -- --file <path>' 恰好接受：

'{schemaVersion:1,seedVersion,cases,caseManifests,facilities,custodians,deviceRegistrations,intakeScans,custodyMatches,transfers}; history arrays may be empty, expected labels are unique per Case, device IDs and starting sequences are unique, and references exist.'

成员模式是精确的：

- cases[] = {caseId:uuid,caseNumber:string}; caseManifests[] = {caseId:uuid,version:int,items:[{collectedItemId:uuid,expectedLabel:string,expectedSealCode:string,quantity:int}]}; quantity 为正安全整数
- facilities[] = {facilityId:uuid,name:string,receivingCustodianId:uuid}; custodians[] = {custodianId:uuid,name:string}
- deviceRegistrations[] = {deviceId:uuid,facilityId:uuid,lastBatchSequence:int}; intakeScans[]、custodyMatches[] 和 transfers[] 使用精确的线上模式，可以为空，否则形成有效链

'seedVersion' 是非空字符串，最多 64 个字符。导入器记录规范文件摘要。
相同版本和摘要是无操作重放；相同版本但内容不同则失败并返回
'SEED_VERSION_CONFLICT'。拒绝未知键、重复 ID、缺失引用、无效状态、破坏的
不变量、超出范围的整数和格式错误的时间。任何无效成员拒绝整个导入，
而不更改业务行、任务、幂等性或领域事件。

## 工作器、事件和恢复

工作器使用 'WORK_LEASE_SECONDS' 声明有界持久租约。租约所有权必须在提交结果的短事务内再次证明。
在等待 HTTP、文件、时钟或其他进程时不要持有数据库事务。过期租约可重新声明，但过期令牌不能提交。

业务状态及其领域事件在一个事务中提交。事件字段为 'eventId'、'aggregateId'、
正整数 'sequence'、'type'、'occurredAt'、'schemaVersion:1' 和 'payload'。必需事件类型：
`intake-batch.accepted`、`custody-match.confirmed`、`item.verified`、`item.quarantined`、`custody.transferred`、`custody-match.reversed`。'payload' 对于每个 V1 事件恰好是 '{}'；后续 Manager 事件也使用 '{}'，除非
其发布的契约字面上提供另一个负载形状。回滚不创建事件。序列
按聚合连续。

调度器发送包含'X-EvidenceChain-Event-Id'和'X-EvidenceChain-Event-Type'的JSON。网络错误、超时和非2xx响应会以有界退避无限重试。每次重试保持相同的eventId和语义主体。成功投递的顺序是递增的聚合序列。至少一次投递可能会重复请求；它不得编造另一个事件身份。

### 受控恢复屏障

当'TEST_BARRIER_URL'为空时，不存在屏障请求。当两个测试变量都设置时，工作进程在继续之前于'worker.claimed'、'worker.effect-complete'和'worker.before-commit'处POST；调度器在'dispatcher.response-received'处发布。确切的JSON是'{schemaVersion:1,processRole:worker|dispatcher,point,workId,aggregateId,attempt,leaseTokenHash}'，头部是'X-Test-Barrier-Token: <TEST_BARRIER_TOKEN>'。ID和点在重试之间保持相同；leaseTokenHash是令牌的SHA-256哈希，绝不是令牌本身。204响应释放进程。持有响应会暂停进程，且不打开数据库事务。连接丢失或非204响应每100毫秒以相同主体重试，直到租约丢失或进程终止。仅接受localhost URL。

## 真实用户界面

提供用于创建V1聚合、查看集合和详情、执行每个公开用户操作、观察异步验证任务进度、浏览事件和历史证据以及在刷新后恢复的桌面和移动端流程。展示加载、空、验证、冲突、过期、离线/重试、终止和权限错误状态。使用可见的语义控件、键盘导航、关联标签、焦点管理和WCAG AA对比度。绝不允许通过开发者工具或直接API调用来完成主要流程。

## 项目自有验证

- 单元测试覆盖确定性策略、状态转换、规范化和边界值。
- 集成测试启动真实的PostgreSQL和真实的HTTP进程；它们绝不调用内部服务。
- 浏览器端到端测试使用生产构建、真实Chromium、真实API/数据库/工作进程以及可见控件。
- 并发测试使用至少两个API进程和两个工作进程，针对一个PostgreSQL数据库。
- 恢复测试使用公开的仅测试屏障，在SIGKILL之前观察声明/提交或接收方/ACK边界；随机睡眠不是故障控制。
- 性能测试对以下固定间隔运行生产构建，报告p50/p95/p99、吞吐量、成功变更、预期冲突、意外5xx、积压排空和加载后不变量。

固定的V1兼容性能场景：

### 场景'scanner-batch-ingest'

- 目标：以p95 <= 350毫秒摄取100个扫描仪批次/秒
- 模式：'http'
- 方法：'POST'
- 路径：'/api/v1/intake-batches'
- 设置：准备独立的预热和测量的设备序列范围。每个批次恰好有20次扫描；九个批次是新的，然后一个是对前一批次的精确幂等重放。
- 选择器：按字节轮询deviceId，同时保持每个设备的batchSequence严格递增；scanId由设备和序列确定性生成。
- 请求：{deviceId,batchSequence,scans:[{scanId,label,sealCode,scannedAt,facilityId} x20]}；重放使用原始键和主体。
- 并发：64
- 预热秒数：10
- 测量秒数：60
- 成功：新的原子202或字节相同的重放计数；每十个请求恰好存在180个新的IntakeScan，且部分批次绝不存在。
- 阈值：60秒内至少100个完整成功的批次响应/秒，且p95 <= 350毫秒；意外5xx = 0。
- 计时器：吞吐量窗口从预热后的第一个测量请求开始；每个延迟样本从请求分发到完整响应主体结束。

### 场景'custody-timeline-read'

- 目标：以p95 <= 180毫秒提供200次保管时间线读取/秒
- 模式：'http'
- 方法：'GET'
- 路径：'/api/v1/collected-items/:itemId/timeline'
- 设置：使用所有已收集项目，至少有一个种子时间线事实；读取不改变保管状态。
- 选择器：按字节轮询collectedItemId值。
- 请求：无主体或查询参数。
- 并发：64
- 预热秒数：10
- 测量秒数：60
- 成功：仅200个具有精确项目形状和连续EvidenceTimelineItem序列计数的响应。
- 阈值：60秒内至少200次成功读取/秒，且p95 <= 180毫秒；意外5xx = 0。
- 计时器：吞吐量窗口从预热后的第一个测量请求开始；每个延迟样本从请求分发到完整响应主体结束。

### 场景'verification-recovery'

- 目标：在工作进程恢复后60秒内验证10,000次扫描
- 模式：'worker'
- 方法：'N/A'
- 路径：'work:EVIDENCE_VERIFICATION'
- 设置：恰好10,000个匹配的IntakeScan具有待处理的验证工作。将两个工作进程保持在worker.claimed，SIGKILL，等待租约过期，然后启动两个替代进程。
- 选择器：按提交的匹配顺序验证，并最多更新每个已收集项目一次。
- 请求：不发出测量的客户端请求；设置仅使用已发布的种子和公共API，在工作进程计时器开始之前。
- 并发：2
- 预热秒数：0
- 测量秒数：60
- 成功：所有10,000个选定项目恰好达到VERIFIED一次，没有工作保持非终止状态，且保管身份保持独占。
- 阈值：所有10,000个工作记录在替代进程生成后<= 60秒内变为终止；过期提交和意外失败为零。
- 计时器：在两个替代进程生成时开始，仅在证明排空工作和每个协调不变量的快照时停止。

固定性能种子：seedVersion perf-v1恰好包含100个案例、100个caseManifests，总计10,000个已收集项目、10个设施、10个保管人、100个设备注册、10,000个intakeScans、10,000个CONFIRMED custodyMatches和50,000次转移；每个匹配的扫描标签和sealCode与其已收集项目的expectedLabel和expectedSealCode完全匹配，且所有10,000个匹配的扫描具有待处理的验证任务。

三个场景是从新迁移的数据库和上述精确种子独立运行；完成每个场景's Setup before its Timer begins. Mode 'http' means '方法' and '路径'命名唯一测量的公共请求操作，'concurrency'是精确的闭环客户端数量。模式'worker'表示方法'N/A'，'path'命名测量的工作种类，'concurrency'是精确的工作进程数量。精确使用每个场景的选择器和请求；没有推断的混合工作负载。精确运行'warmupSeconds'未测量的秒数，然后精确运行'measureSeconds'测量的秒数，或直到计时器声明的终止条件。有状态预热和测量身份必须不相交。计数完整的HTTP响应主体以计算延迟。预期发布的冲突单独报告，除非场景的成功和阈值明确计数它们。

基准容器有4个逻辑CPU和8 GiB RAM；PostgreSQL 16、Chromium、两个API进程、指定的工作进程和一个调度器共享该限制。每个后续兼容二进制必须在不更改任何字段或阈值的情况下重新运行这三个相同场景。

意外5xx计数必须为零。在满足延迟或吞吐量但任何强制不变量为假的情况下，性能运行失败。

## 范围外

- 生物识别数据
- 实验室分析
- 法院备案
- 图像识别
- GPS跟踪

## 交接

保持README和OpenAPI最新。以发现优先的审查结束，并报告架构、模块和进程所有权、公共接口、成功/失败数据流、事务和租约边界、迁移、兼容性、运行的确切命令、测试和性能结果、恢复证据、已知风险以及每个未运行的检查。不要声称实际未执行的检查。
