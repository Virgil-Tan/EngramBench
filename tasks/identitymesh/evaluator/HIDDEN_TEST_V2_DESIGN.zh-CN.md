# IdentityMesh Hidden Test v2（Learning）设计

本设计遵循 Learning v2 profile，共 22 个领域 Case。干净安装、build、空库 migration、boot、health、
Chromium shell 和项目命令真实性是不计分 preflight，不在本题换名重复。

## 1. 权威、公开 seam 与 SPEC-GAP

权威依次为 workspace/README.md、orchestration/manager-prompt.zh-CN.md、CONTEXT.md。Evaluator 只通过
公开 HTTP、本地 Provider double、production Chromium、verification snapshot、audit/event receiver、
独立进程、进程信号和 V1→FINAL checkpoint 观察；禁止读取 token、私钥、私有表、
Candidate crypto helper 或内部 cache。

- IM-GAP-01：Manager 未发布 CompromiseIncident、RecoveryApproval 的 exact shape，Incident 状态 enum、
  create/recover request/response、epoch 字段、稳定错误或状态码。A-05 中 quarantine 公共 wire 断言
  blockedBy: IM-GAP-01。
- IM-GAP-02：Manager 要求审批但没有发布 approval endpoint、request/response 或如何读取 approvals；
  因而 B-05/C-03 无法经公开 seam 建立 RECOVERY_READY，均 blockedBy: IM-GAP-02。
- IM-GAP-03：Manager 没有发布 compromise/recovery Domain Event type；Evaluator 只要求字面明确的
  AuditEntry，不发明 Event。
- IM-GAP-04：V1 仅规定 production UI 使用 public API，Manager 只写“真实安全控制台”，均未列出可见
  用户操作、页面状态或 accessibility 合同。D-01/D-02 的具体 UI workflow blockedBy: IM-GAP-04；
  production shell 可启动仅由共享 preflight 验证。
- IM-GAP-05：README 只发布 Work=LEASED、lease 字段和 fenced final commit，未发布
  TEST_BARRIER_URL；Manager 也只泛称 Barrier/SIGKILL Recovery，未发布 protocol 或
  claimed/effect-complete/before-commit checkpoint。可执行恢复测试只能
  轮询公开 snapshot 至目标 Work=LEASED 后 SIGKILL 专用 Worker；精确内部阶段以及
  释放过期旧 owner 的子断言 blockedBy: IM-GAP-05。
- IM-GAP-06：README 规定安全边界使用数据库时间，但未发布可控数据库时钟 seam。
  E-02 只在离发布边界至少 1 秒的前/后安全窗口断言；精确等点和 ±1 ms 子断言
  blockedBy: IM-GAP-06。

blocked Case 在合同补齐前不运行、不重新归一化。其他 Case 每个使用独立数据库、端口和 provider state。

## 2. 独立 oracle、fixtures 与 worked example

Evaluator 自己生成 provider identities、一次性 refresh/challenge secrets、非对称 signing keypairs 和
canonical signing inputs；只向 Candidate 提交公开材料，私钥与原 token 留在 Harness。它独立验证 access
token signature/iat/key window、revocation version、per-tenant Audit digest chain。Fixture：F-LOGIN
（success/fail/unknown/duplicate callback）、F-REFRESH（family generations/reuse）、F-DEVICE
（nonce/user/fingerprint/expiry）、F-KEY（ACTIVE/RETIRING boundary）、F-REVOKE（duplicate/reordered/
stale cache）、F-AUDIT、F-RECOVERY、F-V1-FINAL。

**Worked example IM-W1**：generation 0 token T0 成功 rotate 得 T1；20 路中至多一个 T0 请求成功。
在 T1 已产生后再次使用 T0，必须原子撤销整个 family 及其所有 Session，且不得签发 T2。以后 replay
原成功请求仍返回保存结果，但任何新的 refresh 先受到 family revocation；不能用“最后写入获胜”让
Session 复活。

## 3. 评分

| Family | Cases | 分值 |
| --- | ---: | ---: |
| A 身份与安全主流程 | 5 | 30 |
| B identity、并发与安全 fence | 5 | 25 |
| C Work、恢复与 delivery | 4 | 20 |
| D UI/OpenAPI/snapshot/audit | 4 | 15 |
| E 兼容与安全边界 | 4 | 10 |
| **总计** | **22** | **100** |

Case 内 mandatory assertions 全部通过才得分；blockedBy 项保持原权重但不执行。

## 4. A — 身份与安全主流程

