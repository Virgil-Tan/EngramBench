# ParcelFlow Hidden Test v2 详细设计

本文件遵循 [`docs/hidden-test-v2-standard.zh-CN.md`](../../../docs/hidden-test-v2-standard.zh-CN.md)，只把
ParcelFlow 的公开 README 与已发布 Manager 变更映射为任务专属黑盒测试，不新增产品要求。

## 1. 目标、权威来源与合同缺口

v2 将既有 H gates 和 29 个 stress scenarios 重新整理为 **49 个唯一计分 case**。现有 runner、receiver、
response shield、process supervisor、Chromium 与 load generator 应优先复用，但旧 case 的“已实现”状态不能替代
本设计的独立权重、oracle 和 requirement mapping。

权威顺序：`workspace/README.md` → T16 固定跨仓拆分 Manager 消息 → `workspace/AGENTS.md` →
`CONTEXT.md`。现有 evaluator 文档只提供基础设施与历史映射，不是新增需求来源。

`SPEC-GAP-01`：Manager 只规定 `fulfillments[]`、singular compatibility、分组状态和 Event type，没有发布
FINAL `Fulfillment`/`Allocation` 的完整新增 wire schema，也没有发布 `fulfillment.shipped` payload。Hidden test
只断言已明确字段、分组数量/状态/库存效果和 Event identity/sequence，不私自规定未发布字段。

`SPEC-GAP-02`：README 允许 project tests 使用 deterministic test-only barrier，却没有发布 Worker barrier 的
环境变量或协议。Evaluator 可使用 receiver-side ACK barrier 和 HTTP response shield；Worker recovery 只能在公开
Order/Inventory 进度可观察的 backlog 窗口 SIGKILL。精确 `claimed/effect-complete/before-commit` fencing case 在协议
发布前不得接线或计分，本设计用其他公开可观察的恢复场景覆盖 C 维度。

`SPEC-GAP-03`：README/Manager 没有发布 Task/DispatchTask 的读取 route、wire schema、snapshot 或 ownership
观测协议。Hidden test 不得断言其 identity、数量、状态、owner、attempt 或 lease；只能通过公开
Order/Fulfillment/Shipment/Inventory 与 webhook receiver 观察最终业务效果。需要精确 Task 断言的历史场景均为
`designed_unwired`，冻结公开合同后才能接线计分。

## 2. 公开 seams、隔离与结果

| Seam | 允许操作 | 禁止操作 |
| --- | --- | --- |
| Public commands | README 的 install/migrate/seed/build/start/worker/dispatcher/test commands | 私有入口、源码 import |
| HTTP/OpenAPI | `/api/health`、公开 admin/catalog/order routes、`openapi.yaml` | debug route、私有 task endpoint |
| Production browser | 系统 Chromium、production build、语义控件 | 页面函数注入、内部 store |
| Response shield | 完整读取 upstream mutation response 后断 client | 猜测服务端是否提交 |
| Webhook receiver | 控制 503/timeout/2xx/未知 ACK 并保存 headers/body | 读取 outbox 表 |
| Process boundary | 两 API、多 Worker/Dispatcher、真实 SIGTERM/SIGKILL/restart | 进程内对象模拟 |
| Public state projection | Order/Inventory/Catalog APIs 与 receiver ledger 重建 Allocation/Event 语义；Worker backlog 只由公开业务效果推断 | 直接查询 Candidate 私有表或推断 Task/DispatchTask 私有元数据 |
| V1→FINAL checkpoint | V1 binary 写公开状态，FINAL 原库升级 | FINAL 伪造 V1 数据 |

每个 case 使用独立 database、ports、process group、receiver、browser context 和 fixture；E migration cases 例外。
结果包含 `caseId,dimension,weight,status,durationMs,evidenceDigest,privateFailureCode,publicFeedbackCategory`。基础设施错误必须标
`evaluator_error`，不能算 Candidate 失败。

## 3. 确定性 fixtures 与独立 oracle

私有 `evaluationSeed + caseId + ordinal` 决定 UUID、priority、SKU/line order、库存量和 request release batch。
fixture families：`F-EMPTY`、`F-CATALOG`、`F-V1-ORDER`、`F-SPLIT`、`F-IDEMPOTENCY`、`F-HOT-STOCK`、
`F-WORK-BACKLOG`、`F-EVENT`、`F-MIGRATION`、`F-BROWSER`、`F-PERF`。

