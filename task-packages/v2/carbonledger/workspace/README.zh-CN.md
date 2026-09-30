# CarbonLedger

根据这个有意留空的仓库构建 CarbonLedger。本 README 是完整的产品合同。不要发明合同之外的行为。在做出合同未明确规定的产品决策之前，请先询问。

## 必需技术栈

- Node.js 22、TypeScript、React、PostgreSQL 16、npm 以及预装的 Chromium。
- PostgreSQL 是业务状态、幂等性、租约、事件和排序的唯一权威。
- 生产环境 UI 必须使用公共 HTTP API；不得使用模拟数据、内存数据库或仅浏览器端状态来提供正确性。
- 使用整数领域数量和 UTC ISO-8601 时间戳。不得对金额、容量、序列、持续时间单位或守恒量使用浮点数。

## 必需的非交互式命令

| 命令 | 合同 |
| --- | --- |
| 'npm run db:migrate' | 反复且安全地应用所有版本化迁移。 |
| 'npm run db:seed -- --file <path>' | 原子化导入版本化 JSON 种子数据。 |
| 'npm run dev' | 启动开发环境 API 和 UI。 |
| 'npm run build' | 生成生产环境 API、worker、dispatcher 和 UI 资产。 |
| 'npm run start:api' | 启动一个生产环境 API/UI 进程。 |
| 'npm run start:worker' | 启动一个证书任务 worker。 |
| 'npm run start:dispatcher' | 启动领域事件 webhook dispatcher。 |
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
| 'DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/carbonledger' | 生产/开发环境权威。 |
| 'TEST_DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/carbonledger_test' | 所有有状态测试必需。 |
| 'PORT' | '3000' | 整数 1-65535；API 和生产环境 UI 来源。 |
| 'ADMIN_TOKEN' | 任务本地值 | 仅文档化的管理员变更路由需要；切勿记录。 |
| 'WEBHOOK_URL' | 'http://127.0.0.1:4010/events' | 领域事件投递的 HTTP 端点。 |
| 'WORK_LEASE_SECONDS' | '3' | 整数 1-60；worker 和恢复测试使用的持久化租约时长。 |
| 'CHROMIUM_PATH' | '/usr/bin/chromium' | 项目自有 E2E 的浏览器可执行文件。 |
| 'MANAGED_DATA_ROOT' | '/tmp/carbonledger-data' | 暂存或生成字节的可写根目录；切勿直接提供路径。 |
| 'TEST_BARRIER_URL' | 空 | 仅受控恢复测试使用的可选 localhost HTTP 接收器。 |
| 'TEST_BARRIER_TOKEN' | 空 | 当 URL 已设置时必需的屏障头值；切勿记录。 |

仅绑定到 '127.0.0.1'。日志不得包含令牌、幂等键、原始种子输入、webhook 主体或私有绝对路径。

## 领域和 V1 行为

| 术语 | 规范定义 | 避免 |
| --- | --- | --- |
| 信用批次 | 具有项目、年份、方法论和可用整数克数的不可变签发批次。 | 余额、库存 |
| 注销 | 永久消耗保留碳数量的受益人请求。 | 购买、抵消 |
| 批次分配 | 从一个信用批次为一个注销保留的数量。 | 持有、行项 |
| 证书 | 已完成注销的不可变验证结果。 | 收据、报告 |
| 证书任务 | 产生并发布一个证书的持久化租约工作。 | 作业、渲染器 |
| 注册表事件 | 与批次和注销状态一起提交的有序事实。 | 日志、webhook |

注销：RESERVED -> CERTIFYING -> RETIRED，或 RESERVED -> RELEASED | EXPIRED | FAILED。

1. 导入已验证的信用批次，并从稳定顺序中第一个符合条件的单一批次创建注销。
2. 原子化保留整数克数，并恰好一次释放或过期未完成的请求。
3. 在最终注销之前，在可恢复的 worker 中生成一个确定性证书。
4. 防止竞争注销在 API 和 worker 进程之间过度消耗批次。
5. 在 UI 中展示批次来源、可用性、注销进度、证书下载和注册表事件。

