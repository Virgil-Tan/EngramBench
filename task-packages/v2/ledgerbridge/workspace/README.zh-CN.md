# LedgerBridge

从本意上为空白仓库构建 LedgerBridge。本 README 是完整的产品合同。不要发明合同之外的行为。在做出合同未规定的产品决策之前，请先询问。

## 必需的技术栈

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
| 'npm run build' | 生成生产环境 API、worker、dispatcher 和 UI 资源。 |
| 'npm run start:api' | 启动一个生产环境 API/UI 进程。 |
| 'npm run start:worker' | 启动一个结算任务 worker。 |
| 'npm run start:dispatcher' | 启动领域事件 webhook dispatcher。 |
| 'npm run test:unit' | 运行纯逻辑和边界测试。 |
| 'npm run test:integration' | 运行真实 PostgreSQL 加公共 HTTP 集成测试。 |
| 'npm run test:e2e' | 通过可见控件运行生产构建的 Chromium 测试。 |
| 'npm run test:concurrency' | 针对一个数据库运行至少两个 API 和两个 worker 进程。 |
| 'npm run test:recovery' | 使用可观察屏障、SIGKILL、重启和持久恢复。 |
| 'npm run test:all' | 从干净数据库运行上述所有非性能门禁。 |
| 'npm run test:perf' | 运行固定持续负载并验证所有负载后不变量。 |

每个命令在失败时以非零状态退出，清理自己的子进程，并且不需要任何提示。

## 环境

| 变量 | 默认值 | 规则 |
| --- | --- | --- |
| 'DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/ledgerbridge' | 生产/开发权威。 |
| 'TEST_DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/ledgerbridge_test' | 所有有状态测试必需。 |
| 'PORT' | '3000' | 整数 1-65535；API 和生产 UI 来源。 |
| 'ADMIN_TOKEN' | 任务本地值 | 仅文档化的管理变更路由需要；切勿记录。 |
| 'WEBHOOK_URL' | 'http://127.0.0.1:4010/events' | 领域事件投递的 HTTP 端点。 |
| 'WORK_LEASE_SECONDS' | '3' | 整数 1-60；worker 和恢复测试使用的持久租约时长。 |
| 'CHROMIUM_PATH' | '/usr/bin/chromium' | 项目自有 E2E 的浏览器可执行文件。 |
| 'MANAGED_DATA_ROOT' | '/tmp/ledgerbridge-data' | 暂存或生成字节的可写根目录；切勿直接提供路径。 |
| 'TEST_BARRIER_URL' | 空 | 仅受控恢复测试使用的可选本地主机 HTTP 接收器。 |
| 'TEST_BARRIER_TOKEN' | 空 | 设置 URL 时必需的屏障头值；切勿记录。 |

仅绑定到 '127.0.0.1'。日志不得包含令牌、幂等键、原始种子输入、webhook 主体或私有绝对路径。

## 领域和 V1 行为

| 术语 | 规范定义 | 避免 |
| --- | --- | --- |
| 账户 | 由稳定 accountId 和一个整数最小单位货币标识的余额所有者。 | 钱包、钱袋 |
| 转账 | 两个不同账户之间的一次请求移动。 | 支付、交易 |
| 过账 | 一笔转账的不可变平衡借方和贷方对。 | 余额更新 |
| 结算任务 | 最终确定待处理转账的持久租约工作。 | 作业、队列项 |
| 冲正 | 与恰好一笔已过账转账关联的补偿性过账。 | 删除、退款 |
| 领域事件 | 与聚合状态和序列一起提交的版本化事实。 | 消息、日志 |

转账：PENDING -> POSTED | CANCELLED；POSTED -> REVERSED。CANCELLED 和 REVERSED 为终态。

