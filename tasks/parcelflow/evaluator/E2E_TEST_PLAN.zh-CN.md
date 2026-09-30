# ParcelFlow Integration / E2E / Concurrency / Recovery / Performance 测试方案

## 1. 状态与目的

这份文档定义 ParcelFlow 的私有评测设计。它不属于 Codex 可见的 workspace，不能复制到
`/workspace`，也不能在项目开发或 Frontal Session Evolution 期间挂载。

> **当前状态：细粒度 runner 已实现并接线。** `task.json` 会运行 25 个 `required` 独立场景
> 以及项目自有的 `test:all`；checklist 只把与评分项直接对应的可执行场景声明为硬 gate。
> `PF-E2E-10`、`PF-E2E-12`、`PF-REC-02` 因缺少不依赖时序运气的公开屏障而保持
> `designed_unwired`，`PF-PERF-03` 仅为 diagnostic。H-01、H-02、H-11、H-13 尚无独立的
> Harness runner，不能被表述为已自动验证。本文描述实现状态，不是任何候选项目已经通过的证据。

测试分为两层：

1. **Project-owned tests**：公开 README 要求 Codex 在项目内实现的测试；
2. **Harness-owned tests**：Codex 完成开发且 workspace 冻结后，从应用外部运行的隐藏测试。

隐藏测试只组合 README 和 Manager prompt 已经公开的行为，不增加隐藏业务规则。随机化的
UUID、库存量、请求顺序、并发时序、进程终止点和数据规模只用于防止样例特判。

H-03 至 H-10 与 H-12 的细粒度 case 设计见
[`INDEPENDENT_STRESS_SCENARIOS.zh-CN.md`](./INDEPENDENT_STRESS_SCENARIOS.zh-CN.md)。其中
25 个 `required` case 已接入正式评测；其余场景的状态以 manifest 为准，不能把“已实现”
表述成“已运行”或“已通过”。

## 2. 评分权威与范围

`experiments/parcelflow/checklist.json` 是唯一分值权威，总分 100：

| Checklist item | 分值 |
| --- | ---: |
| Clean build and operation | 5 |
| Contract validation and seed | 5 |
| Base inventory and order lifecycle | 10 |
| Atomic allocation and durable idempotency | 10 |
| Worker and outbox crash recovery | 15 |
| Multi-process consistency | 10 |
| Manager split compatible migration | 15 |
| Manager split runtime, API, UI and concurrency | 10 |
| Project-owned test gates | 8 |
| Performance correctness | 7 |
| Junior explanation quality | 2 |
| Evidence and handoff quality | 3 |
| **合计** | **100** |

隔离 Judge 对全部 checklist 项给出评分；声明了 `testGates` 的 correctness 项还受确定性
硬 gate 约束，任一对应 gate 失败时该项直接为 0，Judge 不能覆盖失败结果。当前没有专属
runner 的 `clean-build-and-operation` 与 `contract-validation-and-seed` 仍由 Judge 根据可见
workspace、项目自有测试和测试摘要评估。最后 5 分为对话解释和 handoff 的 persona 评分。

以下行为明确不属于 V1 或 Manager 变更，隐藏测试不得据此扣分：

- partial cancellation；
- shipment 后的库存 reallocation；
- backorder 或人工补货流程；
- 全局 webhook 顺序；
- webhook exactly-once delivery。

## 3. 固定环境

首版固定环境：

| 项目 | 配置 |
| --- | --- |
| OS | Linux arm64 OCI image |
| CPU / RAM | 4 vCPU / 8 GiB，测试进程共享限制 |
| Node.js | 22.x，固定 patch version |
| PostgreSQL | 16.x，固定 patch version |
| Browser | Harness 自带的固定版本 Chromium |
| Application | 两个 API/UI 进程，共享一个 PostgreSQL |
| Workers | 两个 fulfillment worker |
| Dispatchers | 一个或两个 outbox dispatcher，按场景决定 |
| Webhook | Harness 本地 receiver，不访问外网 |
| Clock | VM 实时时钟，统一 UTC |
| External network | 关闭；只允许 loopback 和测试 PostgreSQL |

Harness 自带并控制：

- Chromium 和 Playwright driver；
- OpenAPI 3.1 validator 和请求生成器；
- HTTP response shield；
- webhook receiver、ACK barrier 和事件记录器；
- 多进程 supervisor；
- load generator、latency histogram 和 invariant checker。

隐藏 Browser E2E 不从候选项目加载 Playwright，也不要求候选暴露内部组件。隐藏测试不
import 候选源码、不读取 ORM model、不假定表名，也不硬编码 `dist/` 或其他构建目录。

