# EscrowGuard Hidden Test v2 详细设计

> 共享计分、隔离、证据与报告规则见 [`docs/hidden-test-v2-standard.zh-CN.md`](../../../docs/hidden-test-v2-standard.zh-CN.md)；本文件只细化 EscrowGuard 的 task-specific 合同、oracles、fixtures 与 cases。冲突时以公开 Task Contract 为准。

## 1. 目标、权威来源与合同缺口

本方案把现有 H-01～H-13 拆成 **48 个 Harness-owned、可独立复现的黑盒 case**。测试只经过公开命令、HTTP、生产浏览器、verification snapshot、webhook、barrier 和进程边界，不读取 Candidate 表、ORM、源码或内部 helper。

权威顺序：

1. `workspace/README.md` 的 V1 合同；
2. `orchestration/user-and-manager-prompts.zh-CN.md` 中 `FIXED_MANAGER_MESSAGE`；
3. `workspace/AGENTS.md` 与 `CONTEXT.md`；
4. 本文件只把合同变成测试，不新增产品规则。

正式实现前必须处理以下合同缺口：

- `EG-GAP-01`：`submit` 的 `{evidence}` 没有发布 evidence 的 JSON 类型、大小或 nested-field 规则。冻结前，计分 HTTP Case 不发送成功 submit，也不猜一个“普通 JSON”；需要 SUBMITTED 前置时使用 V1 exact seed，Browser Case 只通过可见控件操作且不把 Candidate 选择的 wire envelope 当 expected value。
- `EG-GAP-02`：Manager 同时要求 `Release` 增加 `payouts`，又要求 legacy one-Seller Release response byte-for-byte 不变，但没有发布 legacy media type 或内容协商规则。迁移测试可比较已保存 V1 replay；新请求的 legacy response 是否含 `payouts` 必须先冻结。
- `EG-GAP-03`：`BENEFICIARY_PAYOUT_CONFLICT` 需要 persisted payout set 与 captured shares 不同，但没有公开 seam 能合法制造该状态。Evaluator 不得写私有表；只验证 OpenAPI 声明及自然并发中若触发时的稳定错误。

在缺口未解决前不得用 evaluator 的偏好补齐合同，也不得因此惩罚 Candidate。

## 2. 公开测试 seams

| Seam | 允许观察 | 禁止行为 |
| --- | --- | --- |
| Published commands | README 精确命令、退出码、子进程、日志 | import Candidate module、替换脚本 |
| HTTP/OpenAPI | `/healthz`、`/openapi.json`、公开 `/api/v1` 路由 | 调用 debug/private route |
| Verification snapshot | ADMIN_TOKEN 下同一 point-in-time 的 resources/work/events | 直查私有表或猜表名 |
| Production browser | production build、系统 Chromium、可见语义控件 | 注入 store、用页面脚本替代用户动作 |
| Webhook receiver | 接收事件并控制 2xx/500/断线/未知 ACK | 读取 Candidate outbox |
| Recovery barrier | README 发布的四个 barrier point | 用随机 sleep 猜 claim/commit |
| Process boundary | 独立 API/Worker/dispatcher、SIGTERM/SIGKILL/restart | 用同进程对象模拟多进程 |
| V1→FINAL checkpoint | V1 binary 生成状态，FINAL binary 迁移同一库 | 用 FINAL binary 伪造 V1 历史 |

所有预期值来自合同字面值、固定 worked example 与独立 oracle；Candidate 输出不能反向生成 expected value。

## 3. Runner、case 与结果接口

建议在 `evaluator/v2/` 下按 `cases/A..E`、`fixtures/`、`oracles/`、`calibration/` 组织。每个 case 使用独立数据库、端口、receiver 和 managed-data root；迁移 case 除外。性能 case 独占 4 CPU/8 GiB 环境。

```js
export default {
  id: "B-03",
  dimension: "data-correctness",
  weight: 2.5,
  prerequisites: ["FINAL"],
  async run(ctx) { return ctx.pass({ evidence: [] }); }
};
```

一个 case 内所有 mandatory assertions 全过才得分。结果必须区分 `passed|failed|excluded|evaluator_error`；总 verdict 为 `accepted|rejected|invalid|evaluator_error`，并保存 submission digest、fixture seed、duration、private failure code 和 evidence digest。`excluded` 只允许 Task Package 确实缺少阶段资产，正式完整实验不得默认排除迁移。

## 4. 独立 oracle 与确定性 fixtures

