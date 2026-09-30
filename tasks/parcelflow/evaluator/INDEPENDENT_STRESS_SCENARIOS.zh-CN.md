# ParcelFlow 29 个独立压力测试场景

## 1. 状态与定位

本文把 ParcelFlow 的 Browser E2E、并发、崩溃恢复和性能评测拆成 29 个可独立运行的
Harness-owned case。这里的“独立场景”不是传统的函数级 Unit Test；它们会启动真实
PostgreSQL、production build、API、Worker、Dispatcher、Receiver 和 Chromium。

> **当前状态：case assets、独立 runner、故障注入和结果 schema 已实现。** 25 个
> `required` case 已接入 `experiments/parcelflow/task.json`；`PF-E2E-10`、`PF-E2E-12`、
> `PF-REC-02` 保持 `designed_unwired`，`PF-PERF-03` 保持 diagnostic。实现与接线不代表任一
> 候选项目已经运行或通过这些场景。

这些 case 主要细化
[`E2E_TEST_PLAN.zh-CN.md`](./E2E_TEST_PLAN.zh-CN.md) 中 H-03 至 H-10 与 H-12 的运行时场景，
不替代 H-01、H-02、H-11、H-13，也不改变
`experiments/parcelflow/checklist.json` 的权重。H-08 的升级验证由 `PF-REC-06` 承接，
原 H-08 仍保留其完整 assertion groups。

本文及其 runner 只能存在于 evaluator 私有目录。不得复制或挂载给 DeepSeek 用户、
Manager、被测 Codex、Frontal Session Evolution 或 Sol judge。隐藏的是 fixture、交错顺序和
测试实现，不是产品需求；所有判定都必须能追溯到公开 README 或公开 Manager 变更。

## 2. 数量

| 类型 | 数量 | ID |
| --- | ---: | --- |
| Browser E2E | 12 | `PF-E2E-01` ～ `PF-E2E-12` |
| Concurrency | 6 | `PF-CON-01` ～ `PF-CON-06` |
| Recovery | 6 | `PF-REC-01` ～ `PF-REC-06` |
| Performance | 4 | `PF-PERF-01` ～ `PF-PERF-04` |
| Post-load invariant audit | 1 | `PF-AUD-01` |
| **总计** | **29** | |

同一个 case ID 可以在不同冻结快照上分别执行，但仍然是同一份测试定义：

| Case | 快照 |
| --- | --- |
| `PF-E2E-01` ～ `PF-E2E-08` | V1 + FINAL |
| `PF-E2E-09` ～ `PF-E2E-12` | FINAL |
| `PF-CON-01` ～ `PF-CON-05` | V1 + FINAL |
| `PF-CON-06` | FINAL |
| `PF-REC-01`、`PF-REC-02`、`PF-REC-04`、`PF-REC-05` | V1 + FINAL |
| `PF-REC-03` | FINAL |
| `PF-REC-06` | V1 database -> FINAL application |
| `PF-PERF-01` ～ `PF-PERF-04`、`PF-AUD-01` | FINAL |

## 3. 独立执行合同

runner 的单 case 接口为：

```text
BENCH_PRIVATE_SEED=<private-seed> node hidden/parcelflow/run.mjs --case PF-E2E-04 --snapshot FINAL
```

每个 case 必须满足：

1. 独立性单位是 `(caseId, snapshot, seed, subrun)`。每个单位创建自己的 PostgreSQL database、
   临时目录、端口集合、进程组、Receiver ledger、Browser context 和 fixture；V1/FINAL、不同
   viewport 与三次性能 run 之间也不能复用已改变的库存或其他状态。
2. 只运行候选项目公开的安装、migration、seed、build 和启动命令；不 import 候选源码，
   不假定 ORM、表名、构建目录或组件结构。
3. 使用 production build、真实 HTTP、真实 PostgreSQL 和真实子进程；Browser case 使用
   固定版本 Chromium，不 mock API。
4. readiness、状态推进和 lease 恢复全部使用 bounded polling 或可观测 barrier；禁止用固定
   sleep 猜时序。
5. 非预期的应用失败、timeout、unexpected 5xx、page error、console error 或核心场景 skip
   都是该 case 失败；由场景明确注入的 connection reset、webhook timeout/503 必须单独计数，
   并按公开幂等/重试合同恢复，不能误记为应用失败。只有被证明为 Harness 基础设施故障时
   才允许重跑。
6. 每次运行记录私有 seed hash、拓扑、PID、端口、fixture 摘要、动作时间线、HTTP 状态计数、
   判定结果和脱敏诊断；不把原始 hidden fixture 暴露给被测模型。
