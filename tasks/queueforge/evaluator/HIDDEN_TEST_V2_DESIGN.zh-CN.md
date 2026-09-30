# QueueForge Hidden Test v2 设计

## 边界与权重

- 权威：`workspace/README.md`、T16 fixed Manager message、`CONTEXT.md`；旧 E2E 仅作覆盖索引。
- 22 Case：A 5×6=30，B 5×5=25，C 4×5=20，D=4+4+4+3=15，E=3+3+2+2=10，总分 100。
- `primarySkill` 聚焦 S04、S07、S14、S15；S02、S06、S11、S17 等相关能力只列入 `secondarySkills`。
- clean install/build/migrate/boot/health/OpenAPI parse/Chromium shell 为不计分 preflight；候选表、源码、日志和自带测试不是 oracle。

## SPEC-GAP

- `SPEC-GAP-QF-01`：Manager 明确禁止推断未字面发布的新 Work kind/event；Workflow Case 不要求自造事件名。
- `SPEC-GAP-QF-02`：失败节点 retry 与并发 cancel 的精确胜负错误未额外发布；只接受符合已发布状态机的可串行结果，不臆造 code。
- 无阻断评分的缺口。

## Worked example

创建 DAG `A→{B,C}, B→D, C→D, D→E`，令 B 失败：oracle 预期 A=SUCCEEDED、B=FAILED，D/E 因失败祖先被 BLOCKED，C 可独立完成。对 B 执行一次合法 retry 后，只有 B 重新可运行；B 成功且 C 已成功后 D 才 eligible，继而 E，最终 aggregate COMPLETED。任何未满足 predecessor 的 claim、无关节点重跑或 aggregate 提前完成均失败。

## Scoring Cases

### A-01 Run 创建与三种 operation 的精确结果 — 6 分
来源：README「Domain and V1 behavior」及 public routes；Fixture：ECHO、SHA256、SUM 的边界合法输入与非法哨兵；动作：公开 enqueue/read seam 驱动终态。
Oracle/Mandatory：harness 独立计算 operation 输出、状态与 terminal result，精确 shape/code；禁止副作用：无效输入不得创建 Run/Work/Event，SUM 不得浮点或溢出静默。
归因：dimension: A；primarySkill=S04；feedback=A.operation-contract；mutant=M01。

### A-02 Claim 顺序、notBefore 与 priority — 6 分
来源：README「Deterministic policy」；Fixture：相同/不同 priority、notBefore、createdAt、runId；动作：用公开 worker/verification seam 在固定 DB time claim。
Oracle/Mandatory：严格按 `priority desc, notBefore, createdAt, runId` 选择且未来任务不可 claim；禁止副作用：读取顺序不得依赖进程、插入或 UUID 随机顺序。
归因：dimension: A；primarySkill=S07；feedback=A.ordering；mutant=M02。

### A-03 Queue capacity、attempt 与 backoff 边界 — 6 分
来源：README mandatory invariants/worker rules；Fixture：容量边界、失败次数和可控数据库时钟；动作：enqueue、失败、到点重试。
Oracle/Mandatory：容量只计合同定义的非终态 Run，attempt/backoff/notBefore 精确且终态不重入；禁止副作用：拒绝 enqueue 不得留下 Work/Event/idempotency 半记录。
归因：dimension: A；primarySkill=S07；feedback=A.queue-invariant；mutant=M03。

### A-04 WorkflowRun 创建时冻结合法 DAG — 6 分
来源：Manager 规则与新增 wire/route；Fixture：1、50 节点、重复 nodeId、环、自依赖、缺引用；动作：公开 Workflow 创建/read。
Oracle/Mandatory：独立拓扑检查，合法成员/edges/operations 完整冻结，非法图原子返回发布错误；禁止副作用：不得部分创建 Run/Node/Work 或动态改图。
归因：dimension: A；primarySkill=S04；secondarySkills=S06；feedback=A.workflow-contract；mutant=M04。

### A-05 Workflow eligibility、失败传播与 aggregate closure — 6 分
来源：Manager dependency-aware WorkflowRun 规则；Fixture：worked-example 及多根/多叶 DAG；动作：驱动 nodes success/failure。
Oracle/Mandatory：仅 predecessor 全成功节点 eligible，失败阻断全部传递后代，aggregate 仅在成员闭合后终态；禁止副作用：无关分支不得被阻断或提前执行。
归因：dimension: A；primarySkill=S07；secondarySkills=S17；feedback=A.dag-closure；mutant=M05。

### B-01 Enqueue durable idempotency 与 unknown response — 5 分
来源：README「Durable idempotency」；Fixture：相同 key/语义冲突、20 路并发、response shield、restart；动作：跨两个 API enqueue/replay。
Oracle/Mandatory：原 status/body/runId 保持且一个 Run/Work/effect；禁止副作用：冲突 key 不得占容量或产生 event。
归因：dimension: B；primarySkill=S04；feedback=B.idempotency；mutant=M06。

