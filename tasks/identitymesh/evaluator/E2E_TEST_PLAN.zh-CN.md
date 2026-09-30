# IdentityMesh 隐藏测试计划

这是候选工作区之外的 Harness 黑盒测试合同。测试只能使用 README 公布的命令、HTTP/OpenAPI、
Chromium、本地 Provider double、barrier、进程信号和 verification snapshot。不得导入候选源码、
ORM、数据库表、私钥、token 或内部模块。

## H-01 安装、迁移、Seed 与启动

执行公开命令、重复 migration、合法 seed、同 digest 重放、冲突版本和随机非法成员；启动 API、
Worker、Dispatcher 和 UI，并验证 snapshot 不泄漏秘密。

## H-02 登录合同和错误边界

验证 OpenAPI、稳定错误、时间/UUID/媒体类型/未知字段、分页和登录成功/失败。验证原始凭据、
Provider assertion、RefreshToken 和私钥不会出现在响应、日志或 snapshot。

## H-03 登录与会话刷新

完成真实 UI 登录、会话刷新、过期和登出。验证一个成功登录只创建一个 Session 和一个 Token family，
刷新后旧 token 立即失效。

## H-04 Refresh Token 重用竞争

并发使用同一个旧 RefreshToken，验证最多一个旋转成功；重用检测会原子地撤销整个 token family 和
派生 Session，不能创建第二个 Session。

## H-05 UNKNOWN Provider 结果

Provider 返回 timeout/connection reset 后 LoginAttempt 必须保持 UNKNOWN，不能创建 Session，也不能
把同一尝试当作新的登录；reconcile 后只产生一个最终身份结果。

## H-06 Device challenge 与信任

创建设备、发起 challenge、重复/过期/跨用户 approve。验证 nonce 单次使用、挑战绑定设备和用户，
成功信任不会被重复请求覆盖。

## H-07 设备撤销传播

让设备撤销与刷新、挑战批准并发发生。验证撤销拥有单调 security fence，所有派生 Session 立即失效，
延迟或乱序传播不能重新启用设备。

## H-08 Signing-key rotation

并发轮换 SigningKey，验证只有一个 ACTIVE key，旧 key 正确 RETIRING；旧 token 在边界前可验证，
超过边界必须失败。私钥材料永不出现在 API 或 snapshot。

## H-09 Revocation propagation 和缓存失效

发送重复、乱序、延迟 revocation message，模拟过期缓存和多个 API 进程。验证旧版本缓存 fail closed，
最终版本单调，撤销记录和事件身份不重复。

## H-10 Audit chain

覆盖登录、刷新、设备信任、设备撤销、密钥轮换和用户撤销。验证每次状态变更恰好一条 AuditEntry，
sequence 连续、priorDigest 正确、payloadDigest 可重算。

## H-11 Worker 崩溃和审计恢复

在 revocation propagation、audit dispatch 和 key retirement barrier 分别 SIGKILL Worker，等待
lease 过期后恢复。验证业务状态和审计记录最多一次，stale lease 不能提交，outbox 重试保留原身份。

## H-12 持续压力

执行三个固定场景并在压力后重新验证所有安全不变量：

1. `session-refresh-contention`: 20,000 个活跃 Session，至少 200 refresh/s，p95 <= 300ms，旧 token 重用率和意外 5xx 为 0。
2. `revocation-fanout`: 10,000 个设备和 Session 的撤销传播，至少 500 message/s，5 秒内完成，禁止 stale re-enable。
3. `audit-chain-append`: 1,000,000 条安全事件追加，至少 1,000 entry/s，p95 <= 250ms，恢复后链验证通过。

缩放运行只能作为 smoke，不得计为正式通过；正式运行固定 dataset、阈值和完整指标。

## H-13 项目自带验证

检查项目是否提供并实际运行 unit、真实 PostgreSQL integration、production Chromium、两 API/两
Worker concurrency、barrier/SIGKILL recovery、revocation invariant、audit-chain verification 和
performance 命令。

每个场景最后验证：token family 单次旋转、撤销版本单调、设备隔离、当前 key 唯一、审计链连续、
事件顺序、Work 排空和没有敏感数据泄漏。
