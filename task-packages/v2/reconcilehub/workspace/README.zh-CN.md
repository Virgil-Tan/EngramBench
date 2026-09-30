# ReconcileHub

基于此空白仓库构建 ReconcileHub。本 README 为完整产品契约。请勿在契约之外臆造行为。若契约未明确的产品决策，须先征询。

## 必需技术栈

- Node.js 22、TypeScript、React、PostgreSQL 16、npm 及预装 Chromium。
- PostgreSQL 是业务状态、幂等性、租约、事件与排序的唯一权威来源。
- 生产环境 UI 必须使用公共 HTTP API；不得以模拟、内存数据库或浏览器端状态提供正确性。
- 使用整数领域数量与 UTC ISO-8601 时间戳。不得对金额、容量、序列、时长单位或守恒量使用浮点数。

## 必需的非交互命令

| 命令 | 契约 |
| --- | --- |
| 'npm run db:migrate' | 反复且安全地应用所有版本化迁移。 |
| 'npm run db:seed -- --file <path>' | 原子化导入版本化 JSON 种子数据。 |
| 'npm run dev' | 启动开发环境 API 与 UI。 |
| 'npm run build' | 生成生产环境 API、worker、dispatcher 及 UI 构建产物。 |
| 'npm run start:api' | 启动单个生产环境 API/UI 进程。 |
| 'npm run start:worker' | 启动单个建议任务 worker。 |
| 'npm run start:dispatcher' | 启动领域事件 webhook dispatcher。 |
| 'npm run test:unit' | 运行纯逻辑与边界测试。 |
| 'npm run test:integration' | 运行真实 PostgreSQL 加公共 HTTP 集成测试。 |
| 'npm run test:e2e' | 通过可见控件运行生产构建 Chromium 测试。 |
| 'npm run test:concurrency' | 针对同一数据库运行至少两个 API 与两个 worker 进程。 |
| 'npm run test:recovery' | 使用可观察屏障、SIGKILL、重启及持久恢复。 |
| 'npm run test:all' | 从干净数据库运行上述所有非性能门禁。 |
| 'npm run test:perf' | 运行固定持续负载并验证所有负载后不变量。 |

每条命令失败时以非零退出，清理自身子进程，且无需任何提示。

## 环境变量

| 变量 | 默认值 | 规则 |
| --- | --- | --- |
| 'DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/reconcilehub' | 生产/开发环境权威来源。 |
| 'TEST_DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/reconcilehub_test' | 所有有状态测试必需。 |
| 'PORT' | '3000' | 整数 1-65535；API 与生产 UI 来源。 |
| 'ADMIN_TOKEN' | 任务本地值 | 仅文档化的管理变更路由需要；切勿记录。 |
| 'WEBHOOK_URL' | 'http://127.0.0.1:4010/events' | 领域事件投递的 HTTP 端点。 |
| 'WORK_LEASE_SECONDS' | '3' | 整数 1-60；worker 与恢复测试使用的持久租约时长。 |
| 'CHROMIUM_PATH' | '/usr/bin/chromium' | 项目自有 E2E 的浏览器可执行文件。 |
| 'MANAGED_DATA_ROOT' | '/tmp/reconcilehub-data' | 暂存或生成字节的可写根目录；切勿直接提供路径。 |
| 'TEST_BARRIER_URL' | 空 | 仅受控恢复测试使用的可选 localhost HTTP 接收器。 |
| 'TEST_BARRIER_TOKEN' | 空 | 设置 URL 时必需的屏障头值；切勿记录。 |

仅绑定到 '127.0.0.1'。日志不得包含令牌、幂等键、原始种子输入、webhook 请求体或私有绝对路径。

## 领域与 V1 行为

| 术语 | 规范定义 | 避免 |
| --- | --- | --- |
| 语句批次 | 外部语句行的单一版本化原子导入。 | 文件、上传 |
| 语句行 | 来自语句批次的不可变日期金额与引用。 | 交易、行 |
| 分类账条目 | 可用于对账的不可变内部金额。 | 付款、过账 |
| 匹配 | V1 中一条语句行与一个分类账条目之间的一对一关联。 | 链接、映射 |
| 建议任务 | 对合格的一对一候选进行排序的持久租约工作。 | 作业、模型 |
| 冲销 | 释放已确认匹配双方的可审计转换。 | 删除、取消匹配 |

