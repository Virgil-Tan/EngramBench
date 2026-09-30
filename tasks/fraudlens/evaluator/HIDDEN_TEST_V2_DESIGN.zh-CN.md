# FraudLens Hidden Test v2（Learning）设计

本方案按 Learning v2 profile 将旧 H-01～H-13 收敛为 22 个领域 Case。安装、构建、空库 migration、
boot、health、Chromium shell 和项目命令真实性均是不计分共享 preflight。

## 1. 权威、公开 seam 与 SPEC-GAP

权威为 workspace/README.md、orchestration/manager-prompt.zh-CN.md 与 CONTEXT.md。只允许公开 HTTP、
production Chromium、verification snapshot、事件 receiver、独立 API/Worker/Dispatcher、进程信号、
V1→FINAL checkpoint 和 README 三个性能 workload；不得读 Candidate 私有表、源码或内部 rule evaluator。

- FL-GAP-01：RemediationRun 冻结“全部 Assessment”，但 AssessmentCorrection.oldDecision 只能是
  APPROVE|BLOCK；尚未人工决策的 REVIEW Assessment 没有该值。A-05/B-05 只使用已有最终 decision 的
  fixture；包含未决 Review 的补救分支 blockedBy: FL-GAP-01。
- FL-GAP-02：AssessmentCorrection.reason 未定义生成规则、长度或内容。测试仅断言它是稳定 string，
  same Run+Assessment replay 不变，不制造 reason 文本 oracle。
- FL-GAP-03：Manager 没有发布 Remediation 资源在 verification snapshot 中的 exact key 和 sort tuple。
  D-03 对 V1 snapshot exact 计分，对 remediationRuns/assessmentCorrections 的 exact snapshot member
  blockedBy: FL-GAP-03；公开 GET 仍可完整验证。
- FL-GAP-04：README 只说 TEST_BARRIER_URL/TOKEN 有 conventional meanings 且 recovery uses a
  barrier，未发布 barrier protocol 或 claimed/effect-complete/before-commit checkpoint。计分恢复测试
  只轮询公开 snapshot 至目标 Work=LEASED 后 SIGKILL；精确内部阶段及释放过期旧 owner 的子断言
  blockedBy: FL-GAP-04。

除 E-01 外 Case 完全隔离；并发和 rollback boundary 使用三个固定交错 seed，不以 sleep 猜 commit。

## 2. 独立 oracle、fixtures 与 worked example

Evaluator 自己解释有限 EQ/IN/GTE/LTE 规则，按 priority、ruleId 排序，逐步 safe-integer 求和并 clamp
到 0..1000，独立重算 recommendation、RuleHit、audit digest chain 与 remediation 新结果。Fixture：
F-RULE（边界/负分/同 priority）、F-EVENT（tenant/external identity/version boundary）、F-REVIEW
（lease/expiry/opposite decisions）、F-ROLLBACK、F-REMEDIATION、F-RECOVERY、F-V1-FINAL 和三个公开
性能 dataset。

**Worked example FL-W1**：规则依次为 (priority 1, b, +900)、(priority 1, a, +300)、
(priority 2, c, −400)，三条均命中时 RuleHit 顺序为 a、b、c，sum=800，不能在中途先 clamp
1200→1000 再减成 600；reviewThreshold=700、blockThreshold=900，因此 recommendation=REVIEW。
rollback 后 remediation 用恢复版本独立重算，但原 Assessment/RuleHits/decision/audit bytes 必须不变。

## 3. 评分

| Family | Cases | 分值 |
| --- | ---: | ---: |
| A 领域合同与主流程 | 5 | 30 |
| B 不变量、幂等与并发 | 5 | 25 |
| C Work、恢复与 Event/Audit | 4 | 20 |
| D UI/OpenAPI/snapshot 闭环 | 4 | 15 |
| E 兼容与合同负载 | 4 | 10 |
| **总计** | **22** | **100** |

每个 Case 内 mandatory assertions 全通过才得分；blocked 分支不执行、不重归一化。

## 4. A — 领域合同与主流程

### A-01 RuleVersion 激活、不可变规则与确定性评分 — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：README “Rules and scoring、RuleVersion states/errors”；F-RULE 与 FL-W1。
- **公开动作 / oracle**：创建/激活版本，提交命中/不命中/负分事件；再尝试修改 activated version，并经 HTTP 读取 Assessment。
- **Mandatory / 禁止副作用**：唯一 ACTIVE、规则 immutability、RuleHit order、final sum/clamp、threshold equality、recommendation/decision exact；坏 rule 或 overflow 整体零 version/event/work/audit。
- **primarySkill**：S08 deterministic-projection-and-reconciliation；**feedback**：rules.scoring；**mutant**：M-FL-01。

