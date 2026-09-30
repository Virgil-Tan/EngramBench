# AuctionGuard Hidden Test V2 设计

> 仅为黑盒设计，不实现 runner。计分权威仅为 `workspace/README.md`、`CONTEXT.md` 与固定 Manager 消息；旧 `E2E_TEST_PLAN.zh-CN.md` 只用于旧 H 追溯，不产生 expected value。共享 install/build/migrate/boot/health preflight 不计入 22 个领域 Case，也不得以别名重复计分。

## 1. 测试画像与隔离

- **两项主机制**：数据库时间上的递增竞价/anti-sniping；多单位统一清算价的确定性分配与原子 Awards。
- **领域 family**：`BID`、`CLEAR`、`RACE`、`MIGRATE`、`LOAD` 只用于业务定位；评分以每个 Case 的显式 A–E dimension 为准。
- **核心 primarySkill（4 个）**：`S04` database-owned-atomic-idempotency、`S06` ordered-authority-and-frozen-membership、`S07` durable-work-fenced-recovery、`S02` compatibility-seed-bootstrap-gate；性能与跨层验收只列为 `secondarySkills`。
- **seam 与 isolation**：仅 HTTP/OpenAPI、server time、receiver、barrier、进程信号、Chromium、point-in-time snapshot；每 Case 新数据库/端口/固定时钟相对 fixture，LOAD 每条独立生产拓扑。失败只归属本 Case，hard cap 后置且不重复扣分。

## 2. 计分 Case（22 个，100 分）

### BID-01 reserve、increment 与整数金额边界 — 6 分

- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture / seam 动作**：README「Deterministic policy」1；对 SCHEDULED/OPEN Auction 提交 reserve-1、reserve、increment-1、increment 及 safe-integer 边界 Bid。
- **独立 oracle / mandatory assertions / 禁止副作用**：整数模型计算唯一合法金额；合法 Bid 获连续 sequence，非法请求返回精确错误；不得改变 leader/endAt、创建 Work/Event 或留下拒绝 Bid。
- **primarySkill / feedback / mutant**：`S04` / `BID_VALUE_CONTRACT` / `AG-M01`。

### BID-02 committedSequence 决定唯一 leader — 5 分

- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture / seam 动作**：README policy 2、invariants 1–2；两 API 对一个 Auction 交错提交合法递增金额。
- **独立 oracle / mandatory assertions / 禁止副作用**：按公开 bid history 的 committedSequence 重算 gapless 顺序与最高金额 leader；不得以客户端时间/到达顺序定胜负、出现两个 leading Bid 或 sequence gap。
- **primarySkill / feedback / mutant**：`S06` / `COMMIT_ORDER` / `AG-M02`。

### BID-03 anti-sniping 120 秒规则与安全余量 — 6 分

- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture / seam 动作**：README policy 3；用数据库响应中的 acceptedAt 筛选距 endAt 至少 2 秒在窗口外、至少 2 秒在窗口内的资格 Bid，并连续触发扩展。
- **独立 oracle / mandatory assertions / 禁止副作用**：外部按已观察 acceptedAt 计算 `acceptedAt+120s`；窗口内更新且每 Bid 一次、窗口外不变；不得累计双扩展、缩短 deadline 或用进程本地时钟。无法通过公开 seam 稳定命中恰好 120 秒，等点分支 blockedBy: `SPEC-GAP-AG-03`。
- **primarySkill / feedback / mutant**：`S04` / `ANTI_SNIPING_BOUNDARY` / `AG-M03`。

### BID-04 effectiveEndAt 严格截止与状态栅栏 — 6 分

- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture / seam 动作**：README policy 2/4；在 effectiveEndAt 至少 2 秒前、至少 2 秒后提交 Bid，并覆盖 OPEN/CLOSING/CLOSED/CANCELLED。
- **独立 oracle / mandatory assertions / 禁止副作用**：数据库时间与公开状态为 oracle；仅 `acceptedAt < effectiveEndAt && OPEN` 接受；不得让 late Bid 改写 leader、deadline、outcome、Award 或 event。恰等于 effectiveEndAt 的不可控等点 blockedBy: `SPEC-GAP-AG-03`。
- **primarySkill / feedback / mutant**：`S04` / `DEADLINE_FENCE` / `AG-M03`。