### B-02 热队列多 worker claim 唯一性与全序 — 5 分
来源：README deterministic policy/leases；Fixture：大量同 priority 可运行 Run、四 worker；动作：并发 claim/complete。
Oracle/Mandatory：每个 lease 期内单 owner，最终 claim 序列符合所有已提交点可线性化全序；禁止副作用：不得双执行或饿死更高优先级已到期 Run。
归因：dimension: B；primarySkill=S07；feedback=B.claim-contention；mutant=M02。

### B-03 Run cancel 与 worker terminal commit 竞争 — 5 分
来源：README V1 state/cancel race；Fixture：`worker.before-commit` barrier；动作：并发 cancel 与 completion。
Oracle/Mandatory：只接受单一合法终态，胜者事件/结果精确，重复 cancel/replay 一致；禁止副作用：CANCELLED 后旧 token 不得写 result，成功后不得伪装取消。
归因：dimension: B；primarySkill=S04；feedback=B.terminal-race；mutant=M07。

### B-04 Workflow 节点 fan-out 并发不越依赖 — 5 分
来源：Manager eligibility 与 concurrency；Fixture：宽 DAG、多 API/worker；动作：并发 claim 所有可见节点。
Oracle/Mandatory：harness 的 predecessor ledger 对每次 claim 提交点均为 satisfied，每节点最多一个业务效果；禁止副作用：不得因缓存过期 claim 未 eligible 节点。
归因：dimension: B；primarySkill=S07；secondarySkills=S17；feedback=B.fanout-concurrency；mutant=M05。

### B-05 Retry 只解除 sole failed ancestor 的后代 — 5 分
来源：Manager retry failed node/selective unblock；Fixture：后代分别有一个与两个 failed ancestors；动作：公开 retry 并完成其中一祖先。
Oracle/Mandatory：只重置目标 failed node；仅不再有任何 failed ancestor 且 predecessors 可满足的后代解除阻断；禁止副作用：已成功/无关节点不重跑，仍有失败祖先者不解锁。
归因：dimension: B；primarySkill=S04；secondarySkills=S06,S17；feedback=B.selective-reentry；mutant=M08。

### C-01 Expired lease reclaim 与 stale token fencing — 5 分
来源：README Workers/recovery/barrier；Fixture：短 lease、`worker.claimed`/`before-commit` barriers；动作：SIGKILL、等 DB lease 到期、替代 worker。
Oracle/Mandatory：attempt 按合同递增、任务可恢复且旧 token commit 被拒；禁止副作用：不得永久 LEASED、重复 result/event 或持事务等待 barrier。
归因：dimension: C；primarySkill=S07；feedback=C.lease-recovery；mutant=M09。

### C-02 Effect-complete unknown outcome 的 operation 至多一次 — 5 分
来源：README controlled recovery 与 operation effect invariant；Fixture：effect-complete barrier、可独立核对结果；动作：kill/restart worker。
Oracle/Mandatory：恢复后一个终态和一份确定性 result，stale completion 无权覆盖；禁止副作用：不得新增第二业务 effect 或丢合法 Work。
归因：dimension: C；primarySkill=S07；feedback=C.effect-recovery；mutant=M09。

### C-03 Workflow crash/restart 后 DAG 继续闭合 — 5 分
来源：Manager recovery、aggregate rules；Fixture：部分成功/失败/blocked 的 50 节点 DAG；动作：多次 kill workers 后替换排空。
Oracle/Mandatory：最终 member ledger 等于独立 DAG 模型、无重复 effect，aggregate/计数闭合；禁止副作用：不得全图重跑或让 blocked descendants 永久 pending。
归因：dimension: C；primarySkill=S07；secondarySkills=S17；feedback=C.aggregate-recovery；mutant=M10。

### C-04 Domain Event unknown ACK 与 aggregate 顺序 — 5 分
来源：README events/dispatcher recovery；Fixture：成功和 rollback Run、receiver 500/断连/ACK barrier；动作：restart dispatcher。
Oracle/Mandatory：committed transition 对应稳定 eventId/body，同 aggregate 成功交付 sequence 递增；禁止副作用：rollback 无 event，重试不换 identity。
归因：dimension: C；primarySkill=S07；feedback=C.outbox；mutant=M10。

### D-01 Run/Workflow wire、错误、分页与排序 — 4 分
来源：README HTTP/OpenAPI 与 Manager exact schemas/routes/errors；Fixture：边界字段、unknown keys、cursor、missing IDs；动作：仅公共 HTTP。
Oracle/Mandatory：runtime 精确 status/body/error、stable opaque pagination 和 exact enum；禁止副作用：拒绝/GET 不得改变队列、Workflow 或 Work。
归因：dimension: D；primarySkill=S15；feedback=D.api-evidence；mutant=M04。

### D-02 浏览器完成 V1 enqueue→execution→cancel — 4 分
来源：README「Real UI」；Fixture：生产 build、真实 DB/API/worker、桌面移动 viewport；动作：仅 visible controls。
Oracle/Mandatory：operation/result/history/work 状态与 HTTP/oracle 一致，refresh、loading/error/offline、键盘焦点可用；禁止副作用：不得 mock 或直连内部模块。
归因：dimension: D；primarySkill=S15；feedback=D.browser-v1；mutant=M01。