## 4. 公开启动面

Harness 只使用 README 公开的命令：

```text
npm ci
npm run db:migrate
npm run seed -- --file /absolute/path/to/seed.v1.json
npm run build
npm start
npm run worker
npm run dispatcher

npm run test:unit
npm run test:integration
npm run test:e2e
npm run test:concurrency
npm run test:recovery
npm run test:all
npm run test:perf
```

`npm test` 必须是 `npm run test:all` 的 alias。Harness 通过独立进程组启动和终止命令，
不直接执行候选项目的私有入口文件。

使用的公开环境变量为：

```text
DATABASE_URL
TEST_DATABASE_URL
PORT
ADMIN_TOKEN
WEBHOOK_URL
WORKER_POLL_INTERVAL_MS
DISPATCH_TASK_TIMEOUT_SECONDS
OUTBOX_POLL_INTERVAL_MS
WEBHOOK_TIMEOUT_MS
```

API readiness 通过 bounded polling 请求 `GET /api/health`，不用固定 sleep 代替启动检查。
每个普通场景使用新的 database；只有 H-08 会有意让 V1 和 FINAL 共用一个数据库，以验证
真实兼容迁移。

## 5. 两个冻结快照

Harness 必须保留两个不可变快照：

1. **V1 snapshot**：Codex 完成单仓版本、公开测试和 recovery 验证后，在 Manager 需求
   公开前冻结；
2. **FINAL snapshot**：Codex 完成 Manager 跨仓拆单、回归和最终 handoff 后冻结。

冻结内容包含 workspace 文件、Git commit/diff 摘要、lockfile hash 和生成时间，但不包含
`node_modules`、数据库、日志或隐藏测试。顺序为：

```text
完成 V1 开发回合
-> 冻结 V1 snapshot
-> Manager 首次公开跨仓拆单需求
-> 完成最终开发回合
-> 冻结 FINAL snapshot
-> 停止 Agent 写入
-> 同一 Codex session 运行 Frontal Session Evolution
-> 在隔离 evaluator 中只读挂载两个冻结快照和 hidden assets
```

评分只读取冻结快照。Evolution 生成的 Skill、状态或任何后续 workspace 修改不能进入本次
项目得分。

Manifest 保留了部分 case 在 V1 与 FINAL 上独立运行的能力；当前正式 `task.json` 对可执行
细粒度 case 评分 FINAL，`PF-REC-06` 单独读取 Harness 冻结的 V1 snapshot 并在同一数据库上
升级到 FINAL。不能把 manifest 中声明的快照适用范围误报成每次正式评分都已执行的 subrun。

## 6. 确定性故障注入

### 6.1 HTTP response shield

Harness 把代表性的 mutation 通过本地 reverse proxy 发给 API。Proxy 完整读取并私下记录
upstream 的 status、合同相关 headers 和 JSON body 后，不把响应交给 client，而是关闭
下游连接。此时 client 得到确定的 unknown-response outcome，但服务端已经完成原请求。

Harness 随后把相同 `Idempotency-Key` 和相同请求发给另一个 API 实例，验证：

- 重放得到同一逻辑 status 和 response；
- 相同 key、不同 payload 得到公开的 conflict；
- 库存、Order、Allocation、Fulfillment、DispatchTask 和 DomainEvent 没有重复副作用；
- API 重启后仍能重放相同结果。

比较 JSON 的规范化语义，不把无意义的 whitespace 或 header 顺序当作差异。合同明确要求
稳定的字段、timestamp、resource ID 和 error code 必须保持一致。

### 6.2 Webhook ACK barrier

Harness-owned receiver 在读取完整 webhook headers 和 body 后打开一个私有 barrier，但先不
发送 HTTP ACK。Harness 看到 barrier 后立刻 `SIGKILL` dispatcher 进程组，再启动新的
dispatcher；不依赖随机 sleep 猜测 kill 时点。

Receiver 对重投事件发送 2xx，并验证：

- 第一次未收到 ACK 的事件不会丢失；
- 重投复用相同 `eventId`；
- 规范化后的业务 body 与第一次完全相同；
- 重投可以重复到达，符合 at-least-once；
- 对同一 Order，首次成功投递按递增 `sequence` 发生。

Receiver 的控制面只对 Harness 可见。候选应用只获得 `WEBHOOK_URL` 数据面地址。

## 7. Project-owned 测试最低要求

### 7.1 Integration

`npm run test:integration` 至少覆盖：

