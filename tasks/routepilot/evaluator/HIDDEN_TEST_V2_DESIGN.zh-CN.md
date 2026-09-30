# RoutePilot Hidden Test v2 设计

## 边界与权重

- 权威：`workspace/README.md`、`orchestration/manager-prompt.zh-CN.md`、`CONTEXT.md`；旧 E2E 只作映射。
- 22 个名义 Case，A/B/C/D/E=30/25/20/15/10，总权重 100。核心 primarySkill 聚焦 S04、S05、S07、S14；迁移、冻结、snapshot 与跨层能力只作对应 Case 的 secondarySkills。
- install/build/migrate replay/boot/health/OpenAPI parse/Chromium shell 为不计分 preflight；oracle 由 harness 的 route matcher、hash、token/circuit windows、rollout ledger 计算。

## SPEC-GAP 与评分就绪

- `SPEC-GAP-RP-01`：Manager 发布了 `minimumObservationSeconds`/`failureThresholdPercent` 与 readiness 错误，却未发布 region failure observation 的输入 API、统计窗口、计数分母或来源。A-05 中“满足观察条件后 advance”、C-03、D-03 的自动推进部分标记 `blockedBy=SPEC-GAP-RP-01`；不得从候选实现或旧 E2E 发明健康 seam。
- `SPEC-GAP-RP-02`：Manager 未发布 rollout 专属 event type；不要求自造类型。
- blockedBy 的名义权重不转移；合同补齐前 score manifest 不是完全可执行态。

## Worked example

配置同时有 `/shops/:shopId/items/:itemId`、`/shops/*` 和两个相同 specificity 的 route。对 `/shops/a/items/b`，oracle 先按 priority、再 specificity、最后 routeId 选唯一 route；若该 route 有 20% canary，则按 README 的精确 hash 公式独立算 bucket。随后用同一请求跨实例重放，RouteRevision、upstream、rate/circuit 决策与响应 identity 均须稳定。

## Scoring Cases

### A-01 Path pattern、priority、specificity、routeId 全序 — 6 分
来源：README「Domain model and invariants」；Fixture：literal、`:param`、`*` 重叠与全 tie；动作：公开 gateway request seam。
Oracle/Mandatory：独立 parser/matcher 按发布全序选 route 且参数语义精确；禁止副作用：不得依赖插入/查询顺序、把 wildcard 当跨段 param 或污染其他 tenant。
归因：dimension=A；primarySkill=S05；feedback=A.route-selection；mutant=M01。

### A-02 Canary 精确 hash 与冻结 revision — 6 分
来源：README canary/hash/revision rules；Fixture：命中 bucket 边界的 request identity、发布前后 release；动作：gateway request/read。
Oracle/Mandatory：按字节级公式和权重边界选择 upstream，单请求冻结 RouteRevision/ConfigRelease；禁止副作用：不得随机、浮点漂移或因进程/重试改变 bucket。
归因：dimension=A；primarySkill=S05；feedback=A.canary-identity；mutant=M02。

### A-03 Tenant rate window 精确限流 — 6 分
来源：README rate-window invariant；Fixture：DB time 窗口边界、多 route/tenant；动作：公开 gateway 请求序列。
Oracle/Mandatory：独立整数 window ledger 给出 allow/throttle，边界 rollover 精确且 tenant 隔离；禁止副作用：拒绝不得消耗错误窗口、使用进程时钟或跨实例超发。
归因：dimension=A；primarySkill=S04；feedback=A.rate-limit；mutant=M03。

### A-04 Circuit breaker 状态、窗口与探测 — 6 分
来源：README circuit breaker contract；Fixture：成功/失败序列、阈值边界、可控 DB time；动作：gateway receiver 返回编排结果。
Oracle/Mandatory：CLOSED/OPEN/half-open 合同转移与 frozen upstream 精确；禁止副作用：OPEN 时不得正常外呼、旧窗口不得倒灌新 release 或跨 route 共享。
归因：dimension=A；primarySkill=S04；feedback=A.circuit-state；mutant=M04。

