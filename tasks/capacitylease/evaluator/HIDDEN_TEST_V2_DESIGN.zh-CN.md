# CapacityLease Hidden Test v2 详细设计

## 1. 目标与结论

本方案把现有 H-01～H-13 的粗粒度验收拆成 **49 个独立、确定性、Harness-owned 的黑盒测试**。
所有测试只验证 Public Contract 已声明的行为，不从 Candidate 源码、ORM、私有表名或实现结构推断正确性。

v2 主要解决四个问题：

1. 一个 H case 同时包含大量行为，任何一个浅层成功都可能掩盖内部缺口；
2. 通用 adapter 只抽样一个 happy path，没有完整覆盖 CapacityLease 的时间切片、Promotion、Gang、迁移和状态竞争；
3. Candidate 自己编写的测试可能是空测试、字符串检查或 always-green wrapper；
4. OpenAPI、UI、HTTP、持久化、Work、Domain Event 和 E2E 没有形成逐需求闭环。

本文件是测试设计，不改变 README、Manager 变更、性能阈值或产品行为。实现前必须冻结 Public Contract、
Manager 文本、V1 checkpoint 接口和本文件列出的公开测试 seam。

## 2. 权威来源与不可测试内容

### 2.1 权威顺序

1. `tasks/capacitylease/workspace/README.md`：V1 Public Contract；
2. T16 发布的固定 Manager 变更：Gang Lease FINAL Contract；
3. `tasks/capacitylease/workspace/AGENTS.md`：工程与测试约束；
4. `tasks/capacitylease/CONTEXT.md`：领域术语；
5. 本文件：只负责把上述合同映射为测试，不得补充产品需求。

### 2.2 已发现的合同缺口

`SPEC-GAP-01`：WAITING Admission Entry 被异步 Promotion 为 HELD Lease 后，Public Contract 没有定义
客户端如何获得该 Lease 的 hold token；但 Confirm 又要求 current hold token。

因此 v2 可以验证：Promotion 原子性、原始 interval/member 集合、HELD 状态、Work/Event、容量和最终 expiry；
但在 Public Contract 明确 token 交付方式前，**不得**增加“Promotion 后必须能 Confirm”的 hidden assertion。
这项缺口应由 Task 作者先修改 Public Contract，再增加对应测试，不能由 evaluator 私自选择产品行为。

`SPEC-GAP-02`：Manager 规定 gang request 可以返回一个 WAITING Gang Admission Entry，但没有发布能表达
2～10 Members 的 FINAL AdmissionEntry wire shape；V1 AdmissionEntry 的 `poolId/units` 又是必填单值。

因此 v2 可以根据原始 gang request 和最终 promoted Lease 验证 Member 集合保持、原子 Promotion 和容量，
但在合同补充之前，不得私自规定 202 response 中 `poolId/units/members` 的具体表示。A-04 只要求 OpenAPI
对已明确发布的 schema 精确，A-16/B-10 将该 202 response 标记为 `partial` contract coverage，而不是猜测字段。

## 3. 预先确认的测试 seams

Evaluator 只能从以下公开 seam 观察 Submission：

| Seam | 允许操作 | 禁止操作 |
| --- | --- | --- |
| Public commands | 执行 README 精确发布的 npm commands，观察退出码、子进程和日志 | import Candidate 模块或调用内部 test helper |
| HTTP | 调用 `/healthz`、`/openapi.json` 和所有公开 `/api/v1` routes | 调用未发布 debug route |
| Verification snapshot | 使用 Bearer ADMIN_TOKEN 读取公开 point-in-time snapshot | 直接查询 Candidate 私有表 |
| Production browser | 对 production build 使用系统 Chromium 和可见控件 | 注入页面函数、直接调用页面内部 store |
| Webhook receiver | 接收 dispatcher 的 HTTP 请求并控制 ACK/断线/500 | 读取 Candidate outbox 表 |
| Recovery barrier | 使用公开 `TEST_BARRIER_URL/TOKEN` 协议暂停 Worker/Dispatcher | sleep 猜测 claim 或 commit 时刻 |
| Process boundary | 启动独立 API/Worker/Dispatcher，发送 SIGTERM/SIGKILL，检查存活与日志 | 在同一进程构造两个 service object 代替多进程 |
| V1→FINAL checkpoint | 用冻结 V1 Submission 写入数据，再对同一数据库运行 FINAL migration/binary | 用 FINAL binary 伪造 V1 数据 |

这些 seams 是实现测试前必须确认的唯一边界。测试预期值来自 README 中的字面合同、固定 worked examples
和 evaluator 自己的独立 oracle，不能从 Candidate 输出反推 expected value。

## 4. Runner 总体架构

建议目录：