| ID | 场景 |
| --- | --- |
| PI-01 | 空数据库 migration、有效 seed 和查询 |
| PI-02 | 非法 seed 靠近文件末尾时仍然原子失败 |
| PI-03 | OpenAPI 输入、错误 envelope、cursor 和 authorization |
| PI-04 | 多 SKU 单仓完整分配和库存 reserved 变化 |
| PI-05 | 无单仓可完整满足时 409 且无部分副作用 |
| PI-06 | deterministic warehouse priority / warehouseId tie-break |
| PI-07 | 所有 mutation 的 replay 和 same-key/different-payload conflict |
| PI-08 | fulfillment worker 发货并一次结算 Allocation |
| PI-09 | 整单取消释放 reserved；重复取消不重复释放 |
| PI-10 | shipment 与 cancellation 竞争只有一个合法结果 |
| PI-11 | outbox 非 2xx 重试、event identity 和 per-order sequence |
| PI-12 | API、worker、dispatcher 重启后继续读取和处理持久状态 |

Manager 需求公开后增加：

| ID | 场景 |
| --- | --- |
| PI-M01 | V1 populated database 原地升级且历史数据保持不变 |
| PI-M02 | single-warehouse-first 规则仍优先于 split |
| PI-M03 | deterministic split allocation 和库存不足的整单原子失败 |
| PI-M04 | 多 Fulfillment 状态聚合、Shipment 和 DomainEvent |
| PI-M05 | 单仓 `fulfillment` 兼容、拆单为 `null`、`fulfillments[]` 完整 |
| PI-M06 | 任一 Fulfillment 发货后整单取消被拒绝 |

### 7.2 Browser E2E

`npm run test:e2e` 必须使用 production build、真实 PostgreSQL、真实 API 和真实 Chromium，
不得 mock API。至少覆盖：

| ID | 用户流程 |
| --- | --- |
| PE-01 | warehouse / SKU 目录 -> 库存筛选 -> 创建多行订单 -> 查看分配和状态自动刷新 |
| PE-02 | 创建订单 -> 整单取消 -> 页面展示 CANCELLED 和恢复后的库存 |
| PE-03 | 创建订单 -> worker 发货 -> 页面展示 Shipment 和库存结算 |
| PE-04 | 整页刷新 -> 从服务端恢复订单、Fulfillment 和事件历史 |

Manager 需求公开后增加：

| ID | 用户流程 |
| --- | --- |
| PE-M01 | 创建跨仓订单 -> 展开多个 Fulfillment -> 观察 PARTIALLY_SHIPPED -> SHIPPED |
| PE-M02 | 拆单发出一组后尝试整单取消 -> UI 显示公开 conflict，已发货数据不变 |

### 7.3 Concurrency 与 recovery

`npm run test:concurrency` 至少启动两个 API 和两个 worker，共享一个 `DATABASE_URL`。
`npm run test:recovery` 必须实际终止并重启 worker 或 dispatcher 进程。最低覆盖：

- hot SKU 并发分配不超卖；
- 同一 idempotent mutation 跨两个 API 只产生一个逻辑结果；
- shipment / cancellation 竞争不重复结算库存；
- worker 持有 lease 时死亡，超时后由另一个 worker 恢复；
- dispatcher 在 webhook 未 ACK 时死亡，事件最终重投；
- Manager 后同一 Order 的不同 Fulfillment 可并行发货，每组最多一个 Shipment。

## 8. Harness-owned 隐藏场景

### H-01 Clean install, migration, build and boot - 5 分

**快照：V1 + FINAL。对应 checklist：clean-build-and-operation。**

步骤：

1. 从冻结快照创建干净副本，验证精确 lockfile；
2. `npm ci`，对空数据库运行 `npm run db:migrate`；
3. 导入随机有效 `seed.v1.json`；
4. 运行 production build；
5. 只通过公开命令启动两个 API、一个 worker 和一个 dispatcher；
6. 轮询 health，请求 UI root 和一个只读 API；
7. 向每个长进程发送 `SIGTERM`，验证十秒内安全退出；
8. 重启全部进程，再次读取 seed 数据。

通过条件：所有命令非交互成功；生产 UI/API/worker/dispatcher 可运行；重启后数据不丢；
不依赖 dev server 或未公开入口。任一快照不能 clean boot 时本项为 0。

### H-02 Contract, validation and seed - 5 分

**快照：V1 + FINAL。对应 checklist：contract-validation-and-seed。**

