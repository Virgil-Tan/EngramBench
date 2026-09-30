# AccessSentinel Hidden Test v2 详细设计

> 共享计分、隔离、证据与报告规则见 [`docs/hidden-test-v2-standard.zh-CN.md`](../../../docs/hidden-test-v2-standard.zh-CN.md)；本文件只细化 AccessSentinel 的 task-specific cases、oracles、fixtures 与 contract gaps。公开 Task Contract 始终优先。

## 1. 目标、权威来源与合同缺口

本方案将 H-01～H-26 拆为 **53 个独立、确定性、Harness-owned 黑盒 case**。Evaluator 只用公开命令、HTTP/OpenAPI、production Chromium、verification snapshot、webhook、barrier 与 OS process seams。

权威顺序：`workspace/README.md` V1 → `orchestration/manager-prompt.zh-CN.md` 固定 Manager 消息 → `AGENTS.md`/`CONTEXT.md` → 本文件。

正式 runner 前必须冻结：

- `AS-GAP-01`：`POST .../reviews` 只说“records the review”，没有精确发布 request body。Evaluator 不得自行规定是否为 `{reviewerId,decision,comment}`；成功 review cases 需使用补充合同后的 body。
- `AS-GAP-02`：V1 要求 grant 对 stale “region authority” fail closed、E2E H-21 要测 Region fence，但 V1 没有发布创建/推进 Region revocation authority 的路由或 seed resource。Manager 的 RegionalQuarantine 可以验证隔离，但不能反推一个未发布的 V1 Region revocation API。
- `AS-GAP-03`：V1 没有枚举 Domain Event type 名称或 exact payload。测试只能验证事务性、identity、sequence、secret boundary 与 retry stability，不能发明 event type/payload。
- `AS-GAP-04`：Manager 定义 FINAL 新资源 exact shapes，却没有发布其 snapshot key 大小写形式；固定消息写的是类型名，已有 evaluator 约定 lowerCamel keys 不是公开合同。正式测试前需明确四个 key。
- `AS-GAP-05`：Manager 要求 RetrospectiveReview 在 Session 终态后 24 小时内完成，但没有公开可控时钟或晚于 24h 时的 stable error。可用真实短窗口测正常路径，不能靠改 Candidate DB 制造过期。

缺口未解决时对应节点标 `partial`，不得猜测并计失败。

## 2. 公开测试 seams

| Seam | 允许操作 | 禁止操作 |
| --- | --- | --- |
| Commands | README 精确 npm commands、exit/process/log | import 内部 service/helper |
| HTTP/OpenAPI | health、OpenAPI、公开 `/api/v1` routes | private/debug routes |
| Snapshot | ADMIN_TOKEN 下单 PostgreSQL point-in-time | 直查 Candidate tables/cache |
| Browser | production build、系统 Chromium、visible controls | browser store 注入/直接内部调用 |
| Webhook | receiver 控制 ACK/500/disconnect | 读 Candidate outbox |
| Barrier | `worker.claimed`、`worker.before-effect`、`dispatcher.response-received` | 发明 effect-complete/before-commit 或随机 sleep |
| Processes | 多 API/Worker/dispatcher、SIGTERM/SIGKILL/restart | 单进程对象模拟 topology |
| Migration | V1 binary 造状态，FINAL 同库迁移 | FINAL 伪造 V1 checkpoint |

## 3. Runner/结果接口

每 case 独立数据库、端口、receiver、barrier 与 managed root；迁移 case 同库切换 binary；性能 case 独占运行且不与其他 evaluator workload 并行。case 唯一声明 `id/dimension/weight/prerequisites`，mandatory assertions all-or-nothing，证据只保存结构化摘要与 digest。

结果区分 `passed|failed|excluded|evaluator_error` 和 `accepted|rejected|invalid|evaluator_error`。正式完整运行不允许默认 exclude migration 或某条 performance scenario。

## 4. 独立 oracles 与 fixtures

### 4.1 Authority/risk oracle

Evaluator 独立计算：

