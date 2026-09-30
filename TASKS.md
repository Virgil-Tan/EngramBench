# EngramBench 任务说明

本文档介绍 EngramBench V2 的 30 个 Learning 与 13 个 Transfer/Test 任务（保持各自原任务顺序与业务需求）。

每个任务统一说明：

- 项目用途；
- 需要实现的核心功能；
- 希望形成或验证的通用 Skill 类型；
- 主要工程难点。

> Learning 任务的 Trajectory 可以进入 M1–M4，用于自然产生 Candidate Skill。Transfer/Test 任务只用于验证 Skill 是否能够跨领域迁移，默认不得回流 Skill Evolution。文中的 Skill 方向是课程目标，不是要求任务直接生成同名 Skill，更不能包含任务专属接口、状态名、固定阈值或隐藏测试答案。

## 一、Learning 任务（30 个）

### 1. LaunchPass（`launchpass`）

- **项目用途**：活动名额预留与购买系统，模拟用户先临时锁定有限名额，再确认、释放或等待自动过期。
- **核心功能**：活动与容量管理、Hold/Order 生命周期、幂等请求、自动过期、客户历史、真实浏览器 UI、OpenAPI、多实例并发与项目自测。
- **希望蒸馏的 Skill**：`database-owned-atomic-idempotency`、`durable-work-fenced-recovery`、`hermetic-artifact-and-test-isolation`、`cross-layer-acceptance-closure`。
- **主要难点**：热点容量不能超卖；确认、释放和过期必须互斥；多实例竞争要由数据库裁决；API、数据库、UI 与 E2E 必须真正打通。

### 2. SchemaHarbor（`schemaharbor`）

- **项目用途**：多租户版本化 Schema 发布平台，用于管理 Schema 草稿、异步校验、兼容性判断和不可变版本发布。
- **核心功能**：Schema 校验、依赖解析、compare-and-publish、不可变版本、异步 Worker、发布快照、恢复、OpenAPI 和运维 UI。
- **希望蒸馏的 Skill**：`contract-wire-triangulation`、`compatibility-seed-bootstrap-gate`、`ordered-authority-and-frozen-membership`、`point-in-time-snapshot-audit`。
- **主要难点**：并发发布不能产生版本空洞或双 Active；依赖图必须一致；旧版本与旧 seed 要兼容；读取快照需要稳定排序并避免 N+1。

### 3. ImportWorks（`importworks`）

- **项目用途**：大文件数据导入平台，支持可恢复上传、异步校验和原子提交。
- **核心功能**：分片上传与续传、文件摘要、行级校验、错误报告、导入预览、原子 commit、Work/Event、恢复、UI 和性能验证。
- **希望蒸馏的 Skill**：`contract-wire-triangulation`、`compatibility-seed-bootstrap-gate`、`database-owned-atomic-idempotency`、`durable-work-fenced-recovery`、`hermetic-artifact-and-test-isolation`。
- **主要难点**：大文件不能整体载入内存；重试不能重复导入；部分失败不能污染正式数据；上传、校验、提交和报告的跨阶段状态必须可恢复。

### 4. RuleBench（`rulebench`）

- **项目用途**：多租户确定性规则引擎，用于发布规则、执行评估、解释结果并比较两个规则版本。
- **核心功能**：受限 JSON 规则语言、静态冲突检查、规则优先级与短路、不可变版本、异步评估、ReplayRun、ComparisonRun 和结构化解释。
- **希望蒸馏的 Skill**：`replay-precedence-and-identity-scope`、`durable-work-fenced-recovery`、`deterministic-projection-and-reconciliation`、`independent-oracle-and-failure-frontier`。
- **主要难点**：相同输入必须得到相同决定和解释；乱序 Work、重放和崩溃不能改变结果；比较任务必须冻结 corpus 与版本，不能受后续发布影响。

### 5. AuctionGuard（`auctionguard`）

- **项目用途**：并发升价拍卖平台，覆盖竞价、截止时间延长和可恢复关拍。
- **核心功能**：拍卖创建与开启、幂等出价、单调赢家选择、反狙击延时、关拍 Worker、取消、审计时间线、UI 和压力验证。
- **希望蒸馏的 Skill**：`database-owned-atomic-idempotency`、`ordered-authority-and-frozen-membership`、`durable-work-fenced-recovery`、`contract-shaped-performance-and-backlog`。
- **主要难点**：热点拍卖下只能产生一个权威赢家；出价与截止时间更新必须原子；关闭、取消和最后一刻竞价存在终态竞争；关拍 Worker 崩溃后要安全接管。