### A-01 LoginAttempt、Provider callback 与 UNKNOWN reconcile — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：README Product boundary、Authentication 1/3、login routes/errors；F-LOGIN。
- **公开动作 / oracle**：Provider double返回success/fail/delay/reset、duplicate/reordered callback；查询/reconcile同Attempt并重放。
- **Mandatory / 禁止副作用**：成功只建一Session/family；UNKNOWN不等于failed且在reconcile前不能新开身份结果；callback/providerRequestId绑定正确，失败/unknown无Session，credentials/assertions从未持久公开。
- **primarySkill**：S05 replay-precedence-and-identity-scope；**feedback**：login.provider-reconcile；**mutant**：M-IM-01。

### A-02 Refresh 单次 rotation、reuse family revoke 与 expiry — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：README Authentication 2/4、Session shape/errors；F-REFRESH 与 IM-W1。
- **公开动作 / oracle**：顺序rotate、old token reuse、expired session、same request replay，验证新access token signature。
- **Mandatory / 禁止副作用**：generation严格+1、旧token即时单次；reuse撤销整个family且不产生新Session/token；expiry用数据库时间，revoked/expired永不refresh，raw token不进响应外面、snapshot/event/log/audit。
- **primarySkill**：S18 credential-rotation-revocation-and-signing；**feedback**：refresh.family-reuse；**mutant**：M-IM-02。

### A-03 Device fingerprint、challenge nonce 与 trust/revoke — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：README Device trust 1–5、Device/Challenge shapes；F-DEVICE。
- **公开动作 / oracle**：register稳定fingerprint，发challenge，正确/重复/过期/跨user approval，再revoke并尝试challenge/session。
- **Mandatory / 禁止副作用**：challenge绑定tenant/user/device/fingerprint/nonce/expiry且single-use；trustRevision单调；revoke立即使派生Session和queued refresh无效，角色信息不参与trust。
- **primarySkill**：S18 credential-rotation-revocation-and-signing；**feedback**：device.challenge-binding；**mutant**：M-IM-03。

### A-04 SigningKey rotation、retirement window 与 JWKS — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：README Signing-key contract、rotate/JWKS/errors；F-KEY。
- **公开动作 / oracle**：rotate两次，在retireAt前后验证旧/新签发token；并发rotate并读取JWKS/snapshot。
- **Mandatory / 禁止副作用**：任时唯一ACTIVE；prior原子RETIRING，只有边界前已签token可验证，RETIRED拒绝；publicJwk/fingerprint/signature一致，private material任何公开面均不存在。
- **primarySkill**：S18 credential-rotation-revocation-and-signing；**feedback**：signing.rotation-window；**mutant**：M-IM-04。

### A-05 Tenant compromise quarantine 原子安全切换 — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：Manager rules 1、4、6；含active sessions/devices/key/revocations的tenant。
- **公开动作 / oracle**：拟经 POST compromise-incidents 创建，并比较tenant epoch、所有session/device/key/work/audit的同一提交边界。
- **Mandatory / 禁止副作用**：epoch提高、全部Session revoke、Device suspend、旧key停止签发、传播Work和唯一Audit原子；任何失败零partial effect，旧身份不复活。由于请求/响应/shape/state/error均未发布，本Case blockedBy: IM-GAP-01。
- **primarySkill**：S18 credential-rotation-revocation-and-signing；**feedback**：quarantine.contract-gap；**mutant**：M-IM-10。

## 5. B — identity、并发与安全 fence

### B-01 Idempotency 与 Provider callback identity precedence — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：README mutation key scope、UNKNOWN rule、duplicate/reordered callback；两个API/response shield。
- **公开动作 / oracle**：same key same/different body、same providerRequestId same/different callback、unknown response/restart/reconcile交叉。
- **Mandatory / 禁止副作用**：request replay先返回保存status/body，provider identity再防第二结果；conflict/UNKNOWN不互相吞没，最多一Attempt terminal、一Session/family和对应Audit/Event。
- **primarySkill**：S05 replay-precedence-and-identity-scope；**secondarySkills**：S04；**feedback**：login.identity-precedence；**mutant**：M-IM-05。

### B-02 同 RefreshToken 并发 rotate/reuse 线性化 — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：README single-use/family revoke/durable idempotency；两个API 20-way。
- **公开动作 / oracle**：不同keys并发使用T0，再unknown-response replay获胜request，最后用可能产生的T1。
- **Mandatory / 禁止副作用**：最多一个rotation effect；检测reuse时family/session原子revoked，不能同时留下ACTIVE T1；saved replay不重新签token，不出现双generation或双Audit identity。
- **primarySkill**：S18 credential-rotation-revocation-and-signing；**feedback**：refresh.contention；**mutant**：M-IM-02。

