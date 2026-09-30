# QuotaMesh Hidden Test v2 设计

## 边界与计分

- 权威为 `workspace/README.md`、orchestration fixed Manager message、`CONTEXT.md`；旧 E2E 仅作 H→Case 覆盖索引。
- 22 个 Case，总分 100：A 30、B 25、C 20、D 15、E 10。`primarySkill` 聚焦 S04、S07、S14、S15；S02、S06、S11 等相关能力只列入 `secondarySkills`。
- install/build/migration replay/boot/health/OpenAPI parse/Chromium shell 是不计分 preflight；业务 Case 只走 HTTP、真实 UI、公开 barrier/receiver 和 snapshot。

## SPEC-GAP

- `SPEC-GAP-QM-01`：Manager 明确“不新增未字面发布 Work kind/event”；测试不要求 hierarchy 专属事件名。
- `SPEC-GAP-QM-02`：Project allocation 的同值 CAS 成功响应排序未另行定义；按 exact resource shape 比较，不推断集合包装顺序。
- 无 blocked Case。

## Worked example

Org 容量 `{cpu:10,mem:20}`，Project A allocation `{6,12}`、B `{4,8}`。A 已 committed `{4,8}` 后请求 `{3,5}`，即使 B 未使用也必须原子拒绝，因为 A 余量仅 `{2,4}`；不得借用 B。释放 A 的 `{2,4}` 后同请求才可成功，并同时令 A 与 Org 的 held 各增加 `{3,5}`。oracle 分别维护 Org、Project 两本整数向量账，任何单维负数、只改一层或跨 Project 借用均失败。

## Scoring Cases

### A-01 多维 Reservation 原子守恒 — 6 分
来源：README「Domain and V1 behavior」「Mandatory invariants」；Fixture：2–6 维 Pool、恰好/超一单位边界；动作：公开 reservation create/read。
Oracle/Mandatory：每维 `capacity=available+held+committed`、整数非负，向量全成或全败；禁止副作用：失败不得改变任一维、Work/Event/idempotency 业务结果。
归因：dimension: A；primarySkill=S04；feedback=A.vector-conservation；mutant=M01。

### A-02 Commit、release 与 expiry 状态闭合 — 6 分
来源：README V1 state machine/deterministic policy；Fixture：HELD reservation、边界 DB time；动作：公开 commit/release 和 expiry worker。
Oracle/Mandatory：held/committed 向量按唯一合法转移精确移动，terminal 不重入；禁止副作用：过期不得动 committed，release/commit 不得重复退还。
归因：dimension: A；primarySkill=S04；feedback=A.state-conservation；mutant=M02。

### A-03 Admission 排序与严格 head-only promotion — 6 分
来源：README deterministic admission policy；Fixture：priority、requestedAt、id 形成 ties，队首暂不可满足而后项可满足；动作：enqueue/释放容量/驱动 promotion。
Oracle/Mandatory：按发布顺序选择，只有 head 可晋升，head 不可满足时后项不得绕行；禁止副作用：不得因吞吐跳过 head 或重写 requestedAt。
归因：dimension: A；primarySkill=S07；secondarySkills=S06；feedback=A.admission-order；mutant=M03。

### A-04 Project Reservation 同时消耗 Project 与 Org — 6 分
来源：Manager hierarchy 规则；Fixture：worked-example 和多 Project；动作：Manager public reservation seam。
Oracle/Mandatory：单事务检查/更新两层向量，Project 不超过 allocation、Org 不超过 capacity；禁止副作用：不得借用 sibling 未用 allocation、只写一层或动态换归属。
归因：dimension: A；primarySkill=S04；feedback=A.hierarchy-conservation；mutant=M04。

### A-05 Capacity/allocation CAS 与可行域 — 6 分
来源：Manager exact schemas/routes/errors；Fixture：expectedRevision 新旧值、缩容到 current usage 上下；动作：公开 Org capacity/Project allocation CAS。
Oracle/Mandatory：正确 revision 原子递增，stale revision 精确冲突且零变化，更新后仍覆盖 held+committed/各 allocation 约束；禁止副作用：不可行缩容不得部分修改 revision/vector。
归因：dimension: A；primarySkill=S04；feedback=A.cas-invariant；mutant=M05。

### B-01 Reservation durable replay 与 key scope — 5 分
来源：README「Durable idempotency」；Fixture：相同 key、语义冲突、unknown response、restart；动作：跨两个 API 重放。
Oracle/Mandatory：method+canonical path+key 同语义返回原 status/body/id 且单次向量变化；禁止副作用：不同语义 key reuse 不得占 quota。
归因：dimension: B；primarySkill=S04；feedback=B.idempotency；mutant=M06。

### B-02 热 Pool 并发向量请求不超售 — 5 分
来源：README mandatory invariants/concurrency；Fixture：可满足 K 个的 capacity、20 路不同请求；动作：双 API 并发 create。
Oracle/Mandatory：成功集合可线性化且逐维总量不超过 capacity，输家为预期冲突；禁止副作用：不得某维负数或出现 orphan Reservation。
归因：dimension: B；primarySkill=S04；feedback=B.contention；mutant=M01。

