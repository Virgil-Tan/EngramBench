# PermitForge Hidden Test v2 详细设计

> 共享计分、隔离、证据和报告规则见 [`docs/hidden-test-v2-standard.zh-CN.md`](../../../docs/hidden-test-v2-standard.zh-CN.md)；本文件只细化 PermitForge 的 task-specific 合同、oracles、fixtures 与 cases。冲突时以公开 Task Contract 为准。

## 1. 目标、权威来源与合同缺口

本方案将原 H-01～H-13 拆成 **48 个独立、确定性、Harness-owned 黑盒 case**。测试不得 import Candidate 源码、ORM、私有表或 test helper。

权威顺序：`workspace/README.md` V1 → `orchestration/user-and-manager-prompts.zh-CN.md` 的
`FIXED_MANAGER_MESSAGE` → `AGENTS.md`/`CONTEXT.md` → 本测试映射。

必须先冻结以下 contract gaps：

- `PF-GAP-01`：claim 决策要求 raw `claimToken`，但 `ReviewClaim` exact shape 不含 token，claim endpoint 只说返回一个 leased ReviewClaim，seed/snapshot 也不提供 token。正式 evaluator 不能猜 `{claimToken}` envelope；冻结前不对任何成功 Decision、Decision race 或 Stage completion 路径固定计分，只能验证 Claim 本身、seeded immutable history 和不依赖 token 的公开行为。
- `PF-GAP-02`：FINAL 说 legacy one-stage response 可在 “legacy media type” 省略 stage 字段，但没有发布 media type、header 或 negotiation 规则。测试只能比较迁移前保存的 V1 replay，不能自行定义新旧表示。
- `PF-GAP-03`：`INVALID_REVIEW_STAGES` 包含 invalid ordinal trigger，但公开 stages request 只有 `{name,reviewPolicy}`、没有 ordinal。Evaluator 不得添加一个输入字段来制造该错误。
- `PF-GAP-04`：Manager 要求 stale Claim/Decision 返回 `REVIEW_STAGE_CHANGED`，但公开 ReviewClaim/Decision shape 没有 `stageId/stageOrdinal`。系统可由内部 captured stage fencing 判定，但 snapshot 无法直接证明 Claim 属于哪一 Stage；需发布可观察关联或明确只以行为结果验证。
- `PF-GAP-05`：Stage `name` 只发布为 string，没有空值、长度、字符集或唯一性规则；`INVALID_REVIEW_STAGES` 虽提到 invalid name，但没有 exact trigger。Evaluator 不得把 empty/duplicate name 自行定义为非法。

缺口未解决时，测试只能覆盖已发布行为，不能把 evaluator 的产品选择计入分数。

## 2. 公开测试 seams

| Seam | 允许操作 | 禁止操作 |
| --- | --- | --- |
| Published commands | README 精确命令、exit code、进程和日志 | import 内部 service/helper |
| HTTP/OpenAPI | health、OpenAPI、全部公开 `/api/v1` routes | debug/private route |
| Verification snapshot | ADMIN_TOKEN 下同一 point-in-time resources/work/events | 直查 Candidate tables |
| Production browser | production build、系统 Chromium、可见控件 | 注入 store/直接内部调用 |
| Webhook receiver | 控制 ACK/500/断线并记录公开请求 | 读取 outbox 私有状态 |
| Recovery barrier | published worker/dispatcher points | random sleep 猜 critical point |
| Process boundary | 独立 API/Worker/dispatcher、signals/restart | 单进程对象模拟并发 |
| V1→FINAL checkpoint | V1 binary 写真实历史，FINAL 同库迁移 | FINAL 伪造 V1 数据 |

## 3. Runner 与结果接口

每 case 使用独立数据库、端口、receiver、barrier 与 data root；迁移 case 保留同一库切换 binary；性能 case 独占固定 4 CPU/8 GiB。case 必须声明唯一 `id/dimension/weight/prerequisites`，all-or-nothing 获得权重，并保存 evidence digest。

结果区分 `passed|failed|excluded|evaluator_error` 和最终 `accepted|rejected|invalid|evaluator_error`。`excluded` 只用于任务包确实没有某阶段资产；正式完整实验不得用它隐藏 migration 或 contract gap。

## 4. 独立 oracles 与 fixtures

### 4.1 Revision/quorum oracle

Evaluator 自己计算：

