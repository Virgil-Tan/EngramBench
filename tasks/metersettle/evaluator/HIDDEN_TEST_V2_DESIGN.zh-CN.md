# MeterSettle Hidden Test v2 详细设计

本任务设计遵循 [`docs/hidden-test-v2-standard.zh-CN.md`](../../../docs/hidden-test-v2-standard.zh-CN.md)；
下文只定义 MeterSettle 的任务专属合同映射、oracle、fixtures、Cases、Hard Caps 与 mutants。

## 1. 目标与边界

本方案把现有 H-01～H-13 拆成 **44 个独立、确定性、Harness-owned 黑盒 case**。所有预期只来自
`workspace/README.md`、T16 固定 Manager 变更、`CONTEXT.md` 与公开命令；不读取 Candidate 源码、ORM、
私有表或内部 helper。每个 case 只经公开 seam 观察行为，并使用 evaluator 自己的金额、月区间、排序和
revision oracle，不能把 Candidate 自测或 Candidate OpenAPI 当作正确性真值。

本文件只设计测试，不改变产品合同、性能阈值或现有 evaluator，也不实现 runner。

## 2. 权威来源与合同缺口

权威顺序：

1. `tasks/metersettle/workspace/README.md`（V1 Public Contract）；
2. `tasks/metersettle/README.zh-CN.md` 中 T16 固定 Manager 变更；
3. `tasks/metersettle/workspace/AGENTS.md` 与 `tasks/metersettle/CONTEXT.md`；
4. 本文件只映射断言，不新增产品行为。

已发现且不得由 hidden test 猜测的缺口：

- `SPEC-GAP-01`：`GET /api/v1/statements/:statementId/revisions/:revision` 被描述为“返回 one revision and
  its CorrectionEvents”，但没有发布外层 JSON shape。测试可验证 revision 与对应 CorrectionEvents 的语义、
  exact member shapes 和集合内容；在合同补全前不得规定 `{revision,correctionEvents}` 等 wrapper 名称。
- `SPEC-GAP-02`：Correction `reason` 的长度、字符集和空字符串规则没有发布；除 JSON 类型和 unknown-field
  规则外，不得制造隐藏边界。
- `SPEC-GAP-03`：Correction batch 返回的 accepted/duplicate ID 数组顺序没有发布。测试验证集合、唯一性和
  原子性，不规定输入序、字节序或提交序；Revision 内 `correctionIds` 则必须按已发布的 UTF-8 byte order。
- `SPEC-GAP-04`：Manager 没有定义 correction ingestion 自身的 Domain Event type；Evaluator 不得要求一个
  新事件。只要求已字面发布的 `statement.revision-finalized`，以及 V1 同类 transition 的原事件。
- `SPEC-GAP-05`：`GET /api/v1/meters/:meterId/usage?from&to` 发布了参数名，但没有定义边界包含关系；通用
  `interval={startAt,endAt}` 的半开语义不能自动套用到两个独立 query 参数。测试只用严格位于查询范围内部的
  时间验证过滤、排序和分页；`from`/`to` 边界事件在合同补全前不计分。

## 3. 预先确认的公开测试 seams

| Seam | 允许操作 | 禁止操作 |
| --- | --- | --- |
| Public commands | 执行 README 精确发布的 npm commands，观察退出码、进程和日志 | import Candidate 模块或调用内部测试 helper |
| HTTP | `/healthz`、`/openapi.json`、公开 `/api/v1` routes | 未发布 debug route |
| Verification snapshot | ADMIN_TOKEN 读取同一 point-in-time snapshot | 直查私有表或推断表名 |
| Production browser | production build + 系统 Chromium + 可见控件 | 页面注入、直接调用 store/API 代替主操作 |
| Notification receivers | 接收 Domain Event webhook，控制 2xx/500/断线/ACK | 读取 Candidate outbox |
| Recovery barrier | 使用公开 `TEST_BARRIER_URL/TOKEN` 三个 worker 点和 dispatcher 点 | 随机 sleep 猜 critical point |
| Process boundary | 独立 API/Worker/Dispatcher，SIGTERM/SIGKILL，检查子进程 | 同进程构造多个 service object 冒充并发 |
| V1→FINAL checkpoint | 冻结 V1 binary 写历史数据，再对同库执行 FINAL migration | FINAL binary 伪造 V1 数据 |

