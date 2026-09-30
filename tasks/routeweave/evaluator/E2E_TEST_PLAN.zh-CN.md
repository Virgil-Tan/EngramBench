# RouteWeave 隐藏端到端测试计划

Harness 只使用公开命令、HTTP/OpenAPI、Chromium、receiver、barrier、信号和 verification snapshot，从候选工作区外黑盒验证；不导入候选源码、ORM、数据库表或私有模块。

## H-01 构建、迁移、Seed 与启动

干净安装/build、重复 migration，合法 seed/replay，以及 dangling hub、断裂 leg、重复 scanner ID、非法 projection 和跨租户引用的整批回滚；启动 API、Projection Worker、dispatcher 与 production UI。

## H-02 公共合同、浏览器和隔离

OpenAPI 3.1 覆盖所有路径；严格拒绝未知/重复字段、非法 UUID/时间/时区、断裂 route 和越界 body。Chromium 操作 shipment、timeline、loss/found/reassign。两个 Tenant 的 API/cursor/snapshot/Event/Work/UI 不交叉，敏感 carrier/facility/address 信息不泄漏。

## H-03 多段主流程与确定性投影

创建四段 Shipment，按正常和随机顺序提交 pickup/depart/arrive/deliver scans。Worker 后 snapshot 与从全部 ScanEvent 独立重放完全一致；依赖未满足时证据保留但不越段，最终只在最后 Hub DELIVERED。

## H-04 非法路线/扫描的原子拒绝

提交断裂 legs、重复 ordinal、跨租户 hub/carrier、旧 revision 的新进度、错误 hub/leg、非法 terminal 和 malformed JSON。Shipment、RoutePlan、ScanEvent、Projection、LossCase、Work、Event 完整不变；幂等语义冲突同样无部分写。

## H-05 扫描身份、响应丢失与持久 replay

在 ScanEvent 提交后丢弃响应，随后同 key 和 scannerEventId 重试、20 路并发、API 重启。只保留一个 evidence、一个逻辑 projection effect。相同 scanner ID 不同 body 返回 `SCAN_EVENT_CONFLICT`，原证据与 projection 不变。

## H-06 两 API 乱序、重复与丢件竞争

两个 API、四个 Worker 对同批 Shipment 发 shuffled scans、20% duplicates，并将 LOSS_REPORTED、FOUND、两条 reassign 与后续 old-plan scans 交错。每个 scanner identity 唯一，只有一个 LossCase outcome/current route，旧 evidence 不跨 fence，stored projection 等于 full replay。

## H-07 Projection Worker 崩溃恢复

在 `worker.claimed` 后 SIGKILL，并在 loss/reassign fence 前后重复。lease 过期后替代 Worker 排空；projectionVersion、current route、leg state、terminal state 和 Event 只表达一次真实效果，stale worker 无权覆盖。

## H-08 Outbox 未知 ACK

receiver 已 204、dispatcher 未记录 ACK 时 SIGKILL，替代进程重发相同 event ID/body/aggregate sequence。多 Shipment 顺序分别连续且互不阻塞，无凭据、私有设施数据、地址或路径泄漏。

## H-09 V1 到多件 Consignment 迁移

V1 中保留 delivered/in-flight/lost/reassigned journeys、pending projection、已提交 replay 与 events，升级 FINAL。每个 Shipment 获得稳定 legacy piece；原 tracking、route、scan、projection、loss、work、event 和响应身份不变，旧 API 继续工作。

## H-10 多件证据与聚合状态

创建含重复 pieceRef 的请求并验证原子拒绝；合法 Consignment 冻结去重 piece。对 pieces 交错 scans/loss/found，逐件投影正确，聚合状态只能由全体重算得到，PARTIALLY_DELIVERED/EXCEPTION 不受最后到达事件误导。

## H-11 共享改线、并发与恢复

两个 API 并发逐件/共享 reassign、scan 和 cancel，Worker 在 claim 后被杀。非法成员使共享操作整批失败；合法操作只产生一版 route 和每件 fence，替代 Worker 收敛。重复操作、Event 和真实 UI 稳定。

## H-12 三条 RouteWeave 专属持续压力场景

1. `shipment-plan-ingest`：100 hubs、20 carriers、四段路线、64 clients 创建 50,000 Shipments；>=300 shipment/s、p95<=400ms、unexpected 5xx=0，路线全连接且身份唯一。
2. `out-of-order-scan-storm`：20,000 Shipment、200,000 shuffled scans、20% exact duplicates、两个 API；>=600 mutation/s、p95<=500ms，重复不冲突，全量 replay 等于所有 projection。
3. `loss-reroute-recovery`：10,000 in-flight Shipment 并发 loss/found/reassign；kill 两个 claimed Worker，四个替代在 60 秒内排空。每个 Shipment 仅一个合法 current route/LossCase outcome，旧 plan evidence 不跨 fence。

压力后重算 route connectivity、scan uniqueness、projection equality、leg monotonicity、terminal uniqueness、loss/reassignment/Consignment fences、Event 顺序、Work 与 tenant isolation；记录延迟分位数、吞吐、状态、RSS 和恢复时间。

## H-13 项目自带验证

实际执行 unit、真实 PostgreSQL/HTTP integration、production Chromium、双 API/四 Worker concurrency、barrier/SIGKILL recovery、aggregate/replay 和 performance。拒绝占位、mock、jsdom、开发 UI 或只报告吞吐不验证轨迹的脚本。
