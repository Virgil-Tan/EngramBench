# BillForge Hidden Test V2 设计

> 只设计黑盒 Case，不实现 runner。共享 install/build/migrate/boot/health 是不计分 preflight。计分权威只来自 `workspace/README.md`、`CONTEXT.md` 与固定 Manager 消息；旧 E2E 中未被 README 发布的性能数字不是合同。

## 1. 测试画像与隔离

- **两项主机制**：冻结计价/不可变双分录；provider identity、UNKNOWN/reconcile 与 Refund/Dispute 共享额度的串行化。
- **领域 family**：`BILL`、`PAY`、`RACE`、`ADJUST`、`COMPAT` 只用于业务定位；评分以每个 Case 的显式 A–E dimension 为准。
- **核心 primarySkill（4 个）**：`S10` immutable-ledger-correction、`S05` replay-precedence-and-identity-scope、`S04` database-owned-atomic-idempotency、`S07` durable-work-fenced-recovery；兼容、snapshot 与跨层验收只列为 `secondarySkills`。
- **隔离**：每 Case 新 tenant/database/端口；只用已发布 HTTP/OpenAPI、provider boundary、receiver、snapshot、Chromium。README 未冻结 provider-double 控制协议或 recovery barrier，依赖这些控制点的 Case 按 SPEC-GAP blocked；禁止表级检查。Case 分数独立，hard cap 后置。
- **Manager SPEC-GAP gate**：`ADJUST-*` 的语义可设计，但 Manager 未发布 request/response shape、稳定错误、snapshot resource 或 Work/Event 名称；冻结 runner 前必须补公共合同，不能由 evaluator 私造 wire。

## 2. 计分 Case（22 个，100 分）

### BILL-01 effective-dated 版本选择与期间冻结 — 6 分

- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture / seam 动作**：README「Billing」1–2；准备相邻但不重叠的 Price/Tax/Discount/FX 版本，在边界前后生成并 finalize Invoice，随后发布新版本。
- **独立 oracle / mandatory assertions / 禁止副作用**：按 period instant 独立选版本；Invoice 固定 version IDs/rate snapshot/lines，后发版本不改历史；不得重算旧 Invoice、混用边界版本或改 ledger/event。
- **primarySkill / feedback / mutant**：`S10` / `FROZEN_TERMS` / `BF-M01`。

### BILL-02 upgrade/downgrade/cancel 的冻结 proration 结果 — 6 分

- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture / seam 动作**：README「Billing」3；对同一公开 period 执行 upgrade/downgrade/cancel，重放相同语义并在随后发布新价格版本后重读。
- **独立 oracle / mandatory assertions / 禁止副作用**：只断言结果确定、同语义重放一致、PRORATION lines 与选定版本冻结、金额为安全整数且 Invoice/line 非负，后发版本不改历史；具体分摊公式、余数方向与等点顺序 blockedBy: `SPEC-GAP-BF-05`，不得由 evaluator 自拟有理数算法。
- **primarySkill / feedback / mutant**：`S10` / `PRORATION_CONSERVATION` / `BF-M02`。

### BILL-03 多币种 exchange-rate snapshot 保真 — 6 分

- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture / seam 动作**：README Domain、Billing 2；生成引用固定 exchangeRateSnapshotId 的 Invoice，随后导入/创建另一个有效汇率版本并重读、支付与结算。
- **独立 oracle / mandatory assertions / 禁止副作用**：Invoice 与后续公开账务始终引用原 snapshot/currency，后发版本不重估历史且每组 posting 同币种平衡；README 未发布 FX 换算/rounding 公式，因此不反推数值换算，相关精确算法 blockedBy: `SPEC-GAP-BF-05`。
- **primarySkill / feedback / mutant**：`S10` / `FX_SNAPSHOT` / `BF-M01`。

### BILL-04 discount floor 与 frozen taxable base — 6 分

- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture / seam 动作**：README「Billing」5；构造 discount 等于/超过 base、多税率与 proration 的 Invoice。
- **独立 oracle / mandatory assertions / 禁止副作用**：断言 discount 后任何 line/Invoice 均非负、taxable base 与选定 tax/discount versions 冻结、同语义结果稳定且整数不溢出；README 未发布 discount allocation 与 tax/proration 的运算顺序，精确顺序/金额 blockedBy: `SPEC-GAP-BF-05`，不得把某一种顺序写成 oracle。
- **primarySkill / feedback / mutant**：`S10` / `TAX_DISCOUNT_ORDER` / `BF-M02`。