### BID-05 cancel 与首个 accepted Bid 的互斥 — 6 分

- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture / seam 动作**：README policy 4、Manager 规则 5；对无 Bid 和已有 Bid 的 SCHEDULED/OPEN Auction 取消，并与首 Bid 竞争。
- **独立 oracle / mandatory assertions / 禁止副作用**：最终公开历史必须线性化为 CANCELLED 无 Bid，或 OPEN/CLOSING 有 accepted Bid；不得出现 cancelled Auction 的 accepted Bid/close outcome 或已竞价 Auction 被取消。
- **primarySkill / feedback / mutant**：`S04` / `CANCEL_BID_RACE` / `AG-M04`。

### CLEAR-01 multi-unit 数量与总额 overflow 合同 — 5 分

- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture / seam 动作**：Manager 规则 1/7 与三个 400；测试 unitCount 1/2/100/101、quantity 0/1/20/21/遗漏及乘积 safe boundary。
- **独立 oracle / mandatory assertions / 禁止副作用**：BigInt oracle 判断 `amountMinor*quantity<=9007199254740991`；错误 code 精确；不得截断/浮点舍入、创建非法 Auction/Bid 或推进 sequence。
- **primarySkill / feedback / mutant**：`S04` / `MULTI_UNIT_INPUT` / `AG-M05`。

### CLEAR-02 价格/sequence/bidId 三键确定性排序 — 5 分

- **dimension**：B（数据正确性、幂等与并发）
- **blockedBy**：`SPEC-GAP-AG-04`；V1 强制同 Auction 的 accepted amount 严格递增，公开 API 无法构造同价 Bids，合同补齐前本 Case 不运行且不重分。
- **来源 / fixture / seam 动作**：Manager 规则 2；构造同价且可控制 commit sequence 的 Bids，并用 UUID 字节序形成最终 tie。
- **独立 oracle / mandatory assertions / 禁止副作用**：独立排序 `price desc, committedSequence asc, bidId asc` 后逐单位分配；Awards rank/bidder/bid 完全相符；不得依赖插入/查询顺序或随机 tie-break。
- **primarySkill / feedback / mutant**：`S06` / `ALLOCATION_ORDER` / `AG-M06`。

### CLEAR-03 clearing price 与末位 partial Award — 5 分

- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture / seam 动作**：Manager 规则 3；7 Units，按合法递增提交 5@80→3@90→3@100，再由 Close Task 关闭 Auction。
- **独立 oracle / mandatory assertions / 禁止副作用**：预期分配 3/3/1，所有 Award clearing price=80，total=allocated×80，allocated/unallocated 对账；不得按各自 bid price 收费、超配或丢 partial。
- **primarySkill / feedback / mutant**：`S06` / `UNIFORM_PRICE` / `AG-M07`。

### CLEAR-04 Awards 与 outcome 全组原子、不可变 — 5 分

- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture / seam 动作**：Manager 规则 4 与 `AWARD_ALLOCATION_CONFLICT`；在 close 前后观察并重试/竞争 close。
- **独立 oracle / mandatory assertions / 禁止副作用**：单个 point-in-time snapshot 只允许零 Awards+未 CLOSED 或完整 canonical Awards+CLOSED；重试结果一致；不得 partial Awards、第二 outcome、改 rank/price 或超 unitCount。
- **primarySkill / feedback / mutant**：`S06` / `ATOMIC_AWARDS` / `AG-M08`。

### CLEAR-05 one-unit/multi-unit 的 OpenAPI/UI wire 分流 — 4 分

- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture / seam 动作**：Manager 规则 6、AuctionDetail/OpenAPI/UI/snapshot；分别经 Chromium 与 live HTTP 读取 omitted unitCount 和 explicit multi-unit Auction 的 close 结果。
- **独立 oracle / mandatory assertions / 禁止副作用**：OpenAPI、live body、UI 与 snapshot 同时证明 one-unit 保留 winnerId/winningAmountMinor/旧 outcome；multi-unit 两字段 null、leadingBidId 为最高价 Bid、awards 与 outcome identical；不得给旧 replay 增字段、前端自算另一 allocation 或把 multi-unit 简化成单 winner。
- **primarySkill / secondarySkills / feedback / mutant**：`S02` / `S15` / `WIRE_VARIANT` / `AG-M09`。