1. Revision 从 1 连续且历史 canonical fields/digest/policy 永不变化；
2. 每个 ReviewPolicy 的 roles/reviewerIds 排序去重，role quota 与 total threshold 均可满足；
3. 每 Reviewer/Revision 最多一个 Decision，Claim/Decision 的 application/revision/reviewer/role 完全一致；
4. APPROVED 仅在每个 role quota 和 total threshold 同时满足且没有 veto REJECT；
5. REQUEST_CHANGES 立即终止本 Revision 并仅允许 revision+1；veto REJECT 或 quorum impossible 立即 REJECT；
6. FINAL 中只有 current ACTIVE Stage 可收 Decision；stage completion 与下一 Stage activation 原子；只有全部 Stages completed 才签发 Permit。

Worked example：Stage policy `security 2/3 (veto), legal 1/2, requiredTotal=3`。两个 security + 一个 legal APPROVE 才通过；一个 security REJECT 立即否决；普通 legal REJECT 后若仍有另一 legal 可 APPROVE，不应提前拒绝。

### 4.2 Deterministic fixtures

- 私有 seed 决定 UUID、reviewer/role 排序、时间与交错；基准 `T0` 来自可观察数据库时间；
- `F-V1-POLICY`：1/10 roles、边界 quotas、veto/non-veto、canonical fields；
- `F-CLAIMS`：eligible/ineligible、leased/expired/reclaimed Claims；
- `F-DECISIONS`：approve/veto/request-changes/quorum-impossible paths；
- `F-IDEMPOTENCY`：全部 mutation 的 replay/conflict/unknown response；
- `F-WORK-EVENT`：PENDING/LEASED/terminal Deadline Work 与未 ACK events；
- `F-FINAL-STAGES`：1、2、5 Stages、相同/不同 roles、stale prior-stage Claims；
- `F-MIGRATION`：V1 all states、saved replay、pending/leased Work、undelivered event；
- `F-BROWSER` 与 README 精确 `perf-v1`。

expected digest 由 evaluator 的 RFC 8785 + SHA-256 实现计算，不调用 Candidate canonicalizer。

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
- 前置：clean checkout、空 PostgreSQL。
- 操作：install、migrate×2、build，分别启动 API/Worker/dispatcher。
- 可观察断言：命令 non-interactive、失败非零；production UI/health/OpenAPI 可达；角色为独立进程；SIGTERM 后无泄漏。

### A-02 Repeatable migration — 2
- 前置：空库及已创建 V1 Application/Claim/Decision fixture。
- 操作：前后各执行 migration×2。
- 可观察断言：Application/Revision/Claim/Decision/Permit/Work/Event identity 与 immutable payload 不变；失败 migration 不留下 partial behavior。

### A-03 Strict atomic seed — 2
- 前置：合法全资源 seed。
- 操作：同 version+digest replay，并逐个注入 unknown field、duplicate、broken ref、revision gap、policy/claim/decision/state/time/digest error、same version different digest。
- 可观察断言：合法 replay no-op；冲突 `SEED_VERSION_CONFLICT`；非法 seed 全回滚且无 Work/Event/idempotency effect。

### A-04 HTTP validation and error envelope — 2
- 前置：API ready。
- 操作：逐 route 测 unsupported media、malformed JSON、unknown keys、bad UUID/enum/range、bad cursor/token、missing resource。
- 可观察断言：published status/code 与 exact error envelope；所有 rejected mutations 零副作用。

### A-05 Lists, details and snapshot — 2
- 前置：121 Applications、多个 Revisions/Claims/Decisions。
- 操作：default/1/100 pagination、多页 cursor、malformed cursor、detail/revision/snapshot reads。
- 可观察断言：无重漏、排序精确、exact shapes；snapshot 同一 point-in-time 并递归省略 tokens/secrets。

### A-06 Submit immutable Revision 1 — 2
- 前置：合法 Applicant/Reviewers。
- 操作：提交边界 fields（含 canonical key order variants）、deadline、1/10 roles；再测 64KiB、deadline 0/>30d、bad policy。
- 可观察断言：合法请求原子创建 SUBMITTED Application、Revision 1、captured policy、Deadline Work 与 event；digest 等于独立 oracle；非法请求零状态。