### BILL-05 Invoice authority 唯一与 finalized immutable — 6 分

- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture / seam 动作**：README「Billing」4、state machine；两 API 对相同 tenant/customer/period/subscription version 创建并 finalize。
- **独立 oracle / mandatory assertions / 禁止副作用**：恰一 Invoice identity/sequence，败者 `INVOICE_ALREADY_EXISTS`；finalized 后 body/lines/versions 不变；不得双 Invoice、双 finalize Work/Event 或覆盖历史。
- **primarySkill / feedback / mutant**：`S04` / `INVOICE_UNIQUENESS` / `BF-M03`。

### PAY-01 PaymentIntent durable idempotency 与精确 replay — 5 分

- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture / seam 动作**：README Payments 1；同 key 20 路、跨 API/重启、response shield 断开，再以异 amount/currency 复用。
- **独立 oracle / mandatory assertions / 禁止副作用**：保存的 status/JSON/paymentIntentId/providerRequestId 为 oracle；同语义一次效果，异语义 conflict；不得二次 provider call/attempt/posting/event。
- **primarySkill / feedback / mutant**：`S04` / `PAYMENT_IDEMPOTENCY` / `BF-M03`。

### PAY-02 TIMEOUT/RESET → UNKNOWN 与禁止再扣款 — 5 分

- **dimension**：B（数据正确性、幂等与并发）
- **blockedBy**：`SPEC-GAP-BF-06`；provider double 的请求/控制/观察协议未发布，无法可移植地制造 TIMEOUT/RESET 并证明调用次数。
- **来源 / fixture / seam 动作**：README Payments 2/5；provider double 先 TIMEOUT 或 RESET，再对同 intent 重试 capture、查询/reconcile。
- **独立 oracle / mandatory assertions / 禁止副作用**：调用日志+公开状态证明 UNKNOWN 保留原 providerRequestId，reconcile 前无新 charge；Invoice 不 PAID、无成功 Posting；不得把 transport error 当 FAILED 后重扣。
- **primarySkill / feedback / mutant**：`S05` / `UNKNOWN_OUTCOME` / `BF-M04`。

### PAY-03 provider transaction identity 与乱序 Webhook — 5 分

- **dimension**：B（数据正确性、幂等与并发）
- **blockedBy**：`SPEC-GAP-BF-06`；README 仅列 webhook route 与行为，没有冻结 provider webhook/control wire。
- **来源 / fixture / seam 动作**：README Payments 3–4；同 transaction ID 发 duplicate/reordered success/failure，并尝试绑定另一 PaymentIntent。
- **独立 oracle / mandatory assertions / 禁止副作用**：providerEvent/request/transaction identity matrix 得到一个 semantic result；第二 intent 精确 conflict；不得重复状态转换、posting、invoice payment 或 event。
- **primarySkill / feedback / mutant**：`S05` / `PROVIDER_IDENTITY` / `BF-M05`。

### PAY-04 partial Refund、失败与 UNKNOWN 的可退款额度 — 5 分

- **dimension**：B（数据正确性、幂等与并发）
- **blockedBy**：`SPEC-GAP-BF-04`, `SPEC-GAP-BF-06`；Refund UNKNOWN 状态和 provider 控制 seam 未发布。
- **来源 / fixture / seam 动作**：README Refunds 1–3；对 captured amount 依次成功 partial、失败、UNKNOWN，再并发申请 remainder±1。
- **独立 oracle / mandatory assertions / 禁止副作用**：只按 captured amount 与公开可见的 SUCCEEDED Refund 总额重算 available；总成功不得超 captured，失败/未决事实不生成成功 Posting 或减少公开可退款额；不得发明 reservation 记录/状态、形成负余额或错误改 Invoice state。
- **primarySkill / feedback / mutant**：`S10` / `REFUND_CONSERVATION` / `BF-M06`。

### PAY-05 每个成功事实一组平衡 immutable Posting — 5 分

- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture / seam 动作**：README「Money and accounting」；完成 payment、partial refunds，再重放所有 callbacks/requests 并读取 invoice ledger。
- **独立 oracle / mandatory assertions / 禁止副作用**：按 postingId/currency 汇总 debit=credit，账户方向及 effective balance 公式一致；不得改写历史 Entry、重复 posting、跨币种配平或默认账户透支。
- **primarySkill / feedback / mutant**：`S10` / `DOUBLE_ENTRY` / `BF-M07`。

### RACE-01 mutation response loss 的原子业务+replay — 5 分

- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture / seam 动作**：README durable idempotency/transaction event；对 Invoice finalize、Refund、Settlement create 在 commit 后屏蔽响应并跨进程 replay。
- **独立 oracle / mandatory assertions / 禁止副作用**：原 status/JSON 与 snapshot identity/sequence 为 oracle；业务、Work、Event、幂等记录共同恰一次；不得出现已提交业务但无 replay 或 replay 有第二效果。
- **primarySkill / feedback / mutant**：`S04` / `ATOMIC_RESPONSE_REPLAY` / `BF-M03`。

### RACE-02 Webhook 与 reconcile 的 precedence/commutativity — 5 分

- **dimension**：C（Worker、恢复与持久性）
- **blockedBy**：`SPEC-GAP-BF-06`；没有冻结可生成同一 provider fact 的 double/webhook wire。
- **来源 / fixture / seam 动作**：README Payments 4；对同 UNKNOWN intent 交错 `webhook→reconcile`、`reconcile→webhook`、同时到达及矛盾 identity。
- **独立 oracle / mandatory assertions / 禁止副作用**：四条排列收敛到同一 canonical provider fact/status/posting；冲突按 published identity error；不得因请求顺序生成不同 invoice/ledger/event。
- **primarySkill / feedback / mutant**：`S05` / `REPLAY_PRECEDENCE` / `BF-M05`。

### RACE-03 Refund 与 Dispute 共享 reserve 的末额竞争 — 5 分

- **dimension**：C（Worker、恢复与持久性）
- **blockedBy**：`SPEC-GAP-BF-01`；合同补齐前不得运行、不得把 5 分重分配给其他 Case。
- **来源 / fixture / seam 动作**：Manager 规则 1/3；在 `SPEC-GAP-BF-01` 补齐 wire 后，两 API 让 Refund 与 OPEN/resolve Dispute 竞争同一最后额度。
- **独立 oracle / mandatory assertions / 禁止副作用**：整数 reserve 方程 `refund succeeded + refund reserved + dispute reserved <= captured`；只有一个可串行结果；不得超额、负 available、双冲销或 partial Manager aggregate。
- **primarySkill / feedback / mutant**：`S10` / `SHARED_RESERVE_RACE` / `BF-M08`。

### RACE-04 Settlement phase crash 与 frozen snapshot — 5 分

- **dimension**：C（Worker、恢复与持久性）
- **blockedBy**：`SPEC-GAP-BF-07`；README 要求 SIGKILL recovery，但没有发布 barrier URL、point 或 body，不能稳定停在 phase claim。
- **来源 / fixture / seam 动作**：README Monthly settlement 1–4；在 SNAPSHOTTING/CALCULATING/POSTING claimed barrier SIGKILL，snapshot 后再提交 payment/refund。
- **独立 oracle / mandatory assertions / 禁止副作用**：公开 snapshot digest/period totals 与迁移前事实集合重算，replacement 从 durable phase 收敛；新事实进下一 period；不得 duplicate posting、重算 frozen set 或 stale lease close。
- **primarySkill / feedback / mutant**：`S07` / `SETTLEMENT_RECOVERY` / `BF-M09`。

### ADJUST-01 Dispute create 的 OpenAPI/runtime/snapshot 闭环 — 4 分

- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **blockedBy**：`SPEC-GAP-BF-01`, `SPEC-GAP-BF-02`；合同补齐前不得运行或重新归一化。
- **来源 / fixture / seam 动作**：Manager 规则 1/5/7；待 `SPEC-GAP-BF-01/02` 公布 wire/snapshot 后，经 live HTTP 与 OpenAPI 创建多个 Dispute，并在 UI/point-in-time snapshot 查看边界与越界。
- **独立 oracle / mandatory assertions / 禁止副作用**：OpenAPI/live body/UI/snapshot 一致，公开 reserve 方程闭合；合法均 OPEN，越界原子拒绝；不得在 OPEN 时创建 Chargeback Posting、改 Invoice paid/refunded、占用超过 captured 或由前端伪造状态。
- **primarySkill / feedback / mutant**：`S10` / `DISPUTE_RESERVE` / `BF-M08`。

### ADJUST-02 WON/LOST 的 UI→Ledger→Event 跨层纠正链 — 4 分

- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **blockedBy**：`SPEC-GAP-BF-01`, `SPEC-GAP-BF-02`；合同补齐前不得运行或重新归一化。
- **来源 / fixture / seam 动作**：Manager 规则 2/5/7；待 wire/Event/snapshot 补齐后由 UI 分别 resolve WON/LOST，再经 live ledger、Event 与 snapshot 追踪同 key/异 key replay。
- **独立 oracle / mandatory assertions / 禁止副作用**：UI/runtime/Event/ledger/snapshot 同一 identity；WON 后 reserve 释放且零 chargeback，LOST 恰一 balanced immutable posting group；不得双 posting、改原 payment Entry、让终态反转或展示与账本不一致金额。
- **primarySkill / feedback / mutant**：`S10` / `CHARGEBACK_CORRECTION` / `BF-M08`。

### ADJUST-03 Dispute/Refund 并发的跨层线性化证据 — 4 分

- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **blockedBy**：`SPEC-GAP-BF-01`, `SPEC-GAP-BF-02`, `SPEC-GAP-BF-06`；合同补齐前不得运行或重新归一化。
- **来源 / fixture / seam 动作**：Manager 规则 3/7；待 wire/provider/snapshot 补齐后，对同 reserve 并发 WON/LOST 与 Refund，并用 UI、live API、ledger、Event、snapshot观察终态。
- **独立 oracle / mandatory assertions / 禁止副作用**：各公开面指向同一线性化结果，以 commit 后 facts 重放守恒，允许序列均保持 cap 与一次 chargeback/refund posting；不得依赖到达顺序超额、同一 provider fact执行两次或 UI/账本分叉。
- **primarySkill / feedback / mutant**：`S10` / `DISPUTE_REFUND_SERIALIZATION` / `BF-M08`。

### ADJUST-04 CLOSED 后只追加下一开放期 Adjustment — 2.5 分

- **dimension**：E（迁移、性能与可运维性）
- **blockedBy**：`SPEC-GAP-BF-01`, `SPEC-GAP-BF-02`；合同补齐前不得运行或重新归一化。
- **来源 / fixture / seam 动作**：Manager 规则 4–5；待 wire 补齐后引用 CLOSED run 的原 Posting 创建 adjustment，并尝试直接 reopen/recalculate。
- **独立 oracle / mandatory assertions / 禁止副作用**：旧 run/digest/totals/Entries byte-stable，新 Adjustment 引用原 posting 且在下一 open period 形成 balanced entries；不得回写 CLOSED、删除/修改历史或落入旧 period。
- **primarySkill / feedback / mutant**：`S10` / `APPEND_ONLY_ADJUSTMENT` / `BF-M10`。

### COMPAT-01 V1 全资源、Posting 与 replay 身份迁移 — 2.5 分

- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture / seam 动作**：Manager 规则 6；迁移含 DRAFT/OPEN/PAID/refunded Invoice、UNKNOWN intent、partial refund、各 settlement phase 与 saved replay。
- **独立 oracle / mandatory assertions / 禁止副作用**：迁移前后公开 IDs/shapes/status/JSON、ledger entries、snapshot digest、events 精确对应；不得重算发票/结算、合成 Dispute 或改 idempotency semantics。
- **primarySkill / secondarySkills / feedback / mutant**：`S10` / `S02` / `V1_MIGRATION` / `BF-M10`。

### COMPAT-02 in-flight Work、UNKNOWN 与 provider identity 保真 — 2.5 分

