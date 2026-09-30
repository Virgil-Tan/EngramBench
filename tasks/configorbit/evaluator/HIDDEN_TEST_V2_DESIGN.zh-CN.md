# ConfigOrbit Hidden Test V2 设计

> 设计稿，不实现 runner。公共 install/build/migrate/boot/health 属共享不计分 preflight。22 个 Case 只验证 README/CONTEXT/固定 Manager 消息可观察的配置控制合同。

## 1. 画像与隔离

- **两项主机制**：immutable revision + generation-fenced deterministic rollout；跨环境 PromotionTrain 的冻结阶段权威与补偿 Release。
- **领域 family**：`REV`、`TRAIN`、`RACE`、`MIGRATE`、`LOAD` 只用于业务定位；评分以每个 Case 的显式 A–E dimension 为准。
- **核心 primarySkill（4 个）**：`S01` contract-wire-triangulation、`S06` ordered-authority-and-frozen-membership、`S04` database-owned-atomic-idempotency、`S07` durable-work-fenced-recovery；兼容、性能与跨层验收只列为 `secondarySkills`。
- **seam/isolation**：公开 HTTP/OpenAPI、client fetch/ETag、receiver、barrier、SIGKILL、Chromium、snapshot；每 Case 独立 tenant/application/database/ports，固定 client IDs 与 salt。LOAD 每条新库；禁止读 cache/表/源码。

## 2. 计分 Case（22 个，100 分）

### REV-01 parent CAS 与 RFC 风格 canonical digest — 6 分

- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture / seam 动作**：README「Revision」1；以对象键序互换、数组序变换、数值/字符串类型差异创建 revision，并用 stale/current parent。
- **独立 oracle / mandatory assertions / 禁止副作用**：独立 canonical JSON+SHA-256；对象换序 digest 同、数组/类型变化不同，stale parent 精确冲突；不得创建孤立 revision、推进 generation 或 event。
- **primarySkill / feedback / mutant**：`S01` / `REVISION_CONTRACT` / `CO-M01`。

### REV-02 secret-like 递归拒绝与 published immutable — 6 分

- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture / seam 动作**：README Product boundary/Revision rules；在多层 object/array 放 password/secret/token/privateKey 大小写合同键，publish 后尝试修改。
- **独立 oracle / mandatory assertions / 禁止副作用**：递归遍历 fixture 得到拒绝位置；任一禁键整 document 原子拒绝，published content/digest 永不变；不得部分清洗后接受或泄漏 value 到错误/log/snapshot。
- **primarySkill / feedback / mutant**：`S01` / `STRICT_CONFIG_DOCUMENT` / `CO-M02`。

### REV-03 publish 的 generation/Release/Invalidation 全包提交 — 5 分

- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture / seam 动作**：README Revision rule 2；发布合法 draft，并在 validation/commit 边界观察 snapshot/client fetch。
- **独立 oracle / mandatory assertions / 禁止副作用**：同一 point-in-time 出现 PUBLISHED revision、新 Release、generation+1、Invalidation、Audit、Work、Event；失败则全无；不得出现可 fetch 新 config 但缺审计/失效或半发布。
- **primarySkill / feedback / mutant**：`S04` / `ATOMIC_PUBLISH` / `CO-M03`。

### REV-04 rollout assignment 精确首 64-bit SHA-256 — 5 分

- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture / seam 动作**：README Revision rule 3；固定 tenant/application/environment/release/salt，生成跨 0/1/9999/10000 basis-point client 集。
- **独立 oracle / mandatory assertions / 禁止副作用**：外部按 exact colon string、unsigned first 64 bits、mod 10000 重算；所有 API/重启结果一致；不得用百分比浮点、不同字段序、进程 hash 或 client cache 决策。
- **primarySkill / feedback / mutant**：`S06` / `DETERMINISTIC_ASSIGNMENT` / `CO-M04`。

### REV-05 ETag、knownGeneration 与单调 invalidation — 6 分

- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture / seam 动作**：README「Client fetch」；发送 current/stale ETag+knownGeneration，倒序/重复观察 invalidation，并 poll 两 API。
- **独立 oracle / mandatory assertions / 禁止副作用**：304 仅 resolved release+generation 均未变；stale knownGeneration 必须 body，client observation 只增，commit 后 5 秒可见；不得错误 304、旧 invalidation re-enable 或 cache 绕过 DB fence。
- **primarySkill / feedback / mutant**：`S06` / `GENERATION_FENCE` / `CO-M05`。