### B-03 Device revoke 与 challenge approve/refresh 竞争 — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：README Device trust 4、Revocation 2–5；F-DEVICE/F-REVOKE。
- **公开动作 / oracle**：在两个API固定交错revoke device、approve live challenge、refresh derived session。
- **Mandatory / 禁止副作用**：合法commit总序中revoke fence之后无trust/refresh成功；已revoked device/session永不复活，queued work取消/失败关闭，最多一次安全transition/Audit。
- **primarySkill**：S18 credential-rotation-revocation-and-signing；**feedback**：device.revocation-race；**mutant**：M-IM-06。

### B-04 Revocation version 单调、乱序传播与 verifier fail-closed — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：README Revocation propagation 1–5；多API stale caches与duplicate/reordered messages。
- **公开动作 / oracle**：对session/device/user/tenant发布递增versions，以2,1,3,2顺序传播并在每步verify/refresh/login。
- **Mandatory / 禁止副作用**：effective version只增；verifier本地版本低于required fence时拒绝，不以cache允许；duplicate保持revocation/event identity，最终所有subject约束闭合。
- **primarySkill**：S18 credential-rotation-revocation-and-signing；**feedback**：revocation.monotonic-fence；**mutant**：M-IM-07。

### B-05 最终审批与 recover 并发唯一转换 — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：Manager rules 2–5；2–10 approvers、threshold边界、已/未满足恢复前置。
- **公开动作 / oracle**：拟并发duplicate/不同approver最终票与20路recover，核对recovery epoch和旧identity。
- **Mandatory / 禁止副作用**：approval按approver唯一，threshold转换/Audit一次；仅全部撤销传播+新ACTIVE key后recover；新epoch不恢复旧Session/family/challenge/key。审批HTTP seam缺失，blockedBy: IM-GAP-02。
- **primarySkill**：S18 credential-rotation-revocation-and-signing；**feedback**：recovery.approval-gap；**mutant**：M-IM-10。

## 6. C — Work、恢复与 delivery

### C-01 LOGIN_RECONCILIATION 在公开 LEASED 后崩溃 — 5 分
- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture**：README UNKNOWN、Work exact shape/fenced commits；F-LOGIN/F-RECOVERY。
- **公开动作 / oracle**：单独启动worker，轮询snapshot至目标 LOGIN_RECONCILIATION Work=LEASED后SIGKILL，lease后replacement用同providerAttempt reconcile。
- **Mandatory / 禁止副作用**：最终只有一个provider outcome、Session/family或failure、Work terminal、Event/Audit，identity/body不因重试改变。effect-complete/before-commit与旧owner释放子断言 blockedBy: IM-GAP-05。
- **primarySkill**：S07 durable-work-fenced-recovery；**feedback**：login.reconciliation-recovery；**mutant**：M-IM-08。

### C-02 REVOCATION_PROPAGATION 在公开 LEASED 后恢复 — 5 分
- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture**：README revocation Work/duplicate messages/fail-closed；F-REVOKE。
- **公开动作 / oracle**：轮询snapshot至目标 REVOCATION_PROPAGATION Work=LEASED后SIGKILL，lease后replacement传播并跨API verify。
- **Mandatory / 禁止副作用**：稳定revocation/version/message identity，所有verifier最终收敛且恢复期间fail closed，无subject re-enable或重复Audit/Event。effect-complete/before-commit与旧owner释放子断言 blockedBy: IM-GAP-05。
- **primarySkill**：S07 durable-work-fenced-recovery；**feedback**：revocation.recovery；**mutant**：M-IM-08。

### C-03 TENANT_QUARANTINE/RECOVERY crash 与旧 lease fence — 5 分
- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture**：Manager rules 5–6；有待撤销身份和最终approval的Incident。
- **公开动作 / oracle**：若wire补齐，仅轮询snapshot至两类Work=LEASED后SIGKILL并恢复，期间并发recover；不假设内部checkpoint。
- **Mandatory / 禁止副作用**：每旧identity最多一次revocation、旧lease不越epoch fence、恢复不reenable旧身份、Audit转换一次。因Incident/approval公共wire缺失，blockedBy: IM-GAP-01, IM-GAP-02；精确内部崩溃点另 blockedBy: IM-GAP-05。
- **primarySkill**：S07 durable-work-fenced-recovery；**feedback**：quarantine.recovery-gap；**mutant**：M-IM-10。