### 6. QueueForge（`queueforge`）

- **项目用途**：基于租约的异步作业执行平台，模拟持久队列、Worker 调度和失败恢复。
- **核心功能**：作业入队、租约 claim、心跳、成功/失败、确定性重试、取消、公平调度、过期租约回收、事件和运维 UI。
- **希望蒸馏的 Skill**：`database-owned-atomic-idempotency`、`durable-work-fenced-recovery`、`contract-shaped-performance-and-backlog`、`bounded-progress-recovery`。
- **主要难点**：Worker 崩溃后任务不能丢失；旧 owner 不能提交；取消与完成存在竞争；重试次数、顺序和退避必须确定；大 backlog 要在期限内排空。

### 7. LedgerBridge（`ledgerbridge`）

- **项目用途**：持久化双重记账转账平台，覆盖转账、结算、取消和冲正。
- **核心功能**：账户与余额、双重分录、幂等转账、异步结算、取消/冲正、事务事件、对账快照、UI 和恢复验证。
- **希望蒸馏的 Skill**：`database-owned-atomic-idempotency`、`replay-precedence-and-identity-scope`、`durable-work-fenced-recovery`、`immutable-ledger-correction`。
- **主要难点**：借贷永远守恒；业务状态、分录、事件和幂等响应必须同事务；取消与结算、冲正与重复请求要收敛到唯一终态。

### 8. GeoPulse（`geopulse`）

- **项目用途**：多租户地理围栏平台，根据设备位置事件生成 ENTER、EXIT 和 DWELL 轨迹。
- **核心功能**：不可变 RegionVersion、位置事件接入、乱序重放、边界 hysteresis、版本激活、RegionBundle、批量空间查询、UI 和压力测试。
- **希望蒸馏的 Skill**：`ordered-authority-and-frozen-membership`、`durable-work-fenced-recovery`、`deterministic-projection-and-reconciliation`、`contract-shaped-performance-and-backlog`。
- **主要难点**：事件时间与设备序号形成双重顺序；迟到、重复和边界抖动必须收敛；一个设备评估不能混用两个区域版本；空间查询还要满足规模要求。

### 9. MediaDock（`mediadock`）

- **项目用途**：文件与媒体处理平台，覆盖分片上传、内容寻址、病毒扫描、转码和安全清理。
- **核心功能**：Multipart Upload、摘要验证、Blob 去重、租户隔离、扫描门禁、转码 promotion、临时下载、引用计数、mark/sweep cleanup 和 UI。
- **希望蒸馏的 Skill**：`durable-work-fenced-recovery`、`cross-store-atomic-publication`、`hermetic-artifact-and-test-isolation`、`cross-layer-acceptance-closure`。
- **主要难点**：数据库元数据与真实字节必须一致；Provider unknown ACK 不能导致双处理；清理不能删除仍被引用的 Blob；任意 crash point 后都要可恢复。

### 10. QuotaMesh（`quotamesh`）

- **项目用途**：多租户多维配额预留平台，在一个请求中原子申请多个资源维度。
- **核心功能**：Quota Pool、向量化 Reservation、Hold/Commit/Release/Expire、公平准入、层级配额迁移、恢复、快照、UI 和热点竞争测试。
- **希望蒸馏的 Skill**：`database-owned-atomic-idempotency`、`ordered-authority-and-frozen-membership`、`durable-work-fenced-recovery`、`contract-shaped-performance-and-backlog`。
- **主要难点**：配额向量必须全有或全无；每个维度都要守恒且非负；过期与提交存在终态竞争；热点池并发和层级迁移不能破坏容量。

### 11. BillForge（`billforge`）

