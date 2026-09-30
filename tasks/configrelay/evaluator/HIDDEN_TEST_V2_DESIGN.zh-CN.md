# ConfigRelay Hidden Test V2 设计

> 只设计 runner contract，不实现代码。公共 install/build/migrate/boot/health 是共享不计分 preflight。计分只走公开 seed 命令、HTTP/OpenAPI、Agent poll/ack、barrier/receiver、Chromium 与 verification snapshot。

## 1. 画像与隔离

- **两项主机制**：Agent 单调 commandSequence 与稳定 delivery identity；冻结 cohort、健康门槛、失败后精确成员自动 rollback。
- **五维评分**：`A-01..05` 公开接口合同 30 分；`B-01..05` 数据正确性/幂等/并发 25 分；`C-01..04` Worker/恢复/持久性 20 分；`D-01..04` OpenAPI/UI/snapshot 跨层闭环 15 分；`E-01..04` 迁移/性能/可运维 10 分。
- **核心 primarySkill（4 个）**：`S05` `replay-precedence-and-identity-scope`、`S06` `ordered-authority-and-frozen-membership`、`S07` `durable-work-fenced-recovery`、`S17` `frozen-fanout-aggregate-closure`。seed/迁移、性能、跨层等相关官方 Skill 仅在对应 Case 作 `secondarySkills`。
- **failure isolation**：每 Case 新 database/fleet/Agent pool/ports；Agent IDs、labels、config bytes 与 acknowledgement 排列由确定 seed 产生。E-01..03 每场景独立 formal seed。Case 分数不因别的 Case setup 级联；hard cap 单独应用。

## 2. 计分 Case（22 个，100 分）

### A-01 Configuration 发布的 runtime 合同 — 6 分

- **dimension / 权重**：`A` / 6 分。
- **来源 / fixture / seam 动作**：README Configuration wire/API/common errors；通过公开 HTTP 提交 RFC8785 JSON 值、未知字段、错误 media/JSON、current/stale expectedFleetRevision 与 1MiB 边界。
- **独立 oracle / mandatory assertions / 禁止副作用**：成功响应恰为 Configuration shape，revision 是下一正整数，canonicalDigest 由独立 RFC8785+SHA-256 得出；stale 精确 `FLEET_REVISION_CHANGED`，公共错误 envelope/status 精确；所有拒绝均不得留 Configuration/Event 或推进 Fleet。
- **primarySkill / secondarySkills / feedback / mutant**：`S06` / `S01` / `A.CONFIGURATION_CONTRACT` / `CR-M01`。

### A-02 legacy Deployment create/cancel 公开合同 — 6 分

- **dimension / 权重**：`A` / 6 分。
- **来源 / fixture / seam 动作**：README Deployment create/detail/cancel API；用合法/非法 selector、missing resources、terminal/nonterminal Deployment 调用公开 route。
- **独立 oracle / mandatory assertions / 禁止副作用**：202/create 与 detail 保持 exact V1 Deployment shape，targetCount/targetDigest/state/nullability 合同化；cancel 只在合法状态成功，terminal 精确 `DEPLOYMENT_NOT_CANCELLABLE`，invalid selector 精确 `INVALID_AGENT_SELECTOR`；拒绝不得留 Deployment/Assignment/Work/Event。
- **primarySkill / secondarySkills / feedback / mutant**：`S06` / `S01` / `A.LEGACY_DEPLOYMENT_CONTRACT` / `CR-M06`。

### A-03 Agent poll/ack 的 exact wire 与稳定错误 — 6 分

- **dimension / 权重**：`A` / 6 分。
- **来源 / fixture / seam 动作**：README AgentPollResponse/Acknowledgement wire、poll/ack route 与 errors；分开提交 COMMAND/NO_CHANGE、完整合法 ack、stale token、异 outcome 与 malformed/unknown-field request。
- **独立 oracle / mandatory assertions / 禁止副作用**：poll status/command nullability 与 Assignment shape 精确；合法 ack 返回合同结果，单独的 stale token 精确 `STALE_ASSIGNMENT_TOKEN`，单独的异 outcome 精确 `ACKNOWLEDGEMENT_CONFLICT`；不得对未发布的复合错误优先级作断言，不得在拒绝时改状态/Event。
- **primarySkill / secondarySkills / feedback / mutant**：`S05` / `S01,S06` / `A.AGENT_COMMAND_CONTRACT` / `CR-M04`。

