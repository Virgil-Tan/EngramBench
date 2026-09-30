# AuctionGuard

从本有意为空的仓库构建 AuctionGuard。本 README 是完整的产品合同。请勿在合同之外发明行为。在做出合同未明确规定的产品选择之前，请先询问。

## 必需技术栈

- Node.js 22、TypeScript、React、PostgreSQL 16、npm 以及预装的 Chromium。
- PostgreSQL 是业务状态、幂等性、租约、事件和排序的唯一权威。
- 生产环境 UI 必须使用公共 HTTP API；不得使用模拟、内存数据库或仅浏览器状态来提供正确性。
- 使用整数领域数量和 UTC ISO-8601 时间戳。不得对金额、容量、序列、持续时间单位或守恒量使用浮点数。

## 必需的非交互式命令

| 命令 | 合同 |
| --- | --- |
| 'npm run db:migrate' | 重复且安全地应用所有版本化迁移。 |
| 'npm run db:seed -- --file <path>' | 原子导入版本化 JSON 种子数据。 |
| 'npm run dev' | 启动开发环境 API 和 UI。 |
| 'npm run build' | 生成生产环境 API、worker、dispatcher 和 UI 资产。 |
| 'npm run start:api' | 启动一个生产环境 API/UI 进程。 |
| 'npm run start:worker' | 启动一个 Close Task worker。 |
| 'npm run start:dispatcher' | 启动 Domain Event webhook dispatcher。 |
| 'npm run test:unit' | 运行纯逻辑和边界测试。 |
| 'npm run test:integration' | 运行真实 PostgreSQL 加公共 HTTP 集成测试。 |
| 'npm run test:e2e' | 通过可见控件运行生产构建的 Chromium 测试。 |
| 'npm run test:concurrency' | 针对一个数据库运行至少两个 API 和两个 worker 进程。 |
| 'npm run test:recovery' | 使用可观察屏障、SIGKILL、重启和持久恢复。 |
| 'npm run test:all' | 从干净数据库运行上述所有非性能门禁。 |
| 'npm run test:perf' | 运行固定持续负载并验证所有负载后不变量。 |

每个命令在失败时以非零退出，清理自己的子进程，并且不需要任何提示。

## 环境

| 变量 | 默认值 | 规则 |
| --- | --- | --- |
| 'DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/auctionguard' | 生产/开发权威。 |
| 'TEST_DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/auctionguard_test' | 所有有状态测试必需。 |
| 'PORT' | '3000' | 整数 1-65535；API 和生产 UI 来源。 |
| 'ADMIN_TOKEN' | 任务本地值 | 仅文档化的管理员变更路由需要；切勿记录。 |
| 'WEBHOOK_URL' | 'http://127.0.0.1:4010/events' | Domain Event 投递的 HTTP 端点。 |
| 'WORK_LEASE_SECONDS' | '3' | 整数 1-60；worker 和恢复测试使用的持久租约时长。 |
| 'CHROMIUM_PATH' | '/usr/bin/chromium' | 项目自有 E2E 的浏览器可执行文件。 |
| 'MANAGED_DATA_ROOT' | '/tmp/auctionguard-data' | 可写的暂存或生成字节根目录；切勿直接提供路径。 |
| 'TEST_BARRIER_URL' | 空 | 仅受控恢复测试使用的可选 localhost HTTP 接收器。 |
| 'TEST_BARRIER_TOKEN' | 空 | 设置 URL 时必需的屏障头值；切勿记录。 |

仅绑定到 '127.0.0.1'。日志不得包含令牌、幂等键、原始种子输入、webhook 主体或私有绝对路径。

## 领域和 V1 行为

| 术语 | 规范定义 | 避免 |
| --- | --- | --- |
| Lot | 由一个 Auction 提供的不可变物品。 | 产品、列表 |
| Auction | V1 中针对一个 Lot 的定时升价竞争。 | 销售、市场 |
| Bid | 由一个 Bidder 提交的不可变最高金额。 | 报价、价格 |
| Leading Bid | 确定性当前获胜的已接受 Bid。 | 赢家、顶行 |
| Close Task | 在有效 endAt 之后关闭 Auction 的持久租约工作。 | 定时器、cron |
| 反狙击窗口 | 已发布的时间间隔，在该间隔内，已接受的 Bid 每次新的有效截止时间将 endAt 延长一次。 | 延迟、宽限 |