- **项目用途**：支付、账单和月度结算系统，模拟外部支付 Provider 的不确定响应。
- **核心功能**：账单生成、整数金额、双重记账、支付与 unknown response、退款上限、月度结算、租户隔离、事件、Work、快照和 UI。
- **希望蒸馏的 Skill**：`database-owned-atomic-idempotency`、`replay-precedence-and-identity-scope`、`durable-work-fenced-recovery`、`immutable-ledger-correction`、`independent-oracle-and-failure-frontier`。
- **主要难点**：Provider 请求可能成功但响应丢失；重复回调不能产生第二次财务效果；退款与结算要保持账本守恒；测试必须从快照独立重算而非相信 API。

### 12. ClinicGrid（`clinicgrid`）

- **项目用途**：临床预约平台，一次预约需要同时锁定医生、房间和设备等多种资源。
- **核心功能**：可用性查询、多资源 Hold、确认/取消/过期、候补队列、公平 promotion、日历 UI、恢复和并发测试。
- **希望蒸馏的 Skill**：`database-owned-atomic-idempotency`、`ordered-authority-and-frozen-membership`、`durable-work-fenced-recovery`、`cross-layer-acceptance-closure`。
- **主要难点**：时间区间不能重叠；多个资源必须原子占用；过期与确认互斥；候补顺序不能被并发请求破坏；日历读取还需避免规模退化。

### 13. ConfigRelay（`configrelay`）

- **项目用途**：把期望配置可靠下发到大量 Agent 的配置分发系统。
- **核心功能**：不可变配置版本、Deployment、Agent Assignment、轮询下发、ACK、离线重放、取消、超越旧版本、Worker/Event 和 UI。
- **希望蒸馏的 Skill**：`ordered-authority-and-frozen-membership`、`durable-work-fenced-recovery`、`deterministic-projection-and-reconciliation`、`frozen-fanout-aggregate-closure`。
- **主要难点**：每个 Agent 只能接受正确顺序的权威版本；旧 ACK 不能覆盖新配置；离线 Agent 恢复后要收敛；整体 Deployment 只能在冻结成员全部终结后闭合。

### 14. DispatchBoard（`dispatchboard`）

- **项目用途**：配送派单系统，由多个 Courier 竞争领取 Offer 并推进 Delivery 生命周期。
- **核心功能**：Delivery 创建、Offer fanout、单赢家 claim、Offer 过期、Assignment 恢复、取件/送达/取消、团队迁移、事件和 UI。
- **希望蒸馏的 Skill**：`database-owned-atomic-idempotency`、`ordered-authority-and-frozen-membership`、`durable-work-fenced-recovery`、`frozen-fanout-aggregate-closure`、`bounded-progress-recovery`。
- **主要难点**：并发 claim 只能有一个赢家；Offer 过期与领取存在竞争；部分 fanout 和 Worker 崩溃不能丢 Courier；终态与团队迁移必须保持历史可审计。

### 15. NotifyRoute（`notifyroute`）

- **项目用途**：多渠道通知路由平台，根据偏好、同意状态、配额和 Provider 状态发送消息。
- **核心功能**：路由与内容选择、退订、租户/渠道限流、Delivery Work、Provider identity、unknown ACK 重试、事件、快照和 UI。
- **希望蒸馏的 Skill**：`database-owned-atomic-idempotency`、`replay-precedence-and-identity-scope`、`durable-work-fenced-recovery`、`contract-shaped-performance-and-backlog`、`frozen-fanout-aggregate-closure`。
- **主要难点**：接受请求后用户可能立即退订；多个 Worker 竞争同一配额；Provider 已接受但响应丢失时不能重复发送；fanout 的父状态不能提前完成。

### 16. RouteWeave（`routeweave`）

- **项目用途**：多段物流运输平台，根据不可变扫描证据生成确定性包裹轨迹。
- **核心功能**：运输段、扫描接入、轨迹 projection、丢件 fence、重派、恢复、verification snapshot、OpenAPI、UI 和规模验证。
- **希望蒸馏的 Skill**：`durable-work-fenced-recovery`、`deterministic-projection-and-reconciliation`、`point-in-time-snapshot-audit`、`contract-shaped-performance-and-backlog`。
- **主要难点**：扫描可能乱序、重复或迟到；重派不能改写历史；丢件和送达存在终态约束；完整 rebuild 与增量 projection 必须一致。

### 17. EdgeTwin（`edgetwin`）

