# RuleBench Hidden Test v2 设计

## 边界与权重

- 权威：`workspace/README.md`、`orchestration/manager-prompt.zh-CN.md`、`CONTEXT.md`；旧 E2E 仅作覆盖映射。
- 22 Cases，A/B/C/D/E=30/25/20/15/10，总计 100。核心 primarySkill 聚焦 S04、S07、S08、S13；冻结、账本式不可变、迁移、snapshot、性能与跨层能力只作对应 Case 的 secondarySkills；S03/S16 仅 observer。
- install/build/migrate replay/boot/health/OpenAPI parse/Chromium shell 不计分；oracle 是 evaluator 自己的受限解释器、canonical JSON/digest 和 immutable result ledger，绝不执行候选代码或信任候选 explanationDigest。

## SPEC-GAP

- `SPEC-GAP-RB-01`：Manager 的 ComparisonRun timestamp/nullability 写法未逐字段展开；只断言已发布状态对应的语义 nullability，不臆造额外格式。
- `SPEC-GAP-RB-02`：ERROR 明确无 waiver API；任何候选“已解释/忽略 ERROR”行为均属越权，不是缺口补全。
- `SPEC-GAP-RB-03`：README 要求 Dispatcher at-least-once，但没有发布 receiver URL/协议或 dispatcher response barrier。C-04 的 unknown-ACK delivery 子断言 `blockedBy` 此缺口；补 seam 前只计公开 snapshot 可观察的 Event 原子持久化、identity/body/sequence 与进程重启不改写。
- 无整 Case blocked；仅 C-04 的 delivery 子断言 blocked，且不转移权重。

## Worked example

Rule 依 `(priority,ruleId)` 为：R1 nonterminal 命中并产 tags `[a,b]`、decision REVIEW；R2 terminal 命中并置 DENY；R3 不得求值。oracle 左到右求 expression leaf、为 R3 生成一个 `SKIPPED` node，`matchedRuleIds=[R1,R2]`，tags 按首产生规则去重，decision=DENY，再以公开 canonical 规则算 explanationDigest。改变输入 object key insertion order不得改变结果。

## Scoring Cases

### A-01 Expression dialect、深度、规模与 safe-integer gate — 6 分
来源：README「Rule language and deterministic semantics」；Fixture：exact 20/21 depth、1/100/101 children、5,000/5,001 Rules、256KiB 边界、float/unsafe int/unknown op；动作：公开 version validate/publish/evaluate。
Oracle/Mandatory：受限 grammar/size/type 精确接受拒绝并返回发布 code；禁止副作用：非法表达式不得出版 Version、创建 Evaluation/Work/Event 或被当 JS 执行。
归因：dimension=A；primarySkill=S13；feedback=A.language-boundary；mutant=M01。

### A-02 Missing/null、比较与 `in` 无 coercion 语义 — 6 分
来源：README expression semantics；Fixture：missing、null、string/boolean/safe-int、array 与 path 边界；动作：公开 Evaluation。
Oracle/Mandatory：独立 interpreter 对 eq/neq/lt/lte/gt/gte/in/exists 逐型比较，无转换，ordering 仅 safe integer；禁止副作用：非法 operand 必须稳定失败且不产生伪 decision。
归因：dimension=A；primarySkill=S13；feedback=A.operator-semantics；mutant=M02。

### A-03 Rule 全序、terminal short-circuit 与 ExplanationNode — 6 分
来源：README deterministic execution/explanation rules；Fixture：worked-example、ties、重复 tags、无 match；动作：evaluate/read explanation。
Oracle/Mandatory：priority/ruleId、last decision/default、matched IDs/tags、visited leaves 和每个 later rule 的单 SKIPPED node 精确，digest 独立重算；禁止副作用：不得求值 terminal 后规则或省略 SKIPPED。
归因：dimension=A；primarySkill=S08；feedback=A.deterministic-evaluation；mutant=M03。

### A-04 Static ConflictReport 与 immutable publication — 6 分
来源：README conflict detection/version invariants；Fixture：每种发布 conflict、排序 ties、已 published version mutation；动作：validate/conflicts/publish。
Oracle/Mandatory：独立静态检查器给出 exact deterministic `(priority,ruleId,code)` report，published content/digest 永不变；禁止副作用：conflict 不得 publish，retry 不得重写 report/version。
归因：dimension=A；primarySkill=S04；secondarySkills=S10；feedback=A.version-immutability；mutant=M04。