### TRAIN-01 stage 定义、revision digest/order/salt 冻结 — 5 分

- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture / seam 动作**：Manager 规则 1–3；创建 development/staging/production Train，测试跨 application/env、重复/乱序/非法 basis points，并在 start/rollback 的公开响应中反复核对冻结字段；不调用未发布 update route。
- **独立 oracle / mandatory assertions / 禁止副作用**：合法 Train/Stage exact shape、position 从 0、revisionDigest 与输入顺序/salt 在所有公开 mutation 后不变；非法 create 原子错误；不得创建 partial stages、暗换 digest 或重排环境。`PROMOTION_TRAIN_FROZEN` 的可达 mutation blockedBy: `SPEC-GAP-CO-03`。
- **primarySkill / feedback / mutant**：`S06` / `FROZEN_PROMOTION_TRAIN` / `CO-M06`。

### TRAIN-02 start 与单一当前 Stage 权威 — 5 分

- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture / seam 动作**：Manager states/start API；start DRAFT Train，重复 start，并观察三个环境与 Work。
- **独立 oracle / mandatory assertions / 禁止副作用**：Train RUNNING，仅 position 0 ACTIVE，其他 PENDING；一次正常 Release/generation/invalidation；不得同时激活两 Stage、提前动 staging/production 或改前一环境历史。
- **primarySkill / feedback / mutant**：`S06` / `SINGLE_ACTIVE_STAGE` / `CO-M06`。

### TRAIN-03 expectedStage+generation 的 advance — 4 分

- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **blockedBy**：`SPEC-GAP-CO-02`, `SPEC-GAP-CO-05`；跨到 staging/production 时，合同没有定义环境绑定 ConfigRevision 的新 identity/复制语义，也没有 refresh 后的 Train read seam。
- **来源 / fixture / seam 动作**：Manager 规则 3–4；用正确/stale expectedStage 与 expectedEnvironmentGeneration 逐级 advance。
- **独立 oracle / mandatory assertions / 禁止副作用**：合同补齐后，OpenAPI/live response、UI refresh 与 snapshot 必须共同证明前 Stage PROMOTED、目标 Stage ACTIVE并创建正常 immutable Release/generation/invalidation/audit；stale 请求无变化；不得跳 stage、改写旧 Release、重复 generation 或让 UI 留在旧 Stage。
- **secondarySkills**：`S15`。
- **primarySkill / feedback / mutant**：`S06` / `ORDERED_PROMOTION` / `CO-M07`。

### TRAIN-04 当前环境补偿 rollback、不倒退其他环境 — 4 分

- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **blockedBy**：`SPEC-GAP-CO-05`；领域 rollback 可由公开 POST 验证，但本 D Case 要求的 refresh 后 UI/Train read 没有公共 seam。
- **来源 / fixture / seam 动作**：Manager 规则 5；让 source ConfigRevision 所属 development Stage ACTIVE 后 rollback，并重放/与同环境 rollout 竞争；不先执行受 `SPEC-GAP-CO-02` 阻塞的跨环境 advance。
- **独立 oracle / mandatory assertions / 禁止副作用**：合同补齐后，OpenAPI/live response、UI refresh 与 snapshot 共同证明只 development 创建 compensation Release 且 generation 增加、其他环境不变；不得编辑旧 Release/revision、跨环境回滚或由 UI 复活旧 generation。
- **secondarySkills**：`S15`。
- **primarySkill / feedback / mutant**：`S06` / `COMPENSATING_RELEASE` / `CO-M07`。

### TRAIN-05 可达 terminal/stale 错误与 exact Train response — 6 分

- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture / seam 动作**：Manager errors/wire；对公开可达的 ROLLED_BACK Train 做 start/advance/rollback，并测试 stale expectedStage/generation 与不存在 ID；不调用未发布 cancel/update/read route。
- **独立 oracle / mandatory assertions / 禁止副作用**：返回已发布且可达的精确 code/envelope，成功 mutation 返回完整 Train，snapshot stages 状态一致；不得从 terminal 复活、留下 promotion Work/Event/Release 或混入未列字段。CANCELLED setup、`PROMOTION_TRAIN_FROZEN` trigger blockedBy: `SPEC-GAP-CO-03`。
- **primarySkill / feedback / mutant**：`S01` / `TRAIN_WIRE_TERMINAL` / `CO-M08`。