1. 使用整数最小单位和一种货币从一个账户向另一个账户创建转账。
2. 原子性地预留可用来源资金，并让租约 worker 过账平衡的借方和贷方。
3. 仅允许在待处理时取消，仅在过账后允许冲正；竞争性终态操作只有一个赢家。
4. 公开账户对账单、转账历史、事件历史以及真实 API 支持的操作 UI。
5. 通过至少一次 webhook dispatcher 投递领域事件，具有稳定身份和每笔转账的顺序。

### 确定性策略

1. currency 恰好是三个大写 ASCII 字母；amountMinor 是从 1 到 9007199254740991 的整数；来源和目的地必须不同，且两个账户必须使用该货币。
2. availableMinor 等于 balanceMinor 减去 reservedMinor。创建仅增加来源 reservedMinor；过账在一个事务中减少来源余额和预留并增加目的地余额。
3. 结算任务按 createdAt 然后 transferId 认领 PENDING 转账。取消仅在过账前获胜；冲正创建相反的平衡过账并恰好更改一次余额。
4. 对账单按 createdAt 升序然后 postingId 升序排序；游标编码两个值，balanceAfterMinor 是该腿之后的已提交余额。

## 强制不变量

1. 对于每种货币，所有账户 balanceMinor 值之和是守恒的；预留不参与该总和。
2. 每笔已过账转账恰好有两个过账腿，其带符号金额之和为零。
3. 对于每个账户，reservedMinor 等于其传出 PENDING 转账的 amountMinor 之和，availableMinor 等于 balanceMinor 减去 reservedMinor，且这些值均不为负。
4. 一笔转账最多有一次成功过账和最多一次冲正。
5. 已提交的状态转换恰好有一个领域事件；回滚的转换没有。

这些不变量必须在成功、验证失败、未知 HTTP 结果、重复请求、并发请求、worker 或 dispatcher SIGKILL、重启、迁移和持续负载之后仍然成立。

## HTTP 和 OpenAPI 3.1

在 'GET /openapi.json' 提供规范 OpenAPI，在 'GET /healthz' 提供健康检查。OpenAPI 文档和运行时行为必须一致。API 路由使用 JSON，除非明确记录的原始内容。拒绝不支持的媒体类型返回 415 'UNSUPPORTED_MEDIA_TYPE'，格式错误的 JSON 返回 400 'MALFORMED_JSON'，未知对象键返回 400 'UNKNOWN_FIELD'，形状或范围违规且没有更具体的已发布代码时返回 400 'INVALID_REQUEST'。语义或状态冲突使用其已发布的 409 代码。在文档化的 ADMIN_TOKEN 路由上缺失、格式错误或不正确的 Bearer 令牌返回 401 'ADMIN_AUTH_REQUIRED'。

成功的分页集合读取返回 '{items,nextCursor}'。'limit' 默认为 50，是从 1 到 100 的整数。游标顺序稳定且不透明；格式错误的游标返回 400 'INVALID_CURSOR'。类型为 'uuid' 的字段是小写 UUID 字符串；无类型字符串标识符保留其已发布的语法。时间戳是 UTC，带尾随 'Z'。资源未命中返回 404 'NOT_FOUND'。

错误使用精确格式：

~~~json
{"error":{"code":"STABLE_CODE","message":"human-readable text","details":{}}}
~~~

以下线符号是规范性的：'uuid' 是小写 RFC 4122 文本，'int' 是 JSON 安全整数，'timestamp' 是带毫秒精度和尾随 Z 的 UTC ISO-8601，'date' 是严格 YYYY-MM-DD，'sha256' 是 64 个小写十六进制，'currency' 是三个大写 ASCII 字母，'json' 是 RFC 8785 接受的任何值。'http-url' 是不带凭据或片段的绝对 http 或 https URL。'interval' 恰好是 '{startAt:timestamp,endAt:timestamp}'，startAt 在 endAt 之前，表示半开区间 '[startAt,endAt)'。'|null' 字段是必需且可空的。每个未列出的字段都被拒绝，数组保持其声明的顺序。响应使用精确的资源形状：