### 4.1 Escrow oracle

Evaluator 独立维护每个 Escrow 的状态模型：

- `totalMinor = availableMinor + releasedMinor + refundedMinor` 且各项非负安全整数；
- Milestone ordinal 从 1 连续，amount 总和等于 total；
- 只有最低未释放 ordinal 可前进，最多一个 SUBMITTED/DISPUTED；
- 每个 amount 只能 release 或 refund 一次；
- RELEASE dispute 只释放当前 Milestone；REFUND dispute 退当前及其后全部 amount；
- FINAL 中每个 Milestone 的 Share amount 精确守恒，Release 的 Payout 集合与 captured Shares 一一对应。

例如 `total=100`、Milestones=`[30,20,50]`：先释放 30 后 position 必须为 `70/30/0`；第二项 dispute REFUND 后必须为 `0/30/70`，不得只退 20，也不得为第三项创建 payout。

### 4.2 确定性夹具

- UUID、idempotency key、时间由私有 `evaluationSeed + caseId + ordinal` 生成；
- `T0` 取可观察数据库时间之后的安全窗口，所有 deadline/expiry 从 T0 派生；
- `F-V1-FLOW`：1、2、20 Milestones 与 release/refund 路径；
- `F-RACES`：accept/dispute/resolve/expiry 的确定性交错；
- `F-IDEMPOTENCY`：每个 mutation 的 replay、conflict、unknown response；
- `F-WORK-EVENT`：PENDING/LEASED/terminal Work 与未 ACK events；
- `F-FINAL-SHARES`：1、2、20 Shares、mixed legacy/Manager Milestones、非法 sum/duplicate；
- `F-MIGRATION`：全部 V1 states、saved response、leased Work、undelivered event；
- `F-BROWSER`：可见主流程及错误状态；
- `F-PERF-V1`：README 精确 perf-v1 dataset。

同 Submission+seed 的非性能结果必须可复现；并发 calibration 至少使用三个冻结 seed。

## 5. 计分

| 维度 | 分值 | cases |
| --- | ---: | ---: |
| A. 需求与公共接口覆盖 | 30 | 15 |
| B. 数据正确性、幂等与并发 | 25 | 10 |
| C. Worker、恢复与持久性 | 20 | 8 |
| D. OpenAPI、UI 与跨层闭环 | 15 | 8 |
| E. 迁移、性能与可运维性 | 10 | 7 |
| **总计** | **100** | **48** |

## 6. A — 需求与公共接口覆盖（30 分）

### A-01 Clean commands and production boot — 2
- 前置：无 `node_modules/dist` 的冻结 Submission、空库。
- 操作：依次执行 install、migrate×2、build，并独立启动 API、Worker、dispatcher。
- 可观察断言：命令非交互且失败非零；生产 UI、health、OpenAPI 可达；三个角色为独立进程；SIGTERM 后无子进程或端口残留。

### A-02 Repeatable migration — 2
- 前置：空库与一份合法 V1 业务 fixture。
- 操作：空库 migration×2，创建状态后再 migration×2。
- 可观察断言：所有 IDs、Fund Position、Work/Event identity 和 saved responses 不变；失败 migration 不留下 partial observable schema。

### A-03 Strict atomic seed — 2
- 前置：合法 seed 基线。
- 操作：重放相同 version/digest，再分别导入 duplicate、broken reference、bad ordinal/sum/state/time、unknown field 与 same-version different digest。
- 可观察断言：合法重放 no-op；冲突给 `SEED_VERSION_CONFLICT`；每个非法 seed 后 snapshot bitwise semantic 等价且无 Work/Event/idempotency effect。

### A-04 HTTP envelope and validation — 2
- 前置：API 已启动。
- 操作：逐 mutation 发送 unsupported media、malformed JSON、unknown field、missing/invalid value、坏 admin token 和 missing resource。
- 可观察断言：分别得到 published status/code；error 精确为 `{error:{code,message,details}}`；失败均零副作用。

### A-05 Pagination, detail and snapshot contract — 2
- 前置：至少 121 个按私有 seed 打乱写入的 Escrow。
- 操作：遍历默认/1/100 limit、多页 cursor、malformed cursor、detail 与 snapshot。
- 可观察断言：无遗漏/重复；cursor opaque；exact shapes/sorts；snapshot 同一 point-in-time、递归省略 `*Token` 与秘密。