### A-02 RiskEvent 接受、tenant external identity 与版本冻结 — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：README scoring 4–5、RiskEvent exact shape；F-EVENT。
- **公开动作 / oracle**：在 activation 前后提交相同/不同 externalEventId payload，并在另一 tenant 重用 ID；排空 Assessment。
- **Mandatory / 禁止副作用**：接受 transaction 同时冻结 RuleVersion/RiskEvent/Assessment/Work/Event；相同 canonical payload 返回同 identity，不同 payload稳定 conflict，跨 tenant 独立；后续 activation 不改历史。
- **primarySkill**：S04 database-owned-atomic-idempotency；**feedback**：risk.identity-freeze；**mutant**：M-FL-02。

### A-03 Review claim、fenced decision 与 recommendation 保真 — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：README “Review and rollback” 1–3、ReviewCase/Decision wire；F-REVIEW。
- **公开动作 / oracle**：对 REVIEW Assessment claim、renewed claimant/旧 claimant、APPROVE/BLOCK 决策和 expiry 边界发请求。
- **Mandatory / 禁止副作用**：exact one ReviewCase/Decision/terminal state；仅 live fenced owner 可决策；最终 business decision append，recommendation/RuleHits 不重写，loser 无 Audit/Event。
- **primarySkill**：S07 durable-work-fenced-recovery；**feedback**：review.fenced-decision；**mutant**：M-FL-03。

### A-04 Rule rollback 的历史不变与提交边界 — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：README rollback rules/errors；F-ROLLBACK 含较早/异 RuleSet/current version。
- **公开动作 / oracle**：合法 rollback、same key replay、非法 target；在提交前后接受事件并读取 Assessment/Audit。
- **Mandatory / 禁止副作用**：from 必须当前 ACTIVE、to 必须同 RuleSet earlier；RuleRollback+active switch+Event+Audit 原子；边界前事件保留 from、边界后使用 to，旧 score/hits/decision 不变。
- **primarySkill**：S10 immutable-ledger-correction；**feedback**：rollback.immutable-boundary；**mutant**：M-FL-04。

### A-05 Remediation 冻结集合、重算与 append-only Correction — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：Manager 冻结规则、resources/routes/counts；F-REMEDIATION 仅含 final APPROVE/BLOCK。
- **公开动作 / oracle**：rollback 后按闭区间创建 Run；随后新增/改变区间内外事件并排空 REMEDIATION_RECHECK，GET run/detail。
- **Mandatory / 禁止副作用**：tenant/from/to/range/Assessment IDs 创建时冻结；每项 exact one CORRECTED/NO_CHANGE，counts 守恒，完成条件精确；原 RiskEvent/Assessment/Hit/Review/Audit bytewise 不变。未决 REVIEW blockedBy: FL-GAP-01，reason 内容按 FL-GAP-02 不猜。
- **primarySkill**：S10 immutable-ledger-correction；**feedback**：remediation.append-only；**mutant**：M-FL-05。

## 5. B — 不变量、幂等与并发

### B-01 评分算术、RuleHit 顺序与独立 reference model — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：README rules 2–3、SCORE_OVERFLOW；随机但保存 seed 的 F-RULE。
- **公开动作 / oracle**：生成边界 scalar/array attributes 和规则组合，经 HTTP 评分并与 evaluator 逐规则 reference model 对比。
- **Mandatory / 禁止副作用**：只读 published fields、无代码/网络；hit order、每 hit score/reason、最终 clamp精确；overflow 失败不产生 Assessment side effects，不能复用 Candidate 结果作 oracle。
- **primarySkill**：S08 deterministic-projection-and-reconciliation；**feedback**：scoring.reference-model；**mutant**：M-FL-01。

### B-02 Idempotency-Key 与 externalEventId 双 identity 优先级 — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：README Reliability 与 external dedupe；两个 API、response shield、四象限 key/event identity。
- **公开动作 / oracle**：same key/body、same key/different body、new key/same external+same payload、new key/same external+different payload，含 unknown response/restart。
- **Mandatory / 禁止副作用**：先由 request replay scope 恢复原 response，再由 tenant external identity dedupe；对应稳定 conflict 不互相吞掉；任一组合最多一 RiskEvent/Assessment/Work/Event/Audit。
- **primarySkill**：S04 database-owned-atomic-idempotency；**secondarySkills**：S05；**feedback**：risk.identity-precedence；**mutant**：M-FL-06。

