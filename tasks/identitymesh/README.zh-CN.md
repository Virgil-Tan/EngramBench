# IdentityMesh 任务设计

IdentityMesh 是新增的独立身份安全任务，不复用其他任务的源码、数据库或运行状态。

## 差异化难点

- 与 `TenantGuard` 不同：不测试 RBAC/ABAC 权限决策，而测试身份生命周期、token family 和设备信任；
- 与 `BillForge` 不同：不测试金额和结算，而测试密钥轮换、撤销传播和安全边界；
- 重点是未知 Provider 结果、单次 RefreshToken、缓存版本围栏、审计哈希链和敏感信息零泄漏。

## 评测原则

所有安全状态都通过公开接口和 verification snapshot 验证。测试不会读取候选数据库表或私钥；
会通过重复请求、乱序消息、并发 API、Worker SIGKILL 和真实 Chromium 流程制造压力。

## 当前交付状态

已完成公开 README、Agent 约束、H-01～H-13 黑盒测试计划和静态合同测试。可执行的 IdentityMesh
Harness Adapter、固定 seed 和压力 Runner 应在合同评审通过后实现，避免未确认 API 时伪造运行时行为。