### 确定性策略

1. 所有数量均为正整数克数，<=9007199254740991。资格筛选精确匹配 projectId/methodology 和包含边界的年份范围，然后按优先级降序、projectId 升序、年份升序、creditLotId 升序对批次排序。
2. 选择第一个 availableGrams 覆盖数量的批次。创建操作在一个事务中将数量从 available 移至 reserved，并将 expiresAt 设置为 transactionTime + 600 秒。
3. 证书任务仅在持有当前租约时将 RESERVED 更改为 CERTIFYING，生成规范证书字节，原子化地将 reserved 更改为 retired，记录摘要，并且仅在 RETIRED 状态下使字节可见。
4. 释放/过期仅在 RESERVED 状态下合法，并将 reserved 移至 available。CERTIFYING 不可释放；在注销提交之前的失败将返回 RESERVED 以进行重试。

## 强制不变量

1. 对于每个信用批次，issuedGrams = availableGrams + reservedGrams + retiredGrams，且所有项均为非负。
2. V1 注销恰好分配一个符合条件的信用批次，或什么都不分配。
3. 每个注销最多发布一个证书，其数量、受益人、批次和摘要与已提交状态匹配。
4. 已释放、已过期或失败的注销永远不会增加 retiredGrams。
5. 注册表事件和证书发布不能存在于已回滚的注销状态。

这些不变量必须在成功、验证失败、未知 HTTP 结果、重复请求、并发请求、worker 或 dispatcher SIGKILL、重启、迁移和持续负载之后仍然成立。

## HTTP 和 OpenAPI 3.1

在 'GET /openapi.json' 提供规范 OpenAPI，在 'GET /healthz' 提供健康检查。OpenAPI 文档和运行时行为必须一致。API 路由使用 JSON，除非明确文档化的原始内容。拒绝不支持的媒体类型，返回 415 'UNSUPPORTED_MEDIA_TYPE'；拒绝格式错误的 JSON，返回 400 'MALFORMED_JSON'；拒绝未知对象键，返回 400 'UNKNOWN_FIELD'；拒绝形状或范围违规且没有更具体的已发布代码，返回 400 'INVALID_REQUEST'。语义或状态冲突使用其已发布的 409 代码。在文档化的 ADMIN_TOKEN 路由上，缺失、格式错误或不正确的 Bearer 令牌返回 401 'ADMIN_AUTH_REQUIRED'。

成功的分页集合读取返回 '{items,nextCursor}'。'limit' 默认为 50，是 1 到 100 之间的整数。游标顺序稳定且不透明；格式错误的游标返回 400 'INVALID_CURSOR'。类型为 'uuid' 的字段是小写 UUID 字符串；未类型化的字符串标识符保留其已发布的语法。时间戳是 UTC，带尾随 'Z'。资源未命中返回 404 'NOT_FOUND'。

错误使用精确格式：

~~~json
{"error":{"code":"STABLE_CODE","message":"human-readable text","details":{}}}
~~~

以下线符号是规范性的：'uuid' 是小写 RFC 4122 文本，'int' 是 JSON 安全整数，
'timestamp' 是带毫秒精度和尾随 Z 的 UTC ISO-8601，'date' 是严格的 YYYY-MM-DD，
'sha256' 是 64 位小写十六进制，'currency' 是三个大写 ASCII 字母，'json' 是 RFC 8785 接受的任何值。'http-url' 是不带凭据或片段的绝对 http 或 https URL。'interval' 恰好是 '{startAt:timestamp,endAt:timestamp}'，startAt 在 endAt 之前，表示半开区间 '[startAt,endAt)'。'|null' 字段是必需的且可空。每个未列出的字段都被拒绝，数组保持其声明的顺序。响应精确使用这些资源形状：