### B-03 Event acceptance 与 activation/rollback 串行化竞争 — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：README scoring 4、rollback 5；两个 API/两个 workers。
- **公开动作 / oracle**：固定三交错并发 accept、activate newer、rollback prior；以公开 committed response/audit sequence 建立合法总序。
- **Mandatory / 禁止副作用**：每 Assessment 恰冻结某一提交边界 ACTIVE version且完整按其评分；tenant 始终一 ACTIVE；无 mixed RuleHits、无重新投影历史、无丢 Event/Audit。
- **primarySkill**：S08 deterministic-projection-and-reconciliation；**feedback**：rules.activation-race；**mutant**：M-FL-07。

### B-04 Hot Review claim、opposite decision 与 expiry race — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：README Review lease/terminal；同一 ReviewCase 64 路竞争。
- **公开动作 / oracle**：两个 API claim、两个 reviewer 相反 decision、REVIEW_EXPIRY worker 在 lease 边界交错。
- **Mandatory / 禁止副作用**：数据库时间/live fence 决定唯一 terminal；最多一 ReviewDecision/decision Event/Audit，losers 返回已发布 error；跨 tenant claimant 不可观察/更改状态。
- **primarySkill**：S07 durable-work-fenced-recovery；**feedback**：review.terminal-race；**mutant**：M-FL-03。

### B-05 Remediation 并发创建、cancel fence 与 count closure — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：Manager idempotency/cancel/terminal/count invariant；20 assessments、32-way replay。
- **公开动作 / oracle**：并发创建 Run；从公开 GET 观察到部分 correction 已提交后，让 cancel 与剩余 Work 竞争，再排空。
- **Mandatory / 禁止副作用**：唯一 frozen Run/cohort；每 Run+Assessment最多一 correction；COMPLETED 或 CANCELLED 恰一，cancel 后未开始项永不处理，已提交项保留，四 count 一致。未决 Review blockedBy: FL-GAP-01。
- **primarySkill**：S10 immutable-ledger-correction；**feedback**：remediation.cancel-closure；**mutant**：M-FL-08。

## 6. C — Work、恢复与 Event/Audit

### C-01 RISK_ASSESSMENT 在公开 LEASED 后崩溃恢复 — 5 分
- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture**：README Work exact shape、lease/fenced commit；F-RECOVERY。
- **公开动作 / oracle**：单独启动worker，轮询snapshot至目标 RISK_ASSESSMENT Work=LEASED后SIGKILL，lease后replacement排空。
- **Mandatory / 禁止副作用**：同一 frozen version 重算，Work terminal一次；Assessment/Hit/Decision/Event/Audit 各一次且 reference score精确。effect-complete/before-commit与旧owner释放子断言 blockedBy: FL-GAP-04。
- **primarySkill**：S07 durable-work-fenced-recovery；**feedback**：assessment.recovery；**mutant**：M-FL-09。

### C-02 REVIEW_EXPIRY 与 live owner 的恢复/fence — 5 分
- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture**：README ReviewCase bounded lease、review expiry Work；F-REVIEW。
- **公开动作 / oracle**：轮询snapshot至目标 REVIEW_EXPIRY Work=LEASED后SIGKILL；lease后replacement与仍持live review lease的decision并发。
- **Mandatory / 禁止副作用**：数据库 lease时点决定 EXPIRED 或 decision terminal；旧 worker/reviewer不能提交，终态/Decision/Audit/Event 恰一，无 ReviewCase 复活。
- **primarySkill**：S07 durable-work-fenced-recovery；**feedback**：review.expiry-recovery；**mutant**：M-FL-09。

### C-03 REMEDIATION_RECHECK 在公开 LEASED 后 cancel 恢复 — 5 分
- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture**：Manager Worker SIGKILL/old lease/cancel fence；F-REMEDIATION。
- **公开动作 / oracle**：轮询FINAL snapshot至目标 REMEDIATION_RECHECK Work=LEASED后SIGKILL，期间cancel，lease后replacement处理frozen items。
- **Mandatory / 禁止副作用**：稳定 correction identity/outcome/digest，replacement越不过cancel fence；已提交保留、未开始取消、counts与terminal精确，原V1事实不改。effect-complete/before-commit与旧owner释放子断言 blockedBy: FL-GAP-04。
- **primarySkill**：S07 durable-work-fenced-recovery；**feedback**：remediation.recovery；**mutant**：M-FL-08。

