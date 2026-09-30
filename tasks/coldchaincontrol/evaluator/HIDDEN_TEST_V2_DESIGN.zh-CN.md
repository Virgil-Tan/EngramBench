# ColdChainControl Hidden Test v2 详细设计

本文件遵循 [`docs/hidden-test-v2-standard.zh-CN.md`](../../../docs/hidden-test-v2-standard.zh-CN.md)，只将
ColdChainControl 的公开 V1 合同与已发布 Manager 变更映射为黑盒测试。

## 1. 目标、权威来源与 SPEC-GAP

本方案定义 **51 个独立计分 case**，覆盖 edge configuration→signed telemetry→shipment projection→excursion→
notification 以及 FINAL custody/recall。测试不导入 Candidate 源码，不读取 ORM/私有表，不把现有 adapter 的通过
状态当产品证据。

权威顺序：`workspace/README.md` → 固定 Manager 消息 → `workspace/AGENTS.md` → `CONTEXT.md`。Scenario 和现有
evaluator 文本不是产品需求来源。

`SPEC-GAP-01`：V1 为多数 create/action route 发布了 request 与 resource fields，但没有统一发布精确 success
status、response wrapper、list cursor wire shape。测试精确验证已发布资源字段、行为、错误和 OpenAPI/runtime 一致，
但不发明未发布 wrapper/status；Task 作者冻结 wire contract 后再加入 exact assertion。

`SPEC-GAP-02`：Site radius 的距离公式与边界 rounding 未发布。测试只使用“坐标恰好等于 Site 中心”和“明显远离
所有 Site”的 fixture，不在半径边界猜测球面/平面算法。

`SPEC-GAP-03`：Notification payload、tenant-wide rate-limit window 算法和 DEAD_LETTER 的精确触发条件未发布。
测试只验证 matching-policy fan-out、跨 Dispatcher 共享限流、不超公开 `rateLimitPerMinute`、retry identity、redaction
与最终公开状态；不要求某种滑动/固定窗口或私有 payload 字段。

`SPEC-GAP-04`：README 发布了 `TEST_BARRIER_URL`/`TEST_BARRIER_TOKEN` 配置名，并要求 recovery tests 使用 barrier
hooks，但没有发布 barrier request/response、事件名、claim/effect/commit 时点或 release 协议。Evaluator 可以在公开
verification snapshot 已观察到 leased Work、receiver 已完整读取请求或公开 backlog 正在推进时执行进程级
SIGKILL/SIGSTOP；依赖精确 barrier 点的 stale-writer 子断言在协议冻结前为 `designed_unwired`，不得伪装成 passed。

## 2. 公共 seams 与隔离

| Seam | 允许操作 | 禁止操作 |
| --- | --- | --- |
| npm lifecycle | 公开 migrate/seed/build/start/test commands | 未发布入口、source import |
| HTTP/OpenAPI | health、`/openapi.json`、公开 `/api/v1` routes | debug/admin-private route |
| Verification snapshot | ADMIN_TOKEN 读取 resources/work/events/managerResources | 直查 Candidate 表 |
| Signed device boundary | 用 Harness fixture secret 计算公开 HMAC headers/readings/attestation | 读取 Candidate secret storage |
| Production browser | 系统 Chromium + production UI 可见控件 | 操纵内部 store/function |
| Receiver | 控制 webhook ACK/500/断线并记录公开请求 | 读取 Candidate outbox |
| Recovery observation | verification snapshot 的公开 leased Work、receiver ACK window 与公开 backlog；协议冻结后才接 TEST_BARRIER | 猜测私有 claim/effect/commit 或发明 barrier 协议 |
| Process boundary | 两 API、多 Workers/Dispatchers、SIGTERM/SIGKILL | 单进程对象模拟 |
| V1→FINAL checkpoint | 冻结 V1 binary 写状态、FINAL 原库升级 | FINAL 伪造 V1 |

