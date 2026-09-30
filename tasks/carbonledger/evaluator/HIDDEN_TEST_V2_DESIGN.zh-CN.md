# CarbonLedger Hidden Test v2 详细设计

本文件遵循 [`docs/hidden-test-v2-standard.zh-CN.md`](../../../docs/hidden-test-v2-standard.zh-CN.md)，只把
CarbonLedger 的公开 README 与已发布 Manager 变更映射为任务专属黑盒测试，不新增产品要求。

## 1. 目标与边界

本方案把 CarbonLedger 的 H-01～H-13 拆成 **49 个独立、确定性、Harness-owned 黑盒 case**。测试只依据
`workspace/README.md`、固定 Manager 变更和 `CONTEXT.md`，不读取 Candidate 源码、ORM、私有表或测试 helper。
本文是设计，不实现 runner，也不改变产品合同、性能阈值或评分权重。

### 1.1 权威顺序与合同缺口

1. `workspace/README.md` 的 V1 合同；
2. 已公开的 cross-lot Manager 固定消息；
3. `workspace/AGENTS.md` 与 `CONTEXT.md`；
4. 本文只把前三者映射为可执行断言。

`SPEC-GAP-01`：Manager 没有发布新的 split-retirement Event type 名或 payload。Evaluator 不得发明；只对与
V1 相同 aggregate transition 的既有 Event 做精确断言，其他 Manager-only transition 不要求新 Event。

`SPEC-GAP-02`：Manager 没有定义 `GET /retirements/:id/allocations` 的分页参数；因此只验证精确
`{items:[LotAllocation]}`、ordinal 顺序和完整集合，不增加 cursor/limit 行为。

## 2. 公开测试 seams

| Seam | 允许观察 | 禁止行为 |
| --- | --- | --- |
| npm lifecycle | README 精确发布的 install/migrate/seed/build/start/test commands、退出码、子进程 | 运行未发布私有入口 |
| HTTP/OpenAPI | `/healthz`、`/openapi.json`、全部公开 `/api/v1` 路由 | debug route、内部 service import |
| Verification snapshot | 使用 ADMIN_TOKEN 读取同一 point-in-time 的 resources/work/events | 直查 Candidate 数据表 |
| Certificate bytes | 通过公开 certificate route 读取 bytes、Content-Type、ETag | 读取 managed-data 私有路径 |
| Production browser | 系统 Chromium、production build、可见语义控件 | 页面内注入 store 或直接调用组件 |
| Webhook receiver | 控制 2xx/500/断线/未知 ACK，记录公开 headers/body | 读取 outbox 表 |
| Recovery barrier | 使用公开 barrier，在 claimed/effect-complete/before-commit 精确暂停 | 用随机 sleep 猜关键窗口 |
| Process boundary | 独立 API/Worker/Dispatcher、SIGTERM/SIGKILL/restart | 用同进程对象模拟并发 |
| V1→FINAL checkpoint | V1 binary 写公开状态，FINAL 对同库 migration/boot | 用 FINAL binary 伪造 V1 历史 |

## 3. Runner、结果与独立 oracle

每个 case 使用独立数据库、端口、managed-data root、receiver 和 barrier；迁移 case 除外。结果 schema 至少包含
`caseId,dimension,weight,status,durationMs,evidenceDigest,privateFailureCode,publicFeedbackCategory`，状态为
`passed|failed|excluded|evaluator_error`。Candidate 失败与 evaluator 基础设施失败必须分离。

确定性 fixture 由私有 `evaluationSeed + caseId + ordinal` 生成 UUID、Lot、数量与交错；预期值不能从
Candidate 输出反推。独立 oracle 维护：

- 每个 Credit Lot 的 `issued = available + reserved + retired`；
- V1 eligibility 与 `(priority DESC, projectId ASC, vintage ASC, creditLotId ASC)` 选择；
- FINAL 先尝试单 Lot，否则按同序对正可用量做 stable greedy prefix，最多 20 Lots；
- allocation 总和、ordinal、provenance lineage 与 immutable frozen rights；
- Certificate v1/v2 的 RFC 8785 bytes、SHA-256 和 ETag；
- per-Retirement gapless Event sequence、Work terminal/fence、saved replay identity。