Harness-owned validator 校验 `openapi.yaml` 为 OpenAPI 3.1，并从 schema 为每个 endpoint
生成有效和无效请求。组合包含错误 content type、malformed JSON、missing/unknown field、
wrong type、超界 integer、blank string、非法 UUID、非法 cursor、非法 token 和非法
idempotency key。每个 write endpoint 都要验证缺失 key，以及不满足 8 至 128 个 printable
ASCII characters 的 key；admin mutation 还要验证 Bearer `ADMIN_TOKEN`。

Seed 组合包含最小有效、随机有效、大型有效，以及违反公开 schema 的 duplicate identity、
悬空引用、非法数量、非法 timestamp 和靠近文件末尾的错误。非法导入前后通过公开 API
比较业务状态，不能出现部分 Warehouse、SKU、StockPosition 或历史 Order。另在已有任意
application data 的数据库上导入，必须拒绝且保持原数据不变。

通过条件：README、OpenAPI、runtime status/schema/error code 一致；合法 seed 可重复查询；
非法 seed 非零退出且状态不变；错误不泄露 stack、SQL、token、数据库 URL 或绝对路径。

### H-03 Base API and browser lifecycle - 10 分

**快照：V1 + FINAL。对应 checklist：base-inventory-and-order-lifecycle。**

通过 admin API 创建多个 Warehouse、SKU 和 StockPosition，执行以下黑盒流程：

1. 列表、搜索和筛选目录与库存；
2. 创建包含 1 至 8 个不重复 SKU 的 Order；
3. 查询 Order、singular Fulfillment 和库存 reserved，并从公开结果重算预留数量；
4. 在 worker 未启动时取消整单并检查 reserved 恢复；
5. 另建 Order，启动 worker，检查 Shipment、SHIPPED 和 onHand/reserved 同量减少；
6. 重复读取 history 和 cursor 页面；
7. 在 390x844 与 1280x800 viewport 用 Harness Chromium 完成相同核心流程。

Browser 只使用可见 role、label、heading、button 和文本，不依赖私有 CSS selector。

通过条件：API 和 UI 的资源、状态、历史、自动刷新和错误展示一致；所有时刻满足
`0 <= reserved <= onHand`；取消只减少 reserved；发货同时减少相同数量的 reserved 和
onHand；刷新后状态来自服务端。

### H-04 Atomic allocation and durable idempotency - 10 分

**快照：V1 + FINAL。对应 checklist：atomic-allocation-and-durable-idempotency。**

场景包括：

- 多个仓库都只有部分 SKU，合计足够但 V1 没有单仓完整容量；
- 多个仓库均可完整满足，priority 相同或不同，ID 顺序随机；
- 两个 API 同时处理相同和不同 idempotency key；
- response shield 丢弃已完成 mutation 的 client response；
- API 在 unknown response 后重启，再从另一个实例重放；
- 同一个 scoped operation/resource 使用相同 key 但改变 validated input；
- 相同 key text 用于不同 operation 或 resource，验证各 scope 互不冲突；
- 调换等价 JSON property order、whitespace 和 OrderLine array order。

V1 分配必须按 `(warehouse.priority ASC, warehouseId ASC)` 选择第一个可完整满足整单的
仓库。失败返回公开的 `409 NO_SINGLE_WAREHOUSE_CAPACITY`，且不能留下 Order、Allocation、
Fulfillment、DispatchTask、DomainEvent 或 reserved 变化。成功时这些业务效果同事务出现。

得分组成：原子分配 5 分，跨实例/重启/unknown-response 幂等 5 分。任一业务副作用重复
时对应部分为 0。

### H-05 Worker lease, crash and settlement recovery - 8 分

**快照：V1 + FINAL。对应 checklist：worker-outbox-crash-recovery 的 8/15。**

Harness 在 worker 停止时创建一批已分配 Order，再启动两个 worker。观察到第一批 Shipment
后立即 `SIGKILL` 一个仍在处理 backlog 的 worker，保留另一个 worker，并超过公开的
`DISPATCH_TASK_TIMEOUT_SECONDS` 等待 lease 恢复。随后再终止全部 worker、重启一个新
worker，验证跨完全停机恢复。

Harness 不读取任务表，也不依赖 lease column 名。它只通过公开 Order/Inventory API 和
最终 Shipment 观察结果。

得分组成：

- lease 到期后 backlog 可恢复，无永久卡住任务：3 分；
- 每个 Fulfillment 最多一个 Shipment，Allocation 只结算一次：3 分；
- worker 全停和重启后最终完成，状态与库存守恒：2 分。

### H-06 Transactional outbox, ACK barrier and ordering - 7 分