除 migration cases 外，每 case 使用 fresh DB、端口、receiver、barrier、browser context 和 deterministic fixture。
结果使用统一 `caseId,dimension,weight,status,durationMs,evidenceDigest,privateFailureCode,publicFeedbackCategory`，基础设施故障单列
`evaluator_error`。

## 3. 独立 oracle 与 fixtures

`evaluationSeed + caseId + ordinal` 决定 UUID、Tenant、secret、sequence、reading/order 与交错；时间从可观察 DB
基准 `T0` 派生。Fixture families：`F-EMPTY`、`F-CONFIG`、`F-CREDENTIAL`、`F-TELEMETRY`、`F-SHIPMENT`、
`F-EXCURSION`、`F-NOTIFICATION`、`F-CUSTODY`、`F-RECALL`、`F-IDEMPOTENCY`、`F-WORK`、`F-MIGRATION`、
`F-BROWSER`、`F-PERF`。

独立 reference model 计算：

- Tenant ownership、cross-tenant non-disclosure、key/config version 单调性；
- exact HMAC lines、60-second DB-time auth window、reading identity/fingerprint；
- `(sequence,readingId)` 全序 replay、`lastSequence=max`、route monotonicity；
- 三连越界/三连恢复与 offline excursion 状态机；
- connected ShipmentLeg/CustodyHandoff order、window/revision/current Carrier；
- Recall 发布时受影响集合、QuarantineAction cardinality 与 authority fences；
- per-aggregate Event sequence、Work lease/attempt/fence、Notification logical delivery。

Worked example：先提交 sequence 4、5、6（越界），再补 1、2、3（in-range）。Oracle 按全序重算历史，允许 excursion
边界被更早 readings 修正，但 current `lastSequence=6`、当前 route/site 不得倒退。它区分“按到达顺序投影”的错误实现。

## 4. 固定评分

| 维度 | 分值 | Cases |
| --- | ---: | ---: |
| A. 需求与公共接口覆盖 | 30 | 16 |
| B. 数据正确性、幂等与并发 | 25 | 10 |
| C. Worker、恢复与持久性 | 20 | 8 |
| D. OpenAPI、UI 与跨层闭环 | 15 | 8 |
| E. 迁移、性能与可运维性 | 10 | 9 |
| **合计** | **100** | **51** |

## 5. A — 需求与公共接口覆盖（30 分）

### A-01 Clean lifecycle and independent roles（2 分）
- **前置**：clean checkout/DB，无 artifacts。
- **操作**：install、migrate 两次、build，独立启动 API/Worker/Dispatcher，健康检查并 SIGTERM。
- **断言**：production UI/OpenAPI 非空；三角色职责独立；退出无残留；配置错误 actionable 且不泄密。

### A-02 Populated migration and seed replay（2 分）
- **前置**：合法全状态 V1 seed。
- **操作**：seed、same version+content replay、runtime mutation、migration 重跑/restart。
- **断言**：replay no-op；resources/Work/Event/Audit/identities 不变；无重复 assignments/readings/deliveries。

### A-03 Atomic seed rejection and secret protection（2 分）
- **前置**：snapshot baseline 与单缺陷 seeds。
- **操作**：unknown/duplicate/broken ref/cross-tenant/bad state/secret/version conflict 导入。
- **断言**：整份失败、snapshot 无变化；secret 不在 response/log/Event/Audit/snapshot；无部分文件/Work。

### A-04 OpenAPI 3.1 route/error coverage（2 分）
- **前置**：V1/FINAL live API 和独立 contract model。
- **操作**：枚举公开 routes、device headers、requests、errors 与 success samples。
- **断言**：OpenAPI/runtime 一致；Manager routes/resources/errors/Work kinds 已描述；不对 SPEC-GAP-01 发明 schema。

### A-05 Strict input, error envelope and tenant isolation（1.5 分）
- **前置**：两个 Tenants 的相似资源 IDs。
- **操作**：malformed JSON、unknown field、bad UUID/time/int、missing resource、cross-tenant references。
- **断言**：stable error envelope；cross-tenant 不透露 foreign existence/ID；所有失败无 Work/Event/Audit/idempotency success。