实现 runner 前应冻结这些 seams。若某个断言无法由这些 seam 观察，应补 Public Contract，而不是读取实现。

## 4. Runner、结果与隔离接口

建议使用 `evaluator/v2/{manifest,contract-map,run,lib,fixtures,cases,calibration}`；每个 case 使用独立数据库、
端口、managed-data root、receiver 和 barrier。只有迁移 case 可跨 V1/FINAL 阶段复用数据库。非性能 case
顺序运行，性能 case 独占 4 CPU/8 GiB 环境。

Case 记录至少包含：`id`、`dimension`、`weight`、`prerequisites`、`status`、`durationMs`、
`evidenceDigest`、私有 failure code。case 内任一 mandatory assertion 失败则该 case 为 0 分，不拆分小数分。
总结果使用 `accepted|rejected|invalid|evaluator_error`；Candidate 行为失败只能是 `failed`，基础设施故障才是
`evaluator_error`。

下文每个 Case 标题即唯一 ID/维度/权重，“前置/操作/可观察断言”分别对应 fixture、public-seam action 和
mandatory assertions；第 14.1 节给出不重叠的 Public Contract 映射。失败时 private failure code 固定为
`MS_<CASE_ID>_FAILED`（Case ID 中 `-` 转为 `_`）；最小公开类别固定为
`A=contract`、`B=correctness`、`C=recovery`、`D=cross_layer`、`E=compat_perf`，不公开 fixture 或断言细节。

## 5. 独立 oracle 与确定性 fixtures

### 5.1 统一确定性

- UUID、eventId、correctionId、request key 与交错顺序由私有 `evaluationSeed + caseId + ordinal` 生成；
- `T0` 从可观察数据库/API 时间后的安全窗口派生；月边界固定使用 UTC；
- 同 submission+seed 可复现；并发 case 至少运行三个固定 interleaving seed；
- 预期值只来自字面合同、固定 worked example 或 evaluator reference model。

### 5.2 Rating / revision oracle

Evaluator 独立完成：

1. 由 `occurredAt` 计算半开 UTC 月份 `[monthStart,nextMonthStart)`；
2. 选择覆盖 `occurredAt` 的唯一 Rate Plan，绝不使用 ingestion/correction audit time；
3. V1 `chargeMinor = quantity * unitPriceMinor`，逐步检查 JSON safe integer；
4. base Statement 的 line、totalQuantity、totalMinor 和版本集合由不可变 Usage Events 重算；
5. pre-finalization correction 把同 source 的全部已提交 delta 加到 effective quantity 后重新生成一条 line；
6. finalized correction batch 每个 Statement 最多生成一条 Revision；`deltaMinor` 为该 Statement 所有
   accepted corrections 的 `quantityDelta * source unitPriceMinor` 之和；
7. `priorTotalMinor` 取最新 FINALIZED Revision，否则取 base total；`effectiveTotalMinor` 用独立整数相加；
8. Revision 编号连续，`correctionIds` 按 UTF-8 bytes 排序；pending Revision 不进入 effective total。

关键 worked examples：跨月边界前后 1ms 的两个事件必须进入不同 Statement；同一 source 数量 10、单价 7，
delta `+3,-2` 的 effective quantity 是 11、deltaMinor 是 7，而不是用 correction.occurredAt 的计划重新定价。

### 5.3 Fixture families

| Fixture | 用途 |
| --- | --- |
| F-EMPTY | clean migrate/build/boot/validation |
| F-V1-RATING | 多 tenant、跨月、计划边界、零/大数量、OPEN/FINALIZED |
| F-DEDUPE | 相同/冲突 tenant+eventId、批内重复、unknown response |
| F-WATERMARK | 相邻月份、严格递增、late event、finalization races |
| F-WORK | PENDING/LEASED/terminal RATING，多 attempt、接近 lease expiry |
| F-EVENT | 多 aggregate/sequence、未 ACK、已重试与已 ACK |
| F-CORRECTION | pre-finalization、finalized、多 Statement、negative/overflow/pending |
| F-MIGRATION | V1 全状态、saved replay、pending work、undelivered event |
| F-BROWSER | V1 与 correction/revision 主流程及错误状态 |
| F-PERF-V1 | README 精确的 100 tenants/10k meters/100 plans/1m events |

