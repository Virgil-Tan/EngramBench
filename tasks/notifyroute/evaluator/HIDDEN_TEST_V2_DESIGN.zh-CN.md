# NotifyRoute Hidden Test v2 设计

## 计分边界

- 权威顺序：`workspace/README.md` → `orchestration/manager-prompt.zh-CN.md` → `CONTEXT.md`；旧 E2E 只作映射。
- 22 个名义 Case，A/B/C/D/E=30/25/20/15/10，总权重 100；`primarySkill` 聚焦 S05、S07、S14、S15，其他相关能力只列入 `secondarySkills`；S03/S16 只可作 observer。D-02 的固定 secret HMAC 仅以 `secondarySkills=S18` 表示辅助签名能力，不作为 credential lifecycle 的 S18 confirmed source。
- install/build/migrate/boot/health/OpenAPI parse/Chromium shell/evaluator isolation 是不计分 preflight。
- Oracle 使用 harness 的冻结路由、suppression/rate-window、provider receiver 和受众账本，不以候选 snapshot、日志或 UI 文案自证。

## SPEC-GAP 与评分就绪状态

- `SPEC-GAP-NR-01`：Manager 只发布 `POST /api/v1/campaigns` 路径，未发布 Campaign/CampaignRecipient wire shape、create body/response、GET 或 pause/resume/cancel 路径、稳定错误。A-05、B-05、C-03、C-04、D-04 标记 `blockedBy=SPEC-GAP-NR-01`；合同补齐前不得运行或把其权重转给别题。
- `SPEC-GAP-NR-02`：Manager 未发布 Campaign 事件 type/payload；测试只验证已发布 V1 event 规则及“不臆造新事件名”。
- `SPEC-GAP-NR-03`：旧 E2E 的三个性能场景、dataset 与阈值未出现在 README/Manager。E-02..E-04 标记 `blockedBy=SPEC-GAP-NR-03`，不得把旧 H-12 当需求来源。
- 因存在 blocked Case，本设计名义总分为 100，但任务在合同补齐前不是可执行的 100 分 score manifest。

## Worked example

fixture 为同一 tenant/recipient 配置 Email→SMS fallback、当前 suppression revision、每分钟窗口和一个首 Provider 返回 UNKNOWN 的 receiver。创建 Notification 后，oracle 固定 TemplateVersion/data/RoutePolicy；UNKNOWN 必须保留稳定 providerRequestId，receipt 与 reconcile 两种顺序都收敛同一 Delivery，且在 suppression 生效时不得调用下一 Provider。receiver ledger、HTTP 查询和事件序列三方不一致即失败。

## Scoring Cases

### A-01 Notification 冻结模板、数据与 RoutePolicy — 6 分
来源：README「Routing and content contract」；Fixture：可变 Template/RoutePolicy 与创建前后 revision；动作：公开 create/read seam。
Oracle/Mandatory：按创建提交点冻结 TemplateVersion、canonical data 和 policy revision，渲染/路由严格使用冻结值；禁止副作用：后续编辑不得倒灌，拒绝请求不得创建 Notification/Delivery/Event。
归因：dimension: A；primarySkill=S05；secondarySkills=S06；feedback=A.freeze-contract；mutant=M01。

### A-02 Suppression fence 在 Provider 调用前生效 — 6 分
来源：README「Consent and unsubscribe contract」；Fixture：tenant/recipient/channel suppression 及 receiver；动作：创建、取消订阅并驱动发送。
Oracle/Mandatory：harness 按 revision/作用域计算 SUPPRESSED，receiver 调用数为零；禁止副作用：不得先外呼再补写 suppression，不得回退到被 suppression 的 channel。
归因：dimension: A；primarySkill=S05；secondarySkills=S06；feedback=A.suppression；mutant=M02。

### A-03 双层 rate window 与有序 fallback — 6 分
来源：README「Rate limits」「Routing and content contract」；Fixture：tenant 与 recipient 窗口边界、首通道失败/抑制；动作：数据库时钟下发送序列。
Oracle/Mandatory：独立 token/window 模型断言两层上限、只在合同失败/抑制后按冻结顺序 fallback；禁止副作用：被拒尝试不得消耗错误窗口或跳通道。
归因：dimension: A；primarySkill=S05；secondarySkills=S04；feedback=A.rate-routing；mutant=M03。