### A-04 staged Cohort create/detail 合同 — 6 分

- **dimension / 权重**：`A` / 6 分。
- **来源 / fixture / seam 动作**：Manager staged create/detail wire 与 errors；提交 omitted、1/20、0/21 cohorts，threshold 0/10000/越界、observationSeconds 1/86400/越界、非法 name/selector 与 zero/multi-match partition。
- **独立 oracle / mandatory assertions / 禁止副作用**：omitted 继续 exact V1 shape；合法 staged response 添加严格 DeploymentCohort[]/rollback:null 且 ordinal 有序；plan 错精确 `INVALID_COHORT_PLAN`，partition 错精确 `COHORT_TARGET_PARTITION_INVALID`；拒绝不得留任何聚合/Work/Event。
- **primarySkill / secondarySkills / feedback / mutant**：`S17` / `S01,S06` / `A.STAGED_DEPLOYMENT_CONTRACT` / `CR-M06`。

### A-05 RolloutCommand/Rollback 与 legacy 兼容表面 — 6 分

- **dimension / 权重**：`A` / 6 分。
- **来源 / fixture / seam 动作**：Manager RolloutCommand、DeploymentRollback、poll/ack 增量合同；通过公开 staged 流程观察 APPLY/ROLLBACK command、failed Deployment rollback，并对照 legacy poll/detail。
- **独立 oracle / mandatory assertions / 禁止副作用**：Manager shapes/state/nullability 与 `AGENT_COMMAND_SEQUENCE_CONFLICT` 精确，staged poll 仅按合同扩展 command union；legacy detail/poll 不混入 cohorts/rollback/RolloutCommand，rollback 不创建 event；不得泄漏 token 或私有字段。
- **primarySkill / secondarySkills / feedback / mutant**：`S17` / `S01,S06` / `A.ROLLOUT_WIRE_COMPATIBILITY` / `CR-M06`。

### B-01 selector 冻结与 per-Agent 有序 command 权威 — 5 分

- **dimension / 权重**：`B` / 5 分。
- **来源 / fixture / seam 动作**：README policy 1–4；创建 labels 交集与多 Deployments，部署后改 label/新增 Agent，重复 poll 并断连/重连。
- **独立 oracle / mandatory assertions / 禁止副作用**：创建时 AND exact selector 的 agentId 排序+newline SHA-256 得出永不变的 members/count/digest；每 Agent commandSequence 从 1 gapless，只返回最低非终态，revision 不降且 identity/body/token 稳定；不得动态扩缩、越序或丢队列。
- **primarySkill / secondarySkills / feedback / mutant**：`S06` / `S07,S17` / `B.FROZEN_ORDERED_COMMAND` / `CR-M02`。

### B-02 Deployment/ack/cancel 的幂等与身份作用域 — 5 分

- **dimension / 权重**：`B` / 5 分。
- **来源 / fixture / seam 动作**：README durable idempotency、ack/cancel invariants；response shield 后跨两 API processes 并发 replay/restart/异 payload，每个子 fixture 只违反 request key 或 ack tuple/token/sequence 一层，并对 mixed WAITING/SENT/ACKED 取消。
- **独立 oracle / mandatory assertions / 禁止副作用**：合法 replay 原 status/semantic JSON 且只一 target/command/ack/cancel effect，同 key 异语义精确 conflict，仅 next current token 的合法 ack 改状态；cancel 只 supersede 未 ack；不断言两层同时非法的优先级，不得第二 effect/sequence/Work/Event 或 synthetic downgrade。
- **primarySkill / secondarySkills / feedback / mutant**：`S05` / `S04,S06` / `B.DURABLE_REPLAY_SCOPE` / `CR-M04`。

### B-03 Cohort partition、counts 与基点健康门 — 5 分

- **dimension / 权重**：`B` / 5 分。
- **来源 / fixture / seam 动作**：Manager rules 1–3；三 cohort exact-one partition，targetCount 3/7/10，threshold 边界，deadline 前部分/全部 ack 与 deadline 后 missing。
- **独立 oracle / mandatory assertions / 禁止副作用**：外部重算每个 frozen member 恰属一 cohort、仅 ordinal 0 active，success+failure+pending=targetCount；用 BigInt 独立算 floor(count×10000/targetCount)，deadline 将 missing 全转 failure 并仅决定一次；不得 round、换 denominator、投递后续 cohort 或留下 partial plan。
- **primarySkill / secondarySkills / feedback / mutant**：`S17` / `S06,S13` / `B.COHORT_HEALTH_INVARIANT` / `CR-M08`。

