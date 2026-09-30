# NotifyRoute 隐藏测试计划

这是候选工作区之外的 Harness 黑盒测试合同。测试只能使用 README 公布的命令、HTTP/OpenAPI、
Chromium、Email/SMS Provider double、Webhook receiver、barrier、进程信号和 verification snapshot。
不得导入候选源码、ORM、数据库表或私有模块。

## H-01 安装、迁移、Seed 与启动

从干净 checkout 安装并执行 build、重复 migration、合法 seed、同 digest 重放、冲突版本和非法成员。
验证整批导入原子回滚，API、Worker、Dispatcher 和生产 UI 都能独立启动、健康退出且不遗留进程。

## H-02 公共合同、浏览器和隔离

验证 OpenAPI 3.1 覆盖全部公开路径，未知字段、错误 media type、非法 UUID/时间/URL/号码和未知模板
变量返回稳定错误。真实 Chromium 操作 Notification、Delivery、Endpoint、Suppression 和 RateLimit 页面。
创建两个 Tenant，验证 API、游标、snapshot、Event、Work 和 UI 不会交叉暴露联系人或业务状态。

## H-03 模板冻结、路由和 fallback

建立 Email -> SMS -> Webhook 的三步策略，接受 Notification 后修改 TemplateVersion、Endpoint 和
RoutePolicy。验证已接受请求仍使用冻结版本；只有前一步耗尽或被抑制才启用下一步；成功终止后迟到
Receipt 不会再启动 fallback。重算每个 Notification 的 Delivery routeOrdinal 和最终状态。

## H-04 严格渲染与原子拒绝

提交缺失变量、未知变量、重叠 ordinal、非法 retry、跨租户 endpoint、溢出窗口和无法规范化的地址。
请求必须完整失败，Notification、Delivery、Work、Event、配额和 Suppression 都不能出现部分状态。
相同 Idempotency-Key 的语义冲突也必须保持完整 snapshot 不变。

## H-05 幂等、dedupe 与响应丢失

在 API 响应提交后主动断开连接，随后以同 key 重试、20 路并发重放并重启 API。验证返回身份和正文
稳定，只有一条 Notification。再用同 dedupeKey 的相同和不同 canonical payload 验证稳定 replay 与
`DEDUPE_CONFLICT`，且 Provider 尚未发生重复外部调用。

## H-06 退订、配额和发送竞争

在两个 API 与四个 Worker 间同时执行发送 claim、ALL/channel/category unsubscribe、配额最后一个
token 和窗口 rollover。使用 barrier 将 Worker 停在外部调用前，先提交退订，再释放旧 lease；旧
Worker 必须被 fence。对热 Recipient 发起 1,000 路竞争，Provider 实收不得超过 Tenant 和 Recipient
中更严格的限额，剩余 Work 有准确 `nextAttemptAt`，不得丢失或忙循环。

## H-07 Provider UNKNOWN 与 Worker 崩溃

分别在 `worker.claimed`、Provider 已接受但响应丢失、Receipt 入库前 SIGKILL Worker。等待 lease
过期并启动替代 Worker，验证 timeout/connection reset 进入 UNKNOWN，reconcile 不产生第二次逻辑
发送，重复和乱序 Receipt 收敛到同一 Provider identity。Bounce/complaint 必须在新发送前禁用 endpoint
并提交 Suppression。每个终态 Work、Attempt 和 Event 都只能表达一个真实效果。

## H-08 Outbox 未知 ACK

Dispatcher 收到 receiver 204 后在记录 ACK 前 SIGKILL，再启动替代 Dispatcher。receiver 至少收到两次，
但 Event ID、aggregate sequence、canonical body 和签名输入完全相同；跨多个 aggregate 时各自顺序连续，
一次失败不能阻塞其他 aggregate，Event 中不得包含 contact secret 或 Provider credential。

## H-09 V1 到 Manager 迁移

在 V1 workspace 创建 Notification、UNKNOWN Delivery、Active Suppression、限流窗口、待恢复 Work 和已
提交的幂等结果，升级到 FINAL migration。验证所有公开身份、状态、计数、Receipt、Event、lease 和 replay
不变；新增 Campaign 表为空；旧 Worker 不能绕过新 schema 或重发已有 Delivery。

## H-10 Campaign 冻结受众与唯一 fan-out

创建包含重复 recipientId 的 Campaign，在创建后新增 Recipient、修改 Template/RoutePolicy 并让部分
Recipient 退订。验证 audience snapshot 已冻结和去重，每个 `(campaignId, recipientId)` 最多一条
CampaignRecipient 和 Notification；发送前仍遵守更新后的 Suppression fence。pause 后不再创建新项目，
resume 只继续剩余受众，已完成项目不重复。

## H-11 Campaign cancel、并发控制与恢复

两个 API 并发发起 pause、resume、cancel，Worker 同时 claim fan-out，并在 claim 后 SIGKILL。验证状态机
只允许一个合法终态，CANCELLED fence 阻止旧 lease 和替代 Worker 生成新的 Notification 或开始新的外部
发送，Provider 已接受的 Delivery 保留真实状态。重复 cancel 和创建 replay 身份稳定，Event 顺序连续。

## H-12 三条专属持续压力场景

正式模式固定运行以下三个 NotifyRoute 专属场景；缩放模式只允许 smoke，不计入正式得分：

1. `notification-ingest`：100,000 个 Recipient 上持续接受并冻结混合路由 Notification，64 并发，
   throughput >= 300 notification/s，p95 <= 450ms，unexpected 5xx=0，dedupe 与 route identity 唯一。
2. `hot-recipient-quota`：两个 API、四个 Worker 对 1,000 个热 Recipient 产生 50,000 次竞争，至少
   250 mutation/s，p95 <= 600ms；每个 UTC 窗口不得超出 Tenant 或 Recipient 限额，窗口后 Work 可继续。
3. `delivery-recovery`：准备 10,000 个待发送 Delivery，在 barrier 后 SIGKILL 两个 Worker，再用四个
   Worker 接管；60 秒内排空 eligible Work，逻辑 Delivery 重复率为 0，UNKNOWN 不重发，unexpected 5xx=0。

压力后重新计算：每个 Notification 的 route 和终态、每个 Delivery 的 attempt 序列、Provider message
唯一性、Suppression fence、窗口配额、CampaignRecipient 唯一性、Event 顺序、Work 排空、租户隔离和
敏感信息零泄漏。记录 p50/p95/p99、throughput、状态分布、RSS 和恢复耗时。

## H-13 项目自带验证

检查项目是否提供并实际运行 unit、真实 PostgreSQL integration、production Chromium、双 API/四 Worker
concurrency、barrier/SIGKILL recovery、aggregate/invariant 和 performance 命令。拒绝总是通过、只检查
文件存在、mock 数据库、开发服务器替代 production build 或没有真实负载测量的占位脚本。