- **dimension**：E（迁移、性能与可运维性）
- **blockedBy**：`SPEC-GAP-BF-06`, `SPEC-GAP-BF-07`；无法经冻结 seam 构造 delayed provider fact 与确定的 LEASED checkpoint。
- **来源 / fixture / seam 动作**：README Work/Payments 与 Manager 规则 6；迁移时保留 LEASED capture/refund/settlement Work、UNKNOWN PaymentIntent 与 delayed Webhook。
- **独立 oracle / mandatory assertions / 禁止副作用**：workId/lease/attempt/providerRequestId/transaction identity 不变，replacement/reconcile 按原事实收敛；不得重新 charge、换 identity、重置 phase 或 stale commit。
- **primarySkill / secondarySkills / feedback / mutant**：`S07` / `S02` / `INFLIGHT_COMPATIBILITY` / `BF-M09`。

### COMPAT-03 seed/snapshot 的 V1 exactness 与 point-in-time 账务 — 2.5 分

- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture / seam 动作**：README「Seed and snapshot」；合法 seed/replay/conflict/坏引用，并在并发 payment/refund 时重复抓 snapshot。
- **独立 oracle / mandatory assertions / 禁止副作用**：V1 exact member set、稳定 ID 排序、同一观察点的 invoice/payment/refund/ledger/settlement 守恒；不得接受 Manager seed member、跨时点撕裂或泄漏 raw provider/private path。
- **primarySkill / secondarySkills / feedback / mutant**：`S10` / `S02,S11` / `SNAPSHOT_COMPATIBILITY` / `BF-M01`。

### COMPAT-04 OpenAPI/真实 UI 的旧账单与新增纠正闭合 — 3 分

- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **blockedBy**：`SPEC-GAP-BF-01`, `SPEC-GAP-BF-02`；因 mandatory assertions 包含新增纠正流程，合同补齐前整 Case 不运行、不拆分重分。
- **来源 / fixture / seam 动作**：README UI/API 与 Manager 规则 5/7；Chromium 完成 V1 invoice→payment→refund→settlement，并在 SPEC-GAP 补齐后完成 dispute/adjustment。
- **独立 oracle / mandatory assertions / 禁止副作用**：OpenAPI/runtime/可见 UI 与 snapshot/ledger 逐层一致，refresh 后仍可审计；不得用 mock/provider credential、私有 API 或展示与账本不一致的派生金额。
- **primarySkill / secondarySkills / feedback / mutant**：`S10` / `S02,S15` / `CROSS_LAYER_COMPATIBILITY` / `BF-M10`。

## 3. Worked example：RACE-02

本例受 `SPEC-GAP-BF-06` 阻塞。合同补齐后，先经冻结 provider seam 让固定 `providerRequestId` 进入 UNKNOWN；四个隔离子 fixture 分别执行 webhook-success→reconcile、reconcile→webhook-success、两个公开请求并发到达、duplicate/reordered webhook。独立 oracle 只接受一条 Provider transaction identity、一组 balanced payment Posting、Invoice 一次状态推进及一个语义事件；四种排列的最终公开状态必须等价。测试不能调用实现内 helper，也不假设未发布 barrier。

## 4. Mutant 清单（10 个）

| Mutant | 单一故障 | 必杀 Case |
| --- | --- | --- |
| BF-M01 | 发票/结算使用最新版本或 FX，而非冻结 snapshot | BILL-01/03、COMPAT-03 |
| BF-M02 | proration/discount/tax 用浮点或允许负 line | BILL-02/04 |
| BF-M03 | Invoice/Payment 幂等为 process-local 或副作用与 replay 分事务 | BILL-05、PAY-01、RACE-01 |
| BF-M04 | UNKNOWN 被当 FAILED 并再次 capture | PAY-02 |
| BF-M05 | webhook/reconcile precedence 依赖到达顺序或 transaction ID 可复用 | PAY-03、RACE-02 |
| BF-M06 | 并发 Refund 的 SUCCEEDED 总额超过 captured，或失败/未决事实错误减少可退款额 | PAY-04 |
| BF-M07 | posting 单腿、币种混配或直接改历史 Entry | PAY-05 |
| BF-M08 | Dispute reserve/resolve 与 Refund 非串行、LOST 重复 chargeback | RACE-03、ADJUST-01..03 |
| BF-M09 | settlement/迁移重置 phase 或无 lease fencing | RACE-04、COMPAT-02 |
| BF-M10 | 直接修改 CLOSED run，或迁移/UI 改写 V1 历史 | ADJUST-04、COMPAT-01/04 |