### B-04 成功 Cohort 的唯一有序后继 — 5 分

- **dimension / 权重**：`B` / 5 分。
- **blockedBy**：`SPEC-GAP-CR-02`；成功推进公开语义补齐前不得运行或重新归一化。
- **来源 / fixture / seam 动作**：Manager ordered Cohorts/evaluate semantics；ordinal 0 刚好成功，随后对 ordinal 1 poll 并重放 deadline/ack。
- **独立 oracle / mandatory assertions / 禁止副作用**：ordinal 0 恰一 SUCCEEDED，ordinal 1 才开始且有独立 deadline/command identities，最多一 active cohort；不得跳序、并行激活、重用前 cohort identity 或改 frozen members。
- **primarySkill / secondarySkills / feedback / mutant**：`S17` / `S06` / `B.ORDERED_COHORT_ADVANCE` / `CR-M07`。

### B-05 失败 Cohort 的 rollback affected-set 与闭合 — 5 分

- **dimension / 权重**：`B` / 5 分。
- **来源 / fixture / seam 动作**：Manager rules 4–5；前两 cohorts 中部分 APPLY 已改变 Agent，第二 cohort 失败，与晚 ack/label change 三个固定交错并发。
- **独立 oracle / mandatory assertions / 禁止副作用**：失败事务冻结恰为当前及早先 cohorts 中 successful APPLY 真正改版的 Agents，其他 pending APPLY 全 SUPERSEDED，每 affected Agent 恰一新 ROLLBACK、sequence 严格增、全终态才闭合；不得纳入晚成员/未应用者、漏成员或提前 complete。
- **primarySkill / secondarySkills / feedback / mutant**：`S17` / `S04,S06,S07` / `B.ROLLBACK_AFFECTED_SET` / `CR-M09`。

### C-01 ASSIGNMENT_DELIVERY 的三断点接管 — 5 分

- **dimension / 权重**：`C` / 5 分。
- **来源 / fixture / seam 动作**：README Work/barrier；分别在 `worker.claimed`、`worker.effect-complete`、`worker.before-commit` 持有 ASSIGNMENT_DELIVERY 时 SIGKILL，lease 过期后启 replacement。
- **独立 oracle / mandatory assertions / 禁止副作用**：原 workId/attempt 可追踪且终态保留，replacement 排空，Assignment 恰一 WAITING→SENT，deliveryId/body/token 稳定，stale owner 无提交；不得重复 command/event、跳 sequence 或网络等待持事务。
- **primarySkill / secondarySkills / feedback / mutant**：`S07` / `S05,S06` / `C.ASSIGNMENT_RECOVERY` / `CR-M03`。

### C-02 COHORT_DEADLINE 恢复与最后 ack 单次裁决 — 5 分

- **dimension / 权重**：`C` / 5 分。
- **来源 / fixture / seam 动作**：Manager rule 3/FINAL Work；固定两类不依赖 CR-02 的 fixture：非末 cohort 必然失败或末 cohort 必然成功；在 deadline Work 三 barrier SIGKILL，并将最后 APPLIED/REJECTED ack 与 replacement 以两种 commit order 交错。
- **独立 oracle / mandatory assertions / 禁止副作用**：Work 可接管且 stale owner 被 fence，失败 fixture 仅一 FAILED+rollback，末 cohort 成功 fixture 仅一 SUCCEEDED，counts 守恒；不观察“成功后启动下一 cohort”，不得 double-evaluate 或同时 success+rollback。
- **primarySkill / secondarySkills / feedback / mutant**：`S07` / `S06,S17` / `C.DEADLINE_RECOVERY` / `CR-M08`。

### C-03 ROLLBACK_DELIVERY 的冻结 fanout 恢复 — 5 分

- **dimension / 权重**：`C` / 5 分。
- **来源 / fixture / seam 动作**：Manager rules 4–5/FINAL Work；在本 Case 的独立 database 中先通过公开流程冻结 affected set，再分别于 ROLLBACK_DELIVERY 三 barrier SIGKILL，改 Agent labels 并等 lease 后两 replacement 接管。
- **独立 oracle / mandatory assertions / 禁止副作用**：replacement 仅向已冻结成员恢复同 commandId/deliveryId/semantic body/token，每 command 恰一终态，Work drain 后 Rollback 才 COMPLETED；不得重算 affected set、stale commit、漏/重投 Agent 或提前闭合。
- **primarySkill / secondarySkills / feedback / mutant**：`S07` / `S06,S17` / `C.ROLLBACK_RECOVERY` / `CR-M09`。