Auction：SCHEDULED -> OPEN -> CLOSING -> CLOSED | CANCELLED；Bid：ACCEPTED | OUTBID | WINNING。

1. 创建计划中的 Auction，并通过持久化的时间边界将其打开。
2. 接受严格递增的整数最小单位 Bid，并具有持久的作用域幂等性。
3. 在并发 API 请求下选择确定性 Leading Bid，并在精确的反狙击规则下延长 endAt。
4. 使用可恢复的 Close Tasks 关闭，并发布恰好一个赢家或无销售结果。
5. 在 UI 中展示实时出价历史、基于服务器时间的倒计时、结果和事件投递。

### 确定性策略

1. 所有金额均为 Auction 货币中的正安全整数。第一个接受的 Bid 必须 >= reservePriceMinor；每个后续 Bid 必须 >= 当前领先金额加上 minimumIncrementMinor。
2. 数据库事务时间戳为 acceptedAt。仅当状态为 OPEN 且 acceptedAt < effectiveEndAt 时，Bid 才符合条件；序列化提交顺序分配 committedSequence，从而确定唯一领导者。
3. antiSnipingWindowSeconds 为 120。如果接受的 Bid 的 effectiveEndAt - acceptedAt <= 120 秒，则将 effectiveEndAt 设置为 acceptedAt + 120 秒；否则保持不变。
4. Close Tasks 按 effectiveEndAt 然后 auctionId 处理，并且必须锁定/重新检查截止时间。领先 Bid 产生 WINNER；无已接受 Bid 产生 NO_SALE。仅在 SCHEDULED/OPEN 且无 Bid 时取消才合法。

## 强制不变量

1. 一个 Auction 的已接受出价金额在提交序列中严格递增。
2. V1 中最多一个 Bid 是 Leading，且最多一个赢家被最终确定。
3. 在有效截止时间之前接受的 Bid 不能被并发关闭丢失。
4. 每个符合条件的已接受 Bid 最多应用一次确定性截止时间延长。
5. 关闭发出一个不可变结果，重复的 worker 不能更改它。

这些不变量必须在成功、验证失败、未知 HTTP 结果、重复请求、并发请求、worker 或 dispatcher SIGKILL、重启、迁移和持续负载之后保持。

## HTTP 和 OpenAPI 3.1

在 'GET /openapi.json' 提供规范 OpenAPI，在 'GET /healthz' 提供健康检查。OpenAPI 文档和运行时行为必须一致。API 路由使用 JSON，除非明确记录的原始内容。拒绝不支持的媒体类型，返回 415 'UNSUPPORTED_MEDIA_TYPE'；格式错误的 JSON 返回 400 'MALFORMED_JSON'；未知对象键返回 400 'UNKNOWN_FIELD'；形状或范围违规且没有更具体的已发布代码时返回 400 'INVALID_REQUEST'。语义或状态冲突使用其已发布的 409 代码。在文档化的 ADMIN_TOKEN 路由上，缺失、格式错误或不正确的 Bearer 令牌返回 401 'ADMIN_AUTH_REQUIRED'。

成功的分页集合读取返回 '{items,nextCursor}'。'limit' 默认为 50，是 1 到 100 的整数。游标顺序稳定且不透明；格式错误的游标返回 400 'INVALID_CURSOR'。类型为 'uuid' 的字段是小写 UUID 字符串；未类型化的字符串标识符保留其已发布的语法。时间戳为 UTC，带尾随 'Z'。资源未命中返回 404 'NOT_FOUND'。

错误使用精确格式：

~~~json
{"error":{"code":"STABLE_CODE","message":"human-readable text","details":{}}}
~~~