语句行：UNMATCHED -> MATCHED | IGNORED；匹配：PROPOSED -> CONFIRMED | REJECTED | REVERSED。

1. 以持久文件摘要重放原子化导入确定性语句批次。
2. 仅使用已发布的精确规则生成确定性一对一匹配建议。
3. 在两个 API 实例间以安全竞态确认、拒绝、忽略或冲销决策。
4. 保留不可变金额、决策与审计历史，并投递领域事件。
5. 在 UI 中展示批次状态、未匹配工作队列、并排审查及对账总计。

### 确定性策略

1. currency 为三个大写字母，amountMinor 为非零安全整数，reference 为去除首尾空白的区分大小写 UTF-8 字符串（最长 120 字符），bookedAt/postedAt 为严格 ISO 日期。
2. 建议候选要求币种与金额相等，且绝对日期距离 <= 3 天。得分为 1000 减去 dateDistanceDays * 100，引用完全相等再加 50。
3. 对于每条 UNMATCHED 语句行，按 bookedAt、externalId、statementLineId 顺序，对未使用分类账条目按得分降序、postedAt、ledgerEntryId 排序，仅建议第一名；单个建议任务快照不得复用成员。
4. 确认通过比较并设置（compare-and-set）双方修订号。拒绝仅对 PROPOSED 匹配合法，且不改变任一成员。忽略仅对 UNMATCHED 语句行合法；冲销已确认匹配将双方恢复为 UNMATCHED 并递增各自修订号。

## 强制不变量

1. 已确认语句行至多属于一个活动匹配。
2. 已确认分类账条目至多属于一个活动匹配。
3. 每个已确认 V1 匹配双方币种与金额相等。
4. 批次导入为全有或全无，相同摘要重放相同 ID 与响应。
5. 冲销恰好恢复双方一次，且绝不删除审计历史。

这些不变量必须在成功、校验失败、未知 HTTP 结果、重复请求、并发请求、worker 或 dispatcher 被 SIGKILL、重启、迁移及持续负载后仍然成立。

## HTTP 与 OpenAPI 3.1

在 'GET /openapi.json' 提供规范 OpenAPI，在 'GET /healthz' 提供健康检查。OpenAPI 文档与运行时行为必须一致。API 路由使用 JSON，除非明确文档化的原始内容。对不支持的媒体类型返回 415 'UNSUPPORTED_MEDIA_TYPE'，对格式错误的 JSON 返回 400 'MALFORMED_JSON'，对未知对象键返回 400 'UNKNOWN_FIELD'，对无更具体已发布代码的形状或范围违规返回 400 'INVALID_REQUEST'。语义或状态冲突使用其已发布的 409 代码。在文档化的 ADMIN_TOKEN 路由上，缺失、格式错误或不正确的 Bearer 令牌返回 401 'ADMIN_AUTH_REQUIRED'。

成功的分页集合读取返回 '{items,nextCursor}'。'limit' 默认为 50，为 1 至 100 的整数。游标顺序稳定且不透明；格式错误的游标返回 400 'INVALID_CURSOR'。类型为 'uuid' 的字段为小写 UUID 字符串；未类型化的字符串标识符保留其已发布语法。时间戳为 UTC 且以 'Z' 结尾。资源缺失返回 404 'NOT_FOUND'。

错误精确使用：

~~~json
{"error":{"code":"STABLE_CODE","message":"human-readable text","details":{}}}
~~~

以下线格式为规范：'uuid' 为小写 RFC 4122 文本，'int' 为 JSON 安全整数，'timestamp' 为带毫秒精度及尾部 Z 的 UTC ISO-8601，'date' 为严格 YYYY-MM-DD，'sha256' 为 64 位小写十六进制，'currency' 为三个大写 ASCII 字母，'json' 为 RFC 8785 接受的任意值。'http-url' 为不带凭据或片段的绝对 http 或 https URL。'interval' 精确为 '{startAt:timestamp,endAt:timestamp}'，startAt 早于 endAt，表示半开区间 '[startAt,endAt)'。'|null' 字段为必需且可空。所有未列出的字段均被拒绝，数组保持其声明顺序。响应精确使用以下资源形状：