```text
tasks/capacitylease/evaluator/v2/
  manifest.v2.json
  contract-map.v2.json
  run.mjs
  lib/
    context.mjs
    process-supervisor.mjs
    http-client.mjs
    response-shield.mjs
    webhook-receiver.mjs
    recovery-barrier.mjs
    browser-driver.mjs
    snapshot-oracle.mjs
    capacity-oracle.mjs
    openapi-oracle.mjs
    evidence.mjs
    scoring.mjs
  fixtures/
    generators.mjs
    v1-boundaries.mjs
    v1-admission.mjs
    final-gang.mjs
    migration-history.mjs
    perf-v1.mjs
  cases/
    A-contract/
    B-correctness/
    C-recovery/
    D-cross-layer/
    E-compat-perf/
  calibration/
    mutant-expectations.v2.json
```

每个 case 使用独立数据库、端口、managed-data root、receiver 和 barrier。除 V1→FINAL migration case 外，
不得跨 case 复用 Candidate 状态。非性能 case 顺序运行；性能 case 独占容器 CPU、PostgreSQL 和端口。

### 4.1 Case 接口

```js
export default {
  id: "B-07",
  dimension: "data-correctness",
  weight: 3,
  prerequisites: ["FINAL"],
  async run(ctx) {
    // arrange only through migrate, seed and public APIs
    // act through public HTTP/process seams
    // assert using independent literal/oracle values
    return ctx.pass({ evidence: [...] });
  }
};
```

每个 case 必须满足：

- 独立 setup 和 teardown；
- 一个清晰行为主题；
- case 内所有 mandatory assertions 全通过才获得该 case 权重；
- Candidate 失败与 evaluator 基础设施失败分别分类；
- 证据保存哈希和结构化摘要，不向 Agent 暴露 hidden payload、fixture 或内部栈。

### 4.2 结果接口

```json
{
  "schemaVersion": 2,
  "taskId": "capacitylease",
  "submissionDigest": "sha256",
  "score": 0,
  "maxScore": 100,
  "verdict": "accepted|rejected|invalid|evaluator_error",
  "dimensions": {},
  "hardCapsApplied": [],
  "cases": [
    {
      "id": "B-07",
      "weight": 3,
      "status": "passed|failed|excluded|evaluator_error",
      "durationMs": 0,
      "evidenceDigest": "sha256",
      "privateFailureCode": "CAPACITY_OVERSUBSCRIBED"
    }
  ]
}
```

`excluded` 只允许用于 Task Package 明确缺失的阶段资产，例如没有 V1 checkpoint 时无法执行迁移测试。
正式 CapacityLease 完整实验必须提供 V1 checkpoint，因此 E-01～E-03 不应被排除。

## 5. 独立 oracle 与夹具

### 5.1 确定性输入

- 每次 Evaluation 使用 Harness 私有 `evaluationSeed`；
- UUID 由 `evaluationSeed + caseId + ordinal` 确定性生成；
- 运行时基准时间 `T0` 取数据库/API 可观察当前时间之后的安全未来窗口；
- 所有请求时间都从 `T0` 派生并保存到私有 evidence；
- 同一 Submission 的复跑可使用同 seed 精确复现；calibration 使用多个固定 seed。

### 5.2 Capacity oracle

Evaluator 维护与 Candidate 无关的 reference model：

1. 收集所有 HELD、CONFIRMED、ACTIVE Lease 的 start/end boundaries；
2. 按时间排序唯一 boundaries；
3. 对每个半开 segment `[boundary[i], boundary[i+1])` 累加覆盖该 segment 的 units；
4. 分 Pool 检查 `0 <= used <= capacityUnits`；
5. 期望 Capacity Slice 恰好覆盖有意义的区间，边界只能来自 Lease startAt/endAt；
6. 对 Gang Lease，把每个 Member 独立投影到对应 Pool，但 aggregate 状态、interval、revision 必须一致。

必须包含一个专门区分“峰值计算”和“错误汇总全部重叠 Lease”的 worked example：

```text
Pool capacity = 10
Lease A = [T0, T0+10m), units 6
Lease B = [T0+10m, T0+20m), units 6
Candidate request = [T0, T0+20m), units 4

正确结果：每个 slice 的峰值都是 10，允许创建。
错误实现：SUM(A.units + B.units) + 4 = 16，错误拒绝。
```

### 5.3 Fixture families