### A-06 Device authentication and scalar boundaries（1.5 分）
- **前置**：active Device/key、DB time T0。
- **操作**：正确/错误 HMAC、path/device mismatch、窗口内 59 秒与窗口外 61 秒、bad hex/keyVersion、safe-int/range inputs。
- **断言**：公开窗口与 canonical line 精确；失败 401 且零副作用；token/signature 不泄露。

### A-07 Excursion list filters and stable cursor（1.5 分）
- **前置**：>100 excursions，多个 tenant/shipment/kind/state ties。
- **操作**：组合 filters、分页、malformed/cross-tenant cursor、restart continuation。
- **断言**：只返回本 tenant 匹配项、无重漏、稳定 order/cursor；invalid cursor 无状态变化。

### A-08 Tenant, Site, Carrier and Device catalog（2.5 分）
- **前置**：空 Tenant 与 duplicate/cross-tenant fixtures。
- **操作**：创建 resources，测试 Site code/radius、Carrier state、Device serial/current versions。
- **断言**：published fields/uniqueness/tenant ownership 正确；invalid reference atomic reject；snapshot exact cardinality。

### A-09 Gapless Config publication（2 分）
- **前置**：Tenant with no config, then DRAFT revisions。
- **操作**：create/publish revision N，保存其公开表示；再 create/publish N+1，重读 N；另发 stale expected-version publish。
- **断言**：versions gapless；N 在 N+1 发布前后 byte-semantic 等价且 immutable；CAS conflict no side effect；Event/Audit 与 state 同事务。

### A-10 Assignment delivery and acknowledgement（2 分）
- **前置**：active Device、two published revisions。
- **操作**：create assignment、device-auth GET config、ack exact assignment、stale/out-of-order ack、expiry。
- **断言**：one nonterminal assignment；currentConfigVersion 只升不降；Work/Event/Audit 收敛；stale ack stable error。

### A-11 Credential rotation and revocation（2 分）
- **前置**：Device current key v1。
- **操作**：rotate expected v1→v2、replay/conflict、revoke keys、用旧/新 keys 调用 config/telemetry。
- **断言**：version/current key 单一；old/revoked/not-yet-valid signature rejected；secret 永不回显；成功/失败原子。

### A-12 Signed telemetry acceptance（2 分）
- **前置**：active Shipment/Device/config，Harness 持有 fixture secret。
- **操作**：提交 valid reading、exact duplicate、changed same readingId/sequence、bad digest fields。
- **断言**：exact replay one reading；identity conflict 409；accepted reading 创建 projection Work/Event/Audit；失败零副作用。

### A-13 Shipment creation and activation（2.5 分）
- **前置**：connected 1/32-leg routes、suspended Carrier、inactive/busy Device、config variants。
- **操作**：create DRAFT、activate、invalid route/config/device/Carrier requests。
- **断言**：合法 freeze route/device/carrier/bounds/config；invalid atomic reject；active Device 不能复用；snapshot lineage 完整。

### A-14 Projection, excursion, cancellation and delivery（2 分）
- **前置**：active Shipment，center/far coordinates 与 temperature sequences。
- **操作**：投递 route readings、3 out/3 in、ack excursion、cancel/deliver attempts。
- **断言**：projection monotonic；excursion open/extend/resolve/ack semantics；unresolved TEMP blocks deliver；terminal fences pending work。

### A-15 Notification policies, deliveries and snapshot（1.5 分）
- **前置**：matching/nonmatching/disabled policies、multiple tenants。
- **操作**：触发 excursion/terminal Events，运行 Dispatchers，读取 snapshot。
- **断言**：每 matching policy/event 一个 logical delivery；shared rate bound、retry identity、redaction；snapshot single point-in-time/sorted。