以下线符号是规范性的：'uuid' 是小写 RFC 4122 文本，'int' 是 JSON 安全整数，
'timestamp' 是带毫秒精度和尾随 Z 的 UTC ISO-8601，'date' 是严格的 YYYY-MM-DD，
'sha256' 是 64 位小写十六进制，'currency' 是三个大写 ASCII 字母，'json' 是 RFC 8785 接受的任何值。'http-url' 是不带凭据或片段的绝对 http 或 https URL。
'interval' 恰好是 '{startAt:timestamp,endAt:timestamp}'，startAt 在 endAt 之前，表示半开区间 '[startAt,endAt)'。'|null' 字段是必需且可空的。每个未列出的字段都被拒绝，数组保持其声明的顺序。响应使用精确的资源形状：

- Auction = {auctionId:uuid,lotId:uuid,currency:currency,reservePriceMinor:int,minimumIncrementMinor:int,startAt:timestamp,effectiveEndAt:timestamp,state:SCHEDULED|OPEN|CLOSING|CLOSED|CANCELLED,leadingBidId:uuid|null,winnerId:uuid|null,winningAmountMinor:int|null,sequence:int}
- Bid = {bidId:uuid,auctionId:uuid,bidderId:uuid,amountMinor:int,committedSequence:int,state:ACCEPTED|OUTBID|WINNING,acceptedAt:timestamp,effectiveEndAtAfter:timestamp}
- AuctionOutcome = {auctionId:uuid,result:WINNER|NO_SALE,winnerId:uuid|null,winningBidId:uuid|null,winningAmountMinor:int|null,closedAt:timestamp}
- Lot = {lotId:uuid,title:string,description:string}

公共聚合路由为：

- 'GET /api/v1/auctions?limit&cursor' 和
  'GET /api/v1/auctions/:auctionId'。
- POST /api/v1/auctions/:auctionId/bids 使用 {bidderId,amountMinor}；返回 201 已接受的 Bid 和 effectiveEndAt，或稳定的 409 BID_TOO_LOW/AUCTION_NOT_OPEN。
- POST /api/v1/admin/auctions 使用 {lotId,currency,reservePriceMinor,minimumIncrementMinor,startAt,endAt} 需要 ADMIN_TOKEN，返回 201 SCHEDULED。
- POST /api/v1/auctions/:auctionId/cancel 使用 {reason} 仅在存在已接受的 Bid 之前成功。
- POST /api/v1/admin/auctions/:auctionId/open 使用 {} 强制执行计划开始并幂等重放。
- GET /api/v1/auctions/:auctionId/bids?limit&cursor 返回已提交的出价序列，不泄露幂等键。
- GET /api/v1/time 返回 {now:timestamp}；浏览器倒计时和隐藏截止时间测试使用此服务器权威时钟。
- 'GET /api/v1/domain-events?aggregateId&afterSequence&limit' 按序列返回已提交的事件。
- 'GET /api/v1/verification-snapshot' 需要 'Authorization: Bearer <ADMIN_TOKEN>'，并返回一个可序列化的快照 '{asOf:timestamp,resources:{...},work:[Work],events:[DomainEvent]}'。

### V1 验证快照

完整快照从单个 PostgreSQL 时间点读取；'asOf'、每个资源数组 'work' 以及 'events' 必须描述同一数据库快照。V1 的 'resources' 对象恰好包含以下键，且无其他键：

- 'bidders' 使用精确形状 'Bidder = {bidderId:uuid,displayName:string}'，并按标量字段路径元组 'bidderId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。
- 'lots' 使用精确形状 'Lot'，并按标量字段路径元组 'lotId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。
- 'auctions' 使用精确形状 'Auction'，并按标量字段路径元组 'auctionId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。
- 'bids' 使用精确形状 'Bid'，并按标量字段路径元组 'auctionId'、'committedSequence'、'bidId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。
- 'auctionOutcomes' 使用精确形状 'AuctionOutcome'，并按标量字段路径元组 'auctionId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。

每个资源数组恰好包含其声明形状所命名的每个当前或不可变实例一次。每个列出的排序路径解析为标量。标量顺序为：null 优先，然后 false 在 true 之前，整数按数值排序，其他所有字符串形式标量按 UTF-8 字节排序。按完整元组升序排序，然后仅以 RFC 8785 规范 JSON 作为决胜条件。递归省略每个名称以 'Token' 结尾的对象字段，在所有嵌套深度均如此。