- Account = {accountId:uuid,currency:currency,openingBalanceMinor:int,balanceMinor:int,reservedMinor:int,availableMinor:int,revision:int}
- Transfer = {transferId:uuid,sourceAccountId:uuid,destinationAccountId:uuid,currency:currency,amountMinor:int,state:PENDING|POSTED|CANCELLED|REVERSED,postingId:uuid|null,reversalPostingId:uuid|null,createdAt:timestamp,postedAt:timestamp|null,cancelledAt:timestamp|null,reversedAt:timestamp|null,sequence:int}
- Posting = {postingId:uuid,transferId:uuid,kind:TRANSFER|REVERSAL,legs:[{accountId:uuid,direction:DEBIT|CREDIT,amountMinor:int}],createdAt:timestamp}; legs 恰好包含一个 DEBIT 然后一个 CREDIT
- StatementPage = {items:[{postingId:uuid,transferId:uuid,kind:TRANSFER|REVERSAL,direction:DEBIT|CREDIT,amountMinor:int,balanceAfterMinor:int,createdAt:timestamp}],nextCursor:string|null}

公共聚合路由是：

- 'GET /api/v1/transfers?limit&cursor' 和
  'GET /api/v1/transfers/:transferId'。
- POST /api/v1/transfers，请求体为 {sourceAccountId,destinationAccountId,currency,amountMinor}；返回 202，包含完整的 Transfer 及必需的 Idempotency-Key 重放语义。
- POST /api/v1/transfers/:transferId/cancel，请求体为 {}，返回最终结果或 409 TRANSFER_NOT_CANCELLABLE。
- POST /api/v1/transfers/:transferId/reverse，请求体为 {reason}，返回 202 或 409 TRANSFER_NOT_REVERSIBLE。
- GET /api/v1/accounts/:accountId/statement?limit&cursor 返回有序的 Posting 分录及稳定的游标。
- GET /api/v1/accounts/:accountId 返回用于重新计算守恒性的精确 Account 线格式。
- 'GET /api/v1/domain-events?aggregateId&afterSequence&limit' 按顺序返回已提交的事件。
- 'GET /api/v1/verification-snapshot' 要求 'Authorization: Bearer <ADMIN_TOKEN>'，并返回一个
  可序列化的快照 '{asOf:timestamp,resources:{...},work:[Work],events:[DomainEvent]}'。

### V1 验证快照

完整快照从单个 PostgreSQL 时间点读取；'asOf'、每个资源数组、'work'，
以及 'events' 必须描述同一数据库快照。V1 'resources' 对象仅包含以下键，
不得包含其他键：

- 'accounts' 使用精确形状 'Account'，并按标量字段路径元组 'accountId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。
- 'transfers' 使用精确形状 'Transfer'，并按标量字段路径元组 'transferId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。
- 'postings' 使用精确形状 'Posting'，并按标量字段路径元组 'postingId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。

每个资源数组恰好包含其声明形状所命名的每个当前或不可变实例一次。每个列出的排序路径解析为标量。标量顺序为 null 优先，然后 false 在 true 之前，
整数按数值排序，其他所有字符串形式标量按 UTF-8 字节排序。按完整元组升序排序，然后仅以 RFC 8785 规范 JSON 作为决胜条件。
递归省略每个名称以 'Token' 结尾的对象字段，无论嵌套深度如何。

'Work' 恰好是
'{workId:uuid,kind:SETTLEMENT,aggregateId:uuid,state:PENDING|LEASED|SUCCEEDED|FAILED|CANCELLED,terminal:boolean,attempt:int,leaseOwner:string|null,leaseExpiresAt:timestamp|null}'。
'kind' 恰好是 'SETTLEMENT' 之一。两个租约字段仅在状态为
'LEASED' 时非空，在其他所有状态下均为 null。'terminal' 仅在状态为
'SUCCEEDED'、'FAILED' 或 'CANCELLED' 时为 true；终态 Work 被保留。
当没有匹配的 Work 具有 'terminal:false' 时，积压队列恰好被排空。'work' 数组按
workId 排序。

