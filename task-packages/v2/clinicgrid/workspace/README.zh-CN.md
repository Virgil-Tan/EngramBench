# ClinicGrid

从本空白仓库构建 ClinicGrid。本 README 是完整的产品合同。请勿在合同之外发明行为。在做出合同未明确规定的产品决策前，请先询问。

## 必需技术栈

- Node.js 22、TypeScript、React、PostgreSQL 16、npm 以及预装的 Chromium。
- PostgreSQL 是业务状态、幂等性、租约、事件和排序的唯一权威。
- 生产环境 UI 必须使用公共 HTTP API；不得使用模拟、内存数据库或仅浏览器状态来提供正确性。
- 使用整数领域数量和 UTC ISO-8601 时间戳。不得对金额、容量、序列、时长单位或守恒量使用浮点数。

## 必需的非交互式命令

| 命令 | 合同 |
| --- | --- |
| 'npm run db:migrate' | 重复且安全地应用所有版本化迁移。 |
| 'npm run db:seed -- --file <path>' | 原子导入版本化 JSON 种子数据。 |
| 'npm run dev' | 启动开发环境 API 和 UI。 |
| 'npm run build' | 生成生产环境 API、worker、dispatcher 和 UI 资源。 |
| 'npm run start:api' | 启动一个生产环境 API/UI 进程。 |
| 'npm run start:worker' | 启动一个过期任务 worker。 |
| 'npm run start:dispatcher' | 启动领域事件 webhook dispatcher。 |
| 'npm run test:unit' | 运行纯逻辑和边界测试。 |
| 'npm run test:integration' | 运行真实 PostgreSQL 加公共 HTTP 集成测试。 |
| 'npm run test:e2e' | 通过可见控件运行生产构建的 Chromium 测试。 |
| 'npm run test:concurrency' | 针对一个数据库运行至少两个 API 和两个 worker 进程。 |
| 'npm run test:recovery' | 使用可观察屏障、SIGKILL、重启和持久恢复。 |
| 'npm run test:all' | 从干净数据库运行上述所有非性能门禁。 |
| 'npm run test:perf' | 运行固定持续负载并验证所有负载后不变量。 |

每个命令在失败时以非零退出，清理自己的子进程，且不需要任何提示。

## 环境

| 变量 | 默认值 | 规则 |
| --- | --- | --- |
| 'DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/clinicgrid' | 生产/开发权威。 |
| 'TEST_DATABASE_URL' | 'postgresql://postgres@127.0.0.1:5432/clinicgrid_test' | 所有有状态测试必需。 |
| 'PORT' | '3000' | 整数 1-65535；API 和生产 UI 来源。 |
| 'ADMIN_TOKEN' | 任务本地值 | 仅文档化的管理员变更路由需要；切勿记录。 |
| 'WEBHOOK_URL' | 'http://127.0.0.1:4010/events' | 领域事件投递的 HTTP 端点。 |
| 'WORK_LEASE_SECONDS' | '3' | 整数 1-60；worker 和恢复测试使用的持久租约时长。 |
| 'CHROMIUM_PATH' | '/usr/bin/chromium' | 项目自有 E2E 的浏览器可执行文件。 |
| 'MANAGED_DATA_ROOT' | '/tmp/clinicgrid-data' | 暂存或生成字节的可写根目录；切勿直接提供路径。 |
| 'TEST_BARRIER_URL' | 空 | 仅受控恢复测试使用的可选 localhost HTTP 接收器。 |
| 'TEST_BARRIER_TOKEN' | 空 | 设置 URL 时必需的屏障头值；切勿记录。 |

仅绑定到 '127.0.0.1'。日志不得包含令牌、幂等键、原始种子输入、webhook 主体或私有绝对路径。

## 领域和 V1 行为

| 术语 | 规范定义 | 避免 |
| --- | --- | --- |
| 临床医生 | 具有版本化可用性区间的执业者。 | 医生、提供者 |
| 房间 | 具有独立可用性的物理治疗室。 | 地点、办公室 |
| 设备单元 | 服务类型所需的唯一可预约设备。 | 资产、工具 |
| 预约 | 一个患者请求，在一个区间内持有临床医生、房间和所需设备单元。 | 预订、访问 |
| 候补条目 | 针对一个服务类型和可接受时间范围的优先级请求。 | 队列项 |
| 过期任务 | 使未确认预约过期并恰好释放每个资源一次的持久工作。 | 定时器、cron |

预约：HELD -> CONFIRMED | CANCELLED | EXPIRED；终态转换互斥。