### RACE-01 Bid 与 cancel unknown response 的 durable replay — 5 分

- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture / seam 动作**：README「Durable idempotency」与公开 Bid/cancel routes；response shield 分别丢 committed Bid 与无 Bid Auction 的 cancel 响应，跨 API 20 路 replay、重启及异 payload；不存在公开 close HTTP，不调用它。
- **独立 oracle / mandatory assertions / 禁止副作用**：原 status/semantic JSON、bidId/sequence 或 CANCELLED identity 为 oracle；一次业务效果，异 payload精确 409；不得第二 Bid、deadline extension、重复取消或 event。
- **primarySkill / feedback / mutant**：`S04` / `DURABLE_IDEMPOTENCY` / `AG-M04`。

### RACE-02 Bid/Close 竞争的 UI、timeline 与 snapshot 闭环 — 4 分

- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture / seam 动作**：README invariant 3、policy 4 与 UI/snapshot；在 worker claimed barrier 持有 close，使 Bid 的数据库 acceptedAt 以安全余量早于有效截止，随后用 UI/timeline观察收敛。
- **独立 oracle / mandatory assertions / 禁止副作用**：OpenAPI/live response、公开时间、Bid history、UI countdown/outcome 与 snapshot 共同证明合法早 Bid 进入 locked canonical snapshot，close 重检扩展 deadline；不得丢 Bid、过早 close、产生两个 Work/outcome 或 UI 显示旧 winner。
- **primarySkill / secondarySkills / feedback / mutant**：`S06` / `S15` / `BID_CLOSE_LINEARIZATION` / `AG-M03`。

### RACE-03 Close lease expiry 与 stale owner fencing — 5 分

- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture / seam 动作**：README worker/barrier；在 claimed、effect-complete、before-commit 分别 SIGKILL，lease 过期后 replacement。
- **独立 oracle / mandatory assertions / 禁止副作用**：barrier body+snapshot 证明 Work attempt、一个 immutable outcome/award set、terminal drain；不得 stale owner commit、重复 close event 或 canonical set 漂移。
- **primarySkill / feedback / mutant**：`S07` / `CLOSE_RECOVERY` / `AG-M08`。

### RACE-04 outbox unknown ACK 与聚合顺序 — 5 分

- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture / seam 动作**：README events/dispatcher/barrier；receiver 收完整 body 后悬挂 ACK，杀 dispatcher 并恢复。
- **独立 oracle / mandatory assertions / 禁止副作用**：receiver 解析后的 eventId、type、semantic JSON；重投保持 eventId 与 semantic body 等价且 aggregate sequence 递增；不得要求未发布的 JSON 字节序、创建新事件、跳序、发送 rollback event 或泄漏 token/私有路径。
- **primarySkill / feedback / mutant**：`S07` / `OUTBOX_IDENTITY` / `AG-M10`。

### MIGRATE-01 V1 unitCount=1 与 winner Award 映射 — 2.5 分

- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture / seam 动作**：Manager 规则 8；迁移含 WINNER、NO_SALE、OPEN、CLOSING 的 V1 Auctions。
- **独立 oracle / mandatory assertions / 禁止副作用**：每项 unitCount=1；有 winner 者恰一 Award 且身份/金额语义对应，无 sale 者无 Award；不得改变 Bid/outcome/event 历史或给非终态合成 winner。
- **primarySkill / feedback / mutant**：`S02` / `MIGRATION_MAPPING` / `AG-M09`。

### MIGRATE-02 pending Close Work 与 effective deadline 保真 — 2.5 分

- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture / seam 动作**：Manager 规则 9；迁移前留 PENDING/LEASED Close Tasks 及已 anti-snipe 延长 deadline，迁移后恢复 workers。
- **独立 oracle / mandatory assertions / 禁止副作用**：前后 workId/state/attempt/effectiveEndAt 一致并按原顺序收敛；不得重置 deadline、换 Work、提前 close 或使旧 lease 绕过 fence。
- **primarySkill / feedback / mutant**：`S02` / `INFLIGHT_MIGRATION` / `AG-M09`。

### MIGRATE-03 Auction/Bid V1 seed 原子导入、replay/conflict 与 FINAL 兼容 — 6 分

- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture / seam 动作**：README「Seed contract」与 Manager V1 seed 保持规则；导入合法完整 bidders/lots/auctions/bids、同 version+digest replay、同 version 异 digest、断引用、sequence gap、leader/WINNING 不一致与未知字段，再在 FINAL 重放。
- **独立 oracle / mandatory assertions / 禁止副作用**：合法资源、Bid committedSequence、leader、effectiveEndAt 全部精确；同 digest no-op、异 digest `SEED_VERSION_CONFLICT`，任一坏 member 对业务/Work/Event/幂等均零影响；FINAL 不要求 quantity/unitCount/Award seed 字段。
- **primarySkill / feedback / mutant**：`S02` / `REPLAY_COMPATIBILITY` / `AG-M09`。

### MIGRATE-04 OpenAPI/UI/snapshot 的新旧 Auction 证据 — 4 分

- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture / seam 动作**：Manager wire/API/snapshot/UI 要求；Chromium 并排操作 one-unit 与 multi-unit Auction，查看 bids/awards/outcome。
- **独立 oracle / mandatory assertions / 禁止副作用**：OpenAPI/runtime exact shapes、snapshot `awards` 排序、UI 显示的 allocation/clearing price 互相一致；不得让 UI 自算不同结果、读私有接口或破坏 legacy controls/body。
- **primarySkill / secondarySkills / feedback / mutant**：`S02` / `S15` / `COMPATIBLE_UI` / `AG-M09`。

### LOAD-01 20 热点 Auction 持续竞价 — 2.5 分

- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture / seam 动作**：README `hot-auction-bids`；20 sequential producers、20 concurrency、10s warm-up+60s measure。
- **独立 oracle / mandatory assertions / 禁止副作用**：仅 201 accepted 计数，≥250 Bid/s、p95≤300ms、unexpected 5xx=0，sequence gapless/leader 最大；不得并行破坏单 producer、缩放或把 409 算成功。
- **primarySkill / secondarySkills / feedback / mutant**：`S06` / `S14` / `PERFORMANCE_BID` / `AG-M02`。

### LOAD-02 live Auction 一致性读取 — 2.5 分

- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture / seam 动作**：README `live-auction-read`；独立库、20 OPEN Auctions、64 clients、60 秒。
- **独立 oracle / mandatory assertions / 禁止副作用**：≥400 read/s、p95≤100ms；每个响应 leader/amount/state/effectiveEndAt 属于同一 revision；不得混读、泄漏其他 Auction 或用旧缓存伪造。
- **primarySkill / secondarySkills / feedback / mutant**：`S06` / `S14` / `PERFORMANCE_READ` / `AG-M06`。

### LOAD-03 2,000 due Auctions close recovery — 5 分

- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture / seam 动作**：README `auction-close-recovery`；两 worker claimed 后 SIGKILL，lease 后两 replacement，45 秒 timer。
- **独立 oracle / mandatory assertions / 禁止副作用**：全部 2,000 恰一 canonical outcome、Work drain、0 unexpected failure；不得 stale commit、重复 Award/outcome 或延用非 locked Bid snapshot。
- **primarySkill / secondarySkills / feedback / mutant**：`S07` / `S14` / `PERFORMANCE_RECOVERY` / `AG-M08`。

### LOAD-04 负载后 Auction/Award/Event 跨层对账 — 3 分

- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture / seam 动作**：README post-load invariants、OpenAPI/UI/snapshot+Manager 分配规则；每条正式负载后抓独立 snapshot，并经 UI/detail 抽查结果。
- **独立 oracle / mandatory assertions / 禁止副作用**：重算 Bid sequence、leader、deadline、Award unit sum、共同 clearing price、safe totals、event order/Work drain；任一错使对应 LOAD 失败；不得只测吞吐或跨场景复用状态。
- **primarySkill / secondarySkills / feedback / mutant**：`S06` / `S14,S15` / `POST_LOAD_CLEARING` / `AG-M07`。

## 3. Worked example：CLEAR-03

Fixture 建立 `unitCount=7`，按 V1 严格递增规则依次提交 `5@80`、`3@90`、`3@100`，并保证三个 Bid 的 committedSequence 已公开可见。独立 oracle 再按价格降序排序为 100、90、80，分配 3、3、1；最低胜价为 80，因此三个 Award 的 total 分别为 240、240、80，而不是按各自 bid price 计费。runner 必须同时核对 AuctionDetail、MultiUnitAuctionOutcome、snapshot Awards、allocated/unallocated 总数与不可变重试；只看到三个赢家不算通过。