### A-06 Funded Escrow creation — 2
- 前置：Buyer/Seller parties 与未来 expiry。
- 操作：创建 1、2、20 Milestones；再测 0/21、零/负/unsafe amount、bad currency、sum 不等。
- 可观察断言：合法请求原子生成一个 FUNDED Escrow、连续 Milestones、一个 expiry Work、一个 `escrow.funded` event；非法请求 `INVALID_ESCROW_TOTAL` 且零状态。

### A-07 Current-Milestone ordering guards — 2
- 前置：V1 exact seed 创建三 Milestone FUNDED Escrow，以及一条合法 SUBMITTED current Milestone history。
- 操作：对 later PENDING Milestone 调用 accept/dispute，对 current PENDING Milestone调用 accept；读取 detail/history。
- 可观察断言：later ordinal 不能越过 current，未 SUBMITTED 的 current 返回 `MILESTONE_NOT_SUBMITTED`，所有失败零副作用；seeded SUBMITTED history 的 amount/ordinal immutable。EG-GAP-01 未冻结前不发送成功 submit。

### A-08 Acceptance and exact release — 2
- 前置：current Milestone 已 SUBMITTED。
- 操作：accept，并 replay；随后尝试再次 accept/submit later before prior completion 的反例。
- 可观察断言：恰好一 Release，available→released 精确移动，Milestone 终为 RELEASED；全量完成时 Escrow RELEASED，否则 ACTIVE；无重复 amount/event。

### A-09 Dispute resolved RELEASE — 2
- 前置：current SUBMITTED Milestone。
- 操作：BUYER/SELLER 合法 open，管理员以 RELEASE resolve；测试坏 token 与 duplicate resolve。
- 可观察断言：open 冻结为 DISPUTED；resolve 与普通 release 同一守恒语义；Dispute/Release/Fund Position/Event 原子；重复或未授权无第二效果。

### A-10 Dispute resolved REFUND — 2
- 前置：前序 Milestone 已释放，current Milestone 已 DISPUTED，后续仍 PENDING。
- 操作：管理员 REFUND resolve。
- 可观察断言：current 及全部 later 变 REFUNDED，exact sum available→refunded，前序 Release 不变，Escrow REFUNDED，且不存在 beneficiary payout。

### A-11 Expiry eligibility — 2
- 前置：分别构造到期 FUNDED、部分释放 ACTIVE、SUBMITTED、DISPUTED、terminal Escrow。
- 操作：运行 expiry Worker 穿过真实 deadline。
- 可观察断言：仅无 SUBMITTED/DISPUTED 的 eligible aggregate 一次性退款；不提前 expiry；阻塞/terminal Work 安全收敛且不覆盖合法 winner。

### A-12 Events and aggregate query — 2
- 前置：经公开 mutation 形成 create/release/dispute/refund 历史；SUBMITTED 前置来自 exact seed。
- 操作：按 aggregateId、afterSequence、limit 分页读取。
- 可观察断言：sequence 从 1 连续、type 属于发布集合、payload 精确 `{}`、排序稳定；rollback 无 event；success state/event 同时可观察。

### A-13 FINAL beneficiary capture — 2
- 前置：Manager 已发布、合法 parties。
- 操作：创建含 legacy、1、2、20 beneficiary Shares 的 mixed Escrow，并发送 0/21、duplicate、nonpositive、bad-sum 输入。
- 可观察断言：合法 Shares ordinal 连续且 captured immutable；每个 Milestone amount 精确守恒；非法输入 `INVALID_BENEFICIARY_ALLOCATION` 且整个 Escrow 不存在。

### A-14 FINAL atomic payouts — 2
- 前置：带多个 Shares 的 SUBMITTED Milestone 与一条 DISPUTED Milestone。
- 操作：分别走 accept 与 resolve RELEASE。
- 可观察断言：每条路径原子创建一个 Release 和完整 Payout 集合；每个 Payout 的 identity/beneficiaryShareId/beneficiary/amount 与 Share 对应，`Release.payouts` 按对应 Share ordinal 排序；Payout 本身不要求未发布的 ordinal 字段；不存在 partial payout，replay 不重复。

### A-15 FINAL compatibility and exact snapshot — 2
- 前置：V1 legacy 与 FINAL mixed Escrows 共存。
- 操作：用旧请求读写 legacy aggregate，再读取 FINAL detail/snapshot/OpenAPI。
- 可观察断言：旧路由与错误语义仍工作；FINAL resources 只有 V1 keys + `beneficiaryShares/beneficiaryPayouts`；旧 IDs/events/work 保持；EG-GAP-02 未冻结前不猜新 legacy response 字段。

