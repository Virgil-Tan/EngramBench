# AccessSentinel 任务设计

AccessSentinel 是四个递增复合 Transfer 任务中的第三个，规模约为当前高难度全栈任务的两倍。它把 IdentityMesh、FraudLens、ConfigOrbit、NotifyRoute 和 GeoPulse 中可迁移的工程能力组织成一条连贯的特权访问生命周期，而不是把多个无关 CRUD 拼在一起。

## 连贯主线

设备与 Session 建立信任，LocationObservation 提供有序区域证据，AccessRequest 冻结 Policy/Risk/Trust/Epoch 输入，Worker 生成不可变 RiskDecision，需要时进入独立人工复核，随后只签发精确且短期的 AccessGrant。任何 Session、Device、Principal、Tenant、Grant 或 Region 撤销都会立即 fail closed；Audit 哈希链和事务性 outbox 覆盖每次安全转换。

## 难度梯度

- 16 类 V1 snapshot 资源，4 类 Manager 资源；
- 同时覆盖 token rotation、不可变 revision、乱序 replay、人审职责分离、短期授权、跨进程撤销、租约 fencing、Audit 链和 unknown ACK；
- H-01～H-26 全部由独立 Harness 通过公开 seam 执行；
- H-12 包含 8 条独立固定压力场景，不以单一吞吐脚本代替；
- 对话约 30 个场景，至少 36 轮、最高 80 轮，不以 scene visit 数自动推进。

## Manager 保密边界

V1 完成后，唯一 Manager 消息才发布双人紧急授权、区域隔离和事后复核。公开 workspace、T01～T21 和初始用户角色不会提前透露相关资源、路由、错误或状态机。

## 评分

Checklist 总分 100。功能正确性由 H-01～H-26 硬 gate 约束；Judge 只补充架构、解释与证据质量判断。压力测试同时检查吞吐、延迟、收敛、状态守恒、secret boundary 和恢复后不变量。