- CreditLot = {creditLotId:uuid,projectId:uuid,vintage:int,methodology:string,priority:int,issuedGrams:int,availableGrams:int,reservedGrams:int,retiredGrams:int,provenanceDigest:sha256}
- Retirement = {retirementId:uuid,beneficiaryId:uuid,quantityGrams:int,state:RESERVED|CERTIFYING|RETIRED|RELEASED|EXPIRED|FAILED,allocation:{creditLotId:uuid,quantityGrams:int}|null,expiresAt:timestamp,certificateDigest:sha256|null,createdAt:timestamp,terminalAt:timestamp|null,sequence:int}
- Certificate = {certificateVersion:1,retirementId:uuid,beneficiaryId:uuid,quantityGrams:int,creditLotId:uuid,projectId:uuid,vintage:int,methodology:string,provenanceDigest:sha256,retiredAt:timestamp}
- CertificateResponse = Certificate 的 UTF-8 RFC 8785 JSON 字节，Content-Type 为 application/json，ETag 等于 certificateDigest

公共聚合路由是：

- 'GET /api/v1/retirements?limit&cursor' 和
  'GET /api/v1/retirements/:retirementId'。
- POST /api/v1/retirements，请求体为 {beneficiaryId, quantityGrams, eligibility:{projectId?, vintageFrom?, vintageTo?, methodology?}}；返回 202 RESERVED 并附带一个批次分配，或返回 409 CREDIT_UNAVAILABLE。
- POST /api/v1/retirements/:retirementId/release，请求体为 {reason}，仅允许在 RESERVED 状态下执行，原子性地释放其分配，否则返回 409 RETIREMENT_NOT_RELEASABLE。
- GET /api/v1/retirements/:retirementId/certificate 在 RESERVED 或 CERTIFYING 状态下返回 202 及 {retirementId, state}，在 RETIRED 状态下返回经过验证的 CertificateResponse 字节，在 RELEASED、EXPIRED 或 FAILED 状态下返回 409 CERTIFICATE_NOT_READY；绝不返回部分证书。
- GET /api/v1/credit-lots?projectId&vintage&methodology&limit&cursor 返回稳定的合格排序和精确数量。
- GET /api/v1/credit-lots/:creditLotId 返回精确的 CreditLot 总计和 provenanceDigest，用于守恒检查。
- 'GET /api/v1/domain-events?aggregateId&afterSequence&limit' 按顺序返回已提交的事件。
- 'GET /api/v1/verification-snapshot' 要求 'Authorization: Bearer <ADMIN_TOKEN>'，并返回一个
  可序列化的快照 '{asOf:timestamp,resources:{...},work:[Work],events:[DomainEvent]}'。

### V1 验证快照

完整快照从单个 PostgreSQL 时间点读取；'asOf'、每个资源数组、'work'
以及 'events' 必须描述同一数据库快照。V1 的 'resources' 对象仅包含以下键，
且无其他键：

- 'projects' 使用精确形状 'CarbonProject = {projectId:uuid,name:string}'，并按标量字段路径元组 'projectId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。
- 'beneficiaries' 使用精确形状 'Beneficiary = {beneficiaryId:uuid,name:string}'，并按标量字段路径元组 'beneficiaryId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。
- 'creditLots' 使用精确形状 'CreditLot'，并按标量字段路径元组 'creditLotId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。
- 'retirements' 使用精确形状 'Retirement'，并按标量字段路径元组 'retirementId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。
- 'certificates' 使用精确形状 'Certificate'，并按标量字段路径元组 'retirementId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜条件。

每个资源数组恰好包含其声明形状所指定的每个当前或不可变实例一次。每个列出的排序路径解析为标量。标量顺序为：null 优先，然后 false 在 true 之前，整数按数值排序，其他所有字符串形式标量按 UTF-8 字节排序。按完整元组升序排序，然后仅以 RFC 8785 规范 JSON 作为决胜条件。
递归省略每个名称以 'Token' 结尾的对象字段，适用于所有嵌套深度。

'Work' 恰好是
'{workId:uuid,kind:CERTIFICATE_GENERATION|RETIREMENT_EXPIRY,aggregateId:uuid,state:PENDING|LEASED|SUCCEEDED|FAILED|CANCELLED,terminal:boolean,attempt:int,leaseOwner:string|null,leaseExpiresAt:timestamp|null}'。
'kind' 恰好是 'CERTIFICATE_GENERATION'、'RETIREMENT_EXPIRY' 之一。两个租约字段仅在状态为
'LEASED' 时非空，在其他所有状态下均为 null。'terminal' 仅在状态为
'SUCCEEDED'、'FAILED' 或 'CANCELLED' 时为 true；终止的 Work 被保留。
当没有匹配的 Work 具有 'terminal:false' 时，积压队列即被排空。'work' 数组按
workId 排序。