- **项目用途**：设备数字孪生与控制平台，维护设备影子、离线命令和固件批量升级。
- **核心功能**：版本化 Device Shadow、Command Queue、过期 fence、乱序 ACK、离线重放、Firmware Campaign、恢复、UI 和压力测试。
- **希望蒸馏的 Skill**：`ordered-authority-and-frozen-membership`、`durable-work-fenced-recovery`、`deterministic-projection-and-reconciliation`、`frozen-fanout-aggregate-closure`。
- **主要难点**：desired/observed 状态需要单调收敛；迟到 ACK 不能覆盖新命令；Campaign 成员要冻结；离线与崩溃恢复不能重复或遗漏设备动作。

### 18. ReconcileHub（`reconcilehub`）

- **项目用途**：可审计的银行流水与内部账本对账平台。
- **核心功能**：Statement 批量导入、确定性匹配建议、人工确认/拒绝/忽略/冲正、金额守恒、审计时间线、快照、恢复和 UI。
- **希望蒸馏的 Skill**：`deterministic-projection-and-reconciliation`、`immutable-ledger-correction`、`point-in-time-snapshot-audit`、`independent-oracle-and-failure-frontier`。
- **主要难点**：批次导入必须原子；相同数据要产生相同匹配；并发人工决策只能有一个权威结果；纠正不能改写历史金额事实。

### 19. MergeBoard（`mergeboard`）

- **项目用途**：版本化协作文档变更与合并平台。
- **核心功能**：不可变 Revision、Change 提交、乐观并发、操作 replay、确定性冲突、分支、快照压缩、恢复、UI 和历史读取。
- **希望蒸馏的 Skill**：`ordered-authority-and-frozen-membership`、`deterministic-projection-and-reconciliation`、`point-in-time-snapshot-audit`、`independent-oracle-and-failure-frontier`。
- **主要难点**：Revision 必须严格递增；重放不能重复应用操作；同一冲突必须得到相同结论；snapshot compaction 后仍要能完整恢复历史。

### 20. EvidenceChain（`evidencechain`）

- **项目用途**：法证物证清单、身份核对和保管链管理平台。
- **核心功能**：Manifest、批量扫描接入、物证身份 reconciliation、唯一 Custody、验证/隔离、拆分 lineage、离线 replay、时间线、快照和 UI。
- **希望蒸馏的 Skill**：`coverage-ledger-and-slice-reentry`、`ordered-authority-and-frozen-membership`、`point-in-time-snapshot-audit`、`independent-oracle-and-failure-frontier`、`cross-layer-acceptance-closure`。
- **主要难点**：批量接入全有或全无；同一物证不能同时属于两个 Custody；离线扫描重放要保持身份稳定；拆分 lineage 和审计链必须可追溯。

### 21. ArtifactVault（`artifactvault`）

- **项目用途**：基于内容寻址的构建产物发布平台，实现原子上传、验证和不可变 Release。
- **核心功能**：流式 Upload、Digest 验证、去重、Artifact Version、Release、数据库与文件系统协调、失败清理、恢复、下载和 UI。
- **希望蒸馏的 Skill**：`contract-wire-triangulation`、`compatibility-seed-bootstrap-gate`、`cross-store-atomic-publication`、`hermetic-artifact-and-test-isolation`、`cross-layer-acceptance-closure`。
- **主要难点**：数据库记录和真实文件必须原子可见；重复内容要安全去重；发布后版本不可变；崩溃不能留下可见缺文件或不可回收孤儿。

### 22. ExportVault（`exportvault`）

- **项目用途**：隐私数据导出与保留平台，为大规模数据生成可验证、可下载、可过期清理的 Export。
- **核心功能**：一致性快照、分片生成、Digest、Range Download、取消/失败/过期、对象清理、恢复、兼容迁移、UI 和大规模性能验证。
- **希望蒸馏的 Skill**：`durable-work-fenced-recovery`、`cross-store-atomic-publication`、`point-in-time-snapshot-audit`、`hermetic-artifact-and-test-isolation`、`frozen-fanout-aggregate-closure`。
- **主要难点**：导出必须对应同一时点；分片全部完成后才能 READY；过期与下载/生成存在竞争；数据库、对象字节和 Digest 必须一致。

### 23. FirmwareFleet（`firmwarefleet`）