- StatementLine = {statementLineId:uuid,batchId:uuid,externalId:string,bookedAt:date,currency:currency,amountMinor:int,reference:string,state:UNMATCHED|MATCHED|IGNORED,revision:int}
- LedgerEntry = {ledgerEntryId:uuid,postedAt:date,currency:currency,amountMinor:int,reference:string,state:UNMATCHED|MATCHED,revision:int}
- Match = {matchId:uuid,statementLineId:uuid,ledgerEntryId:uuid,state:PROPOSED|CONFIRMED|REJECTED|REVERSED,score:int,reasons:[string],createdAt:timestamp,confirmedAt:timestamp|null,reversedAt:timestamp|null,sequence:int}
- StatementBatch = {batchId:uuid,source:string,batchKey:string,digest:sha256,state:IMPORTED,lineCount:int,createdAt:timestamp}

公共聚合路由为：

- 'GET /api/v1/matches?limit&cursor' 和
  'GET /api/v1/matches/:matchId'。
- POST /api/v1/statement-batches，请求体为 {source,batchKey,lines:[{externalId,bookedAt,currency,amountMinor,reference}]}；返回 202，包含稳定的行 ID 和原子持久化重放。
- POST /api/v1/matches，请求体为 {statementLineId,ledgerEntryId}，返回 201 PROPOSED 或精确的冲突代码。
- POST /api/v1/matches/:matchId/confirm，请求体为 {expectedLineRevision,expectedLedgerRevision}，原子性获胜，否则返回 409 MATCH_CONFLICT。
- POST /api/v1/matches/:matchId/reject，请求体为 {reason}，仅从 PROPOSED 状态返回 REJECTED，否则返回 409 MATCH_NOT_REJECTABLE。
- POST /api/v1/matches/:matchId/reverse，请求体为 {reason}，释放双方并保留历史记录。
- POST /api/v1/statement-lines/:statementLineId/ignore，请求体为 {expectedRevision,reason}，仅从 UNMATCHED 状态返回 IGNORED，否则返回 409 STATEMENT_LINE_NOT_IGNORABLE。
- GET /api/v1/reconciliation-work?state=UNMATCHED&limit&cursor 返回 {statementLines:[StatementLine],ledgerEntries:[LedgerEntry],suggestions:[Match],nextCursor}。
- 'GET /api/v1/domain-events?aggregateId&afterSequence&limit' 按顺序返回已提交的事件。
- 'GET /api/v1/verification-snapshot' 需要 'Authorization: Bearer <ADMIN_TOKEN>'，并返回一个
  可序列化的快照 '{asOf:timestamp,resources:{...},work:[Work],events:[DomainEvent]}'。

### V1 验证快照

完整快照从单个 PostgreSQL 时间点读取；'asOf'、每个资源数组、'work'
和 'events' 必须描述同一数据库快照。V1 'resources' 对象恰好包含以下键，
且不包含其他键：

- 'statementBatches' 使用精确形状 'StatementBatch'，并按标量字段路径元组 'batchId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。
- 'statementLines' 使用精确形状 'StatementLine'，并按标量字段路径元组 'statementLineId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。
- 'ledgerEntries' 使用精确形状 'LedgerEntry'，并按标量字段路径元组 'ledgerEntryId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。
- 'matches' 使用精确形状 'Match'，并按标量字段路径元组 'matchId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。

每个资源数组恰好包含其声明形状所命名的每个当前或不可变实例一次。每个列出的排序路径解析为标量。标量顺序为 null 优先，然后 false 在 true 之前，整数按数值排序，其他所有字符串形式标量按 UTF-8 字节排序。按完整元组升序排序，然后仅以 RFC 8785 规范 JSON 作为决胜条件。
递归省略每个名称以 'Token' 结尾的对象字段，在所有嵌套深度。