'Work' 恰好是 '{workId:uuid,kind:AUCTION_CLOSE,aggregateId:uuid,state:PENDING|LEASED|SUCCEEDED|FAILED|CANCELLED,terminal:boolean,attempt:int,leaseOwner:string|null,leaseExpiresAt:timestamp|null}'。'kind' 恰好是 'AUCTION_CLOSE' 之一。两个租约字段仅在状态为 'LEASED' 时非 null，在其他所有状态下均为 null。'terminal' 仅在状态为 'SUCCEEDED'、'FAILED' 或 'CANCELLED' 时为 true；终止的 Work 被保留。当没有匹配的 Work 具有 'terminal:false' 时，积压队列即被排空。'work' 数组按 workId 排序。

'events' 包含精确的领域事件对象，按 aggregateId、sequence、eventId 排序。对每个事件负载应用相同的递归 '*Token' 省略规则。省略身份验证和业务围栏令牌、幂等键、原始 webhook 主体、私有文件系统路径和机密。这是外部不变量查询面。

以下领域错误对于格式良好的请求是穷尽的，除上述已发布的常见错误外，还包括 400 'INVALID_REQUEST'、400 'INVALID_CURSOR'、404 'NOT_FOUND' 和 409 'IDEMPOTENCY_CONFLICT'：

| HTTP | 代码 | 精确触发条件 |
| ---: | --- | --- |
| 409 | AUCTION_NOT_OPEN | 拍卖状态或有效截止时间不接受出价 |
| 409 | BID_TOO_LOW | 金额不满足保留价或当前最低价 |
| 409 | AUCTION_NOT_CANCELLABLE | 存在出价或状态不可取消 |
| 409 | AUCTION_ALREADY_CLOSED | 已存在终止结果 |
| 400 | INVALID_BID_AMOUNT | 金额不是正的安全整数 |
| 400 | INVALID_AUCTION_SCHEDULE | 金额字段无效或 startAt 不在 endAt 之前 |

### 持久幂等性

每个变更操作都需要 'Idempotency-Key'，为 1-128 个可见 ASCII 字符。作用域为方法、规范路径和键。在确认成功之前，持久化规范语义请求指纹以及完整状态/主体。相同的重试（包括重启或未知响应丢失后）返回原始状态和语义 JSON，且无第二次效果。使用不同语义重用键返回 409 'IDEMPOTENCY_CONFLICT'。并发相同请求收敛于一个结果；进程本地映射不是权威。在基准测试期间不使记录过期，也不在迁移期间重写保存的重放主体。

## 种子契约

'npm run db:seed -- --file <path>' 恰好接受：

'{schemaVersion:1,seedVersion,bidders,lots,auctions,bids}; monetary values are non-negative integers in one Auction currency, startAt precedes endAt, and anti-sniping parameters are bounded.'

成员模式是精确的：

- bidders[] = {bidderId:uuid,displayName:string}；lots[] 使用精确的 Lot 模式
- auctions[] 使用精确的 Auction 模式，并添加 antiSnipingWindowSeconds:120；计划/开放截止时间和金额字段必须有效
- bids[] 使用精确的 Bid 模式，具有连续的 committedSequence，且每个 Auction 领导者恰好匹配一个 WINNING Bid

'seedVersion' 是非空字符串，最多 64 个字符。导入器记录规范文件摘要。相同版本和摘要是无操作重放；相同版本但内容不同则失败并返回 'SEED_VERSION_CONFLICT'。拒绝未知键、重复 ID、缺失引用、无效状态、破坏的不变量、超出范围的整数和格式错误的时间。任何无效成员都会拒绝整个导入，而不更改业务行、任务、幂等性或领域事件。

## 工作进程、事件和恢复

工作进程使用 'WORK_LEASE_SECONDS' 声明有界持久租约。租约所有权必须在提交结果的短事务内再次证明。在等待 HTTP、文件、时钟或其他进程时，不持有数据库事务。过期租约可重新声明，但过期令牌无法提交。