### A-07 Claim eligibility and lease — 2
- 前置：current Revision 与 eligible/ineligible Reviewers。
- 操作：claim 合法 role，重复 reviewer、错误 role、满 slot、过期后 reclaim。
- 可观察断言：合法 Claim 的公开 ReviewClaim 字段与 captured tuple 一致、lease duration/attempt 合同成立；非法为 `REVIEW_SLOT_UNAVAILABLE`；token/authorization 不进 snapshot/log。PF-GAP-01 未冻结前不规定成功 response 中 token 的字段位置或外层 envelope。

### A-08 Quorum state projection — 2
- 前置：exact seed 创建满足/未满足 role quota、total threshold 与 ApprovedPermit 的合法 immutable histories。
- 操作：通过 Application detail、revision read 与 snapshot 读取各 history。
- 可观察断言：只有同时满足全部 role quota、total threshold 且无 veto 的 history 可为 APPROVED 并暴露一个 exact Permit；其他 history 不得暴露 Permit。PF-GAP-01 未冻结前不提交 Decision。

### A-09 Veto and impossible-quorum projections — 2
- 前置：exact seed 创建 veto REJECT、仍可达 non-veto REJECT、quota 不再可达三类合法 histories。
- 操作：读取 Application/detail/snapshot，并用独立 quorum oracle 重算。
- 可观察断言：veto history 为 REJECTED；仍可达 history 不得伪造 terminal approval/rejection；不再可达 history 为 REJECTED；任何 REJECTED history 无 Permit。PF-GAP-01 未冻结前不提交 Decision。

### A-10 REQUEST_CHANGES and replacement Revision — 2
- 前置：exact seed 创建 Revision 1 `CHANGES_REQUIRED` history。
- 操作：以 expectedRevision 创建 Revision 2，并尝试 stale/skip expectedRevision。
- 可观察断言：Revision 1 immutable；Revision 2 恰为 +1 并捕获新 fields/policy/deadline；stale/skip revision 零副作用。PF-GAP-01 未冻结前不提交 old-Claim Decision。

### A-11 Deadline expiry — 2
- 前置：due SUBMITTED/UNDER_REVIEW、已 terminal、刚完成 quorum Applications。
- 操作：运行 Worker 穿过真实 deadline。
- 可观察断言：仅 undecided current Revision 一次性 EXPIRED；无 Permit；terminal/decision winner 不被覆盖；Deadline Work 安全终结。

### A-12 Domain events — 2
- 前置：经公开非 Decision mutation 形成 submit→claim→replacement/expire histories。
- 操作：按 aggregateId/afterSequence/limit 查询。
- 可观察断言：sequence 从 1 连续、type 属于发布集合、payload `{}`、排序稳定；rollback 无 event，success state/event 同时可见。

### A-13 FINAL staged creation — 2
- 前置：Manager 发布、合法 reviewers。
- 操作：创建 1、2、5 Stages；再测 0/6、invalid nested policy、同时传 legacy policy+stages。
- 可观察断言：Stage ordinals 连续、仅 Stage 1 ACTIVE、后来 PENDING；已发布非法输入 `INVALID_REVIEW_STAGES` 且零 aggregate。PF-GAP-03/05 下不发送 ordinal 字段，也不把 empty/duplicate name 判为失败。

### A-14 FINAL current-Stage claim eligibility — 2
- 前置：三 Stage Application，Stage 1 ACTIVE、later Stages PENDING。
- 操作：按 Stage 1 captured policy claim 合法/非法 role，并读取 `/stages` 与 detail。
- 可观察断言：Claim eligibility 只来自 current ACTIVE Stage policy；PENDING Stage 不变且一次仅一 ACTIVE；completed-stage/Decision progression 在 PF-GAP-01/04 冻结前不计分。

### A-15 FINAL compatibility and snapshot — 2
- 前置：V1 one-stage 与 FINAL multi-stage 共存。
- 操作：旧客户端继续 submit/claim/read，重放已保存的 V1 Decision response，并读取 `/stages`、detail、OpenAPI、FINAL snapshot。
- 可观察断言：V1 IDs/semantics 保留；FINAL resources 只新增 `reviewStages`；Stage exact shape/order；PF-GAP-01/02 未冻结前只比较 saved V1 Decision/replay，不猜 claimToken envelope 或 legacy media type。

## 7. B — 数据正确性、幂等与并发（25 分）