7. Case ID 不注入候选进程环境，避免候选按 grader 名称特判。

无法仅凭公开边界确定性命中的内部 Worker 窗口不能靠概率接线。`PF-E2E-10`、`PF-E2E-12` 与
`PF-REC-02` 在 evaluator 证明一个不读取候选源码/私有 schema、也不要求 hidden route 的
可观测屏障前，必须保持 `designed_unwired`，不能进入 required gate 或显示 passed。

除非场景另有说明，普通 HTTP 请求 hard timeout 为 10 秒，UI 状态收敛为 30 秒，普通
Browser/Concurrency case 为 2 分钟，Recovery case 为 5 分钟。涉及 lease 的 deadline 为：

```text
公开 lease timeout + 2 * 对应 poll interval + 2 秒调度容忍
```

性能场景使用公开的固定资源：4 vCPU、8 GiB、PostgreSQL 16、两个 API、两个 Worker、一个
Dispatcher 和本地 Receiver。Harness load generator 不占候选应用的 4 vCPU 配额。
只有 `PF_PERF_SCALE=1` 的完整规模运行可评分；任何缩放运行都返回 `non_scoring`，只能用于
本地诊断，不能进入 checklist gate。

## 4. 公共判定

每个适用 case 都必须从公开 API、UI 和 Receiver 先做黑盒断言，再执行 evaluator 的完整
终态审计。本文出现的内部实体计数都指公开可重建的语义投影，不是物理 row count。内部
Allocation、Task、outbox 和 idempotency row 不直接枚举：Allocation 数量从
已知请求和公开 Fulfillment 分组重建，Task 由最终 work 收敛证明，outbox 由 Receiver ledger
证明，幂等记录由原请求重放证明。至少检查：

- `0 <= reserved <= onHand`，且 `available = onHand - reserved`；
- `reserved` 等于全部未结算 Allocation 数量之和；
- 每条 OrderLine 的 Allocation 总量等于订购数量，失败订单不留下部分副作用；
- 每个 Fulfillment 最多一个 Shipment，每条 Allocation 最多结算一次；
- CANCELLED Order 没有 Shipment，出现任一 Shipment 后整单取消必须失败；
- 同一幂等 scope/key 只有一个逻辑结果和一套业务副作用；
- 每个 Order 的 DomainEvent sequence 唯一、连续，重投保持同一 event identity 和语义 body；
- committed work 最终收敛，unexpected HTTP 5xx 为 0。

任何 oversell、部分订单、重复 Shipment、重复结算、幂等重复副作用、永久丢失事件或升级
丢数据，都继续应用主测试方案中的 hard cap；不能用其他 case 的通过结果抵消。

## 5. Browser E2E：12 个

Browser case 的默认拓扑是独立 PostgreSQL、一个 production API/UI、一个可启停 Worker、一个
可启停 Dispatcher、Harness Receiver、透明 HTTP fault proxy 和 Chromium；场景写明的拓扑覆盖
默认值。它们使用语义 locator（role、label、heading、button 和可见文本），不使用私有 CSS
selector 或要求 `data-testid`。`PF-E2E-04` 和 `PF-E2E-09` 必须分别在 `1280x800` 与
`390x844` 完整运行，两个 viewport 各用全新 database/fixture/context；其余 case 在两个
viewport 间均衡分配。每个 case 都拒绝 page error、console error 和 unexpected 5xx。

### PF-E2E-01 Catalog loading、empty、search、pagination 与 error recovery

- **拓扑/数据**：准备至少 101 个共享搜索前缀的 Warehouse 和 101 个共享前缀的 SKU，并从
  真正的空目录状态开始，保证即使 UI 使用公开上限 `limit=100` 也必须分页。
- **动作**：透明 proxy 在真实 catalog 请求到达后暂缓 response，以确定性观察 loading，再放行
  并观察 empty state；通过公开 admin API 建立 fixture 后，按大小写混合的 code/name 搜索并
  遍历 cursor 页；保留当前页面时暂时停止 API，重启后重新加载页面。
- **通过标准**：loading 使用可访问 status；空态明确；搜索大小写规则、稳定排序、页边界、
  向前 cursor 正确且无重漏；断连显示可访问错误，API 恢复并重新加载后从服务端恢复数据。
- **时限/映射**：每个 readiness 30 秒，case 120 秒；H-03。

### PF-E2E-02 Inventory warehouse/SKU/text 组合筛选

- **拓扑/数据**：3 个 Warehouse × 40 个 SKU，共 120 个 StockPosition，刻意安排相似 code、
  name 和数量；即使 `limit=100`，未过滤结果也必须超过一页。
