# ModerationFlow Hidden Test v2 设计

## 计分边界

- 权威顺序：`workspace/README.md` → `orchestration/manager-prompt.zh-CN.md` → `CONTEXT.md`；旧 `E2E_TEST_PLAN.zh-CN.md` 仅用于覆盖映射。
- 22 个领域 Case，A/B/C/D/E 分别为 30/25/20/15/10，总分 100。`primarySkill` 聚焦 S06、S07、S14、S15；其他相关能力只列入 `secondarySkills`。S03/S16 只可作为 evaluator observer，不进入 Case 主归因。
- clean install、migration replay、build、boot/health、OpenAPI 可解析、Chromium 壳和 evaluator 隔离属于不计分 preflight；失败时阻断运行，不改名计分。
- 独立 oracle 由 harness 根据冻结输入、策略表、证据版本和事件账本计算；候选 snapshot/OpenAPI/日志不能自证正确。

## SPEC-GAP

- `SPEC-GAP-MF-01`：Manager 未发布 Reconsideration 列表顺序；相关断言按 ID 集合比较，不臆造顺序。
- `SPEC-GAP-MF-02`：Manager 未新增 Recall/Reconsideration 事件类型；不得要求未被字面发布的新事件名。
- 未发现阻断下列 22 个 Case 的缺口。

## Worked example

fixture 在闭区间内放入两个使用 recalled PolicyVersion 的终态 Case：一个 replacement `level1Action` 改变，另一个不变；区间外和非终态 Case 作哨兵。调用创建 Recall，独立 oracle 先冻结 `{caseId,finalDecisionId,evidenceHeadVersion}`，排空 `POLICY_RECALL` Work 后应得到一条 CHANGED（且恰好一个 RECONSIDERATION Stage）和一条 NO_CHANGE（无 Stage），计数为 `2=1+1`；任何哨兵、原 Decision/Evidence/Audit 被改写均失败。

## Scoring Cases

### A-01 内容摄入与初始证据冻结 — 6 分
来源：README「Domain model and states」「Policy, evidence, and review rules」；Fixture：随机 tenant、外部内容 ID、首份 evidence；动作：经公开内容创建/读取 seam 重放同语义请求。
Oracle/Mandatory：harness 规范化输入并核对唯一 ContentItem、EvidenceVersion=1 和精确响应；禁止副作用：不得生成第二 Case、跳号证据或泄露跨 tenant 数据。
归因：dimension: A；primarySkill=S06；secondarySkills=S04；feedback=A.contract；mutant=M01。

### A-02 EvidenceVersion 追加连续且不可变 — 6 分
来源：README「Policy, evidence, and review rules」；Fixture：已有三版 evidence 与乱序客户端请求；动作：通过公开追加 seam 创建下一版并读取历史。
Oracle/Mandatory：独立账本断言版本严格 1..N、旧 body/digest 不变、head 精确；禁止副作用：失败请求不得留下 EvidenceVersion、AuditEntry 或缺口。
归因：dimension: A；primarySkill=S06；secondarySkills=S10；feedback=A.invariant；mutant=M02。

### A-03 冻结策略与证据的两级审核 — 6 分
来源：README「Domain model and states」「Policy, evidence, and review rules」；Fixture：PolicyVersion category/action 表、审核期间追加 evidence；动作：公开 claim/decision seam 完成 LEVEL_1/LEVEL_2。
Oracle/Mandatory：按 Stage 捕获的 policy/evidence 计算允许转移和最终 Decision；禁止副作用：后加 evidence 或新 ACTIVE policy 不得倒灌已冻结 Stage，ESCALATE 不得成为终局处置。
归因：dimension: A；primarySkill=S06；feedback=A.state-machine；mutant=M03。

### A-04 Appeal 唯一性、期限与冻结基线 — 6 分
来源：README「Policy, evidence, and review rules」；Fixture：终态 Case、边界时钟 `decisionAt+30d` 两侧及新 evidence；动作：公开 Appeal 创建与裁决。
Oracle/Mandatory：数据库时钟下只允许合同窗口内一次 Appeal，并按捕获 head/Decision 审核；禁止副作用：迟到或第二次 Appeal 不得创建 Stage/Decision/Event。
归因：dimension: A；primarySkill=S06；feedback=A.boundary；mutant=M04。