- Session family 只有一个 ACTIVE generation；旧 token reuse 后全 family REVOKED；
- DeviceTrustRevision 不可变且 current trusted 唯一；tenant/principal/device/session/grant epochs 单调；
- AccessRequest 接受时冻结 policy/risk/trust/session generation/epochs/location watermark，后续 publication/replay 不改 basis；
- risk score 从 0 加 frozen weights，reasons 字典序；`<=lowMax` LOW、`<=reviewMax` REVIEW、否则 HIGH，policy DENY 强制 HIGH；
- LOW 可直接 grant，REVIEW 需独立 ACTIVE reviewer，HIGH/policy deny 永不 grant；
- grant check 任一 frozen fence/TTL/scope stale 即 false；Audit per tenant 从 1 连续且 digest 为 `SHA256(previousDigest || RFC8785(entry without digest))`；
- FINAL BreakGlass 精确二人 quorum、scope 和不可绕过 fences；quarantine revision CAS、普通 grant fail closed；review independence 与 guarded release。

### 4.2 Location oracle

按 `(observedAt,deviceSequence,observationId)` 重排；watermark 内十分钟 late observation 触发确定性 projection rebuild，更老 observation terminal `LOCATION_TOO_LATE` 且 projection 不变；duplicate identity 不得重复 flags。

### 4.3 Fixtures

- 私有 `evaluationSeed` 决定 UUID、时间、地理坐标、规则、interleavings；
- `F-IDENTITY`：多 tenant/principal/device/trust/session families；
- `F-POLICY-RISK`：deny-overrides、threshold boundaries、immutable revisions；
- `F-LOCATION`：duplicate/out-of-order/bounded-late/too-late/impossible travel；
- `F-ACCESS`：LOW/REVIEW/HIGH、batch、review/grant/revoke/expiry；
- `F-IDEMPOTENCY`：每 mutation replay/conflict/unknown response；
- `F-WORK-EVENT-AUDIT`：全部 Work kinds、leased attempts、events/Audit histories；
- `F-BREAKGLASS`：quorum/scope/quarantine/close/expiry/review/release；
- `F-MIGRATION` 与 README 八个 exact performance datasets。

## 5. 计分

| 维度 | 分值 | cases |
| --- | ---: | ---: |
| A. 需求与公共接口覆盖 | 30 | 16 |
| B. 数据正确性、幂等与并发 | 25 | 10 |
| C. Worker、恢复与持久性 | 20 | 8 |
| D. OpenAPI、UI 与跨层闭环 | 15 | 8 |
| E. 迁移、性能与可运维性 | 10 | 11 |
| **总计** | **100** | **53** |

## 6. A — 需求与公共接口覆盖（30 分）

### A-01 Clean commands and boot — 2
- 前置：clean checkout、空库。
- 操作：`npm ci`、migrate×2、build，独立启动 API/Worker/dispatcher。
- 可观察断言：production UI/health/OpenAPI 可达；进程角色独立；命令 non-interactive、失败非零；SIGTERM 无残留。

### A-02 Repeatable populated migration — 2
- 前置：V1 全资源合法 fixture。
- 操作：空库/有数据各 migration×2，再由公开命令启动全部生产角色并读取公开观察面。
- 可观察断言：IDs、immutable revisions、epochs、Audit/Event/Work/replay 不变；重复迁移不新增或改写业务状态。

### A-03 Strict atomic seed — 2
- 前置：合法 seed。
- 操作：相同 canonical replay，再逐个注入 unknown/nested field、duplicate、broken ref、digest/revision/interval/audit-link/raw-secret/state/time error、same version different content。
- 可观察断言：合法 no-op；conflict 稳定失败；每个非法 seed 后 snapshot 不变且 seed 不产生 Work/Event。

### A-04 HTTP/OpenAPI/error contract — 2
- 前置：API ready。
- 操作：逐 route 测 non-JSON、malformed JSON、unknown key、invalid UUID/enum/range/query、auth、resource miss。
- 可观察断言：published status/code 与 exact envelope；OpenAPI 3.1 exact requests/responses；失败零副作用。

### A-05 Tenant isolation and read routes — 2
- 前置：两个 tenants、known foreign 和 unknown identities。
- 操作：读取 tenants/principals/devices/request，并用 foreign IDs 发 tenant-scoped mutations。
- 可观察断言：collection deterministic；foreign/unknown 均为相同稳定 403 envelope、不泄露存在性；无跨 tenant state/Event/Audit。

### A-06 Snapshot and Audit chain — 2
- 前置：多 tenant 安全 transitions。
- 操作：读取 ADMIN snapshot 并独立重算每条 Audit digest。
- 可观察断言：16 个 V1 resource arrays exact shape/sort/once，同一 point-in-time；Audit sequence contiguous/digest valid；raw tokens/credentials/authorization/admin/nonce/private key 全部省略。