## 6. 评分总览

| Dimension | Weight | Case 数 |
| --- | ---: | ---: |
| A. 需求与公共接口覆盖 | 30 | 14 |
| B. 数据正确性、幂等与并发 | 25 | 10 |
| C. Worker、恢复与持久性 | 20 | 8 |
| D. OpenAPI、UI 与跨层闭环 | 15 | 7 |
| E. 迁移、性能与可运维性 | 10 | 5 |
| **Total** | **100** | **44** |

## 7. A — 需求与公共接口覆盖（30 分）

### A-01 Published commands and production boot — 2
- **前置**：空数据库、无 `node_modules/dist`、合法环境变量。
- **操作**：依次执行 install、migrate、build，独立启动 API、RATING Worker、Dispatcher。
- **可观察断言**：命令非交互且退出码真实；仅绑定 127.0.0.1；health/OpenAPI 可用；SIGTERM 后无遗留子进程。

### A-02 Repeatable populated migration — 2
- **前置**：F-V1-RATING，已保存公开资源摘要。
- **操作**：空库迁移两次、seed、经 HTTP 增加状态，再重放迁移两次。
- **可观察断言**：所有资源、Work/Event identity、排序和 saved replay 不变；失败 migration 无半成品行为。

### A-03 Atomic deterministic seed — 2
- **前置**：F-EMPTY 与合法/非法 seed 族。
- **操作**：合法导入、同 version+digest 重放、同 version 不同内容；逐个注入 unknown key、重复 ID、缺引用、
  重叠计划、坏时间、溢出。
- **可观察断言**：合法内容 exact；重放 no-op；冲突为 `SEED_VERSION_CONFLICT`；任一非法导入后 snapshot 不变且无 Work/Event。

### A-04 OpenAPI 3.1 exact public contract — 2
- **前置**：FINAL production API。
- **操作**：独立解析 `/openapi.json` 并与冻结 contract map 比较。
- **可观察断言**：V1/Manager 全部 route、method、parameter、body、状态码、required/nullable/additionalProperties、
  safe integer/timestamp/UUID schema 精确；不得用文档缺口发明 wrapper/顺序。

### A-05 Common errors and scalar boundaries — 2
- **前置**：每类 mutation/read 的最小合法 fixture。
- **操作**：逐 route 提交非 JSON、坏 JSON、unknown field、错误 auth、UUID/timestamp/int/cardinality 边界和坏 cursor。
- **可观察断言**：415/400/401/404/409 与稳定 code、exact `{error}` shape；合法边界成功，非法边界零副作用。

### A-06 Pagination and point-in-time snapshot — 2
- **前置**：每个 collection 超过 110 个确定性资源。
- **操作**：默认/1/100 limit 翻页，读取 FINAL snapshot 与 Domain Events。
- **可观察断言**：无重无漏、cursor opaque/stable；snapshot exact keys/shapes/sorts、同一 asOf、递归省略 `*Token` 与秘密。

### A-07 Atomic Usage Batch and tenant-scoped dedupe — 2
- **前置**：同 tenant 与跨 tenant 的相同 eventId fixture。
- **操作**：创建 1、1000 member batch；相同内容重放；不同 meter/time/quantity 冲突；批内重复。
- **可观察断言**：202 的 accepted/duplicate 集合正确；scope 仅 tenant+eventId；冲突返回 `EVENT_ID_CONFLICT` 或
  `INVALID_USAGE_BATCH`，完整批次零副作用。

### A-08 Occurred-at Rate Plan and UTC month assignment — 2
- **前置**：F-V1-RATING，计划切换点与月边界 ±1ms。
- **操作**：摄入事件并推进覆盖月份的 Watermark。
- **可观察断言**：Statement/line 归月、ratePlanVersion、unitPrice、charge 与独立 oracle 一致；不用 ingestion time。