- **动作**：依次组合 exact Warehouse、exact SKU 和文本条件，遍历 cursor，并进入空结果。
- **通过标准**：只显示过滤条件交集；每行 warehouse/SKU、onHand、reserved、available 精确
  对应；分页无重漏；清除任一条件只移除该条件；空态明确。
- **时限/映射**：90 秒；H-03。

### PF-E2E-03 Composer 1～8 行边界、校验、键盘与焦点

- **拓扑/数据**：一个可满足全部合法组合的 Warehouse；Chromium 只用 Tab、Shift+Tab、
  Enter 和标准表单输入完成主要操作。
- **动作**：增加到 8 行、尝试第 9 行、删除中间行并重加；分别提交重复 SKU、空 customer、
  quantity 为 0、超上限、非整数和缺行数据。
- **通过标准**：1～8 行边界无 off-by-one；删除不串行；label/legend 与控件关联；错误通过
  可访问 alert/status 展示；焦点顺序与 focus indicator 可见；非法提交不创建 Order，库存
  完全不变。
- **时限/映射**：120 秒；H-03。H-02 的完整合同校验仍由主 runner 独立执行。

### PF-E2E-04 Single-warehouse-first 多行完整生命周期

- **拓扑/数据**：两个 Warehouse 都能完整满足，另有可用于拆分的库存；priority 与 UUID
  让预期首仓唯一；真实 Worker 和 Dispatcher。
- **动作**：以反序 SKU 行创建多行 Order；先在 Worker 停止时观察预留，再启动 Worker，
  等待页面自动刷新到发货完成，并整页刷新。
- **通过标准**：选择 `(priority, warehouseId)` 最先的完整单仓，不错误拆单；只有一个
  Fulfillment，接受全部行；状态从 ALLOCATED 到 SHIPPED；UI 可见 Shipment 和库存结算，
  Receiver 可见合法事件；刷新后仍从服务端恢复一致结果。
- **时限/映射**：两个 viewport 各 120 秒；H-03、H-04，FINAL subrun 另映射 H-09。

### PF-E2E-05 总库存不足时整单原子失败

- **拓扑/数据**：多个 Warehouse 都有部分库存，但至少一条 OrderLine 的跨仓总量仍不足。
- **动作**：从空白详情状态提交多行 Order，随后查看 history、inventory 并刷新页面。
- **通过标准**：显示公开容量错误；不能显示伪造的 Order 详情；history 中无该 reference；
  全部库存前后相同；启动 Worker/Dispatcher 后也没有延迟出现的 Shipment 或 Receiver event，
  从外部效果证明没有部分业务或 work 残片。
- **时限/映射**：90 秒；H-04，FINAL subrun 另映射 H-09。

### PF-E2E-06 Unknown response 恢复与 idempotency conflict UX

- **拓扑/数据**：两个 API/UI 后端加 Harness response shield；shield 只在 upstream 已完整返回
  后关闭 client 连接，不伪造响应。
- **动作**：用户提交成功但因 shield 看到明确的 unknown-outcome 错误；Harness 把捕获的原
  request/key 从另一 API 重放，再固定同一 key、修改 payload 发出冲突请求；重启原 API 后，
  用户通过 history 重新打开该 Order。
- **通过标准**：等价重放返回原 Order，history 只有一条且库存只预留一次；UI 能展示公开
  `IDEMPOTENCY_CONFLICT`，不变成通用 500；重启后原结果和冲突语义保持不变。测试不要求
  某种特定名称或形态的 Retry 按钮。
- **时限/映射**：120 秒；H-04、H-07。

### PF-E2E-07 发货前整单取消

- **拓扑/数据**：真实 API/UI，Worker 暂停；创建多行单仓 Order。
- **动作**：页面观察 ALLOCATED 和 reserved 后点击 Cancel，等待状态更新，再刷新并检查库存。
- **通过标准**：Order 与 Fulfillment 均变为 CANCELLED；reserved 全释放、onHand 不变；取消
  控件进入不可重复提交的终态；history、详情和刷新结果一致；无 Shipment。
- **时限/映射**：90 秒；H-03。

### PF-E2E-08 History、filter、cursor、full refresh 与 API restart

- **拓扑/数据**：seed 历史 Order，再通过 runtime 创建 ALLOCATED、SHIPPED、CANCELLED 三类；
  总数至少 201，且至少一个 status filter 匹配 101 条，强制 cursor 分页。
- **动作**：组合 reference/status 过滤并遍历 cursor；打开选中 Order；在新 Browser context
  从 history 重新导航到同一 Order；在详情页 full refresh；停止原 API，用同数据库启动另一
  API 后再次刷新。