### C-04 Event unknown ACK 与 tenant Audit digest chain — 5 分
- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture**：README event types、audit ordering、at-least-once dispatch；多 tenant mutations。
- **公开动作 / oracle**：receiver 500/断线；另一次收完并保存body后暂不响应，Evaluator SIGKILL已知dispatcher进程。重启后分页读取audit，独立按canonical payload重算priorDigest/digest。
- **Mandatory / 禁止副作用**：business/Work/Event/Audit同事务；rollback无残留；event retry保持 ID/body/order；每 tenant audit sequence连续且 digest闭合，无跨 tenant链接或 secret。
- **primarySkill**：S10 immutable-ledger-correction；**secondarySkills**：S07；**feedback**：audit.event-chain；**mutant**：M-FL-10。

## 7. D — UI、OpenAPI、snapshot 闭环

### D-01 浏览器完成 rule→event→explanation→review→rollback — 4 分
- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture**：README Required UI/Chromium flow；F-RULE/F-REVIEW/F-ROLLBACK。
- **公开动作 / oracle**：production Chromium 仅用可见控件激活 version、提交 REVIEW event、检查 RuleHits、claim/decide、rollback并 refresh。
- **Mandatory / 禁止副作用**：loading/empty/error、stable code、tenant context、键盘/移动可用；页面 score/hits/version/decision 与 HTTP exact，一切操作走公开 API。
- **primarySkill**：S08 deterministic-projection-and-reconciliation；**secondarySkills**：S15；**feedback**：ui.explainable-review；**mutant**：M-FL-07。

### D-02 浏览器创建、观察、取消 Remediation 并看差异 — 4 分
- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture**：Manager UI 创建/进度/差异/取消/明细；F-REMEDIATION。
- **公开动作 / oracle**：页面创建闭区间 Run，观察 running counts和每 correction old/new/digest，取消另一 Run并 refresh。
- **Mandatory / 禁止副作用**：UI只显示冻结集合，counts/terminal与GET一致；NO_CHANGE/CORRECTED可区分，取消不伪造回滚已提交 correction，原 Assessment explanation不变。
- **primarySkill**：S10 immutable-ledger-correction；**secondarySkills**：S15；**feedback**：ui.remediation；**mutant**：M-FL-05。

### D-03 OpenAPI、V1 snapshot 与 Remediation 公共形状 — 4 分
- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture**：README HTTP/seed/snapshot、Manager exact routes/resources/errors；全状态 fixture。
- **公开动作 / oracle**：冻结 contract map 校验 OpenAPI；读取 snapshot和 GET remediation detail，独立核对 public identity排序。
- **Mandatory / 禁止副作用**：routes/body/status/errors和V1 exact resources/work/events正确，递归无secret；Manager GET exact wrapper/correction shape。Manager snapshot key/sort断言 blockedBy: FL-GAP-03。
- **primarySkill**：S10 immutable-ledger-correction；**secondarySkills**：S11；**feedback**：contract.remediation-shape；**mutant**：M-FL-05。

### D-04 原 Assessment 到 Correction 的不可变解释链 — 3 分
- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture**：README history immutability/audit与Manager append-only；一条 corrected、一条 no-change。
- **公开动作 / oracle**：保存 rollback前全部公开 bytes/digests，完成 remediation 后跨 Assessment、Audit、GET run、Event重新读取。
- **Mandatory / 禁止副作用**：旧 resource逐字不变；Correction只引用 frozen identity，newRuleHitsDigest由恢复规则独立重算；reason仅检验稳定 string（FL-GAP-02），无 secret/hidden data。
- **primarySkill**：S10 immutable-ledger-correction；**feedback**：history.correction-lineage；**mutant**：M-FL-04。

## 8. E — 兼容与合同负载

### E-01 V1→FINAL 保留评分、复核、replay 与 audit chain — 2.5 分
- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture**：Manager compatible migration；V1 binary创建全状态、pending Work、unacked Event、saved replay。
- **公开动作 / oracle**：同库 FINAL migration，重放旧 requests，完成 pending Assessment/Review，逐项重算 score与audit digest。
- **Mandatory / 禁止副作用**：V1 identities/body/hits/decisions/replay/work/event/audit均不变，新资源初始空；migration不重新评分或自动创建 remediation。
- **primarySkill**：S10 immutable-ledger-correction；**secondarySkills**：S02；**feedback**：migration.audit-compat；**mutant**：M-FL-04。