'events' 包含精确的领域事件对象，按 aggregateId、sequence、eventId 排序。对每个事件负载应用相同的递归 '*Token' 省略规则。省略认证和业务防护令牌、幂等键、原始 webhook 主体、私有文件系统路径和机密。这是外部不变量查询面。

以下领域错误对于格式良好的请求是穷尽的，除上述常见错误外，还包括 400 'INVALID_REQUEST'、400 'INVALID_CURSOR'、404 'NOT_FOUND' 和 409
'IDEMPOTENCY_CONFLICT'：

| HTTP | 代码 | 精确触发条件 |
| ---: | --- | --- |
| 409 | CREDIT_UNAVAILABLE | 在 V1 中，没有单个合格批次覆盖该数量 |
| 409 | RETIREMENT_EXPIRED | 在 expiresAt 之后发生认证或释放竞争 |
| 409 | RETIREMENT_NOT_RELEASABLE | 状态不是 RESERVED |
| 409 | CERTIFICATE_NOT_READY | Retirement 处于 RELEASED、EXPIRED 或 FAILED 状态，无法再生成证书 |
| 400 | INVALID_ELIGIBILITY_FILTER | 数量或项目/年份/方法学过滤器无效 |

### 持久幂等性

每个变更操作要求 'Idempotency-Key'，为 1-128 个可见 ASCII 字符。作用域为方法、规范
路径和键。在确认成功之前，持久化规范语义请求
指纹和完整状态/主体。相同的重试，包括
重启或未知响应丢失后，返回原始状态和语义 JSON，且无二次效果。使用相同键但语义不同返回 409 'IDEMPOTENCY_CONFLICT'。并发相同
请求收敛于一个结果；进程本地映射不是权威。在基准测试期间不要使记录过期，或在迁移期间重写保存的重放主体。

## 种子契约

'npm run db:seed -- --file <path>' 恰好接受：

'{schemaVersion:1,seedVersion,projects,beneficiaries,creditLots,retirements,certificates}; quantities are positive integer grams, lot priorities are deterministic, provenance references exist, and seeded totals reconcile.'

成员模式是精确的：

- projects[] = {projectId:uuid, name:string}; beneficiaries[] = {beneficiaryId:uuid, name:string}
- creditLots[] 使用精确的 CreditLot 模式，且 issuedGrams 必须等于 availableGrams+reservedGrams+retiredGrams
- retirements[] 和 certificates[] 使用精确的线上模式；分配、批次总计、状态、字节、摘要和注册表事件序列必须协调一致

'seedVersion' 是一个非空字符串，最多 64 个字符。导入器记录规范文件摘要。
相同版本和摘要是无操作重放；相同版本但内容不同则失败，返回
'SEED_VERSION_CONFLICT'。拒绝未知键、重复 ID、缺失引用、无效状态、破坏的
不变量、超出范围的整数和格式错误的时间。任何无效成员拒绝整个导入，
而不更改业务行、任务、幂等性或领域事件。

## 工作进程、事件和恢复

工作进程使用 'WORK_LEASE_SECONDS' 声明有界持久租约。租约所有权必须在提交结果的短事务内再次证明。在等待
HTTP、文件、时钟或其他进程时，不要持有数据库事务。过期租约可重新声明，但过期令牌不能提交。

业务状态及其领域事件在一个事务中提交。事件字段为 'eventId'、'aggregateId'、
正整数 'sequence'、'type'、'occurredAt'、'schemaVersion:1' 和 'payload'。必需事件类型：
`retirement.reserved`、`retirement.released`、`retirement.expired`、`retirement.completed`、`certificate.published`。'payload' 对于每个 V1 事件恰好是 '{}'；后续 Manager 事件也使用 '{}'，除非
其发布的契约字面上提供另一种负载形状。回滚不产生事件。序列
按聚合连续。