### A-04 Provider UNKNOWN、receipt 与 reconcile 收敛 — 6 分
来源：README「Provider uncertainty and duplicate protection」；Fixture：stable providerRequestId、延迟/重复 receipt；动作：发送、webhook receipt、reconcile 两种排列。
Oracle/Mandatory：所有排列收敛同一合法 Delivery 终态、稳定 provider identity、最多一次业务 Delivery；禁止副作用：UNKNOWN 不得当失败触发重复外发或伪造成功。
归因：dimension: A；primarySkill=S05；feedback=A.provider-uncertainty；mutant=M04。

### A-05 Campaign 创建原子冻结受众 — 6 分
blockedBy=`SPEC-GAP-NR-01`；来源：Manager 规则 1、3、7；Fixture：重复 recipientIds、Template/Policy/Suppression 随后变更；动作：待发布的 Campaign create/read seam。
Oracle/Mandatory：去重受众、TemplateVersion、RoutePolicy revision、Suppression revision 同事务冻结且每 recipient 最多一 Notification；禁止副作用：不得动态扫描受众或部分创建。
归因：dimension: A；primarySkill=S05；secondarySkills=S06,S17；feedback=A.manager-freeze；mutant=M05。

### B-01 Notification mutation 的 durable replay — 5 分
来源：README durable idempotency/public mutations；Fixture：相同 key、语义冲突、response shield、API restart；动作：跨实例重放 create/cancel 类已发布 mutation。
Oracle/Mandatory：原 status/body/IDs 逐语义相同且一个业务效果；禁止副作用：key conflict 不得写 Delivery/Work/Event。
归因：dimension: B；primarySkill=S05；secondarySkills=S04；feedback=B.idempotency；mutant=M06。

### B-02 Dispatcher 多实例只共享一个受控发送身份 — 5 分
来源：README provider duplicate protection 与 durable Work；Fixture：同一 Delivery、两个 dispatcher/receiver；动作：并发 claim/send。
Oracle/Mandatory：外呼均携带同一稳定 providerRequestId，状态转移线性化；禁止副作用：不得为同一 Delivery 生成新 provider identity 或越过 suppression/rate fence。
归因：dimension: B；primarySkill=S07；secondarySkills=S05；feedback=B.dispatch-contention；mutant=M04。

### B-03 Suppression 与 send claim 竞争可解释 — 5 分
来源：README suppression fence；Fixture：barrier 位于外呼前、并发 unsubscribe；动作：两个 API/dispatcher 交错。
Oracle/Mandatory：仅接受按数据库提交点可串行化的“已外呼”或“零外呼 SUPPRESSED”结果；禁止副作用：suppression 先提交后仍外呼，或 receiver 有请求但状态伪装 SUPPRESSED。
归因：dimension: B；primarySkill=S05；secondarySkills=S04；feedback=B.linearizability；mutant=M02。

### B-04 Receipt/reconcile 重复与逆序交换律 — 5 分
来源：README provider receipt/reconciliation 规则；Fixture：重复 receipt、reconcile 结果和不同到达顺序；动作：公开 webhook/admin reconcile seam。
Oracle/Mandatory：全排列的最终 Delivery/Notification、事件 identity 与 provider identity 相同；禁止副作用：不得状态回退、重复 terminal event 或第二发送。
归因：dimension: B；primarySkill=S05；feedback=B.commutativity；mutant=M07。

### B-05 Campaign pause/resume/cancel 与 fan-out 串行化 — 5 分
blockedBy=`SPEC-GAP-NR-01`；来源：Manager 规则 2、4、5、6；Fixture：部分已 ACCEPTED、部分未创建、旧 lease；动作：待发布控制 seam 与 worker claim 并发。
Oracle/Mandatory：pause 阻止新 fan-out、resume 只续未创建者、cancel fence 未创建/未外发项且保留 ACCEPTED 真实状态；禁止副作用：CANCELLED 后旧 lease 不得创建/外发。
归因：dimension: B；primarySkill=S07；secondarySkills=S04,S17；feedback=B.manager-linearization；mutant=M08。

### C-01 Provider UNKNOWN 后 crash/restart 不重复身份 — 5 分
来源：README unknown outcome/recovery；Fixture：外部效果完成与 commit 前 barrier；动作：SIGKILL worker/dispatcher 并恢复。
Oracle/Mandatory：以原 providerRequestId 查询/重试并收敛，业务 Delivery 唯一；禁止副作用：不得换 identity 再发或把未知直接标终态失败。
归因：dimension: C；primarySkill=S07；secondarySkills=S05；feedback=C.unknown-outcome；mutant=M04。