### A-16 FINAL custody and recall public lifecycle（1 分）
- **前置**：valid chain steps、target lot Shipments。
- **操作**：create/offer/attested accept chain；create/quarantine recall；GET resources。
- **断言**：published shapes/states/revisions/Work kinds/errors；最后 handoff completes；recall reaches CONTAINED 且 action set 精确。

## 6. B — 数据正确性、幂等与并发（25 分）

### B-01 Config version/CAS contention（2.5 分）
- **前置**：两个 API、same next version/publish request。
- **操作**：32 路 same/different keys 并发 create/publish/assign/ack。
- **断言**：一个 authoritative next version/publication；无 gaps/duplicate nonterminal assignment；stale ack 不降级。

### B-02 Credential rotation versus ingest（2 分）
- **前置**：v1 current key 与预签 v1/v2 readings。
- **操作**：rotate/revoke 与两 API ingest barrier 同时释放。
- **断言**：每 accepted reading 对应线性化时有效 key；revocation 后旧 key 零 effect；currentKeyVersion 唯一单调。

### B-03 Telemetry identity and durable idempotency（2 分）
- **前置**：same readingId、same sequence、different canonical fields variants。
- **操作**：跨 API/restart exact replay 与 conflicts，response shield 丢已提交 response。
- **断言**：one identity/effect；original saved status/body；conflict 不改 projection Work/Event/Audit；semantic fingerprint 稳定。

### B-04 Device auth anti-replay boundary（2.5 分）
- **前置**：valid/foreign/superseded/revoked keys 与 timestamps。
- **操作**：同签名跨 path/device/tenant、window 内外、rotation 前后调用。
- **断言**：HMAC authority 不能跨上下文复用；所有 invalid 统一 401 不泄露原因；snapshot cardinality 不变。

### B-05 Hot-device two-API ordering（2.5 分）
- **前置**：500 Devices×100 sequences，20% exact duplicates。
- **操作**：64 clients 逆序/随机发两 API，三个固定 shuffle seeds。
- **断言**：每 identity 一条；lastSequence=100；projection 等于离线 oracle；无 deadlock/5xx/duplicate Event identity。

### B-06 Late-reading historical correction（2.5 分）
- **前置**：第 3 节 worked example 和 route-site variants。
- **操作**：先 high sequence 后 low sequence，排空 Workers，再全量 deterministic replay 对照。
- **断言**：历史 excursion 可更正；current sequence/site/leg 不回退；两次完整 rebuild 得相同 projection/history。

### B-07 Shipment activate/device/terminal races（3 分）
- **前置**：same Device 的两 DRAFT Shipments 与 config/Carrier mutations。
- **操作**：双 API 同时 activate、cancel/deliver，穿插 config supersession/Carrier suspend。
- **断言**：一个 active ownership；freeze 之后 immutable；terminal winner 单一；loser stable conflict、零 partial Work/Event。

### B-08 Excursion/offline race matrix（3 分）
- **前置**：接近 offline deadline 与 2 consecutive out/in readings。
- **操作**：late/new telemetry、offline check、ack/cancel/deliver 并发。
- **断言**：每 kind 最多一个 open logical excursion；三连规则按 ordered readings；new reading resolves offline；terminal state 不被旧 Work 改写。

### B-09 Custody handoff authority contention（2.5 分）
- **前置**：connected Chain 当前 OFFERED Handoff、two API/valid receiving credential。
- **操作**：32 路 accept/replay/conflict，穿插 revoke、expiry、Recall quarantine。
- **断言**：revision/currentOrdinal/Shipment Carrier 只前进一次；wrong/stale/revoked authority 失败；无 split custody。

### B-10 Recall frozen-set atomicity（2.5 分）
- **前置**：目标/non-target lot、active/terminal/chain/offered Shipments。
- **操作**：64 same-key/different-key recalls、deliver/handoff/telemetry concurrent。
- **断言**：一个 active Recall；发布瞬间集合冻结；每 target 一 Action、non-target 0；quarantine fence 后不能 activate/deliver/advance chain。

## 7. C — Worker、恢复与持久性（20 分）