### C-04 KEY_RETIREMENT 与 AUDIT_DELIVERY unknown ACK — 5 分
- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture**：README key boundary、audit at-least-once、Work/Event stable identity；F-KEY/F-AUDIT。
- **公开动作 / oracle**：轮询snapshot至 KEY_RETIREMENT Work=LEASED后SIGKILL worker；receiver收完audit body后暂不响应，Evaluator SIGKILL dispatcher，再恢复。
- **Mandatory / 禁止副作用**：数据库时间/fence决定RETIRING→RETIRED一次；旧token在安全余量窗口内语义不漂移；audit重投同entry/body，tenant sequence/digest连续，private key/token/assertion永不出现。
- **primarySkill**：S07 durable-work-fenced-recovery；**secondarySkills**：S18；**feedback**：key-audit.delivery-recovery；**mutant**：M-IM-09。

## 7. D — UI、OpenAPI、snapshot 与 audit

### D-01 V1 安全控制台身份全流程 — 4 分
- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture**：README仅规定production UI使用public HTTP，未发布可见功能列表；F-LOGIN/F-DEVICE/F-KEY。
- **公开动作 / oracle**：拟在production Chromium完成login/refresh/device trust/key rotation/revocation并refresh页面。
- **Mandatory / 禁止副作用**：若合同补全，应验证所有状态来自API且不以browser storage为authority、无secret、错误可见、键盘/移动可用。当前具体workflow与控件无权推定，blockedBy: IM-GAP-04。
- **primarySkill**：S18 credential-rotation-revocation-and-signing；**secondarySkills**：S15；**feedback**：ui.v1-contract-gap；**mutant**：M-IM-04。

### D-02 Compromise/recovery 安全控制台 — 4 分
- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture**：Manager rule 8“真实安全控制台”及quarantine/recover规则。
- **公开动作 / oracle**：拟创建Incident、显示epoch/affected identities/approval progress、recover并检查旧identity不可用。
- **Mandatory / 禁止副作用**：UI不得越过approval/security prerequisites或复活旧identity，所有显示与HTTP/snapshot一致。因wire与UI动作均缺失，blockedBy: IM-GAP-01, IM-GAP-02, IM-GAP-04。
- **primarySkill**：S18 credential-rotation-revocation-and-signing；**secondarySkills**：S15；**feedback**：ui.quarantine-gap；**mutant**：M-IM-10。

### D-03 OpenAPI、point-in-time snapshot 与 secret-negative oracle — 4 分
- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture**：README exact routes/shapes/snapshot/secret rules；全状态F-AUDIT。
- **公开动作 / oracle**：冻结contract map校验OpenAPI；在并发activity中读snapshot，递归扫描响应、events、audit、logs中的sentinel secrets。
- **Mandatory / 禁止副作用**：V1 exact resource keys/shapes/sorts、Work enum与same snapshot一致；只暴露public JWK/fingerprint；token/credential/assertion/private key/path均零命中。Manager resource exact blockedBy: IM-GAP-01。
- **primarySkill**：S11 point-in-time-snapshot-audit；**feedback**：snapshot.secret-absence；**mutant**：M-IM-09。

### D-04 Audit verify、checkpoint 与 tamper detection — 3 分
- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture**：README Audit-chain 1–5、audit routes；跨全部V1安全transition的F-AUDIT。
- **公开动作 / oracle**：独立重算per-tenant sequence/priorDigest/payloadDigest/digest，调用verify并用public seed导入删除/插入/重排/篡改变体。
- **Mandatory / 禁止副作用**：原链verify通过，四类tamper必失败且不修写历史；checkpoint精确latest sequence/digest，tenant链隔离，delivery duplicate保持entry identity/body。
- **primarySkill**：S11 point-in-time-snapshot-audit；**feedback**：audit.chain-verification；**mutant**：M-IM-09。

## 8. E — 兼容与安全边界

### E-01 V1→FINAL 身份与审计无损迁移 — 2.5 分
- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture**：Manager rule 7；V1 binary创建active/revoked sessions、devices、keys、revocations、pending Work、unacked Event、saved replay/audit。
- **公开动作 / oracle**：同库FINAL migration后重放旧requests，完成pending work，验证旧token/revocation/key boundaries和audit chain。
- **Mandatory / 禁止副作用**：所有V1 identity/body/fence/replay/work/event/audit不变；migration不创建Incident、不reenable身份、不泄露private material。
- **primarySkill**：S18 credential-rotation-revocation-and-signing；**secondarySkills**：S02；**feedback**：migration.identity-compat；**mutant**：M-IM-07。