### A-05 ComparisonRun 冻结 corpus、版本与双 digest — 6 分
来源：Manager ComparisonRun/Result contract；Fixture：重复/乱序 1..100,000 completed Evaluation IDs、跨 RuleSet/未完成哨兵；动作：create/read comparison。
Oracle/Mandatory：同 RuleSet published baseline/candidate、IDs 去重 UUID 升序、corpusDigest/resultDigest RFC8785+SHA256 精确，每 ID 一 immutable result；禁止副作用：非法 corpus 不得留 Run/Work/Event，后续 Evaluation 改变不扩 cohort。
归因：dimension=A；primarySkill=S08；secondarySkills=S06；feedback=A.comparison-freeze；mutant=M05。

### B-01 Evaluation durable idempotency 与 facts freeze — 5 分
来源：README invariants/idempotency；Fixture：canonical-equivalent facts、semantic conflict、20 concurrent、shield/restart；动作：跨 API create/replay。
Oracle/Mandatory：tenant+method+path+key 原 status/body/ID，facts/version frozen 且单 Work/Event effect；禁止副作用：不同 body key reuse 不得新建 Evaluation。
归因：dimension=B；primarySkill=S04；feedback=B.idempotency；mutant=M06。

### B-02 RuleSet revision publish 并发唯一且不可变 — 5 分
来源：README version identity/REVISION_CONFLICT；Fixture：同 RuleSet 两 draft revisions；动作：双 API validate/publish。
Oracle/Mandatory：`(tenant,ruleSet,revision)` 唯一、冲突线性化、winner exact digest；禁止副作用：loser 不得成为 current/写 event 或改 winner content。
归因：dimension=B；primarySkill=S04；feedback=B.publication-race；mutant=M04。

### B-03 多 Worker Evaluation 结果确定且至多一次 — 5 分
来源：README atomic Evaluation/Work/Explanation/Event；Fixture：同 frozen input、多 worker claim/race；动作：排空。
Oracle/Mandatory：一 terminal decision/explanation/result digest，与独立 interpreter 相同且原子可见；禁止副作用：不得两套 nodes、digest drift 或 completed 无 event。
归因：dimension=B；primarySkill=S07；feedback=B.evaluation-contention；mutant=M03。

### B-04 Comparison start CAS 与 per-corpus 唯一结果 — 5 分
来源：Manager start/expectedRevision/Worker rule；Fixture：同 PENDING run、20 start 请求、wide corpus；动作：并发 start/workers。
Oracle/Mandatory：恰一 revision transition，每 evaluationId 一 result/ordinal，counts 合计 corpus size；禁止副作用：CAS loser 不得写 Work/Event，result 不得覆盖原 Evaluation。
归因：dimension=B；primarySkill=S04；feedback=B.comparison-cas；mutant=M07。

### B-05 cancel/promote/worker commit 收敛与 ERROR gate — 5 分
来源：Manager control/CAS/promotion rules；Fixture：RUNNING/COMPLETED runs、DIFF/ERROR mixes、old leases；动作：并发 cancel/promote/commit。
Oracle/Mandatory：cancel durable fence；promotion 仅 COMPLETED、revision match、ERROR=0，并只切 currentPublishedVersionId+publicationRevision；禁止副作用：不得修改 Version/Results、忽略 ERROR 或双终态。
归因：dimension=B；primarySkill=S04；feedback=B.control-linearization；mutant=M08。

### C-01 Evaluation Work lease reclaim/stale fence — 5 分
来源：README Work invariant/recovery 与公开 snapshot Work shape；Fixture：短 lease；动作：轮询 snapshot 观察 EVALUATION_EXECUTE 为 LEASED 后 SIGKILL owner并启动 replacement。
Oracle/Mandatory：Work 可恢复、旧 token 不可 commit、最终 decision/nodes/event 一次原子出现；禁止副作用：不得永久 LEASED、重复 explanations 或在外部等待期间持事务。
归因：dimension=C；primarySkill=S07；feedback=C.evaluation-recovery；mutant=M09。

### C-02 Replay 永远使用 original version/facts — 5 分
来源：README Replay invariant；Fixture：原 Evaluation 后发布新 current version、response loss，且 snapshot 显示 EVALUATION_REPLAY 为 LEASED；动作：SIGKILL owner后公开 replay/recovery。
Oracle/Mandatory：以原 frozen inputs 重算 MATCHED；真实 digest mismatch 仅 append DIVERGED，绝不覆盖 Evaluation；禁止副作用：不得用 current version 或修补原 digest。
归因：dimension=C；primarySkill=S04；secondarySkills=S05；feedback=C.replay-precedence；mutant=M10。