### C-01 Work schema/lifecycle/retention（2 分）
- **前置**：所有 V1/FINAL Work kinds 的 pending/leased/terminal fixtures。
- **操作**：Workers claim/complete/retry，读取 snapshot。
- **断言**：stable identity/kind/aggregate/attempt/schedule/terminal；lease/fence fields 合同一致；terminal retained、backlog 可判定。

### C-02 Config assignment Worker kill（2.5 分）
- **前置**：20k assignments、4 Workers；公开 snapshot 已观察到 leased Work。
- **操作**：SIGKILL 两个正在处理 backlog 的 Worker，公开 lease 后启动 replacements；同时提交 stale acknowledgements。
- **断言**：全部 delivered/confirmed/expired；attempt 单调；无 version downgrade。精确 stale-owner-before-commit 断言仅在 `SPEC-GAP-04` 冻结后接线。

### C-03 Telemetry projection Worker kill（2.5 分）
- **前置**：shuffled hot Device backlog。
- **操作**：公开 snapshot 显示 leased Work 且 backlog 正在推进时 SIGKILL Workers，再启动 replacements；精确 effect-complete/before-commit 注入为 `SPEC-GAP-04` unwired。
- **断言**：最终 projection/excursion 等于 oracle；无 partial current/history 或 duplicate Event；精确 stale overwrite fence 待 barrier contract 冻结。

### C-04 Offline-check recovery and fencing（2.5 分）
- **前置**：接近 frozen offlineAfterSeconds 的 active Shipment。
- **操作**：snapshot 观察 A lease 后 SIGSTOP A 至 lease 过期，B open/resolve，再恢复 A 并提交 newer reading。
- **断言**：一个 OFFLINE excursion；new reading 只 resolve 一次；DB time authority。若不能由公开 snapshot 将 lease 绑定到 A，则“old A 不覆盖”子断言为 `SPEC-GAP-04` unwired。

### C-05 Handoff expiry and replacement（3 分）
- **前置**：当前 OFFERED Handoff 临近 windowEnd，expiry Work claimed。
- **操作**：snapshot 观察 expiry Work leased 后 kill claimant，replacement 与 accept race；精确释放 stale claimant 只在 `SPEC-GAP-04` 冻结后执行。
- **断言**：accept 或 expiry 仅一合法 winner；expiry cancels Chain 且不推进后续；old Carrier 不可写；精确 stale-Worker fence 子断言未接线时不得计为通过。

### C-06 Recall propagation/quarantine recovery（2 分）
- **前置**：2,500 target Actions、RECALL_PROPAGATE/QUARANTINE_ENFORCE Work。
- **操作**：snapshot 显示 leased Work 后 SIGKILL half Workers，replacement drain；同时尝试 terminal actions。
- **断言**：Recall CONTAINED、每 target APPLIED exactly once、non-target unchanged；精确旧 lease release fence 仅在 `SPEC-GAP-04` 冻结后接线。

### C-07 Dispatcher unknown ACK（3 分）
- **前置**：receiver 完整读取 request 后暂停 ACK。
- **操作**：kill Dispatcher A，B 经过 500/disconnect/timeout 再 2xx。
- **断言**：stable Event/NotificationDelivery identity 与 semantic body；at-least-once、不丢失；无 secret/signature/raw auth。

### C-08 Shared notification quota and ordering（2.5 分）
- **前置**：多 policies/events、two Dispatchers、small published rate limits。
- **操作**：同时启动、restart 一个 Dispatcher、receiver 记录时间与 attempts。
- **断言**：Tenant aggregate 不超过公开每分钟上限；process restart 不重置 quota；per aggregate sequence 有序；SPEC-GAP-03 算法不做额外要求。

## 8. D — OpenAPI、UI 与跨层闭环（15 分）

### D-01 OpenAPI validates live traffic（2 分）
- **前置**：独立 contract validator 与 V1/FINAL APIs。
- **操作**：每 route 采集 success/error，验证 auth headers、closed objects、nullable/enums。
- **断言**：live traffic 全通过；OpenAPI 不可用宽松 object 掩盖 tenant/secret/status mismatch。