- **项目用途**：设备固件 Campaign 下发、安装确认和失败回滚平台。
- **核心功能**：Campaign、Wave、Device Update、命令轮询、批量报告、ACK、离线 replay、租约、取消、失败回滚、恢复、事件和 UI。
- **希望蒸馏的 Skill**：`ordered-authority-and-frozen-membership`、`durable-work-fenced-recovery`、`frozen-fanout-aggregate-closure`、`bounded-progress-recovery`。
- **主要难点**：设备状态必须有序推进；旧命令和迟到报告不能回退状态；Wave 成员冻结且逐批推进；失败与回滚在进程重启后仍要收敛。

### 24. ConfigOrbit（`configorbit`）

- **项目用途**：多环境配置中心，管理不可变 Revision、灰度发布、回滚和跨环境 PromotionTrain。
- **核心功能**：配置版本、确定性灰度、Rollout、Rollback、客户端 fetch/cache fence、多实例竞争、Worker/outbox、环境 promotion、UI 和性能门禁。
- **希望蒸馏的 Skill**：`contract-wire-triangulation`、`compatibility-seed-bootstrap-gate`、`ordered-authority-and-frozen-membership`、`durable-work-fenced-recovery`、`deterministic-projection-and-reconciliation`。
- **主要难点**：同一环境只能有一个权威版本；灰度分桶必须确定；客户端缓存不能越过版本 fence；跨环境 promotion 要冻结输入并可安全恢复。

### 25. EntitlementHub（`entitlementhub`）

- **项目用途**：订阅与权益管理平台，覆盖试用、升级降级、过期、退款和组织席位池。
- **核心功能**：Subscription、Entitlement、实时访问判定、Provider 事件、退款撤权、组织 Seat Pool、并发分配、恢复、快照和 UI。
- **希望蒸馏的 Skill**：`database-owned-atomic-idempotency`、`replay-precedence-and-identity-scope`、`ordered-authority-and-frozen-membership`、`durable-work-fenced-recovery`、`immutable-ledger-correction`。
- **主要难点**：乱序 Provider 事件不能回退权益；退款和撤权必须及时且幂等；同一 Seat 不能被重复分配；多实例竞争与历史 replay 要保持一致。

### 26. ModerationFlow（`moderationflow`）

- **项目用途**：内容审核、人工复核、申诉与复议平台，保留完整的策略和证据历史。
- **核心功能**：Policy Version、Evidence、自动判定、人工 Review、Appeal/Re-review、唯一终态、审计、Work/Event、恢复、UI 和快照。
- **希望蒸馏的 Skill**：`coverage-ledger-and-slice-reentry`、`ordered-authority-and-frozen-membership`、`deterministic-projection-and-reconciliation`、`bounded-progress-recovery`。
- **主要难点**：决定必须绑定当时的策略和证据版本；并发审核只能有一个终态；申诉不能改写原始决定；策略切换和崩溃恢复仍需保留完整解释链。

### 27. FraudLens（`fraudlens`）

- **项目用途**：实时反欺诈平台，支持规则发布、在线评分、人工复核和紧急回滚。
- **核心功能**：不可变 Rule Version、确定性打分、风险 Decision、人工 Review、Rollback、事件审计、Work、快照、UI 和并发验证。
- **希望蒸馏的 Skill**：`contract-wire-triangulation`、`ordered-authority-and-frozen-membership`、`deterministic-projection-and-reconciliation`、`independent-oracle-and-failure-frontier`。
- **主要难点**：相同事实与版本必须得到相同分数；发布和回滚不能产生双 Active；人工与自动决定存在终态竞争；测试需要独立重算而不能复制实现公式。

### 28. IdentityMesh（`identitymesh`）

- **项目用途**：身份、Session、设备信任、签名密钥和撤销传播平台。
- **核心功能**：登录与 Session Refresh、Token Family、Device Trust、Signing Key Rotation、吊销传播、签名验证、Audit Hash Chain、Work/Event、快照和 UI。
- **希望蒸馏的 Skill**：`compatibility-seed-bootstrap-gate`、`database-owned-atomic-idempotency`、`ordered-authority-and-frozen-membership`、`durable-work-fenced-recovery`、`credential-rotation-revocation-and-signing`。
- **主要难点**：Refresh Token reuse 要触发正确的 family revoke；旧 key、跨设备 token 和已撤销凭证必须 fail closed；轮换与业务请求并发时只能有一个合法 generation；secret 不得进入日志或快照。