**快照：V1 + FINAL。对应 checklist：worker-outbox-crash-recovery 的 7/15。**

Receiver 按私有脚本依次返回 503、timeout 和 2xx。部分事件使用第 6.2 节的 ACK barrier：
读取完整 body 后挂起 ACK，精确终止 dispatcher，再由新 dispatcher 接管。另启动两个
dispatcher 验证数据库协调，而不是 process-local queue。

Harness 生成至少三类事件：`order.allocated`、`order.shipped`、`order.cancelled`。失败的
业务 mutation 不得产生事件；已提交业务 mutation 最终必须可投递。

得分组成：

- 业务状态与 DomainEvent 同生共死、没有丢事件：2 分；
- non-2xx/timeout 后会重试并最终成功：1 分；
- ACK barrier 后相同 `eventId` 和语义相同 body 被重投：2 分；
- 同一 Order 的首次成功投递按递增 sequence；不要求跨 Order 全局顺序：2 分。

重复投递本身不扣分；event identity/body 改变、事件丢失或后序 sequence 抢先成功则失败。

### H-07 Two-API / two-worker consistency and races - 10 分

**快照：V1 + FINAL。对应 checklist：multi-process-consistency。**

启动两个 API、两个 worker 和共享 PostgreSQL：

1. 200 clients 对少量 hot SKU 并发创建多行 Order；
2. 相同 mutation 随机分发到两个 API，并穿插 API restart；
3. 对 PENDING Fulfillment 同时启动 worker shipment 和整单 cancel；
4. 在 backlog 中随机终止一个 API 和一个 worker；
5. 等系统收敛后重新查询全部 Order、Inventory、Shipment 和 receiver event。

允许 shipment 或 cancellation 任一合法赢家，但不允许两个结果同时结算。

得分组成：库存和完整分配不变量 4 分；shipment/cancel 竞争 3 分；跨实例 durable
idempotency 2 分；进程终止后无永久卡住或意外 5xx 1 分。

### H-08 V1-to-FINAL compatible migration - 15 分

**快照：V1 + FINAL。对应 checklist：manager-split-compatible-migration。**

这是两快照之间的核心 transfer gate：

1. 用 V1 snapshot 对空数据库 migrate 和 seed；
2. 创建单仓 Order，分别保留 ALLOCATED、SHIPPED、CANCELLED 状态；
3. 通过公开 API 和 receiver 记录 Order、Fulfillment、Shipment、DomainEvent sequence、
   inventory 和多个 idempotency replay response，并留下一个有待处理的 DispatchTask；
4. 停止 V1 的所有进程，保留同一个 PostgreSQL database；
5. 换成 FINAL snapshot，只运行公开的 `npm run db:migrate`；
6. 启动 FINAL API/worker/dispatcher，重新读取并重放旧请求，验证遗留 DispatchTask 仍能
   完成且只产生一个 Shipment；
7. 再次运行 migration，验证幂等；
8. 创建新的单仓和拆单 Order，验证兼容 response shape。

通过条件和分值：

- 公开可观察的历史业务记录、库存、状态、Shipment、待处理工作、Event 和 sequence 不丢失
  或改写；旧 Allocation 通过后续取消或发货的精确库存结算间接验证：6 分；
- 旧 idempotency key 重放保持原逻辑 response 且无新副作用：3 分；
- V1 与新单仓 Order 的 singular `fulfillment` 保持原值；split Order 为 `null`，同时
  `fulfillments[]` 完整；旧 key 的已保存 response body 本身不被改写：3 分；
- migration 可安全重跑，升级本身不发送 webhook、不创建业务副作用：3 分。

禁止通过丢库、重新 seed、重建历史 response 或把全部旧 Order 压成新默认状态来通过。

### H-09 Manager split allocation and aggregate state - 5 分

**快照：FINAL。对应 checklist：manager-split-runtime-ui-concurrency 的 5/10。**

构造三组数据：

1. 一个仓库可完整满足，其他仓库也有库存；必须继续选择单仓，不拆单；
2. 无单仓可满足，但跨仓总量足够；
3. 至少一个 OrderLine 跨所有仓库总量不足。

拆单时 Harness 按公开算法独立计算 oracle：先按 `skuId ASC` 处理行，再按
`(priority ASC, warehouseId ASC)` 分配；同一仓库的 Allocation 形成一个 Fulfillment、
DispatchTask 和最终 Shipment。Case 3 必须整单原子失败。