### A-07 Session create/refresh/reuse/revoke — 2
- 前置：trusted active identity。
- 操作：TTL 60/3600 创建，rotate，旧 token reuse，expectedGeneration revoke；测边界/foreign/stale。
- 可观察断言：raw token 只在 committed response；generation+1 且旧 token invalid；reuse 原子 revoke family；replay 不产生新 token/state；秘密不进 snapshot/event/log。

### A-08 Device trust and revocation epochs — 2
- 前置：active device/session/grants。
- 操作：CAS publish trust revision，device/principal/tenant revoke，并尝试 stale publication/epoch。
- 可观察断言：revision immutable、current trusted 唯一；revoke epoch 恰加一并 append Revocation/Audit/Work；stale `REVOCATION_EPOCH_CONFLICT`；sessions/grants fail closed。

### A-09 Policy publish/rollback and frozen basis — 2
- 前置：PolicyBundle、500-rule boundary、RiskModel revisions。
- 操作：publish、rollback to prior rules、接受 request 后再 publish/rollback。
- 可观察断言：revision+1、old immutable、deny overrides allow；accepted request/decision/grant 保持 frozen IDs/digests，不能换成 current authority。

### A-10 Location observation/replay — 2
- 前置：location fixture 与 Worker。
- 操作：提交 duplicate、out-of-order、within-10m late、too-late、边界 longitude/latitude。
- 可观察断言：identity immutable；projection 等于独立 oracle；bounded late rebuild、too-late terminal 且不改 projection；riskFlags 无重漏。

### A-11 Access request and atomic batch — 2
- 前置：valid/stale/foreign/insufficient-assurance identities。
- 操作：single request、1/100 batch、101 与一项非法 batch。
- 可观察断言：合法请求冻结全部 authority fields 并创建 RISK_EVALUATION Work；非法/stale 整体零状态；batch 全有或全无且 no partial Audit/Event。

### A-12 Risk and policy decision — 2
- 前置：LOW/REVIEW/HIGH/policy-deny fixtures。
- 操作：drain risk work，读取决定与被冻结的 policy/risk/trust/location basis；对 HIGH/deny 尝试 grant。
- 可观察断言：score/level/reasons/inputDigest 符合 oracle且唯一；deny/HIGH terminal denied；REVIEW 在没有独立 APPROVE 时不能 grant。AS-GAP-01 未冻结前不发送 review mutation，也不以 review 成功/失败计分。

### A-13 Grant lifecycle and checks — 2
- 前置：LOW、approved REVIEW 与 denied requests。
- 操作：grant with expectedState，cross-process check，explicit revoke，真实 TTL expiry。
- 可观察断言：每 request 最多一个 exact grant、不延长 requested TTL；action/resource/region/frozen IDs 一致；revoke/expiry 后所有 API fail closed；Audit/Event/Work 原子。

### A-14 Work, Events and transition evidence — 2
- 前置：六类 V1 Work 与多 aggregate transitions。
- 操作：查询 snapshot work/events 并触发 success/rollback。
- 可观察断言：Work exact shape/state/terminal；Event identity/aggregate sequence 单调且 transaction-bound；AS-GAP-03 下只断言稳定 type/body，不猜内容；secret-free。

### A-15 FINAL BreakGlass quorum and scoped authorization — 1
- 前置：Manager 发布、普通 active grant、三名独立 approvers。
- 操作：create→requester/self/duplicate/两名独立审批→activate→scope/fence checks→close/expiry。
- 可观察断言：requiredApprovals=2、requester/self/duplicate 不计；BreakGlass 只在 exact scope/TTL/frozen fences 下 authorized；terminal Session 不再授权；只按 Manager HTTP response exact shapes 断言，不猜 FINAL snapshot key。

### A-16 FINAL quarantine and guarded release — 1
- 前置：同 region 普通 active grant、已终态 BreakGlassSession、合法独立 retrospective reviewer。
- 操作：quarantine CAS，验证普通 grant/new grant fail closed；用已发布 retrospective body 记录复核，再以 expectedRevision release。
- 可观察断言：quarantine 原子撤销该 region 普通 grant并创建 REGION_QUARANTINE Work；stale CAS 无副作用；Session 未全终态或复核未完成时 release 失败，条件满足后只 release 一次。Manager 资源只经公开 route 验证；AS-GAP-04 未冻结前不固定 snapshot key。

## 7. B — 数据正确性、幂等与并发（25 分）