### A-09 Watermark scheduling and Statement finalization — 2
- **前置**：连续三个月 OPEN usage，多 tenant。
- **操作**：严格递增推进 Watermark，运行两个 Worker 排空 RATING。
- **可观察断言**：仅 `periodEnd <= through` 的 period 按 periodStart/statementId 处理；OPEN→FINALIZING→FINALIZED，
  base revision=1、finalizedAt/watermarkThrough/sequence/Work/Event 精确且一次。

### A-10 Late usage and rollback — 2
- **前置**：至少一个 FINALIZED Statement 与 finalized Watermark。
- **操作**：提交 occurredAt 等于、早于和晚于 cutoff 的批次，并混合一个 late member 与一个合法 member。
- **可观察断言**：前两者 `LATE_USAGE_EVENT`；混合批完整回滚；晚于 cutoff 的合法事件可进入开放 period；历史不可变。

### A-11 Statement, meter usage and Watermark reads — 2
- **前置**：多页 usage、多个 Statement/plan version；用于 range 过滤的事件时间严格位于 `from` 与 `to` 内部。
- **操作**：调用 Statement list/detail、meter usage range、tenant watermark；边界事件按 `SPEC-GAP-05` 排除计分。
- **可观察断言**：exact resource shapes、内部时间过滤、排序/分页；line sums 等于 totals；openPeriodStarts/finalizedThrough 与 oracle 一致；不推定 `from`/`to` 为半开区间。

### A-12 Domain Event query and V1 transition coverage — 2
- **前置**：完成 batch、watermark、finalization 成功与失败路径。
- **操作**：按 aggregateId/afterSequence/limit 查询并由 receiver 接收。
- **可观察断言**：V1 type/payload `{}`、每 aggregate sequence 从 1 连续；成功业务与 event 同 transaction，rollback 无 event。

### A-13 Pre-finalization Correction behavior — 3
- **前置**：Manager FINAL；source Usage Event 所在 Statement 尚未 FINALIZED。
- **操作**：提交 +/− correction batch，随后让 Rating Task finalization。
- **可观察断言**：Correction immutable；effective quantity 非负；仍按 source occurredAt 的计划；base Statement 只有一条
  effective line、无 StatementRevision；batch 错误整组回滚。

### A-14 Finalized Statement Revisions and public APIs — 3
- **前置**：FINALIZED base Statement，多个 source 与两个 correction batches。
- **操作**：提交 corrections、排空 RATING，读取 StatementDetail、revision detail 与 snapshot。
- **可观察断言**：每 batch/Statement 最多一 Revision；编号 2..N 连续；prior/delta/effective totals、correctionIds、
  FINALIZING→FINALIZED、pendingRevision 和 `statement.revision-finalized` 均与 oracle 一致；base JSON 不变。

## 8. B — 数据正确性、幂等与并发（25 分）

### B-01 Independent rating arithmetic oracle — 2
- **前置**：零价、最大安全边界、多个计划/事件。
- **操作**：完成 finalization 并读取 Statement/snapshot。
- **可观察断言**：每行 multiplication 与总和逐步保持 safe integer；totalQuantity/totalMinor/versions 精确，无浮点舍入。

### B-02 Batch-wide semantic atomicity — 2
- **前置**：一个 duplicate、一个 conflict、一个无计划与多个合法 member。
- **操作**：构造包含任一坏 member 的 1..1000 批次。
- **可观察断言**：对应稳定错误；UsageEvent、Statement、RATING Work、idempotency effect、Event 全部不变。

### B-03 Immutable dedupe scope under terminal history — 2
- **前置**：同 tenant eventId 已进入 FINALIZED Statement。
- **操作**：用新 key 提交相同和不同 semantic body，并在另一 tenant 使用相同 eventId。
- **可观察断言**：相同内容只 duplicate、不重复计费；不同内容永远 conflict；跨 tenant 独立；finalized history 不改。

### B-04 Unknown-response durable replay — 2
- **前置**：response shield 与 Create batch、Watermark、Correction mutation。
- **操作**：shield 在完整 upstream response 后断开，重试同 key，重启 API 后再重试。
- **可观察断言**：原 status/semantic JSON/IDs 永久一致；每 mutation 只有一次业务效果、Work 和 Event。