## 7. B — 数据正确性、幂等与并发（25 分）

### B-01 Fund conservation at integer boundaries — 2.5
- 前置：1、2、20 Milestones，含 `Number.MAX_SAFE_INTEGER` 附近合法/非法 totals。
- 操作：执行 partial release、REFUND resolution 与失败 mutation。
- 可观察断言：oracle 在每个 commit 后精确成立；无浮点舍入、负数、双计 release/refund；失败前后 snapshot 差异为空。

### B-02 Current-ordinal action contention — 2.5
- 前置：exact seed 创建 current SUBMITTED ordinal 1、later PENDING ordinal 2。
- 操作：两个 API 交错 accept/dispute current 与 accept/dispute later。
- 可观察断言：later ordinal 不能越过 current；current 只有一个 serialized winner；最多一个 RELEASED/DISPUTED transition；events 连续。EG-GAP-01 未冻结前不并发 submit。

### B-03 Accept versus expiry — 2.5
- 前置：临近 expiry 的 current SUBMITTED 或 eligible ACTIVE Escrow。
- 操作：在 barrier 控制下并发 accept 与 expiry commit。
- 可观察断言：恰好一个 serialized winner；同一 amount 不会同时 released/refunded；loser 产生 published conflict/安全 Work 终态；守恒与 event 数正确。

### B-04 Accept versus dispute open — 2.5
- 前置：一个 current SUBMITTED Milestone。
- 操作：两个 API 分别 32 路 accept 与 open dispute。
- 可观察断言：最终只能 RELEASED 或 DISPUTED；Dispute 与 Release 不同时存在于冲突历史；任何 loser 零副作用。

### B-05 Dispute resolution versus competing terminal action — 2.5
- 前置：OPEN Dispute 与到期 Escrow。
- 操作：并发 RELEASE/REFUND resolution、expiry 和 duplicate resolve。
- 可观察断言：一个决议胜出，Dispute terminal 与 Escrow/Fund Position 一致；未决 dispute 永远阻止 expiry；无双 terminal event。

### B-06 Unknown-response durable replay — 2.5
- 前置：response shield 与公开 request shape 已冻结的 V1/FINAL mutations；EG-GAP-01 未冻结前排除 submit。
- 操作：完整 upstream response 后断开客户端，API restart 后相同 key/body retry。
- 可观察断言：返回原 status/semantic JSON；Escrow、Release、Payout、Dispute、Work/Event 各最多一个效果。

### B-07 Same-key authority across APIs — 2.5
- 前置：两个 API 共享一 PostgreSQL。
- 操作：64 路相同 key/body 首次请求；另发 same key/different body；重启第三 API replay。
- 可观察断言：首批响应唯一，同 key 冲突为 `IDEMPOTENCY_CONFLICT`，第三 API 仍返回原结果；process-local map mutant 失败。

### B-08 Distinct-key terminal races — 2.5
- 前置：同 aggregate 可被 accept/resolve/expiry 竞争。
- 操作：多个合法 distinct keys 经两个 API/两个 Worker 确定性交错。
- 可观察断言：不同 keys 不绕过状态机；最多一个 terminal transition；每个 committed key 的 saved response 与最终 history 可解释一致。

### B-09 Beneficiary allocation/payout atomicity — 2.5
- 前置：20 Shares 且其中多 beneficiary 重复出现在不同 Milestones。
- 操作：双 API 并发 accept 或 resolve RELEASE，并在 response shield 下 replay。
- 可观察断言：Release/Payout 是全有或全无；每 Share 恰有一匹配 Payout；总 payout 等于 Milestone amount；锁顺序不造成死锁。

### B-10 Refund/expiry never pays beneficiaries — 2.5
- 前置：含 Shares 的 current/later Milestones。
- 操作：并发 dispute REFUND、expiry 与 stale release attempt。
- 可观察断言：refund winner 后所有 unreleased Shares 保留历史但零 Payout；amount 完整退款；stale release 不能补写 payout；自然触发 payout conflict 时返回稳定 409 而非 500。

## 8. C — Worker、恢复与持久性（20 分）

### C-01 Work lifecycle and retention — 2.5
- 前置：future、due、terminal expiry Work。
- 操作：观察 claim、reclaim、success/cancel/fail 与 backlog drain。
- 可观察断言：Work exact shape；lease fields 仅 LEASED 非空；attempt 单调；terminal 保留；drain 只在无 `terminal:false` 时成立。