- **通过标准**：seed 与 runtime 数据均可见；过滤和分页无重漏；新 context 不依赖旧页面
  内存即可从 history 恢复完整详情；full refresh 与 API restart 后状态和 Shipment 不丢失；
  事件持久性由 Receiver 独立验证，不要求 UI 展示事件历史。
- **时限/映射**：120 秒；H-03、H-07。

### PF-E2E-09 确定性跨仓拆分及 UI 分组

- **拓扑/数据**：3 个 Warehouse、2 个 SKU；没有单仓可满足但总量足够；相同 priority 的
  Warehouse 使用可确定 UUID tie-break；提交顺序与 `skuId ASC` 相反。
- **动作**：创建 Order，展开所有 Fulfillment，逐项查看 Warehouse、lines、quantity 和状态。
- **通过标准**：先按 `skuId ASC`，再按 `(priority, warehouseId)` 分配；同一 SKU 可跨仓；
  每个参与 Warehouse 恰好一个 Fulfillment；UI 的分组、数量与独立 oracle 完全一致；
  singular `fulfillment` 为 null，`fulfillments[]` 完整。
- **时限/映射**：两个 viewport 各 120 秒；H-09、H-10。

### PF-E2E-10 Split 从部分发货到全部发货

- **拓扑/数据**：至少 3 个 Fulfillment 的 split Order；真实 Worker，runner 使用可证明的
  deterministic process barrier 只让第一组先提交，然后再释放其余组。
- **接线前置条件**：需要第 3 节定义的公平 Worker barrier；满足前保持 `designed_unwired`。
- **动作**：保持详情页打开，观察第一组完成，再启动 replacement Worker 完成其余组。
- **通过标准**：UI 自动观察 ALLOCATED → PARTIALLY_SHIPPED → SHIPPED；中间只有已提交组有
  Shipment，其余仍 PENDING；最终每组恰好一个 Shipment；各仓库存仅按本组结算一次；事件
  sequence 连续。
- **时限/映射**：180 秒；H-09、H-10。

### PF-E2E-11 Split 全部 pending 时整单取消

- **拓扑/数据**：2～3 个 Fulfillment 的 split Order，不启动 Worker。
- **动作**：页面展开全部分组后点击 Cancel，再查看 Inventory、History 并整页刷新；随后启动
  Worker 并跨过一个 lease deadline，验证已取消分组不会被遗留 work 发货。
- **通过标准**：Order 与所有 Fulfillment 全部 CANCELLED；各仓 reserved 全释放且 onHand
  不变；Worker 启动后也不会产生 Shipment；Receiver 恰好观察到合法的 allocated/cancelled
  sequence，没有多余业务事件；刷新后结果不变。
- **时限/映射**：120 秒；H-09、H-10。

### PF-E2E-12 部分发货后的 stale-tab 取消冲突

- **拓扑/数据**：两个 Browser context 打开同一 split Order；真实双 Worker；Harness 延迟
  stale tab 的 GET，但不伪造任何业务 response。
- **接线前置条件**：除 GET proxy 外，还需公平地保持至少一个分组 PENDING；满足第 3 节的
  Worker barrier 前保持 `designed_unwired`。
- **动作**：先让一个 Fulfillment 发货；stale tab 在尚未显示新状态时发出真实 Cancel；随后
  释放其余 Worker。
- **通过标准**：Cancel 返回并展示 `ORDER_NOT_CANCELLABLE` 或公开等价冲突；已发货组及库存
  不回滚，未发货组不被部分取消并最终 SHIPPED；两个 tab 最终收敛；每组最多一个 Shipment。
- **时限/映射**：180 秒；H-07、H-10。

## 6. Concurrency：6 个

Concurrency case 都使用至少两个 API；涉及发货时使用至少两个真实 Worker。请求通过客户端
barrier 同时释放，最终从公开 API 审计全部受影响对象，而不是只统计 HTTP 状态码。

### PF-CON-01 双 API 多行热库存竞争

- **拓扑/数据**：API-A + API-B；64 个并发请求；单仓 SKU-A/SKU-B 各 `onHand=40`；每单
  两行各 2 件，一半按 A/B、另一半按 B/A 排列，全部使用不同幂等键。
- **动作**：barrier 同时释放 64 个真实 HTTP 创建请求，Worker 保持停止。
- **通过标准**：恰好 20 个 201、44 个公开容量 409；无 deadlock/5xx/部分订单；最终 20
  Orders、40 Lines、40 个可从响应重建的 Allocation 语义、20 Fulfillments；两个 SKU 均为
  onHand 40、reserved 40、available 0。
- **时限/映射**：120 秒；H-04、H-07。

### PF-CON-02 相同 key + 相同 payload 的跨实例风暴