Fixture families：`F-EMPTY`、`F-V1-SINGLE`、`F-SPLIT-2-20`、`F-SPLIT-21`、`F-IDEMPOTENCY`、
`F-WORK`、`F-EVENT`、`F-MIGRATION`、`F-BROWSER`、`F-PERF-V1`。非法 fixture 每次只改变一个公开约束。

## 4. 评分

| 维度 | 分值 | Case 数 |
| --- | ---: | ---: |
| A. 需求与公共接口覆盖 | 30 | 16 |
| B. 数据正确性、幂等与并发 | 25 | 10 |
| C. Worker、恢复与持久性 | 20 | 8 |
| D. OpenAPI、UI 与跨层闭环 | 15 | 8 |
| E. 迁移、性能与可运维性 | 10 | 7 |
| **合计** | **100** | **49** |

## 5. A — 需求与公共接口覆盖（30 分）

### A-01 Published lifecycle and production boot（2 分）
- **前置**：干净 checkout、空 PostgreSQL、无 build artifact。
- **操作**：依次执行 install、migration、build，独立启动 API、Worker、Dispatcher，再 SIGTERM。
- **断言**：公开命令非交互；三角色独立存活；health/UI/OpenAPI 可用；终止后无子进程、端口或锁残留。

### A-02 Repeatable migration and legal seed replay（2 分）
- **前置**：最小合法 seed 与包含全部 V1 状态的合法 seed。
- **操作**：migration 两次；导入 seed；同 version+digest 重放；再 migration 两次。
- **断言**：资源、Work、Event、certificate bytes 与 identity 不变；重放为 no-op；失败步骤不留半迁移状态。

### A-03 Atomic seed rejection（2 分）
- **前置**：已记录空库和已填充库的公开 snapshot digest。
- **操作**：分别导入 unknown key、duplicate ID、missing reference、坏守恒、坏状态、越界整数、坏时间 seed。
- **断言**：每次非零退出且完整 snapshot 不变；无 Work/Event/idempotency/file 副作用。

### A-04 OpenAPI 3.1 exact contract（2 分）
- **前置**：V1 与 FINAL production API。
- **操作**：独立 schema validator 枚举 routes、methods、headers、bodies、success/error schemas。
- **断言**：V1/FINAL runtime response 均通过独立合同；one-Lot legacy 字段与 split nullable/arrays 被准确表达。

### A-05 Common failures and admin authentication（1.5 分）
- **前置**：每类 mutation 与 snapshot route。
- **操作**：发送非 JSON、malformed JSON、unknown field、shape/range error、缺失/错误 bearer、missing resource。
- **断言**：status/code 为合同值；error exact shape；失败无副作用且不泄露 SQL、路径、token 或 seed。

### A-06 Quantity, filter and timestamp boundaries（1.5 分）
- **前置**：边界 Lot、Project、Beneficiary。
- **操作**：测试 safe integer 上下界、正数量、inclusive vintage、exact methodology/project、UUID 与已发布 timestamp 字段。
- **断言**：合法边界接受；越界返回稳定 validation error；过滤与稳定排序由独立 oracle 精确命中。

### A-07 Reads, pagination and cursor stability（1.5 分）
- **前置**：至少 121 Lots 与 Retirements，含同 priority/timestamp ties。
- **操作**：默认、1、100 limit 翻页；组合 filters；malformed cursor；restart 后继续 cursor。
- **断言**：无重漏、顺序稳定、cursor opaque；detail/list exact shape 一致；非法 cursor 无副作用。

### A-08 V1 single-Lot reservation（2.5 分）
- **前置**：多个 eligibility 相同但 priority/project/vintage/id 不同的 Lots。
- **操作**：POST Retirement，改变输入数组顺序后在 fresh fixture 重跑。
- **断言**：选择第一个完整覆盖的 Lot；只产生一个 allocation；available→reserved 守恒；expiry Work、Event、replay 同事务可见。

### A-09 Release and expiry（2 分）
- **前置**：两个 RESERVED Retirements，一个手工 release，一个到期。
- **操作**：调用 release；让 Worker 处理 expiry；重放并尝试 terminal transition。
- **断言**：reserved 只释放一次、retired 不增；状态/terminalAt/Event/Work 收敛；terminal replay 无第二效果。