### B-05 Same-key contention across API processes — 2
- **前置**：两个独立 API、一个 PostgreSQL。
- **操作**：64 路并发提交相同 key/body，再由第三 API replay；另测同 key 不同 body。
- **可观察断言**：相同请求收敛为唯一结果；不同语义 `IDEMPOTENCY_CONFLICT`；snapshot 只有一条 effect chain。

### B-06 Ingest versus Watermark finalization race — 3
- **前置**：event occurredAt 接近将推进 cutoff，两个 API、两个 Worker。
- **操作**：确定性交错 batch commit、Watermark commit 与 Rating lock。
- **可观察断言**：事件要么在合法锁边界前被计入一次，要么以 `LATE_USAGE_EVENT` 整批拒绝；不存在 FINALIZED 后漏加/改写或半批。

### B-07 Correction negative and overflow atomicity — 3
- **前置**：多个 source/Statement，数量和金额接近安全整数边界。
- **操作**：混合导致 negative effective quantity、乘法/Statement delta/effective total overflow 的 member。
- **可观察断言**：`NEGATIVE_EFFECTIVE_USAGE` 或 `CORRECTION_TOTAL_OVERFLOW`；无 CorrectionEvent/Revision/Work/Statement/Event 改动。

### B-08 Correction versus base-finalization race — 3
- **前置**：base Statement 正在 finalization，correction 可在 lock 前后竞争。
- **操作**：三个固定 interleaving 并发提交 correction 与两个 RATING Worker。
- **可观察断言**：lock 前 correction 进入 base effective line 且无 Revision；lock 后 correction 创建 revision；任何结果都只计一次且 totals 守恒。

### B-09 Concurrent correction batches and pending Revision — 3
- **前置**：一个 FINALIZED Statement；两个 API 同时提交不同 batches。
- **操作**：制造一个 FINALIZING Revision，再提交另一 batch；随后排空并重试。
- **可观察断言**：每时最多一个 FINALIZING；loser 为 `STATEMENT_REVISION_PENDING` 且零副作用；后续 revision 严格 +1、prior 链正确。

### B-10 Multi-Statement correction batch grouping — 3
- **前置**：一批 corrections 覆盖两个 finalized Statements、含 duplicate 与新 correction。
- **操作**：并发 replay 与 Worker finalization。
- **可观察断言**：每 affected Statement 最多一 Revision；accepted/duplicate 集合正确；每组 correctionIds byte-sort；
  duplicate 不建 Revision；所有 Statement 要么整批接收要么整批回滚。

## 9. C — Worker、恢复与持久性（20 分）

### C-01 Work lifecycle, shape and retention — 2
- **前置**：PENDING/LEASED/SUCCEEDED/FAILED/CANCELLED RATING Work。
- **操作**：经 Watermark 与 correction 路径创建/完成 Work，读取 snapshot。
- **可观察断言**：exact shape；lease fields 仅 LEASED 非空；terminal 派生正确且永久保留；drain 只看 `terminal:false`。

### C-02 SIGKILL after `worker.claimed` — 2
- **前置**：due RATING Work、claimed barrier held。
- **操作**：确认无开放 transaction 后杀 Worker A，等 lease expiry，启动 B。
- **可观察断言**：B reclaim、attempt 增加、Statement/Revision effect 一次；A 的 stale claim 不可完成。

### C-03 SIGKILL after `worker.effect-complete` — 2
- **前置**：effect-complete barrier，含多 line rating。
- **操作**：杀 A、启动 B。
- **可观察断言**：业务 effect 与 Work terminal 最终原子收敛；无重复 line/Revision/Event，无永久 nonterminal。

### C-04 SIGKILL at `worker.before-commit` — 2
- **前置**：before-commit barrier。
- **操作**：SIGKILL 后 replacement 恢复。
- **可观察断言**：原 transaction 全无或完整一次；不能观察 partial Statement/line/correction/Work/Event。