独立 oracle 维护：

- 每 Stock Position：`0 <= reserved <= onHand`、`available=onHand-reserved`；
- reserved 等于公开请求与终态可重建的 unsettled Allocation 总和；
- V1 首个完整仓为 `(priority ASC, warehouseId ASC)`；
- FINAL 先执行 V1 single-warehouse-first；否则按 `skuId ASC`，再按 `(priority,warehouseId)` greedy；
- 每 OrderLine 全量分配或 Order 不存在；每 Fulfillment 至多一 Shipment/一次 settlement；
- cancellation 与 shipping 的合法串行终态；
- per-Order Event sequence 与 webhook identity/body；
- idempotency semantic identity（Order line array order 等价）。

区分常见错误的固定 worked example：Warehouse A 各有 SKU-X=5、Y=0，B 各有 X=0、Y=5，C 各有
X=5、Y=5。V1/FINAL 都必须选 C 的完整单仓，而不是先拆 A+B；只有不存在 C 时 FINAL 才按稳定序拆分。

## 4. 固定评分

| 维度 | 分值 | Cases |
| --- | ---: | ---: |
| A. 需求与公共接口覆盖 | 30 | 16 |
| B. 数据正确性、幂等与并发 | 25 | 10 |
| C. Worker、恢复与持久性 | 20 | 8 |
| D. OpenAPI、UI 与跨层闭环 | 15 | 8 |
| E. 迁移、性能与可运维性 | 10 | 7 |
| **总计** | **100** | **49** |

## 5. A — 需求与公共接口覆盖（30 分）

### A-01 Clean lifecycle and role ownership（2 分）
- **前置**：干净 checkout、空 DB、无 artifacts。
- **操作**：`npm ci`、migrate、build；独立启动 API/UI、Worker、Dispatcher；SIGTERM。
- **断言**：lockfile 可安装、公开角色可用、API 仅其职责、十秒内退出且无进程/端口残留。

### A-02 Repeatable migration and populated operation（2 分）
- **前置**：合法 seed 与 runtime-created Order。
- **操作**：migration 两次、seed、创建/发货 Order，再 migration 两次并 restart。
- **断言**：Catalog/Inventory/Order/Shipment/replay/Event 外部投影不变；无重复业务效果。

### A-03 Seed validation and all-or-nothing import（2 分）
- **前置**：最小/大合法 seed 及单缺陷 mutants。
- **操作**：测试 unknown field/version、duplicate IDs/codes/position/line、missing ref、bad timestamp/value、非空库。
- **断言**：合法 seed summary/count 精确；非法非零且全部公开 Catalog/Inventory/Order 投影不变，receiver 无新增 Event。

### A-04 OpenAPI 3.1 and outbound webhook contract（2 分）
- **前置**：V1/FINAL API 与独立 schema oracle。
- **操作**：解析 `openapi.yaml`，覆盖所有 routes、headers、errors、webhook 与 live responses。
- **断言**：runtime 与 schema 一致；FINAL 已发布字段可表达；SPEC-GAP-01 字段不做隐藏 shape 发明。

### A-05 Common validation/auth/error envelope（1.5 分）
- **前置**：每类 write/read route。
- **操作**：unsupported content type、invalid JSON/schema/body、unknown field、bad UUID/cursor/key、admin auth、not found。
- **断言**：published status/code/exact envelope；transport/auth/key-preflight 失败零副作用；无 SQL/path/secret 泄露。

### A-06 Scalar, cardinality and body boundaries（1.5 分）
- **前置**：Warehouse/SKU/Order fixtures。
- **操作**：code/name/priority/onHand、1/8/9 lines、duplicate SKU、quantity、blank strings、safe integer 边界。
- **断言**：合法边界接受，非法 422/稳定错误；输入不被静默截断；失败库存和 Order history 不变。

### A-07 Search, filters, cursor and stable order（1.5 分）
- **前置**：>100 Warehouses/SKUs/Inventory/Orders 与 ties。
- **操作**：默认/1/100 limit、组合 filters、大小写搜索、多页、stale/malformed cursor、restart continuation。
- **断言**：排序按合同、无重漏、交集过滤、cursor opaque；invalid cursor 不泄露其他 query state。