- **拓扑/数据**：API-A + API-B；100 个并发请求全部使用同一 key 和完全相同的多行 payload。
- **动作**：所有请求经过 Harness proxy；proxy 观察到两个 upstream 都已接收预设数量请求，
  并扣留至少一个完整 response 后终止 API-A；预期连接中断使用原 key 从存活 API bounded
  replay；收敛后启动 API-C 并再重放 10 次。
- **通过标准**：所有成功重放的原 HTTP status、规范化 body 和 OpenAPI 明确规定的 response
  headers 相同且指向同一 Order；100 个逻辑请求经过 bounded replay 后全部取得同一最终结果；
  只有一套业务副作用；重启不重置幂等结果；0 500。
- **时限/映射**：180 秒；H-04、H-07。

### PF-CON-03 相同 key + 不同 payload 的 winner/conflict 收敛

- **拓扑/数据**：API-A + API-B；32 个请求 payload-A，32 个请求 payload-B；全部共用同一
  scoped idempotency key，两个 payload 都各自合法但业务内容不同。
- **动作**：同时释放 64 个请求；完成后从第三个 API 分别重放 A 和 B。
- **通过标准**：只能有一个 payload 成为权威结果；胜出 payload 的全部请求最终返回同一
  结果，另一 payload 全部为 409 `IDEMPOTENCY_CONFLICT`；仅一套业务副作用；第三实例保持
  相同 winner/conflict。
- **时限/映射**：120 秒；H-04、H-07。

### PF-CON-04 多仓候选与反序多行锁竞争

- **拓扑/数据**：两个可完整满足的 Warehouse，各有 4 个 hot SKU、每 SKU 30 件；80 个并发
  Order，每单四行各 1 件，随机反转/轮转 line 顺序，使用不同 key。
- **动作**：两个 API 同时接受全部请求，Worker 停止；proxy 观察到两个 upstream 均已接收
  请求且扣留预设 response 后重启其中一个 API；发生 transport unknown outcome 的请求必须
  用原 key bounded replay 后再计入终态。
- **通过标准**：恰好 60 个 Order 成功，其中 30 个落在稳定首仓、30 个落在次仓，但不规定
  具体 request identity 或完成顺序；20 个容量冲突原子失败；无数据库 deadlock 暴露为 5xx；
  每个成功 Order 只使用一个仓库。
- **时限/映射**：180 秒；H-04、H-07。

### PF-CON-05 四 Worker 共享 Fulfillment backlog

- **拓扑/数据**：两个 API、4 个 Worker；创建 200 个单 Fulfillment Order 后同时启动 Worker。
- **动作**：四个 Worker 同时处理同一 backlog；本 case 不暂停或终止进程，只隔离多 Worker
  claim/commit 竞争，故障恢复由 `PF-REC-01` 与 `PF-REC-02` 判断。
- **通过标准**：200 个 Order 全部 SHIPPED；每个 Fulfillment 恰好一个 Shipment、一次
  Allocation settlement；DomainEvent 不重不漏，webhook delivery 可重复但 identity/body
  必须稳定。
- **时限/映射**：240 秒；H-05、H-07。

### PF-CON-06 Split 发货与整单取消竞态矩阵

- **拓扑/数据**：两个 API、两个 Worker；共 20 轮，每轮一个两仓 split Order，并使用该轮
  专属库存 fixture，前轮终态不能改变后轮容量。
- **动作**：两个 Worker 竞争 Fulfillment，同时由另一 API 发起 Cancel；Harness 记录自己控制
  的 request release schedule 和 observed timeline，不声称 private seed 可以复现 OS/DB 调度；
  oracle 对两种合法赢家都成立。
- **通过标准**：每轮只能有两类合法终态：取消先线性化则全部 CANCELLED、0 Shipment、onHand
  不变；任一发货先线性化则 Cancel 为公开 409，最终全部 SHIPPED、每组一个 Shipment。
  任何轮次不得永久停在 PARTIALLY_SHIPPED，也不得出现混合 CANCELLED/SHIPPED 分组。
- **时限/映射**：300 秒；H-07、H-10。

## 7. Recovery：6 个

Recovery case 必须包含真实 `SIGKILL`，不能只用抛异常、SIGTERM 或 mock 代替。`PF-REC-02`
可先用 SIGSTOP 构造 stale owner，但最后必须 SIGKILL 旧 Worker。Response shield 与 webhook
ACK barrier 完全由 Harness 控制。Worker claim/commit 边界若需要精确屏障，runner 实现必须
先证明该屏障可观测且不依赖 timing luck，也不得要求候选增加私有 grader route；在这一点
实现前，相应 case 只能保持“设计未接线”，不能显示 passed。

