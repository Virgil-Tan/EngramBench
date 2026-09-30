# ReconcileHub Hidden Test v2 设计

## 边界与计分

- 权威：`workspace/README.md` → fixed Manager message → `CONTEXT.md`；旧 E2E 只供覆盖映射。
- 22 个 Cases，权重 A/B/C/D/E=30/25/20/15/10，总计 100。`primarySkill` 聚焦 S04、S08、S10、S15；S02、S07、S11、S14 等相关能力只列入 `secondarySkills`。
- install/build/migrate replay/boot/health/OpenAPI parse/Chromium shell 是不计分 preflight。
- 独立 oracle 由 harness 从原始 Statement/Transaction、日期距离、reference、金额守恒和 action ledger 计算；候选 suggestion/snapshot 不是答案来源。

## SPEC-GAP

- `SPEC-GAP-RH-01`：Manager 的 MatchGroup shape 包含 `REJECTED`，但未发布将 group 变为 REJECTED 的接口/触发器；不设计该转移 Case，也不从 V1 reject 路径推断。
- `SPEC-GAP-RH-02`：Manager 未字面发布 group 专属 event type；不得要求自造类型。
- 无 blocked Case。

## Worked example

StatementLine `100 USD, 2026-01-10, ref=ABC` 对三个可用 Transaction：同额同日同 ref（score 1050）、同额前一日同 ref（950）、同额同日不同 ref（1000）。oracle 先按发布 score，再按发布 tie-break 选 1050；一旦确认，该 line 与 transaction 都不可进入另一 match/group。若构造两条 lines 合计 150 与两笔 transactions 合计 150，则 Manager group 可原子确认；任一 currency/总和不等必须整组零写入。

## Scoring Cases

### A-01 StatementBatch 全量原子导入 — 6 分
来源：README「Domain and V1 behavior」「Seed contract」及 import route；Fixture：合法 batch、末成员重复/非法引用/边界整数；动作：公开 batch import/read。
Oracle/Mandatory：合法成员完整精确出现，任一非法成员使 batch/lines/Work/Event 全部不变；禁止副作用：不得部分导入、浮点金额或重排原始 line identity。
归因：dimension: A；primarySkill=S04；feedback=A.import-atomicity；mutant=M01。

### A-02 一对一候选 score 与全序确定性 — 6 分
来源：README「Deterministic policy」；Fixture：日期 ±3 天、exact/different reference、同分 ties；动作：公开 suggestion generation/read。
Oracle/Mandatory：仅等 currency/amount 且窗口内；score=`1000-100*dateDistance+50 exactRef`，Statement 与 candidate 顺序按合同；禁止副作用：不得使用数据库返回顺序、模糊 reference 或超窗候选。
归因：dimension: A；primarySkill=S08；feedback=A.deterministic-match；mutant=M02。

### A-03 confirm/reject/ignore/reverse 的不可变历史 — 6 分
来源：README V1 state/action rules；Fixture：同一 proposal 的各合法/非法转换；动作：公开 review/reverse seams。
Oracle/Mandatory：当前 projection 精确，历史 action append-only，reverse 是新 correction 而非删除旧记录；禁止副作用：terminal action 不得就地覆盖、复用已占成员或改原 Statement/Transaction。
归因：dimension: A；primarySkill=S10；feedback=A.immutable-correction；mutant=M03。

### A-04 MatchGroup 创建的成员、currency、sum 原子合同 — 6 分
来源：Manager 规则与 exact schemas/routes；Fixture：1..20 each side、重复成员、currency/sum 相等与差一单位；动作：公开 group create/read。
Oracle/Mandatory：成员互异可用、单 currency、两侧整数总和严格相等，合法 group 精确冻结；禁止副作用：非法 group 不得占用任何成员或创建半组/事件。
归因：dimension: A；primarySkill=S04；feedback=A.group-conservation；mutant=M04。