### A-08 Admin catalog and inventory mutations（2.5 分）
- **前置**：有效 admin token 与 duplicate code/已有 reserved stock。
- **操作**：创建 Warehouse/SKU；create/update Stock Position；将 onHand 降到 reserved 以下；replay。
- **断言**：resource shape/ordering 正确；duplicate/conflict 稳定；onHand 更新不改 reserved；replay 无第二 effect。

### A-09 V1 atomic multi-line allocation（2 分）
- **前置**：多个完整/不完整 Warehouse，Worker 停止。
- **操作**：以反序 lines 创建 1～8 行 Order。
- **断言**：首个完整仓、所有 lines/allocations、one Fulfillment 与 allocated Event 同时出现；reserved 精确增加；不检查私有 Task。

### A-10 V1 capacity rejection（2 分）
- **前置**：跨仓合计足够但无单仓完整容量的 V1 checkpoint。
- **操作**：POST Order 并重放 domain 409。
- **断言**：`NO_SINGLE_WAREHOUSE_CAPACITY` durable replay；无 Order/line/allocation/Fulfillment/Event/inventory partial effect。

### A-11 Fulfillment and Shipment lifecycle（2 分）
- **前置**：ALLOCATED Orders 与 Worker 停止。
- **操作**：启动至少两 Workers，轮询 detail/inventory。
- **断言**：PENDING→SHIPPED；一个 Shipment；reserved/onHand 同量减少；Order/Fulfillment/Event 收敛且持久。

### A-12 Cancellation lifecycle（2 分）
- **前置**：ALLOCATED、CANCELLED、SHIPPED Orders。
- **操作**：cancel、repeat cancel、cancel shipped、restart 再读。
- **断言**：前两者返回同 logical cancelled；只释放 reserved；shipped 返回 `ORDER_NOT_CANCELLABLE`；无混合终态。

### A-13 Webhook contract and ordering（2.5 分）
- **前置**：会 allocate→ship 和 allocate→cancel 的 Orders。
- **操作**：Dispatcher 投递到 receiver，记录 headers/raw semantic JSON。
- **断言**：eventId/type headers 与 body 一致；payload 使用公开字段；sequence 1→2；不同 Orders 可交错；失败业务无 Event。

### A-14 Order reads and history（2 分）
- **前置**：seed historical 与 runtime ALLOCATED/SHIPPED/CANCELLED Orders。
- **操作**：list/detail、reference/status/warehouse filters、多页与 full restart。
- **断言**：完整 durable Order shape、line SKU order、Shipment nullable 规则、createdAt/id descending，无重漏。

### A-15 FINAL split allocation and aggregate state（1.5 分）
- **前置**：2～4 Warehouse，无单仓满足但总量足够。
- **操作**：创建 split Order，逐组完成 Shipment。
- **断言**：稳定 greedy、每参与仓一个 Fulfillment、ALLOCATED→PARTIALLY_SHIPPED→SHIPPED；每组只结算本仓库存；不检查私有 Task。

### A-16 FINAL compatibility, cancellation and events（1 分）
- **前置**：one-Warehouse 与 split Orders。
- **操作**：读取 compatibility fields；split 全 pending cancel；一组 shipped 后 cancel；收集 Events。
- **断言**：single singular object、split singular null 且 `fulfillments[]` 完整；全 pending 原子 cancel；发货后 409；published Event types/sequence 正确。

## 6. B — 数据正确性、幂等与并发（25 分）

### B-01 Single-warehouse-first oracle（2.5 分）
- **前置**：第 3 节 worked example 与 priority/UUID tie variants。
- **操作**：V1/FINAL fresh DB 创建等价 Order。
- **断言**：完整仓存在时绝不 split；选择首仓独立于 seed/line array order；其他仓库存不变。

### B-02 Full-order atomicity and inventory conservation（2 分）
- **前置**：一条 line 足、一条不足及 update-onHand race。
- **操作**：并发 create 与 admin inventory update。
- **断言**：Order 全有或全无；`reserved=sum(unsettled)`；`available=onHand-reserved`；失败无 orphan effect。