## 5. SPEC-GAP 登记

- `SPEC-GAP-BF-01`（**runner freeze blocker**）：Manager 未定义 `Dispute`、`Adjustment`、Chargeback Entry 的 exact public shape，也未定义三个新增 POST 的 request/response body。`RACE-03`、`ADJUST-01..04`、`COMPAT-04` 的新增流程部分必须在公开合同补齐后才能实现，evaluator 不得猜 `{amountMinor}`/`{outcome}` 等字段。
- `SPEC-GAP-BF-02`：Manager 未发布新增稳定错误、snapshot keys、Work kind 或 Domain Event type。V2 只断言已发布 V1 身份/事件不变；不得私设名称或把候选自选名称当统一 oracle。
- `SPEC-GAP-BF-03`：README 没有发布性能 workload/规模/阈值。旧 H-12 的 `100,000/250 invoice/s` 等数字不可计分；本设计不设性能 Case，`COMPAT` 的 10 分只测已发布领域兼容合同。
- `SPEC-GAP-BF-04`：README Refund state 不含 UNKNOWN，但 Required behavior 提到“failed or unknown Refund”。在状态/wire 补齐前，PAY-04 只对 provider 未决事实的额度/无成功 Posting 做黑盒断言，不要求一个未发布的 Refund state 字符串。
- `SPEC-GAP-BF-05`：README 只要求 deterministic proration、冻结 exchange-rate snapshot、discount 不得为负及 frozen taxable base，未发布 proration 公式/余数规则、FX 换算与 rounding、discount allocation 与 tax/proration 顺序；V2 只测冻结、稳定、整数与非负，不发明精确算法。
- `SPEC-GAP-BF-06`：provider test double 的 endpoint、request/response、控制脚本与可观察调用日志均未冻结；依赖 TIMEOUT/RESET、乱序 callback 或精确调用次数的 Case blocked。
- `SPEC-GAP-BF-07`：README 未发布 `TEST_BARRIER_URL`、barrier point/body/header；需要确定 phase claim/lease checkpoint 的 SIGKILL Case blocked，不能用 sleep 代替。

## 6. README → Case contract-map

| 合同 | Cases |
| --- | --- |
| Billing/frozen terms/proration/tax | BILL-01..05 |
| Payment/UNKNOWN/provider identity/refunds/ledger | PAY-01..05 |
| 跨进程 replay、reconcile 与 settlement recovery | RACE-01..04 |
| Manager Dispute/Chargeback/Adjustment | RACE-03、ADJUST-01..04（受 SPEC-GAP gate） |
| Manager V1 preservation、seed/snapshot/UI | COMPAT-01..04 |

## 7. 旧 H → V2 Case

| 旧 H | V2 Cases |
| --- | --- |
| H-01 | 共享 preflight（不计分）；seed 领域语义 COMPAT-03 |
| H-02 | BILL-01/04/05、COMPAT-04 |
| H-03 | BILL-02 |
| H-04 | BILL-03 |
| H-05 | PAY-01、RACE-01 |
| H-06 | PAY-02、RACE-02 |
| H-07 | PAY-03、RACE-02 |
| H-08 | PAY-04/05、RACE-03 |
| H-09 | ADJUST-01..03 |
| H-10 | RACE-04、ADJUST-04 |
| H-11 | RACE-04、COMPAT-02 |
| H-12 | `SPEC-GAP-BF-03`：不计分，不沿用未发布阈值 |
| H-13 | 共享 preflight（不计分）；领域闭合 COMPAT-04 |

## 8. 评分

按显式 dimension 汇总为 `A=30、B=25、C=20、D=15、E=10`，共 **22 Case / 100 分**；领域 family 不决定维度。任何 money overflow、unbalanced posting、captured amount 超额、UNKNOWN 二次扣款、CLOSED history 改写、幂等第二效果、stale settlement commit 或迁移丢账均触发领域 hard cap。S03/S16 不作为计分 primarySkill；若需轨迹证据，仅由不计分 observer 记录。