### C-05 Expired lease fencing — 3
- **前置**：A claim 后暂停超过 lease，B reclaim 并完成。
- **操作**：B commit 后释放 A。
- **可观察断言**：A 的 owner/token/expiry stale write 必败；最终 attempt/state/totals/event 只反映 B。

### C-06 Watermark backlog ordering and obsolete Work — 3
- **前置**：多个 tenant/月份、重复 Watermark/idempotent replay、已被合法状态覆盖的 Work。
- **操作**：两个 Worker 并发 drain 并重启。
- **可观察断言**：处理顺序 periodStart→statementId；每 Statement finalized 一次；无需的 Work terminal/cancelled，不留 immortal backlog。

### C-07 Unknown Domain Event webhook ACK — 3
- **前置**：receiver 已持久化完整 request 后暂停 ACK。
- **操作**：SIGKILL dispatcher，分别模拟 500、断线、timeout，再由 replacement 送达。
- **可观察断言**：eventId/type/semantic body 固定、per-aggregate 成功顺序递增、无限 bounded retry、无新 event identity。

### C-08 Transactional event and revision recovery — 3
- **前置**：V1 finalization 与 Manager Revision finalization 成功/回滚路径。
- **操作**：在 worker 三个 barrier 和 dispatcher barrier 组合故障后恢复。
- **可观察断言**：成功 transition 必有唯一已发布 event，rollback 无 event；sequence 连续；revision/Statement/Work/event 同步收敛且不泄密。

## 10. D — OpenAPI、UI 与跨层闭环（15 分）

### D-01 OpenAPI validates live traffic — 2
- **前置**：FINAL production API 与冻结 evaluator schema。
- **操作**：每 route 至少采集一个 success 和一个 published error，由独立 validator 校验。
- **可观察断言**：status/header/body 均通过 evaluator schema；文档仅列 path 或自证响应不能通过。

### D-02 Production-browser V1 lifecycle — 2
- **前置**：production UI/API/PostgreSQL/Worker/Dispatcher。
- **操作**：只用可见控件摄入 usage、推进 Watermark、观察 finalization、查看 Statement/usage/events。
- **可观察断言**：UI 状态与 HTTP/snapshot 一致；刷新后持久；不得由 evaluator API 代替 primary UI action。

### D-03 Production-browser corrections and revisions — 2
- **前置**：一个 open 与一个 finalized Statement。
- **操作**：UI 创建 corrections、观察 base recompute/Revision progress、读取 revision history。
- **可观察断言**：pre/post-finalization 两路径可完成；pending/final totals、correction IDs 与 snapshot 一致；失败可恢复。

### D-04 Loading, empty, validation, conflict, offline and permission — 2
- **前置**：可控 slow/offline/401/409 receiver。
- **操作**：逐一触发 UI 状态并 retry。
- **可观察断言**：状态可见、有语义、可恢复；retry 不重复 mutation；ADMIN_TOKEN 不在 bundle/页面/日志。

### D-05 Keyboard, labels, focus and mobile — 2
- **前置**：desktop/mobile viewport。
- **操作**：键盘完成 V1 与 correction 主流程，触发 validation/permission errors。
- **可观察断言**：primary controls 可达且有 label/name；错误后 focus 合理；无不可达控件；关键 contrast 达 WCAG AA。

### D-06 Project-owned gates are not fake green — 2
- **前置**：clean database/build。
- **操作**：逐个运行公开 test commands，并外部观察 PostgreSQL、HTTP、Chromium、多进程、barrier/SIGKILL。
- **可观察断言**：非零测试、失败不吞；不是文件/字符串存在检查；integration/e2e/concurrency/recovery 确实穿过公开 seam。

### D-07 README-to-evidence cross-layer closure — 3
- **前置**：固定 requirement ledger。
- **操作**：逐项映射 `README → HTTP → OpenAPI → UI（适用）→ snapshot/Work/Event → hidden evidence`。
- **可观察断言**：每节点只能 unrun/empty/failed/partial/passing；所有适用节点实际执行才 passing，测试名或总 pass count 不构成证据。

## 11. E — 迁移、性能与可运维性（10 分）