### A-10 Certificate bytes and immutable publication（2 分）
- **前置**：一个 RESERVED V1 Retirement 与其 source Lot。
- **操作**：Worker 完成 certification，前/中/后读取 certificate route。
- **断言**：RETIRED 前只返回合同规定的未就绪状态；RETIRED 后 bytes 等于独立 RFC8785 oracle、digest/ETag 一致；只发布一次且 lineage 精确。

### A-11 Retirement state transitions（2 分）
- **前置**：RESERVED、CERTIFYING、RETIRED、RELEASED、EXPIRED fixtures。
- **操作**：对各状态执行 Worker、release、certificate reads 和 replay。
- **断言**：只允许公开状态图；CERTIFYING 不可 release；失败前回到 RESERVED 可重试；terminal 状态不可复活。

### A-12 Credit Lot provenance and availability reads（2 分）
- **前置**：多 Project/vintage/methodology Lots，含 runtime retirement。
- **操作**：list/detail reads，随后 reserve、release、retire 再读。
- **断言**：provenanceDigest 永不改变；三个 quantity 字段按 transaction 更新；过滤和 ordering 精确。

### A-13 FINAL cross-Lot allocation（2.5 分）
- **前置**：无单 Lot 覆盖但 2、3、20 Lots 合计足够的独立 fixtures。
- **操作**：创建 split Retirement，查询 detail 与 `/allocations`。
- **断言**：stable greedy prefix、ordinal 1..N、总量精确、每 Lot 原子 reserve；legacy allocation 为 null；split arrays immutable。

### A-14 Verification snapshot（2 分）
- **前置**：混合所有 V1/FINAL resources、Work/Event 状态。
- **操作**：认证读取 snapshot，并与并发写前后两个合法 point-in-time oracle 比较。
- **断言**：只能匹配一个完整时点；keys/sorts/exact shapes 正确；递归省略 `*Token`、secret、path、raw body。

### A-15 Registry Event query（1.5 分）
- **前置**：多个 aggregate、每个 2+ events。
- **操作**：aggregateId、afterSequence、limit 分页；制造成功与 rollback mutation。
- **断言**：sequence 从 1 连续、排序稳定、V1 payload `{}`；成功同事务有 Event、rollback 无 Event。

### A-16 FINAL limits, errors and compatibility（1 分）
- **前置**：需要 20 与 21 Lots 才满足的 fixtures、一个单 Lot fixture。
- **操作**：创建 Retirement，查询 one-Lot/split response 与 OpenAPI；对已非 RESERVED 的 split Retirement 调用 release。
- **断言**：20 成功、21 返回 `CROSS_LOT_LIMIT_EXCEEDED` 且零副作用；one-Lot 保持 v1 bytes/legacy 字段；非法 split release 返回 `SPLIT_RETIREMENT_NOT_RELEASABLE`。

## 6. B — 数据正确性、幂等与并发（25 分）

### B-01 Single-Lot-first dominates split（2.5 分）
- **前置**：一个 later-ordered Lot 可独立满足，多个 earlier Lots 合计也足够。
- **操作**：创建 FINAL Retirement。
- **断言**：必须选择按 V1 order 首个可独立满足的单 Lot，不可因为 greedy prefix 更早而拆分；其他 Lots 完全不变。

### B-02 Deterministic greedy prefix and remainder（2 分）
- **前置**：6 个正容量 Lots、ties 覆盖全部排序字段，需求落在第 4 Lot 中间。
- **操作**：以不同 seed array order 创建等价请求。
- **断言**：前三 Lot 全取、第 4 Lot 只取 remainder、后两 Lot 不动；ordinal/provenance 与 oracle 相同。

### B-03 Conservation under atomic rejection（2 分）
- **前置**：总量不足、需要 21 Lots、其中一 Lot 将在竞争中耗尽三组 fixture。
- **操作**：分别请求 split creation。
- **断言**：所有失败均无 Retirement/allocation/Work/Event/quantity partial effect；每 Lot 守恒且非负。