'events' 包含精确的领域事件对象，按 aggregateId、sequence、eventId 排序。对每个事件负载应用
相同的递归 '*Token' 省略规则。省略认证和业务防护令牌、幂等键、原始 webhook 请求体、私有文件系统路径及机密信息。这是
外部不变量查询面。

以下领域错误对于格式良好的请求是穷尽的，除上述已发布的常见错误外，还包括 400 'INVALID_REQUEST'、400 'INVALID_CURSOR'、404 'NOT_FOUND' 和 409
'IDEMPOTENCY_CONFLICT'：

| HTTP | 代码 | 精确触发条件 |
| ---: | --- | --- |
| 409 | INSUFFICIENT_FUNDS | 源账户的 availableMinor 小于 amountMinor |
| 409 | ACCOUNT_CURRENCY_MISMATCH | 任一账户具有其他货币 |
| 409 | TRANSFER_NOT_CANCELLABLE | Transfer 不是 PENDING 状态 |
| 409 | TRANSFER_NOT_REVERSIBLE | Transfer 不是 POSTED 状态 |
| 400 | INVALID_AMOUNT | amountMinor 超出已发布的整数范围 |

### 持久幂等性

每个变更操作要求 'Idempotency-Key'，为 1-128 个可见 ASCII 字符。作用域为方法、规范
路径和键。在确认成功之前，持久化规范语义请求
指纹及完整状态/请求体。相同的重试，包括
重启或未知响应丢失后，返回原始状态和语义 JSON，且无第二次
效果。使用不同语义重用键返回 409 'IDEMPOTENCY_CONFLICT'。并发相同
请求收敛于一个结果；进程本地映射不是权威。在基准测试期间
不要过期记录，或在迁移期间重写已保存的重放请求体。

## 种子契约

'npm run db:seed -- --file <path>' 恰好接受：

'{schemaVersion:1,seedVersion,accounts,transfers}; account IDs are unique, balances are non-negative integers, and currencies use three uppercase letters.'

成员模式是精确的：

- accounts[] = {accountId:uuid,currency:currency,openingBalanceMinor:int}；openingBalanceMinor 为 0..9007199254740991
- transfers[] = {transferId:uuid,sourceAccountId:uuid,destinationAccountId:uuid,currency:currency,amountMinor:int,state:PENDING|POSTED|CANCELLED,createdAt:timestamp,terminalAt:timestamp|null}
- 对于种子 POSTED Transfer，postings 从 transferId 确定性派生，且总额必须与每个账户的开户余额对账；CANCELLED Transfer 没有 Posting。

'seedVersion' 是非空字符串，最多 64 个字符。导入器记录规范文件摘要。
相同版本和摘要是无操作重放；相同版本但内容不同则失败，返回
'SEED_VERSION_CONFLICT'。拒绝未知键、重复 ID、缺失引用、无效状态、破坏的
不变量、超出范围的整数及格式错误的时间。任何无效成员拒绝整个导入，
不更改业务行、任务、幂等性或领域事件。

## 工作进程、事件和恢复

工作进程使用 'WORK_LEASE_SECONDS' 声明有界持久租约。租约所有权必须在
提交结果的短事务内再次证明。在等待
HTTP、文件、时钟或其他进程时，不要持有数据库事务。过期租约可重新声明，但过期令牌不能提交。

业务状态及其领域事件在一个事务中提交。事件字段为 'eventId'、'aggregateId'、
正整数 'sequence'、'type'、'occurredAt'、'schemaVersion:1' 和 'payload'。必需事件类型：
`transfer.created`、`transfer.posted`、`transfer.cancelled`、`transfer.reversed`。'payload' 恰好是 '{}'，适用于每个 V1 事件；后续 Manager 事件也使用 '{}'，除非
其已发布契约字面提供另一负载形状。回滚不产生事件。序列
按聚合连续。