### B-01 Session rotation/reuse contention — 2.5
- 前置：一个 ACTIVE family current token。
- 操作：两 API 64 路 refresh、旧 token reuse 与 revoke 交错。
- 可观察断言：最终至多一个 ACTIVE generation；成功 rotations 连续；reuse winner 后 family 全 revoked；raw token 无泄漏，events/audit 无重复。

### B-02 Trust publication versus revoke — 2.5
- 前置：device current trust revision 与 active sessions/grants。
- 操作：双 API 并发 expectedRevision publish 和 device revoke。
- 可观察断言：revoke 后 stale publication 不能 restore device/trust；current pointer/epoch monotonic；所有 dependent authority fail closed。

### B-03 Policy revision freeze under races — 2.5
- 前置：publish/rollback 与 request acceptance 同时可执行。
- 操作：三个固定 interleaving seeds 并发操作。
- 可观察断言：每 request 精确冻结一个完整 revision，不出现 mixed rules/digest；later rollback 不改 decision basis 或 saved response。

### B-04 Deterministic location convergence — 2.5
- 前置：200 observations 的 fixed shuffled schedule。
- 操作：两个 API duplicate/out-of-order ingest，四 Workers replay。
- 可观察断言：最终 DeviceLocation 与 offline sort oracle 一致；unique sequence identity；无 duplicate risk flags/gaps；too-late 不污染 projection。

### B-05 Risk-score boundary oracle — 2.5
- 前置：四信号组合与 threshold boundary fixtures。
- 操作：生成 0..4 signals、region mismatch/impossible travel/policy deny requests。
- 可观察断言：score 为 frozen integer weights 精确和；reasons sorted；boundary levels 正确；每 request 一个 immutable Decision。

### B-06 Batch/idempotency/unknown response — 2.5
- 前置：response shield、100-item batch。
- 操作：合法 batch 丢失 response 后 retry/restart；same key 改一项；非法 item batch。
- 可观察断言：合法 exact replay；changed body `IDEMPOTENCY_CONFLICT`；非法/冲突整批零副作用；每 item 恰一 request/work/event relation。

### B-07 Same-key multi-API authority — 2.5
- 前置：两个 API 共库。
- 操作：对 session/request/grant/revoke 各 64-way same key/body，重启第三 API replay；AS-GAP-01 未冻结前不把 V1 review mutation 纳入本 Case。
- 可观察断言：每组 status+semantic JSON 唯一、一次 business effect；different body 冲突；process-local map 失败。

### B-08 Grant/revoke races — 2.5
- 前置：LOW 或已由冻结 fixture 合法批准的 REVIEW request、grant/revoke candidates。
- 操作：double grant、grant vs session/device revoke。
- 可观察断言：一个 grant winner；任何 fence commit 后不能出现新 active grant；sequence/audit contiguous。AS-GAP-01 未冻结前不构造 approve/reject race。

### B-09 Cross-process revocation fence — 2.5
- 前置：两个 API cache 已读 active grant。
- 操作：分别 commit session/device/principal/tenant/grant revoke，持续两 API checks。
- 可观察断言：commit 后无 stale `active:true`；epochs monotonic、每 subject 一 Revocation；AS-GAP-02 下不伪造未发布 Region API。

### B-10 Manager quorum/quarantine/release races — 2.5
- 前置：同 region 两 BreakGlass Sessions、普通 grants、多 reviewers。
- 操作：并发 final approval、quarantine CAS、activate/close/expiry/review/release，含 stale Worker。
- 可观察断言：恰好两名独立 approvers、READY transition 一次；quarantine revision 一个 winner；Session 未全终态/复核时 release 失败；无 BreakGlass 绕过 tenant/principal/device/session/trust fence。

## 8. C — Worker、恢复与持久性（20 分）

### C-01 Work lifecycle/retention — 2.5
- 前置：每种 Work 的 PENDING/LEASED/terminal fixture。
- 操作：claim、reclaim、success/fail/cancel、drain。
- 可观察断言：lease fields/terminal exact；attempt 单调；terminal retained；drain 只看 `terminal:false`。

### C-02 SIGKILL after `worker.claimed` — 2.5
- 前置：due Work、barrier held claimed。
- 操作：杀 A、等待 lease expiry、启动 B。
- 可观察断言：B reclaim attempt+1；A 无 open transaction/stale commit；Decision/projection/revocation/expiry effect 只一次。