### B-04 Unknown-response durable replay（2.5 分）
- **前置**：response shield 与公开 Retirement Create/Release mutations。
- **操作**：upstream 完成后切断，跨 API/restart 用原 key/body 重试。
- **断言**：原 status 和 exact saved body；同一 identities/timestamps；只有一次数量迁移、Work 与 Event。Certificate 由 Worker 合同另行验证，不作为幂等 mutation replay 的直接效果。

### B-05 Idempotency scope and semantic fingerprint（2.5 分）
- **前置**：多 route/aggregate keys。
- **操作**：同 scope key 的 property-order/whitespace 等价 replay、不同 semantic body、跨 route 同文本 key。
- **断言**：等价 replay；不同语义 `IDEMPOTENCY_CONFLICT`；不同 scope 不冲突；saved response 不重写。

### B-06 Same-key contention across two APIs（2.5 分）
- **前置**：两个 API、同一可成功 Retirement request。
- **操作**：64 路同 key 同 payload 同时释放，随后第三 API 重放。
- **断言**：所有可达 response 收敛为一个 body；一套 aggregate/allocation/effects；restart 后 replay 相同。

### B-07 Distinct-key hot-Lot contention（3 分）
- **前置**：少量 hot Lots，总容量只允许固定数量 Retirements。
- **操作**：双 API 以不同 keys 并发 128 个请求，三个固定交错 seed 重跑。
- **断言**：成功数量符合 oracle；任何瞬间/终态不超用；失败无 partial allocation；unexpected 5xx 为零。

### B-08 Certification, release and expiry races（3 分）
- **前置**：接近 expiry 的 one-Lot 与 split RESERVED Retirements。
- **操作**：对两类 Retirement 分别让 Worker certification、API release 与 expiry Worker 通过 barrier 并发。
- **断言**：恰好一个合法终态；若 release/expiry 胜出，split 的全部 allocations 在同一 transaction 中将 reservedGrams 原子归还 availableGrams，不得部分归还且不得有 Certificate；若 certification 胜出，全部 allocations 一次性转为 retired 并且只有一份 Certificate。Event sequence 连续，loser 不覆盖 winner。

### B-09 Split allocation atomicity and lock-order freedom（2.5 分）
- **前置**：两个请求竞争同一组 Lots；fixture 的 seed/physical 顺序反转，但公开 stable order 相同，容量只允许一方完整成功。
- **操作**：两个 API 同时创建 split Retirements。
- **断言**：无 deadlock/5xx；一方完整成功、另一方完整失败；无 orphan allocation、混合 Lot quantity 或负数。

### B-10 Split certificate and release contention（2.5 分）
- **前置**：20-allocation RESERVED split Retirement。
- **操作**：两个 Workers 竞争 certification，同时 API release。
- **断言**：若 release 赢则全部 Lots 原子归还且无 certificate；若 certify 赢则全部原子 retired 且一个 v2 certificate；禁止混合结算。

## 7. C — Worker、恢复与持久性（20 分）

### C-01 Work lifecycle and retention（2 分）
- **前置**：CERTIFICATE_GENERATION、RETIREMENT_EXPIRY 的 pending/leased/terminal fixtures。
- **操作**：启动/停止 Workers 并轮询 snapshot。
- **断言**：exact Work shape；lease fields 只在 LEASED；attempt 单调；terminal retained；backlog drain 定义正确。

### C-02 SIGKILL after `worker.claimed`（2.5 分）
- **前置**：目标 Work 与公开 barrier。
- **操作**：claimed 时暂停并 SIGKILL A，lease 过期后 B reclaim。
- **断言**：A 暂停期间无开放 transaction；B attempt 增加并完成；业务/数量/Event 只有一次。

### C-03 SIGKILL after `worker.effect-complete`（2.5 分）
- **前置**：certificate pipeline 目标 Work。
- **操作**：effect-complete 暂停后杀 A，启动 replacement。
- **断言**：可安全重做或确认既有持久 effect；不存在 bytes 已发布但状态/Work 未收敛，也无第二 Certificate。

