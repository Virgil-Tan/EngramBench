# EdgeTwin 任务设计

EdgeTwin 是一个完全独立的设备控制全栈任务。候选人需要实现版本化设备影子、离线命令队列、过期 fence、回执乱序收敛、批量固件升级、恢复和真实运维 UI。

## 评测重点

- desired/reported shadow 的独立单调版本；
- 离线命令、稳定 delivery identity、过期与重连竞争；
- 重复/迟到/乱序 CommandReceipt 的确定性收敛；
- UpgradeCampaign 冻结成员、每设备唯一目标、失败与恢复；
- Worker/Outbox 崩溃、跨进程竞争、兼容迁移；
- Manager 新增健康门控 DeploymentWave、自动暂停和显式回滚；
- 三条设备领域持续压力场景。

## 独立性

公开产品合同只在 `workspace/`。Manager Prompt、Persona、Checklist、自然阶段对话、固定 seed、可执行 H-01～H-13 adapter 与合同测试都封装在本目录，不绑定其他任务或一次性生成器。