'Work' 恰好是
'{workId:uuid,kind:MATCH_SUGGESTION,aggregateId:uuid,state:PENDING|LEASED|SUCCEEDED|FAILED|CANCELLED,terminal:boolean,attempt:int,leaseOwner:string|null,leaseExpiresAt:timestamp|null}'。
'kind' 恰好是 'MATCH_SUGGESTION' 之一。两个租约字段仅在状态为
'LEASED' 时非空，在所有其他状态下均为 null。'terminal' 仅在状态为
'SUCCEEDED'、'FAILED' 或 'CANCELLED' 时为 true；终止的 Work 被保留。
当没有匹配的 Work 具有 'terminal:false' 时，积压被完全排空。'work' 数组按
workId 排序。

'events' 包含精确的领域事件对象，按 aggregateId、sequence、eventId 排序。对每个事件负载应用相同的递归 '*Token' 省略。省略认证和业务防护令牌、幂等键、原始 webhook 主体、私有文件系统路径和机密。这是外部不变量查询面。

以下领域错误对于格式良好的请求是穷尽的，除了上述发布的常见错误以及 400 'INVALID_REQUEST'、400 'INVALID_CURSOR'、404 'NOT_FOUND' 和 409
'IDEMPOTENCY_CONFLICT'：

| HTTP | 代码 | 精确触发条件 |
| ---: | --- | --- |
| 409 | BATCH_DIGEST_CONFLICT | source 加 batchKey 已存在且具有另一个规范摘要 |
| 409 | MATCH_AMOUNT_MISMATCH | 成员在货币或金额上不同 |
| 409 | MATCH_CONFLICT | 成员修订已更改或已处于活动匹配状态 |
| 409 | MATCH_NOT_REJECTABLE | Match 不是 PROPOSED |
| 409 | MATCH_NOT_REVERSIBLE | Match 不是 CONFIRMED |
| 409 | STATEMENT_LINE_NOT_IGNORABLE | Statement Line 不是 UNMATCHED |
| 400 | INVALID_STATEMENT_BATCH | 成员 ID、日期、货币、金额或重复项无效 |

### 持久化幂等性

每个变更操作都需要 'Idempotency-Key'，1-128 个可见 ASCII 字符。作用域为方法、规范
路径和键。在确认成功之前，持久化规范语义请求
指纹和完整状态/主体。相同的重试，包括重启或未知响应丢失后，返回原始状态和语义 JSON，且无第二次效果。使用不同语义重用键返回 409 'IDEMPOTENCY_CONFLICT'。并发相同请求
收敛于一个结果；进程本地映射不是权威。在基准测试期间不要过期记录，或在迁移期间重写保存的重放主体。

## 种子契约

'npm run db:seed -- --file <path>' 恰好接受：

'{schemaVersion:1,seedVersion,ledgerEntries,statementBatches,matches}; currencies use three uppercase letters, amounts are non-zero integers, external IDs are unique per source, and imports reference no hidden state.'

成员模式是精确的：

- ledgerEntries[] 使用精确的 LedgerEntry 模式，并以修订版本 1 开始
- statementBatches[] = {batchId:uuid,source:string,batchKey:string,digest:sha256,createdAt:timestamp,lines:[StatementLine without batchId and revision]}
- matches[] 使用精确的 Match 模式；已确认的活动成员必须唯一，且其 StatementLine 和 LedgerEntry 状态必须一致

'seedVersion' 是一个非空字符串，最多 64 个字符。导入器记录规范文件摘要。
相同版本和摘要是无操作重放；相同版本但内容不同则失败，返回
'SEED_VERSION_CONFLICT'。拒绝未知键、重复 ID、缺失引用、无效状态、破坏的
不变量、超出范围的整数和格式错误的时间。任何无效成员拒绝整个导入，
而不更改业务行、任务、幂等性或领域事件。

## 工作进程、事件和恢复

工作进程使用 'WORK_LEASE_SECONDS' 声明有界持久化租约。租约所有权必须在提交结果的短事务内再次证明。在等待 HTTP、文件、时钟或其他进程时，不要持有数据库事务。过期租约可重新声明，但过期令牌不能提交。