1. 从真实临床医生、房间和设备日历搜索可用性。
2. 原子持有每个所需资源，区间按 15 分钟对齐，并发布过期时间。
3. 确认、取消或使预约过期，恰好一个终态胜出且可持久重放。
4. 按严格优先级、joinedAt 和 ID 顺序提升符合条件的候补条目，不跳过队首。
5. 暴露患者和协调员日历、异步过期/提升状态以及事件投递。

### 确定性策略

1. 区间为半开 [startAt,endAt)，startAt 对齐到 15 个 UTC 分钟，endAt 等于 startAt 加 ServiceType.durationMinutes；时长为 15..240，步长为 15 分钟。
2. 选择请求的临床医生，然后按优先级升序和 roomId 选择可用房间，再按优先级和 equipmentUnitId 选择每个所需设备类型的一个单元。所有日历必须覆盖完整区间。
3. 成功持有在数据库事务时间戳后恰好 120 秒过期。确认仅在严格早于 expiresAt 时合法；在 expiresAt 或之后，过期结果胜出。
4. 候补优先级为 0 到 100 的整数。候补顺序为优先级降序、joinedAt 升序、waitlistEntryId 升序。提升仅考虑队首，并选择最早可行时段，然后按正常资源顺序。

## 强制不变量

1. 任何资源不得有重叠的 HELD 或 CONFIRMED 预约。
2. 预约在其完整区间内拥有所有所需资源，或什么都不拥有。
3. 取消或过期恰好释放每个资源一次。
4. 候补条目最多产生一个预约，且发布的队首阻塞顺序得以保留。
5. 持久化的 expiresAt 时刻（而非进程本地定时器）决定过期。

这些不变量必须在成功、验证失败、未知 HTTP 结果、重复请求、并发请求、worker 或 dispatcher SIGKILL、重启、迁移和持续负载后仍然成立。

## HTTP 和 OpenAPI 3.1

在 'GET /openapi.json' 提供规范 OpenAPI，在 'GET /healthz' 提供健康检查。OpenAPI 文档和运行时行为必须一致。API 路由使用 JSON，除非明确文档化的原始内容。拒绝不支持的媒体类型返回 415 'UNSUPPORTED_MEDIA_TYPE'，格式错误的 JSON 返回 400 'MALFORMED_JSON'，未知对象键返回 400 'UNKNOWN_FIELD'，形状或范围违规且无更具体的已发布代码时返回 400 'INVALID_REQUEST'。语义或状态冲突使用其已发布的 409 代码。在文档化的 ADMIN_TOKEN 路由上，缺失、格式错误或不正确的 Bearer 令牌返回 401 'ADMIN_AUTH_REQUIRED'。

成功的分页集合读取返回 '{items,nextCursor}'。'limit' 默认为 50，为 1 到 100 的整数。游标顺序稳定且不透明；格式错误的游标返回 400 'INVALID_CURSOR'。类型为 'uuid' 的字段是小写 UUID 字符串；无类型字符串标识符保留其已发布的语法。时间戳为 UTC，带尾随 'Z'。资源未命中返回 404 'NOT_FOUND'。

错误使用精确格式：

~~~json
{"error":{"code":"STABLE_CODE","message":"human-readable text","details":{}}}
~~~

以下线符号是规范性的：'uuid' 是小写 RFC 4122 文本，'int' 是 JSON 安全整数，'timestamp' 是带毫秒精度和尾随 Z 的 UTC ISO-8601，'date' 是严格 YYYY-MM-DD，'sha256' 是 64 个小写十六进制，'currency' 是三个大写 ASCII 字母，'json' 是 RFC 8785 接受的任何值。'http-url' 是不带凭据或片段的绝对 http 或 https URL。'interval' 恰好是 '{startAt:timestamp,endAt:timestamp}'，startAt 在 endAt 之前，表示半开区间 '[startAt,endAt)'。'|null' 字段为必需且可空。每个未列出的字段都被拒绝，数组保留其声明的顺序。响应使用精确的资源形状：