### C-04 dispatcher unknown ACK 与 event 持久顺序 — 5 分

- **dimension / 权重**：`C` / 5 分。
- **来源 / fixture / seam 动作**：README event/outbox/barrier；receiver 持久化完整 request 后挂 ACK，在 `dispatcher.response-received` 杀 dispatcher，混合多 aggregate sequences 恢复。
- **独立 oracle / mandatory assertions / 禁止副作用**：重试保持同 eventId，解析 JSON 经独立 RFC8785 canonicalize 后语义等价，同 aggregate 成功顺序递增、payload 仍 `{}`；不要求未发布的 wire bytes 相同，不得换 identity、发 rollback event、乱序成功或泄漏 token/private path。
- **primarySkill / secondarySkills / feedback / mutant**：`S07` / `S05,S06` / `C.OUTBOX_RECOVERY` / `CR-M05`。

### D-01 Configuration/Deployment seed→OpenAPI/runtime 合同闭环 — 4 分

- **dimension / 权重**：`D` / 4 分。
- **来源 / fixture / seam 动作**：README OpenAPI 与 Seed contract；用公开 seed 命令导入 exact V1 graph，覆盖 Configuration contiguous revisions/RFC8785 digests、Assignment per-Agent contiguous commandSequence、target/revision/digest 引用对账，再通过公开 HTTP 读取并与 `/openapi.json` 核对；另行给出同 version+digest replay、同 version 异内容、断 revision/sequence、invalid refs/unknown keys fixture。
- **独立 oracle / mandatory assertions / 禁止副作用**：合法 graph 一次导入且 runtime/OpenAPI 的 V1 shape、required/nullability/error 一致；同 version+digest 无作用，同 version 异内容精确 `SEED_VERSION_CONFLICT`，任一无效成员使整份导入原子拒绝，不得留业务行/Work/idempotency/Event；不得使用 Manager-only seed 成员。
- **primarySkill / secondarySkills / feedback / mutant**：`S06` / `S01,S02,S15` / `SEED_WIRE_TRIANGULATION` / `CR-M01`。

### D-02 legacy all-at-once 真实 UI 闭环 — 4 分

- **dimension / 权重**：`D` / 4 分。
- **来源 / fixture / seam 动作**：README Real UI 与 Manager legacy compatibility；Chromium 在 desktop/mobile viewport 从可见语义控件创建 Configuration/all-at-once Deployment，观察 delivery/ack/cancel/history/event，refresh 后继续。
- **独立 oracle / mandatory assertions / 禁止副作用**：每个 UI 状态与同流程公开 HTTP/Agent 观察一致；legacy Deployment 保持 exact V1 shape 且省略 cohorts/rollback；loading/empty/validation/conflict/stale/offline/terminal/permission 状态、keyboard、label 与 focus 可验证；不得 mock、browser-only state、私有 API 或用文本存在代替真实流程。
- **primarySkill / secondarySkills / feedback / mutant**：`S06` / `S01,S15` / `LEGACY_UI_ACCEPTANCE` / `CR-M06`。

### D-03 staged cohort/rollback 真实 UI 闭环 — 4 分

- **dimension / 权重**：`D` / 4 分。
- **来源 / fixture / seam 动作**：Manager rule 12 与 staged wire/API/UI；Chromium 创建一个合法 staged Deployment，从 Agent 公开 seam 使 cohort 失败并完成 rollback，在 UI 查看 cohorts、counts、deadline、commands、rollback 与 Agent history，refresh 后复核。
- **独立 oracle / mandatory assertions / 禁止副作用**：UI、runtime Deployment/poll/ack 与 snapshot 对同一 identities/state/counts 闭合；可见 loading/error/terminal 状态不伪造未发布 event；不得 mock、读表、私有 endpoint 或静态截图假绿。
- **primarySkill / secondarySkills / feedback / mutant**：`S17` / `S06,S15` / `STAGED_UI_ACCEPTANCE` / `CR-M09`。

### D-04 Configuration/Cohort FINAL point-in-time snapshot 与跨层 shape — 3 分

