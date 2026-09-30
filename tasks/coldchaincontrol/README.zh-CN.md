# ColdChainControl 任务设计

ColdChainControl 是四个递增型复合迁移任务中的第一个。它不是多个无关功能的拼盘，而是一条完整的全球冷链控制流程：运营方发布传感器配置，设备用可轮换凭据提交签名遥测，系统在乱序与重复下投影货件位置和温度，检测离线/温控异常，可靠通知运营人员，并在生产 UI 中处置。

公开 workspace 只有 `.git/`、`README.md` 和 `AGENTS.md`。Agent 需要从零实现 Node.js 22 + TypeScript + React + PostgreSQL 系统，并把 API、Worker、dispatcher 做成独立进程。核心正确性依赖 durable idempotency、数据库事务、数据库时间、租约 fencing、transactional outbox、严格租户隔离、确定性乱序投影与敏感字段脱敏。

任务包含约 28 个自然开发场景，至少 28 轮、最多 80 轮，不使用 `maxVisits` 强制推进。DS V4 Flash 只扮演初级交付工程师：每轮推进一个目标、询问职责和证据，不给代码、SQL、命令、锁算法、隐藏测试或 Debug 提示。

V1 完成真实评审后，唯一 Manager 消息才发布多承运人责任接力与按批次召回隔离。发布前严禁泄漏。Agent 必须先做影响分析，再兼容迁移和实现；既有 Shipment、配置、设备凭据、遥测、异常、saved replay、pending Work、Event 与 Audit 必须保持。

独立 evaluator 提供 H-01～H-20。H-01/H-02/H-13 复用共享 runner，其余经任务 adapter 在公开 HTTP/Chromium/进程 seam 验证。H-12 包含 5 条专属持续压力场景；H-14～H-20 深入验证凭据、配置、乱序投影、通知、接力、召回和跨域故障演练。评分时 evaluator 不导入候选源码、不读取私有表。

详细领域边界、隐藏 gate 和校准要求见 `CONTEXT.md`；公开实现合同仅以 `workspace/README.md` 和 `workspace/AGENTS.md` 为准。