### A-05 Group suggestion 在 1:1 后且总成员最多四个 — 6 分
来源：Manager suggestion rule；Fixture：同时存在强 1:1、2:1、1:2、2:2 及 5-member 组合；动作：驱动 suggestion Work/read。
Oracle/Mandatory：先完成发布的一对一选择，再从剩余成员确定性产生 group suggestions，group 总成员 `<=4`；禁止副作用：不得抢占更优 1:1、重复成员或输出超限组合。
归因：dimension: A；primarySkill=S08；feedback=A.group-suggestion；mutant=M05。

### B-01 Batch import durable idempotency 与 response loss — 5 分
来源：README「Durable idempotency」；Fixture：same key、semantic conflict、20 路 concurrent、shield/restart；动作：跨 API import/replay。
Oracle/Mandatory：原 status/body/IDs 精确重放且一个 batch effect；禁止副作用：key conflict 不得留下 batch/line/Work/Event。
归因：dimension: B；primarySkill=S04；feedback=B.idempotency；mutant=M06。

### B-02 一对一成员全局独占的并发确认 — 5 分
来源：README one-to-one invariant；Fixture：两个 proposals 共享 line 或 transaction；动作：双 API 并发 confirm。
Oracle/Mandatory：最多一个确认成功，输家为发布冲突，最终每边至多一 match；禁止副作用：不得两个 projection 都 MATCHED 或遗留孤立 action。
归因：dimension: B；primarySkill=S04；feedback=B.uniqueness；mutant=M07。

### B-03 confirm/reject/ignore/reverse 竞争单一可解释历史 — 5 分
来源：README review state machine；Fixture：同 proposal 多 action barrier；动作：20 路不同 mutation。
Oracle/Mandatory：历史可按提交线性化，每步只允许发布 transition，current projection 等于折叠结果；禁止副作用：不得丢 action、状态倒退或重复释放成员。
归因：dimension: B；primarySkill=S10；feedback=B.action-race；mutant=M03。

### B-04 MatchGroup 与 V1 match 竞争成员所有权 — 5 分
来源：Manager group 规则 + V1 one-to-one；Fixture：group 与 proposal 共享一成员；动作：并发 confirm。
Oracle/Mandatory：只允许其中一个整体占用成功，另一个零变化；禁止副作用：不得让 group 部分成员锁定、同一 line/transaction 双归属或跨 currency。
归因：dimension: B；primarySkill=S04；feedback=B.cross-cardinality-race；mutant=M07。

### B-05 Group confirm/reverse 整组守恒 — 5 分
来源：Manager atomic confirm/reverse；Fixture：20×20 边界组和重复调用；动作：公开 confirm、reverse 并发/重放。
Oracle/Mandatory：所有成员同事务进入/退出 group current projection，reverse append correction，sum/currency 始终可复算；禁止副作用：不得部分释放或删除原 group/history。
归因：dimension: B；primarySkill=S10；feedback=B.group-correction；mutant=M08。

### C-01 Suggestion Work lease reclaim/stale fence — 5 分
来源：README Workers/recovery/barrier；Fixture：可控 claim/effect/before-commit、短 lease、两 worker；动作：SIGKILL/reclaim。
Oracle/Mandatory：相同输入最终 suggestion set/digest 一致，旧 token 不可 commit、Work 可排空；禁止副作用：不得重复 proposals、永久 lease 或持事务等待 barrier。
归因：dimension: C；primarySkill=S08；secondarySkills=S07；feedback=C.worker-recovery；mutant=M09。

### C-02 Batch import unknown response 的完整恢复 — 5 分
来源：README atomic import/idempotency recovery；Fixture：upstream 完整 response 后 client disconnect 与 API kill；动作：restart/replay。
Oracle/Mandatory：要么完整原结果可重放，要么零导入；禁止副作用：不得出现只有部分 lines、第二 Work 或变化的 saved body。
归因：dimension: C；primarySkill=S04；secondarySkills=S07；feedback=C.atomic-response-loss；mutant=M01。