| Fixture | 用途 |
| --- | --- |
| F-EMPTY | 干净 migration、boot、validation |
| F-V1-BOUNDARY | 半开区间、多个 boundary、HELD/CONFIRMED/ACTIVE 混合 |
| F-V1-ADMISSION | WAITING priority/tie-break/bypass/Promotion |
| F-IDEMPOTENCY | 每类 mutation 的 replay、conflict、unknown response |
| F-WORK | PENDING/LEASED/terminal Work、多个 attempt、接近 lease expiry |
| F-EVENT | 多 aggregate、多 sequence、未 ACK 和已 ACK events |
| F-GANG | 2、3、10 Members，distinct Pools，部分容量不足和反向输入顺序 |
| F-MIGRATION | V1 全状态、pending/leased Work、undelivered events、saved replay |
| F-BROWSER | 可由 UI 完成的 V1/Gang/Admission/错误状态 |
| F-PERF-V1 | README 精确规定的 1k owners/200 Pools/40k Leases/10k Admission/60k Slices |

## 6. 评分维度

| Dimension | Weight | Case 数 |
| --- | ---: | ---: |
| A. 需求与公共接口覆盖 | 30 | 16 |
| B. 数据正确性、幂等与并发 | 25 | 10 |
| C. Worker、恢复与持久性 | 20 | 8 |
| D. OpenAPI、UI 与跨层验证 | 15 | 8 |
| E. 兼容迁移、性能与可运维交付 | 10 | 7 |
| **Total** | **100** | **49** |

“可维护性”中无法确定性黑盒验证的主观部分不进入 hidden score。v2 只测试可观察代理：公开命令真实性、
进程所有权、清理、日志卫生、迁移兼容和项目自有测试是否真正穿过规定 seam。代码可读性继续用于独立静态评审，
不得混入 hidden functional score。

## 7. A — 需求与公共接口覆盖（30 分）

### A-01 Published commands and production boot — 2.0

- 从无 `node_modules/dist` 的 Submission 执行 `npm ci`、`db:migrate`、`build`；
- 分别启动 production API/UI、Worker、Dispatcher，确认是独立 OS processes；
- `/healthz` 和 `/openapi.json` 只能通过 `127.0.0.1` 访问；
- 每个进程正常 SIGTERM 后退出，不能残留子进程。

### A-02 Repeatable populated migration — 2.0

- 空库连续执行 migration 两次；
- 导入合法 V1 seed 并通过公开 API 创建额外状态；
- 再执行 migration 两次，所有公开资源、saved replay、Work/Event identity 保持不变；
- migration 任一步失败必须回滚，不能留下部分 schema 可观察行为。

### A-03 Atomic deterministic seed — 2.0

- 合法 seed 首次成功，同 version+digest 重放 no-op；
- 同 version 不同 canonical content 返回 `SEED_VERSION_CONFLICT`；
- unknown field、重复 ID、missing reference、invalid state、broken capacity、bad time、unsafe integer
  各生成一个 seed；
- 每个非法 seed 后 snapshot 与之前完全一致，不能产生 Work/Event/idempotency effects。

### A-04 OpenAPI 3.1 complete contract — 2.0

- 文档版本必须是 OpenAPI 3.1；
- 每个 V1 和 FINAL route、method、parameter、request body、success/error status 都存在；
- required/nullable/additionalProperties、UUID/timestamp/int boundaries 与 Public Contract 一致；
- V1 one-member 与 FINAL gang response 的 `poolId/units/members` 兼容规则明确可表达。

### A-05 Common HTTP failures — 1.5

逐 route 验证：

- 非 JSON mutation：415 `UNSUPPORTED_MEDIA_TYPE`；
- malformed JSON：400 `MALFORMED_JSON`；
- unknown object key：400 `UNKNOWN_FIELD`；
- 其他 shape/range：400 `INVALID_REQUEST`；
- missing/malformed/wrong admin bearer：401 `ADMIN_AUTH_REQUIRED`；
- resource miss：404 `NOT_FOUND`；
- body 必须严格为 `{error:{code,message,details}}`，不能附加字段。

### A-06 Scalar and temporal boundaries — 1.5

- lowercase RFC4122 UUID、safe integer 上下界、positive units/capacity；
- `startAt < endAt`、最大 30 days、`holdSeconds` 1/120 合法，0/121 非法；
- timestamp 必须 UTC、毫秒精度、末尾 Z；
- `holdExpiresAt = transaction time + holdSeconds` 且早于 startAt；
- priority、revision、sequence 不得浮点或溢出。

### A-07 Reads, pagination and cursors — 1.5

- list 默认 limit 50，边界 1/100；0/101/非整数拒绝；
- 多页读取不重复、不遗漏，cursor opaque 且稳定；
- malformed cursor 返回 `INVALID_CURSOR`；
- detail/list 的 exact resource shape、排序、nullable fields 和 timestamp 相同。

### A-08 Create HELD Lease — 2.5