### E-02 十万 RiskEvent ingest 与版本冻结负载 — 2.5 分
- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture**：README risk-event-ingest exact scale/concurrency/threshold。
- **公开动作 / oracle**：100000 unique、concurrency96，完整计时；流后抽样及aggregate独立重算全部 score/version refs。
- **Mandatory / 禁止副作用**：≥300 accepted/s、p95≤300ms、5xx=0；无重复/错 version/断 audit/event/work backlog。
- **primarySkill**：S08 deterministic-projection-and-reconciliation；**secondarySkills**：S14；**feedback**：perf.risk-ingest；**mutant**：M-FL-01。

### E-03 Hot-subject Review 持续 terminal throughput — 2.5 分
- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture**：README hot-subject-review exact 20k/100 subjects/concurrency64。
- **公开动作 / oracle**：按公开 workload claim/decide，逐 case 记录 lease owner与 terminal identity 后统计。
- **Mandatory / 禁止副作用**：≥180 terminal decisions/s、p95≤700ms；duplicate decision、cross-tenant state、stale owner commit、5xx均为零。
- **primarySkill**：S07 durable-work-fenced-recovery；**secondarySkills**：S14；**feedback**：perf.hot-review；**mutant**：M-FL-03。

### E-04 Rollback boundary 后一万 Assessment 恢复 — 2.5 分
- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture**：README rollback-boundary-recovery exact kill/replacement/90s。
- **公开动作 / oracle**：10k事件跨一个rollback commit；从snapshot确认两个worker各持目标Work=LEASED后SIGKILL，四replacements排空并重算每项。
- **Mandatory / 禁止副作用**：≤90秒；每 Assessment冻结正确 version，score/hits exact，Work terminal，Audit/Event连续；历史改写、stale commit、5xx为零。
- **primarySkill**：S08 deterministic-projection-and-reconciliation；**secondarySkills**：S14；**feedback**：perf.rollback-boundary；**mutant**：M-FL-09。

## 9. Mutant calibration（10 个）

| Mutant | 单一故障 | 主击杀 Case |
| --- | --- | --- |
| M-FL-01 | hit顺序错误或逐步 clamp | A-01、B-01、E-02 |
| M-FL-02 | worker读取处理时 ACTIVE version | A-02 |
| M-FL-03 | Review decision不校验 live fence | A-03、B-04、E-03 |
| M-FL-04 | rollback/remediation直接改历史 Assessment/Audit | A-04、D-04、E-01 |
| M-FL-05 | remediation只写 CORRECTED、漏 NO_CHANGE | A-05、D-02、D-03 |
| M-FL-06 | request key与external ID错误合并/分事务 | B-02 |
| M-FL-07 | activate/rollback与accept非原子 | B-03、D-01 |
| M-FL-08 | cancel后stale remediation worker仍提交 | B-05、C-03 |
| M-FL-09 | Work lease无完成 fence | C-01、C-02、E-04 |
| M-FL-10 | Event/Audit在业务transaction外 | C-04 |

Gold 与各 mutant 同 seed 至少三次稳定；blocked 分支不计入 mutant 必杀集合。

## 10. README→Case 与旧 H→Case

| Requirement | Case |
| --- | --- |
| RuleVersion/scoring/frozen Assessment | A-01、A-02、B-01、B-03 |
| externalEvent/idempotency | A-02、B-02 |
| Review lease/decision/expiry | A-03、B-04、C-02 |
| rollback/history/audit | A-04、C-04、D-04 |
| RemediationRun/Correction/cancel | A-05、B-05、C-03、D-02 |
| worker/outbox recovery | C-01～C-04 |
| UI/OpenAPI/snapshot | D-01～D-04 |
| compatibility | E-01 |
| published performance | E-02～E-04 |

| 旧 H | 新 Case |
| --- | --- |
| H-01 | 不计分 preflight；migration行为归E-01 |
| H-02 | D-01、D-03 |
| H-03 | A-01、A-02、B-01 |
| H-04 | B-01、B-02 |
| H-05 | B-02 |
| H-06 | B-03、B-04 |
| H-07 | C-01、C-02 |
| H-08 | C-04 |
| H-09 | E-01 |
| H-10 | A-05、D-02、D-04 |
| H-11 | B-05、C-03 |
| H-12 | E-02～E-04 |
| H-13 | 不单列计分，证据用于定位对应 Case |

统一 Hard Caps 外：改写历史 Assessment/RuleHit/Decision/Audit、同 Review 或 correction 双终态、
跨 tenant 暴露均使 correctness 总分上限 30；凭据泄漏或探测 hidden fixture 为 invalid。