### C-02 SIGKILL after `worker.claimed` — 2.5
- 前置：due Escrow、barrier 持有 claimed。
- 操作：确认无开放 DB transaction，SIGKILL Worker A，lease expiry 后启动 B。
- 可观察断言：B reclaim 且 attempt+1；退款一次；A 无法提交；Work/Event identity 不重复。

### C-03 SIGKILL after `worker.effect-complete` — 2.5
- 前置：barrier 持有 effect-complete。
- 操作：杀 A，启动 replacement。
- 可观察断言：外部/计算阶段可重做；业务 transaction 最终完整一次；不出现已退款但 Work 永久 nonterminal 或第二 event。

### C-04 SIGKILL at `worker.before-commit` — 2.5
- 前置：barrier 持有 before-commit。
- 操作：杀 Worker 并恢复。
- 可观察断言：原 transaction 要么全无要么完整一次；Escrow/Milestones/Fund Position/Work/Event 无 partial combination。

### C-05 Expired lease fencing — 2.5
- 前置：A claim 后暂停至 lease 过期，B reclaim。
- 操作：B 完成后释放 A。
- 可观察断言：A 的 stale ownership 不能 terminal commit；最终只反映 B 的 token/attempt/result，守恒和 sequence 不变。

### C-06 Manual winner closes obsolete Work — 2.5
- 前置：future expiry Work 与合法人工 release/refund winner。
- 操作：先完成 terminal mutation，再运行 Worker。
- 可观察断言：obsolete Work cancelled/succeeded 安全终结；不形成 immortal backlog；Worker 不改写 terminal aggregate。

### C-07 Unknown webhook ACK — 2.5
- 前置：receiver 已保存完整 event request 但隐藏 ACK。
- 操作：SIGKILL dispatcher，依次模拟 500、disconnect、replacement success。
- 可观察断言：eventId/type/semantic bytes 稳定、bounded backoff、同 aggregate 顺序不倒置、无第二 logical event。

### C-08 Transactional event and dispatcher ordering — 2.5
- 前置：多个 aggregates、success 与 rollback mutations。
- 操作：并发产生 events，并在 `dispatcher.response-received` kill/restart。
- 可观察断言：success 必有同 transaction event，rollback 无 event；各 aggregate sequence 连续；跨 aggregate 可交错；秘密与 token 不泄漏。

## 9. D — OpenAPI、UI 与跨层闭环（15 分）

### D-01 OpenAPI validates real traffic — 2
- 前置：FINAL OpenAPI 与独立 contract schema。
- 操作：每 route 采一个 success 和一个 published error，通过独立 validator 校验。
- 可观察断言：OpenAPI 3.1 的 paths/status/body/required/nullable/additionalProperties 与真实 traffic 一致；只列 path、不匹配 schema 失败。

### D-02 Browser V1 release lifecycle — 2
- 前置：production build、系统 Chromium、真实 DB/API/Worker。
- 操作：仅可见控件 create→submit→accept 多 Milestones，刷新 detail；Evaluator 不读取或规定 UI 发出的 evidence JSON envelope。
- 可观察断言：UI 展示 frozen amounts、Fund Position、history/Work/Event；刷新后为 server authority；无 API 替代 primary action；EG-GAP-01 不作为 wire-shape 断言。

### D-03 Browser dispute and expiry — 2
- 前置：可 dispute 与临期 Escrows。
- 操作：UI open/resolve dispute，观察 expiry progress 和 terminal states。
- 可观察断言：permission/conflict/terminal 状态可见；异步进度最终与 snapshot 一致；未决 dispute 不显示虚假退款。

### D-04 Browser beneficiary flow — 2
- 前置：FINAL UI。
- 操作：可见控件创建 legacy、2、20 Shares，执行 release/refund 并查看 detail。
- 可观察断言：可动态增删、总和 validation、Payout 映射和 refund-without-payout 可见；不得固定两个 beneficiary。

### D-05 UI recovery, accessibility and security — 2
- 前置：slow/offline/401/409/empty fixtures、desktop/mobile viewport。
- 操作：键盘完成主流程，触发 loading/retry/validation/conflict/permission/terminal。
- 可观察断言：label/focus/keyboard/viewport 可用；retry 不重复 mutation；ADMIN_TOKEN、idempotency key、private path 不进入 bundle/DOM/log。