- **dimension / 权重**：`D` / 3 分。
- **来源 / fixture / seam 动作**：README V1 snapshot 与 Manager FINAL union；混合 legacy/staged/failed rollback、terminal/nonterminal Work 与 events，在并发变更时读取 verification snapshot，并与各公开 detail/poll 的稳定前后时点对照。
- **独立 oracle / mandatory assertions / 禁止副作用**：`resources` 恰为 V1+Manager 八组 union，shape、ordinal/scalar tuple+RFC8785 tie-break、Work enum/lease/retention/drain、event order 与递归 `*Token` omission 全精确；同一 `asOf` 下 counts/引用闭合，不得 N+1 造成不一致、泄密或多出私有键。
- **primarySkill / secondarySkills / feedback / mutant**：`S17` / `S11,S15` / `FINAL_SNAPSHOT_CLOSURE` / `CR-M06`。

### E-01 100,000 Agents 的 poll mix — 2.5 分

- **dimension / 权重**：`E` / 2.5 分。
- **来源 / fixture / seam 动作**：README `agent-poll`；64 clients、10s warm-up+60s measure、每 100 requests 精确 50/50 COMMAND/NO_CHANGE，使用官方 `perf-v1` seed 的完整规模。
- **独立 oracle / mandatory assertions / 禁止副作用**：≥2,000 poll/s、p95≤80ms、token mix-up/5xx=0，body exact；计时后完整 snapshot 重算 per-Agent sequence、deliveryId/token 稳定、revision/digest 非降级、target/counters/Work/Event 对账；不得缩放、改 mix、提前 ack 或跨 Agent 复用 command/token。
- **primarySkill / secondarySkills / feedback / mutant**：`S06` / `S11,S14` / `PERFORMANCE_POLL` / `CR-M03`。

### E-02 acknowledgement-ingest replay mix — 2.5 分

- **dimension / 权重**：`E` / 2.5 分。
- **来源 / fixture / seam 动作**：README `acknowledgement-ingest`；64 clients、60s，45% APPLIED/5% REJECTED/50% exact replay，使用官方 `perf-v1` seed 的完整规模。
- **独立 oracle / mandatory assertions / 禁止副作用**：≥1,000 successful responses/s、p95≤180ms，每 unique Assignment 一次 state effect；计时后重算 APPLIED/REJECTED/ACKED 计数、Agent desired/applied/digest、deployment/event contiguous sequence 与 Work drain；不得将 stale token 算成功、改变 mix 或重复 applied transition。
- **primarySkill / secondarySkills / feedback / mutant**：`S05` / `S04,S11,S14` / `PERFORMANCE_ACK` / `CR-M04`。

### E-03 50,000 Assignment delivery recovery — 2.5 分

- **dimension / 权重**：`E` / 2.5 分。
- **来源 / fixture / seam 动作**：README `assignment-delivery-recovery`；两 claimed workers SIGKILL，lease 后两 replacement，120s，使用官方 `perf-v1` seed 的完整规模。
- **独立 oracle / mandatory assertions / 禁止副作用**：全部 WAITING→SENT、Work drain、stable delivery identity、Agent desired/Deployment counts reconcile；计时后全量复核 target membership/digest、commandSequence gapless、token/attempt/lease fence、event order；不得 stale commit、漏 Agent、要求 ACKED 或改变 selector/order。
- **primarySkill / secondarySkills / feedback / mutant**：`S07` / `S06,S11,S14` / `PERFORMANCE_DELIVERY_BACKLOG` / `CR-M03`。

### E-04 V1 升级到 FINAL 的兼容迁移 — 2.5 分

- **dimension / 权重**：`E` / 2.5 分。
- **来源 / fixture / seam 动作**：Manager rules 7–10/13；在本 Case 内用冻结 V1 binary 与符合公开 seed 合同的 exact fixture 独立建立各状态 Deployment、WAITING/SENT Assignment、PENDING/LEASED Work、unknown event ACK 与已保存 create/ack/cancel replay，记录 HTTP/snapshot/receiver 观测，执行公开升级迁移后 poll/replay/恢复。
- **独立 oracle / mandatory assertions / 禁止副作用**：每 V1 Deployment 对应一 legacy cohort，targets/Assignments/tokens/acks/events、deliveryId/semantic body、workId/attempt/lease 与 saved status/semantic JSON 保持；in-flight Work 可接管，旧 Agent 只恢复迁移前合法的 current greater desired；不得用 RolloutCommand 替换旧 Assignment、重置 sequence、产生 synthetic rollback/降级/event 或改写 replay。
- **primarySkill / secondarySkills / feedback / mutant**：`S06` / `S02,S05,S07` / `V1_FINAL_COMPATIBILITY` / `CR-M10`。