### C-02 Webhook unknown ACK 保持 event/body/order — 5 分
来源：README event dispatcher 规则；Fixture：receiver 500、断连、持久化 body 后暂停 ACK；动作：SIGKILL/restart dispatcher。
Oracle/Mandatory：重试 eventId/body 不变且同 aggregate 成功顺序递增；禁止副作用：不得丢 committed event、为 rollback 发 event 或产生新 identity。
归因：dimension: C；primarySkill=S07；feedback=C.outbox-recovery；mutant=M09。

### C-03 Campaign fan-out lease 恢复与 recipient 闭合 — 5 分
blockedBy=`SPEC-GAP-NR-01`；来源：Manager 规则 3、6、7；Fixture：冻结 recipient ledger、CAMPAIGN_FANOUT barrier、两个 worker；动作：claim 后 kill/过期/reclaim。
Oracle/Mandatory：每 recipient 最多一 Notification，完成时全部成员有明确终态，旧 token 不能提交；禁止副作用：不得漏永久 pending 或重复 recipient effect。
归因：dimension: C；primarySkill=S07；secondarySkills=S17；feedback=C.fanout-recovery；mutant=M10。

### C-04 Campaign cancel fencing 的崩溃边界 — 5 分
blockedBy=`SPEC-GAP-NR-01`；来源：Manager 规则 4–6；Fixture：fan-out 创建前、外呼前、ACCEPTED 后三个 barrier；动作：各点 cancel+SIGKILL+restart。
Oracle/Mandatory：未创建/未外呼被 fence，已 ACCEPTED 保留真实状态，Run 终态单调；禁止副作用：restart 不得复活 CANCELLED 工作或撤销 Provider 事实。
归因：dimension: C；primarySkill=S07；secondarySkills=S17；feedback=C.cancel-recovery；mutant=M08。

### D-01 V1 wire shape、错误、分页和 tenant scope — 4 分
来源：README「Exact public shapes」「Public HTTP surface」；Fixture：边界字段、未知键、游标、跨 tenant IDs；动作：仅 HTTP。
Oracle/Mandatory：精确 shape/envelope/code/排序，读与拒绝零 mutation；禁止副作用：不得容忍额外字段、跨 tenant 泄露或用 OpenAPI 替代 runtime 断言。
归因：dimension: D；primarySkill=S15；feedback=D.api-contract；mutant=M01。

### D-02 Webhook HMAC 与重放边界 — 4 分
来源：README provider webhook 签名合同；Fixture：正确/错误/过期签名、原始 body 差异；动作：公开 webhook seam。
Oracle/Mandatory：只接受精确签名语义并将重复 receipt 幂等归并；禁止副作用：失败鉴权不得改变 Delivery/Event，日志不得含 secret/raw body。
归因：dimension: D；primarySkill=S15；secondarySkills=S05,S18；feedback=D.security-contract；mutant=M07。

### D-03 浏览器完成通知、suppression 与 provider 状态流 — 4 分
来源：README UI/真实生产数据要求；Fixture：真实 DB/API/worker/receiver、桌面移动 viewport；动作：仅可见控件创建、观察 fallback/UNKNOWN、unsubscribe、refresh。
Oracle/Mandatory：UI 与 HTTP/receiver ledger 一致，loading/empty/conflict/offline/terminal 和键盘焦点可用；禁止副作用：不得 mock 或隐藏 Provider UNKNOWN。
归因：dimension: D；primarySkill=S15；feedback=D.browser；mutant=M03。

### D-04 浏览器 Campaign 控制与冻结进度 — 3 分
blockedBy=`SPEC-GAP-NR-01`；来源：Manager 规则 1–9；Fixture：混合成员和 worker；动作：待发布 UI/API 完成 create/pause/resume/cancel。
Oracle/Mandatory：可见受众/进度/成员状态与独立 ledger 一致，refresh 后保持；禁止副作用：不得用 client-only 状态或把 ACCEPTED 显示为撤回。
归因：dimension: D；primarySkill=S15；secondarySkills=S17；feedback=D.manager-ui；mutant=M08。

### E-01 Populated V1 到 Campaign FINAL 的兼容迁移 — 3 分
来源：Manager 规则 7、8；Fixture：V1 Notification/Delivery/Suppression/RateLimit/Receipt/Event/Work 和 saved replay；动作：升级、恢复、重放。
Oracle/Mandatory：所有 V1 identity/body/sequence/replay 保持，新增 `CAMPAIGN_FANOUT` 不改变旧 Work；禁止副作用：不得重编号、重发或把 V1 数据隐式归入 Campaign。
归因：dimension: E；primarySkill=S05；secondarySkills=S02,S17；feedback=E.compatibility；mutant=M05。