### A-05 PolicyRecall 冻结成员与兼容预检 — 6 分
来源：Manager 第 1 段及公开 `POST /api/v1/policy-recall-runs`；Fixture：区间内外、终态/非终态、多 category Case 与 replacement；动作：创建 RecallRun。
Oracle/Mandatory：按闭区间和 recalled version 独立选出成员并冻结 finalDecision/evidenceHead；replacement 缺任一 category 时精确 409 `POLICY_RECALL_POLICY_INCOMPATIBLE` 且零 Run/Work；禁止副作用：不得动态扩充 cohort。
归因：dimension: A；primarySkill=S06；secondarySkills=S17；feedback=A.manager-contract；mutant=M05。

### B-01 并发证据追加只产生一个下一版本 — 5 分
来源：README evidence 连续性、幂等与并发规则；Fixture：同一 Case head=N、20 个相同和不同 key 请求；动作：两个 API 并发追加。
Oracle/Mandatory：相同语义汇聚一结果，不同合法追加线性化为无缺口序列；禁止副作用：不得重复 digest、覆盖旧版或出现两个 N+1。
归因：dimension: B；primarySkill=S06；secondarySkills=S04；feedback=B.concurrency；mutant=M02。

### B-02 决策与迟到 evidence 竞争保持 Stage 快照 — 5 分
来源：README 冻结 evidence/policy 规则；Fixture：已租用 Stage 与固定提交次序两侧的新 evidence；动作：并发提交 Decision 与 append。
Oracle/Mandatory：两种合法串行结果均按 Stage 捕获版本裁决且历史完整；禁止副作用：不得把未捕获 evidence 偷换进 Decision 或丢追加。
归因：dimension: B；primarySkill=S06；secondarySkills=S04；feedback=B.linearizability；mutant=M03。

### B-03 Appeal 创建竞争至多一次 — 5 分
来源：README Appeal 规则与 durable idempotency；Fixture：同一合格 Case、20 路不同 key；动作：跨 API 并发创建。
Oracle/Mandatory：恰好一个 Appeal/Stage，输家为发布的稳定冲突，snapshot 与事件一致；禁止副作用：不得有孤立 Work、Stage 或第二现实处置。
归因：dimension: B；primarySkill=S06；secondarySkills=S04；feedback=B.uniqueness；mutant=M04。

### B-04 Recall 创建重放与冻结 cohort 一致 — 5 分
来源：Manager mutation 继承 V1 Idempotency-Key；Fixture：固定请求、response shield、20 路重放并在之后新增合格 Case；动作：跨实例创建/replay。
Oracle/Mandatory：状态码与语义 JSON、Run ID、Work ID、冻结 totalCount 不变；禁止副作用：新增 Case 不得进入既有 Run，key 冲突不得写业务行。
归因：dimension: B；primarySkill=S06；secondarySkills=S04,S17；feedback=B.idempotency；mutant=M01。

### B-05 Reconsideration 分类与计数原子闭合 — 5 分
来源：Manager Worker、资源形状和计数恒等式；Fixture：CHANGED/NO_CHANGE 混合集合；动作：排空公开 Work 后读取 Run。
Oracle/Mandatory：每冻结 Case 恰一 Reconsideration，CHANGED 恰一 Stage、NO_CHANGE 无 Stage，`completed=changed+noChange<=total`；禁止副作用：不得改写原 Case/Decision/Appeal/Evidence/Audit。
归因：dimension: B；primarySkill=S06；secondarySkills=S17；feedback=B.conservation；mutant=M06。

### C-01 ReviewStage 租约过期与 stale-owner fencing — 5 分
来源：README「Audit, idempotency, recovery, and events」及公开 snapshot Work shape；Fixture：短 lease、两个 worker；动作：轮询 snapshot 观察目标 Work 进入 LEASED 后 SIGKILL owner，过期后替代 worker 完成。
Oracle/Mandatory：任务可重领且仅一个终态 Decision，旧 token 提交被拒；禁止副作用：不得永久 LEASED、重复 Decision/Event/Audit。
归因：dimension: C；primarySkill=S07；feedback=C.lease-recovery；mutant=M07。

### C-02 Recall worker 崩溃后逐 Case 恰好一次 — 5 分
来源：Manager 并发创建、Worker SIGKILL 与旧 lease 条款；Fixture：混合 cohort、短 lease；动作：从公开 snapshot 观察各 Recall Work 为 LEASED 后多次 kill/restart。
Oracle/Mandatory：最终每个冻结 Case 恰一结果且计数闭合，已提交项不重做；禁止副作用：不得重复 Reconsideration/Stage 或遗漏可处理成员。
归因：dimension: C；primarySkill=S07；secondarySkills=S17；feedback=C.progress；mutant=M08。