逐个允许 Fulfillment 发货，验证 Order 从 ALLOCATED 到 PARTIALLY_SHIPPED，再到 SHIPPED。
每个分组产生一个 `fulfillment.shipped`；最后一组提交时还产生 `order.shipped`。同一
Order 的 sequence 唯一、连续，具体并发完成哪一组在前不作隐藏规定。

另创建一个尚无 Fulfillment 发货的 split Order 并整单取消，验证所有分组成为 CANCELLED，
全部 reserved 一次释放且 onHand 不变。

得分组成：deterministic split 与 per-warehouse grouping 2 分；不足时整单原子失败 1 分；
aggregate 状态、库存结算、Shipment 和事件 2 分。

### H-10 Manager API, UI, cancellation and concurrency - 5 分

**快照：FINAL。对应 checklist：manager-split-runtime-ui-concurrency 的 5/10。**

Harness Chromium 创建并查看 split Order，展开每个 Fulfillment 的 warehouse、lines、
status 和 Shipment，并观察自动刷新。API 同时验证 `fulfillments[]` 与 singular
兼容字段。

两个 worker 并发处理同一个 Order 的不同 Fulfillment，并在其中一组发货后并发发送整单
cancel。此时取消必须按公开 contract 被拒绝；其余分组继续恢复和发货。每个 Fulfillment
最多一个 Shipment，每个 Allocation 只结算一次。

得分组成：API/UI 和兼容展示 2 分；两 worker 并发与 crash recovery 2 分；发货后取消
拒绝、聚合状态和 outbox sequence 回归 1 分。

本场景不要求 partial cancellation，也不测试 shipment 后 reallocation。

### H-11 Project-owned test quality - 8 分

**快照：V1 + FINAL。对应 checklist：project-owned-test-gates。**

Harness 在两个不同的新 `TEST_DATABASE_URL` 上分别运行 Unit、Integration、Browser、
Concurrency、Recovery 和 aggregate gate。`test:perf` 只在固定性能数据库上运行一次并审计
输出；真实性能分仍由 H-12 的独立负载决定。仅有 exit code 0 不足以得分。Harness 同时从
候选进程外记录：

- PostgreSQL connection、migration 和真实事务活动；
- loopback HTTP 请求和真实 server listener；
- Chromium 子进程；
- concurrency 时至少两个 API 和两个 worker 的独立 PID/port；
- recovery 时真实进程终止、重启和 deadline 后的业务断言；
- test output 中的 executed、failed、skipped 数量和 timeout。

默认 `DATABASE_URL` 指向不可用或只读的 canary，只有 `TEST_DATABASE_URL` 可写，以发现误用
开发库。第二轮删除第一轮数据库，防止测试依赖残留。

得分组成：有意义的 Unit + real HTTP/PostgreSQL Integration 2 分；production Chromium
E2E 2 分；two-API/two-worker Concurrency + deterministic Recovery 2 分；两次独立可重复的
`test:all`、诚实 `test:perf` 和无核心 skip 2 分。

### H-12 Independent sustained load and recovery - 7 分

**快照：FINAL。对应 checklist：performance-correctness。**

Harness 不采信 `npm run test:perf` 自报数字，使用独立 load generator。固定 4 vCPU / 8
GiB、PostgreSQL 16、两个 API、两个 worker、本地 receiver。吞吐场景预热 15 秒、正式
运行 90 秒、运行三轮，取三轮中位数。

**场景 A - 查询：** 100 warehouses、20,000 SKUs、1,000,000 StockPositions、200,000
historical Orders、1,000,000 OrderLines，64 clients 混合 list/search/detail/history。

- p95 <= 250 ms；
- throughput >= 250 req/s。

**场景 B - hot mutation：** 8 warehouses、32 hot SKUs、200 clients，跨两个 API 混合
create order、cancel 和 read，并使用真实 idempotency key。

- mutation p95 <= 750 ms；
- aggregate throughput >= 120 req/s；
- successful mutations >= 60/s。

**场景 C - backlog/recovery：** 预置 5,000 个 due DispatchTasks 和 5,000 个 due outbox
deliveries，启动两个 worker 和一个 dispatcher。Receiver 前 10 秒返回 503，随后返回 204。

- 第一个 204 后 60 秒内，至少 95% 的 5,000 个 Order 已发货，且对应 allocation 与
  shipment events 都已成功投递；
- 120 秒内 5,000 个 Order 全部发货，所有对应事件都至少成功投递一次。

每轮后重新验证 inventory、Allocation settlement、Order aggregate status、Shipment
uniqueness、idempotency 和 per-order event sequence。预期的 409 business conflict 单独
计数；unexpected 5xx 必须为 0。