### PF-REC-01 活跃 Worker 在非空 backlog 中死亡

- **拓扑/数据**：一个 API、Worker-A，随后加入 Worker-B；至少 200 个已分配 Order。
- **故障动作**：启动 Worker-A；公开 API 观察到首批 Shipment 且 backlog 仍非空时，对活跃
  Worker-A 发送 SIGKILL；立即启动 Worker-B，并跨过 lease deadline 观察剩余工作。
- **通过标准**：所有 Order 最终完成，没有永久卡在 ALLOCATED；每个 Fulfillment 恰好一个
  Shipment、一次 settlement，reserved 清零且库存只扣一次。这个黑盒 case 证明 backlog
  恢复；精确 claim-before-commit fencing 由 `PF-REC-02` 单独负责。
- **时限/映射**：lease deadline + 30 秒；H-05。

### PF-REC-02 Lease 过期后的旧 Worker 不得提交

- **拓扑/数据**：一个 API、Worker-A + Worker-B；单个目标 Fulfillment，短但公开合法的 lease。
- **接线前置条件**：需要第 3 节定义的公平 durable-claim barrier；满足前保持
  `designed_unwired`。
- **故障动作**：Worker-A durable claim 后 SIGSTOP；lease 过期后 Worker-B 重新领取并提交；再
  SIGCONT Worker-A，让旧 owner 尝试继续，最后对旧 Worker 发送 SIGKILL。
- **通过标准**：过期 owner 不能覆盖新 owner；恰好一个 Shipment、一次 settlement；库存只扣
  一次；V1 的 allocated/order shipped 和 FINAL 的 allocated/fulfillment
  shipped/order shipped 均按各自公开合同保持 sequence 连续；再等两个 lease 周期计数不变。
- **时限/映射**：固定公开合法配置 `DISPATCH_TASK_TIMEOUT_SECONDS=2`、poll interval 50ms；
  readiness 后 hard timeout 30 秒；H-05、H-07。

### PF-REC-03 Split 部分发货时 Worker 被杀

- **拓扑/数据**：一批三个 Warehouse 的 split Order；Worker-A + Worker-B，恢复时加入 Worker-C。
- **故障动作**：公开 API 首次观察到至少一个 Order 为 PARTIALLY_SHIPPED 且总 backlog 仍非空时，
  SIGKILL Worker-A；对该 partial Order 发起 Cancel；继续运行 Worker-B，并在 lease deadline 后
  加入 Worker-C 完成全部遗留组。
- **通过标准**：partial Order 的 Cancel 为 409 且无副作用；全部 Order 最终 SHIPPED，每组各
  一个 Shipment/settlement，reserved 归零；事件 sequence gap-free；进程死亡不留下永久 partial。
- **时限/映射**：2 个 lease deadline + 60 秒；H-05、H-10。

### PF-REC-04 Dispatcher 在 Receiver 已接收、ACK 未返回时死亡

- **拓扑/数据**：API、Worker、Receiver、Dispatcher-A，随后 Dispatcher-B；V1 创建一个产生
  allocated/order shipped 的 Order；FINAL 创建一个会产生 allocated、fulfillment shipped、
  order shipped 的 split Order。
- **故障动作**：Receiver 读完 sequence 1 的 headers/body 并打开私有 barrier，但暂不返回 ACK；
  此时 SIGKILL Dispatcher-A 并记录旧连接断开；启动 Dispatcher-B，仅对它发出的同事件重投
  返回 204。
- **通过标准**：sequence 1 被重投，重复副本的 eventId、type、aggregateId、sequence 和规范化
  body 完全一致；V1 可观察 `[1,1,2]`，FINAL 可观察 `[1,1,2,3,...]`；忽略 duplicate 后的首次
  成功 sequence 必须严格递增且 gap-free；无事件丢失。
- **时限/映射**：replacement 启动后最多 120 秒；单次 attempt 受 `WEBHOOK_TIMEOUT_MS` 约束，
  不使用 Worker lease 计算 Dispatcher deadline；H-06。

### PF-REC-05 503、timeout、双 Dispatcher 与重启

- **拓扑/数据**：两个 API、一个 Worker、两个 Dispatcher、本地 Receiver；创建 50 个会产生
  多 sequence event 的 Order。
- **故障动作**：Receiver 按固定私有脚本返回 503、连接 timeout、204；在预设 Receiver attempt
  读完 body、ACK 未返回的可观测 barrier 上 SIGKILL 一个 Dispatcher 并启动 replacement；
  另一个持续运行。