### 29. SeatReserve（`seatreserve`）

- **项目用途**：票务与座位预留平台，协调有限座位、冻结价格和不确定支付。
- **核心功能**：Seat Inventory、Hold、Order、Checkout、价格冻结、Payment unknown、取消/过期、Worker/Event、恢复、快照和真实 UI。
- **希望蒸馏的 Skill**：`database-owned-atomic-idempotency`、`replay-precedence-and-identity-scope`、`ordered-authority-and-frozen-membership`、`durable-work-fenced-recovery`、`contract-shaped-performance-and-backlog`。
- **主要难点**：每个 Seat 只能有一个 owner；Hold、Order 和 Payment 必须一致；支付成功但响应丢失不能重复扣款；热门座位高并发下仍要守恒。

### 30. RoutePilot（`routepilot`）

- **项目用途**：完整 API 网关控制面与数据面，用于发布路由并可靠传播到运行实例。
- **核心功能**：Route/Revision、控制面 API、数据面请求转发、不可变配置、后台传播、实例 ACK、事件分发、PostgreSQL 权威状态、OpenAPI、UI 和性能验证。
- **希望蒸馏的 Skill**：`compatibility-seed-bootstrap-gate`、`ordered-authority-and-frozen-membership`、`durable-work-fenced-recovery`、`hermetic-artifact-and-test-isolation`、`cross-layer-acceptance-closure`。
- **主要难点**：控制面发布与数据面生效存在异步边界；旧实例 ACK 不能覆盖新版本；路由切换要原子且可回滚；多进程、冷启动和高负载下仍要保持一致。

## 二、Transfer/Test 任务（13 个）

这些任务只做执行评测，不回流 Skill Evolution。完整业务范围以每题原 README 与 Manager 文档为准；下面是导航摘要，不可替代需求。

| 任务 | 难度分组 | 项目与主要难点 |
| --- | --- | --- |
| MeterSettle (`metersettle`) | 标准 | 用量事件结算；水位、修订、迟到数据与金额重算一致性 |
| DockChain (`dockchain`) | 标准 | 港口靠泊与保管链；泊位时间冲突、移动接力、批量调度与恢复 |
| IncidentRelay (`incidentrelay`) | 标准 | 事故告警与升级；值班轮转、确认、SLA、通知与恢复 |
| FlagFoundry (`flagfoundry`) | 标准 | 功能开关及发布；不可变配置、确定性分流、Rollout 和结果统计 |
| CarbonLedger (`carbonledger`) | 标准 | 碳信用预留与核销；数量守恒、拆分 lineage、不可变证书与恢复 |
| ParcelFlow (`parcelflow`) | 标准 | 多仓订单履约；库存原子分配、取消/发货竞争、Shipment 与 Webhook |
| ColdChainControl (`coldchaincontrol`) | 超难 | 冷链控制；配置、签名遥测、货件投影、异常与可靠通知 |
| CreatorRightsExchange (`creatorrightsexchange`) | 超难 | 媒体商业化；上传、支付、License、版税、争议与跨存储一致性 |
| AccessSentinel (`accesssentinel`) | 超难 | 特权访问；会话、信任、风险、审批、撤销与审计 |
| CommerceCommand (`commercecommand`) | 超难 | 全渠道交易；报价、库存、支付、履约、权益与账本 |
| EscrowGuard (`escrowguard`) | 中高难 | 里程碑托管；放款、退款、争议、过期和多受益人结算 |
| PermitForge (`permitforge`) | 中高难 | 版本化审批；冻结 Quorum、Reviewer 租约、补件与截止恢复 |
| CapacityLease (`capacitylease`) | 中高难 | 时间窗口容量租赁；Hold、排队 Promotion、跨 Pool Gang 与并发守恒 |

对应 V2 起始工程在 `task-packages/v2/<id>/workspace/`。九题迁移与使用说明见 [Transfer V2](docs/transfer-v2.zh-CN.md)，四个超难任务记录见 [Superhard V2](docs/superhard-v2.zh-CN.md)。