- 在每个重叠 slice 都有容量时返回 201 HELD 和 hold token；
- 只创建一个 Capacity Lease、对应 expiry Work 和 `lease.held` event；
- snapshot 递归省略所有 `*Token` fields；
- timeline 立即显示正确 HELD units 和 available units；
- `allowWait:false` 且容量不足时返回 `CAPACITY_UNAVAILABLE`，零副作用。

### A-09 Confirm — 2.0

- current hold token + current revision + before expiry 成功转 CONFIRMED；
- revision/sequence 各只增加一次，event contiguous；
- wrong/stale token、expired hold、stale revision 返回对应 published conflict；
- replay 返回最初结果，不产生第二 transition/event。

### A-10 Renew — 2.0

- HELD/CONFIRMED 且尚未 ACTIVE 时只能扩展 endAt；
- 只检查新增覆盖 slices，但最终完整 interval 必须守恒；
- capacity 不足、缩短、超过 30 days、ACTIVE/terminal/stale revision 全部原子失败；
- 成功后 interval、revision、timeline 和 `lease.renewed` event 一致。

### A-11 Activation, release and expiry — 2.0

- CONFIRMED future Lease 到 startAt 后成为 ACTIVE；
- CONFIRMED future/ACTIVE Lease release 后变 RELEASED、terminalAt 非空、容量只释放一次；
- HELD 到期由 Worker 变 EXPIRED；
- terminal Lease 的重复/stale transition 不改变容量、Work 或 events；
- release/expiry 都创建可驱动 Promotion 的 durable Work。

### A-12 WAITING and cancellation — 2.0

- 容量不足且 `allowWait:true` 返回一个 202 WAITING Admission Entry；
- 同一 request 永远不能同时产生 Lease 和 Admission Entry；
- WAITING 保存原始 owner、interval、priority 和 Member 集合；
- DELETE 只取消 WAITING，使用 durable idempotency；
- cancelled Entry 不再 Promotion，Work 最终收敛。

### A-13 Deterministic Promotion and overlap bypass — 2.5

- 顺序严格为 priority desc、requestedAt asc、entryId asc；
- earlier blocked Entry 只阻止与 candidate interval 重叠的后续 Entry；
- 不重叠 candidate 允许绕过；重叠 candidate 不允许绕过；
- release 和 expiry 都能触发 Promotion；
- Promotion 保留原请求 interval/identity/Member 集合，原子写入 Lease、Members、Work、events 和 Entry state；
- 重复 Promotion Work 不产生第二 Lease。

### A-14 Timeline and verification snapshot — 2.0

- timeline slices 按 startAt 排序、无 gap/overlap，数值符合独立 Capacity oracle；
- snapshot 的 `asOf/resources/work/events` 来自同一个 PostgreSQL point-in-time；
- resources keys 在 V1/FINAL 阶段分别精确匹配合同；
- 每个数组 exact shape、exact sort、exactly-once；
- recursively omit `*Token`、idempotency keys、raw webhook、private path 和 secrets。

### A-15 Domain-event query — 1.5

- `aggregateId/afterSequence/limit` 过滤、分页、排序正确；
- sequence per aggregate 从 1 连续递增；
- V1 payload 精确 `{}`；
- rollback 没有 event；success event 与业务状态同一 transaction 可观察。

### A-16 FINAL Gang wire contract — 1.0

- 2、3、10 Members 合法；1、11、duplicate Pool、mixed legacy fields、非正 units 返回
  `INVALID_GANG_MEMBERS`；
- Members 按 poolId byte order 获得 immutable ordinal；
- one-member Lease 保留 legacy `poolId/units`，gang 为 null，并始终返回 `members`；
- `/members` 返回 exact `{items:[GangLeaseMember]}`；
- 任一 Pool 不足返回 `GANG_CAPACITY_UNAVAILABLE` 且零 partial state。
- `GANG_STATE_CONFLICT` 必须出现在 OpenAPI；由于 Public Contract 没有提供制造 persisted mixed Member
  state 的公开 seam，Evaluator 不得直接修改 Candidate 私有数据库来强行触发它；并发 case 若自然检测到
  mixed state，则 runtime 必须返回该稳定错误而非 500。
- Manager 不得发明未发布的新 event type；相同 aggregate transition 只能复用对应 V1 type，否则不发 event。

## 8. B — 数据正确性、幂等与并发（25 分）

### B-01 Interval peak, not overlap total — 2.5

- 使用第 5.2 节 worked example；
- 断言跨两个相邻 Lease 的 request 能成功，因为每个 instant 的峰值为 capacity；
- 再加入真正同时重叠的 request，必须拒绝；
- timeline 与 reference segments 精确一致。

该 case 专门捕获 `SUM(all overlapping leases)` 的错误实现。

### B-02 Half-open boundaries — 2.0