业务状态及其领域事件在一个事务中提交。事件字段为 'eventId'、'aggregateId'、正整数 'sequence'、'type'、'occurredAt'、'schemaVersion:1' 和 'payload'。必需的事件类型：`auction.opened`、`bid.accepted`、`auction.extended`、`auction.closed`、`auction.cancelled`。'payload' 对于每个 V1 事件恰好是 '{}'；后续 Manager 事件也使用 '{}'，除非其发布的契约字面提供另一种负载形状。回滚不产生事件。序列按聚合连续。

调度器发送带有 'X-AuctionGuard-Event-Id' 和 'X-AuctionGuard-Event-Type' 的 JSON。网络错误、超时和非 2xx 响应以有界退避无限重试。每次重试保持相同的 eventId 和语义主体。成功投递顺序为递增的聚合序列。至少一次投递可能重复请求；不得发明另一个事件身份。

### 受控恢复屏障

当 'TEST_BARRIER_URL' 为空时，不存在屏障请求。当两个测试变量都设置时，工作进程在 'worker.claimed'、'worker.effect-complete' 和 'worker.before-commit' 处继续之前 POST；调度器在 'dispatcher.response-received' 处 POST。精确 JSON 为 '{schemaVersion:1,processRole:worker|dispatcher,point,workId,aggregateId,attempt,leaseTokenHash}'，头部为 'X-Test-Barrier-Token: <TEST_BARRIER_TOKEN>'。ID 和点在重试间保持相同；leaseTokenHash 是令牌的 SHA-256，绝不是令牌。204 响应释放进程。保持的响应暂停进程，且不打开数据库事务。连接丢失或非 204 响应每 100 毫秒以相同主体重试，直到租约丢失或进程终止。仅接受 localhost URL。

## 真实 UI

提供桌面和移动流程，用于创建 V1 聚合、查看集合和详情、执行每个公共用户操作、观察异步关闭任务进度、浏览事件和历史证据，以及刷新后恢复。显示加载、空、验证、冲突、过期、离线/重试、终止和权限错误状态。使用可见语义控件、键盘导航、关联标签、焦点管理和 WCAG AA 对比度。绝不要求使用 devtools 或直接 API 调用来完成主要流程。

## 项目自有验证

- 单元测试覆盖确定性策略、状态转换、规范化和边界值。
- 集成测试启动真实 PostgreSQL 和真实 HTTP 进程；绝不调用内部服务。
- 浏览器 E2E 使用生产构建、真实 Chromium、真实 API/数据库/工作进程和可见控件。
- 并发测试使用至少两个 API 进程和两个工作进程，针对一个 PostgreSQL 数据库。
- 恢复测试使用公共测试专用屏障，在 SIGKILL 前观察声明/提交或接收方/ACK 边界；随机睡眠不是故障控制。
- 性能测试运行生产构建，针对以下固定间隔，报告 p50/p95/p99、吞吐量、成功变更、预期冲突、意外 5xx、积压排空和加载后不变量。

固定的 V1 兼容性能场景：

### 场景 'hot-auction-bids'

- 目标：在 20 个热门拍卖上接受 250 出价/秒，p95 <= 300 毫秒
- 模式：'http'
- 方法：'POST'
- 路径：'/api/v1/auctions/:auctionId/bids'
- 设置：使用恰好 20 个已播种的 OPEN 热门拍卖，以及不相交的预热和测量出价者池。每个拍卖保持一个顺序生产者。
- 选择器：20 个生产者中的每一个针对一个拍卖，并按字节选择下一个 bidderId；amountMinor 是先前接受的金额加上 minimumIncrementMinor。
- 请求：{bidderId,amountMinor}；生产者等待其响应后再计算下一个金额，并始终使用新键。
- 并发：20
- 预热秒数：10
- 测量秒数：60
- 成功：仅计 201 接受的出价；committedSequence 无间隙，领导者匹配最大的已提交金额，且成功分子中无 409。
- 阈值：在 60 秒内，20 个拍卖上至少 250 个接受的出价/秒，且 p95 <= 300 毫秒；意外 5xx = 0。
- 计时器：吞吐量窗口从预热后的第一个测量请求开始；每个延迟样本从请求发送到完整响应主体结束。