### A-05 RegionalRollout 冻结 stages、prior release 与顺序 — 6 分
部分 blockedBy=`SPEC-GAP-RP-01`；来源：Manager 规则 1–5 与 exact shapes；Fixture：重复 regions、边界观察时间/阈值、多 ACTIVE release；动作：create/read，advance 仅待 health seam 发布。
Oracle/Mandatory：first-occurrence 去重、ordinal 0..N-1、prior/target 与参数同事务冻结；只有当前 stage 可 ACTIVE，推进 readiness 待补；禁止副作用：非法请求不得留 Stage/Work/Event。
归因：dimension=A；primarySkill=S04；secondarySkills=S06；feedback=A.rollout-freeze；mutant=M05。

### B-01 ConfigRelease activate/rollback 原子切换 — 5 分
来源：README config release rules；Fixture：两个 releases、并发 gateway reads；动作：公开 activate/rollback/read。
Oracle/Mandatory：每个请求只见完整 old 或 new release，revision/history 精确；禁止副作用：不得混合 route set、部分激活或改写旧 revision。
归因：dimension=B；primarySkill=S04；feedback=B.atomic-publication；mutant=M06。

### B-02 Gateway mutation/release 的 durable replay — 5 分
来源：README idempotency；Fixture：same key/semantic conflict、20 并发、response shield/restart；动作：跨 API mutation replay。
Oracle/Mandatory：原 status/body/identity 和一次 release effect；禁止副作用：conflict key 不得改 active release/rate/circuit/event。
归因：dimension=B；primarySkill=S04；feedback=B.idempotency；mutant=M07。

### B-03 Hot tenant 跨 API rate authority — 5 分
来源：README PostgreSQL authority/rate invariants；Fixture：精确 token 数、双 API 高竞争；动作：并发 gateway requests。
Oracle/Mandatory：全局成功数不超过 window limit、结果可线性化且 rollover 精确；禁止副作用：不得各实例独立 quota 或负 token。
归因：dimension=B；primarySkill=S04；feedback=B.rate-contention；mutant=M03。

### B-04 Breaker result 与 config reload 竞争不串 revision — 5 分
来源：README breaker/release freeze；Fixture：旧 release in-flight results 与新 release activation；动作：barrier 交错 result/activate。
Oracle/Mandatory：result 只归其请求冻结的 CircuitWindow/revision，新请求只用新 release；禁止副作用：迟到失败不得打开新 release breaker 或覆盖 rollback。
归因：dimension=B；primarySkill=S05；feedback=B.precedence-race；mutant=M04。

### B-05 Rollout pause/resume/cancel/rollback 与 claim 串行 — 5 分
来源：Manager 规则 2、4–6、control APIs/errors；Fixture：部分 ACTIVE/SUCCEEDED stages 与旧 advance lease；动作：两个 API 并发 controls/worker claim。
Oracle/Mandatory：只收敛一个合法 rollout state；pause/cancel 不改已激活事实，rollback 原子恢复所有已激活 regions prior release并 fence 旧 lease；禁止副作用：不得部分 rollback 或终态离开。
归因：dimension=B；primarySkill=S04；feedback=B.rollout-linearization；mutant=M08。

### C-01 Gateway unknown response 与 idempotent replay — 5 分
来源：README durable replay/unknown outcome；Fixture：upstream 完整响应后断 client、API kill；动作：restart/retry。
Oracle/Mandatory：请求记录、rate/circuit effects 与原 response 只出现一次并可重放；禁止副作用：不得重复消耗 quota/记录 breaker result 或换 canary target。
归因：dimension=C；primarySkill=S05；feedback=C.unknown-outcome；mutant=M07。

### C-02 Config release/reload 崩溃保持完整 authority — 5 分
来源：README activation/recovery；Fixture：activation commit 边界、两个 API；动作：kill/restart 后查询并继续 gateway traffic。
Oracle/Mandatory：active authority 只能完整 old/new，历史/sequence 连续且 traffic 与之匹配；禁止副作用：不得 boot 时重算不同 active release 或丢 rollback 信息。
归因：dimension=C；primarySkill=S07；feedback=C.release-recovery；mutant=M06。

