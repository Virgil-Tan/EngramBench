# FraudLens H-01～H-13 黑盒测试计划

Evaluator 位于候选 workspace 外，只使用公开命令、HTTP/OpenAPI、Chromium、Webhook receiver、
barrier、进程信号和 verification snapshot。不得导入候选源码、ORM、数据库表或私有模块。

## H-01 干净构建、迁移、Seed 和角色启动

在干净 checkout 安装、build、重复 migration；执行合法空 seed、同 digest 重放、冲突和未知成员；
验证原子回滚，并分别启动 API、Worker、Dispatcher 和 production UI。

## H-02 合同、浏览器和租户隔离

验证 OpenAPI 3.1 覆盖全部公开路由，未知字段、非法 UUID/时间/整数/规则和 media type 返回稳定错误。
用 Chromium 完成规则、事件、解释、复核和回滚流程；两个 tenant 的 API、游标、UI、Event、Work 和
snapshot 不得交叉暴露。

## H-03 评分主流程和冻结版本

激活含多条规则的版本，提交匹配与不匹配事件，等待 Worker。按公开顺序重算 RuleHit、score、阈值、
recommendation 和 Decision；随后激活新版本，确认旧 Assessment 仍引用原版本且数据完整。

## H-04 严格拒绝与原子性

发送 malformed JSON、同 Idempotency-Key 不同 body、非法阈值、跨 tenant 引用、嵌套
attributes 和溢出 score。每次失败前后 snapshot 除 `asOf` 外完全一致，不产生 Work、Event 或 Audit。

## H-05 未知响应和持久幂等

Response shield 在 API 已提交后断开连接；随后执行串行、20-way 并发和 API 重启重放。状态、响应正文、
RiskEvent、Assessment、Work、Event 和 Audit 身份必须相同，语义冲突返回 `IDEMPOTENCY_CONFLICT`。

## H-06 双 API 事件与复核竞争

两个 API 同时接受相同 externalEventId，并让多个 reviewer claim 和提交相反终态。只允许一个 RiskEvent、
Assessment、ReviewCase 和最终 ReviewDecision；失败者不能留下部分 Audit 或改变 frozen RuleHits。

## H-07 Worker lease 崩溃恢复

在 `worker.claimed` barrier 后 SIGKILL 当前 Assessment 或 Review-expiry Worker，等待公开 lease 过期并启动
替代者。旧 owner 不能提交，Work 最终 terminal，业务效果和 Audit 各一次。

## H-08 Outbox 未知 ACK

Receiver 已收到完整 Event 后暂停 ACK 并 SIGKILL Dispatcher；替代者重发时 Event ID、aggregate sequence
和 canonical body 必须逐字节相同，业务状态与 Audit 不重复。

## H-09 V1 到 FINAL 兼容迁移

在 V1 snapshot 创建规则、事件、Assessment、Review 和保存的 idempotent response，再运行 FINAL migration。
验证所有 identity、历史 score/hit、replay、pending Work、Event 与 audit chain 不变，新增资源为空。

## H-10 Manager 补救行为

激活高误杀版本、生成受影响 Assessment、回滚并创建 RemediationRun。创建时冻结集合；Worker 使用恢复
版本重算，为冻结集合的每个 Assessment append 恰好一条 AssessmentCorrection/NO_CHANGE，不改写任何
原事实。GET 查询、计数、状态、Work 和 UI 必须与 snapshot 一致。

## H-11 补救并发、取消和恢复

两个 API 32-way replay 创建同一批次，在 `worker.claimed` barrier 竞争取消并 SIGKILL Worker，再由替代
Worker 排空。每个 Run+Assessment 最多一个结果；取消后未开始条目不再处理，已提交 correction 保留，
旧 lease 不能越过 cancel fence，冻结的 V1 事实逐字不变。

## H-12 三条专属持续压力场景

固定环境为 4 vCPU、8 GiB RAM、PostgreSQL 16、4 API、4 Worker；正式评分必须使用完整规模：

1. `risk-event-ingest`：100,000 个 unique events、concurrency 96，至少 300 accepted/s、p95 <= 300ms、0 5xx；重算全部分数与版本引用。
2. `hot-subject-review`：20,000 个事件集中到 100 个 subject，concurrency 64，至少 180 terminal decisions/s、p95 <= 700ms；无重复 Decision、超租户数据或 lease 越权。
3. `rollback-boundary-recovery`：10,000 个 RiskEvent 分布在一次 rollback 提交边界两侧，在 claim barrier
   SIGKILL 2 个 Worker，用 4 个替代者在 90 秒内排空；每个 Assessment 必须冻结接收提交时的 RuleVersion，
   Work 全部终态且 Audit/Event 连续。

任一阈值、5xx、Work 未排空、重复结果、历史改写、版本错误、租户泄漏或审计链断裂均失败。

## H-13 项目自有测试真实性

审计并从干净安装运行 `test:unit`、`test:integration`、`test:e2e`、`test:concurrency`、
`test:recovery` 和 `test:all`；拒绝占位脚本。确认浏览器使用 production build、Integration 使用真实
PostgreSQL/HTTP、Concurrency 使用至少两个进程、Recovery 使用 barrier+SIGKILL，`test:perf` 确实包含
上述三条完整场景。

## Hard caps

以下任一项将 correctness 限制为不及格：无法 build/boot；历史 Assessment、RuleHit、Decision 或 Audit
被修改；同一 externalEvent/idempotency identity 产生多个效果；同一 Review 或 correction 多个终态；
rollback 使用错误版本；迁移丢数据；负载后不变量失败。读取 hidden assets 或逃逸隔离边界使样本无效。