### B-03 Split deterministic greedy and grouping（2 分）
- **前置**：同 priority ties、同 SKU 跨三仓、反序 lines。
- **操作**：FINAL create，以多个 fixture array order 重跑。
- **断言**：先 skuId 后 Warehouse order；同仓合并一个 Fulfillment；每 line 分配总量精确；结果确定。

### B-04 Unknown-response durable replay（2.5 分）
- **前置**：response shield、两个 API。
- **操作**：对 Warehouse/SKU/Inventory/Order/Cancel 完成 upstream 后断 client，跨实例/restart 重试。
- **断言**：original status/body/IDs/timestamps；每 route 一次 business effect/Event；domain 409 也 durable replay。

### B-05 Idempotency scope and canonical semantics（2.5 分）
- **前置**：相同文本 key 跨 operations/resources。
- **操作**：property order/whitespace/line array reorder；same scope different input；跨 scope same key。
- **断言**：等价 replay；semantic mismatch 409；跨 scope 独立；pre-business failures 不要求 replay 且无 effect。

### B-06 Same-key two-API storm（2.5 分）
- **前置**：两个 API 与一个可成功 multi-line request。
- **操作**：100 路同 key/payload，同时 kill 一 API，存活 API replay，第三 API restart 验证。
- **断言**：所有 logical response 收敛；一个 Order/Fulfillment/effects；无 process-local reset。

### B-07 Distinct-key hot-stock contention（3 分）
- **前置**：两 hot SKUs 各 capacity 40，64 requests 每单各 2。
- **操作**：双 API barrier 同时释放，不同 keys，三个固定 seed。
- **断言**：恰好 20 success、其余 published conflict；无 oversell/deadlock/5xx；终态精确符合 oracle。

### B-08 Shipment versus cancellation race（3 分）
- **前置**：20 独立 ALLOCATED Orders、两 API/两 Workers。
- **操作**：每轮同时释放 Worker processing 与 cancel。
- **断言**：仅 CANCELLED/无 Shipment/onHand 不变，或 SHIPPED/一 Shipment/onHand 扣一次；不得混合或永久 pending。

### B-09 Split create atomicity and deadlock freedom（2.5 分）
- **前置**：多个 Requests 以反序 lines 争相同 4 Warehouse/SKUs。
- **操作**：双 API 并发，随机 restart 一 API 后原 key replay。
- **断言**：每个成功 Order 完整 split；失败无 partial；稳定 lock-order 下无 5xx/deadlock；库存守恒。

### B-10 Split shipment/cancel contention（2.5 分）
- **前置**：20 个 two-Fulfillment Orders，独立库存 fixture。
- **操作**：两 Workers 处理不同 groups，同时另一 API cancel。
- **断言**：cancel 先则全部 CANCELLED；任一 shipment 先则 cancel 409 且最终全部 SHIPPED；无 mixed groups/duplicate Shipment。

## 7. C — Worker、恢复与持久性（20 分）

### C-01 Public fulfillment backlog convergence（2 分）
- **前置**：200 ALLOCATED Orders、4 Workers。
- **操作**：同时启动 Workers，通过 public APIs 观察收敛。
- **断言**：全部 SHIPPED；每 Fulfillment 一 Shipment/settlement；重启任意 API 不影响公开 backlog 收敛；Task ownership 不计分。

### C-02 Active Worker death with backlog（2.5 分）
- **前置**：200 Orders、Worker A，已观察首批 shipped 且仍有 ALLOCATED。
- **操作**：SIGKILL A，立即启动 B，跨公开 lease deadline 轮询。
- **断言**：无永久 stranded Order；每个 effect 一次；库存和 Event 终态完整。

### C-03 Complete Worker outage and restart（2.5 分）
- **前置**：非空 backlog 与两个 Workers。
- **操作**：SIGKILL 全 Workers，等待，再启动全新 Worker process。
- **断言**：committed Orders/ownership 不丢；公开 timeout 后全部恢复；无 duplicate Shipment/settlement。

### C-04 Concurrent Worker completion convergence（2.5 分）
- **前置**：单个 hot Fulfillment 加 200-item backlog，4 Workers。
- **操作**：同时启动并在处理中 restart 两个 Workers。
- **断言**：hot Fulfillment 只一个 Shipment/settlement；其余 backlog 收敛；失败/retry 不暴露 mixed Order state；不检查 owner/attempt。