业务状态及其领域事件在一个事务中提交。事件字段为 'eventId'、'aggregateId'、
正整数 'sequence'、'type'、'occurredAt'、'schemaVersion:1' 和 'payload'。必需的事件类型：
`statement-batch.imported`、`match.proposed`、`match.confirmed`、`match.rejected`、`match.reversed`、`statement-line.ignored`。'payload' 对于每个 V1 事件恰好是 '{}'；后续 Manager 事件也使用 '{}'，除非
其发布的契约字面提供另一个负载形状。回滚不创建事件。序列
每个聚合是连续的。

调度器发送 JSON，包含 'X-ReconcileHub-Event-Id' 和 'X-ReconcileHub-Event-Type'。网络错误、
超时和非 2xx 响应以有界退避无限重试。每次重试保持相同的
eventId 和语义主体。成功投递顺序是递增的聚合序列。至少一次
投递可能重复请求；不得发明另一个事件身份。

### 受控恢复屏障

当 'TEST_BARRIER_URL' 为空时，不存在屏障请求。当两个测试变量都设置时，工作进程
在继续之前 POST，位于 'worker.claimed'、'worker.effect-complete' 和 'worker.before-commit'；调度器在 'dispatcher.response-received' 发布。精确 JSON 是
'{schemaVersion:1,processRole:worker|dispatcher,point,workId,aggregateId,attempt,leaseTokenHash}'，头是 'X-Test-Barrier-Token: <TEST_BARRIER_TOKEN>'。ID 和点在重试之间保持相同；
leaseTokenHash 是令牌的 SHA-256，绝不是令牌。204 响应释放进程。保持
响应暂停进程，而不打开数据库事务。连接丢失或非 204 每
100 毫秒重试，使用相同主体，直到租约丢失或进程终止。仅接受 localhost URL。

## 真实 UI

提供桌面和移动流程，用于创建 V1 聚合、查看集合和详情、
执行每个公共用户操作、观察异步建议任务进度、浏览事件和历史
证据，以及刷新后恢复。显示加载、空、验证、冲突、过期、
离线/重试、终止和权限错误状态。使用可见语义控件、键盘导航、
关联标签、焦点管理和 WCAG AA 对比度。绝不需要开发工具或直接 API 调用来完成主要流程。

## 项目拥有的验证

- 单元测试覆盖确定性策略、状态转换、规范化和边界值。
- 集成测试启动真实 PostgreSQL 和真实 HTTP 进程；它们从不调用内部服务。
- 浏览器 E2E 使用生产构建、真实 Chromium、真实 API/数据库/工作进程和可见控件。
- 并发测试使用至少两个 API 进程和两个工作进程，针对一个 PostgreSQL 数据库。
- 恢复测试使用公共仅测试屏障来观察声明/提交或接收器/ACK 边界，然后
  SIGKILL；随机睡眠不是故障控制。
- 性能测试在以下固定间隔内运行生产构建，报告 p50/p95/p99、吞吐量、
  成功变更、预期冲突、意外 5xx、积压排空和加载后不变量。

固定 V1 兼容性能场景：

### 场景 'statement-batch-import'

- 目标：以 p95 ≤ 500 毫秒的速度导入 50 批/秒，每批 100 行
- 模式：'http'
- 方法：'POST'
- 路径：'/api/v1/statement-batches'
- 设置：准备 3,500 个互不重叠的 100 行批次：500 个用于预热，3,000 个用于测量，且 source、batchKey 和 externalId 值唯一。
- 选择器：批次序号决定 source 和 batchKey；行按 bookedAt、externalId 排序，并在 USD/EUR 之间交替，且 amountMinor 非零。
- 请求：{source,batchKey,lines:[{externalId,bookedAt,currency,amountMinor,reference} x100]}；每个请求都有新的键。
- 并发数：64
- 预热秒数：10
- 测量秒数：60
- 成功：仅计算成功原子导入且恰好包含 100 条新 Statement Lines 的请求；重复或冲突不计入。
- 阈值：在 60 秒内至少成功处理 50 批/秒，且 p95 ≤ 500 毫秒；部分导入和意外 5xx 计为零。
- 计时器：吞吐量窗口从预热后的第一个测量请求开始；每个延迟样本从请求发送到完整响应体接收完毕。

### 场景 'reconciliation-review'