### B-01 Canonical fields and Revision immutability — 2.5
- 前置：语义相同但 JSON key order 不同的 fields 与多 Revision history。
- 操作：创建、读回、replace，并在后续 policy/Stage 变化后重读旧 Revision。
- 可观察断言：同语义 digest 相同；旧 fields/policy/digest bitwise semantic 不变；revision 连续且无 overwrite。

### B-02 Independent quorum projection — 2.5
- 前置：exact seed 的多个 role quota/total/veto immutable histories。
- 操作：通过公开 reads 枚举 histories 并由 oracle 重算。
- 可观察断言：Application/Permit projection 等于 oracle；total 满足但 role 未满、roles 满足但 total 未满均不得 APPROVED；veto history 优先 REJECTED。PF-GAP-01 未冻结前不提交 Decision。

### B-03 Reviewer Claim uniqueness under contention — 2.5
- 前置：同 Reviewer/Revision/role 可 claim。
- 操作：两个 API 64 路用 distinct keys 并发 claim。
- 可观察断言：同 Reviewer/Revision 最多一个 current leased Claim；响应为同一 replay 或稳定 slot conflict；attempt/Work/Event 不重复。PF-GAP-01 未冻结前不提交 Decision。

### B-04 Claim lease reclaim race — 2.5
- 前置：Claim 接近 expiry、另一 Reviewer 可争同 role slot。
- 操作：旧 Claim expiry 与 reclaim/new Claim 确定性交错。
- 可观察断言：最多一个 current leased Claim；attempt 单调；expired Claim 不恢复 LEASED，不占用已回收 slot。PF-GAP-01 未冻结前不提交 token-dependent Decision。

### B-05 Replacement Revision versus Claim — 2.5
- 前置：exact seed 创建 current CHANGES_REQUIRED Revision 与已保留的旧 Claim history。
- 操作：双 API 并发创建 replacement Revision 与 reclaim/claim。
- 可观察断言：replacement 只有一个 winner；旧 Revision/Claims immutable 且不能成为新 current authority；新 Claim 只绑定 current Revision。PF-GAP-01 未冻结前不提交 Decision。

### B-06 Deadline versus replacement — 2.5
- 前置：临界 deadline 与 exact seed 的 CHANGES_REQUIRED Revision。
- 操作：Worker expiry 与 replacement Revision request 交错。
- 可观察断言：只有一个 expiry/replacement winner；rolled-back path 无 event；过期后旧 Claim/replacement 不能复活 Application。PF-GAP-01 未冻结前不并发 Decision。

### B-07 Unknown-response durable replay — 2.5
- 前置：response shield 覆盖 submit/claim/revision 和 FINAL staged submit；PF-GAP-01 未冻结前排除 Decision。
- 操作：完整 upstream response 后断开，API restart 后相同 key retry。
- 可观察断言：原 status/semantic JSON 重放；Application/Revision/Claim/Decision/Permit/Stage/Event 各最多一个 effect。

### B-08 Same-key multi-API authority — 2.5
- 前置：两个 API 共库。
- 操作：对 submit/claim/revision/staged-submit 做 64-way 相同 key/body first use、same key/different body、第三 API restart replay；PF-GAP-01 未冻结前排除 Decision。
- 可观察断言：首批唯一结果；conflict `IDEMPOTENCY_CONFLICT` 零副作用；process-local map 无法通过。

### B-09 Atomic staged creation — 2.5
- 前置：合法五 Stage body 与一个 invalid nested policy fixture。
- 操作：两个 API 并发相同 key/body staged submit，并测试同 key different body。
- 可观察断言：一个 Application/Revision 及完整五 Stage 集合全有或全无；仅 Stage1 ACTIVE；replay 结果稳定，conflict 零副作用。

### B-10 Current Stage Claim versus deadline — 2.5
- 前置：Stage1 ACTIVE 且接近 Application deadline。
- 操作：三个冻结交错 seed 并发 claim 与 Deadline Worker expiry。
- 可观察断言：expiry commit 后不能产生新的 LEASED Claim；claim winner 不阻止合法 deadline；terminal Application 无 later-stage activation、Permit 或 event gap。PF-GAP-01/04 未冻结前不提交 stale-stage Decision，也不要求 `REVIEW_STAGE_CHANGED`。

## 8. C — Worker、恢复与持久性（20 分）

### C-01 Deadline Work lifecycle — 2.5
- 前置：future/due/terminal Deadline Work。
- 操作：观察 claim、reclaim、success/cancel/fail 与 drain。
- 可观察断言：exact Work shape；lease fields 仅 LEASED 非空；attempt 单调；terminal retained；drain 定义正确。