### C-03 SIGKILL at `worker.before-effect` — 2.5
- 前置：published before-effect barrier。
- 操作：杀 Worker 并 replacement。
- 可观察断言：业务 effect 尚未 partial commit；replacement 完整处理；Work/Event/Audit/authority 一致。

### C-04 Expired lease fencing — 2.5
- 前置：A pause 到过期，B reclaim 完成。
- 操作：释放 A。
- 可观察断言：A stale token 不能 terminal write；最终只反映 B 的 attempt/result；无第二 decision/revocation/expiry。

### C-05 Location replay recovery — 2.5
- 前置：bounded-late observation 触发 projection rebuild。
- 操作：在 claim/before-effect kill/restart 多 Worker。
- 可观察断言：offline oracle 最终一致、风险 flags 不重复、Work terminal；重放不丢 observation。

### C-06 Revocation/expiry recovery — 2.5
- 前置：大量 active grants 与 propagation/expiry Work。
- 操作：commit fence 后 kill Workers，再 replacements drain。
- 可观察断言：API 从 commit 即 fail closed，不等待 Worker；replacement 收敛 dependent state；obsolete Work 不复活 authority。

### C-07 Unknown webhook ACK — 2.5
- 前置：receiver 保存完整 request 后隐藏 ACK。
- 操作：kill dispatcher，500/disconnect/replacement success。
- 可观察断言：eventId/type/semantic body 稳定，bounded retry、per-aggregate ordering、无第二 Event；headers/payload 无 raw token。

### C-08 Transactional Audit/Event and ordering — 2.5
- 前置：success/rollback mutations、多 tenants/aggregates。
- 操作：并发 append，dispatcher response barrier kill/restart。
- 可观察断言：security change、Audit、Event/Work 同 transaction；rollback 全无；Audit per-tenant chain、Event per-aggregate sequence 连续；secret-free。

## 9. D — OpenAPI、UI 与跨层闭环（15 分）

### D-01 OpenAPI validates live traffic — 2
- 前置：FINAL OpenAPI 与独立 contract schema。
- 操作：每 route 采 success/published error traffic。
- 可观察断言：OpenAPI 3.1 的 paths/status/body/closed shapes/formats 与 runtime 一致；只列 path 失败。

### D-02 Browser identity/policy lifecycle — 2
- 前置：production build、真实 DB/API。
- 操作：可见控件 create/rotate session、publish/rollback policy、查看 trust/history，刷新。
- 可观察断言：immutable revision/frozen basis/server state 可见；primary action 不用 direct API 代替。

### D-03 Browser access/review/grant lifecycle — 2
- 前置：LOW/REVIEW/HIGH fixtures。
- 操作：UI request、risk reasons、LOW grant/check/revoke/expiry，并观察 REVIEW 的待复核阻塞状态。
- 可观察断言：状态/理由/TTL/fences 与 snapshot 一致；permission/conflict/terminal state 可见。AS-GAP-01 未冻结前不要求浏览器完成 review mutation。

### D-04 Browser location/revocation/Audit — 2
- 前置：location/revocation histories。
- 操作：UI 查看 freshness/replay/risk flags、跨 subject revocations、验证 Audit chain/Events/Work。
- 可观察断言：不在 browser 重算 authority；refresh 后仍为 server truth；late/failed/recovery states 可理解。

### D-05 Manager UI — 2
- 前置：FINAL production UI。
- 操作：可见控件完成 quorum、scope check、quarantine、close/expiry、retrospective、release。
- 可观察断言：动态 approvers/actions/patterns、guarded release、普通与 emergency authority 区分可见；不得硬编码 happy result。

### D-06 Accessibility/recovery/security — 2
- 前置：loading/empty/409/403/offline/retry fixtures、mobile/desktop。
- 操作：全键盘走 primary flows 并触发错误。
- 可观察断言：labels/focus/keyboard/viewport/contrast 可用；retry 不重复 mutation；tokens/admin/private paths 不进 DOM/bundle/log。

### D-07 Project gates not fake green — 2
- 前置：clean database。
- 操作：逐个执行 unit/integration/e2e/concurrency/recovery/all/test:perf。
- 可观察断言：integration 真 PostgreSQL+HTTP；e2e production Chromium；concurrency ≥2 API+4 Worker；recovery 真 barrier/SIGKILL/replacement；`test:perf` 实际执行 README 八个场景并报告阈值/后置不变量；0 tests/字符串检查/吞失败均失败。