调度器发送带有 'X-CarbonLedger-Event-Id' 和 'X-CarbonLedger-Event-Type' 的 JSON。网络错误、
超时和非 2xx 响应以有界退避无限重试。每次重试保持相同的
eventId 和语义主体。成功投递顺序为聚合序列递增。至少一次
投递可能重复请求；不得发明另一个事件身份。

### 受控恢复屏障

当 'TEST_BARRIER_URL' 为空时，不存在屏障请求。当两个测试变量都设置时，工作进程
在继续之前于 'worker.claimed'、'worker.effect-complete' 和 'worker.before-commit' 处 POST；调度器
在 'dispatcher.response-received' 处 POST。精确 JSON 为
'{schemaVersion:1,processRole:worker|dispatcher,point,workId,aggregateId,attempt,leaseTokenHash}'，头为
'X-Test-Barrier-Token: <TEST_BARRIER_TOKEN>'。ID 和点跨重试保持相同；
leaseTokenHash 是令牌的 SHA-256，绝不是令牌。204 响应释放进程。保持
响应暂停进程，而不打开数据库事务。连接丢失或非 204 每
100 毫秒重试，使用相同主体，直到租约丢失或进程终止。仅接受 localhost URL。

## 真实 UI

提供桌面和移动流程，用于创建 V1 聚合、查看集合和详情、
执行每个公共用户操作、观察异步证书任务进度、浏览事件和
历史证据，以及刷新后恢复。显示加载、空、验证、冲突、过期、
离线/重试、终止和权限错误状态。使用可见语义控件、键盘导航、
关联标签、焦点管理和 WCAG AA 对比度。绝不需要开发工具或直接 API 调用来
完成主要流程。

## 项目拥有的验证

- 单元测试覆盖确定性策略、状态转换、规范化和边界值。
- 集成测试启动真实 PostgreSQL 和真实 HTTP 进程；它们绝不调用内部服务。
- 浏览器 E2E 使用生产构建、真实 Chromium、真实 API/数据库/工作进程和可见控件。
- 并发测试使用至少两个 API 进程和两个工作进程，针对一个 PostgreSQL 数据库。
- 恢复测试使用公共仅测试屏障来观察声明/提交或接收器/ACK 边界，然后
  SIGKILL；随机睡眠不是故障控制。
- 性能测试在以下固定间隔内运行生产构建，报告 p50/p95/p99、吞吐量、
  成功变更、预期冲突、意外 5xx、积压排空和加载后不变量。

固定 V1 兼容性能场景：

### 场景 'lot-and-provenance-read'

- 目标：每秒服务 300 次批次/来源读取，p95 ≤ 140 毫秒
- 模式：'http'
- 方法：'GET'
- 路径：'/api/v1/credit-lots?projectId=:projectId&vintage=:vintage&methodology=:methodology&limit=50; /api/v1/credit-lots/:creditLotId'
- 设置：使用所有已播种的合格批次。读取不会创建退役或改变数量。
- 选择器：交替进行集合读取和详情读取。集合过滤器来自优先级顺序中的下一个批次；详情 ID 按字节顺序前进。
- 请求：无请求体；集合请求省略游标。
- 并发数：64
- 预热秒数：10
- 测量秒数：60
- 成功：仅 200 响应计数；每个完整的 100 请求块恰好为 50 次集合读取和 50 次详情读取，且所有数量/来源字段均核对一致。
- 阈值：至少 300 次成功的混合读取/秒持续 60 秒，且 p95 ≤ 140 毫秒；意外 5xx = 0。
- 计时器：吞吐量窗口从预热后的第一个测量请求开始；每个延迟样本从请求分发到完整响应体结束。

### 场景 'competing-retirement-create'