### C-03 Recall 取消与最后提交线性化 — 5 分
来源：Manager 取消 fence 与终态竞争规则；Fixture：剩最后一个成员且其 Work 已由公开 snapshot 观察为 LEASED；动作：并发 cancel 与 owner SIGKILL/replacement commit。
Oracle/Mandatory：Run 只可 COMPLETED 或 CANCELLED，已提交结果保留，CANCELLED 后旧 lease 无新增；禁止副作用：不得双终态或计数回退。
归因：dimension: C；primarySkill=S07；secondarySkills=S04,S17；feedback=C.cancel-fence；mutant=M09。

### C-04 审核事件与 webhook unknown ACK — 5 分
来源：README event/outbox/recovery 规则；Fixture：成功与回滚决策、receiver 500/断连/持久化后暂停 ACK；动作：重启 dispatcher。
Oracle/Mandatory：成功业务有且只有一个稳定 event identity/body，回滚无 event，交付按 aggregate sequence；禁止副作用：重试不得新造 eventId 或越序成功。
归因：dimension: C；primarySkill=S07；feedback=C.outbox；mutant=M10。

### D-01 Moderation wire、错误与历史查询闭合 — 4 分
来源：README「Public HTTP surface」及 Manager 公开资源/错误；Fixture：边界枚举、未知字段、缺失 ID；动作：只走 HTTP。
Oracle/Mandatory：精确 shape、状态、错误 envelope/code、排序和 tenant scope；禁止副作用：读请求与所有拒绝不得改变 Case/Stage/Work/Event。
归因：dimension: D；primarySkill=S15；feedback=D.api-evidence；mutant=M05。

### D-02 浏览器完成 V1 审核主流程 — 4 分
来源：README「Seed, snapshot, UI, and project verification」；Fixture：真实 PostgreSQL/worker 和桌面、移动 viewport；动作：仅可见语义控件完成 ingest→review→decision→appeal。
Oracle/Mandatory：HTTP 观察与独立账本一致，refresh 保留状态，键盘/focus/错误态可用；禁止副作用：不得 mock、直连内部 API 或依赖 devtools。
归因：dimension: D；primarySkill=S15；feedback=D.browser；mutant=M03。

### D-03 浏览器完成 Recall 差异与人工确认 — 4 分
来源：Manager UI 条款；Fixture：worked-example cohort；动作：UI 创建、观察进度/差异、打开 Reconsideration、人工确认并测试取消。
Oracle/Mandatory：可见计数/结果与 GET 一致，CHANGED Stage 只允许 ALLOW/RESTRICT/REMOVE；禁止副作用：UI 不得伪装 ESCALATE 已执行或隐藏 NO_CHANGE。
归因：dimension: D；primarySkill=S15；secondarySkills=S17；feedback=D.manager-ui；mutant=M06。

### D-04 单点快照与 Audit digest chain — 3 分
来源：README snapshot/audit 规则与 Manager 兼容条款；Fixture：跨 aggregate 历史、pending Work、Recall；动作：授权读取 verification snapshot/audit。
Oracle/Mandatory：同一 as-of、规定资源集合/排序/脱敏，harness 逐条重算 digest chain；禁止副作用：不得泄露 token/key/raw body/private path，Recall 不得重写旧 chain。
归因：dimension: D；primarySkill=S15；secondarySkills=S10,S11；feedback=D.auditability；mutant=M10。

### E-01 Populated V1 到 FINAL 的身份与 replay 兼容 — 3 分
来源：Manager FINAL migration 兼容段；Fixture：V1 terminal/pending Work、events、audit、saved replay；动作：升级后恢复并重放旧请求。
Oracle/Mandatory：V1 identity/body/sequence/audit digest 和 saved status/body 不变，pending 正常完成或按旧规则终止；禁止副作用：不得重编号或补写历史。
归因：dimension: E；primarySkill=S07；secondarySkills=S02,S05；feedback=E.compatibility；mutant=M05。