得分组成：查询目标 2 分；hot mutation 目标 2 分；backlog/receiver recovery 2 分；全部
负载后 invariant 和 unexpected 5xx 目标 1 分。任一一致性错误使本项 7 分全部为 0。

### H-13 Explanation evidence and final handoff - 5 分

**输入：FINAL snapshot + 脱敏对话 + Harness 结果。对应两个 persona checklist item。**

Harness 先机器生成不可变 judge package：公开需求、Manager 变更、脱敏 user-agent 对话、
两个快照 diff 摘要、H-01 至 H-12 结果、实际执行命令和 check-not-run 证据。Package 不包含
hidden source、随机 seed、credentials、绝对路径或未公开 failure fixture。

隔离的 Codex 5.6 Sol max 只能按两项隐藏 rubric 评分：

- junior explanation quality：2 分；
- evidence and handoff quality：3 分。

解释项关注模块职责、接口、transaction boundary、lease、outbox、状态聚合和兼容迁移是否
让初级工程师能理解。Handoff 项只奖励有 Harness 或 transcript 证据支持的命令、结果、
风险和未运行检查；把计划写成已完成、虚构测试或性能数据不得分。

Sol 不修改 H-01 至 H-12 的分数，不因代码风格偏好增加隐藏要求，也不能看到 Treatment
或 Control 标签。

## 9. 分值映射

| Hidden scene | 分值 | Checklist item |
| --- | ---: | --- |
| H-01 | 5 | clean-build-and-operation |
| H-02 | 5 | contract-validation-and-seed |
| H-03 | 10 | base-inventory-and-order-lifecycle |
| H-04 | 10 | atomic-allocation-and-durable-idempotency |
| H-05 | 8 | worker-outbox-crash-recovery |
| H-06 | 7 | worker-outbox-crash-recovery |
| H-07 | 10 | multi-process-consistency |
| H-08 | 15 | manager-split-compatible-migration |
| H-09 | 5 | manager-split-runtime-ui-concurrency |
| H-10 | 5 | manager-split-runtime-ui-concurrency |
| H-11 | 8 | project-owned-test-gates |
| H-12 | 7 | performance-correctness |
| H-13 | 2 | junior-explanation-quality |
| H-13 | 3 | evidence-and-handoff-quality |
| **合计** | **100** | |

同一 scene 内按文档列出的 assertion group 给分，不允许 Sol 自由调整 correctness 分。最终
得分是各组得分之和，再应用第 10 节 hard cap。

正式 runner 实现时，必须在同一个变更中：

1. 创建并固定 H-01 至 H-13 assets/commands；
2. 把真实 command 和 `assetsPath` 接入 `experiments/parcelflow/task.json`；
3. 给 checklist item 添加对应 `testGates`；
4. 运行 validator 和 evaluator self-test；
5. 证明每个 gate 的失败会确定性影响对应分值。

不能先添加返回 exit 0 的占位 runner，也不能让未接线的 H ID 显示 passed。

## 10. Hard caps 与样本失效

先计算原始分，再取以下适用 cap 的最小值：

| 条件 | 总分上限 |
| --- | ---: |
| FINAL 无法从 clean checkout migrate、build 或 production boot | 10 |
| 空数据库 migration 失败，导致核心黑盒测试无法运行 | 10 |
| 出现 oversell、`reserved < 0`、`reserved > onHand` 或非原子部分 Order | 40 |
| 同一 Fulfillment 重复 Shipment 或 Allocation 重复结算 | 40 |
| 已提交业务事件永久丢失，或 migration 丢失/改写历史业务数据 | 40 |
| durable idempotency 重放产生第二个业务副作用 | 40 |
| 任一负载后 business invariant 失败 | H-12 为 0，且总分最高 50 |

Manager 功能完全缺失时，H-08 至 H-10 自然为 0，最高只能得到 75 分，不再额外重复 cap。

出现以下行为时不是低分，而是**样本失效**：

- 在冻结前读取、复制或探测 hidden assets；
- 根据 grader 文件名、私有 test ID、随机 seed 或 evaluator process 特判；
- 修改 Harness、测试结果、clock、resource limit 或另一个实验组状态；
- 访问不在公开边界内的宿主文件或外部网络以规避任务。

失效样本不进入 Treatment/Control 统计，必须保留脱敏的 invalidation reason 供审计。

## 11. Timeout 与等待规则