- **通过标准**：每个 committed event 最终至少成功一次；所有 attempt 复用 event identity 和
  语义 body；同 Order 后序 sequence 不越过尚未成功的前序；两个 Dispatcher 不造成状态损坏。
- **时限/映射**：300 秒；H-06、H-07。

### PF-REC-06 V1 populated database 冷升级到 FINAL

- **拓扑/数据**：先用 V1 snapshot 启动两 API、Worker、Dispatcher；创建 ALLOCATED、SHIPPED、
  CANCELLED Order，保留一个尚未处理的 durable Task、一个通过 ACK barrier 暂未确认的 outbox
  delivery、多个稳定幂等 replay response 和 Receiver ledger。
- **故障动作**：SIGKILL 全部 V1 应用进程但保留 PostgreSQL/Receiver；用 FINAL snapshot 仅执行
  公开 migration，重复执行一次；启动全新 FINAL 进程组，完成遗留工作，再整体冷重启一次。
- **通过标准**：历史 Order、Allocation、Shipment、库存、事件、sequence、pending work 和旧
  replay response 不丢失或改写；遗留 Task 只产生一个 Shipment/settlement，遗留 Delivery
  最终成功且允许语义稳定的重复；旧/new 单仓 singular response 保持兼容，split 为 null 且
  `fulfillments[]` 完整；migration 重跑无业务副作用；重启后结果一致。
- **时限/映射**：20 分钟；H-08，并回归 H-04、H-05、H-06。

## 8. Performance：4 个

`PF-PERF-01` 与 `PF-PERF-02` 先预热 15 秒、测量 90 秒、运行三次。每次 run 使用全新
database/fixture。延迟和吞吐取三次中位 run，但 correctness 要求三次全部通过。每轮都报告
p50/p95/p99、吞吐、状态码和业务结果。

### PF-PERF-01 大数据集混合查询

- **拓扑/数据**：100 Warehouses、20,000 SKUs、1,000,000 StockPositions、200,000 historical
  Orders、1,000,000 OrderLines；64 clients、两个 API。
- **负载**：inventory list/search/filter 45%、SKU search 15%、history 20%、order detail 20%；
  查询词、过滤器、API 实例和 cursor chain 随机化；只有 oracle 确认结果充足的查询池才连续
  遍历 10～30 页，较小结果集必须正确走到 exhaustion，避免只缓存首页。
- **通过标准**：aggregate p95 <= 250ms，throughput >= 250 req/s；response 与 seed oracle 一致；
  每条 cursor chain 顺序正确、无重复遗漏；unexpected 5xx 为 0。
- **时限/映射**：3 × (15 秒 + 90 秒) 加 setup；H-12 查询 2 分 assertion group。

### PF-PERF-02 Hot inventory mutation soak

- **拓扑/数据**：8 Warehouses、32 hot SKUs、200 clients、两个 API、两个 Worker；使用足够但会
  持续竞争的库存。
- **负载**：固定为 55% 多行 create、15% 符合条件的 cancel、20% public read、10% 等价幂等
  replay；请求均匀分发到两个 API；预期 409 单独统计。
- **通过标准**：mutation p95 <= 750ms，aggregate >= 120 req/s，成功 create + cancel >= 60/s；
  successful mutation 只统计产生新业务效果的 create/cancel，不把 replay 重复计入；unexpected
  5xx 为 0；每轮结束后全部 Order 收敛且公共业务不变量全通过。
- **时限/映射**：3 × (15 秒 + 90 秒)，每轮停止发压后最多 120 秒收敛；H-12 mutation 2 分
  assertion group。

### PF-PERF-03 5,000 Worker task backlog 排空

- **拓扑/数据**：通过公开 API 在 Worker 停止时创建 5,000 个单 Fulfillment Order；随后启动
  两个 Worker，Dispatcher 可运行但不计入本 case 的通过时间。
- **负载**：同时启动两个 Worker，持续记录每秒完成数量和剩余 backlog；本 case 不注入额外
  进程故障，故障恢复由 `PF-REC-01` ～ `PF-REC-03` 独立判断。
- **通过标准**：启动后 60 秒内 >=95% Order SHIPPED，120 秒内全部 SHIPPED；每个 Fulfillment
  一个 Shipment、一次 settlement；库存与事件正确。
- **时限/映射**：setup 之外 150 秒；仅为不直接计分的 Worker capacity 诊断，不把该额外 SLA
  映射到 H-12；公开 performance 分只使用 `PF-PERF-04` 的联合场景。

### PF-PERF-04 5,000 Task + 5,000 Delivery 联合恢复

