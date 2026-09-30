# ParcelFlow 项目设计说明

## 文件夹结构

```text
parcelflow/
├── CONTEXT.md
├── README.zh-CN.md
├── workspace/
│   ├── .git/
│   ├── README.md
│   └── AGENTS.md
├── orchestration/
│   └── user-and-manager-prompts.zh-CN.md
└── evaluator/
    ├── E2E_TEST_PLAN.zh-CN.md
    └── INDEPENDENT_STRESS_SCENARIOS.zh-CN.md
```

`workspace/` 是唯一交给 Codex 的目录。其余目录只属于 Benchmark Harness，不能在开发
回合、Frontal Session Evolution 或最终评分前复制、挂载或透露给 Codex。

## 1. 这个项目是什么

ParcelFlow 是 LaunchPass 之后的 transfer task。它模拟一个多仓库存预留与异步履约
系统：客户提交包含多个 SKU 的订单，系统原子预留库存，后台 Worker 创建 Shipment，
事务 outbox 再把业务事件投递到本地 webhook。

V1 刻意要求一个仓库完整满足整单。题目的主要困难不是 CRUD 数量，而是这些边界同时
成立：

- 多个 SKU 的库存必须整单成功或整单回滚；
- 两个 API 进程和两个 Worker 共享同一个 PostgreSQL；
- 创建、取消、发货、幂等重试和进程崩溃可以互相竞争；
- DispatchTask 的租约过期后要恢复，不能重复扣库存或创建 Shipment；
- 业务状态与 DomainEvent 必须原子提交；
- webhook 是至少一次投递，同一 Order 的成功投递又必须保持 sequence 顺序；
- 项目自己要提供真实 PostgreSQL、HTTP、Chromium、多进程、崩溃恢复和持续负载测试。

术语的精确定义见 [CONTEXT.md](./CONTEXT.md)。

## 2. Codex 一开始能看到什么

每个项目使用新的 workspace 和新的 Codex session。初始内容只有：

```text
/workspace/
├── .git/
├── README.md
└── AGENTS.md
```

Codex 看不到实现骨架、Manager 后续需求、Checklist、隐藏输入、竞争调度或评分脚本。
环境只提供通用工具，包括 Node.js 22、npm、PostgreSQL 16、Git 和 Chromium。

公开产品合同是 [workspace/README.md](./workspace/README.md)，工程边界是
[workspace/AGENTS.md](./workspace/AGENTS.md)。

## 3. V1 最终交付

Codex 要从零交付 TypeScript + React + PostgreSQL 应用：

- Warehouse、SKU、库存目录和版本化 seed；
- 1 到 8 个不重复 SKU 的订单；
- 稳定的单仓完整分配与原子库存预留；
- 订单取消、持久化 DispatchTask、双 Worker 和 Shipment；
- 跨实例、跨重启的 durable idempotency；
- 与业务事务一起提交的 DomainEvent 和至少一次 webhook dispatcher；
- 客户下单、详情、取消、自动刷新和历史，以及管理员库存与履约页面；
- OpenAPI 3.1、production build 和公开要求的全部测试命令；
- 明确的吞吐、延迟、backlog 恢复与负载后一致性证据。

PostgreSQL 是库存、任务、幂等和 outbox 的唯一 authority。不能用进程内锁、队列、
timer 或 cache 承担正确性。

## 4. 为什么比 LaunchPass 更难

LaunchPass 的主要竞争围绕单个活动容量和单个 hold。ParcelFlow 把一个写操作扩展为
多个 SKU、多个库存位置和后台任务，并加入两个独立失败边界：Worker 崩溃和 webhook
未知投递结果。

它仍然保持一个清晰主流程，没有支付、退款、退货、承运商路由、库存调拨或第三方消息
队列。难度来自公开的不变量、恢复语义和后续兼容变更，而不是无关功能堆叠。

## 5. 长交互与用户角色

正常剧本有 22 个阶段。DeepSeek V4 Flash 扮演初级全栈工程师，先要求计划、模块职责、
数据流和契约，再按垂直切片推进实现、Review 和真实验证。

DS 不写代码、不运行命令、不分析日志、不猜根因，也不向 Codex建议表、锁、事务、索引、
队列或算法。Codex 报告失败时，DS 只要求它自行定位、修复和重新验证。

T16 由 Harness 注入固定 Manager 消息；完整协议见
[orchestration/user-and-manager-prompts.zh-CN.md](./orchestration/user-and-manager-prompts.zh-CN.md)。

## 6. Manager 的固定变更