### C-02 SIGKILL after `worker.claimed` — 2.5
- 前置：due Application、barrier 持有 claimed。
- 操作：杀 A，lease expiry 后启动 B。
- 可观察断言：B reclaim attempt+1；Application 只 expiry 一次；A 无法提交；Work/Event identity 不重复。

### C-03 SIGKILL after `worker.effect-complete` — 2.5
- 前置：effect-complete barrier。
- 操作：杀 Worker 并 replacement。
- 可观察断言：计算可重做，业务 effect 最终完整一次；不出现已 EXPIRED 但 Work 永久 pending 或第二 event。

### C-04 SIGKILL at `worker.before-commit` — 2.5
- 前置：before-commit barrier。
- 操作：SIGKILL、restart、drain。
- 可观察断言：transaction 全无或全有；Application/Permit/Work/Event 无 partial combination。

### C-05 Expired Work lease fencing — 2.5
- 前置：A 暂停至 lease 过期，B reclaim 完成。
- 操作：释放 A stale attempt。
- 可观察断言：A 不能 terminal commit；最终 attempt/owner/result 只反映 B；不会覆盖 replacement Revision 或已存在的 terminal state。

### C-06 Review Claim expiry and reclaim — 2.5
- 前置：leased Claim 接近 expiry。
- 操作：暂停旧 claimant，过期后经公开 claim endpoint reclaim，再释放旧请求上下文。
- 可观察断言：旧 Claim 保持 EXPIRED，新 Claim/attempt 唯一且 current；同 role slot 不重复占用。PF-GAP-01 未冻结前不提交 Decision 或猜 token envelope。

### C-07 Unknown webhook ACK — 2.5
- 前置：receiver 持久化完整 event 后隐藏 ACK。
- 操作：kill dispatcher，模拟 500/disconnect，replacement retry。
- 可观察断言：eventId/type/body 稳定、per-aggregate order 递增、bounded retry、无第二 logical Event。

### C-08 Transactional event and dispatcher recovery — 2.5
- 前置：success/rollback transitions、多个 aggregates。
- 操作：并发产生 events，并在 response-received kill/restart。
- 可观察断言：success 与 event 同 transaction，rollback 无 event；sequence 连续；token/authorization/private path 不泄漏。

## 9. D — OpenAPI、UI 与跨层闭环（15 分）

### D-01 OpenAPI validates live traffic — 2
- 前置：FINAL OpenAPI 与 evaluator 独立 schema。
- 操作：对 exact wire 已冻结的 route 采 success/published error traffic；Decision route 只验证已发布 request 与 errors。
- 可观察断言：OpenAPI 3.1 paths/status/body/closed objects/formats 与真实响应一致；仅列 path 不得分。PF-GAP-01 未冻结前不规定 claim success token envelope，也不采 Decision success 作为计分断言。

### D-02 Browser V1 quorum lifecycle — 2
- 前置：production build、真实 DB/API、系统 Chromium。
- 操作：仅可见控件 submit→claim，查看 seeded quorum/terminal histories 并刷新 detail。
- 可观察断言：Revision/policy/quota/Claim/seeded Decision/Permit/history 为 server authority；primary action 不用 direct API 替代。PF-GAP-01 未冻结前不把成功 Decision UI 动作计分。

### D-03 Browser changes and deadline — 2
- 前置：seeded CHANGES_REQUIRED 与临期 Applications。
- 操作：UI 创建 Revision 2、观察旧 Claim、异步 expiry 和 terminal state。
- 可观察断言：immutable history、progress、conflict/recovery 可见；刷新后与 snapshot 一致。

### D-04 Browser multi-stage flow — 2
- 前置：FINAL UI。
- 操作：可见控件创建 1/2/5 Stages、claim current Stage，并查看 seeded completed/terminal histories。
- 可观察断言：动态 Stage/role/quota UI；只 current 可 claim；seeded completed evidence 不变；不得固定两个 Stages。PF-GAP-01/04 未冻结前不把 Stage completion Decision 动作计分。

### D-05 UI states, accessibility and secret boundary — 2
- 前置：slow/offline/401/409/empty fixtures、mobile/desktop。
- 操作：键盘触发 loading/validation/conflict/stale/retry/terminal/permission。
- 可观察断言：labels/focus/keyboard/viewport/contrast 可用；retry 不重复 mutation；token/admin/idempotency/private path 不进 bundle/DOM/log。