## 3. Worked example：B-03

以 targetCount=7、minimumSuccess=5714、maximumFailure=4285 为 fixture。deadline 前 4 APPLIED、2 REJECTED、1 missing 时，success=`floor(4*10000/7)=5714`；deadline 到达后 missing 也计 failure，failure=`floor(3*10000/7)=4285`，因此恰好成功。把任一 threshold 加 1 就失败。runner 用整数/BigInt 自算，不能调用候选比例 helper，并须同时检查 counts 从 4/2/1 原子变为 4/3/0 且只一次 transition。

## 4. Mutants（10 个）

| Mutant | 单一故障 | 必杀 Case |
| --- | --- | --- |
| CR-M01 | Configuration revision/digest 非 contiguous/RFC8785 或 seed 断链 | A-01、D-01 |
| CR-M02 | Deployment target 动态重算或 selector 当 OR | B-01 |
| CR-M03 | poll 越序/重试生成新 delivery identity | B-01、C-01、E-01/03/04 |
| CR-M04 | ack 只校验部分 tuple 或单层 replay 语义错 | A-03、B-02、E-02 |
| CR-M05 | cancel 撤已 ack 状态或 dispatcher 乱序/换 identity | B-02、C-04 |
| CR-M06 | cohort partition 非原子或 legacy/FINAL wire 被改 | A-02/04/05、D-01/02/04 |
| CR-M07 | 多 cohort 同时 active/counts 漂移 | B-03/04、D-03 |
| CR-M08 | threshold 用 round 或 deadline 不计 missing/双裁决 | B-03、C-02 |
| CR-M09 | rollback affected set 漂移/Work 无 fence/提前闭合 | B-05、C-03、D-03 |
| CR-M10 | process-local idempotency 或迁移合成 rollback | B-02、E-04 |

## 5. SPEC-GAP

- `SPEC-GAP-CR-01`：Manager 没有发布新 Domain Event type；rollback 明确不创建 event，其他新 transition 不得由 evaluator 发明名称。
- `SPEC-GAP-CR-02`：Manager 没有逐字写出“成功 cohort 后启动下一 cohort”的 endpoint/Work 名，但 ordered staged rollout 与 `COHORT_DEADLINE` 暗含该推进。冻结 runner 前应在公开合同补一句成功推进语义；否则 B-04 作为契约修订待办。

## 6. README → Case contract-map

| 合同 | Cases |
| --- | --- |
| V1/Manager runtime wire、route、边界与错误 | A-01..05 |
| 冻结成员、序列、replay、cohort 健康门与 rollback 不变量 | B-01..05 |
| Assignment/deadline/rollback Worker 与 dispatcher 恢复 | C-01..04 |
| seed/OpenAPI、legacy UI、staged UI、FINAL snapshot | D-01..04 |
| 三条 fixed performance、负载后可运维闭合与 V1→FINAL 兼容迁移 | E-01..04 |

## 7. 旧 H → V2 Case

| 旧 H | V2 Cases |
| --- | --- |
| H-01 | 共享 preflight（不计分）；领域 seed=D-01 |
| H-02 | A-01..05、D-01/04 |
| H-03 | A-01..03、B-01/02 |
| H-04 | A-01..04、B-01..03 |
| H-05 | B-02 |
| H-06 | B-01/05、C-02 |
| H-07 | C-01..03 |
| H-08 | C-04 |
| H-09 | E-04 |
| H-10 | A-04/05、B-03..05 |
| H-11 | C-02/03、D-02..04 |
| H-12 | E-01..03 |
| H-13 | 共享 preflight（不计分）；负载后领域闭合已并入 E-01..03 |

## 8. 评分

`A 30 + B 25 + C 20 + D 15 + E 10 = 100`，共 **22 Case**。A 仅评公开 runtime 合同，B 评数据不变量/幂等/并发，C 评三类 Work 与 dispatcher 恢复，D 评 seed→OpenAPI/runtime、两条真实 UI 与 snapshot 跨层，E 评三条正式性能场景、负载后可运维闭合与兼容迁移。sequence/token 错、target 漂移、双 cohort transition、rollback 漏/多成员、幂等第二效果、stale Work commit、迁移 synthetic downgrade/改 replay 均适用领域 hard cap。S03/S16 不作计分 primarySkill。