- `[T0,T1)` 与 `[T1,T2)` 不重叠，可各使用完整 capacity；
- `[T0,T1)` 与 `[T1-1ms,T2)` 重叠，必须进行容量冲突判断；
- renew 到恰好相邻 boundary 不应占用下一段之外容量；
- 所有 slice boundary 只能来自 Lease start/end。

### B-03 Exactly one consuming or waiting result — 2.0

- 在容量临界点并发提交 `allowWait:true` 的不同请求；
- 每个逻辑 request 最终恰好一个 HELD 或一个 WAITING；
- 所有返回、snapshot、Work 和 Event 能一一对应；
- 禁止同一 request 同时出现 consuming Lease 和 Admission Entry。

### B-04 Unknown-response durable replay — 2.5

- response shield 在收到完整 upstream mutation response 后断开 client；
- 对 Create、Confirm、Renew、Release、Cancel 分别重试相同 key/semantic body；
- API restart 前后返回原 status 和 semantic JSON；
- 每种 mutation 只有一次 state effect 和一次对应 event。

### B-05 Idempotency scope and semantic fingerprint — 2.5

- scope 精确为 method + canonical path + key；
- 同 key 同 route 不同 semantic body 返回 `IDEMPOTENCY_CONFLICT`；
- 同 key 不同 aggregate/path 不应碰撞；
- JSON key order/无语义格式差异应产生相同 fingerprint；
- migration 后 saved replay body、status 和 identity 不得重写。

### B-06 Same-key contention across two APIs — 2.5

- 两个独立 API processes 同时接收 64 个相同 key/request；
- 所有 response 的 status+semantic JSON 唯一；
- snapshot 只有一个 aggregate/effect/event chain；
- 停止两 API 后启动第三 API，replay 仍完全一致。

### B-07 Distinct-key hot-capacity contention — 3.0

- 两个 API 对同一 Pool/interval 使用不同 keys 提交超过 capacity 的请求；
- 允许 success/wait/conflict 的数量必须与 capacity oracle 一致；
- 任意时刻和最终 snapshot 都不 oversubscribe；
- 重复 3 个确定性交错 seed，不能依赖偶然调度通过。

### B-08 Revision and terminal races — 3.0

分别执行：

- Confirm vs expiry；
- Renew vs release；
- Release vs expiry；
- Cancel Admission vs Promotion；
- 两个 Promotion Work 同时处理同一 Entry。

每组只允许一个 revision winner、一个 terminal effect 和合法连续 event sequence；loser 必须返回/收敛为
published conflict，不能恢复已释放容量或覆盖 winner。

### B-09 Gang atomicity and deadlock freedom — 2.5

- 请求一按 `[PoolA,PoolB]`，请求二按 `[PoolB,PoolA]` 同时提交；
- Candidate 必须按 poolId byte order 协调，不能因输入顺序死锁；
- 设置容量只允许一个 Gang 成功，另一请求完整失败或 WAITING；
- 不能观察 partial Members、partial slices、mixed aggregate state 或 orphan Work/Event。

### B-10 Gang waiting, Promotion and no bypass — 2.5

- 一个 earlier Gang 的某 Member blocked，后续请求分别构造 overlap 和 non-overlap intervals；
- 只有合同允许的 non-overlap candidate 可以绕过；
- 所有 Member 同时 fit 才能 Promotion；
- Promotion 后 Member set、ordinal、units、aggregate interval/revision 完全保留；
- release/expiry 与 Promotion 并发时无 partial capacity。

## 9. C — Worker、恢复与持久性（20 分）

### C-01 Work schema, lifecycle and retention — 2.0

- Work exact shape、kind enum、attempt、terminal 派生正确；
- leaseOwner/leaseExpiresAt 仅在 LEASED 非空；
- PENDING→LEASED→SUCCEEDED/FAILED/CANCELLED 合法；
- terminal Work 必须保留，backlog drain 只看 `terminal:false`。

### C-02 SIGKILL after `worker.claimed` — 2.5

- barrier 收到 exact claimed body 后保持 204 pending，确认 Worker 没有持有开放 DB transaction；
- SIGKILL first Worker，等待公开 lease expiry；
- replacement Worker reclaim，attempt 递增，effect 只发生一次；
- stale claim 永远不能 terminal commit。

### C-03 SIGKILL after `worker.effect-complete` — 2.5

- 在 effect-complete barrier 杀进程；
- replacement 必须根据持久状态安全重做或完成；
- 不能出现 business effect 已提交但 Work 永久非终态，也不能重复 event/capacity effect。

### C-04 SIGKILL at `worker.before-commit` — 2.5

- 在 before-commit barrier 杀进程；
- 重新启动后要么原 transaction 完全没发生，要么 replacement 完整提交一次；
- snapshot 不允许 partial Lease/Admission/Members/Work/Event。

### C-05 Expired-lease fencing — 3.0