### C-05 Cancellation fences pending work（3 分）
- **前置**：单仓与 split Orders，Workers 停止。
- **操作**：成功 cancel 后启动 Workers 并跨两个 lease deadlines；重复 restart。
- **断言**：已取消 Fulfillment 永不发货；无 Shipment/onHand deduction/terminal Event 重复；工作最终不造成外部 backlog effect。

### C-06 API/Worker/Dispatcher cold restart（2 分）
- **前置**：committed Orders、pending shipment 与 pending webhook。
- **操作**：SIGKILL 全 application processes，保留 DB/receiver，再全新启动。
- **断言**：reads/replays 保持；pending shipment/delivery 完成；sequence/identity 不变；无进程内 authority 依赖。

### C-07 Unknown webhook acknowledgement（3 分）
- **前置**：receiver 读完 Event body 后保持 ACK pending。
- **操作**：SIGKILL Dispatcher A，B 对相同 Event 经 503/timeout 后得到 204。
- **断言**：允许 duplicate arrival，但 eventId/type/aggregate/sequence/semantic body 相同；Event 不丢且无新 identity。

### C-08 Two Dispatchers and per-Order order（2.5 分）
- **前置**：50 Orders、多 sequence Events、两个 Dispatchers。
- **操作**：receiver 脚本化 503/timeout/204，并在可观察 ACK window kill 一 Dispatcher。
- **断言**：每 Event 最终成功；同 Order 后序不能越过前序成功；不同 Orders 可并发；restart 不改变 body。

## 8. D — OpenAPI、UI 与跨层闭环（15 分）

### D-01 Independent OpenAPI/live validation（2 分）
- **前置**：独立 OpenAPI 3.1 validator。
- **操作**：每 route 至少一 success/一 published error，含 admin/key/webhook schemas。
- **断言**：live status/headers/body 全通过；宽松 `{}` 或只列 path 不能通过。

### D-02 Production browser catalog-to-shipment（2 分）
- **前置**：真实 DB/API/Worker/Dispatcher/Chromium。
- **操作**：浏览 Catalog/Inventory、创建 multi-line Order、观察 allocation→shipment、full refresh。
- **断言**：只用可见控件；selected Warehouse/lines/Shipment/quantities 与 HTTP oracle 一致；refresh durable。

### D-03 Browser cancellation and async progress（2 分）
- **前置**：Worker 暂停的 ALLOCATED Order。
- **操作**：UI cancel、查看 Inventory/History、刷新；另一个 Order 自动轮询至 SHIPPED。
- **断言**：cancel 恢复 reserved；async state 不伪造；retry 不重复 mutation；history 可重新导航。

### D-04 Browser FINAL split flows（2.5 分）
- **前置**：2～4 Fulfillment split 与 single control。
- **操作**：创建/展开各组，观察 partial/final shipping；全 pending split cancel；mobile/desktop 重跑。
- **断言**：每组 Warehouse/lines/status/Shipment 可见；compat fields 正确；动态数量不固定；库存跨层闭环。

### D-05 Loading, empty, conflict, stale, offline, permission（1.5 分）
- **前置**：透明 proxy 与可触发各种状态的 fixtures。
- **操作**：延迟、空数据、capacity/idempotency conflict、API restart、bad admin auth。
- **断言**：可访问且可恢复状态；失败不假造 Order；UI/bundle/logs 不暴露 ADMIN_TOKEN。

### D-06 Keyboard, labels, focus and viewports（1.5 分）
- **前置**：390x844、1280x800 production UI。
- **操作**：纯键盘完成 catalog search、1～8 行 composer、detail/cancel。
- **断言**：README 已发布流程的 labels/status/focus 正确，validation 后可理解，无不可达控件。

### D-07 Project-owned tests are not fake green（1.5 分）
- **前置**：两份 fresh TEST_DATABASE_URL 与外部进程观测。
- **操作**：逐项执行 unit/integration/e2e/concurrency/recovery/all/perf。
- **断言**：真实 PostgreSQL/HTTP/Chromium/2 API/2 Worker/SIGKILL；无 core skip、0-test、mock seam、吞错或 always-zero。