- Appointment = {appointmentId:uuid,patientId:uuid,serviceTypeId:uuid,clinicianId:uuid,roomId:uuid,equipmentUnitIds:[uuid],startAt:timestamp,endAt:timestamp,state:HELD|CONFIRMED|CANCELLED|EXPIRED,expiresAt:timestamp,confirmedAt:timestamp|null,terminalAt:timestamp|null,sequence:int}
- AvailabilitySlot = {serviceTypeId:uuid,clinicianId:uuid,startAt:timestamp,endAt:timestamp,roomIds:[uuid],equipmentOptions:[[uuid]]}；选项按分配优先级排序
- WaitlistEntry = {waitlistEntryId:uuid,patientId:uuid,serviceTypeId:uuid,earliestStart:timestamp,latestEnd:timestamp,priority:int,state:WAITING|PROMOTED|WITHDRAWN,joinedAt:timestamp,appointmentId:uuid|null}
- ServiceType = {serviceTypeId:uuid,name:string,durationMinutes:int,requiredEquipmentTypes:[string]}

公共聚合路由为：

- 'GET /api/v1/appointments?limit&cursor' 和
  'GET /api/v1/appointments/:appointmentId'。
- POST /api/v1/appointments，请求体为 {patientId,serviceTypeId,clinicianId,startAt}；返回 201 HELD，并附带分配的诊室/设备和 expiresAt；若不可用则返回 409 SLOT_UNAVAILABLE，且不产生任何影响。
- POST /api/v1/appointments/:appointmentId/confirm，请求体为 {}，仅在 HELD 状态且未超过 expiresAt 时返回 CONFIRMED；若到达或超过 expiresAt，则原子性地过期并返回 APPOINTMENT_EXPIRED；若状态为 CONFIRMED 或 CANCELLED，则返回 APPOINTMENT_NOT_CONFIRMABLE；若预约已处于 EXPIRED 状态，则返回 APPOINTMENT_EXPIRED。
- POST /api/v1/appointments/:appointmentId/cancel，请求体为 {reason}，仅释放一次资源。
- POST /api/v1/waitlist-entries，请求体为 {patientId,serviceTypeId,earliestStart,latestEnd,priority}，要求 priority 为 0..100 的整数，返回 201 WAITING，并附带服务端分配的 joinedAt。
- GET /api/v1/availability?serviceTypeId&clinicianId&from&to 返回 {items:[AvailabilitySlot]}，按 startAt 排序，时间范围最多 31 天。
- GET /api/v1/resources/:resourceType/:resourceId/calendar?from&to 返回活跃的 Appointment ID 和半开区间。
- 'GET /api/v1/domain-events?aggregateId&afterSequence&limit' 按顺序返回已提交的事件。
- 'GET /api/v1/verification-snapshot' 需要 'Authorization: Bearer <ADMIN_TOKEN>'，并返回一个
  可序列化的快照 '{asOf:timestamp,resources:{...},work:[Work],events:[DomainEvent]}'。

### V1 验证快照

完整快照从单个 PostgreSQL 时间点读取；'asOf'、每个资源数组、'work'
和 'events' 必须描述同一数据库快照。V1 的 'resources' 对象仅包含以下键，
不得包含其他键：

- 'clinicians' 使用精确形状 'Clinician = {clinicianId:uuid,name:string,priority:int,availability:[{startAt:timestamp,endAt:timestamp}]}'，并按标量字段路径元组 'clinicianId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜排序依据。
- 'rooms' 使用精确形状 'Room = {roomId:uuid,name:string,priority:int,availability:[{startAt:timestamp,endAt:timestamp}]}'，并按标量字段路径元组 'roomId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜排序依据。
- 'equipmentUnits' 使用精确形状 'EquipmentUnit = {equipmentUnitId:uuid,equipmentType:string,priority:int,availability:[{startAt:timestamp,endAt:timestamp}]}'，并按标量字段路径元组 'equipmentUnitId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜排序依据。
- 'serviceTypes' 使用精确形状 'ServiceType'，并按标量字段路径元组 'serviceTypeId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜排序依据。
- 'patients' 使用精确形状 'Patient = {patientId:uuid,name:string}'，并按标量字段路径元组 'patientId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜排序依据。
- 'appointments' 使用精确形状 'Appointment'，并按标量字段路径元组 'appointmentId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜排序依据。
- 'waitlistEntries' 使用精确形状 'WaitlistEntry'，并按标量字段路径元组 'waitlistEntryId' 升序排序，然后以 RFC 8785 规范 JSON 作为决胜排序依据。

每个资源数组恰好包含其声明形状所指定的每个当前或不可变实例一次。每个列出的排序路径都解析为标量。标量顺序为：null 优先，然后 false 在 true 之前，整数按数值排序，其他所有字符串形式的标量按 UTF-8 字节排序。按完整元组升序排序，然后仅以 RFC 8785 规范 JSON 作为决胜排序依据。
递归省略所有名称以 'Token' 结尾的对象字段，适用于每个嵌套层级。