### C-03 Comparison worker crash 后 corpus closure — 5 分
来源：Manager Worker/cancel/result immutability；Fixture：mixed MATCH/DIFF/ERROR corpus 与短 lease；动作：每次从公开 snapshot 观察 Comparison Work 为 LEASED 后 kill owner/replacement。
Oracle/Mandatory：每 frozen ID 恰一 immutable Result，counts/digests/ordinal 闭合，old lease fenced；禁止副作用：不得漏/重结果、把 ERROR 标已解释或改原 Evaluation。
归因：dimension=C；primarySkill=S07；feedback=C.comparison-recovery；mutant=M07。

### C-04 Rule/Comparison event unknown ACK — 5 分
blockedBy（仅 delivery unknown-ACK 子断言）：`SPEC-GAP-RB-03`；公开 receiver/response seam 补齐前不运行该子断言、不转移权重。
来源：README dispatcher/Event 原子规则 + Manager published event types；Fixture：成功/rollback transitions 与任意 dispatcher restart；动作：经公开 snapshot 前后读取 Event，重启 dispatcher；seam 补齐后再注入 receiver 500/unknown ACK。
Oracle/Mandatory：published event type、stable eventId/canonical body、aggregate sequence 随业务原子递增，任意 restart 不改写；禁止副作用：rollback 无 event、cancel/promote 不重复；补 seam 前不得声称已验证 external delivery 或 retry identity。
归因：dimension=C；primarySkill=S07；feedback=C.outbox；mutant=M09。

### D-01 V1/Comparison wire、errors、strict JSON 与 tenant scope — 4 分
来源：README Public HTTP + Manager exact routes/shapes/errors；Fixture：unknown fields、invalid expression/facts/corpus/revision/missing IDs；动作：仅 HTTP。
Oracle/Mandatory：exact status/body/enums/error envelope、runtime schema/ordering；禁止副作用：GET/拒绝零 mutation，facts/credentials 不出 logs/events。
归因：dimension=D；primarySkill=S13；secondarySkills=S15；feedback=D.api-contract；mutant=M01。

### D-02 浏览器完成 RuleSet→Evaluation→Explanation→Replay — 4 分
来源：README「UI」；Fixture：真实 DB/API/workers、桌面移动；动作：visible controls。
Oracle/Mandatory：conflicts、decision/tags/nodes/replay/Work 与 HTTP/oracle 一致，refresh/keyboard/error/offline 可用；禁止副作用：不得 mock、执行用户代码或隐藏 SKIPPED。
归因：dimension=D；primarySkill=S08；secondarySkills=S15；feedback=D.browser-v1；mutant=M03。

### D-03 浏览器完成 corpus、diff、cancel、promote — 4 分
来源：Manager UI contract；Fixture：MATCH/DIFF/ERROR comparisons；动作：visible create/start/progress/detail/cancel/promote。
Oracle/Mandatory：counts/digests/diffs 和 ERROR gate 可见、refresh 保持、CAS conflict 明确；禁止副作用：不得客户端改 result 或给 ERROR waiver。
归因：dimension=D；primarySkill=S08；secondarySkills=S15；feedback=D.browser-manager；mutant=M08。

### D-04 FINAL snapshot 点时重算解释与结果 — 3 分
来源：README seed/snapshot + Manager resources/Work/events；Fixture：all version/evaluation/replay/comparison states；动作：授权 snapshot。
Oracle/Mandatory：exact keys/shapes/sorts/same asOf/Work retention/redaction；harness 独立重算 selected digests/counts；禁止副作用：不得泄露 facts/credentials、漏 terminal Work 或多时点拼接。
归因：dimension=D；primarySkill=S08；secondarySkills=S11；feedback=D.snapshot；mutant=M10。

### E-01 Populated V1→Comparison FINAL 兼容迁移 — 3 分
来源：Manager migration clause；Fixture：V1 versions/explanations/replays/idempotency/leases/events；动作：upgrade/recover/replay。
Oracle/Mandatory：所有 V1 identity/content/digest/saved body/lease/event 不变，pending V1 Work 按 frozen input 收敛；禁止副作用：不得补 comparison、重算 old digest 或更换 event identity。
归因：dimension=E；primarySkill=S04；secondarySkills=S02；feedback=E.compatibility；mutant=M06。