### E-01 Populated V1→FINAL migration — 2
- **前置**：真实 V1 checkpoint，含 OPEN/FINALIZING/FINALIZED Statements、late rejection 历史。
- **操作**：FINAL migration 后通过旧/新 API 和 snapshot 读取。
- **可观察断言**：existing Statement 成 base revision 1；JSON replay、line IDs、events/timestamps 不变；旧 late rule 仍有效；仅 correction 可修订历史。

### E-02 Saved idempotency and event identity across migration — 2
- **前置**：V1 success/conflict/unknown-response replay 与 delivered/undelivered events。
- **操作**：迁移、重启 API/Dispatcher 后 replay。
- **可观察断言**：原 status/body/identity/sequence 不改；新 Detail fields 不倒灌改写历史 saved response。

### E-03 Pending Work and Watermark continuity — 2
- **前置**：V1 PENDING/LEASED RATING，不同 attempt/owner/expiry，多 tenant Watermark。
- **操作**：迁移并由 replacement Workers drain。
- **可观察断言**：Work 与 Watermark exact 保留；stale token 仍不可提交；正常完成 base 或按锁边界创建 Manager revision。

### E-04 HTTP sustained performance — 2
- **前置**：README `perf-v1` 精确数据集、独占固定容器。
- **操作**：分别严格运行 `usage-batch-ingest` 与 `statement-read` 的 setup/selector/request/64 clients/10s+60s。
- **可观察断言**：>=1000 accepted events/s 且 batch p95<=400ms；>=200 valid reads/s 且 p95<=150ms；5xx=0；负载后 rating oracle 全通过。

### E-05 Rating recovery performance and operability — 2
- **前置**：精确 10k closed unfinalized events，两个 Worker 在 claimed barrier 后被杀。
- **操作**：等 lease expiry，启动两个 replacements，按公开 timer 测 60s；随后 cleanup/repro/log audit。
- **可观察断言**：10k lines 一次、全部 FINALIZED、无 nonterminal RATING、计划选择正确、<=60s；无遗留进程/端口/锁；日志无秘密；同 seed 功能结果一致。

## 12. Hard caps、invalid 与 evaluator_error

| Failure | Cap |
| --- | ---: |
| clean build、migration 或 production boot 失败 | 25 |
| at-most-once usage、金额守恒、watermark 单调或 atomic batch 失败 | 35 |
| durable idempotency 在 replay/unknown/restart 后产生第二 effect | 30 |
| 成功业务缺 event、rollback 有 event、retry 改 event identity/body | 40 |
| SIGKILL 后 Work 丢失或 stale Worker 可提交 | 40 |
| Correction partial batch、negative/overflow 落库或 Revision 链断裂 | 35 |
| migration 丢历史/改 saved replay/破坏旧客户端 | 35 |
| 性能后核心不变量失败 | 性能 case 0，并应用对应 correctness cap |

读取 hidden assets/evaluator env、硬编码私有 fixture/seed/case ID、访问 workspace 外资产、容器逃逸、伪造
evidence 均为 `invalid`。Docker/PostgreSQL/Chromium/端口分配等 Harness 故障为 `evaluator_error`，不得记为
Candidate 失败。Evaluator watchdog 只保护 evaluator 自身，不创造产品时限或 Harness turn timeout。

## 13. Anti-fake-green

1. Candidate tests 只用于 D-06 gate 真实性，不作为产品正确性真值；
2. Statement totals、revision arithmetic、月归属和排序由独立 oracle 生成；
3. 不用 Candidate OpenAPI 自校验 Candidate response；
4. 不把 route/file/test-name/log 声明当行为证据；
5. recovery 必须命中 barrier，并发必须是独立 OS processes；
6. performance 只统计完整且通过 semantic oracle 的响应，负载后重跑全部不变量；
7. public report 只泄露 assertion code/脱敏摘要，私有 evidence 保存 fixture/seed digest。

## 14. Requirement mapping

### 14.1 Compact contract-map

下表范围互不重叠；每个 Case 只以所在行的冻结条款集合决定 expected value。