### E-02 Notification ingest 固定持续负载 — 3 分
blockedBy=`SPEC-GAP-NR-03`；来源待补：README/Manager 尚未发布 workload；Fixture/动作：只能在 dataset、selector、并发、时长、阈值全部公开后冻结。
Oracle/Mandatory：必须同时验证吞吐/延迟/5xx 与 Notification/Delivery 不变量；禁止副作用：不得采用旧 E2E 私有阈值或自行缩放。
归因：dimension: E；primarySkill=S14；feedback=E.performance-gap；mutant=M06。

### E-03 Hot-recipient quota 固定竞争负载 — 2 分
blockedBy=`SPEC-GAP-NR-03`；来源待补：公开合同缺 workload；Fixture/动作：待发布 recipient 分布、窗口、计时和阈值。
Oracle/Mandatory：独立窗口模型和负载后守恒必须共同通过；禁止副作用：不得只测吞吐或把 expected throttles 计为 5xx。
归因：dimension: E；primarySkill=S14；secondarySkills=S05；feedback=E.contention-gap；mutant=M03。

### E-04 Delivery recovery 固定恢复负载 — 2 分
blockedBy=`SPEC-GAP-NR-03`；来源待补：公开合同缺 kill/replacement/完成窗口；Fixture/动作：待公开 barrier 点和规模。
Oracle/Mandatory：恢复时限与 provider/event identity 不变量同验；禁止副作用：不得用随机 sleep 或旧 E2E 数字补合同。
归因：dimension: E；primarySkill=S14；secondarySkills=S07,S17；feedback=E.recovery-load-gap；mutant=M10。

## Task-specific mutants

| Mutant | 缺陷 | 必杀 Case |
|---|---|---|
| M01 | 创建时不冻结 TemplateVersion/RoutePolicy | A-01、D-01 |
| M02 | Provider 调用后才检查 suppression | A-02、B-03 |
| M03 | rate limit 仅进程内或 fallback 跳序 | A-03、E-03 |
| M04 | UNKNOWN 重试生成新 providerRequestId | A-04、C-01 |
| M05 | Campaign worker 动态读取受众/revision | A-05、E-01 |
| M06 | 幂等记录晚于业务 commit | B-01、E-02 |
| M07 | receipt/reconcile 可回退或重复终态事件 | B-04、D-02 |
| M08 | pause/cancel 不 fence 旧 fan-out/send lease | B-05、C-04、D-04 |
| M09 | webhook ACK 重试更换 eventId/body | C-02 |
| M10 | fan-out crash 后重复或永久遗漏 recipient | C-03、E-04 |

## Coverage mapping

**README / Manager → Case**

| README/Manager requirement | Cases |
|---|---|
| Freeze、routing、suppression、rate limit | A-01..A-03、B-03、D-03 |
| Provider uncertainty、receipt/reconcile | A-04、B-02、B-04、C-01、D-02 |
| Durable replay、event、recovery | B-01、C-01..C-02 |
| Campaign freeze/fan-out/control/migration | A-05、B-05、C-03..C-04、D-04、E-01 |
| Public HTTP/snapshot/UI | D-01..D-04 |
| 性能 | E-02..E-04（blocked） |

**旧 H → Case**

| 旧 E2E H family | v2 Cases |
|---|---|
| H-01 | 不计分 preflight |
| H-02..H-04 | A-01..A-04、D-01、D-03 |
| H-05..H-08 | B-01..B-04、C-01..C-02、D-02 |
| H-09 | E-01 |
| H-10..H-11 | A-05、B-05、C-03..C-04、D-04（blocked） |
| H-12 | E-02..E-04（SPEC-GAP，旧文档不能供权威） |
| H-13 | D 维度的项目证据，不另计分 |

## Evidence 与 hard caps

每个可运行 Case 保存 fixture、公开 HTTP、receiver ledger、barrier transcript、独立 oracle diff 和 snapshot digest。suppression 之后仍外呼、Campaign 重复成员效果或终态回退使总分上限 35；durable replay 产生第二业务效果上限 30；stale worker 越 fence 或合法 Work 丢失上限 40；迁移改写 V1 identity/replay 上限 35；性能不变量失败则相应 Case 为 0 并应用 correctness cap。blocked Case 不得静默跳过、改权或用实现现状补协议。