### D-02 Browser configuration-to-live-shipment（2 分）
- **前置**：production UI、real API/DB/Workers。
- **操作**：先由公开 API fixture 发布/分配 config；浏览器只执行 README 已发布的 tenant selection、Shipment create/activate，并观察 Device/config state、telemetry projection/timeline。
- **断言**：浏览器步骤只用已发布的可见流程；Device/config/shipment/timeline 来自后端；refresh/second browser 一致。

### D-03 Browser excursions and notifications（2 分）
- **前置**：可制造 TEMP/OFFLINE excursions 的 fixture。
- **操作**：观察 open、ack、resolve、delivery status 与 audit search。
- **断言**：ack 不等于 resolve；async progress 与 snapshot/receiver 一致；terminal/error 状态不被 optimistic UI 伪造。

### D-04 Browser FINAL custody and recall（2.5 分）
- **前置**：multi-step Chain、target lot Recall。
- **操作**：UI 创建/offer/accept/expiry chain，发 recall、看 affected progress/quarantine。
- **断言**：动态 Handoffs/责任 Carrier/Actions 完整；conflict/recovery 可见；不泄露 attestation/secret。

### D-05 Loading/empty/conflict/stale/offline/retry/permission（1.5 分）
- **前置**：HTTP proxy 与各状态 fixtures。
- **操作**：delay/offline API、stale revision、tenant mismatch、bad auth、Worker/Dispatcher recovery。
- **断言**：每状态可见可恢复；retry 不重复 mutation；foreign resource/secret 不进入 DOM/log/bundle。

### D-06 Keyboard, focus, labels and mobile（1.5 分）
- **前置**：390px/1280px production UI。
- **操作**：纯键盘完成 Shipment/excursion/recall primary flows。
- **断言**：README 已发布流程的 labels/roles/status/focus management 正确；无不可达控件。

### D-07 Project-owned gates are real（1.5 分）
- **前置**：外部 process/DB/browser observer。
- **操作**：运行 unit/integration/e2e/concurrency/recovery/perf/all。
- **断言**：真实 PostgreSQL/production Chromium/2 API/process SIGKILL/receiver；project tests 可使用自有 deterministic hook，但外部 evaluator 不假定其协议；0-test、mock seam、核心 skip、always-zero 失败。

### D-08 README-to-evidence closure（2 分）
- **前置**：固定 requirement ledger。
- **操作**：README→HTTP→OpenAPI→UI→snapshot/Work/Event/receiver→hidden evidence 映射。
- **断言**：每个适用节点实际执行并一致；文件/route 字符串/测试名/自报结果不能闭环。

## 9. E — 迁移、性能与可运维性（10 分）

### E-01 Populated V1→FINAL migration（2 分）
- **前置**：V1 config/key/active Shipment/readings/projection/open excursion/replay/pending Work/Event/Audit。
- **操作**：冷停 V1，同库 FINAL migration 两次、boot/read。
- **断言**：全部 V1 identity/value/lease/sequence/replay 保持；managerResources 初始为空；迁移不产生业务 Event。

### E-02 Saved replay and credential/Event identity（1 分）
- **前置**：V1 success/conflict/unknown response replays、committed Events/keys。
- **操作**：FINAL 跨 APIs replay 与 dispatcher delivery。
- **断言**：原 status/body/identity 不变；secret protection 不退化；旧 Event bytes/sequence 不重写。

### E-03 Pending Work/delivery across migration（1 分）
- **前置**：V1 leased/pending config/projection/offline Work 与 ACK-unknown delivery。
- **操作**：upgrade、lease expiry、replacement drain、cold restart。
- **断言**：attempt/authority 保持；stale token 失败；业务/notification 只完成一次且 backlog 收敛。