调度器发送 JSON，包含 'X-LedgerBridge-Event-Id' 和 'X-LedgerBridge-Event-Type'。网络错误、
超时和非 2xx 响应以有界退避无限重试。每次重试保持相同的
eventId 和语义请求体。成功投递顺序为聚合序列递增。至少一次
投递可能重复请求；不得发明另一事件身份。

### 受控恢复屏障

当 'TEST_BARRIER_URL' 为空时，不存在屏障请求。当两个测试变量均设置时，工作进程
在继续之前于 'worker.claimed'、'worker.effect-complete' 和 'worker.before-commit' 处 POST；调度器
在 'dispatcher.response-received' 处 POST。精确 JSON 为
'{schemaVersion:1,processRole:worker|dispatcher,point,workId,aggregateId,attempt,leaseTokenHash}'，头为
'X-Test-Barrier-Token: <TEST_BARRIER_TOKEN>'。ID 和点跨重试保持相同；
leaseTokenHash 是令牌的 SHA-256，而非令牌。204 响应释放进程。保持
响应暂停进程，且不打开数据库事务。连接丢失或非 204 每
100 毫秒重试，使用相同请求体，直到租约丢失或进程终止。仅接受 localhost URL。

## 真实 UI

提供桌面和移动流程，用于创建 V1 聚合、查看集合和详情、
执行每个公共用户操作、观察异步结算任务进度、浏览事件和
历史证据，以及刷新后恢复。显示加载、空、验证、冲突、过期、
离线/重试、终态和权限错误状态。使用可见语义控件、键盘导航、
关联标签、焦点管理和 WCAG AA 对比度。完成主要流程时，绝不要求使用开发者工具或直接 API 调用。

## 项目自有验证

- 单元测试覆盖确定性策略、状态转换、规范化和边界值。
- 集成测试启动真实 PostgreSQL 和真实 HTTP 进程；它们绝不调用内部服务。
- 浏览器 E2E 使用生产构建、真实 Chromium、真实 API/数据库/工作进程及可见控件。
- 并发测试使用至少两个 API 进程和两个工作进程，针对一个 PostgreSQL 数据库。
- 恢复测试使用公共仅测试屏障，在 SIGKILL 前观察声明/提交或接收方/ACK 边界；随机睡眠不是故障控制。
- 性能测试运行生产构建，针对以下固定间隔，报告 p50/p95/p99、吞吐量、
  成功变更、预期冲突、意外 5xx、积压排空及加载后不变量。

固定 V1 兼容性能场景：

### 场景 'statement-read'

- 目标：150 次语句读取/秒，p95 ≤ 150 毫秒
- 模式：'http'
- 方法：'GET'
- 路径：'/api/v1/accounts/:accountId/statement?limit=50'
- 设置：使用未更改的 perf-v1 种子；读取不消耗数据。
- 选择器：按字节序 UUID 顺序从验证快照中的所有账户中轮询选择 accountId；在每个请求中省略游标。
- 请求：无请求体。仅当公共路由通常需要授权时才要求授权。
- 并发数：64
- 预热秒数：10
- 测量秒数：60
- 成功：仅完整的 200 StatementPage 响应计入；每个页面必须具有有效的顺序、游标、分录金额和 balanceAfterMinor。
- 阈值：至少 150 次成功响应/秒，持续 60 秒，且成功响应 p95 ≤ 150 毫秒；意外 5xx = 0。
- 计时器：吞吐量窗口从预热后的第一个测量请求开始；每个延迟样本从请求发送到完整响应体接收完毕。

### 场景 'transfer-mutation-mix'