'Work' 恰好是
'{workId:uuid,kind:APPOINTMENT_EXPIRY|WAITLIST_PROMOTION,aggregateId:uuid,state:PENDING|LEASED|SUCCEEDED|FAILED|CANCELLED,terminal:boolean,attempt:int,leaseOwner:string|null,leaseExpiresAt:timestamp|null}'。
'kind' 恰好是 'APPOINTMENT_EXPIRY'、'WAITLIST_PROMOTION' 之一。两个租约字段仅在状态为
'LEASED' 时非空，在其他所有状态下均为 null。'terminal' 仅在状态为
'SUCCEEDED'、'FAILED' 或 'CANCELLED' 时为 true；终止的 Work 会被保留。
当没有匹配的 Work 具有 'terminal:false' 时，积压队列即被排空。'work' 数组按
workId 排序。

'events' 包含精确的领域事件对象，按 aggregateId、sequence、eventId 排序。对每个事件负载应用相同的递归 '*Token' 省略规则。省略认证和业务防护令牌、幂等键、原始 webhook 请求体、私有文件系统路径和机密信息。这是外部不变式查询面。

对于格式良好的请求，以下领域错误是穷尽的，此外还包括上述已发布的常见错误，以及 400 'INVALID_REQUEST'、400 'INVALID_CURSOR'、404 'NOT_FOUND' 和 409
'IDEMPOTENCY_CONFLICT'：

| HTTP | 代码 | 精确触发条件 |
| ---: | --- | --- |
| 409 | SLOT_UNAVAILABLE | 无法分配完整的资源包 |
| 409 | APPOINTMENT_EXPIRED | 确认请求到达时已到达或超过 expiresAt |
| 409 | APPOINTMENT_NOT_CONFIRMABLE | 预约已处于 CONFIRMED 或 CANCELLED 状态 |
| 409 | APPOINTMENT_NOT_CANCELLABLE | 预约已处于终止状态 |
| 409 | WAITLIST_HEAD_BLOCKED | 后续条目在符合条件的队首之前尝试提升 |
| 400 | INVALID_APPOINTMENT_INTERVAL | 开始时间对齐或服务类型时长无效 |

### 持久幂等性

每个变更操作都需要 'Idempotency-Key'，长度为 1-128 个可见 ASCII 字符。作用域为方法、规范
路径和键。在确认成功之前，持久化规范语义请求
指纹以及完整的状态/响应体。相同的重试（包括重启后或未知响应丢失后）返回原始状态和语义 JSON，且不产生第二次影响。使用不同语义重用键返回 409 'IDEMPOTENCY_CONFLICT'。并发相同请求收敛于一个结果；进程本地映射不具权威性。在基准测试期间不要过期记录，也不要在迁移期间重写已保存的重放响应体。

## 种子契约

'npm run db:seed -- --file <path>' 恰好接受：

'{schemaVersion:1,seedVersion,clinicians,rooms,equipmentUnits,serviceTypes,patients,appointments,waitlistEntries}; intervals are UTC, 15-minute aligned, non-overlapping per resource, and references must exist.'

成员模式是精确的：

- clinicians[] = {clinicianId:uuid,name:string,priority:int,availability:[{startAt:timestamp,endAt:timestamp}]}，且区间不重叠
- rooms[] = {roomId:uuid,name:string,priority:int,availability:[interval]}，每个设施内 priority 唯一
- equipmentUnits[] = {equipmentUnitId:uuid,equipmentType:string,priority:int,availability:[interval]}，每个类型内 priority 唯一
- serviceTypes[] 使用精确的 ServiceType 线上模式；patients[] = {patientId:uuid,name:string}；种子预约使用精确的 Appointment 模式，且不得重叠
- waitlistEntries[] 使用精确的 WaitlistEntry 模式；priority 为 0..100，PROMOTED 条目引用其唯一的 Appointment

'seedVersion' 是非空字符串，最长 64 个字符。导入器记录规范文件摘要。
相同版本和摘要是无操作重放；相同版本但内容不同则失败，返回
'SEED_VERSION_CONFLICT'。拒绝未知键、重复 ID、缺失引用、无效状态、破坏的
不变式、超出范围的整数和格式错误的时间。任何无效成员都会拒绝整个导入，
且不改变业务行、任务、幂等性或领域事件。

## 工作进程、事件和恢复