### E-02 `evaluation-throughput` 固定负载 — 3 分
来源：README Performance contract #1；Fixture：200-rule、200k evaluations、64 clients、60s；动作：公开 HTTP+workers。
Oracle/Mandatory：`>=600/s`、p95 `<=250ms`、5xx=0、再 `<=60s` drain，post-load decision/explanation/replay/event invariants；禁止副作用：不得 smoke scale 或只数 accepted POST。
归因：dimension=E；primarySkill=S13；secondarySkills=S14；feedback=E.evaluation-performance；mutant=M06。

### E-03 `deep-short-circuit` 5,000-rule 负载 — 2 分
来源：README Performance contract #2；Fixture：100k evaluations、terminal 在前 10、64 clients；动作：规定 60s run。
Oracle/Mandatory：`>=400/s`、p95 `<=350ms`、5xx=0，全部 later rules 为 SKIPPED 且 digest deterministic；禁止副作用：不得省略 explanation 或预删后续 rules。
归因：dimension=E；primarySkill=S08；secondarySkills=S14；feedback=E.short-circuit-performance；mutant=M03。

### E-04 `comparison-recovery` 50k frozen inputs — 2 分
来源：Manager formal scenario；Fixture：50,000 IDs、kill two claimed workers、four replacements；动作：公开 snapshot 观察两个目标 Comparison Work 为 LEASED 后杀 owner并启动 timer/replacements。
Oracle/Mandatory：`<=60s`，每 ID 一 Result、无 digest drift/duplicate Event、counts 闭合；禁止副作用：不得缩 corpus、random sleep 或绕 production worker。
归因：dimension=E；primarySkill=S07；secondarySkills=S14；feedback=E.comparison-performance；mutant=M07。

## Mutants

| Mutant | 领域缺陷 | 必杀 Case |
|---|---|---|
| M01 | 用 JS truthiness/coercion 或不验 grammar/limits | A-01、D-01 |
| M02 | missing 等同 null，ordering 接受字符串/float | A-02 |
| M03 | terminal 后仍求值或省略 SKIPPED/tags 顺序错 | A-03、B-03、E-03 |
| M04 | conflict report 非确定或 published Version 可改 | A-04、B-02 |
| M05 | Comparison worker 动态读取 corpus/current versions | A-05 |
| M06 | 幂等在业务 commit 后保存/迁移重算 old body | B-01、E-01、E-02 |
| M07 | comparison lease crash 造成 duplicate/missing Result | B-04、C-03、E-04 |
| M08 | cancel 不 fence 或 promotion 忽略 ERROR/CAS | B-05、D-03 |
| M09 | stale worker/outbox ACK 可重复 commit/event | C-01、C-04 |
| M10 | replay 用 current version 或覆盖原 Evaluation | C-02、D-04 |

## Coverage mapping

**README / Manager → Case**

| README/Manager requirement | Cases |
|---|---|
| Rule language/determinism/conflicts | A-01..A-04、B-02..B-03 |
| Idempotency/replay/worker/events | B-01、C-01..C-04 |
| ComparisonRun/Result/control | A-05、B-04..B-05、C-03、D-03 |
| HTTP/UI/snapshot | D-01..D-04 |
| Migration/performance | E-01..E-04 |

**旧 H → Case**

| 旧 H family | v2 Cases |
|---|---|
| H-01 | 不计分 preflight |
| H-02..H-04 | A-01..A-04、D-01..D-02 |
| H-05..H-08 | B-01..B-03、C-01..C-02、C-04 |
| H-09 | E-01 |
| H-10..H-11 | A-05、B-04..B-05、C-03、D-03..D-04 |
| H-12 | E-02..E-04 |
| H-13 | D/项目证据，不另计分 |

## Evidence/hard caps

保存 fixture、HTTP、snapshot/进程信号 ledger、独立 interpreter/conflict/digest oracle、snapshot digest；RB-03 补 seam 后才增加 receiver ledger。非法 DSL 执行、版本可变、非确定 decision/explanation、partial comparison 或 terminal 回退总分上限 35；幂等第二效果上限 30；stale worker 可提交/Work 丢失上限 40；迁移改 V1 digest/replay/event 上限 35；性能后不变量失败使对应 E Case 为 0 并应用 correctness cap。