### C-04 SIGKILL at `worker.before-commit`（2.5 分）
- **前置**：V1 与 split Retirement 各一个。
- **操作**：before-commit kill，再由 B 完成。
- **断言**：A transaction 全无或完整；B 后 aggregate、全部 allocations、Lots、Work、Event、Certificate 原子一致。

### C-05 Expired lease fencing（3 分）
- **前置**：A claimed 后 barrier 保持至 lease 过期。
- **操作**：B reclaim/commit 后释放 A。
- **断言**：stale owner/token 无 terminal write；最终只反映 B；attempt、sequence、digest 与 capacity 无重复。

### C-06 Manual transition closes obsolete Work（2 分）
- **前置**：带 expiry/certificate Work 的 RESERVED Retirement。
- **操作**：release 或另一路合法 terminal transition 后运行 Worker。
- **断言**：obsolete Work terminal/cancelled 或安全 terminalize；无永久 nonterminal；旧 Work 不改变 winner。

### C-07 Unknown webhook ACK（3 分）
- **前置**：receiver 完整持久化 request 后暂停 ACK。
- **操作**：SIGKILL dispatcher，replacement 面对 disconnect/500/timeout 后成功。
- **断言**：eventId/type/body 不变、重试无限且 bounded backoff；ACK 后不生成新 Event identity。

### C-08 Event transaction, order and dispatcher recovery（2.5 分）
- **前置**：多个 aggregate 和连续 transitions。
- **操作**：并发完成；在 dispatcher response-received barrier kill/restart。
- **断言**：同 aggregate 成功投递按 sequence；aggregate 间可交错；rollback 无 Event；不得泄露 provenance 之外的私密信息。

## 8. D — OpenAPI、UI 与跨层闭环（15 分）

### D-01 OpenAPI validates live traffic（2 分）
- **前置**：V1/FINAL live API 与独立 contract schema。
- **操作**：每个 route 采集 success 和 published error response。
- **断言**：status/header/body 均由 OpenAPI 验证；不能只列 path 而用宽松 object 掩盖字段错误。

### D-02 Browser V1 reserve-to-certificate（2 分）
- **前置**：production Chromium、真实 API/DB/Worker。
- **操作**：浏览 Lots、创建 Retirement、观察 RESERVED→CERTIFYING→RETIRED、下载 Certificate、刷新。
- **断言**：全程只用可见控件；UI/API/snapshot/bytes 一致；刷新后从服务端恢复。

### D-03 Browser release, expiry and failure states（2 分）
- **前置**：可释放、将到期、容量不足三类 fixture。
- **操作**：UI release、等待 expiry、提交不足请求。
- **断言**：状态和数量正确；失败不伪造 Retirement；loading/empty/conflict/stale/offline/retry 可见且可恢复。

### D-04 Browser FINAL split lifecycle（2.5 分）
- **前置**：2、3、20 Lots split 与 one-Lot 对照。
- **操作**：UI 创建、查看 ordered allocations/provenance、完成 certificate、release 对照。
- **断言**：动态展示全部 allocations，不固定数量；v1/v2 certificate/legacy fields 正确；跨层数量闭环。

### D-05 Permission, secret and offline safety（1.5 分）
- **前置**：slow/offline API、401 snapshot、mutation conflict。
- **操作**：浏览器触发并恢复各状态，扫描 production bundle/logs。
- **断言**：ADMIN_TOKEN 不在 bundle/DOM；错误无路径/secret；retry 不重复 mutation。

### D-06 Keyboard, labels, focus and viewport（1.5 分）
- **前置**：390px 与 1280px production UI。
- **操作**：纯键盘走完 create、release、split detail/download。
- **断言**：控件可达且有 label；错误后 focus 可理解；主流程无不可达/遮挡；关键 contrast 达 WCAG AA。

### D-07 Project-owned gates are real（1.5 分）
- **前置**：公开 test commands 与外部进程观测器。
- **操作**：逐个运行 unit/integration/e2e/concurrency/recovery/all/perf。
- **断言**：真实 PostgreSQL/HTTP/Chromium/2 API/2 Workers/barrier 被命中；0 tests、字符串检查、吞错或 always-zero 均失败。