工作进程使用 'WORK_LEASE_SECONDS' 声明有界的持久租约。租约所有权必须在提交结果的短事务内再次证明。在等待 HTTP、文件、时钟或其他进程时，不要持有数据库事务。过期租约可重新声明，但过期令牌无法提交。

业务状态及其领域事件在一个事务中提交。事件字段为 'eventId'、'aggregateId'、
正整数 'sequence'、'type'、'occurredAt'、'schemaVersion:1' 和 'payload'。必需的事件类型：
`appointment.held`、`appointment.confirmed`、`appointment.cancelled`、`appointment.expired`、`waitlist.promoted`。对于每个 V1 事件，'payload' 恰好是 '{}'；后续 Manager 事件也使用 '{}'，除非
其已发布的契约明确提供另一种负载形状。回滚不产生事件。序列
按聚合连续。

调度器发送带有 'X-ClinicGrid-Event-Id' 和 'X-ClinicGrid-Event-Type' 的 JSON。网络错误、
超时和非 2xx 响应以有界退避无限重试。每次重试保持相同的
eventId 和语义负载。成功投递顺序为聚合序列递增。至少一次
投递可能重复请求；不得发明另一个事件身份。

### 受控恢复屏障

当 'TEST_BARRIER_URL' 为空时，不存在屏障请求。当两个测试变量都设置时，工作进程
在继续之前于 'worker.claimed'、'worker.effect-complete' 和 'worker.before-commit' 处 POST；调度器
在 'dispatcher.response-received' 处 POST。精确 JSON 为
'{schemaVersion:1,processRole:worker|dispatcher,point,workId,aggregateId,attempt,leaseTokenHash}'，头为
'X-Test-Barrier-Token: <TEST_BARRIER_TOKEN>'。ID 和点在重试间保持一致；
leaseTokenHash 是令牌的 SHA-256，而非令牌本身。204 响应释放进程。持有
响应暂停进程，且不打开数据库事务。连接丢失或非 204 响应每
100 毫秒以相同请求体重试，直到租约丢失或进程终止。仅接受 localhost URL。

## 真实 UI

提供桌面和移动端流程，用于创建 V1 聚合、查看集合和详情、
执行每个公开用户操作、观察异步过期任务进度、浏览事件和
历史证据，以及刷新后恢复。展示加载、空、验证、冲突、过期、
离线/重试、终止和权限错误状态。使用可见的语义控件、键盘导航、
关联标签、焦点管理和 WCAG AA 对比度。绝不允许要求使用开发者工具或直接 API 调用来完成主要流程。

## 项目自有验证

- 单元测试覆盖确定性策略、状态转换、规范化及边界值。
- 集成测试启动真实的 PostgreSQL 和真实的 HTTP 进程；它们从不调用内部服务。
- 浏览器端到端测试使用生产构建、真实 Chromium、真实 API/数据库/工作进程以及可见控件。
- 并发测试使用至少两个 API 进程和两个工作进程，针对一个 PostgreSQL 数据库。
- 恢复测试使用仅限测试的公共屏障来观察声明/提交或接收方/确认边界，然后发送 SIGKILL；随机睡眠不是故障控制。
- 性能测试针对以下固定间隔运行生产构建，报告 p50/p95/p99、吞吐量、成功变更、预期冲突、意外 5xx、积压排空及负载后不变量。

固定的 V1 兼容性能场景：

### 场景 'availability-read'

- 目标：200 次可用性查询/秒，p95 <= 180 毫秒
- 模式：'http'
- 方法：'GET'
- 路径：'/api/v1/availability?serviceTypeId=:serviceTypeId&clinicianId=:clinicianId&from=:from&to=:to'
- 设置：选择所有具有种子可用性的 serviceTypeId、clinicianId 对；对于每对，使用其最早的完整 UTC 日作为半开查询范围。
- 选择器：按 serviceTypeId 然后 clinicianId 字节序轮询符合条件的对；读取复用相同的不可变范围。
- 请求：无请求体；from 和 to 是毫秒 UTC 时间戳，恰好相隔 24 小时，且 to 为排他。
- 并发：64
- 预热秒数：10
- 测量秒数：60
- 成功：仅 200 响应，包含确定性排序的 AvailabilitySlot 项且无重叠分配计数。
- 阈值：至少 200 次成功响应/秒持续 60 秒，且 p95 <= 180 毫秒；意外 5xx = 0。
- 计时器：吞吐量窗口从预热后的第一个测量请求开始；每个延迟样本从请求分发到完整响应体结束。

### 场景 'competing-holds'