- Worker A claim 后被 barrier 暂停到 lease 过期；
- Worker B reclaim 并完成；
- 再释放 Worker A；
- A 的 owner/token/expiry 已 stale，任何 terminal write 必须失败；
- 最终 attempt、state、event identity 和 capacity 只反映 B 的合法 commit。

### C-06 Manual transition closes obsolete Work — 2.0

- HELD Confirm、Release、Admission Cancel 等人工 transition 后检查相关旧 Work；
- 不再需要的 Work 必须 terminal/cancelled 或被 Worker 安全 terminalize；
- 不能永久保留 nonterminal backlog；
- 后续 Worker 执行不能改变已经获胜的 state/revision/capacity。

### C-07 Unknown webhook ACK — 3.0

- receiver 已持久化完整 request 后暂停 ACK 并 SIGKILL dispatcher；
- replacement retry 必须保持 eventId header、event type 和 semantic body；
- 500、disconnect、timeout 都无限重试并 bounded backoff；
- 成功 ACK 后不创建新 event identity。

### C-08 Event transaction, ordering and dispatcher recovery — 2.5

- successful business mutation 必有同 transaction event；rollback 必无 event；
- 同 aggregate 多 events 在 receiver 成功顺序严格递增；
- 并发 aggregates 允许交错但各自有序；
- dispatcher `response-received` barrier SIGKILL 后 replacement 不丢 event；
- barrier retry body/IDs/leaseTokenHash 保持一致且绝不泄露 raw token。

## 10. D — OpenAPI、UI 与跨层验证（15 分）

### D-01 OpenAPI validates live traffic — 2.0

- 从 `/openapi.json` 构建独立 request/response validator；
- 对每个 route 至少采集一个 success 和一个 published error response；
- 实际 status、headers、body 必须通过对应 OpenAPI schema；
- 文档存在 route 但 schema 无法验证真实 201/202/409 response 时失败。

### D-02 Production-browser V1 lifecycle — 2.0

- 只通过 production Chromium 可见控件完成 Create→Confirm→Renew→Release；
- 页面展示真实 Pool timeline、Lease state/revision、events/history；
- 刷新后状态仍来自 HTTP/PostgreSQL；
- 不允许 evaluator 直接 API 调用代替 primary UI action。

### D-03 Production-browser Admission and async progress — 2.0

- UI 创建容量不足 request 并看到 WAITING；
- UI 可取消 WAITING，或在释放容量后看到 Promotion/expiry 异步进度；
- 页面不能伪造 terminal state，最终显示必须与 snapshot 同步；
- event/history 可通过 UI 浏览。

### D-04 Dynamic Gang UI — 2.5

- UI 通过可见控件创建 2、3 和 10 Members；
- 支持增删 Member，Pool 不重复，ordinal/units 结果可见；
- 创建后 detail、members、timeline 和 aggregate actions 均可操作；
- 专门捕获“UI 固定两个 Members”的实现；
- V1 one-member UI 仍可使用。

### D-05 Loading, empty, conflict, stale, offline and permission states — 1.5

- 分别注入 slow response、empty seed、409 conflict、stale revision、API offline/retry、401 admin；
- UI 必须有可见、可恢复且不泄密的状态；
- retry 不能重复 mutation effect；
- admin token 不能硬编码在 production bundle 或页面文本中。

### D-06 Keyboard, labels, focus and mobile — 1.5

- 所有 primary controls 可键盘到达并有 associated labels/name；
- validation/permission error 后 focus 移到可理解位置；
- desktop 与 mobile viewport 主流程无不可达控件；
- 基础 WCAG AA contrast 使用自动检查加关键控件人工确定性规则。

### D-07 Project-owned gates are not fake green — 1.5

逐个执行公开测试命令并用外部观测证明 seam：

- integration 必须启动/访问真实 PostgreSQL 和 HTTP；
- e2e 必须启动 production build 和系统 Chromium；
- concurrency 必须观察至少 2 API + 2 Worker OS processes；
- recovery 必须命中公开 barrier、SIGKILL 并启动 replacement；
- test command 若 0 tests、只有文件/字符串检查、吞掉失败或 always exit 0，则失败。

### D-08 README-to-evidence cross-layer closure — 2.0

Evaluator 为每个 observable flow 建立固定 ledger：

```text
README requirement
→ runtime HTTP behavior
→ OpenAPI validation
→ production UI action/visible state（适用时）
→ verification snapshot/Work/Event
→ executable hidden case evidence
```

每行必须标为 unrun/empty/failed/partial/passing。只有全部适用节点存在并执行，才算 passing；
不能因为 test name、文件存在或 aggregate pass count 而闭环。

## 11. E — 兼容迁移、性能与可运维交付（10 分）