### C-03 Regional advance lease reclaim 与 progress — 5 分
blockedBy=`SPEC-GAP-RP-01`；来源：Manager 规则 3、5–7；Fixture：已满足待发布 health oracle 的 current stage、advance barriers；动作：kill/lease expiry/replacement。
Oracle/Mandatory：每 region 至多一个 Stage、严格 ordinal 推进、旧 token 不重新激活，最终闭合；禁止副作用：不得跳 stage、重复 activate 或永久 Work。
归因：dimension=C；primarySkill=S07；feedback=C.rollout-recovery；mutant=M09。

### C-04 Route/rollout event unknown ACK — 5 分
来源：README event/dispatcher + Manager stable events rule；Fixture：成功/rollback transitions、receiver 500/ACK barrier；动作：dispatcher kill/restart。
Oracle/Mandatory：committed transition 有稳定 eventId/body、aggregate sequence 成功顺序；禁止副作用：rollback 业务失败无 event、retry 不换 identity，不要求未发布 event name。
归因：dimension=C；primarySkill=S07；feedback=C.outbox；mutant=M10。

### D-01 Route/Release/Rollout wire 与 errors — 4 分
来源：README HTTP/OpenAPI + Manager exact routes/shapes/errors；Fixture：path/field/range/cursor/tenant/missing IDs；动作：仅 HTTP。
Oracle/Mandatory：exact status/body/enums/error envelope、strict JSON、stable pagination；禁止副作用：GET/拒绝零 mutation，runtime 不得靠宽松 OpenAPI 蒙混。
归因：dimension=D；primarySkill=S05；secondarySkills=S15；feedback=D.api-contract；mutant=M05。

### D-02 浏览器完成 route/release/gateway evidence — 4 分
来源：README「Production UI」；Fixture：真实 DB/API/upstream、桌面移动 viewport；动作：visible controls 创建 route/release、activate、发送请求、看 rate/breaker。
Oracle/Mandatory：selected route/revision/upstream/window 与独立 oracle/HTTP 一致，refresh/error/offline/keyboard 可用；禁止副作用：不得 mock 或客户端算 authority。
归因：dimension=D；primarySkill=S05；secondarySkills=S15；feedback=D.browser-v1；mutant=M01。

### D-03 浏览器 RegionalRollout 控制与进度 — 4 分
推进部分 blockedBy=`SPEC-GAP-RP-01`；来源：Manager UI 条款；Fixture：重复 stage request 与部分进度；动作：UI create/pause/resume/cancel/rollback。
Oracle/Mandatory：冻结 order/prior release/current ordinal/control outcome 与 HTTP 一致；自动健康推进待 seam 发布；禁止副作用：不得把 cancel 显示为 rollback 或客户端伪造 stage success。
归因：dimension=D；primarySkill=S04；secondarySkills=S15；feedback=D.browser-manager；mutant=M08。

### D-04 FINAL snapshot 单时点 route authority — 3 分
来源：README snapshot + Manager resource/Work union；Fixture：RouteRevision、Release、requests/windows、rollouts/stages、leased Work/events；动作：授权 snapshot。
Oracle/Mandatory：exact resources/shapes/sorts、same asOf、Work drain/retention、token omission；禁止副作用：不得多时点拼接、漏 GLOBAL/terminal Work 或泄露 idempotency/lease token。
归因：dimension=D；primarySkill=S05；secondarySkills=S11；feedback=D.snapshot；mutant=M10。

### E-01 V1 active release→deterministic GLOBAL rollout — 3 分
来源：Manager migration rule 8 与 legacy-global identity；Fixture：populated V1 revisions/releases/requests/windows/events/work/replay；动作：重复升级、恢复、重放。
Oracle/Mandatory：每 Tenant 恰一确定性 COMPLETED rollout+GLOBAL SUCCEEDED stage 指向旧 active release，所有 V1 identity/replay 不变；禁止副作用：重复 migration 换 ID 或新增业务 event。
归因：dimension=E；primarySkill=S05；secondarySkills=S02；feedback=E.compatibility；mutant=M05。