### D-06 Snapshot and visible evidence agree — 2
- 前置：复杂 mixed history。
- 操作：分别从 detail、browser、snapshot、event query 读取同一 aggregate。
- 可观察断言：amount/state/order/Dispute/Release/Shares/Payouts/Work/Event 可一一对应；snapshot exact sort/shape/secret omission。

### D-07 Project gates are not fake green — 2
- 前置：clean database 与公开 test commands。
- 操作：逐个运行 unit/integration/e2e/concurrency/recovery/all/test:perf，并观察外部 seams。
- 可观察断言：integration 真用 PostgreSQL+HTTP；e2e 真用 production Chromium；concurrency 至少 2 API+2 Worker；recovery 命中 barrier+SIGKILL；`test:perf` 实际运行三个固定场景和后置不变量；0 tests/字符串检查/吞失败均失败。

### D-08 README-to-evidence ledger — 1
- 前置：全部 case evidence。
- 操作：为每个 observable requirement 建 `README→HTTP→OpenAPI→UI(适用)→snapshot/work/event→hidden case` 映射。
- 可观察断言：节点只能为 unrun/empty/failed/partial/passing；只有全部适用节点实际执行才 passing，不能凭文件或测试名闭环。

## 10. E — 迁移、性能与可运维性（10 分）

### E-01 Populated V1→FINAL migration — 2
- 前置：真实 V1 binary 创建全部 states、legacy Releases 与 one-Seller Milestones。
- 操作：同库运行 FINAL migration 两次并继续旧客户端流量。
- 可观察断言：每个 V1 Milestone 恰好一个 Seller Share；Escrow/Milestone/Release identity 与 amounts 不变；旧流程继续工作；无重复 Shares。

### E-02 Saved replay and event compatibility — 2
- 前置：V1 success/conflict/unknown-response saved records 与 delivered/undelivered events。
- 操作：迁移后 replay 相同 key并读取 events。
- 可观察断言：原 status/body/identity 不被重写，eventId/type/body/sequence 不变；EG-GAP-02 未解决前以保存的 V1 bytes 为唯一兼容 oracle。

### E-03 Pending Work across migration — 2
- 前置：V1 PENDING/LEASED expiry Work，不同 attempt/owner/expiry。
- 操作：FINAL migration、等待 reclaim、replacement drain。
- 可观察断言：deadline/aggregateId/attempt/lease state 保留；stale owner 不可提交；FINAL Worker 能处理旧 payload。

### E-04 `escrow-detail-read` performance — 1
- 前置：README 精确 perf-v1 seed、独占 4 CPU/8 GiB。
- 操作：原样运行 published selector、64 concurrency、10s warmup、60s measure。
- 可观察断言：≥300/s、p95≤140ms；只计完整且 oracle-valid detail；unexpected 5xx=0，负载后读取守恒。

### E-05 `funded-escrow-create` performance — 1
- 前置：README 精确 perf-v1 seed 与 disjoint measured identities、独占 4 CPU/8 GiB。
- 操作：原样运行 published request/selector、64 concurrency、10s warmup、60s measure。
- 可观察断言：≥80/s、p95≤500ms；每个成功创建满足 Fund Position/Milestone/Work/Event oracle；unexpected 5xx=0。

### E-06 `expiry-recovery` performance — 1
- 前置：精确 5,000 due Escrows/Work，两个 Worker claimed 后 kill。
- 操作：lease expiry 后启动两个 replacements，从 spawn 计时 75s。
- 可观察断言：全部一次性 REFUNDED、无 nonterminal Work/stale commit/partial refund，且满足 README 的 75s 阈值。

### E-07 Operability cleanup and reproducibility — 1
- 前置：E-04～E-06 各 workload 已完成或稳定失败。
- 操作：正常终止每个 evaluator-owned process group，检查端口/managed root/log，并以同 seed 重跑一个非性能 Case。
- 可观察断言：无遗留进程、端口或锁；日志无秘密；同 Submission+seed 的非性能结果与 evidence digest 可复现。

## 11. Hard caps、invalid 与 evaluator_error

| 失败 | 总分上限 |
| --- | ---: |
| clean build/migration/production boot 失败 | 25 |
| Fund Position、唯一终态、atomic rejection 或 Share/Payout 守恒失败 | 35 |
| durable idempotency 在 replay/unknown/restart 后产生第二效果 | 30 |
| success 无 event、rollback 有 event、retry 改 event identity/body | 40 |
| pending Work 丢失或 stale Worker 可提交 | 40 |
| migration 丢历史、改 saved replay 或破坏旧客户端 | 35 |
| 性能后核心不变量失败 | 对应 case 0 并应用 correctness cap |