### RACE-01 publish/rollout/同环境 Train rollback 的 durable replay — 5 分

- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture / seam 动作**：README durable idempotency 与 Manager start/rollback；对 V1 publish/rollout/rollback 及 TRAIN-04 的 development 同环境 rollback 使用 response shield、两 API 20 路相同 key、restart、异 payload；不执行受 `SPEC-GAP-CO-02` 阻塞的跨环境 advance。
- **独立 oracle / mandatory assertions / 禁止副作用**：原 status/semantic JSON/IDs 为 oracle；每个 generation/Release/可达 Train transition 恰一次，异 payload conflict；不得第二 invalidation/audit/event/work。
- **primarySkill / feedback / mutant**：`S04` / `DURABLE_IDEMPOTENCY` / `CO-M03`。

### RACE-02 rollout 与当前 Stage rollback 的 generation CAS 热点竞争 — 5 分

- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture / seam 动作**：README rule 4、Manager concurrency；32 个 requests 共享 development expectedGeneration/expectedStage，跨两 API 竞争 V1 rollout 与 TRAIN-04 的同环境 rollback；不执行跨环境 advance。
- **独立 oracle / mandatory assertions / 禁止副作用**：每 authority/version 恰一成功，余者精确 generation/stage conflict；重算 accepted generations 连续且一代一 Release；不得双 successor、gap 或混合 Train state。
- **primarySkill / feedback / mutant**：`S06` / `GENERATION_CONTENTION` / `CO-M07`。

### RACE-03 claimed activation/invalidation/rollback Work SIGKILL — 5 分

- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture / seam 动作**：README project recovery 只明确 claimed worker；在 claimed point 杀 RELEASE_ACTIVATE、CACHE_INVALIDATE 与同环境 PROMOTION_ROLLBACK worker，lease 后 replacement。effect-complete/before-commit 与跨环境 PROMOTION_ADVANCE blockedBy: `SPEC-GAP-CO-02`, `SPEC-GAP-CO-04`。
- **独立 oracle / mandatory assertions / 禁止副作用**：replacement 排空且 generation/Release/Stage 每项一次，旧 owner 无提交；不得遗失 invalidation、重复 stage、长期不可见或旧 lease 前进。
- **primarySkill / feedback / mutant**：`S07` / `PROMOTION_RECOVERY` / `CO-M09`。

### RACE-04 webhook unknown ACK 与乱序失效 — 5 分

- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture / seam 动作**：README invalidation/events；receiver 收完整 body 后挂 ACK/SIGKILL dispatcher，再将消息倒序重复应用。
- **独立 oracle / mandatory assertions / 禁止副作用**：eventId/body byte-identical、aggregate sequence 连续、client generation 单调且 5 秒内收敛；不得新 event identity、旧 generation re-enable 或泄漏 config secret-like value/token。
- **primarySkill / feedback / mutant**：`S07` / `INVALIDATION_OUTBOX_RECOVERY` / `CO-M05`。

### MIGRATE-01 V1 Release/assignment/observation 不自动入 Train — 2.5 分

- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture / seam 动作**：Manager 规则 6；迁移前创建多 generation rollout、client observations、pending invalidations。
- **独立 oracle / mandatory assertions / 禁止副作用**：IDs/digests/assignment 结果/observations 完全保留，promotionTrains/stages 为空；不得合成 Train、改变 salt/generation 或重算 client cohort。
- **primarySkill / secondarySkills / feedback / mutant**：`S06` / `S02` / `V1_MIGRATION` / `CO-M10`。

### MIGRATE-02 Work、event、audit 与 saved replay 保真 — 2.5 分

- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture / seam 动作**：Manager 规则 6、README seed；迁移含 PENDING/LEASED invalidation/event delivery、saved success/conflict replay 与 audit chain。
- **独立 oracle / mandatory assertions / 禁止副作用**：workId/lease/attempt、eventId/body/sequence、audit order、status/JSON 前后相同并可继续恢复；不得重置 Work、换 replay、重排历史或要求 Manager seed member。
- **primarySkill / secondarySkills / feedback / mutant**：`S07` / `S02` / `INFLIGHT_COMPATIBILITY` / `CO-M10`。

### MIGRATE-03 V1 seed replay 与 FINAL snapshot exact union — 6 分

- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture / seam 动作**：README seed/snapshot、Manager snapshot；导入合法完整 V1 seed、同 version+digest replay、异 digest、未知 member、断引用、generation/activeRelease/observation/invalidation 不一致，再抓含新旧资源的 snapshot。
- **独立 oracle / mandatory assertions / 禁止副作用**：合法导入完整，同 digest no-op、异 digest `SEED_VERSION_CONFLICT`，任一坏 member 对资源/Work/Event/audit/幂等零影响；resources exact union/sort、point-in-time generation/Release links 完整；不得接受 Manager seed 字段、额外 key 或泄漏 cache/env/path。
- **primarySkill / secondarySkills / feedback / mutant**：`S01` / `S02,S11` / `SEED_SNAPSHOT_COMPATIBILITY` / `CO-M10`。

### MIGRATE-04 OpenAPI/UI 的 V1 release 控制闭合与 Train read 缺口 — 4 分

- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture / seam 动作**：README UI；Chromium 完成 V1 draft/diff/publish/rollout/rollback 并 refresh，核对 OpenAPI/runtime/snapshot。Manager 未发布 GET/list Train seam，Train refresh/read workflow blockedBy: `SPEC-GAP-CO-05`。
- **独立 oracle / mandatory assertions / 禁止副作用**：V1 OpenAPI/runtime shapes、UI visible generation/invalidation、snapshot 相互一致；不得用 mock/private API、前端自算不同 assignment 或破坏 V1 flow；不把仅保存在浏览器内的 Train response 当可恢复 UI。
- **primarySkill / secondarySkills / feedback / mutant**：`S01` / `S15` / `CROSS_LAYER_COMPATIBILITY` / `CO-M08`。

### LOAD-01 50,000 client fetch mix — 2.5 分

- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture / seam 动作**：README `client-fetch-mix`；128 clients、60s、80% current ETag/20% stale generation、正式规模。
- **独立 oracle / mandatory assertions / 禁止副作用**：≥800 req/s、p95≤150ms、wrong 304/5xx=0，assignment/body digest 重算正确；不得缩放、改变 mix、把 stale 304 计成功或绕 DB fence。
- **primarySkill / secondarySkills / feedback / mutant**：`S06` / `S14` / `PERFORMANCE_CLIENT_FETCH` / `CO-M04`。

### LOAD-02 10,000 rollout/rollback contention — 2.5 分

- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture / seam 动作**：README `rollout-rollback-contention`；100 env、2 APIs、64 clients、10,000 attempts。
- **独立 oracle / mandatory assertions / 禁止副作用**：≥100 mutation/s、p95≤500ms；accepted generation 一代一 Release、assignment deterministic；不得把 expected conflicts 当 5xx、产生双 successor/gap。
- **primarySkill / secondarySkills / feedback / mutant**：`S06` / `S14` / `PERFORMANCE_GENERATION` / `CO-M07`。

### LOAD-03 100,000 invalidation recovery — 5 分

- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture / seam 动作**：README `invalidation-recovery`；两 claimed workers SIGKILL，lease 后四 replacements。
- **独立 oracle / mandatory assertions / 禁止副作用**：90s 内排空，所有 environment 5s 内收敛，无 stale re-enable/stale commit；不得丢/重复逻辑 generation、提前停 daemon 或只清 Work 不验证 clients。
- **primarySkill / secondarySkills / feedback / mutant**：`S07` / `S14` / `PERFORMANCE_INVALIDATION` / `CO-M09`。

### LOAD-04 负载后 revision/generation/Event 跨层对账 — 3 分

- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture / seam 动作**：README post-load invariants、OpenAPI/UI/snapshot；三条独立场景后抓 snapshot，并经 client-config/UI/audit 抽查公开结果。
- **独立 oracle / mandatory assertions / 禁止副作用**：active release unique、generation monotonic、digest immutable、assignment deterministic、audit/event continuous、Work drain；不得只报指标或跨场景复库。跨环境 Train post-load closure blockedBy: `SPEC-GAP-CO-02`，不由 evaluator 猜 revision copy identity。
- **primarySkill / secondarySkills / feedback / mutant**：`S06` / `S14,S15` / `POST_LOAD_INVARIANTS` / `CO-M06`。

## 3. Worked example：REV-04