### D-08 README-to-evidence closure — 1
- 前置：所有 evidence。
- 操作：建立 `README→HTTP→OpenAPI→UI(适用)→snapshot/work/event/audit→hidden case` ledger。
- 可观察断言：每节点实际执行；unrun/empty/failed/partial 不得冒充 passing；AS gaps 明确标 partial。

## 10. E — 迁移、性能与可运维性（10 分）

### E-01 Populated V1→FINAL migration — 1.5
- 前置：V1 binary 创建各 identity/revision/location/request/decision/review/grant/revocation/Audit/Work/Event。
- 操作：FINAL migration×2，继续旧客户端流量。
- 可观察断言：所有 V1 identity/payload/digest/sequence 保留；Manager 创建响应与三种新 Work kind 可用且旧 flows 正常；AS-GAP-04 未冻结前不以 FINAL snapshot key 名称或 exact key-set 计分。

### E-02 Saved replay/Audit/Event compatibility — 1
- 前置：V1 success/conflict/unknown-response records 与 partial delivery histories。
- 操作：迁移后 replay/read/recompute。
- 可观察断言：status/body/identity 不改；Audit digest links、eventId/type/body/sequence 不变。

### E-03 Pending Work/delivery migration — 1
- 前置：V1 PENDING/LEASED Work、attempt/owner/expiry 与 unacked events。
- 操作：FINAL migrate、lease expiry、replacement drain。
- 可观察断言：lease metadata 保留、stale owner 不提交、新 roles 能处理旧 payload/order。

### E-04 `session-refresh-storm` — 0.75
- 前置：README 精确 20k families/100k rotations。
- 操作：64 clients、two APIs、scored scale=1。
- 可观察断言：≥800/s、p95≤180ms；每 family 一个 surviving generation；raw token 零泄漏。

### E-05 `access-decision-ingest` — 0.75
- 前置：精确 100k identities/500k requests、8 Workers。
- 操作：按 README load。
- 可观察断言：≥500 accepted/s、p95≤250ms；request/decision 一一对应；drain 后无 nonterminal Work。

### E-06 `policy-evaluation-hotset` — 0.75
- 前置：100×500 rules、100k frozen requests。
- 操作：1m checks/64 clients。
- 可观察断言：≥2000/s、p95≤75ms；deny-overrides oracle 正确；每 response 一个冻结 revision。

### E-07 `location-replay-convergence` — 0.75
- 前置：10k devices/200k observations、8 Workers。
- 操作：64-client bounded out-of-order load。
- 可观察断言：≥350/s、p95≤300ms；最终 projection 与 offline oracle 一致；无 duplicate flags/nonterminal Work。

### E-08 `grant-revocation-fanout` — 0.75
- 前置：100k grants/1k principals。
- 操作：32 clients revoke，8 Workers drain。
- 可观察断言：mutation p95≤250ms；30s 内两 API 全部 fail closed；每 Principal 一个 monotonic revocation。

### E-09 `audit-chain-append` — 0.625
- 前置：README 精确 250k mutation fixture。
- 操作：按 README topology、selector、concurrency 与计时运行。
- 可观察断言：≥300/s、p95≤300ms；Audit chain/sequence/digest 与 secret boundary 全部成立。

### E-10 `outbox-ack-recovery` — 0.625
- 前置：README 精确 50k events、receiver unknown-ACK fixture。
- 操作：按 README exact kill/replacement/receiver workload。
- 可观察断言：45s 内 drain；retry semantic body/eventId 不变；无第二 Event、顺序和 ACK 后置不变量成立。

### E-11 Revocation-fence recovery and cleanup — 1.5
- 前置：`revocation-fence-recovery` 50k grants、4 Workers claimed。
- 操作：推进四类 fences，kill/replacement，45s converge。
- 可观察断言：每次 commit 后无 stale active；replacement topology/drain 正确；所有性能后不变量重算；无进程/端口/secret log 污染，同 seed 非性能结果可复现。

## 11. Hard caps、invalid、evaluator_error

| 失败 | 总分上限 |
| --- | ---: |
| clean build/migration/production boot 失败 | 25 |
| authority freeze、risk、Audit、唯一 grant 或 atomic rejection 失败 | 35 |
| durable idempotency 产生第二 effect/token family | 30 |
| security change 与 Audit/Event 非事务或 retry 改 identity/body | 40 |
| pending Work 丢失或 stale Worker 可提交 | 40 |
| revoke commit 后任一 API 仍 active | 35 |
| migration 丢历史/改 replay/Audit chain | 35 |
| 性能后核心不变量失败 | 对应 case 0 并应用 correctness cap |