| Case range | 唯一 Public Contract 条款集合 |
| --- | --- |
| A-01～A-03 | V1 README「Required stack/commands」「Environment」「Seed contract」「Handoff」 |
| A-04～A-06 | V1 README「HTTP and OpenAPI 3.1」「V1 verification snapshot」 |
| A-07～A-12 | V1 README「Domain and V1 behavior」「Deterministic policy」「Mandatory invariants」「public aggregate routes」「Workers, events, and recovery」 |
| A-13～A-14 | 固定 Manager 规则 1～13、wire schema、changed APIs 与 errors |
| B-01～B-03 | V1 README「Deterministic policy」「Mandatory invariants」「Seed contract」「Durable idempotency」 |
| B-04～B-05 | V1 README「Durable idempotency」 |
| B-06 | V1 README Watermark/finalization 规则与 Worker 原子性 |
| B-07～B-10 | 固定 Manager 规则 1～10、Correction endpoint 与 stable errors |
| C-01～C-06 | V1 README「Workers, events, and recovery」「Controlled recovery barrier」及 Manager Revision Work 规则 |
| C-07～C-08 | V1 README Domain Event/dispatcher 合同及 Manager 已发布 revision-finalized transition |
| D-01～D-07 | V1 README OpenAPI、Real UI、project-owned verification、Handoff 及 Manager 规则 12 |
| E-01～E-03 | 固定 Manager 迁移/兼容规则 11～13 与 FINAL snapshot/Work 合同 |
| E-04～E-05 | V1 README 三个 fixed performance scenarios 与 Manager 性能兼容合同 |

### 14.2 旧 H Gates 映射

| 旧 Gate | v2 cases |
| --- | --- |
| H-01 | A-01～A-03、E-05 |
| H-02 | A-04～A-06、D-01、D-04、D-05 |
| H-03 | A-07～A-12 |
| H-04 | A-05、A-08～A-10、B-01～B-03 |
| H-05 | B-04、B-05 |
| H-06 | B-06～B-10 |
| H-07 | C-01～C-06 |
| H-08 | C-07、C-08 |
| H-09 | E-01～E-03 |
| H-10 | A-13、A-14、B-07～B-10 |
| H-11 | C-02～C-08、D-03 |
| H-12 | E-04、E-05 |
| H-13 | D-06、D-07、E-05 |

## 15. Calibration mutants

| Mutant | 必须命中的 cases |
| --- | --- |
| 按 ingestion time 而非 occurredAt 选计划 | A-08、B-01 |
| 使用浮点金额或无 safe-int 检查 | B-01、B-07 |
| batch 逐 member 提交 | A-07、A-10、B-02、B-07 |
| process-local idempotency | B-04、B-05 |
| Watermark 与 ingest 无锁导致 finalized history 改写 | B-06 |
| correction occurredAt 重新选价 | A-13、B-07 |
| pending Revision 仍接收下一 batch | B-09 |
| 每 correction 建一 Revision 而非每 batch/Statement | B-10 |
| 无 Work lease fencing | C-02～C-05 |
| event 在业务 transaction 后插入 | A-12、C-08 |
| dispatcher retry 新建 eventId | C-07 |
| migration 重写 saved Statement response | E-01、E-02 |
| OpenAPI 只有路径无精确 schema | D-01 |
| UI/测试仅字符串假绿 | D-02、D-03、D-06 |
| 只报吞吐不验 totals | E-04、E-05 |

Gold 必须通过全部适用 case；每个 mutant 至少被预期 case 稳定捕获；同 mutant+seed 三次一致。冻结
evaluator image、V1/FINAL binaries、fixture generator、contract map、manifest 和性能环境后才可正式 A/B。

## 16. 推荐实施顺序与完成标准

按 vertical slice：A-01/A-03/A-07 → B-01 → B-04/B-05 → C-02/C-05 → D-01/D-02 →
A-13/A-14/B-08 → E-01～E-03 → E-04/E-05 → 其余 cases 与 mutants。每步先让目标 mutant 失败，
再让 gold 通过。

正式启用前必须满足：44 个唯一 case、权重精确 100、全部只走第 3 节 seams、真实 V1 checkpoint 可运行、
gold 全通过、mutants 被定向捕获、三次功能 calibration 无 flake，且 Baseline/Native/Guide 使用完全相同的
submission freeze、seed、evaluator image、case、权重和阈值。