### D-08 README-to-evidence closure（2 分）
- **前置**：固定 requirement ledger。
- **操作**：为每项 observable requirement 建立 README→HTTP→OpenAPI→UI→snapshot/Work/Event/bytes→hidden evidence 映射。
- **断言**：所有适用节点实际执行且一致才 passing；文件存在、test 名称或自报成功不能闭环。

## 9. E — 迁移、性能与可运维性（10 分）

### E-01 Populated V1→FINAL migration（2.5 分）
- **前置**：V1 binary 创建所有状态、one-Lot Certificates、pending/leased Work、undelivered Events。
- **操作**：停 V1、同库运行 FINAL migration 两次、启动 FINAL。
- **断言**：每个 V1 Retirement 恰好 backfill 一个 allocation；Lot totals、bytes/digest、Event、Work、API compatibility 不变。

### E-02 Saved replay and Event identity across migration（1.5 分）
- **前置**：V1 保存 success/domain-conflict/unknown response replays。
- **操作**：迁移后从新 API 重放，查询/投递旧 Events。
- **断言**：status/body/identity 原样；新 allocations 字段不得倒灌改写历史 saved body；Event bytes/sequence 不变。

### E-03 Pending Work and delivery across migration（1.5 分）
- **前置**：V1 pending/leased Work、不同 attempts、未 ACK deliveries。
- **操作**：冷升级、等待 lease、replacement drain。
- **断言**：聚合/lease/attempt/ordering 保持；stale token 失败；只完成一次且 backlog 清空。

### E-04 `lot-and-provenance-read`（1 分）
- **前置**：精确 perf-v1 dataset、64 clients、fresh DB。
- **操作**：10s warm-up、60s 按 published selector 测量。
- **断言**：>=300/s、p95<=140ms、0 unexpected 5xx；每 100 请求 50/50 且 quantity/provenance oracle 通过。

### E-05 `competing-retirement-create`（1 分）
- **前置**：精确 10 measured hot Lots 与 disjoint warm-up Lots。
- **操作**：64 clients、10s warm-up、60s fresh-key 1 gram creates。
- **断言**：>=80 successful/s、p95<=500ms、0 unexpected 5xx；每 gram 只 reserve 一次且全 Lot 守恒。

### E-06 `certificate-recovery`（1.5 分）
- **前置**：精确 5,000 RESERVED + pending Certificate Work。
- **操作**：两 Workers claimed 后 kill，lease expiry 后两 replacements，计时 90s。
- **断言**：全部 RETIRED、一个 verified Certificate、无 nonterminal Work/partial/stale commit，90s 内完成。

### E-07 Cleanup, reproducibility and log hygiene（1 分）
- **前置**：同 Submission/evaluationSeed 两次非性能运行。
- **操作**：比较结果/evidence digest，审计进程、端口、数据库锁、tmp 和 logs。
- **断言**：结果确定；无残留和 workspace 污染；logs 无 token/key/raw seed/body/private path；失败命令非零。

## 10. Hard caps、invalid 与 evaluator error

| 失败 | 总分上限 |
| --- | ---: |
| clean build、migration 或 production boot 失败 | 25 |
| 任一 Lot 守恒/非负/atomic rejection 失败 | 35 |
| durable replay 产生第二 business effect | 30 |
| 成功业务缺 Event、rollback 有 Event、retry 改 Event identity/body | 40 |
| SIGKILL 后 Work 丢失或 stale Worker 可提交 | 40 |
| split partial allocation、混合结算或 duplicate Certificate | 35 |
| migration 丢历史、改 saved replay/bytes 或破坏 V1 client | 35 |
| 性能后核心 invariant 失败 | 对应性能 case 0，并应用 correctness cap |

读取 hidden assets/evaluationSeed、按 case ID 特判、修改 evaluator、容器逃逸或伪造 evidence 为 `invalid`。
Docker/PostgreSQL/Chromium/端口由 Harness 自身造成的故障为 `evaluator_error`，不得算 Candidate 失败。

## 11. Anti-fake-green 与需求映射