### E-01 Populated V1→FINAL migration — 2.5

必须由 Harness 保存真实 V1 checkpoint：

- V1 binary 创建 HELD/CONFIRMED/ACTIVE/RELEASED/EXPIRED、WAITING/CANCELLED/PROMOTED；
- FINAL migration 后每个 V1 Lease 恰好 backfill 一个 Member；
- capacity/state/deadline/Admission order/Work/Event 不变；
- 旧客户端 request/response 和 endpoint 继续工作；
- migration 重放无第二 Members 或 identity changes。

没有 V1 checkpoint 的 FINAL-only run 不能声称完成完整 CapacityLease migration Evaluation。

### E-02 Saved idempotency and event identity across migration — 1.5

- V1 保存 success replay、conflict fingerprint 和 unknown-response result；
- FINAL migration 后原 key 返回原 status/body/identity；
- 已提交 eventId/type/body/sequence 不改变；
- 新 `members` 字段不能倒灌并重写历史 saved replay body。

### E-03 Pending Work and delivery state across migration — 1.5

- V1 构造 PENDING/LEASED expiry/promotion Work、不同 attempt/owner/expiry；
- 构造未 ACK/已重试 events；
- FINAL 保留 exact aggregateId、attempt、lease 和 ordering data；
- replacement Worker/Dispatcher 能继续完成，旧 stale token 仍不能提交。

### E-04 `pool-timeline-read` performance — 1.0

- 严格使用 README perf-v1 dataset、64 closed-loop clients、10s warm-up、60s measure；
- round-robin 200 Pools，完整读取 interval；
- 只统计 body 完整且 slices 通过 oracle 的 200 response；
- throughput >=400/s、p95<=120ms、mixed revisions=0、unexpected 5xx=0。

### E-05 `independent-hold-create` performance — 1.0

- 严格使用 disjoint identities/intervals、64 clients、10s warm-up、60s measure；
- 只统计 201 HELD 且 snapshot 证明 one effect/conservation 的 response；
- throughput >=120/s、p95<=350ms、WAITING 不计、unexpected 5xx=0。

### E-06 `expiry-promotion-recovery` performance — 1.5

- 精确 10k due HELD + 10k eligible WAITING；
- 两 Worker claimed barrier 后 SIGKILL，lease expiry 后启动两个 replacements；
- 从 replacements spawn 开始 90s；
- 全部 20k transitions、无 nonterminal matching Work、无 oversubscription/stale commit/failure；
- 任一 invariant 失败时 performance case 直接 0 分并应用 correctness hard cap。

### E-07 Cleanup, reproducibility and log hygiene — 1.0

- 所有公开命令 non-interactive，失败时非零退出；
- 每个 case 结束无 Candidate 子进程、监听端口或锁定数据库；
- logs 不包含 token、idempotency key、raw seed、webhook body、private absolute path；
- 同 Submission+evaluationSeed 的非性能 cases 复跑结果一致；
- generated artifacts 不污染 Submission。

## 12. Hard caps、invalid 与基础设施错误

保留并细化以下 hard caps：

| Failure | Cap |
| --- | ---: |
| clean build、migration 或 production boot 失败 | 25 |
| 任一容量守恒、非负、唯一终态、atomic rejection 不变量失败 | 35 |
| durable idempotency 在 replay/unknown/restart 后产生第二 effect | 30 |
| 成功业务缺 event、rollback 有 event、retry 改变 event identity/body | 40 |
| SIGKILL 后 pending Work 永久丢失或 stale Worker 可提交 | 40 |
| Gang partial state、oversubscription 或 mixed aggregate state | 35 |
| migration 丢数据、改变 saved replay 或破坏旧客户端 | 35 |
| 性能后核心 invariant 失败 | 对应性能 case 0，并应用 correctness cap |

以下属于 `invalid sample`，不是普通低分：

- Submission 读取 `/hidden`、Evaluator env 私有变量或 workspace 外私有资产；
- 硬编码 private fixture、evaluationSeed 或 hidden case identity；
- 容器逃逸、修改 Evaluator、干扰其他 Submission；
- 伪造 Harness evidence/protocol。

Evaluator 自身 Docker、PostgreSQL、Chromium 或端口分配故障标为 `evaluator_error`，不计 Candidate 失败。
Runner watchdog 只防止 Evaluation 基础设施永久挂起，不属于 Coding Agent/Harness turn timeout，也不能创造 README 未声明的产品时限。

## 13. 防止假绿与测试独立性