### D-03 浏览器呈现 Workflow DAG、阻断与 retry — 4 分
来源：Manager UI 更新条款；Fixture：worked-example DAG；动作：UI create、观察 failure propagation、retry/cancel。
Oracle/Mandatory：节点/edge/eligibility/aggregate 可见且与独立模型一致，refresh 不丢状态；禁止副作用：UI 不得客户端自行“完成”节点或隐藏 blocked 原因。
归因：dimension: D；primarySkill=S15；secondarySkills=S17；feedback=D.browser-manager；mutant=M08。

### D-04 FINAL verification snapshot 的单点闭合 — 3 分
来源：README V1 snapshot + Manager FINAL resource/Work union；Fixture：各 Run/Workflow/Node state、leased/terminal Work/events；动作：授权 snapshot。
Oracle/Mandatory：同一 asOf、exact keys/shapes/sorts、Work retention/drain、递归 token 脱敏；禁止副作用：不得漏 terminal Work、泄露 lease token/key 或用多时点拼接。
归因：dimension: D；primarySkill=S15；secondarySkills=S11,S17；feedback=D.snapshot；mutant=M10。

### E-01 Populated V1→FINAL Workflow 兼容迁移 — 3 分
来源：Manager migration/legacy compatibility；Fixture：V1 Runs、pending/leased Work、events、saved replay；动作：升级、恢复、重放。
Oracle/Mandatory：V1 identity/status/body/event sequence 不变，pending 按旧捕获语义完成；禁止副作用：不得把 legacy Run 伪造为 Workflow member 或改写 replay。
归因：dimension: E；primarySkill=S04；secondarySkills=S02,S05；feedback=E.compatibility；mutant=M06。

### E-02 `run-enqueue` 固定持续负载 — 3 分
来源：README Scenario `run-enqueue`；Fixture/动作：严格按公开 seed、selector、64 并发、60 秒公开 POST。
Oracle/Mandatory：`>=300/s`、p95 `<=250ms`、unexpected 5xx=0，负载后容量/幂等/事件不变量成立；禁止副作用：不得缩规模、混 warm-up 或绕过 HTTP。
归因：dimension: E；primarySkill=S14；feedback=E.performance；mutant=M06。

### E-03 `short-run-execution` 排空 — 2 分
来源：README Scenario `short-run-execution`；Fixture：精确 5,000 short Runs 和规定 worker 数；动作：按公开 timer 排空。
Oracle/Mandatory：`<=60s` 完成且每 operation result 正确、无重复/遗漏；禁止副作用：不得预计算 terminal row 或跳过 post-load snapshot。
归因：dimension: E；primarySkill=S14；feedback=E.execution-load；mutant=M03。

### E-04 `expired-lease-recovery` 负载恢复 — 2 分
来源：README Scenario `expired-lease-recovery`；Fixture：精确 2,000 leased Runs 和公开 kill/replacement 规则；动作：barrier fault/recover。
Oracle/Mandatory：`<=45s` 闭合、stale token 零提交、attempt/result/event 正确；禁止副作用：不得 random sleep 或减小 backlog。
归因：dimension: E；primarySkill=S14；secondarySkills=S07；feedback=E.recovery-load；mutant=M09。

## Mutants

| Mutant | 领域缺陷 | 必杀 Case |
|---|---|---|
| M01 | operation 输入/结果用字符串或浮点捷径 | A-01、D-02 |
| M02 | claim 只按插入顺序/priority，漏完整 tie-break | A-02、B-02 |
| M03 | 容量或 backoff 进程内计算 | A-03、E-03 |
| M04 | DAG 只做局部检查，允许环/部分写 | A-04、D-01 |
| M05 | 节点在 predecessor 未成功时即可 claim | A-05、B-04 |
| M06 | idempotency 在业务 commit 后保存 | B-01、E-01 |
| M07 | cancel 不与 terminal commit 串行化 | B-03 |
| M08 | retry 粗暴重置所有 descendants | B-05、D-03 |
| M09 | expired lease 的旧 token 仍可 commit | C-01、C-02、E-04 |
| M10 | crash 后重复 node/event 或 aggregate 提前闭合 | C-03、C-04、D-04 |

## Coverage mapping

**README / Manager → Case**

| README/Manager requirement | Cases |
|---|---|
| Run operation、queue policy/capacity | A-01..A-03、B-02..B-03 |
| Idempotency/concurrency | B-01..B-03 |
| Worker lease/recovery/events | C-01..C-04 |
| Workflow DAG/failure/retry/cancel | A-04..A-05、B-04..B-05、C-03、D-03 |
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
| H-13 | D/证据门禁，不另计分 |

## Evidence/hard caps

每 Case 保留 fixture seed、HTTP transcript、barrier/receiver ledger、独立 queue/DAG oracle diff、snapshot digest。队列容量、单终态、DAG eligibility 或原子拒绝失败总分上限 35；幂等第二效果上限 30；stale worker 可提交/合法 Work 丢失上限 40；V1 migration/replay 改写上限 35；性能后不变量失败则对应 E Case 为 0 并应用 correctness cap。