### E-04 Signed telemetry ingest performance（1 分）
- **前置**：Harness-owned deterministic 100 Tenants/2k Devices/500 Shipments workload；这些数量是 evaluator fixture，不冒充 README 产品合同。
- **操作**：64 clients，10s warm-up+60s measure。
- **断言**：>=1500 accepted/s、p95<=120ms、非2xx=0；reading/Work/Event/Audit 精确 cardinality 且无泄密。

### E-05 Hot-device ordering performance（1 分）
- **前置**：500 Devices×100 sequences+20% duplicates、two APIs。
- **操作**：64 clients shuffled load，Workers drain。
- **断言**：>=900 requests/s、p95<=180ms；one identity、lastSequence100、projection oracle 与 Events 正确。

### E-06 Configuration rollout recovery performance（1 分）
- **前置**：20k Devices/new config、4 Workers。
- **操作**：kill two claimed，replacement；计时 60s。
- **断言**：全部 confirmed/delivered/expired；p95 queue age<=2s；无 downgrade、duplicate Work 或 stale commit。

### E-07 Excursion notification recovery performance（1 分）
- **前置**：5k Shipments、3 out+3 in、每 Tenant 两 policies。
- **操作**：two Dispatchers unknown ACK/replacement，计时 60s。
- **断言**：每 Shipment 一个 RESOLVED excursion；每 policy/event 一个 logical delivery；identity/body/quota 正确。

### E-08 Recall quarantine convergence performance（1 分）
- **前置**：10k active、2.5k target、500 Chains、500 OFFERED Handoffs。
- **操作**：64 clients replay/conflict、kill 2/4 Workers、并发 deliver/accept/telemetry，90s。
- **断言**：CONTAINED、恰好2500 APPLIED、non-target0、无 split custody/stale release/duplicate notification。

### E-09 Cleanup, reproducibility and log hygiene（1 分）
- **前置**：同 seed 两次非性能 runs。
- **操作**：比较 evidence；审计 processes/ports/DB locks/tmp/logs/artifacts。
- **断言**：结果确定；无残留/污染；secret/signature/token/body/path 不泄露；失败命令非零。

## 10. Hard caps、invalid 与 evaluator error

| 失败 | 总分上限 |
| --- | ---: |
| clean migrate/build/production boot 失败 | 25 |
| cross-tenant disclosure 或 credential/secret 泄露 | 25 |
| reading identity/projection/route current state 不确定或回退 | 35 |
| durable replay 产生第二 business effect | 30 |
| stale Worker 可覆盖 newer config/projection/terminal/custody/quarantine | 35 |
| Event/notification 丢失或 retry 改 identity/body | 40 |
| split custody、Recall partial set 或 quarantine fence 失效 | 35 |
| migration 丢 V1/改 replay/identity | 35 |
| performance 后核心 invariant 失败 | 对应 case 0，并应用 correctness cap |

读取 hidden assets/seed、特判 case、修改 evaluator、逃逸隔离、伪造 evidence 为 `invalid`。Harness 自身
DB/Chromium/receiver/port/image 故障为 `evaluator_error`，不得记 Candidate 失败。

## 11. Anti-fake-green、映射与 calibration

- HMAC、projection、excursion、custody、Recall expected 均由独立 oracle；
- signed request 成功至少由 HTTP + snapshot/Work/Event 两面确认；notification 由 snapshot + receiver 确认；
- recovery 通过公开 snapshot/receiver/backlog window 与进程边界取证；精确 barrier 子断言遵守 `SPEC-GAP-04`，performance 每轮后全量审计；
- Candidate tests 只在 D-07 验证真实性，不作为产品 oracle；
- 所有 arm 使用同一 frozen submission、Manager text、seed、evaluator image 和权重。

每个失败断言使用确定性私有 code `CCC.<CASE_ID>.<ASSERTION_SLUG>`；公开结果只返回下表的最小
`publicFeedbackCategory`，不暴露 fixture、oracle、mutant 或隐藏时序。下表是非重叠 contract-map，展开 range 后每个
Case 恰好出现一次。

