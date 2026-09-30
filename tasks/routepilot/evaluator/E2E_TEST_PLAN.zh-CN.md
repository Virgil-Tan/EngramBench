# RoutePilot 隐藏端到端测试计划

Harness 只从候选工作区外使用公开命令、HTTP/OpenAPI、真实 Chromium、本地 upstream double、receiver、barrier、进程信号和 verification snapshot；禁止导入候选源码、ORM、表或私有模块。所有断言均来自 README 或已发布 Manager 消息。

## H-01 构建、迁移、Seed 与启动

干净 checkout 安装/build，重复 migration，合法 seed、同 digest 重放、版本冲突及含歧义路线、跨租户引用、非法权重的整批失败；分别启动 API、Worker、dispatcher 和 production UI，检查健康、退出与孤儿进程。

## H-02 OpenAPI、Chromium、严格边界与隔离

验证 OpenAPI 3.1 覆盖所有路径；未知/重复字段、media type、UUID、URL、route pattern、权重、时间、body size 均按合同失败。Chromium 完成 route/release/rollback/窗口/熔断流程。两个 Tenant 的 API、cursor、snapshot、Event、Work 和 UI 不交叉，origin/credential/private header 不泄漏。

## H-03 路由、灰度、热更新与回滚

构造 literal、parameter、wildcard 和 header routes，发布 revision 并激活。对固定 affinity 重复请求，验证选择与公开 SHA-256 公式一致；激活新 release 前后的请求分别冻结完整旧/新配置，不出现混合状态。回滚生成新 version，历史请求仍指向原 release。

## H-04 歧义、非法配置与原子拒绝

提交重叠同优先级路线、断裂 backend 引用、权重不等于 10000、非法 policy、stale expected version、malformed JSON 和 Idempotency-Key 语义冲突。ConfigRelease、Work、Event、active 指针、窗口和请求审计完整不变。

## H-05 持久幂等与未知客户端响应

response shield 在 release 提交后丢弃响应，随后同 key 重试、20 路并发 replay、重启 API；身份、状态和正文稳定且仅一条 release/work/event。Gateway request replay 不重复计费或调用 upstream，变化 payload 返回 `IDEMPOTENCY_CONFLICT`。

## H-06 双 API 限流、灰度与熔断竞争

两个 API 64 路请求竞争最后一批 rate token，实收 upstream 调用恰好等于容量。固定 affinity 跨进程选择一致。并发失败恰好使 circuit OPEN；OPEN 零调用，HALF_OPEN 全局探针不超限，成功/失败竞争只产生一个合法 epoch/state。

## H-07 Worker 崩溃与上游未知结果

在 `worker.claimed`、upstream 已处理但响应丢失、circuit reconcile 提交前分别 SIGKILL。等待 lease 后替代 Worker，验证 stale lease 不激活旧 release、不增加第二个请求 identity、不重复计 rate token，Work 最终 terminal 且 breaker 状态可解释。

## H-08 Outbox 未知 ACK

receiver 返回 204 后、dispatcher 记录 ACK 前 SIGKILL，再启动替代进程。至少收到两次，但 event ID、aggregate sequence、canonical body 和签名输入相同；不同 aggregate 互不阻塞，正文无 origin、authorization/cookie、credential 或 token。

## H-09 V1 到 RegionalRollout 迁移

在 V1 创建 active/rolled-back release、rate/circuit window、gateway audit、pending Work 和已提交 replay，升级 FINAL。验证 GLOBAL region backfill，所有 V1 身份/响应/窗口/事件/lease/replay 不变，新 manager resources 初始一致，旧 Worker 不能绕过区域 authority。

## H-10 冻结阶段和健康门槛

创建带重复 region 的 Rollout，验证去重有序、target/prior release 和门槛冻结。Worker 只能依次激活 eligible stage；pause 后无新 region，resume 只继续剩余；健康阈值失败时不推进。每个 `(rollout,region)` 仅一 Stage。

## H-11 并发控制、取消与原子回滚

两个 API 并发 pause/resume/cancel/rollback，Worker 同时 claim 且被 SIGKILL。最终只有一个合法状态；cancel 不改已激活区域，rollback 原子恢复每个 prior release；旧 lease 不能重激活 target。重复控制 replay 和 Event 序列稳定，真实 UI 仍可操作。

## H-12 三条 RoutePilot 专属持续压力场景

正式模式固定运行，缩放只用于非计分 smoke：

1. `route-match-steady`：250 routes、20 weighted versions、64 clients、100,000 dispatches；>=700 request/s，p95<=180ms，unexpected 5xx=0，每个决策符合 frozen release、precedence 和 bucket。
2. `hot-tenant-limit`：两个 API 对固定 1,000-token windows 发 50,000 请求；>=500 request/s，p95<=250ms，每窗口恰好消费合法上限，拒绝零 upstream，replay 不重复消费。
3. `breaker-reload-recovery`：20,000 混合 upstream 结果与 100 次 release/rollback；kill 两个 claimed Worker，四个替代 Worker 60 秒内排空。无 partial release、HALF_OPEN 超发、重复 identity 或非终态 Work。

负载后重算 route/canary、rate/circuit conservation、active release 唯一性、request/attempt identity、regional stage、Event 顺序、Work 排空与租户隔离；记录 p50/p95/p99、throughput、status、RSS、恢复时间。

## H-13 项目自带测试真实性

实际执行 unit、真实 PostgreSQL/HTTP integration、production Chromium、双 API/四 Worker concurrency、barrier/SIGKILL recovery、aggregate 和 performance 命令。拒绝 `true`/`exit 0`、只查文件、mock DB、jsdom 或无真实负载/不变量的脚本。