### E-02 `route-match-steady` 固定负载 — 3 分
来源：README fixed performance `route-match-steady`；Fixture：250 routes/20 weighted、64 concurrency、100k；动作：规定 HTTP selector/timer。
Oracle/Mandatory：`>=700/s`、p95 `<=180ms`、5xx=0，逐样本 route/hash 与 oracle 一致；禁止副作用：不得预热计入、缩 route set 或只校延迟。
归因：dimension=E；primarySkill=S14；feedback=E.route-performance；mutant=M01。

### E-03 `hot-tenant-limit` 固定竞争负载 — 2 分
来源：README fixed performance `hot-tenant-limit`；Fixture：50k requests/1000 tokens；动作：公开 64-concurrency workload。
Oracle/Mandatory：`>=500/s`、p95 `<=250ms`、精确 allow/throttle、5xx=0；禁止副作用：不得 per-process quota 或把 throttles 当成功 mutation。
归因：dimension=E；primarySkill=S14；feedback=E.rate-performance；mutant=M03。

### E-04 `breaker-reload-recovery` 恢复负载 — 2 分
来源：README fixed performance 同名场景；Fixture：20k results、100 release/rollback、kill 2、4 replacements；动作：公开 barriers/timer。
Oracle/Mandatory：`<=60s` 排空、revision 隔离、breaker/window/active release 不变量成立；禁止副作用：不得 random sleep、缩操作或绕过生产 workers。
归因：dimension=E；primarySkill=S14；feedback=E.recovery-performance；mutant=M09。

## Mutants

| Mutant | 领域缺陷 | 必杀 Case |
|---|---|---|
| M01 | matcher 漏 specificity/tie-break 或 wildcard 语义错 | A-01、E-02 |
| M02 | canary 用随机数/浮点或重试换 bucket | A-02 |
| M03 | rate window 进程内 authority | A-03、B-03、E-03 |
| M04 | 迟到旧 release result 污染新 breaker | A-04、B-04 |
| M05 | rollout 不冻结 first-order/prior release 或迁移 ID 不稳 | A-05、E-01 |
| M06 | release activation/rollback 逐 route 提交 | B-01、C-02 |
| M07 | idempotency 保存晚于 gateway/release effect | B-02、C-01 |
| M08 | pause/cancel/rollback 不 fence advance lease | B-05、D-03 |
| M09 | expired rollout worker 可重复/跳 stage | C-03、E-04 |
| M10 | outbox 非原子或 snapshot 多时点拼接 | C-04、D-04 |

## Coverage mapping

**README / Manager → Case**

| README/Manager requirement | Cases |
|---|---|
| Route match/canary/rate/breaker/release | A-01..A-04、B-01..B-04、C-01..C-02 |
| Event/recovery | C-01..C-04 |
| RegionalRollout | A-05、B-05、C-03、D-03、E-01 |
| HTTP/UI/snapshot | D-01..D-04 |
| Migration/performance | E-01..E-04 |

**旧 H → Case**

| 旧 H family | v2 Cases |
|---|---|
| H-01 | 不计分 preflight |
| H-02..H-04 | A-01..A-04、D-01..D-02 |
| H-05..H-08 | B-01..B-04、C-01..C-02、C-04 |
| H-09 | E-01 |
| H-10..H-11 | A-05、B-05、C-03、D-03..D-04（部分 blocked） |
| H-12 | E-02..E-04 |
| H-13 | D/项目证据，不另计分 |

## Evidence/hard caps

保存 fixture、HTTP/upstream ledger、DB-time/barrier/receiver transcript、独立 matcher/window/rollout oracle 与 snapshot digest。错误 route authority、超发、release/rollback partial 或终态回退总分上限 35；幂等第二效果上限 30；stale worker 越 fence/Work 丢失上限 40；迁移改 V1 identity/replay 上限 35；性能后不变量失败则对应 E Case 为 0 并应用 cap。blocked Case 不得改权或以私有旧 E2E 填合同。
