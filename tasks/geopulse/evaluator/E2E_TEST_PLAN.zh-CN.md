# GeoPulse 隐藏端到端测试计划

Evaluator 位于候选 workspace 外，只通过公开命令、HTTP/OpenAPI、真实 Chromium、Webhook receiver、
barrier、进程信号和 verification snapshot 验证。不得导入候选源码、ORM、数据库表或内部模块。
每个场景使用独立数据库和私有随机 seed；所有行为均已在公开 README 或 Manager 消息中声明。

## H-01 安装、迁移、Seed 与启动

从干净 fixture 执行安装、重复 migration、build、合法 seed、同 digest replay、冲突 digest 和非法
polygon/reference seed。验证原子回滚；API、四个 Worker、Dispatcher 和 production UI 可独立启动、
健康退出并清理进程。

## H-02 OpenAPI、浏览器、几何和租户隔离

验证 OpenAPI 覆盖全部公开路径；未知字段、错误媒体类型、越界坐标、未闭合/自交/跨日界 polygon、
非法时间和过大 batch 返回稳定错误。真实 Chromium 完成 Region、Device、事件、Membership、Transition
和 point query 流程。两个 Tenant 的 API、cursor、UI、snapshot、Work 和 Event 不得交叉泄漏。

## H-03 主流程、边界和迟到重放

让设备从 outside 穿越 boundary 进入、停留并退出，验证唯一 ENTER/DWELL/EXIT、RegionVersion 选择、
Membership revision 和 Transition sequence。打乱 10 分钟窗口内事件到达顺序后必须收敛到相同结果；
窗口外事件只能变成 LATE_IGNORED，不能重写已发布事实。

## H-04 原子拒绝与批量一致性

混合合法事件与无效坐标、重复序号不同正文、跨租户 Region 和溢出 batch。整个请求失败时，
LocationEvent、Membership、Transition、Work、Event 和 idempotency snapshot 完全不变。Malformed JSON、
错误 content-type 和相同 Idempotency-Key 的语义冲突也必须无部分副作用。

## H-05 Durable idempotency 与响应丢失

在提交成功响应后由 response shield 断开连接，随后同 key replay、20 路并发和 API 重启。返回身份与
canonical body 必须一致，只有一个 LocationEvent 和一组 Work。批量请求的 key/body 冲突也不得接受
第二组事件。

## H-06 多 API 序号竞争和边界抖动

两个 API 对同一 Device 的最后可用 sequence、重复 eventId、相同时间不同坐标和 64 路相同 replay
并发提交。再围绕 polygon edge 产生 10,000 次微小抖动。只能有一个合法 canonical event；Membership
保持单一且 revision 单调，不能产生 ENTER/EXIT 风暴。

## H-07 Worker claim、late replay 与崩溃恢复

分别在 `worker.claimed`、Membership 更新前和 replay 提交前使用 barrier SIGKILL。等待 lease 过期后
启动替代 Worker，验证旧 owner 被 fence、Work 终态、watermark 正确、Transition identity/sequence
不重复，重启后结果与无故障运行相同。

## H-08 Outbox 未知 ACK

Receiver 已收取 Event 204，但 Dispatcher 在记录 ACK 前被 SIGKILL。替代 Dispatcher 至少重投一次，
两次 Event ID、aggregate sequence、canonical body 和签名输入必须相同；每个 aggregate 顺序连续，
一个失败 aggregate 不阻塞其他设备，正文不含完整坐标或 secret。

## H-09 V1 到 RegionBundle migration

使用 V1 binary 创建 RegionVersion、乱序 LocationEvent、Membership、Transitions、pending LATE_REPLAY、
已提交幂等响应和未确认 Event，再运行 FINAL migration。所有身份、状态、watermark、sequence、lease、
replay 和 cursor 必须不变；新增 bundle 资源为空，旧 Worker 不得写入混合 revision。

## H-10 RegionBundle publish、pinning 与 rollback

创建多个 RegionVersion 并发布 bundle revision，之后修改 Region 活跃版本。验证已接受 LocationEvent、
重放和 batch query 固定原 bundle revision。Rollback 创建新的 revision 而不改旧记录；Composition
去重排序、Event、Work、UI 和 snapshot 与 Manager 合同一致。Runner 还会逐字段验证 `RegionBundle`、
`RegionBundleRevision`、LocationEvent/Membership 的 `bundleRevisionId`，以及 query 顶层唯一
`bundleRevisionId` 和输入顺序。

## H-11 并发 publish、缓存失效和 Worker fence

两个 API 用同 expectedRevision 并发 publish/rollback，只有一个 CAS 成功。将旧 Worker 停在评估
barrier，发布新 revision 后释放；旧 Work 只能按冻结 revision 完成，不能混入新成员集合。新的请求
必须从两个 API 都看到新 revision，所有 API cache 在可观察的 publication 后失效。Runner 验证旧事件
仍引用旧 `bundleRevisionId`、新事件引用获胜的新 revision，且 Transition sequence 仍连续。

## H-12 三条 GeoPulse 专属持续压力

正式环境固定 4 CPU、8 GiB、PostgreSQL 16、两个 API、四个 Worker 和一个 Dispatcher：

1. `ordered-location-ingest`：500,000 events / 100,000 devices，64 并发持续 60 秒，>=500 events/s，
   p95<=250ms，unexpected 5xx=0，deviceSequence/eventId 唯一。
2. `boundary-jitter-convergence`：2,000 devices 在 100 Region 边界产生 100,000 observations，64 并发
   持续 60 秒，>=300 events/s，p95<=350ms，无 spurious transition pair。
3. `bulk-spatial-query`：10,000 Regions、1,000,000 points，以 1,000 点 batch 持续 60 秒，
   >=20,000 points/s，p95 batch<=700ms，输入顺序稳定且响应不混合 revisions。

负载后重算 LocationEvent 唯一性、Membership revision、Transition sequence、hysteresis、bundle pinning、
Work/Event、租户隔离，并记录 p50/p95/p99、throughput、状态分布、RSS 和数据库增长。缩放模式仅 smoke，
不计正式得分。Runner 以这里声明的固定数量乘 `BENCH_PERF_SCALE`，指标同时报告公开基准量、scale 与
实际提交量；正式评分固定 scale=1。任何非 2xx 响应都失败，不能用快速错误响应伪造吞吐。

## H-13 项目自带验证

实际运行 unit、真实 PostgreSQL integration、production Chromium、双 API/四 Worker concurrency、
barrier/SIGKILL recovery、aggregate/invariant 和 performance 命令。拒绝只检查文件、mock 数据库、
jsdom、开发服务器、固定 exit 0 或没有真实负载指标的占位测试。