1. Hidden evaluator 不运行 Candidate test assertions 作为产品正确性证据；Candidate tests 只在 D-07 证明项目自有 gate 真实性；
2. 所有核心状态通过公开 snapshot、HTTP 和 browser 交叉观察；
3. expected capacity、ordering、canonicalization 由独立 oracle 或字面 worked example 生成；
4. 不使用 Candidate 的 OpenAPI schema 验证 Candidate 自己的响应而止步；Evaluator 另有 contract schema；
5. 不把文件存在、route 字符串、test name、进程日志声明当作行为证据；
6. 每次 recovery 都使用 barrier，不用随机 sleep 判断 critical point；
7. 每次 concurrency 都使用独立 OS processes 和一个 PostgreSQL authority；
8. 每次 performance 都在 load 后重新运行完整 capacity/work/event invariants。

## 14. 旧 H-01～H-13 到 v2 的映射

| 旧 Gate | v2 cases |
| --- | --- |
| H-01 | A-01～A-03、E-07 |
| H-02 | A-04～A-07、D-01、D-05、D-06 |
| H-03 | A-08～A-15 |
| H-04 | A-05、A-06、B-01～B-03 |
| H-05 | B-04～B-06 |
| H-06 | B-07～B-10 |
| H-07 | C-01～C-06 |
| H-08 | C-07、C-08 |
| H-09 | E-01～E-03 |
| H-10 | A-16、B-09、B-10 |
| H-11 | D-04、B-09、B-10、C-02～C-08 |
| H-12 | E-04～E-06 |
| H-13 | D-07、E-07 |

## 15. Calibration mutants

在冻结 v2 前至少准备以下定向 mutants，并要求对应 case 稳定失败：

| Mutant | 必须命中的 cases |
| --- | --- |
| process-local idempotency map | B-04、B-06 |
| SUM all overlapping leases instead of interval peak | B-01 |
| closed interval instead of half-open | B-02 |
| create both Lease and WAITING Entry under race | B-03、B-07 |
| event inserted after business transaction | A-15、C-08 |
| no Work lease fencing | C-02～C-05 |
| confirm/release leaves immortal nonterminal expiry Work | C-06 |
| dispatcher retry creates new eventId | C-07 |
| gang Members inserted incrementally | A-16、B-09 |
| lock Pools in request order | B-09 |
| Promotion bypasses overlapping earlier Entry | A-13、B-10 |
| FINAL migration does not backfill one Member | E-01 |
| migration rewrites saved replay body | E-02 |
| OpenAPI only lists paths but schemas disagree | D-01 |
| UI hardcodes admin token | D-05 |
| Gang UI fixed to exactly two Members | D-04 |
| project tests check only strings/files | D-07 |
| performance reports throughput without post-load invariants | E-04～E-06 |

Calibration 要求：

- gold 实现通过全部适用 cases；
- 每个 mutant 至少被预期 case 捕获，不能只依赖 unrelated crash；
- 同 mutant、同 seed 连续三次结果一致；
- 性能阈值在固定 4 CPU/8 GiB image 上至少运行三次并记录分布；
- 冻结 image digest、fixture commit、Public Contract、Manager 文本、manifest、oracle 和 fixture generator。

## 16. 推荐实现顺序

按 vertical slices 实现，不一次性写完 49 个 case：

1. 先实现 A-01、A-03、A-08，打通 command→HTTP→snapshot runner；
2. 实现 B-01 并制作 overlap-sum mutant，证明 Capacity oracle 有区分力；
3. 实现 B-04、B-06，打通 response shield、多 API 和 restart；
4. 实现 C-02、C-05，打通 barrier、SIGKILL、replacement 和 fencing；
5. 实现 D-01、D-02，打通独立 OpenAPI validator 与 production Chromium；
6. 实现 A-16、B-09、D-04，覆盖 Manager Gang 全链路；
7. 接入真实 V1 checkpoint，实现 E-01～E-03；
8. 最后实现 E-04～E-06，性能期间禁止并行其他 evaluator workload；
9. 补齐其余 cases、hard caps、public/private report 和全部 mutants；
10. 完成 gold + mutant + baseline calibration 后才替换现有 H-01～H-13 scoring。

## 17. 完成标准

v2 只有同时满足以下条件才能用于正式 A/B：

- 49 个 case 均有唯一 ID、唯一权重和唯一 Public Contract 映射；
- 总权重精确 100，无重复计分；
- 所有测试只经过第 3 节确认的 seams；
- V1→FINAL checkpoint 真正可执行，不再默认排除 H-09 类能力；
- gold 全通过，所有定向 mutants 被预期 case 捕获；
- 三次 calibration 无功能 flake，性能分布已冻结；
- public feedback 不泄露 hidden fixture，private report 足以定位 assertion；
- Baseline、Native Skills、Runtime Guide 使用完全相同的 Submission freeze 和 evaluator image；
- evaluator 不根据实验 arm、Guide exposure 或提交来源改变任何测试、权重、seed 或阈值。
