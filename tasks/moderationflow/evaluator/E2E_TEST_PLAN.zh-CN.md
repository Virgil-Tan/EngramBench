# ModerationFlow H-01～H-13 黑盒测试计划

Harness 仅从候选 workspace 外使用公开命令、HTTP/OpenAPI、Chromium、receiver、barrier、进程信号
和 verification snapshot；不导入候选源码、ORM、表或内部模块。

## H-01 干净构建与启动

干净安装、build、重复 migration；合法空 seed、同 digest replay、版本冲突、未知成员和跨 tenant 引用；
确认整批回滚，并分别启动 API、Worker、Dispatcher 和 production UI。

## H-02 合同、浏览器、隐私和租户隔离

验证 OpenAPI 3.1 全路径、严格 JSON/UUID/time/digest/range 校验、稳定错误和游标。Chromium 完成 Policy、
Content、Evidence、Review、Appeal、Audit 流程。两个 tenant 的私有证据、Case、Event、Work 和 Audit 不交叉。

## H-03 多级审核和冻结输入

在 Policy v1 下提交 Content 和 Evidence，打开 LEVEL_1，激活 v2 后再决策。Decision 必须引用 v1 与当时
Evidence head；ESCALATE 只创建一个 LEVEL_2，非升级结果直接终态，任何历史对象不被改写。

## H-04 严格原子拒绝

测试 malformed JSON、Idempotency 冲突、重复 category、非法 severity、future/stale Evidence head、跨 tenant
Policy/Evidence 和非法 LEVEL_2 ESCALATE。失败前后 snapshot 除时间外一致，无 Work/Event/Audit 残留。

## H-05 未知响应和持久 replay

在 API 已提交后丢弃响应，再串行、20-way、跨 API、重启后 replay。响应、ContentItem、Case、Evidence、
Work、Event 和 Audit identity 都相同；changed body 返回 `IDEMPOTENCY_CONFLICT`。

## H-06 Evidence、Review 和 Appeal 竞争

两个 API 竞争 append 相同 expected head、claim 同 Stage、提交相反 Decision、创建同一 Appeal。每个版本号、
Stage、Decision、Appeal 只有一个合法结果；失败者不产生孤儿数据或越过 lease。

## H-07 Worker SIGKILL 与 Stage lease

在 `worker.claimed` barrier 杀死 CASE_OPEN、STAGE_EXPIRY 或 APPEAL_OPEN Worker；等待 lease 后替代。旧 owner
不能提交，Work 排空，Stage/Decision/Audit 各一次。

## H-08 Outbox 未知 ACK

Receiver 收到完整事件后暂停 ACK 并杀 Dispatcher。替代者重试的 Event ID、aggregate sequence 与 canonical
body 完全相同；业务状态、AuditEntry 和 checkpoint 不重复。

## H-09 V1 到 FINAL 迁移

用 V1 创建 Policy、Evidence、LEVEL_1/2 Decision、Appeal、保存 replay 和 pending Work，再运行 FINAL migration。
所有 identity、引用、Event 和 audit chain 保留，新增 Manager 资源为空，旧 response replay 逐字相同。

## H-10 Policy Recall 行为

创建错误 PolicyVersion 和已终态案件，再激活 replacement 并创建 Recall。冻结集合与时间范围必须稳定；
每个 Case append 一条 Reconsideration，原 Evidence、Stage、Decision、Appeal、Audit 不变。建议变化只打开
一个人工 RECONSIDERATION Stage，不直接重写现实处置。

## H-11 Recall 并发、取消和恢复

两 API 32-way replay 创建 Recall，并发 cancel 与 Worker claim，期间 SIGKILL。每个 Run+Case 最多一条结果；
cancel 后未开始项停止、已提交项保留、旧 lease 不越界；UI、API 与 snapshot 进度一致。

## H-12 三条专属持续压力场景

固定 4 vCPU、8 GiB RAM、PostgreSQL 16、4 API、4 Worker，正式评分用完整规模：

1. `moderation-ingest`：50,000 submissions、concurrency 96，>=250 accepted/s、p95<=350ms、0 5xx；每 Case 冻结正确 Policy/Evidence。
2. `evidence-appeal-contention`：20,000 evidence append/review/Appeal operations、concurrency 64；每个聚合都由
   不同 API 竞争相同 Evidence head、相反 Decision 和同一 Appeal，>=150 terminal operations/s、p95<=800ms；
   无重复版本、Stage、Decision 或 Appeal。
3. `policy-boundary-recovery`：10,000 Cases 分布在一次 Policy 激活边界两侧，claim 后 SIGKILL 2 Worker，
   4 替代者 90 秒内排空；每个 Case 冻结接收提交时的 PolicyVersion，Stage 唯一且 audit digest chain 完整。

每条负载后验证 tenant isolation、Policy/Evidence 引用、Review/Appeal lineage、Work、Event 与 Audit；任一
阈值、5xx、重复、历史改写、泄漏或链断裂失败。

## H-13 项目测试真实性

从干净安装审计并运行 Unit、真实 PostgreSQL/HTTP Integration、production Chromium E2E、至少双进程
Concurrency、barrier+SIGKILL Recovery 和 Aggregate。拒绝 placeholder；确认 `test:perf` 包含三条全规模场景。

## Hard caps

无法 build/boot、Evidence/Policy/Decision/Audit 被改写、Review/Appeal 多终态、幂等重复效果、Recall 重复
Reconsideration、迁移丢历史、负载后不变量失败均触发 hard cap。读取 hidden assets 或逃逸隔离使样本无效。