- 目标：以 p95 ≤ 180 毫秒的速度服务 250 个审查查询/秒
- 模式：'http'
- 方法：'GET'
- 路径：'/api/v1/reconciliation-work?state=UNMATCHED&limit=100'
- 设置：使用未更改的 perf-v1 未匹配集；省略游标，使每个请求读取稳定的第一页。
- 选择器：无 ID 选择；所有客户端发出完全相同的只读查询。
- 请求：无请求体。
- 并发数：64
- 预热秒数：10
- 测量秒数：60
- 成功：仅计算 200 个响应，其 lines、entries、suggestions 和 nextCursor 遵循已发布的确定性顺序。
- 阈值：在 60 秒内至少成功处理 250 个审查读取/秒，且 p95 ≤ 180 毫秒；意外 5xx = 0。
- 计时器：吞吐量窗口从预热后的第一个测量请求开始；每个延迟样本从请求发送到完整响应体接收完毕。

### 场景 'suggestion-generation'

- 目标：在 60 秒内为 20,000 条未匹配记录生成建议
- 模式：'worker'
- 方法：'N/A'
- 路径：'work:MATCH_SUGGESTION'
- 设置：恰好使用 10,000 条未匹配的 Statement Lines 和 10,000 条未匹配的 Ledger Entries，并启动两个 worker；没有预先存在的 PROPOSED Match 使用这些成员。
- 选择器：使用已发布的 Statement Line 顺序和候选排名；一个快照不能重复使用成员。
- 请求：不发出测量的客户端请求；设置仅使用已发布的种子和公共 API，在 worker 计时器启动前完成。
- 并发数：2
- 预热秒数：0
- 测量秒数：60
- 成功：恰好 10,000 个 PROPOSED Matches 一对一覆盖 20,000 条输入记录，没有非终态的 MATCH_SUGGESTION Work 残留，且已确认的历史记录不变。
- 阈值：完整的 20,000 条记录输入在 ≤ 60 秒内处理完毕，且零成员重用或意外失败。
- 计时器：在两个 worker 生成时启动，并在第一个验证快照证明精确的建议数量、覆盖范围和已排空的 Work 时停止。

固定性能种子：seedVersion perf-v1 恰好包含 20,000 条 ledgerEntries、200 个 statementBatches（每个恰好 100 行）和 10,000 个 CONFIRMED matches，恰好留下 10,000 条未匹配的 Ledger Entries 和 10,000 条未匹配的 Statement Lines。每条未匹配的 Statement Line 恰好有一条未匹配的 Ledger Entry，其货币和金额在三天内相等，且没有跨配对满足这些候选规则，从而恰好产生 10,000 个一对一建议。

这三个场景是从新迁移的数据库和上述精确种子独立运行的；
完成每个场景's Setup before its Timer begins. Mode 'http' means 'method' and 'path' 是唯一测量的公共请求操作，'concurrency' 是精确的闭环客户端数量。模式
'worker' 表示方法 'N/A'，'path' 命名测量的 Work 种类，'concurrency' 是精确的 worker
进程数。严格使用每个场景的选择器和请求；不存在推断的混合工作负载。
运行恰好 'warmupSeconds' 秒的未测量时间，然后恰好 'measureSeconds' 秒的测量时间，或直到
计时器声明的终止条件。有状态的预热和测量身份必须互不重叠。延迟计算
完整的 HTTP 响应体。预期的已发布冲突单独报告，除非
场景的成功和阈值明确将其计入。

基准容器有 4 个逻辑 CPU 和 8 GiB RAM；PostgreSQL 16、Chromium、两个 API 进程、
指定的 worker 和一个调度器共享该限制。每个后续兼容的二进制文件必须
在不更改任何字段或阈值的情况下重新运行这三个相同场景。

意外 5xx 计数必须为零。在任一强制不变量为假时满足延迟或吞吐量
即为性能运行失败。

## 范围外

- 银行连接
- 会计日记账变更
- 外汇
- 机器学习
- 手动 CSV 列映射

## 交接

保持 README 和 OpenAPI 最新。以发现优先的审查结束，并报告架构、模块和
进程所有权、公共接口、成功/失败数据流、事务和租约边界、
迁移、兼容性、执行的精确命令、测试和性能结果、恢复证据、已知
风险以及所有未运行的检查。不要声称执行了未实际执行的检查。