1. Candidate tests 只用于 D-07，不作为产品正确性 oracle；
2. expected allocation、remainder、money-free quantity、canonical bytes 由独立 oracle 计算；
3. 核心结果至少由 HTTP/bytes、snapshot、receiver、browser 中两个公开面交叉确认；
4. recovery 必须命中 barrier，concurrency 必须是独立 OS processes；
5. 每个性能 case 后重跑全量 Lot/Retirement/Certificate/Work/Event invariant；
6. Baseline、Native、Guide 使用同一 frozen submission evaluator image、seed、权重和阈值。

以下 compact contract-map 的 Case 范围按 ID 逐个展开；范围不重叠，因此每个 Case 恰好对应一个主要公开条款。每个失败断言的 private code 为
`CL.<CASE_ID>.<ASSERTION_SLUG>`；对外只公开本表的最小 feedback category，不暴露 fixture、交错或 expected bytes。

| 唯一 Case 范围 | 主要 README/FINAL 条款 | 最小 public feedback category |
| --- | --- | --- |
| A-01～A-03 | README Required commands / migration / Seed contract | `contract_setup_failure` |
| A-04～A-07 | README HTTP/OpenAPI / validation / reads / pagination | `public_contract_failure` |
| A-08～A-12 | README V1 reservation→release/expiry→Certificate 主流程 | `v1_flow_failure` |
| A-13～A-16 | FINAL cross-Lot routes / limits / compatibility / snapshot | `final_contract_failure` |
| B-01～B-03 | README/FINAL Lot selection 与 quantity conservation | `conservation_failure` |
| B-04～B-07 | README durable idempotency 与 multi-API contention | `idempotency_concurrency_failure` |
| B-08～B-10 | README/FINAL certification、release、expiry 终态竞争 | `terminal_race_failure` |
| C-01～C-08 | README Work/Event/dispatcher lease、barrier 与 recovery | `recovery_failure` |
| D-01～D-08 | README/FINAL OpenAPI、production UI 与 project-owned gates | `cross_layer_failure` |
| E-01～E-03 | FINAL V1→FINAL migration / saved replay / pending Work | `compatibility_failure` |
| E-04～E-06 | README/FINAL fixed performance scenarios | `performance_failure` |
| E-07 | README command cleanup / reproducibility / secret hygiene | `operability_failure` |

| 原 Gate | v2 cases |
| --- | --- |
| H-01 | A-01～A-03、E-07 |
| H-02 | A-04～A-07、D-01、D-05、D-06 |
| H-03 | A-08～A-15、D-02、D-03 |
| H-04～H-06 | B-01～B-10 |
| H-07～H-08 | C-01～C-08 |
| H-09 | E-01～E-03 |
| H-10～H-11 | A-13、A-16、B-09、B-10、D-04 |
| H-12 | E-04～E-06 |
| H-13 | D-07、E-07 |

## 12. Calibration mutants

至少准备并要求目标 case 稳定失败：process-local idempotency（B-04/B-06）、按输入数组选 Lot（A-08）、
split 前不先找单 Lot（B-01）、错误 greedy/remainder（B-02）、逐 Lot commit（B-03/B-09）、float quantity
（A-06/B-07）、event 在事务后写（A-15/C-08）、无 lease fence（C-02～C-05）、certificate bytes 非 RFC8785
（A-10）、split certificate 部分 retired（B-10）、migration 改 saved body（E-02）、UI 固定两 allocations（D-04）、
fake tests（D-07）、只报吞吐不验守恒（E-04～E-06）。Gold 必须全通过；每 mutant 同 seed 连续三次命中预期 case。

## 13. 推荐实施顺序与完成标准

1. 先打通 A-01/A-03/A-08 的 command→HTTP→snapshot；
2. 实现 B-01/B-02/B-04 与对应 mutants；
3. 实现 C-02/C-05/C-07 的 barrier 与 replacement；
4. 实现 D-01/D-02、再扩展 FINAL split D-04；
5. 接入真实 V1 checkpoint 完成 E-01～E-03；
6. 最后独占资源实现 E-04～E-06，并补齐其余 cases/hard caps。

正式启用前必须有 49 个唯一 ID、总权重 100、每项唯一 requirement mapping、真实 V1 checkpoint、gold 全过、
mutants 被预期 case 捕获、三次非性能无 flake，以及不泄露 fixture 的 public report。