### C-03 MatchGroup terminal commit crash 保持整组 — 5 分
来源：Manager group atomicity/recovery；Fixture：group confirm/reverse before-commit barrier；动作：worker/API kill 后重试。
Oracle/Mandatory：最终整组 current projection 和 append-only action 一致，成员无遗漏/重复；禁止副作用：不得半组 MATCHED/REVERSED 或丢释放。
归因：dimension: C；primarySkill=S10；secondarySkills=S07；feedback=C.group-recovery；mutant=M08。

### C-04 Reconciliation event unknown ACK — 5 分
来源：README events/dispatcher contract；Fixture：成功/rollback actions、receiver 500/ACK barrier；动作：dispatcher kill/restart。
Oracle/Mandatory：committed action 对应稳定 eventId/body、aggregate sequence 成功交付递增；禁止副作用：rollback 无 event、retry 不换 identity 或重复业务 action。
归因：dimension: C；primarySkill=S10；secondarySkills=S04,S07；feedback=C.outbox-recovery；mutant=M10。

### D-01 V1/Manager wire、errors、cursor 和 deterministic reads — 4 分
来源：README HTTP/OpenAPI + Manager exact shape/routes/errors；Fixture：unknown fields、boundary member count、missing IDs/cursors；动作：仅 HTTP。
Oracle/Mandatory：exact status/body/enums/error envelope/sort，runtime 与发布合同一致；禁止副作用：GET/拒绝不得创建 proposal/group/action/work。
归因：dimension: D；primarySkill=S15；feedback=D.api-contract；mutant=M04。

### D-02 浏览器完成 import→suggest→review→reverse — 4 分
来源：README「Real UI」；Fixture：真实 DB/API/workers、桌面移动 viewport；动作：仅 visible controls。
Oracle/Mandatory：候选 score/reason、history/current state 与独立 oracle/HTTP 一致，refresh、键盘、error/offline 可用；禁止副作用：不得 mock 或隐藏 rejected/ignored history。
归因：dimension: D；primarySkill=S15；secondarySkills=S08；feedback=D.browser-v1；mutant=M02。

### D-03 浏览器完成 MatchGroup 组建、确认与回退 — 4 分
来源：Manager UI 条款；Fixture：worked-example 和不可满足组；动作：visible member selection/create/confirm/reverse。
Oracle/Mandatory：两侧金额/currency/member 状态和 immutable history 可见，失败完整展示且零占用；禁止副作用：不得客户端舍入金额或局部更新 UI。
归因：dimension: D；primarySkill=S15；secondarySkills=S10；feedback=D.browser-manager；mutant=M08。

### D-04 FINAL snapshot 点时投影与历史审计 — 3 分
来源：README V1 snapshot + Manager FINAL resources/Work union；Fixture：各 action/group/work/event 状态；动作：授权 snapshot。
Oracle/Mandatory：exact keys/shapes/sorts、同一 asOf、Work retention/drain、token omission；harness 从 immutable actions 重建 current projection；禁止副作用：不得多时点拼接或漏 terminal history。
归因：dimension: D；primarySkill=S15；secondarySkills=S08,S10,S11；feedback=D.snapshot-audit；mutant=M10。

### E-01 V1 one-to-one→FINAL MatchGroup 兼容迁移 — 3 分
来源：Manager deterministic migration（1:1 match group id=原 match id）；Fixture：V1 confirmed/reversed/ignored history、pending Work/events/replay；动作：升级恢复重放。
Oracle/Mandatory：published 1:1 映射 identity 精确、原 history/event/replay 不改，pending 正常收敛；禁止副作用：不得重新建议、重编号或制造 migration event。
归因：dimension: E；primarySkill=S10；secondarySkills=S02,S08；feedback=E.compatibility；mutant=M06。