读取 hidden assets、硬编码 seed/fixture、workspace 外私有访问、容器逃逸或伪造 evidence 为 `invalid`。Evaluator 自身 Docker/PostgreSQL/Chromium/network/port 故障为 `evaluator_error`。watchdog 只防 evaluator 永久挂起，不增加产品时限。

## 12. Anti-fake-green

1. Candidate tests 只用于 D-07 gate 真实性；
2. risk/location/Audit/quorum/fence expected values由独立 oracle；
3. Candidate OpenAPI 不自证 runtime；
4. 文件、字符串、测试名、日志自述和 exit 0 不是行为证据；
5. recovery 只用 published barriers，多进程必须真实 OS processes；
6. 每个 performance case 后重算 authority/risk/location/Audit/Event/Work invariants；
7. 所有 A/B arms 使用同一 image/seed/cases/weights/thresholds。

## 13. Requirement mapping

| 原 gate | v2 cases |
| --- | --- |
| H-01/H-02 | A-01～A-06、D-01、D-06 |
| H-03/H-04 | A-07～A-14、B-01～B-05 |
| H-05/H-06 | B-06～B-09 |
| H-07/H-08/H-24 | C-01～C-08 |
| H-09 | E-01～E-03 |
| H-10/H-11/H-25/H-26 | A-15～A-16、B-10、D-05 |
| H-12 | E-04～E-11 |
| H-13 | D-07～D-08 |
| H-14～H-23 | A-07～A-14、B-01～B-09、C-05～C-08 |

### 13.1 Case contract-map 与反馈代码

下表把每个 Case 唯一绑定到公开合同。`V1` 指 `workspace/README.md` 对应标题，`MGR` 指
`orchestration/manager-prompt.zh-CN.md` 的固定消息。私有失败码统一为
`AS_<CASE_ID>_<ASSERTION>`；最小公开反馈只返回表中的 category，不返回 fixture、oracle 值或 hidden 条件。

| Case | 唯一 Public Contract 来源 | public feedback category |
| --- | --- | --- |
| A-01 | V1 `Required non-interactive commands`、`Environment` | `command_boot` |
| A-02 | V1 `db:migrate` repeatability、`V1 resources` | `migration_repeatability` |
| A-03 | V1 `Seed contract` | `seed_atomicity` |
| A-04 | V1 `HTTP and OpenAPI 3.1`、stable errors | `http_contract` |
| A-05 | V1 tenant-scoped reads/isolation rules | `tenant_isolation` |
| A-06 | V1 `Verification snapshot`、Audit digest chain | `snapshot_audit` |
| A-07 | V1 Session create/refresh/reuse/revoke rules | `session_lifecycle` |
| A-08 | V1 Device Trust、revocation epoch rules | `trust_revocation` |
| A-09 | V1 Policy/Risk revision publication and frozen basis | `policy_revision` |
| A-10 | V1 Location observation/replay policy | `location_replay` |
| A-11 | V1 Access Request/batch atomicity | `access_request` |
| A-12 | V1 risk-score/policy decision rules；AS-GAP-01 excluded | `risk_decision` |
| A-13 | V1 Grant/check/revoke/expiry rules | `grant_lifecycle` |
| A-14 | V1 Work/Event/Audit public shapes；AS-GAP-03 limits payload checks | `work_event` |
| A-15 | MGR BreakGlass quorum、activate、check、close/expiry | `breakglass_authority` |
| A-16 | MGR RegionalQuarantine CAS、RetrospectiveReview、guarded release | `regional_quarantine` |
| B-01 | V1 Session generation/reuse invariants | `session_concurrency` |
| B-02 | V1 Trust publication/revocation serialization | `trust_concurrency` |
| B-03 | V1 immutable Policy/Risk capture | `policy_concurrency` |
| B-04 | V1 Location ordering/duplicate rules | `location_concurrency` |
| B-05 | V1 risk threshold and deny override | `risk_correctness` |
| B-06 | V1 batch atomicity、durable idempotency | `idempotency_atomicity` |
| B-07 | V1 durable idempotency across API processes | `idempotency_concurrency` |
| B-08 | V1 Grant uniqueness and revocation fences；AS-GAP-01 excluded | `grant_concurrency` |
| B-09 | V1 post-commit revocation fail-closed invariant | `revocation_fence` |
| B-10 | MGR quorum/quarantine/review/release serialization | `manager_concurrency` |
| C-01 | V1 Work shape/lifecycle/retention | `work_lifecycle` |
| C-02 | V1 `worker.claimed` barrier、lease reclaim | `worker_recovery` |
| C-03 | V1 `worker.before-effect` barrier | `worker_recovery` |
| C-04 | V1 persisted lease fencing | `worker_fencing` |
| C-05 | V1 Location replay recoverability | `location_recovery` |
| C-06 | V1 Revocation/expiry Work convergence | `revocation_recovery` |
| C-07 | V1 dispatcher webhook retry/ACK rules | `event_delivery` |
| C-08 | V1 transactional Audit/Event ordering | `transactional_evidence` |
| D-01 | V1 OpenAPI 3.1 and all live public traffic | `openapi_runtime` |
| D-02 | V1 `Real UI` identity/policy actions | `browser_v1` |
| D-03 | V1 `Real UI` request/grant actions；AS-GAP-01 excluded | `browser_access` |
| D-04 | V1 `Real UI` location/revocation/Audit evidence | `browser_evidence` |
| D-05 | MGR UI/quorum/quarantine/retrospective/release requirement | `browser_manager` |
| D-06 | V1 UI loading/error/accessibility/security requirements | `ui_accessibility` |
| D-07 | V1 all `test:*` command contracts including `test:perf` | `project_gates` |
| D-08 | V1 `Project-owned verification` and observable handoff evidence | `evidence_closure` |
| E-01 | MGR migration preservation paragraph；V1 populated state | `migration_compatibility` |
| E-02 | V1 durable replay/Audit/Event identity + MGR preservation | `migration_replay` |
| E-03 | V1 Work leases/delivery + MGR migration preservation | `migration_pending_work` |
| E-04 | V1 `session-refresh-storm` | `performance_session` |
| E-05 | V1 `access-decision-ingest` | `performance_access` |
| E-06 | V1 `policy-evaluation-hotset` | `performance_policy` |
| E-07 | V1 `location-replay-convergence` | `performance_location` |
| E-08 | V1 `grant-revocation-fanout` | `performance_revocation` |
| E-09 | V1 `audit-chain-append` | `performance_audit` |
| E-10 | V1 `outbox-ack-recovery` | `performance_outbox` |
| E-11 | V1 `revocation-fence-recovery` and command cleanup/log rules | `performance_recovery` |