- 目标：每秒创建 80 个竞争性退役，p95 ≤ 500 毫秒
- 模式：'http'
- 方法：'POST'
- 路径：'/api/v1/retirements'
- 设置：使用十个 perf-v1 热门信用批次，每个批次在共享资格元组下至少有 10,000 可用克；预热使用单独的批次。
- 选择器：轮询 beneficiaryId 和共享资格；每个请求竞争同一有序的十个批次集合，并请求一克。
- 请求：{beneficiaryId,quantityGrams:1,eligibility:{projectId,vintageFrom:vintage,vintageTo:vintage,methodology}} 使用新密钥。
- 并发数：64
- 预热秒数：10
- 测量秒数：60
- 成功：仅 202 RESERVED 响应计数；每克从可用移动到保留恰好一次，且无 CREDIT_UNAVAILABLE 响应计数。
- 阈值：至少 80 次成功的退役/秒持续 60 秒，且 p95 ≤ 500 毫秒；批次守恒和意外 5xx 检查通过。
- 计时器：吞吐量窗口从预热后的第一个测量请求开始；每个延迟样本从请求分发到完整响应体结束。

### 场景 'certificate-recovery'

- 目标：恢复后 90 秒内生成并发布 5,000 份证书
- 模式：'worker'
- 方法：'N/A'
- 路径：'work:CERTIFICATE_GENERATION'
- 设置：恰好 5,000 个 RESERVED 退役有待处理的证书工作。保持两个工作进程在 worker.claimed，SIGKILL，等待租约过期，然后启动两个替换进程。
- 选择器：按退役 createdAt 然后 retirementId 处理，并仅在批次转换提交后发布规范字节。
- 请求：不发出测量的客户端请求；设置仅使用已发布的种子和公共 API，在工作者计时器开始之前。
- 并发数：2
- 预热秒数：0
- 测量秒数：90
- 成功：所有 5,000 个退役达到 RETIRED 状态，且每份证书已验证，无工作保持非终止状态，每个摘要与提供的字节匹配，批次总数守恒克数。
- 阈值：所有证书在替换进程生成后 ≤ 90 秒内发布；部分对象、过期提交和意外失败为零。
- 计时器：在两个替换进程生成时开始，仅在快照和直接证书字节验证证明所有后置条件后停止。

固定性能种子：seedVersion perf-v1 包含恰好 1,000 个项目、10,000 个受益人、50,000 个信用批次、105,000 个退役和 100,000 份证书；100,000 个退役为 RETIRED 状态，恰好 5,000 个为 RESERVED 状态且有待处理的证书任务。十个测量的热门批次共享一个资格元组，每个批次 availableGrams ≥ 10000；一个不相交的十个批次集合具有相同边界，用于预热。

三个场景是从新迁移的数据库和上述精确种子独立运行的；
完成每个场景's Setup before its Timer begins. Mode 'http' means '方法' and '路径' 命名
唯一测量的公共请求操作，'concurrency' 是精确的闭环客户端数量。模式
'worker' 表示方法 'N/A'，'path' 命名测量的工作种类，'concurrency' 是精确的工作
进程数量。精确使用每个场景的选择器和请求；没有推断的混合工作负载。
运行恰好 'warmupSeconds' 秒未测量，然后恰好 'measureSeconds' 秒测量或直到
计时器声明的终止条件。有状态预热和测量身份必须不相交。计数
完整 HTTP 响应体用于延迟。预期发布的冲突单独报告，除非
场景的成功和阈值明确计数它们。

基准容器有 4 个逻辑 CPU 和 8 GiB RAM；PostgreSQL 16、Chromium、两个 API 进程、
指定的工作进程和一个调度器共享该限制。每个后续兼容二进制必须重新运行
这三个相同场景，不更改任何字段或阈值。

意外 5xx 计数必须为零。满足延迟或吞吐量而任何强制不变量为假
是失败的性能运行。

## 范围外

- 信用定价
- 支付
- 外部注册表
- 科学验证
- 浮点吨位

## 交接

保持 README 和 OpenAPI 最新。以发现优先的审查结束，并报告架构、模块和
进程所有权、公共接口、成功/失败数据流、事务和租约边界、
迁移、兼容性、执行的精确命令、测试和性能结果、恢复证据、已知
风险以及每个未运行的检查。不要声称实际未执行的检查。