### D-06 Snapshot/detail/browser consistency — 2
- 前置：复杂 multi-Revision/multi-Stage histories。
- 操作：跨 detail、revision endpoint、stages、browser、snapshot、events 读取。
- 可观察断言：state/current revision/stage/quota/Decisions/Permit/Work/Event 一致；exact shape/sort/secret omission。

### D-07 Project gates are meaningful — 2
- 前置：clean DB 与全部公开 test commands。
- 操作：逐个执行 unit/integration/e2e/concurrency/recovery/all/test:perf 并外部观察 seams。
- 可观察断言：integration 真 PostgreSQL+HTTP，e2e production Chromium，concurrency≥2 API+2 Worker，recovery barrier+SIGKILL，`test:perf` 运行三个固定场景和后置不变量；0 tests/字符串检查/吞失败均失败。

### D-08 README-to-evidence ledger — 1
- 前置：所有 case evidence。
- 操作：建立 `README→HTTP→OpenAPI→UI(适用)→snapshot/work/event→hidden case` 映射。
- 可观察断言：每节点实际执行，unrun/empty/failed/partial 不得冒充 passing；PF gaps 明确标 partial 而非猜测完成。

## 10. E — 迁移、性能与可运维性（10 分）

### E-01 Populated V1→FINAL migration — 2
- 前置：真实 V1 binary 创建 all states、one-stage policies、Claims/Decisions/Permits。
- 操作：同库 FINAL migration×2，继续旧客户端 submit/claim/read，并 replay 已保存的 Decision response。
- 可观察断言：每个 V1 current Revision/policy 迁成一个 Stage；IDs/payloads/Permit 不变；无重复 Stage；旧非 Decision 请求继续工作，Decision 只按保存 response 比较直至 PF-GAP-01 冻结。

### E-02 Saved replay and event identity — 2
- 前置：V1 success/conflict/unknown-response replay 与 events。
- 操作：迁移后 retry/read。
- 可观察断言：原 status/body/identity、eventId/type/body/sequence 不改；PF-GAP-02 未解时以 saved V1 bytes 为唯一 legacy oracle。

### E-03 Pending Claim/Work across migration — 2
- 前置：V1 leased Claims、PENDING/LEASED Deadline Work、undelivered events。
- 操作：FINAL migration、lease expiry/reclaim、replacement drain。
- 可观察断言：applicationId/deadline/attempt/lease 保留；stale Work owner 不可提交，Claim expiry/reclaim 合法；FINAL roles 处理旧 payload。PF-GAP-01 未冻结前不提交 stale claimToken Decision。

### E-04 `application-current-read` performance — 1
- 前置：README 精确 perf-v1 seed、独占 4 CPU/8 GiB。
- 操作：原样运行 published selector、64 clients、10s warmup、60s measure。
- 可观察断言：≥350/s、p95≤120ms；只计完整且 revision-consistent responses；unexpected 5xx=0，负载后 read invariants 成立。

### E-05 `application-submit` performance — 1
- 前置：README 精确 disjoint measured identities、独占 4 CPU/8 GiB。
- 操作：原样运行 published request/selector、64 clients、10s warmup、60s measure。
- 可观察断言：≥100/s、p95≤350ms；每个成功 response/Revision/Deadline Work/Event 通过 oracle；unexpected 5xx=0。

### E-06 `deadline-recovery` performance — 1
- 前置：精确 10,000 due Applications/Work，两 Worker claimed 后 kill。
- 操作：lease expiry 后启动 replacements，spawn 起计 75s。
- 可观察断言：全部只 EXPIRED 一次、无 Permit/nonterminal Work/stale commit，且满足 README 的 75s 阈值。

### E-07 Operability cleanup and reproducibility — 1
- 前置：E-04～E-06 各 workload 已完成或稳定失败。
- 操作：正常终止 evaluator-owned process groups，检查端口/managed root/log，并同 seed 重跑一个非性能 Case。
- 可观察断言：无遗留进程、端口或锁；日志无秘密；同 Submission+seed 的非性能结果与 evidence digest 可复现。

## 11. Hard caps、invalid 与 evaluator_error