### D-08 README-to-evidence ledger（2 分）
- **前置**：所有 observable requirement 的固定 ledger。
- **操作**：映射 README→HTTP→OpenAPI→UI→public state/receiver→hidden evidence。
- **断言**：全部适用节点实际执行且一致才 passing；文件、字符串、test 名和自报结果不计证据。

## 9. E — 迁移、性能与可运维性（10 分）

### E-01 Populated V1→FINAL migration（2.5 分）
- **前置**：V1 binary 创建 ALLOCATED（Worker 停止）、SHIPPED/CANCELLED Orders 与 unacked Event。
- **操作**：冷停 V1；同库 FINAL migrate 两次、boot、完成遗留工作。
- **断言**：历史 resources/inventory/Shipment/Event/sequence 不变；每旧 Order 一个 Fulfillment；升级无业务副作用。

### E-02 Saved idempotency replay compatibility（1.5 分）
- **前置**：V1 success、domain 409、unknown-response saved results。
- **操作**：FINAL 通过不同 APIs 重放原 keys/body。
- **断言**：原 status/exact body/IDs 不变；`fulfillments[]` 不倒灌改写旧 saved body；无第二 effect。

### E-03 Pending Work and delivery compatibility（1.5 分）
- **前置**：V1 ALLOCATED 且尚无 Shipment 的公开 Orders 与 ACK-unknown delivery；DispatchTask 私有状态不作为 fixture 条件。
- **操作**：upgrade、启动 replacement Worker/Dispatcher 并由公开投影观察 drain。
- **断言**：只一个 Shipment/settlement；同 Event identity/body 最终成功；cold restart 后仍一致；精确 DispatchTask 恢复为 `SPEC-GAP-03` unwired。

### E-04 Large catalog/history query performance（1 分）
- **前置**：精确 100 Warehouses、20k SKUs、1m positions、200k Orders、1m lines。
- **操作**：64 clients，15s warm-up+90s measure，三 fresh runs 取中位。
- **断言**：p95<=250ms、>=250 req/s、0 unexpected 5xx；每 response/cursor chain 经 oracle 验证。

### E-05 Hot inventory mutation performance（1 分）
- **前置**：8 Warehouses、32 hot SKUs、200 clients、两 API/两 Workers。
- **操作**：公开 mix，15s+90s，三 fresh runs。
- **断言**：mutation p95<=750ms、aggregate>=120/s、新 effect create+cancel>=60/s；replay 不重复计数；全量不变量通过。

### E-06 Worker/outbox recovery backlog（1.5 分）
- **前置**：公开 API 创建 5,000 个 ALLOCATED Orders（Workers 停止）与 5,000 个 pending allocation deliveries，receiver 前10s 503 后204。
- **操作**：两 Workers+Dispatcher；从首个204计时。
- **断言**：60s>=95%、120s全完成/全投递；无 duplicate Shipment/settlement/sequence 越序/5xx。

### E-07 Cleanup, reproducibility and log hygiene（1 分）
- **前置**：同 seed 两次非性能 evaluation。
- **操作**：比较结果并审计 processes/ports/database/tmp/logs/artifacts。
- **断言**：结果确定；无残留/污染；README 明确的 credentials/tokens/keys 不入 logs；失败退出非零。

## 10. Hard caps 与失败分类

| 失败 | 总分上限 |
| --- | ---: |
| FINAL clean migrate/build/boot 失败 | 25 |
| oversell、reserved 越界、partial Order | 35 |
| duplicate Shipment 或 Allocation settlement | 35 |
| durable replay 产生第二业务效果 | 30 |
| committed Event 永久丢失或 retry 改 identity/body | 40 |
| restart 后 Work 永久 stranded | 40 |
| V1→FINAL 丢历史/改 replay/破坏旧 client | 35 |
| load 后任一核心 invariant 失败 | 对应性能 case 0，并应用 correctness cap |

读取 hidden asset/seed、按 test ID 特判、修改 evaluator、跨容器干扰或伪造 evidence 为 `invalid`。
Harness 自身 PostgreSQL/Chromium/port/image 故障为 `evaluator_error`；Candidate timeout/crash 是正常失败。

## 11. Anti-fake-green、旧映射与 mutants