- 目标：40 次转账变更/秒，p95 ≤ 500 毫秒
- 模式：'http'
- 方法：'POST'
- 路径：'/api/v1/transfers; /api/v1/transfers/:transferId/cancel; /api/v1/transfers/:transferId/reverse'
- 设置：从字节序排序的种子 ID 中预留不相交的预热和测量池，包含已注资的同币种账户对、PENDING 转账和 POSTED 转账。
- 选择器：重复执行 CREATE、CREATE、CANCEL、REVERSE。每个 CANCEL 或 REVERSE ID 仅使用一次；每次 CREATE 使用下一个账户对、amountMinor 为 1，并使用新的密钥。
- 请求：CREATE 使用 {sourceAccountId,destinationAccountId,currency,amountMinor:1}；CANCEL 使用 {}；REVERSE 使用 {reason:"perf"}。预热和测量 ID 永不相交。
- 并发数：64
- 预热秒数：10
- 测量秒数：60
- 成功：仅每个计划操作的已发布 2xx 最终响应计入；预期冲突不计入成功分子。
- 阈值：至少 40 次成功变更/秒，持续 60 秒，且成功响应 p95 ≤ 500 毫秒；之后所有余额、预留、入账和事件必须对账一致。
- 计时器：吞吐量窗口从预热后的第一个测量请求开始；每个延迟样本从请求发送到完整响应体接收完毕。

### 场景 'settlement-recovery'

- 目标：在工人重启后 45 秒内排空 2,000 个结算任务
- 模式：'worker'
- 方法：'N/A'
- 路径：'work:SETTLEMENT'
- 设置：恰好 2,000 个 PENDING 转账各有一个非终止状态的 SETTLEMENT 工作。启动两个工人，将两者都保持在 worker.claimed 状态，SIGKILL 它们，等待两个租约过期，然后启动两个替代工人。
- 选择器：工人按已发布的 createdAt,transferId 顺序声明，直到没有非终止状态的 SETTLEMENT 工作。
- 请求：不发出任何测量的客户端请求；设置仅使用已发布的种子和公共 API，在工人计时器启动之前完成。
- 并发数：2
- 预热秒数：0
- 测量秒数：45
- 成功：所有 2,000 笔转账恰好 POSTED 一次，没有 SETTLEMENT 工作的 terminal=false，失效工人无法提交，且守恒和事件不变量通过。
- 阈值：替代工人计时器 ≤ 45 秒，且工人意外失败 = 0。
- 计时器：在两个替代工人进程生成时启动；仅在验证快照证明积压已排空且所有后置条件满足后停止。

固定性能种子：种子版本 perf-v1 恰好包含 20,000 个账户和 102,000 笔转账：100,000 笔 POSTED 和 2,000 笔 PENDING，每笔 PENDING 转账恰好有一个待处理的结算任务。

三个场景是从全新迁移的数据库和上述精确种子独立运行的；
完成每个场景's Setup before its Timer begins. Mode 'http' means '方法' and '路径' 命名
唯一测量的公共请求操作，'concurrency' 是精确的闭环客户端数量。模式
'worker' 表示方法 'N/A'，'path' 命名测量的工作类型，'concurrency' 是精确的工人
进程数量。精确使用每个场景的选择器和请求；不存在推断的混合工作负载。
精确运行 'warmupSeconds' 秒未测量时间，然后精确运行 'measureSeconds' 秒测量时间或直到
计时器声明的终止条件。有状态预热和测量身份必须不相交。计数
完整 HTTP 响应体以计算延迟。预期发布的冲突单独报告，除非
场景的成功和阈值明确将其计入。

基准容器有 4 个逻辑 CPU 和 8 GiB RAM；PostgreSQL 16、Chromium、两个 API 进程、
指定的工人和一个调度器共享该限制。每个后续兼容二进制文件必须
在不更改任何字段或阈值的情况下重新运行这三个相同场景。

意外 5xx 计数必须为零。在任一强制不变量为假时满足延迟或吞吐量
是失败的性能运行。

## 范围外

- 外汇
- 利息
- 费用
- 外部支付通道
- 账户透支

## 交接

保持 README 和 OpenAPI 最新。以发现优先的审查结束，并报告架构、模块和
进程所有权、公共接口、成功/失败数据流、事务和租约边界、
迁移、兼容性、执行的精确命令、测试和性能结果、恢复证据、已知
风险以及所有未执行的检查。不要声称实际未执行的检查。