Runner 固定 50 个 clientId，并按 `tenantId:applicationId:environmentId:releaseId:audienceSalt:clientId` 生成 UTF-8 bytes，取 SHA-256 首 8 bytes 作为 unsigned 64-bit big-endian 整数后 `%10000`。分别在 0、1、2500、9999、10000 basis points 查询两 API 与重启实例。每个响应必须选择 oracle 指定的 Release/document/digest/generation；复制候选返回的 bucket 算法不是独立 oracle。

## 4. Mutants（10 个）

| Mutant | 单一故障 | 必杀 Case |
| --- | --- | --- |
| CO-M01 | canonical digest 保留 object 输入键序或丢类型 | REV-01 |
| CO-M02 | secret-like 只检查顶层/发布后可改 document | REV-02 |
| CO-M03 | publish/幂等 response 与业务不同事务 | REV-03、RACE-01 |
| CO-M04 | rollout 用浮点/进程 hash/错误字节序 | REV-04、LOAD-01 |
| CO-M05 | ETag 只看 release、不看 generation；旧 invalidation 可回退 | REV-05、RACE-04 |
| CO-M06 | Train stage/member/order 未冻结或多 ACTIVE | TRAIN-01/02、LOAD-04 |
| CO-M07 | advance/rollback 无 stage+generation CAS | TRAIN-03/04、RACE-02、LOAD-02 |
| CO-M08 | terminal Train 可复活或 wire/UI 混淆新旧 shape | TRAIN-05、MIGRATE-04 |
| CO-M09 | promotion/invalidation Work 无 lease fence | RACE-03、LOAD-03 |
| CO-M10 | migration 合成 Train、改 replay/event/seed | MIGRATE-01..03 |

## 5. SPEC-GAP

- `SPEC-GAP-CO-01`：Manager 未发布新增 Domain Event type；不猜 promotion 专属名称，只断言既有同类 transition/event 规则、历史 event identity/body/sequence 保留。
- `SPEC-GAP-CO-02`：Manager 说 Train 冻结“一个 ConfigRevision 内容”，但 V1 ConfigRevision 绑定 environment，且没有定义 staging/production 的 revision identity、复制记录或 Release 如何合法引用跨环境 revision；TRAIN-03 及依赖跨环境 advance 的 assertions blocked。
- `SPEC-GAP-CO-03`：Manager 发布 CANCELLED state 与 `PROMOTION_TRAIN_FROZEN`，但没有 cancel/update route；公开 API 无法制造 CANCELLED 或触发冻结字段修改，相关分支 blocked。
- `SPEC-GAP-CO-04`：README 只承诺 recovery 杀 claimed worker/dispatcher，没有冻结 effect-complete/before-commit point 或 barrier body；RACE-03 只计 claimed，其他 crash point blocked。
- `SPEC-GAP-CO-05`：Manager 没有发布 GET/list PromotionTrain route；success response 与 snapshot 不能替代 refresh 后的 UI read seam，Train UI read workflow blocked。

## 6. README → Case contract-map

| 合同 | Cases |
| --- | --- |
| revision/publish/rollout/client fetch | REV-01..05 |
| PromotionTrain wire/states/advance/rollback | TRAIN-01..05 |
| idempotency/generation race/Work/outbox | RACE-01..04 |
| migration/seed/snapshot/UI compatibility | MIGRATE-01..04 |
| 三条 performance 与 post-load | LOAD-01..04 |

## 7. 旧 H → V2 Case

| 旧 H | V2 Cases |
| --- | --- |
| H-01 | 共享 preflight（不计分）；seed=MIGRATE-03 |
| H-02 | REV-01/02/05、TRAIN-05、MIGRATE-04 |
| H-03 | REV-01/03/04/05 |
| H-04 | REV-01/02/03、TRAIN-01/05 |
| H-05 | RACE-01 |
| H-06 | RACE-02、REV-04 |
| H-07 | RACE-03 |
| H-08 | RACE-04 |
| H-09 | MIGRATE-01/02/03 |
| H-10 | TRAIN-01..05 |
| H-11 | RACE-02/03、MIGRATE-04 |
| H-12 | LOAD-01..04 |
| H-13 | 共享 preflight（不计分）；领域闭合 LOAD-04 |

## 8. 评分

按显式 dimension 汇总为 `A=30、B=25、C=20、D=15、E=10`，共 **22 Case / 100 分**；领域 family 不决定维度。generation 回退/双 Release、错误 304、published revision 改写、Train 多 ACTIVE/跨环境误回滚、幂等第二效果、stale Work commit、迁移丢历史触发领域 hard cap。S03/S16 不作计分 primarySkill。