### E-02 `statement-batch-import` 固定负载 — 3 分
来源：README 同名 Scenario；Fixture/动作：精确每 batch 100 行、公开 concurrency/60 秒 HTTP import。
Oracle/Mandatory：`>=50 batches/s`、p95 `<=500ms`、5xx=0，负载后每 batch 全或无；禁止副作用：不得缩 batch、只数 request 不数完整 import。
归因：dimension: E；primarySkill=S04；secondarySkills=S14；feedback=E.import-performance；mutant=M01。

### E-03 `reconciliation-review` 固定审阅负载 — 2 分
来源：README 同名 Scenario；Fixture/动作：按公开 selector 执行 250 reviews/s。
Oracle/Mandatory：p95 `<=180ms`、unexpected 5xx=0，成员独占与 immutable correction 均成立；禁止副作用：expected conflicts 不得伪装成功或跳 post-load audit。
归因：dimension: E；primarySkill=S10；secondarySkills=S04,S14；feedback=E.review-performance；mutant=M07。

### E-04 `suggestion-generation` 确定性排空 — 2 分
来源：README 同名 Scenario；Fixture：10,000 lines+10,000 transactions，目标 10,000 proposals；动作：规定 workers/timer。
Oracle/Mandatory：`<=60s` 且 proposal set/order/score 等于独立 oracle、backlog drain；禁止副作用：不得采样、近似匹配或跳确定性比较。
归因：dimension: E；primarySkill=S08；secondarySkills=S14；feedback=E.projection-performance；mutant=M05。

## Mutants

| Mutant | 领域缺陷 | 必杀 Case |
|---|---|---|
| M01 | batch 循环逐行 commit，末行失败留部分数据 | A-01、C-02、E-02 |
| M02 | candidate 用查询顺序/错误 score 或窗口 | A-02、D-02 |
| M03 | reject/reverse 就地覆盖旧 action | A-03、B-03 |
| M04 | group 只验总额，不验 currency/重复/全原子 | A-04、D-01 |
| M05 | group suggestions 抢 1:1 或允许 >4 members | A-05、E-04 |
| M06 | 幂等/迁移重写 saved response/identity | B-01、E-01 |
| M07 | 成员唯一性仅进程内，竞争可双确认 | B-02、B-04、E-03 |
| M08 | group confirm/reverse 逐成员提交 | B-05、C-03、D-03 |
| M09 | expired suggestion worker 仍可 commit | C-01 |
| M10 | outbox 非原子或 snapshot 丢 immutable action | C-04、D-04 |

## Coverage mapping

**README / Manager → Case**

| README/Manager requirement | Cases |
|---|---|
| Atomic import、1:1 deterministic candidates | A-01..A-03、B-01..B-03 |
| Worker/event/recovery | C-01..C-04 |
| MatchGroup/suggestions/atomic corrections | A-04..A-05、B-04..B-05、C-03、D-03 |
| HTTP/UI/snapshot | D-01..D-04 |
| Migration/performance | E-01..E-04 |

**旧 H → Case**

| 旧 H family | v2 Cases |
|---|---|
| H-01 | 不计分 preflight |
| H-02..H-04 | A-01..A-03、D-01..D-02 |
| H-05..H-08 | B-01..B-03、C-01..C-02、C-04 |
| H-09 | E-01 |
| H-10..H-11 | A-04..A-05、B-04..B-05、C-03、D-03..D-04 |
| H-12 | E-02..E-04 |
| H-13 | D/项目证据，不另计分 |

## Evidence/hard caps

保存 fixture、HTTP、barrier/receiver ledger、独立 candidate/group oracle、immutable action projection diff、snapshot digest。partial batch/group、成员双归属或金额/currency 守恒失败总分上限 35；幂等第二效果上限 30；stale worker 可提交/Work 丢失上限 40；迁移改写 identity/history/replay 上限 35；性能后不变量失败使对应 E Case 为 0 并应用 correctness cap。