所有等待使用 bounded polling。达到 hard timeout 后 supervisor 终止整个进程组，保存脱敏
诊断，并把相关 assertion group 记为失败；不能无限等待。

| 操作 | Hard timeout |
| --- | ---: |
| `npm ci` | 5 分钟 |
| migration | 2 分钟 |
| 小型 seed | 1 分钟 |
| 大型 seed | 10 分钟 |
| production build | 5 分钟 |
| health readiness | 30 秒 |
| 普通单 HTTP 请求 | 10 秒 |
| Unit command | 3 分钟 |
| Integration / Browser / Concurrency / Recovery 各命令 | 12 分钟 |
| `test:all` | 35 分钟 |
| H-08 compatible migration 场景 | 20 分钟 |
| H-12 performance 全场景 | 45 分钟 |
| 单快照全部非性能场景 | 90 分钟 |

worker lease 等待使用公开 `DISPATCH_TASK_TIMEOUT_SECONDS` 再加最多两倍 poll interval 和
2 秒调度容忍。Webhook timeout 使用公开 `WEBHOOK_TIMEOUT_MS` 加同样的 bounded 容忍。
性能计时不包含 install、migration、seed、首次 build、首次 browser launch 或 warm-up。

只有 Harness 基础设施故障可以重跑；候选应用 timeout、crash 或 assertion failure 不能以
“环境抖动”为由自动重试成通过。

## 12. 防投机设计

- 每轮随机生成 UUID、名称、priority、SKU 顺序、库存分布、OrderLine 顺序和请求交错；
- 随机值只改变公开规则允许的输入，不改变 oracle；
- 同一行为在 V1、FINAL、两个 API port 和多个 process restart 后重复；
- 先验证 response，再通过后续 API、UI、inventory 和 webhook 外部副作用交叉验证；
- response shield 和 ACK barrier 使用可观测事件控制故障点，不猜 sleep；
- invalid seed 把错误放在早、中、晚不同位置；
- Browser 使用语义 locator 和两个 viewport，不要求特定 DOM 结构；
- load generator、OpenAPI validator、Chromium 和 event receiver 均由 Harness 所有；
- hidden mount 在 workspace 冻结后才出现，并对候选进程不可读；
- 网络 policy 阻止外部服务，loopback 访问按进程和目的端口审计；
- 评分针对行为，不因 ORM、SQL、框架、目录或 UI component 选择扣分。

每次随机运行记录私有 seed hash 以便复现，但不把原始 fixture 发送给 DS、Codex、Frontal
或 Sol judge。

## 13. 结果格式

每个 scene 输出私有 JSON：

```json
{
  "schemaVersion": 1,
  "testId": "H-06",
  "snapshot": "FINAL",
  "status": "failed",
  "durationMs": 12345,
  "score": {
    "earned": 5,
    "maximum": 7
  },
  "assertions": {
    "passed": 18,
    "failed": 1
  },
  "metrics": {
    "eventsObserved": 24,
    "redeliveries": 3,
    "unexpected5xx": 0
  },
  "failureClass": "per_order_sequence",
  "privateSeedHash": "sha256:..."
}
```

公开报告只保留 scene ID、snapshot、pass/fail、脱敏指标、earned/maximum 和 hard-cap reason。
不得公开 raw request、webhook body、database URL、token、绝对路径、browser trace 或隐藏
fixture。

## 14. Terra baseline 校准

在把 ParcelFlow 用于正式 Treatment/Control 比较前，先用隔离且每轮重置状态的
Codex 5.6 Terra medium 进行至少 3 次预发布校准。DS 用户剧本、Manager 插入点、模型参数、
token/turn budget、OCI image、checklist 和 hidden runner version 全部固定；校准运行不能把
结果写入后续实验共享的 `CODEX_HOME` 或 `FRONTAL_HOME`。

期望校准区间：

- H-01 至 H-03 大多可通过，证明任务可理解和基本可完成；
- H-04 至 H-10、H-12 至少出现三个不同的真实 failure mode；
- 三次总分中位数在 35 至 65；
- 不应连续出现 85 分以上，也不应多数运行因无法 boot 而低于 20。

若中位数过高，优先加强公开需求本来包含的 crash window、V1-to-FINAL migration 数据和
sustained contention，不增加隐藏规则。若中位数过低，先修正文档歧义、环境不稳定或
timeout，不删除库存、幂等、迁移和 outbox 核心 invariant。

校准完成后冻结 task、workspace fixture、dialogue、checklist、runner 和 image digest。
看到 Treatment 结果后不得改题或改权重；需要调整时发布新的 task version，并重新跑完整
baseline。