### B-03 Commit/release/expiry 三方竞争单终态 — 5 分
来源：README state machine/DB time；Fixture：到期边界上的 HELD Reservation；动作：API commit、release 与 expiry worker 并发。
Oracle/Mandatory：恰一合法终态及一次向量迁移，重复调用按发布语义响应；禁止副作用：不得双退还、held/committed 同时计入或终态回退。
归因：dimension: B；primarySkill=S04；feedback=B.terminal-race；mutant=M02。

### B-04 Admission promotion 在并发释放下仍 head-only — 5 分
来源：README admission ordering/promotion；Fixture：一个 head 与多个可绕行后项、两个释放者/worker；动作：并发释放和 promotion。
Oracle/Mandatory：每次容量提交后只按头部重算，成员至多晋升一次；禁止副作用：不得跳头、重复 reservation effect 或丢 admission。
归因：dimension: B；primarySkill=S07；feedback=B.promotion-linearization；mutant=M03。

### B-05 两层 CAS 与 Reservation 竞争不破坏 allocation — 5 分
来源：Manager hierarchy/CAS；Fixture：Project allocation 缩减与同 Project 新 Reservation；动作：两个 API barrier 并发。
Oracle/Mandatory：只接受可串行结果，任一成功提交点两层可行域均成立；禁止副作用：不得用陈旧 allocation 接受请求或 revision 成功却漏 vector update。
归因：dimension: B；primarySkill=S04；feedback=B.hierarchy-race；mutant=M05。

### C-01 Expiry Work lease reclaim 与 stale fencing — 5 分
来源：README Workers/events/recovery barrier；Fixture：`worker.claimed`/`before-commit`、短 lease、两 worker；动作：SIGKILL/reclaim。
Oracle/Mandatory：到期 Reservation 最终一次释放，attempt/lease 状态正确，旧 token 不能提交；禁止副作用：不得永久 held、双退还或持事务等待 barrier。
归因：dimension: C；primarySkill=S07；feedback=C.lease-recovery；mutant=M07。

### C-02 Expiry 后 Admission 连锁推进可恢复 — 5 分
来源：README expiry/promotion Work 与 backlog drain；Fixture：20 个按序 admission、多次释放机会；动作：effect-complete/commit 前 kill/restart。
Oracle/Mandatory：独立 head-only 模型与最终晋升集合/顺序一致，backlog 可排空；禁止副作用：不得漏头、重复晋升或扫描式越序。
归因：dimension: C；primarySkill=S07；feedback=C.progress-recovery；mutant=M08。

### C-03 Hierarchy 更新/Reservation 崩溃保持双层原子 — 5 分
来源：Manager atomic hierarchy + README recovery invariants；Fixture：Org/Project 热点、response shield/API SIGKILL；动作：更新或 create 的未知响应后重试。
Oracle/Mandatory：replay 精确且 Org/Project 两层同时有或同时无变化；禁止副作用：不得留下只消耗 Project/Org 的半提交。
归因：dimension: C；primarySkill=S04；feedback=C.atomic-recovery；mutant=M04。

### C-04 Quota event unknown ACK 保持身份与顺序 — 5 分
来源：README event/dispatcher contract；Fixture：成功/rollback transitions、receiver 500/ACK barrier；动作：kill/restart dispatcher。
Oracle/Mandatory：committed transition 有稳定 eventId/body，aggregate sequence 成功交付递增；禁止副作用：rollback 无 event、retry 不换 identity 或新造业务变化。
归因：dimension: C；primarySkill=S07；feedback=C.outbox；mutant=M09。

### D-01 Pool/Reservation/Admission/Hierarchy wire 闭合 — 4 分
来源：README HTTP/OpenAPI + Manager exact shapes/routes/errors；Fixture：未知字段、边界整数、cursor、missing refs；动作：仅 HTTP。
Oracle/Mandatory：精确 status/body/enums/error envelope、stable pagination 与 exact sort；禁止副作用：GET/拒绝零 mutation，不得接受浮点/额外字段。
归因：dimension: D；primarySkill=S15；feedback=D.api-contract；mutant=M05。

### D-02 浏览器完成 V1 reserve→commit/release→admission — 4 分
来源：README「Real UI」；Fixture：真实 DB/API/worker、桌面移动 viewport；动作：可见控件操作及 refresh。
Oracle/Mandatory：每维 capacity/held/committed、等待顺序和错误态与 HTTP/oracle 一致；禁止副作用：不得 mock、client-only quota 或隐藏 head blocking。
归因：dimension: D；primarySkill=S15；feedback=D.browser-v1；mutant=M03。

### D-03 浏览器呈现 Org/Project 双层配额 — 4 分
来源：Manager UI 条款；Fixture：worked-example；动作：创建层级、CAS allocation、Project reservation。
Oracle/Mandatory：两层使用量/可用量、revision conflict 和“不借用”可见且 refresh 保持；禁止副作用：UI 不得把 Org free 显示成 Project 可借余额。
归因：dimension: D；primarySkill=S15；feedback=D.browser-manager；mutant=M04。