完整 V1、Browser E2E 和双 API/双 Worker 恢复测试完成后，Manager 才发布“跨仓拆分履约”：

- 仍优先使用第一个能完整满足整单的仓库；
- 没有单仓能满足时，按公开稳定顺序把订单行分配到多个仓库；
- 任一订单行总库存不足时仍然整单原子失败；
- 每个仓库形成独立 Fulfillment、DispatchTask 和 Shipment；
- Order 需要正确聚合 `ALLOCATED`、`PARTIALLY_SHIPPED` 和 `SHIPPED`；
- 任何 Fulfillment 发货后不得整单取消；
- 旧 singular `fulfillment` 字段继续兼容，新增 `fulfillments[]`；
- V1 历史数据、事件 sequence 和已保存的幂等 replay 结果必须原样兼容；
- schema、API、Worker、outbox、UI 和所有真实测试层必须一起迁移。

这个变更把核心基数从 `Order 1 -> 1 Fulfillment -> 1 Shipment` 改为
`Order 1 -> N Fulfillments -> N Shipments`，会穿过整个系统，而不是增加一个旁路页面。

## 7. 测试与性能

项目自己必须实现 Unit、真实 PostgreSQL + HTTP Integration、production Chromium
Browser E2E、双实例 Concurrency、双 Worker/dispatcher Recovery、Aggregate 和 Performance
命令。Harness 在最终 workspace 冻结后再从外部执行自己的 H-01 至 H-13。

性能不是单独奖励“跑得快”。任何超卖、负库存、重复 Shipment、丢失业务事件或库存
不守恒都会使性能分归零并触发总分上限。公开数据规模和阈值与 workspace README 完全
一致；隐藏测试只随机化合法数据、顺序、端口和崩溃时点。

评分聚合设计见 [evaluator/E2E_TEST_PLAN.zh-CN.md](./evaluator/E2E_TEST_PLAN.zh-CN.md)；拆分后的
29 个独立压力场景见
[evaluator/INDEPENDENT_STRESS_SCENARIOS.zh-CN.md](./evaluator/INDEPENDENT_STRESS_SCENARIOS.zh-CN.md)。

## 8. 评分结构

`experiments/parcelflow/checklist.json` 是首版唯一的 100 分权重权威：

| 维度 | 分值 |
| --- | ---: |
| 安装、迁移、构建与运行 | 5 |
| 契约、校验与 seed | 5 |
| V1 库存与订单生命周期 | 10 |
| 原子分配与 durable idempotency | 10 |
| Worker、outbox 与崩溃恢复 | 15 |
| 多进程一致性 | 10 |
| Manager 拆单与兼容迁移 | 15 |
| Manager 聚合、API、UI 与竞争 | 10 |
| 项目自带测试真实性 | 8 |
| 持续性能与负载后正确性 | 7 |
| 初级工程师可理解的解释 | 2 |
| 验证证据与 handoff | 3 |

高难度的一致性、恢复和迁移项占主要分值，普通页面和骨架无法得到高分。

## 9. 完整实验位置

ParcelFlow 的 `task.json` 标记为 `transfer`。实验 curriculum 先运行 LaunchPass learning，
再运行 ParcelFlow；同一 persona 的 Treatment 共享实验专用 `CODEX_HOME` 和
`FRONTAL_HOME`，Control 按项目隔离状态。每个项目仍使用新的 workspace 和 Codex
session。

`experiments/parcelflow/experiment.json` 定义上述 paired curriculum；现有 CLI 的
`dialogue` 路径一次只读取首个 task，所以另有 `dialogue-experiment.json` 仅用于单独调试
ParcelFlow 的 22 阶段剧本。它不替代正式 paired experiment。

```text
LaunchPass learning
-> ParcelFlow transfer
-> 每个项目同 session Frontal Session Evolution
-> 冻结副本上的隐藏测试
-> 独立 Codex 5.6 Sol max 评分
```

正式比较必须为 Control/Treatment 使用成对相同 seed、镜像、模型、轮数和 Manager
插入时点。

## 10. 当前落地边界

本目录完成了公开任务、固定 Manager 剧本、Checklist、环境和隐藏评测方案。当前 Harness
尚未实现 ParcelFlow 的 H-01 至 H-13 runner，因此 `task.json` 只接入项目自带
`test:all` 作为临时 smoke gate；不能把该命令通过解释为正式满分。

正式评分前还必须实现并校准独立 runner、单一 assertion score manifest、V1/Final 双
快照和 paired scripted curriculum。禁止用恒通过脚本或 Sol 自由裁量来代替这些工作。