### 场景 'live-auction-read'

- 目标：支持 400 次/秒的实时拍卖读取，p95 ≤ 100 毫秒
- 模式：'http'
- 方法：'GET'
- 路径：'/api/v1/auctions/:auctionId'
- 设置：使用相同的 20 个 OPEN 热拍卖，在此独立运行中不发出出价。
- 选择器：按字节轮询 auctionId 值。
- 请求：无请求体或查询参数。
- 并发数：64
- 预热秒数：10
- 测量秒数：60
- 成功标准：仅统计 200 个拍卖响应，其 leader、amount、state 和 effectiveEndAt 原子一致。
- 阈值：至少 400 次成功读取/秒持续 60 秒，且 p95 ≤ 100 毫秒；混合修订和意外 5xx 为零。
- 计时器：吞吐量窗口从预热后的第一个测量请求开始；每个延迟样本从请求发送到完整响应体接收完毕。

### 场景 'auction-close-recovery'

- 目标：重启后 45 秒内关闭 2,000 个到期拍卖
- 模式：'worker'
- 方法：'N/A'
- 路径：'work:AUCTION_CLOSE'
- 设置：恰好 2,000 个 CLOSING 拍卖具有到期的关闭工作。保持两个工作进程处于 worker.claimed 状态，SIGKILL，等待租约过期，然后启动两个替代进程。
- 选择器：使用锁定的规范出价快照按 effectiveEndAt、auctionId 关闭。
- 请求：不发出测量的客户端请求；设置仅使用已发布的种子和公共 API，在工作者计时器启动之前完成。
- 并发数：2
- 预热秒数：0
- 测量秒数：45
- 成功标准：每个拍卖恰好关闭一次，且只有一个规范的 AuctionOutcome，没有 AUCTION_CLOSE 工作保持非终止状态，过期的工作进程不能创建另一个结果。
- 阈值：2,000 个拍卖积压在替代进程启动后 ≤ 45 秒内清空；意外失败 = 0。
- 计时器：从两个替代进程启动时开始，到第一个证明所有结果和不变量成立的时间点快照时停止。

固定性能种子：seedVersion perf-v1 恰好包含 100,000 个投标人、2,020 个拍品、2,020 个拍卖和 50,000 个出价；恰好 20 个拍卖是 OPEN 热目标，2,000 个拍卖是 CLOSING 且具有到期的关闭任务。

这三个场景是从新迁移的数据库和上述精确种子独立运行的；
完成每个场景's Setup before its Timer begins. Mode 'http' means '方法' and '路径' 命名
唯一测量的公共请求操作，'concurrency' 是精确的闭环客户端数量。模式
'worker' 表示方法 'N/A'，'path' 命名测量的工作种类，'concurrency' 是精确的工作进程
数量。精确使用每个场景的选择器和请求；没有推断的混合工作负载。
运行精确 'warmupSeconds' 秒的未测量时间，然后精确 'measureSeconds' 秒的测量时间或直到
计时器声明的终止条件。有状态预热和测量身份必须不相交。计数
完整的 HTTP 响应体以计算延迟。预期的已发布冲突单独报告，除非
场景的成功标准和阈值明确将其计入。

基准容器具有 4 个逻辑 CPU 和 8 GiB 内存；PostgreSQL 16、Chromium、两个 API 进程、
指定的工作进程和一个调度器共享该限制。每个后续兼容二进制文件必须重新运行
这三个相同场景，不更改任何字段或阈值。

意外 5xx 计数必须为零。在满足延迟或吞吐量但任何强制不变量为假的情况下
是失败的性能运行。

## 范围外

- 支付
- 物流
- 出价撤回
- 密封出价
- 组合打包出价

## 交接

保持 README 和 OpenAPI 最新。以发现优先的审查结束，并报告架构、模块和
进程所有权、公共接口、成功/失败数据流、事务和租约边界、
迁移、兼容性、执行的精确命令、测试和性能结果、恢复证据、已知
风险以及未运行的每项检查。不要声称实际未执行的检查。