读取 hidden asset、硬编码 fixture/seed/case identity、访问 workspace 外私有资产、逃逸容器或伪造 evidence 为 `invalid`。Docker/PostgreSQL/Chromium/端口分配等 evaluator 自身故障为 `evaluator_error`，不得记 Candidate 失败。Evaluator watchdog 只保护评测基础设施，不创造产品时限。

## 12. Anti-fake-green

1. Candidate tests 只在 D-07 验证项目 gate 真实性，不作为产品正确性证据；
2. expected totals、state transitions、Share/Payout mapping 由独立 oracle 计算；
3. 不用 Candidate OpenAPI 验 Candidate 自己即结束，另有冻结 contract schema；
4. 不把文件、route 字符串、测试名、日志自述或 exit 0 当行为证据；
5. fault injection 必须命中 barrier，concurrency 必须是独立 OS processes；
6. 每个性能 case 后重新计算全部业务/Work/Event 不变量；
7. Baseline、Native Skills、Guide 使用同一 submission freeze、image、seed、case、权重和阈值。

## 13. 需求映射

| 原 gate | v2 cases |
| --- | --- |
| H-01/H-02 | A-01～A-05、D-01、D-05 |
| H-03/H-04 | A-06～A-12、B-01～B-05 |
| H-05/H-06 | B-06～B-08 |
| H-07/H-08 | C-01～C-08 |
| H-09 | E-01～E-03 |
| H-10/H-11 | A-13～A-15、B-09～B-10、D-04 |
| H-12 | E-04～E-07 |
| H-13 | D-07～D-08 |

### 13.1 Case contract-map 与反馈代码

`V1` 指 `workspace/README.md` 对应标题；`MGR` 指
`orchestration/user-and-manager-prompts.zh-CN.md` 的 `FIXED_MANAGER_MESSAGE`。每个 Case 的私有失败码固定为
`EG_<CASE_ID>_<ASSERTION>`；公开报告只返回下表 category，不泄露 fixture、expected value 或触发顺序。