| Case range | 唯一公开合同族 | publicFeedbackCategory |
| --- | --- | --- |
| A-01～A-03 | lifecycle、migration、seed、secret protection | `setup_migration_failure` |
| A-04～A-07 | HTTP/OpenAPI、validation、auth、query contract | `public_contract_failure` |
| A-08 | Tenant/Site/Carrier/Device catalog | `catalog_failure` |
| A-09～A-11 | Config assignment 与 credential lifecycle | `configuration_failure` |
| A-12 | signed telemetry acceptance | `telemetry_contract_failure` |
| A-13～A-15 | Shipment、Excursion、Notification V1 flow | `shipment_flow_failure` |
| A-16 | FINAL custody/recall public contract | `final_contract_failure` |
| B-01～B-04 | config/credential/telemetry identity concurrency | `idempotency_concurrency_failure` |
| B-05～B-06 | telemetry ordering/projection correction | `projection_correctness_failure` |
| B-07～B-08 | Shipment/excursion terminal races | `terminal_race_failure` |
| B-09 | Custody authority contention | `custody_concurrency_failure` |
| B-10 | Recall frozen-set atomicity | `recall_atomicity_failure` |
| C-01 | Work lifecycle/retention | `work_contract_failure` |
| C-02～C-06 | Worker public-effect recovery/fencing | `worker_recovery_failure` |
| C-07～C-08 | Dispatcher delivery/quota recovery | `delivery_recovery_failure` |
| D-01 | OpenAPI/live validation | `openapi_failure` |
| D-02～D-06 | production UI 与跨层流程 | `cross_layer_failure` |
| D-07～D-08 | project gates 与 evidence closure | `evidence_failure` |
| E-01～E-03 | populated V1→FINAL compatibility | `upgrade_compatibility_failure` |
| E-04～E-05 | telemetry ingestion/ordering performance | `performance_failure` |
| E-06～E-08 | rollout/notification/recall recovery performance | `recovery_performance_failure` |
| E-09 | cleanup、reproducibility、log hygiene | `operability_failure` |

| 原 Gate | v2 cases |
| --- | --- |
| H-01～H-02 | A-01～A-08、D-01、E-09 |
| H-03～H-06 | A-09～A-15、B-01～B-08 |
| H-07～H-08 | C-01～C-08 |
| H-09 | E-01～E-03 |
| H-10～H-11/H-18～H-20 | A-16、B-09、B-10、C-05、C-06、D-04 |
| H-12 | E-04～E-08 |
| H-13 | D-07、E-09 |
| H-14～H-17 | A-09～A-15、B-01～B-08、C-02～C-04/C-07/C-08 |

Calibration mutants：process-local replay（B-03）、accept revoked key（B-02/B-04）、arrival-order projection（B-05/B-06）、
lastSequence rollback（B-06）、mutable published config（A-09）、no Work fence（C-02～C-06）、route/site regression
（A-14）、notification process-local quota（C-08）、cross-tenant leak（A-05）、partial custody accept（B-09）、Recall dynamic
rather than frozen set（B-10）、migration drops pending Work（E-03）、throughput-only perf（E-04～E-08）、fake UI/tests（D-02/D-07）。
Gold 全过；每 mutant 同 seed 三次稳定命中目标 case。

## 12. 实施顺序与完成标准

先实现 A-01/A-03/A-12、B-03/B-05/B-06 打通 signed ingest oracle；再完成 C-02/C-03/C-07 的公开 snapshot/receiver recovery；
实现 D-01/D-02 后接 FINAL custody/recall；再接真实 V1 checkpoint 完成 E-01～E-03；最后独占固定 4CPU/8GiB
实现 E-04～E-08。依赖精确 claim/effect/commit hook 的子断言等待 `SPEC-GAP-04` 协议冻结。

正式启用需要：51 个唯一 IDs、每维精确 30/25/20/15/10、总分100、唯一 requirement mapping、SPEC-GAP 不计分、
gold 全过、mutants 稳定失败、同 seed 三次非性能无 flake、public report 不泄露 fixture。