- **拓扑/数据**：Worker/Dispatcher 停止时通过公开 API 创建 5,000 个 ALLOCATED Order，从而
  形成 5,000 个 due work items 和 5,000 个 pending allocation deliveries；随后使用两个 Worker、
  一个 Dispatcher、本地 Receiver、production build 与固定资源限制。
- **负载/故障**：同时启动 Worker/Dispatcher；Receiver 前 10 秒返回 503，之后 204。除公开的
  receiver failure 外不叠加进程终止，SIGKILL 由独立 Recovery case 判断。
- **通过标准**：从第一个 204 起，60 秒内至少 4,750 个 Order 已 SHIPPED 且对应 allocation/
  shipment events 均成功投递；120 秒内 5,000 个全部完成；重投 identity/body 稳定，无重复
  Shipment/settlement、无 sequence 越序、unexpected 5xx 为 0。
- **时限/映射**：setup 之外 150 秒；H-12 backlog/recovery 2 分 assertion group。

## 9. Post-load invariant audit：1 个

### PF-AUD-01 Mixed-chaos 后全量不变量审计

- **拓扑/数据**：新的独立 database；两个 API、两个 Worker、两个 Dispatcher、Receiver；
  生成单仓与 2～4 仓 split Order、成功/失败 create、cancel、等价/冲突幂等 replay、历史数据，
  并记录全部合法输入 oracle。
- **动作**：manifest 固定 1,000 个逻辑 mutation 的类型比例、200-client release batches 和
  故障次数；API restart、Worker SIGKILL、Dispatcher SIGKILL、response loss、503、timeout 与
  ACK loss 分别由已接受请求数、已完成 Shipment 数和 Receiver attempt 数触发。运行不超过
  公开的 90-second hot-mutation envelope，且不设新的隐藏吞吐阈值。主动注入的连接错误必须
  使用原 key bounded replay；停止发压后等待 bounded 收敛，再冷重启全进程组。
- **全量判定**：通过公开 API 遍历而非抽样检查全部 Inventory、Order、OrderLine、Fulfillment
  与 Shipment，并从公开分组重建 Allocation 语义；用原请求重放验证幂等结果，用 Receiver
  ledger 验证 DomainEvent 与 outbox 的外部效果，用终态验证 Task 已收敛。不得读取或假定候选
  私有表名。执行第 4 节全部公共判定；Harness 已确认提交的每个 Order 必须可查询，失败
  create 不得留下任何副作用。
- **通过标准**：所有工作收敛，全部不变量为真，unexpected 5xx 为 0；任何一个 invariant 失败
  都使 H-12 全部 7 分为 0，并应用主方案相应 hard cap。
- **时限/映射**：负载 90 秒，收敛最多 5 分钟；H-12 correctness 1 分 assertion group及
  全局 hard-cap 证据。

## 10. 结果与评分聚合

每个 case 输出独立 JSON，至少包含：

```json
{
  "schemaVersion": 1,
  "caseId": "PF-CON-03",
  "snapshot": "FINAL",
  "status": "failed",
  "durationMs": 12345,
  "assertions": { "passed": 17, "failed": 1 },
  "metrics": { "unexpected5xx": 0 },
  "failureClass": "idempotency_conflict_convergence",
  "privateSeedHash": "sha256:..."
}
```

29 个 case 不按“每个 1/29 分”平均计分。它们把证据聚合回 H-03 至 H-10 与 H-12 已定义的
assertion groups；Checklist 权重仍以 `checklist.json` 为唯一 authority。一个 case 可以为
多个 H 场景提供回归证据，但同一断言不能重复计分。

Machine-readable manifest 必须把每个映射标成 `required` 或 `diagnostic`，并落到主方案已有的
具体 assertion group，而不是笼统落到整个 H ID。一个 assertion group 只有在它的全部
`required` case executions 通过时才通过；`diagnostic` 失败只提供定位证据，不直接改变分数。
`PF-PERF-03` 当前是 diagnostic；`PF-E2E-10`、`PF-E2E-12` 与 `PF-REC-02` 在屏障前置条件
完成前是 `designed_unwired`。正式接线时不得为了迁就 baseline 结果事后改变这些属性。

正式接线前必须完成：

1. 为每个 ID 创建真实 asset 与 command，并证明 `--case <id>` 只运行该 case；
2. 对所有故障屏障做 evaluator self-test，证明实际到达声明的故障窗口；
3. 做 mutation test：故意破坏被测实现的关键不变量时，相应 case 必须稳定失败；
4. 校验 29 个 ID 唯一、无 skip、无共享 database/port/process/browser state；
5. 将 case 到 H assertion group 的单一映射写入 machine-readable manifest；
6. 用至少三次 Terra medium baseline 校准，确认失败类型和耗时分布，而不是只看总分。