### D-04 FINAL snapshot 单时点守恒 — 3 分
来源：README V1 snapshot + Manager FINAL resource union；Fixture：各状态/层级、leased/terminal Work/events；动作：授权 snapshot。
Oracle/Mandatory：exact keys/shapes/sorts、同一 asOf、Work retention/drain、token omission；harness 从 snapshot 重算双层向量；禁止副作用：不得多时点拼接或泄露 fencing/idempotency token。
归因：dimension: D；primarySkill=S15；secondarySkills=S04,S11；feedback=D.snapshot；mutant=M09。

### E-01 Legacy Pool→Org/default Project 兼容迁移 — 3 分
来源：Manager deterministic legacy migration；Fixture：V1 Pools、held/committed Reservations、Admissions、pending Work/events/replay；动作：升级恢复重放。
Oracle/Mandatory：每 Pool 映射规定 Org/default Project，identity/vector/event/replay 不变且可行域成立；禁止副作用：不得借迁移合并 Pool、重编号或补业务事件。
归因：dimension: E；primarySkill=S04；secondarySkills=S02,S06；feedback=E.compatibility；mutant=M10。

### E-02 `quota-pool-read` 固定读负载 — 3 分
来源：README Scenario `quota-pool-read`；Fixture/动作：严格公开 seed、selector、concurrency、60 秒 GET。
Oracle/Mandatory：`>=500/s`、p95 `<=100ms`、5xx=0，响应为同一时点精确 Pool；禁止副作用：不得缓存陈旧 authority 或缩 workload。
归因：dimension: E；primarySkill=S14；feedback=E.read-performance；mutant=M10。

### E-03 `hot-pool-reservation-race` 守恒负载 — 2 分
来源：README 同名 Scenario；Fixture：公开 80/20 分布和容量；动作：精确 200 attempts/s、规定并发/时长。
Oracle/Mandatory：p95 `<=400ms` 且成功/冲突、每维守恒与 idempotency 精确；禁止副作用：不得只报吞吐或把 expected conflict 算 5xx。
归因：dimension: E；primarySkill=S14；secondarySkills=S04；feedback=E.contention-performance；mutant=M01。

### E-04 `expiry-and-admission-recovery` 排空 — 2 分
来源：README 同名 Scenario；Fixture：20,000 expiry+20,000 admissions 与公开 worker/recovery；动作：按 timer/barrier 执行。
Oracle/Mandatory：`<=60s`、head-only 顺序、无重复/遗漏、backlog drain；禁止副作用：不得 random sleep、缩 backlog 或跳 post-load invariant。
归因：dimension: E；primarySkill=S14；secondarySkills=S07；feedback=E.recovery-performance；mutant=M08。

## Mutants

| Mutant | 领域缺陷 | 必杀 Case |
|---|---|---|
| M01 | 分维检查/更新，失败后残留部分向量 | A-01、B-02、E-03 |
| M02 | commit/release/expiry 可双退还或回退 | A-02、B-03 |
| M03 | admission 扫描首个可满足项而非 head-only | A-03、B-04、D-02 |
| M04 | Project Reservation 只扣一层或借 sibling | A-04、C-03、D-03 |
| M05 | CAS 不检 revision/当前 usage | A-05、B-05、D-01 |
| M06 | 幂等结果在业务 commit 后保存 | B-01 |
| M07 | expired lease 的旧 worker 仍提交 | C-01 |
| M08 | recovery 全表扫导致越序/重复 promotion | C-02、E-04 |
| M09 | outbox 非原子或 ACK retry 换 eventId | C-04、D-04 |
| M10 | legacy migration 重算/改写 identity 或向量 | E-01、E-02 |

## Coverage mapping

**README / Manager → Case**

| README/Manager requirement | Cases |
|---|---|
| Vector conservation/state/admission | A-01..A-03、B-02..B-04 |
| Durable idempotency/recovery/events | B-01、C-01..C-04 |
| Org/Project hierarchy/CAS | A-04..A-05、B-05、C-03、D-03 |
| HTTP/UI/snapshot | D-01..D-04 |
| Migration/performance | E-01..E-04 |

**旧 H → Case**

| 旧 H family | v2 Cases |
|---|---|
| H-01 | 不计分 preflight |
| H-02..H-04 | A-01..A-03、D-01..D-02 |
| H-05..H-08 | B-01..B-04、C-01..C-02、C-04 |
| H-09 | E-01 |
| H-10..H-11 | A-04..A-05、B-05、C-03、D-03..D-04 |
| H-12 | E-02..E-04 |
| H-13 | D/项目证据，不另计分 |

## Evidence/hard caps

保存 fixture、HTTP、DB-time/barrier/receiver transcript、独立向量与 admission ledger、snapshot digest。任一维负数/超售、非原子向量、head-only 或单终态失败总分上限 35；幂等第二效果上限 30；stale worker 可提交或合法 Work 丢失上限 40；兼容迁移改写身份/replay 上限 35；性能后不变量失败则相应 E Case 为 0 并应用 correctness cap。
