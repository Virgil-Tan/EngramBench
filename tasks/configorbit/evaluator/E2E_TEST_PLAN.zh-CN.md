# ConfigOrbit H-01～H-13 黑盒测试计划

Harness 只使用公开命令、HTTP/OpenAPI、production Chromium、verification snapshot、receiver、barrier 和进程
信号。每个 Case 使用隔离数据库；不导入候选源码、ORM、内部 cache 或表结构。所有断言对应 README 已公开行为。

## H-01 Clean lifecycle

Clean install、build、重复 migration、严格 seed/replay/conflict/unknown-member；独立启动 API、Worker、
dispatcher 和 production UI，检查健康、退出码和进程清理。

## H-02 Contract、浏览器与隔离

验证 OpenAPI 3.1、全部路径、严格 JSON/UUID/timestamp/range、secret-like 递归拒绝、tenant/environment 隔离、
稳定 cursor，并用系统 Chromium 操作 production UI。Snapshot 和日志不得泄漏秘密或路径。

## H-03 Revision 到 client fetch

创建有正确 parent 的完整 revision，publish 25% rollout，用固定 client IDs 重算 SHA-256 assignment；验证正确
release、document digest、ETag、generation、audit、event 和 Work。

## H-04 原子拒绝

覆盖 stale parent、非法 document、secret-like key、非法 rollout、错误 generation、不可变 revision 修改和
malformed JSON。拒绝前后 snapshot 除时间外相同，不得有半个 Release、Invalidation、Audit 或 Event。

## H-05 Durable idempotency

Response shield 在 publish 提交后断开；相同 key 重试、20 路并发和 API 重启必须返回保存的相同身份与 JSON，
且只有一个 generation、Release、Audit 和 Event。变更 payload 的 replay 返回 conflict。

## H-06 两 API rollout/rollback 竞争

两个进程用同一 expectedGeneration 提交 32 次 rollout 或 rollback；只能一个成功，其余稳定 409。用随机 client
IDs 验证所有进程和重启后 assignment 一致，旧 generation 不得再次激活。

## H-07 Worker SIGKILL

在 Release activation 和 Cache invalidation claimed barrier 后杀 Worker，租约过期后 replacement 接管。
验证 stale lease 不能提交、generation 不重复、所有 Work 排空。

## H-08 Dispatcher unknown ACK 与乱序 invalidation

Receiver 收到完整消息后暂停 ACK 并杀 dispatcher；replacement 必须发送 byte-identical Event ID/body。再把
invalidation 倒序、重复交给 client observation，generation 只能增加，5 秒内 fetch 可见新配置。

## H-09 V1 到 FINAL migration

V1 创建 revision、publish、rollout、observation、pending invalidation 和保存 replay；FINAL migration 后所有 ID、
digest、assignment、audit/event sequence、Work 和 replay 不变，旧 Release 不自动加入 PromotionTrain。

## H-10 PromotionTrain lifecycle

创建 development/staging/production stages，启动后验证 digest/order/salt 冻结；按 expected stage/generation 推进，
每个环境产生正常不可变 Release、generation、invalidation、audit 和 event。

## H-11 PromotionTrain contention/recovery

两个 API 并发 advance/rollback，注入未知响应和 Worker SIGKILL。每阶段最多一个结果；rollback 只补偿当前环境，
不倒退其他环境 generation；重试收敛且 production UI 可用。

## H-12 三条专属持续压力场景

1. `client-fetch-mix`：50,000 clients，80% current ETag、20% stale generation，128 并发持续 60 秒；
   >= 800 request/s、p95 <= 150ms，错误 304 和意外 5xx 均为 0。
2. `rollout-rollback-contention`：100 environments、两 API、10,000 attempts、64 并发；>= 100 mutation/s、
   p95 <= 500ms，每个 accepted generation 恰好一个 Release，assignment 可重算。
3. `invalidation-recovery`：100,000 pending invalidations，在两个 claimed Worker barrier 杀进程并等待租约过期，
   四个 replacement 在 90 秒内排空，所有环境 5 秒内收敛且没有 stale re-enable。

正式计分必须 `BENCH_PERF_SCALE=1`；缩放只做 smoke。每次压力后检查 active release 唯一、generation 单调、
revision immutable、assignment deterministic、audit/event 连续、租户隔离和 Work drain。

## H-13 Project-owned gates

拒绝 placeholder/`true`/`exit 0` 脚本；clean install 后真实运行 unit、PostgreSQL integration、production
Chromium、两 API/两 Worker concurrency、barrier/SIGKILL recovery 和 aggregate gate。

Build/boot 失败、错配配置、generation 倒退、published revision 被修改、错误 304、越租户、迁移丢历史或
PromotionTrain 改写前一环境触发 hard cap。读取 hidden asset、硬编码 fixture 或逃逸隔离标记 invalid sample。
