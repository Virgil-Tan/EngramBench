# AccessSentinel 独立 E2E 与压力测试计划

所有 gate 只复制 `evaluator/` 与共享 `hidden/hard-fullstack/`，从公开 HTTP、OpenAPI、production Chromium、进程、barrier、webhook、seed 和 verification snapshot seam 观察候选实现。不得 import 候选源码、ORM、内部模块或读取私有表。

## H-01～H-13 基础深度 Gate

- H-01：clean install/build、重复 migration、严格 seed replay、API/Worker/dispatcher 独立启动。
- H-02：OpenAPI 3.1 覆盖全部公开路径、稳定 404、production Chromium 页面非空。
- H-03：完整 V1 Session → Location → Request → Risk → Review → Grant → Revoke 生命周期。
- H-04：幂等冲突、malformed JSON、非法 scope/review/grant 的全状态原子拒绝。
- H-05：unknown response、20-way replay、API restart 后仍只有一个 Request。
- H-06：双 API 64-way mutation 与 review/grant/revoke 热点竞争收敛。
- H-07：`worker.claimed` 后 SIGKILL、lease expiry、replacement worker fencing。
- H-08：dispatcher 收到 ACK 后 SIGKILL，重试保持同 Event ID 和 canonical body。
- H-09：V1 binary 创建真实状态和一条被 SIGKILL 后仍为 `LEASED` 的 Work；FINAL migration 后逐对象保持 Request、Decision、Work、Event、Audit identity、字段、digest、lease 与 replay。
- H-10：Manager 双人 quorum、scope、expiry、区域隔离、复核与 release 主流程。
- H-11：双 API final approval/quarantine/release CAS 竞争、旧 Worker、production Manager UI。
- H-12：8 条专属压力场景和 exact metrics。
- H-13：候选仓库自身所有非性能验证命令从 clean install 真正执行。

## H-14～H-26 领域 Gate

- H-14：Session family rotation、旧 token 重用、Device Trust CAS/revoke 传播。
- H-15：Policy publish/rollback 的不可变 revision 与已接受 Request 的版本冻结。
- H-16：RiskDecision 唯一性、review separation-of-duties、approve/reject race。
- H-17：Grant 的 action/resource/region/policy revision 与 <=5 秒 TTL 精确；真实等待 EXPIRED，并验证 revoke commit 后两个 API 立即 fail-closed。
- H-18：严格 seed 拒绝 audit tamper，运行时链保持 sequence/digest/secret invariants。
- H-19：跨租户和未知 identity 返回完全相同的稳定 `403` envelope，snapshot auth 拒绝且所有尝试零副作用。
- H-20：100 项 batch 先验证单项错误整批回滚，再验证合法 commit、同 key byte-equivalent replay，以及同 key 改一项的 `IDEMPOTENCY_CONFLICT` 零副作用。
- H-21：Policy publish/rollback 不改变冻结 Grant；Session、Device、Principal、Region、Tenant 五类 fence 分别 commit 后都必须跨两个 API 立即 fail-closed，并等待真实 Work 收敛。
- H-22：refresh response shield、并发 rotation、generation/family conservation 与 raw token 零泄漏。
- H-23：LocationObservation duplicate/out-of-order/bounded-late/too-late replay 的确定性投影。
- H-24：Worker 与 dispatcher 双重崩溃下 Work/Event/Audit 的 identity、顺序和终态守恒。
- H-25：同一 quarantine 下两条 BreakGlassSession 分别真实 close 与等待 expiry；两条各有独立 RetrospectiveReview，重复 review 为 `409`，全部终态复核后才可 release。
- H-26：先创建真实普通 Grant，再组合 quorum、区域隔离、BreakGlass check、policy change、tenant revoke、stale worker 与 unknown ACK；普通 Grant 和 BreakGlass 授权在恢复前后都 fail-closed。

## 8 条专属压力场景

H-12 必须返回且只返回以下 `scenarioId`：

1. `session-refresh-storm`
2. `access-decision-ingest`
3. `policy-evaluation-hotset`
4. `location-replay-convergence`
5. `grant-revocation-fanout`
6. `audit-chain-append`
7. `outbox-ack-recovery`
8. `revocation-fence-recovery`

固定 seed、公开 count、阈值和后置不变量以 workspace README 为准。每条场景使用 fresh database；`BENCH_PERF_SCALE<1` 只允许本地 non-scoring smoke，正式评分必须为 1。每一条 metric 都独立记录实际存活的 API/Worker/dispatcher topology、该场景 RSS、该 fresh database 的 `databaseBytes`，以及 evaluator 已真实断言的 `postLoadInvariants`；不得硬编码 topology 或在汇总时额外启动进程。

- `session-refresh-storm`：每个 family 恰有一个 ACTIVE generation，generation 等于实际 rotation 次数 + 1，抽样 raw token 不得进入 snapshot 或进程日志。
- `access-decision-ingest`：Request 与 Decision 数量和 identity 集合精确相等，全部 Work 终态。
- `policy-evaluation-hotset`：500 条规则真实覆盖被检查 resource；前 100 个重叠路径由 deny 覆盖 allow，每次响应返回精确冻结 revision。
- `location-replay-convergence`：固定时间基准；每 Device sequence 连续、最终位置匹配离线排序 oracle、riskFlags 无重复、全部 Work 终态。
- `grant-revocation-fanout`：每 Principal 一条 monotonic revocation；全部 Grant 经两个 API 检查为 inactive，30 秒包含检查时间。
- `audit-chain-append`：每次 mutation 都被 Audit 和 Event 覆盖，Audit digest 链与 Event aggregate sequence 连续且 identity 唯一。
- `outbox-ack-recovery`：四个 dispatcher 都到达 barrier、杀死两个并补回两个；至少一个 Event 真实 retry 且 raw body 完全相同，logical Event 精确等于公开 count。
- `revocation-fence-recovery`：四个 barrier Worker 都 claim 后全部 SIGKILL；每个 fence commit 后持续跨 API 监测，最终全部 Grant fail-closed，恢复 topology 为 2 API / 4 replacement Worker / 4 dispatcher。