### E-02 Session expiry、key retirement 与 revocation 的同一数据库时钟边界 — 2.5 分
- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture**：README Authentication 4、Signing-key 3、Revocation 2–3；离发布边界至少 1 秒的前/后 fixture。
- **公开动作 / oracle**：在各边界前、后的安全余量窗口分别验证refresh/access token/challenge/key retirement/fence，不以本地sleep制造等点。
- **Mandatory / 禁止副作用**：安全余量窗口内，各决策与数据库生成的published boundaries一致；边界后fail closed且不误撤销边界前合法历史。精确等点、±1 ms和时钟偏移注入子断言 blockedBy: IM-GAP-06。
- **primarySkill**：S18 credential-rotation-revocation-and-signing；**feedback**：security.clock-boundary；**mutant**：M-IM-04。

### E-03 Tenant/User/Device/Session Revocation scope 组合隔离 — 2.5 分
- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture**：README Revocation subject scopes和tenant boundary；两个tenant共享相似UUID后缀。
- **公开动作 / oracle**：依次撤销single session、device、user、tenant并验证所有派生refresh/challenge/login与另一tenant controls。
- **Mandatory / 禁止副作用**：影响集合恰等于公开scope，版本单调、无漏项/越界；其他tenant身份持续可用，响应/error/snapshot不泄漏被撤销subject详情。
- **primarySkill**：S18 credential-rotation-revocation-and-signing；**feedback**：revocation.scope-isolation；**mutant**：M-IM-06。

### E-04 百页 Audit/checkpoint 稳定分页与全链复核 — 2.5 分
- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture**：README collections、Audit chain/checkpoint/snapshot；每tenant超过100页确定性entries。
- **公开动作 / oracle**：并发追加期间从冻结起点分页，随后point-in-time snapshot与verify endpoint交叉核对。
- **Mandatory / 禁止副作用**：cursor稳定、无重漏，tenant sequence/digest/checkpoint闭合；分页不能因新append重排旧项，secret-negative oracle仍通过。此Case无吞吐阈值，不冒充未发布performance合同。
- **primarySkill**：S11 point-in-time-snapshot-audit；**feedback**：audit.pagination-checkpoint；**mutant**：M-IM-09。

## 9. Mutant calibration（10 个）

| Mutant | 故障 | 主击杀 Case |
| --- | --- | --- |
| M-IM-01 | UNKNOWN当failed并另开LoginAttempt | A-01 |
| M-IM-02 | refresh generation在进程内检查或reuse仍签T2 | A-02、B-02 |
| M-IM-03 | challenge不绑定nonce/user/expiry | A-03 |
| M-IM-04 | rotation双ACTIVE或retirement边界错误 | A-04、E-02 |
| M-IM-05 | provider callback与request replay identity混淆 | B-01 |
| M-IM-06 | device revoke未原子阻止refresh/challenge或越tenant | B-03、E-03 |
| M-IM-07 | revocation版本可回退/stale cache fail-open | B-04、E-01 |
| M-IM-08 | reconciliation/propagation Work无fence | C-01、C-02 |
| M-IM-09 | audit跨事务、链错误或泄漏secret | C-04、D-03、D-04、E-04 |
| M-IM-10 | quarantine/recovery部分提交或复活旧identity | blocked：A-05、B-05、C-03、D-02 |

至少前9个active mutant同seed三次被稳定击杀；M-IM-10待Manager合同补齐后才进入freeze gate。

## 10. README→Case 与旧 H→Case

| Requirement | Case |
| --- | --- |
| login/provider/reconcile | A-01、B-01、C-01 |
| refresh family/reuse/expiry | A-02、B-02、E-02 |
| device trust/challenge/revoke | A-03、B-03、E-03 |
| signing rotation/JWKS/window | A-04、C-04、E-02 |
| revocation monotonic/fail-closed | B-04、C-02、E-03 |
| audit/checkpoint/secret absence | C-04、D-03、D-04、E-04 |
| compromise quarantine/recovery | A-05、B-05、C-03、D-02（blocked） |
| compatibility migration | E-01 |

| 旧 H | 新 Case |
| --- | --- |
| H-01 | 不计分preflight；migration归E-01，secret归D-03 |
| H-02 | A-01、D-03 |
| H-03 | A-02 |
| H-04 | B-02 |
| H-05 | A-01、B-01 |
| H-06 | A-03 |
| H-07 | B-03、E-03 |
| H-08 | A-04、E-02 |
| H-09 | B-04、C-02 |
| H-10 | D-04、E-04 |
| H-11 | C-01、C-02、C-04 |
| H-12 | 不映射：阈值仅见旧私有计划，README未发布，不能成为v2计分真值 |
| H-13 | 不单列计分，项目证据只定位对应Case |

统一 Hard Caps 外：凭证/私钥/raw assertion泄漏、revoked identity复活、revocation fence fail-open或
Audit链被改写时 correctness总分上限25；hidden asset探测为invalid。