## 4. Mutant 清单（10 个）

| Mutant | 单一故障 | 必杀 Case |
| --- | --- | --- |
| AG-M01 | reserve/increment 使用 `>`/浮点或拒绝后留 Bid | BID-01 |
| AG-M02 | leader/sequence 按到达时间或 process-local counter | BID-02、LOAD-01 |
| AG-M03 | anti-sniping 边界错误或 close 不重检 deadline | BID-03/04、RACE-02 |
| AG-M04 | cancel/幂等只在进程内，产生第二效果 | BID-05、RACE-01 |
| AG-M05 | quantity/unitCount/乘积 overflow 校验错误 | CLEAR-01 |
| AG-M06 | 同价排序缺 sequence/bidId tie-break | CLEAR-02、LOAD-02 |
| AG-M07 | 各赢家按 bid price 计费或无 partial | CLEAR-03、LOAD-04 |
| AG-M08 | Awards 非原子或 close lease 无 fencing | CLEAR-04、RACE-03、LOAD-03 |
| AG-M09 | 迁移/新 wire 改写 one-unit replay | CLEAR-05、MIGRATE-01..04 |
| AG-M10 | dispatcher retry 换 event 身份/正文 | RACE-04 |

## 5. SPEC-GAP

- `SPEC-GAP-AG-01`：Manager 未发布新的 event type；不要求猜测 Award 专属事件，只验证旧 transition/event 规则和历史身份不变、不得发明名称。
- `SPEC-GAP-AG-02`：Manager 没有改变 V1 性能 workload 中 Bid request（它是 one-unit）。LOAD 只能原样重跑三条 V1-compatible 场景，multi-unit 只增加负载后 correctness，不设第四阈值。
- `SPEC-GAP-AG-03`：没有可冻结数据库 transaction timestamp 的公开 seam，无法稳定制造 acceptedAt 恰等于 120 秒窗口或 effectiveEndAt；计分 fixture 使用至少 2 秒安全余量，等点不执行且不由 sleep 猜测。
- `SPEC-GAP-AG-04`：Manager 发布了同价排序 tie-break，但 V1 又要求同 Auction 的 accepted amount 严格递增；公开 API 无法创建同价 accepted Bids，CLEAR-02 在冲突修订前 blocked。

## 6. README → Case contract-map

| 合同 | Cases |
| --- | --- |
| V1 money、sequence、deadline、anti-sniping、cancel | BID-01..05 |
| Manager multi-unit wire/分配/统一价/overflow | CLEAR-01..05 |
| durable idempotency、close race/lease、outbox | RACE-01..04 |
| V1→FINAL compatibility/migration | MIGRATE-01..04 |
| 三条 fixed performance + post-load invariants | LOAD-01..04 |
| OpenAPI/snapshot/真实 UI | MIGRATE-04（并在相关 Case 校验 wire） |

## 7. 旧 H → V2 Case

| 旧 H | V2 Cases |
| --- | --- |
| H-01 | 共享 preflight（不计分） |
| H-02 | BID-01/04、CLEAR-01/05、MIGRATE-04 |
| H-03 | BID-01..05 |
| H-04 | BID-01/04/05、CLEAR-01/04 |
| H-05 | RACE-01 |
| H-06 | BID-02/05、RACE-02 |
| H-07 | RACE-03 |
| H-08 | RACE-04 |
| H-09 | MIGRATE-01/02/03 |
| H-10 | CLEAR-01..05 |
| H-11 | RACE-02/03、MIGRATE-04 |
| H-12 | LOAD-01..04 |
| H-13 | 共享 preflight（不计分）；领域真实性由 LOAD-04 |

## 8. 评分与 hard cap

按显式 dimension 汇总为 `A=30、B=25、C=20、D=15、E=10`，共 **22 Case / 100 分**；领域 family 不决定维度。金额/单位超配、同 Auction 多 outcome、截止前合法 Bid 被 close 丢失、durable idempotency 第二效果、stale close owner 提交、迁移改写历史触发旧计划相应 hard cap。评分不以公共 build/boot 重复占分；S03/S16 仅可由不计分 trajectory observer 观测。