## 14. Calibration mutants

| Mutant | 必须命中 |
| --- | --- |
| process-local idempotency/token family | B-01、B-06、B-07 |
| refresh old token 不 revoke family | A-07、B-01 |
| stale trust publication restores device | A-08、B-02 |
| request 使用 current 而非 frozen revision | A-09、B-03 |
| location 按 arrival order | A-10、B-04 |
| risk threshold 用 `<` 而非 `<=` | A-12、B-05 |
| batch partial commit | A-11、B-06 |
| revoke 只清本进程 cache | B-09 |
| Audit/Event after business transaction | A-06、C-08 |
| Work lease 无 fencing | C-02～C-06 |
| dispatcher retry 新 eventId/body | C-07 |
| BreakGlass 一人 approve 即 READY | A-15、B-10 |
| BreakGlass 绕过 tenant revoke | A-15、B-10 |
| quarantine release 忽略 retrospective | A-16、B-10 |
| migration 改 Audit digest/replay | E-01～E-02 |
| UI mock authority | D-02～D-05 |
| project tests 只查字符串 | D-07 |
| perf 只报吞吐 | E-04～E-11 |

## 15. 实施顺序与完成标准

1. A-01/A-03/A-07 打通 command→HTTP→snapshot；
2. B-01/B-05/B-07 打通 authority oracle、response shield、多 API；
3. C-02/C-04/C-07 打通 published barriers、SIGKILL、receiver；
4. A-10/B-04 与 A-06/C-08 分别校准 location/Audit oracle；
5. 解决 AS gaps 后补充 V1 review 与 FINAL snapshot-key assertions；
6. D-01～D-05 打通 contract validator/Chromium；
7. E-01～E-03 接真实 V1 checkpoint，最后逐条实现八个 perf scenarios 与 mutants。

正式 A/B 前：53 cases 唯一且总分精确 100；五个 gaps 已解决或对应 assertion 不计失败；gold 全过、所有 mutants 被定向捕获、三次 calibration 无功能 flake；实验 arm 不改变 evaluator 的任何输入或阈值。