| 失败 | 总分上限 |
| --- | ---: |
| clean build/migration/production boot 失败 | 25 |
| revision immutability、quorum、唯一终态或 Stage atomicity 失败 | 35 |
| durable idempotency 产生第二 effect | 30 |
| success 无 event、rollback 有 event、retry 改 event | 40 |
| pending Work 丢失或 stale Work lease 可提交 | 40 |
| migration 丢历史、改 saved replay 或破坏旧客户端 | 35 |
| 性能后核心不变量失败 | 对应 case 0 并应用 correctness cap |

读取 hidden assets、硬编码 fixture/seed、访问 workspace 外私有资产、容器逃逸或伪造 evidence 为 `invalid`。Evaluator 的 Docker/PostgreSQL/Chromium/端口故障为 `evaluator_error`，不算 Candidate 失败。watchdog 只防基础设施永久挂起，不创造产品行为时限。

## 12. Anti-fake-green

1. Candidate tests 只在 D-07 证明 gate 真实性；
2. digest/quorum/stage expected values 来自 evaluator 独立 oracle；
3. Candidate OpenAPI 不自证 Candidate traffic；
4. 文件、字符串、test name、日志声明和 exit 0 不是行为证据；
5. recovery 必须 barrier，concurrency 必须独立 OS processes；
6. performance 后重算 Revision/Claim/Decision/Permit/Stage/Work/Event 全不变量；
7. 所有实验 arm 使用同一 image/seed/cases/weights/thresholds。

## 13. Requirement mapping

| 原 gate | v2 cases |
| --- | --- |
| H-01/H-02 | A-01～A-05、D-01、D-05 |
| H-03/H-04 | A-06～A-12、B-01～B-06 |
| H-05/H-06 | B-07～B-08 |
| H-07/H-08 | C-01～C-08 |
| H-09 | E-01～E-03 |
| H-10/H-11 | A-13～A-15、B-09～B-10、D-04 |
| H-12 | E-04～E-07 |
| H-13 | D-07～D-08 |

### 13.1 Case contract-map 与反馈代码

`V1` 指 `workspace/README.md` 对应标题；`MGR` 指
`orchestration/user-and-manager-prompts.zh-CN.md` 的 `FIXED_MANAGER_MESSAGE`。私有失败码统一为
`PF_<CASE_ID>_<ASSERTION>`；公开报告只返回下表 category，不泄露 claim、fixture、oracle 或交错细节。