- expected allocation/inventory/event 由独立 oracle，不采信 Candidate OpenAPI 或测试断言自身；
- 每个核心行为至少跨 HTTP、browser、public state projection、receiver 两面确认；
- unknown response 必须在 upstream 完整后切断；unknown ACK 必须在 receiver 完整读取后切断；
- 不把私有 row count 当 assertion；Allocation/Event/outbox/idempotency 由公开 effects 重建，Task/DispatchTask 精确状态不推断；
- 性能每轮后遍历全部受影响公开资源重算 invariants。

每个失败断言使用确定性私有 code `PF.<CASE_ID>.<ASSERTION_SLUG>`；公开结果只返回下表的最小
`publicFeedbackCategory`，不暴露 fixture、oracle、mutant 或隐藏阈值。下表是非重叠 contract-map，展开 range 后每个
Case 恰好出现一次。

| Case range | 唯一公开合同族 | publicFeedbackCategory |
| --- | --- | --- |
| A-01～A-03 | lifecycle、migration、seed | `setup_migration_failure` |
| A-04～A-07 | HTTP/OpenAPI、validation、query contract | `public_contract_failure` |
| A-08 | Warehouse/SKU/Inventory admin contract | `catalog_inventory_failure` |
| A-09～A-14 | V1 allocation、shipment、cancel、event、reads | `v1_flow_failure` |
| A-15～A-16 | FINAL split/compatibility contract | `final_contract_failure` |
| B-01～B-03 | allocation atomicity、conservation、determinism | `allocation_correctness_failure` |
| B-04～B-06 | durable idempotency 与 two-API replay | `idempotency_failure` |
| B-07～B-10 | hot-stock 与 terminal concurrency | `concurrency_failure` |
| C-01～C-06 | Worker public-effect recovery | `worker_recovery_failure` |
| C-07～C-08 | Dispatcher delivery recovery/order | `delivery_recovery_failure` |
| D-01 | OpenAPI/live validation | `openapi_failure` |
| D-02～D-06 | production UI 与跨层流程 | `cross_layer_failure` |
| D-07～D-08 | project tests 与 evidence closure | `evidence_failure` |
| E-01～E-03 | populated V1→FINAL compatibility | `upgrade_compatibility_failure` |
| E-04～E-06 | query/mutation/backlog performance | `performance_failure` |
| E-07 | cleanup、reproducibility、log hygiene | `operability_failure` |

| 旧 Gate | v2 cases |
| --- | --- |
| H-01～H-02 | A-01～A-07、D-01、E-07 |
| H-03 | A-08～A-14、D-02、D-03 |
| H-04～H-07 | B-01～B-10、C-01～C-08 |
| H-08 | E-01～E-03 |
| H-09～H-10 | A-15～A-16、B-03、B-09、B-10、D-04 |
| H-11 | D-07 |
| H-12 | E-04～E-06 |
| H-13 | D-08、E-07 |

Calibration mutants 至少包含：process-local replay（B-04/B-06）、line order affects fingerprint（B-05）、
reserve rows one-by-one（B-02）、wrong Warehouse order（B-01）、FINAL splits despite full warehouse（B-01）、
split per line creates duplicate Fulfillments（B-03）、shipment/cancel mixed terminal（B-08/B-10）、public shipment backlog loss after kill
（C-02/C-03）、ACK-before-persist（C-07）、global rather than per-Order event ordering（C-08）、migration rewrites replay
（E-02）、UI hardcodes two groups（D-04）、fake project tests（D-07）、throughput-only perf（E-04～E-06）。

## 12. 实施顺序与完成标准

优先复用现有 ParcelFlow 25 个 required case 的 supervisor/receiver/load 基础设施，但把断言拆到本 manifest 的唯一
case/weight。先实现 A-01/A-03/A-09、B-01/B-04/B-07，再实现 C-02/C-07、D-01/D-02；随后接真实 V1 checkpoint
完成 E-01～E-03，最后独占资源实现 E-04～E-06。`SPEC-GAP-02/03` 未修订前不得把 barrier/Task designed_unwired 断言伪装为 passed。

正式启用要求：49 唯一 IDs、100 精确分、case→requirement 单一映射、gold 全过、mutants 稳定被目标 case 捕获、
同 seed 三次非性能无 flake、所有实验 arm 使用同一 frozen evaluator/fixture/image。