### E-02 `moderation-ingest` 持续负载与不变量 — 3 分
来源：README 固定 performance contract；Fixture：公开规定的 50,000 请求、96 并发和 seed；动作：仅测公开 ingest seam。
Oracle/Mandatory：达到 `>=250/s`、p95 `<=350ms`、unexpected 5xx=0，负载后重算证据连续性/幂等；禁止副作用：不得缩小 dataset、混入 warm-up 或只报吞吐。
归因：dimension: E；primarySkill=S14；secondarySkills=S04,S06；feedback=E.performance；mutant=M02。

### E-03 `evidence-appeal-contention` 热点竞争 — 2 分
来源：README 固定 performance contract；Fixture：20,000 操作、64 并发热点 Case；动作：按公开 selector 执行 evidence/appeal 竞争。
Oracle/Mandatory：`>=150 terminal/s`、p95 `<=800ms` 且 Appeal 唯一、Stage 快照正确；禁止副作用：预期冲突不得算 5xx，不得跳过终态核验。
归因：dimension: E；primarySkill=S14；secondarySkills=S04,S06；feedback=E.contention；mutant=M04。

### E-04 `policy-boundary-recovery` Recall 边界恢复 — 2 分
来源：README 固定 performance contract；Fixture：10,000 成员、kill 2 workers、4 replacements；动作：公开 snapshot 观察两个目标 Work 为 LEASED 后杀 owner并排空。
Oracle/Mandatory：合同窗口 `<=90s` 内闭合、无重复/遗漏、计数正确；禁止副作用：不得用 sleep 推断边界或绕过生产 worker。
归因：dimension: E；primarySkill=S14；secondarySkills=S07,S17；feedback=E.recovery-load；mutant=M08。

## Task-specific mutants

| Mutant | 缺陷 | 必杀 Case |
|---|---|---|
| M01 | 进程内幂等，response loss 后重复创建 | B-04 |
| M02 | evidence head 读后写，产生两个 N+1/缺口 | A-02、B-01 |
| M03 | Decision 使用提交时最新 evidence/policy | A-03、B-02 |
| M04 | Appeal 期限用客户端时钟且无唯一 fence | A-04、B-03 |
| M05 | Recall 在 worker 时动态扫描 cohort | A-05、B-04 |
| M06 | NO_CHANGE 也建 Stage，或改写原 Decision | B-05、D-03 |
| M07 | lease 过期后旧审核 worker 仍可提交 | C-01 |
| M08 | Recall crash 后重复/漏 Reconsideration | C-02、E-04 |
| M09 | cancel 不 fence 已 claim Recall Work | C-03 |
| M10 | event 与业务分事务或 ACK 重试换 identity | C-04、D-04 |

## Coverage mapping

**README / Manager → Case**

| README/Manager requirement | Cases |
|---|---|
| Content、Evidence、Policy、Stage、Decision、Appeal | A-01..A-04、B-01..B-03、C-01 |
| 幂等、audit、event、worker recovery | B-04、C-01..C-04、D-04 |
| Public HTTP、snapshot、真实 UI | D-01..D-04 |
| PolicyRecallRun/Reconsideration 增量 | A-05、B-04..B-05、C-02..C-03、D-03、E-01 |
| 固定性能合同 | E-02..E-04 |

**旧 H → Case**

| 旧 E2E H family | v2 Cases |
|---|---|
| H-01 | 不计分 preflight |
| H-02..H-04 | A-01..A-04、D-01..D-02 |
| H-05..H-08 | B-01..B-04、C-01、C-04 |
| H-09 | E-01 |
| H-10..H-11 | A-05、B-05、C-02..C-03、D-03 |
| H-12 | E-02..E-04 |
| H-13 | D-01..D-04 的项目证据，不另计分 |

## Evidence 与 hard caps

每 Case 保存 fixture seed、公开请求/响应、snapshot/进程信号 transcript、receiver ledger、独立 oracle diff 与 snapshot digest；同一 requirement 只由上述 primary Case 计分。原子拒绝、唯一终态或 evidence 连续性失败总分上限 35；持久幂等产生第二业务效果上限 30；stale worker 可提交或合法 Work 丢失上限 40；迁移改写 V1 identity/replay/audit 上限 35；性能后核心不变量失败则该性能 Case 为 0 并应用 correctness cap。

## 非计分 trajectory observer

S03 仅由独立 observer 记录对公开 requirement ledger 的覆盖/回补轨迹，S16 仅记录长流程中的 bounded progress/recovery 轨迹；二者不读取私有 Case、不影响上述 100 分，也不作为任何 Case 的 `primarySkill`。
