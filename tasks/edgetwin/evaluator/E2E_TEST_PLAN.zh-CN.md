# EdgeTwin 隐藏端到端测试计划

Harness 从候选工作区外只用公开命令、HTTP/OpenAPI、真实 Chromium、device client、receiver、barrier、进程信号与 verification snapshot。禁止导入候选源码、ORM、表或私有模块。

## H-01 构建、迁移、Seed 与启动

干净安装/build、重复 migration、合法 seed/replay；对版本倒退、重复 sequence、expired-delivered command、digest mismatch、跨租户引用和未知成员验证整批回滚。分别启动 API、Worker、dispatcher 和 production UI。

## H-02 OpenAPI、Chromium、严格边界与隔离

验证 OpenAPI 3.1 全路径和严格 JSON；覆盖 UUID/时间/digest、Merge Patch 深度/大小/危险键、body 限制。Chromium 完成 shadow、offline command、poll/receipt、firmware/campaign。两个 Tenant 的 API/cursor/snapshot/Event/Work/UI 不交叉且无 device secret、signing material 或 endpoint 泄漏。

## H-03 Shadow、离线命令和升级主流程

更新 desired，给 offline Device 创建 Command，connect/poll 后提交 ACK receipt 与 reported patch；检查版本、delivery identity、状态与 event/work。创建 Campaign 并让目标通过 matching firmware digest receipt 完成；一次结果对应一个 target/command。

## H-04 Patch、引用与终态原子拒绝

提交 stale/skipped version、危险/过深/过大 patch、cross-tenant device、invalid expiry、revoked firmware、重复 target、malformed JSON 和幂等冲突。Shadow、Command、Receipt、Campaign、Target、Work、Event 完整不变。

## H-05 响应丢失、幂等与 receipt identity

response shield 丢弃 committed Command 响应，再同 key 重试、20 路并发和 API 重启；只一条 command/delivery identity。对 receiptId 和 deviceSequence 分别验证相同 replay 与不同 body conflict，不重复应用 reported patch。

## H-06 双 API patch、poll、expiry 与 receipt 竞争

两个 API 同时争用 expected version；只一个 patch 成功。barrier 将 poll 停在 delivery 前，使数据库时间跨 expiry，并发 cancel/receipt；terminal fence 胜出后 stale lease 不投递。shuffled receipts 不回退 reportedVersion 或 command terminal state。

## H-07 Worker 崩溃和 Campaign 恢复

在 command dispatch、expiry、upgrade fan-out、receipt project 的 `worker.claimed` 分别 SIGKILL。lease 过期后替代 Worker 排空；每设备一 target/command，expired 不投递，matching digest 才成功，stale receipt 保留但不覆盖。

## H-08 Outbox 未知 ACK

receiver 返回 204 后、dispatcher ACK 记录前 SIGKILL。替代进程至少重发一次，但 event ID/body/aggregate sequence/签名输入相同，多设备互不阻塞，正文无 secrets、private endpoints 或 signing material。

## H-09 V1 到 DeploymentWave 迁移

准备 offline/expired/acknowledged commands、out-of-order receipts、running Campaign、pending Work、已提交 replay 和 events，升级 FINAL。V1 Campaign 获得 stable legacy wave；所有身份/响应/版本/terminal state/event/work 不变，旧 Worker 不能绕过 wave fence。

## H-10 冻结 wave、健康门槛与自动暂停

创建有重复设备/非法阈值的 wave 请求验证原子拒绝。合法 Campaign 冻结有序成员；只 matching digest receipt 计成功，同时最多一个 RUNNING。观察时间和失败率满足后才推进，越阈值 durable PAUSED，resume 仅处理剩余目标。

## H-11 并发 cancel/rollback 和恢复

两个 API 并发 pause/resume/cancel/rollback，Worker 同时 claim 并被 SIGKILL。最终状态合法；旧 lease 不推进后续 wave；rollback 为已成功设备建立一个 prior-firmware 补偿 Target，不重复；已执行命令不伪装撤回。Event、replay 与真实 UI 稳定。

## H-12 三条 EdgeTwin 专属持续压力场景

1. `shadow-patch-ingest`：100,000 devices、64 clients 更新 desired/reported；>=500 patch/s、p95<=300ms、unexpected 5xx=0，每个版本连续且 stored value 等于 replay。
2. `offline-command-expiry`：50,000 commands 在 online/offline 与 expiry barrier 竞争；>=350 mutation/s、p95<=450ms，无 expired command 被投递，eligible command 最多一个逻辑 delivery identity。
3. `fleet-upgrade-recovery`：冻结 10,000 devices，注入 shuffled duplicate receipts，在 `worker.claimed` kill 两个 Worker，四个替代 60 秒排空；每设备一个 target/command，无 false success，Campaign aggregate、events、work 正确。

压力后重算 shadow monotonicity、command/receipt identity、expiry fence、target uniqueness、firmware confirmation、campaign/wave state、Event order、Work terminality 和 tenant isolation；记录 p50/p95/p99、throughput、status、RSS、恢复时间。

## H-13 项目自带验证

实际执行 unit、真实 PostgreSQL/HTTP integration、production Chromium、双 API/四 Worker concurrency、barrier/SIGKILL recovery、aggregate/invariant 和 performance。拒绝占位、mock、jsdom、开发 UI 或没有真实持续负载/正确性检查的脚本。