| Case | 唯一 Public Contract 来源 | public feedback category |
| --- | --- | --- |
| A-01 | V1 `Required non-interactive commands`、`Environment` | `command_boot` |
| A-02 | V1 `db:migrate` repeatability、resource identity | `migration_repeatability` |
| A-03 | V1 `Seed contract` | `seed_atomicity` |
| A-04 | V1 `HTTP and OpenAPI 3.1`、published errors | `http_contract` |
| A-05 | V1 pagination、aggregate detail、verification snapshot | `read_snapshot` |
| A-06 | V1 funded Escrow creation/state invariant | `escrow_creation` |
| A-07 | V1 current Milestone ordering/errors；EG-GAP-01 excludes success submit | `milestone_order` |
| A-08 | V1 acceptance/Release/Fund Position transition | `release_lifecycle` |
| A-09 | V1 dispute `RELEASE` resolution | `dispute_release` |
| A-10 | V1 dispute `REFUND` resolution | `dispute_refund` |
| A-11 | V1 expiry eligibility/deadline policy | `expiry_lifecycle` |
| A-12 | V1 published Domain Event query/types | `domain_events` |
| A-13 | MGR rules 1-2、BeneficiaryShare schema/create body | `beneficiary_capture` |
| A-14 | MGR rules 3-4、BeneficiaryPayout schema and Release ordering | `beneficiary_payout` |
| A-15 | MGR legacy compatibility、FINAL snapshot union | `final_compatibility` |
| B-01 | V1 Fund Position conservation/safe integers | `fund_conservation` |
| B-02 | V1 ordinal/state serialization；EG-GAP-01 excludes submit | `ordinal_concurrency` |
| B-03 | V1 accept-versus-expiry serialization | `terminal_concurrency` |
| B-04 | V1 accept-versus-dispute serialization | `terminal_concurrency` |
| B-05 | V1 dispute/expiry terminal rules | `dispute_concurrency` |
| B-06 | V1/FINAL durable idempotency；EG-GAP-01 excludes submit | `idempotency_replay` |
| B-07 | V1 durable idempotency across API processes | `idempotency_concurrency` |
| B-08 | V1 distinct-key terminal state machine | `terminal_concurrency` |
| B-09 | MGR atomic Share/Payout conservation | `payout_atomicity` |
| B-10 | MGR refund/expiry no-payout rule | `refund_atomicity` |
| C-01 | V1 Work schema/lifecycle/retention | `work_lifecycle` |
| C-02 | V1 `worker.claimed` barrier/reclaim | `worker_recovery` |
| C-03 | V1 `worker.effect-complete` barrier | `worker_recovery` |
| C-04 | V1 `worker.before-commit` barrier | `worker_atomicity` |
| C-05 | V1 Work lease fencing | `worker_fencing` |
| C-06 | V1 terminal winner/obsolete Work convergence | `work_convergence` |
| C-07 | V1 dispatcher unknown-ACK/retry identity | `event_delivery` |
| C-08 | V1 transactional events/per-aggregate order | `event_atomicity` |
| D-01 | V1+MGR OpenAPI and live traffic | `openapi_runtime` |
| D-02 | V1 `Real UI` create/submit/accept；EG-GAP-01 excludes wire assertion | `browser_release` |
| D-03 | V1 `Real UI` dispute/expiry | `browser_dispute` |
| D-04 | MGR real UI beneficiary/payout/refund flow | `browser_beneficiary` |
| D-05 | V1 UI states/accessibility/security | `ui_accessibility` |
| D-06 | V1+MGR detail/snapshot/event cross-layer evidence | `cross_layer_evidence` |
| D-07 | V1 all `test:*` command contracts including `test:perf` | `project_gates` |
| D-08 | V1 project verification/handoff evidence | `evidence_closure` |
| E-01 | MGR migration/backfill and V1 identity preservation | `migration_compatibility` |
| E-02 | V1 saved replay/event identity + MGR byte preservation | `migration_replay` |
| E-03 | V1 pending/leased ESCROW_EXPIRY continuity | `migration_pending_work` |
| E-04 | V1 `escrow-detail-read` | `performance_read` |
| E-05 | V1 `funded-escrow-create` | `performance_create` |
| E-06 | V1 `expiry-recovery` | `performance_recovery` |
| E-07 | V1 command cleanup/log secrecy + v2 reproducibility standard | `operability_cleanup` |

## 14. Calibration mutants

| Mutant | 必须命中 |
| --- | --- |
| process-local idempotency map | B-06、B-07 |
| accept 只改 Milestone 不改 Fund Position | A-08、B-01 |
| expiry 忽略 open Dispute | A-11、B-05 |
| accept 与 expiry 都能提交 | B-03、B-08 |
| event 在业务 transaction 后插入 | A-12、C-08 |
| Work lease 无 fencing | C-02～C-05 |
| webhook retry 生成新 eventId/body | C-07 |
| beneficiary Shares 分批写入 | A-13、B-09 |
| payout 少最后一名 beneficiary | A-14、B-09 |
| refund/expiry 错建 payout | A-10、B-10 |
| migration 不 backfill one-Seller Share | E-01 |
| migration 重写 saved Release replay | E-02 |
| OpenAPI 只列 paths | D-01 |
| UI 固定两个 beneficiaries | D-04 |
| project tests 只检查字符串 | D-07 |
| performance 只报吞吐不验守恒 | E-04～E-06 |

gold 必须通过所有适用 cases；每个 mutant 必须被预期 case 稳定捕获；同 mutant/seed 连跑三次一致后，才冻结 image、fixture、合同、manifest、oracle 和阈值。

## 15. 实施顺序与完成标准

按 vertical slices 实现：

1. A-01/A-03/A-06 打通 command→HTTP→snapshot；
2. B-01/B-06/B-07 打通 oracle、response shield 和多 API；
3. C-02/C-05/C-07 打通 barrier、SIGKILL 与 receiver；
4. A-13/A-14/B-09 打通 FINAL Shares/Payouts；
5. D-01/D-02/D-04 打通独立 OpenAPI validator 与 production Chromium；
6. E-01～E-03 接入真实 V1 checkpoint；
7. 最后实现 E-04～E-07、hard caps、public/private report 与 mutants。

正式 A/B 前必须满足：48 个 case 唯一 ID/权重且总分精确 100；所有 seam 已冻结；三个 contract gap 已解决或明确排除对应未发布 assertion；gold 全过、mutants 被定向捕获、三次 calibration 无功能 flake；任何实验 arm 不改变 evaluator 行为。