- 目标：30 次竞争持有请求/秒，p95 <= 600 毫秒
- 模式：'http'
- 方法：'POST'
- 路径：'/api/v1/appointments'
- 设置：创建 30 个预热和 180 个测量的可行热槽。为每个槽分配十个不同的患者 ID 进行竞争，且不重复使用患者-槽尝试。
- 选择器：轮询访问热槽；在推进到下一个槽之前，按字节序患者 ID 顺序并发发送其十个竞争者。
- 请求：{patientId,serviceTypeId,clinicianId,startAt} 针对确切热槽；每个请求都有新的 Idempotency-Key。
- 并发：64
- 预热秒数：10
- 测量秒数：60
- 成功：对于每个槽，恰好一个 201 HELD 是成功持有，其他九个响应恰好是 409 SLOT_UNAVAILABLE；请求速率延迟包括两种结果。
- 阈值：至少 30 次完整尝试/秒持续 60 秒，所有成功持有响应的 p95 <= 600 毫秒，且没有槽有零个或多个获胜者。
- 计时器：吞吐量窗口从预热后的第一个测量请求开始；每个延迟样本从请求分发到完整响应体结束。

### 场景 'expiry-and-promotion-recovery'

- 目标：重启后 45 秒内过期并提升 2,000 条到期记录
- 模式：'worker'
- 方法：'N/A'
- 路径：'work:APPOINTMENT_EXPIRY,WAITLIST_PROMOTION'
- 设置：种子数据恰好包含 1,000 条到期的 HELD Appointments 和 1,000 条符合条件的 WAITING 条目。将两个工作进程保持在 worker.claimed，发送 SIGKILL，等待租约过期，然后启动两个替换进程。
- 选择器：按 expiresAt、appointmentId 过期，并按优先级降序、joinedAt、waitlistEntryId 提升，无绕过。
- 请求：不发出测量的客户端请求；设置仅使用已发布的种子和公共 API，在工作进程计时器启动之前。
- 并发：2
- 预热秒数：0
- 测量秒数：45
- 成功：所有 1,000 条到期的 Appointments 恰好过期一次，所有 1,000 条符合条件的条目恰好提升一次，没有命名的 Work 保持非终态，且资源日历保持排他。
- 阈值：两个积压在替换工作进程生成后 <= 45 秒内排空；意外失败 = 0。
- 计时器：在两个替换进程生成时开始，仅在验证快照证明两种 Work 类型已排空且所有不变量成立时停止。

固定性能种子：seedVersion perf-v1 恰好包含 2,000 名临床医生、2,000 个房间、4,000 个设备单元、20 个服务类型、100,000 名患者、51,000 个预约和 1,000 个候补条目：50,000 个 Appointments 为 CONFIRMED，恰好 1,000 个为 HELD 且到期时间在测量开始时，恰好 1,000 个 Waitlist Entries 为 WAITING 且在测量开始时符合提升条件。

三个场景是从新迁移的数据库和上述确切种子独立运行的；
完成每个场景's Setup before its Timer begins. Mode 'http' means '方法' and '路径' 命名
唯一测量的公共请求操作，'concurrency' 是确切的闭环客户端计数。模式
'worker' 表示方法 'N/A'，'path' 命名测量的 Work 类型，'concurrency' 是确切的工作
进程计数。完全使用每个场景的选择器和请求；没有推断的混合工作负载。
运行恰好 'warmupSeconds' 未测量的秒数，然后恰好 'measureSeconds' 测量的秒数或直到
计时器声明的终止条件。有状态预热和测量的身份必须不相交。计数
完整 HTTP 响应体用于延迟。预期的已发布冲突单独报告，除非
场景的成功和阈值明确计数它们。

基准容器有 4 个逻辑 CPU 和 8 GiB RAM；PostgreSQL 16、Chromium、两个 API 进程、
指定的工作进程和一个调度器共享该限制。每个后续兼容二进制必须重新运行
这些相同的三个场景，不更改任何字段或阈值。

意外 5xx 计数必须为零。在满足延迟或吞吐量时，任何强制不变量为假
都是失败的性能运行。

## 范围外

- 医疗记录
- 计费
- 远程医疗
- 处方
- 患者认证

## 交接

保持 README 和 OpenAPI 最新。以发现优先的审查结束，并报告架构、模块和
进程所有权、公共接口、成功/失败数据流、事务和租约边界、
迁移、兼容性、运行的确切命令、测试和性能结果、恢复证据、已知
风险以及未运行的每项检查。不要声称实际未执行的检查。