| Case | 唯一 Public Contract 来源 | public feedback category |
| --- | --- | --- |
| A-01 | V1 `Required non-interactive commands`、`Environment` | `command_boot` |
| A-02 | V1 repeatable `db:migrate`、immutable resource identity | `migration_repeatability` |
| A-03 | V1 `Seed contract` | `seed_atomicity` |
| A-04 | V1 `HTTP and OpenAPI 3.1`、published errors | `http_contract` |
| A-05 | V1 list/detail/revision/snapshot contracts | `read_snapshot` |
| A-06 | V1 Application submit/Revision 1/digest/deadline | `application_submit` |
| A-07 | V1 Claim eligibility/lease；PF-GAP-01 limits envelope | `claim_lifecycle` |
| A-08 | V1 quorum/ApprovedPermit invariants via seeded history | `quorum_projection` |
| A-09 | V1 veto/quorum-impossible invariants via seeded history | `rejection_projection` |
| A-10 | V1 contiguous replacement Revision route | `revision_replacement` |
| A-11 | V1 Deadline expiry policy | `deadline_lifecycle` |
| A-12 | V1 published non-Decision Domain Event transitions | `domain_events` |
| A-13 | MGR staged creation/body/count/nested policy | `stage_creation` |
| A-14 | MGR current ACTIVE Stage Claim eligibility；PF-GAP-01/04 exclude progression | `stage_claim` |
| A-15 | MGR migration/legacy compatibility/FINAL snapshot | `final_compatibility` |
| B-01 | V1 canonical fields/digest/Revision immutability | `revision_correctness` |
| B-02 | V1 quorum invariants via seeded public projection | `quorum_correctness` |
| B-03 | V1 Reviewer/Revision Claim uniqueness | `claim_concurrency` |
| B-04 | V1 Claim lease expiry/reclaim | `claim_reclaim` |
| B-05 | V1 replacement Revision/current authority | `revision_concurrency` |
| B-06 | V1 Deadline-versus-replacement serialization | `deadline_concurrency` |
| B-07 | V1 durable idempotency；PF-GAP-01 excludes Decision | `idempotency_replay` |
| B-08 | V1 idempotency across API processes；PF-GAP-01 excludes Decision | `idempotency_concurrency` |
| B-09 | MGR staged creation atomicity | `stage_atomicity` |
| B-10 | MGR current Stage Claim versus V1 deadline | `stage_concurrency` |
| C-01 | V1 PERMIT_DEADLINE Work schema/lifecycle | `work_lifecycle` |
| C-02 | V1 `worker.claimed` barrier/reclaim | `worker_recovery` |
| C-03 | V1 `worker.effect-complete` barrier | `worker_recovery` |
| C-04 | V1 `worker.before-commit` transaction boundary | `worker_atomicity` |
| C-05 | V1 Work lease fencing | `worker_fencing` |
| C-06 | V1 Claim expiry/reclaim；PF-GAP-01 excludes Decision fencing | `claim_recovery` |
| C-07 | V1 dispatcher unknown-ACK/retry | `event_delivery` |
| C-08 | V1 transactional events/order/secret boundary | `event_atomicity` |
| D-01 | V1+MGR OpenAPI/live traffic；PF-GAP-01 excludes success envelope | `openapi_runtime` |
| D-02 | V1 real UI submit/claim/seeded histories | `browser_v1` |
| D-03 | V1 real UI replacement Revision/deadline | `browser_revision` |
| D-04 | MGR real UI staged create/current Claim；gapped progression excluded | `browser_stages` |
| D-05 | V1 UI states/accessibility/secret boundary | `ui_accessibility` |
| D-06 | V1+MGR seeded detail/snapshot/browser consistency | `cross_layer_evidence` |
| D-07 | V1 all `test:*` command contracts including `test:perf` | `project_gates` |
| D-08 | V1 project verification/handoff evidence | `evidence_closure` |
| E-01 | MGR V1→FINAL migration and saved Decision replay | `migration_compatibility` |
| E-02 | V1 saved replay/Event identity + MGR preservation | `migration_replay` |
| E-03 | V1 pending Claim/Work continuity；PF-GAP-01 excludes Decision | `migration_pending_work` |
| E-04 | V1 `application-current-read` | `performance_read` |
| E-05 | V1 `application-submit` | `performance_submit` |
| E-06 | V1 `deadline-recovery` | `performance_recovery` |
| E-07 | V1 cleanup/log secrecy + v2 reproducibility standard | `operability_cleanup` |

## 14. Calibration mutants

| Mutant | 必须命中 |
| --- | --- |
| process-local idempotency | B-07、B-08 |
| digest 使用非 canonical JSON | A-06、B-01 |
| total threshold 满足就忽略 role quota（seeded projection） | A-08、B-02 |
| non-veto REJECT 永不检测 quorum impossible（seeded projection） | A-09、B-02 |
| Deadline 覆盖已 APPROVED Application | A-11、B-06 |
| Work lease 无 fencing | C-02～C-05 |
| webhook retry 新 eventId | C-07 |
| Stage 创建 partial commit | A-13、B-09 |
| migration 不 backfill one Stage | E-01 |
| migration 重写 saved replay | E-02 |
| OpenAPI 只列 paths | D-01 |
| UI 固定两个 Stages | D-04 |
| project tests 只检查文件 | D-07 |
| performance 不验 published post-load invariants | E-04～E-06 |

gold 通过全部适用 cases；每 mutant 被预期 case 定向捕获；同 seed 连跑三次一致后才冻结 evaluator。

## 15. 实施顺序与完成标准

1. A-01/A-03/A-06 打通 command→HTTP→snapshot 与 digest oracle；
2. 先解决 PF-GAP-01，再新增独立、非替换性的 Decision/Stage-completion Cases；
3. B-02/B-07/B-08 打通 quorum oracle、response shield、多 API；
4. C-02/C-05/C-07 打通 barrier、SIGKILL、receiver；
5. A-13/A-14/B-09 打通 FINAL Stage creation/current-claim；
6. D-01/D-02/D-04 打通 contract validator 与 Chromium；
7. E-01～E-03 接入真实 V1 checkpoint，最后实现性能、caps、reports、mutants。

正式使用前：48 个 case 唯一且总分精确 100；五个 gaps 已解决或对应 assertion 不进入评分；gold 全过、mutants 被捕获、三次无功能 flake；实验 arm 不得改变任何 evaluator 输入或阈值。
