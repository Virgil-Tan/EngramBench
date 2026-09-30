# EntitlementHub H-01～H-13 黑盒测试计划

Evaluator 在 candidate workspace 外运行，只使用公开命令、HTTP/OpenAPI、production Chromium、Provider
double、verification snapshot、receiver、barrier 和进程信号。每个 Case 隔离数据库；不导入源码、ORM、表或缓存。

## H-01 Clean lifecycle

执行 clean install/build、重复 migration、合法 seed、相同 digest replay、冲突、未知成员和坏引用；分别启动
API、Worker、dispatcher 和 production UI，验证健康与清理。

## H-02 Contract、浏览器与隔离

验证 OpenAPI、全部公开路径、严格 JSON/UUID/timestamp/money/range、稳定错误和 cursor、tenant isolation，
并用系统 Chromium 操作 production build。Snapshot、响应和日志不含 Provider secrets、tokens 或私有路径。

## H-03 Trial 到 entitlement

启动 trial、激活、查询 feature、升级、计划降级和续期。重算 period、integer proration、grant interval、limit、
revocation version、audit/event sequence，验证 PlanRevision 历史冻结。

## H-04 原子拒绝

覆盖重复 trial、未发布 revision、stale expected sequence、负退款、币种不符、terminal mutation、未知字段和
malformed JSON。拒绝不能留下 Subscription、Grant、Refund、Audit、Work 或 Event 的部分状态。

## H-05 Durable idempotency 与 UNKNOWN

Response shield 在提交后断开；20 路 replay、另一个 API 与重启返回完全保存的响应。Provider refund timeout
保持 UNKNOWN 和额度预留，reconcile 只产生一个终态；不同 payload 复用 key 冲突。

## H-06 多实例生命周期竞争

两个 API 并发创建同一 trial，以及 upgrade/downgrade/cancel/refund/renew 竞争。验证 trial consumption 唯一、
一个合法 Subscription sequence、grant 区间无重叠、退款不超 charge、terminal state 不复活。

## H-07 Worker SIGKILL

在 plan change、expiry、refund reconcile 和 revocation claimed barrier 杀 Worker；租约过期后 replacement 恢复。
验证 stale owner 不能提交，业务和 entitlement 各一次，Work 排空。

## H-08 Outbox unknown ACK 与撤权传播

Receiver 收到完整事件后暂停 ACK，杀 dispatcher，replacement 重试必须保持同 Event ID 与 byte body。将 revocation
倒序重复发送到两个 API，2 秒内都必须 deny，旧 version 不能 re-enable。

## H-09 V1 到 FINAL migration

V1 建立 active/trial/past-due Subscription、pending change、UNKNOWN Refund、grant、fence、pending Work 和保存 replay；
FINAL migration 后全部身份和语义保留，个人 entitlement 响应兼容，旧订阅不自动进入 Pool。

## H-10 EntitlementPool

验证 V1 或省略 `subscriptionKind` 的个人订阅不能创建 Pool；创建 `ORGANIZATION` Subscription 和 Pool，分配至 seatLimit，验证唯一 subject、expectedPoolVersion、列表和 exact access。
降级进入 OVER_LIMIT 后禁止新分配但不任意驱逐；显式撤销至合法后恢复。

## H-11 Pool contention/recovery

两个 API 竞争最后 seat、assignment/revoke 与 subscription refund/cancel/expiry；再在 Pool revoke barrier 杀 Worker。
验证不超售、不恢复旧 seat、两秒撤权、重试稳定，production UI 仍可用。

## H-12 三条专属持续压力场景

1. `entitlement-decision-read`：100,000 subjects，80% enabled、20% disabled/stale-fence，128 clients 持续 60 秒；
   >= 1,500 check/s、p95 <= 100ms，stale allow 和意外 5xx 都为 0。
2. `upgrade-refund-race`：20,000 subscriptions、两 API、64 concurrent plan-change/cancel/refund operations；
   >= 100 mutation/s、p95 <= 750ms，无 grant overlap、excess refund、duplicate trial 或 version regression。
3. `expiry-revocation-recovery`：50,000 due subscriptions，在两个 claimed Worker barrier 杀进程并等待租约过期，
   四个 replacement 在 90 秒内排空；所有 API 在每次 commit 后 2 秒内 deny。

正式计分必须 `BENCH_PERF_SCALE=1`；缩放仅 smoke。每条压力后重算 frozen terms、trial uniqueness、period/refund
conservation、grant interval、fence、audit/event、tenant isolation 和 Work drain。

## H-13 Project-owned gates

拒绝 placeholder/`true`/`exit 0`；clean install 后真实执行 unit、PostgreSQL integration、production Chromium、
两 API/两 Worker concurrency、barrier/SIGKILL recovery 和 aggregate gate。

Build/boot 失败、重复 trial、退款超额、grant overlap、撤权后 allow、fence 倒退、迁移丢历史、Pool 超售或越租户
触发 hard cap。读取 hidden assets、硬编码 fixture、逃逸隔离或伪造测试标记 invalid sample。
