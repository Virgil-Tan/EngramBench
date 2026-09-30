# FirmwareFleet Hidden Test v2（Learning）设计

依据 Learning v2 profile 与统一标准，本文件只列 FirmwareFleet 的领域计分 Case。install/build/boot、
空库 migration、health、Chromium shell 与公开命令真实性由共享 preflight 负责，不计入下列 22 Case。

## 1. 权威、seam 与 SPEC-GAP

预期只来自 workspace/README.md、T16 固定 Manager 消息和 CONTEXT.md。允许 seam 为公开 HTTP、
production Chromium、verification snapshot、事件 receiver、独立 API/COMMAND_DELIVERY/REPORT_TIMEOUT/
ROLLBACK worker 与 dispatcher、公开 barrier、V1→FINAL checkpoint 和 README 性能命令。禁止读取私有表、
队列、源码 helper 或固件存储内部路径。

- FF-GAP-01：Manager 说 multi-hop Device Update “expose upgradePlan[] and currentHopIndex”，但只发布
  UpgradePlan resource，没有发布新增后 DeviceUpdate 的完整 exact shape，也没有名为 upgradePlan[] 的
  member schema。A-04 以专用 GET upgrade-plan 为 exact wire oracle；D-03 不猜 DeviceUpdate 新字段，
  此部分 blockedBy: FF-GAP-01。
- FF-GAP-02：路径 tie-break 的 “lexicographically smallest version sequence” 未说明按版本比较器、
  Unicode code point 还是 UTF-8 bytes。计分 path fixture 使用三种规则结果一致的 canonical versions；
  会分歧的版本图 blockedBy: FF-GAP-02。

每个 Case 新建数据库、端口和 receiver，只有 E-01 复用 V1 数据；并发 Case 固定三个交错 seed。

## 2. Oracle、fixtures 与 worked example

Evaluator 独立实现版本 canonicalization/comparator、selector AND、targetDigest、RFC 8785 pathDigest、
command/report 状态机与 aggregate progress。Fixture：F-IMAGE（合法边界和坏 path/version/digest）、
F-WAVE（多 model/labels、maxParallel）、F-REPORT（duplicate/gap/token/digest）、F-PATH（1–5 hop DAG）、
F-FAIL（timeout/failure/cancel/rollback）、F-RECOVERY、F-V1-FINAL 与三个公开性能 seed。

**Worked example FF-W1**：Device 从 1.0 到 4.0；可走 [2.0,4.0] 或 [3.0,4.0]，两者两 hop，
版本序列选择 [2.0,4.0]；若到 2.0 有两个 imageId，则再选 imageId 序列较小者。pathDigest 独立计算
RFC 8785 {deviceId,sourceVersion:1.0,targetVersion:4.0,imageIds:[chosen2,chosen4]}。第一 hop VERIFY
成功后第二 hop 才产生 DOWNLOAD；第二 hop 失败仅 rollback 到 2.0，retry 使用全新 token 且 sequence
接续而不回到 1。

## 3. 评分

| Family | Cases | 分值 |
| --- | ---: | ---: |
| A 领域合同与主流程 | 5 | 30 |
| B 不变量、幂等与并发 | 5 | 25 |
| C Work、恢复与事件 | 4 | 20 |
| D UI/OpenAPI/snapshot 闭环 | 4 | 15 |
| E 兼容与合同负载 | 4 | 10 |
| **总计** | **22** | **100** |

每 Case 的 mandatory assertions 必须全部通过；同一行为不在第二个 Case 重复给分。

## 4. A — 领域合同与主流程

### A-01 Firmware Image 版本、路径与兼容边界 — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：README Deterministic policy、FirmwareImage wire/errors；F-IMAGE。
- **公开动作 / oracle**：HTTP 注册 component 边界、canonical 等价版本、模型/compatibleFromVersions、合法和 dot/dot-dot downloadPath，独立读取 fixture bytes 核验 size/sha256。
- **Mandatory / 禁止副作用**：版本比较与唯一性、1..100 compatibility、path regex/segment、safe integer 精确；任一坏 member 返回稳定 error，零 Image/Work/Event，不能读 assetPath 外文件。
- **primarySkill**：S02 compatibility-seed-bootstrap-gate；**secondarySkills**：S01；**feedback**：image.integrity；**mutant**：M-FF-01。

### A-02 冻结 Campaign selector、targetDigest 与设备级 maxParallel — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：README selector/target/campaign progress；F-WAVE。
- **公开动作 / oracle**：创建 Campaign 后增删符合 label 的 Device，再 poll/report 推进 wave；evaluator 重算初始 bytewise deviceId target 与 digest。
- **Mandatory / 禁止副作用**：target/Image 永不改变，新增设备不进入；PENDING/RUNNING/terminal 状态精确，active Device 数不超 maxParallel，hop command 数不误占多个 slot。
- **primarySkill**：S06 ordered-authority-and-frozen-membership；**feedback**：campaign.frozen-wave；**mutant**：M-FF-02。

### A-03 Command poll、连续 Report 与 verify/rollback V1 状态机 — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：README command 1/2/3、report batch、timeout/rollback；F-REPORT/F-FAIL。
- **公开动作 / oracle**：按 sequence poll DOWNLOAD/INSTALL/VERIFY，提交 success、duplicate、gap、stale token、wrong digest、explicit fail 与 timeout。
- **Mandatory / 禁止副作用**：NO_CHANGE exact；只有当前 command/token 可推进；VERIFY exact digest 后才改 installed firmware；失败只产生一 ROLLBACK，完成前不释放错误状态或发 forward command。
- **primarySkill**：S05 replay-precedence-and-identity-scope；**feedback**：command.report-state；**mutant**：M-FF-03。

### A-04 确定性 1–5 hop UpgradePlan 与 pathDigest — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：T16 UpgradePlan/UpgradeHop/creation/error；F-PATH 与 FF-W1。
- **公开动作 / oracle**：创建 direct、multi-hop、超过 5 hop、无 path Campaign；调用 GET upgrade-plan 并按 evaluator 图搜索重算路径和 digest。
- **Mandatory / 禁止副作用**：fewest hops→version sequence→imageId 次序、稳定 hop index/from/to/digest；任一 target 无 path 时整 Campaign/updates/commands/events 为零。歧义版本图 blockedBy: FF-GAP-02。
- **primarySkill**：S06 ordered-authority-and-frozen-membership；**feedback**：upgrade.path-selection；**mutant**：M-FF-04。

### A-05 每 hop 门控、局部 rollback 与显式 retry — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：T16 per-hop commands、retry endpoint/errors；第二 hop 失败的 F-PATH。
- **公开动作 / oracle**：成功第一 hop、在第二 hop 各阶段失败并 rollback，再以正确/陈旧 expected index+attempt retry，poll 全序列。
- **Mandatory / 禁止副作用**：prior digest verify 前无下一 hop；rollback 只回当前 hop captured prior image；早期成功保留；retry fresh token、attempt +1、global commandSequence 继续，非当前 report 零状态变化。
- **primarySkill**：S06 ordered-authority-and-frozen-membership；**feedback**：upgrade.hop-retry；**mutant**：M-FF-05。

## 5. B — 不变量、幂等与并发

### B-01 Campaign 创建 all-or-none 与 durable replay — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：README durable idempotency、T16 all targets must have path；两个 API、response shield。
- **公开动作 / oracle**：20 路 same key/body、unknown response+restart replay、same key different selector，并混入一个无升级 path target。
- **Mandatory / 禁止副作用**：唯一 Campaign、冻结 target/plans/work/events 与原 status/body；冲突稳定；坏 target 导致全批零 Campaign/Update/Plan/Command/Event。
- **primarySkill**：S06 ordered-authority-and-frozen-membership；**secondarySkills**：S04；**feedback**：campaign.atomic-create；**mutant**：M-FF-06。

### B-02 同 Device active authority 与 maxParallel 热点竞争 — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：README invariant 1、active capacity；两个 Campaign/两个 API/两个 workers。
- **公开动作 / oracle**：同一 Device 并发进入不同 Campaign，并让多个 WAITING updates 竞争最后一个 slot。
- **Mandatory / 禁止副作用**：每 Device 最多一个 active Update/current Command；每 Campaign active Device count≤maxParallel；loser 原子等待/稳定 conflict，无双 command 或 revision 漏洞。
- **primarySkill**：S06 ordered-authority-and-frozen-membership；**feedback**：device.active-authority；**mutant**：M-FF-07。

### B-03 Report identity、sequence、token 与 digest 并发优先级 — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：README exhaustive errors/report batch；T16 non-current hop/attempt；F-REPORT。
- **公开动作 / oracle**：跨两个 API 并发 identical duplicate、same sequence rewritten body、gap、旧 attempt token 与 wrong digest。
- **Mandatory / 禁止副作用**：合法 duplicate 无第二效果；非法输入按字面 stable error，不能被 idempotency 吞掉；lastReportSequence、installed digest、hop/attempt、Work/Event 一致且只推进一次。
- **primarySkill**：S05 replay-precedence-and-identity-scope；**feedback**：report.identity-precedence；**mutant**：M-FF-08。

### B-04 failure/timeout/cancel 与 rollback terminal race — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：README cancellation/timeout/rollback；三个固定 barrier 交错。
- **公开动作 / oracle**：同时提交 FAILED report、触发 REPORT_TIMEOUT 和 cancel Campaign，两个 rollback workers 完成。
- **Mandatory / 禁止副作用**：恰一 rollback command/effect；active update 必完成 rollback，WAITING 原子 CANCELLED，terminal 保留；Campaign 终态与全部 member oracle 一致，不出现 unrelated image。
- **primarySkill**：S07 durable-work-fenced-recovery；**feedback**：rollback.terminal-race；**mutant**：M-FF-09。

### B-05 并发 hop 完成、retry 与 Campaign aggregate closure — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：T16 progress aggregates Devices/hops、retry CAS；多设备多 hop Campaign。
- **公开动作 / oracle**：40 路 report/retry，刻意让最终 hop、最终 rollback、stale retry 同时提交。
- **Mandatory / 禁止副作用**：每 hop/attempt 单一终态，currentHopIndex 单调；final approval 恰一次，Campaign 只在所有 Devices terminal 后结束，maxParallel 始终按 Device 而非 command/hop。
- **primarySkill**：S06 ordered-authority-and-frozen-membership；**secondarySkills**：S17；**feedback**：campaign.aggregate-closure；**mutant**：M-FF-10。

## 6. C — Work、恢复与事件

### C-01 COMMAND_DELIVERY claim 与 before-commit SIGKILL — 5 分
- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture**：README Work lease/barriers/fencing；pending current commands。
- **公开动作 / oracle**：分别在 worker.claimed 和 worker.before-commit SIGKILL，lease 后 replacement 接管，再尝试 stale commit。
- **Mandatory / 禁止副作用**：稳定 commandId/token/sequence，poll 最终只见一个 current command；stale owner 不可提交，Work 有界恢复且 active count 不漂移。
- **primarySkill**：S07 durable-work-fenced-recovery；**feedback**：command.delivery-recovery；**mutant**：M-FF-09。

### C-02 REPORT_TIMEOUT 与 ROLLBACK effect-complete 恢复 — 5 分
- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture**：README timeout policy、worker.effect-complete barrier；F-FAIL。
- **公开动作 / oracle**：在 timeout 判定和 rollback external effect 后分别 SIGKILL，启动 replacement 并提交 late report。
- **Mandatory / 禁止副作用**：数据库时间决定 timeout；late/stale report 不安装；rollback token/identity 重用、installed firmware 回 captured prior once，capacity 仅终态释放。
- **primarySkill**：S07 durable-work-fenced-recovery；**feedback**：rollback.crash-recovery；**mutant**：M-FF-09。

### C-03 Multi-hop 边界崩溃与 sequence 连续性 — 5 分
- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture**：T16 global sequence、prior verify gate、in-flight identity compatibility。
- **公开动作 / oracle**：在 hop N VERIFY commit 前后和 hop N+1 command publication 前 barrier SIGKILL，恢复并 poll/report。
- **Mandatory / 禁止副作用**：已提交 VERIFY 不重做，未提交则安全重试；下一 hop 只发布一次，sequence 无 reset/gap，fresh retry token 不复用旧 attempt token。
- **primarySkill**：S07 durable-work-fenced-recovery；**feedback**：upgrade.boundary-recovery；**mutant**：M-FF-05。

### C-04 Campaign/Update Event outbox unknown ACK — 5 分
- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture**：README event types/payload/order/dispatcher barrier；V1 与 multi-hop success/failure。
- **公开动作 / oracle**：receiver 500/断线，dispatcher.before-ack-commit SIGKILL 后重启并按 aggregate 对账。
- **Mandatory / 禁止副作用**：business+event 同 transaction，rollback 无 event；retry 保持 eventId/body/order；Manager 未发布新类型时不得为 hop/attempt 自造事件，token 递归省略。
- **primarySkill**：S07 durable-work-fenced-recovery；**feedback**：event.unknown-ack；**mutant**：M-FF-06。

## 7. D — UI、OpenAPI、snapshot 闭环

### D-01 浏览器完成 V1 image、Campaign、poll/report 与 rollback — 4 分
- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture**：README Real UI；F-WAVE/F-FAIL。
- **公开动作 / oracle**：production Chromium 仅经可见控件注册 image、创建/cancel Campaign、查看 Device Update/Command/Report/rollback，refresh 后用 HTTP 对账。
- **Mandatory / 禁止副作用**：实时进度、offline/retry/error/terminal 可见，键盘与移动布局可用；UI 不伪造状态或暴露 commandToken、idempotency key、路径。
- **primarySkill**：S06 ordered-authority-and-frozen-membership；**secondarySkills**：S15,S17；**feedback**：ui.v1-rollout；**mutant**：M-FF-03。

### D-02 浏览器解释 UpgradePlan、hop attempts 与 retry — 4 分
- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture**：T16 UI update、UpgradePlan/retry；FF-W1。
- **公开动作 / oracle**：创建 multi-hop Campaign，观察 path/hop/attempt，失败第二 hop 后从页面 retry 并完成。
- **Mandatory / 禁止副作用**：UI pathDigest/current hop/attempt/sequence 与 API exact 一致，早期成功不回退；stale/non-eligible retry 显示稳定 error，legacy direct flow 仍工作。
- **primarySkill**：S06 ordered-authority-and-frozen-membership；**secondarySkills**：S15,S17；**feedback**：ui.multi-hop-plan；**mutant**：M-FF-10。

### D-03 OpenAPI 与 FINAL snapshot 的 UpgradePlan 联合合同 — 4 分
- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture**：README OpenAPI/snapshot、T16 exact union；全状态 V1+Manager fixture。
- **公开动作 / oracle**：以冻结 contract map 校验 paths/schema/errors，读取单一 point-in-time snapshot 并独立排序/去 token。
- **Mandatory / 禁止副作用**：UpgradePlan exact、resource keys/Work enum exact、legacy bodies兼容、hop/attempt arrays正确；未发布 DeviceUpdate extension 不猜字段，blockedBy: FF-GAP-01。
- **primarySkill**：S06 ordered-authority-and-frozen-membership；**secondarySkills**：S11；**feedback**：contract.upgrade-snapshot；**mutant**：M-FF-04。

### D-04 Image→Plan→Command→Report→已安装终态的跨层闭环 — 3 分
- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture**：README invariants/events/snapshot 与 T16 pathDigest；成功、失败、retry 三条链。
- **公开动作 / oracle**：从公开 image bytes/digest 追到 frozen path、每个 command/report、Device installed state、Campaign aggregate 与 Event。
- **Mandatory / 禁止副作用**：IDs/digests/sequences/versions 全链一致，无孤儿 Work/Event/attempt；错误链不得改变 installed firmware，所有公开面不泄漏 commandToken。
- **primarySkill**：S06 ordered-authority-and-frozen-membership；**secondarySkills**：S15；**feedback**：cross-layer.firmware-lineage；**mutant**：M-FF-08。

## 8. E — 兼容与合同负载

### E-01 V1 Campaign 到 one-hop Plan 的无损升级 — 2.5 分
- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture**：T16 migration/compatibility；V1 binary 生成全终态、pending/leased Command、reports、events、saved replay。
- **公开动作 / oracle**：同库 FINAL migration 后，以旧 client replay/poll/report/query，并读取新 one-hop plan。
- **Mandatory / 禁止副作用**：原 IDs/body/tokens/sequences/reports/versions/events/replay 不变；completed 不发命令，in-flight 保持 retry identity，seed schema 仍 V1。
- **primarySkill**：S02 compatibility-seed-bootstrap-gate；**secondarySkills**：S06；**feedback**：migration.one-hop-compat；**mutant**：M-FF-06。

### E-02 Command poll 公开 workload — 2.5 分
- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture**：README scenario device-command-poll 的完整 setup/selector/request/window。
- **公开动作 / oracle**：按原样 64 concurrency、60 秒，current-1 与 current 请求分别验证 COMMAND/NO_CHANGE 后统计。
- **Mandatory / 禁止副作用**：≥3000 successful polls/s、p95≤80ms、5xx=0；每个返回 command identity/token/sequence exact，负载后无 active authority 破坏。
- **primarySkill**：S05 replay-precedence-and-identity-scope；**secondarySkills**：S14；**feedback**：perf.command-poll；**mutant**：M-FF-03。

### E-03 Report batch 半数 replay 公开 workload — 2.5 分
- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture**：README scenario device-report-batch 的原样 2000/s、p95、replay 比例。
- **公开动作 / oracle**：60 秒精确半数 fresh/identical replay，独立核对 report identity、last sequence 和 command transition。
- **Mandatory / 禁止副作用**：≥2000 responses/s、p95≤200ms、exactly half replay；无第二 effect、gap、wrong install 或 5xx。
- **primarySkill**：S05 replay-precedence-and-identity-scope；**secondarySkills**：S14；**feedback**：perf.report-replay；**mutant**：M-FF-08。

### E-04 十万 Command Work 重启排空 — 2.5 分
- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture**：README scenario command-recovery 原样 seed、kill/lease/replacement/timer。
- **公开动作 / oracle**：两个 worker claimed 后 SIGKILL，lease 到期启动 replacements，按 campaign/device/sequence 验证 pollable commands。
- **Mandatory / 禁止副作用**：≤180 秒排空 100000，stale commit/unexpected failure=0，command identity 唯一且 Campaign maxParallel 全程成立。
- **primarySkill**：S07 durable-work-fenced-recovery；**secondarySkills**：S14；**feedback**：perf.command-recovery；**mutant**：M-FF-09。

## 9. Mutant calibration（10 个 task-specific mutant）

| Mutant | 故障 | 主击杀 Case |
| --- | --- | --- |
| M-FF-01 | 用字符串比较版本或允许 dot-dot path | A-01 |
| M-FF-02 | Campaign 每次动态重算 selector | A-02 |
| M-FF-03 | VERIFY 不校验 current token/digest | A-03、D-01 |
| M-FF-04 | path 选最小 imageId 而非先最少 hop | A-04、D-03 |
| M-FF-05 | hop/retry 重置 commandSequence 或复用 token | A-05、C-03 |
| M-FF-06 | Campaign/Plan/replay/Event 跨事务提交 | B-01、C-04、E-01 |
| M-FF-07 | maxParallel 按 command 而非 Device | B-02 |
| M-FF-08 | duplicate/旧 attempt report 再次推进 | B-03、D-04、E-03 |
| M-FF-09 | Work 无 fence，timeout/cancel 可双 rollback | B-04、C-01、C-02、E-04 |
| M-FF-10 | 部分 Device terminal 即结束 Campaign | B-05、D-02 |

同 seed 三次稳定且 Gold 全过后冻结；M-FF-06/M-FF-09 必须在公开 barrier 上稳定暴露 crash window。

## 10. README→Case 与旧 H→Case

| Requirement | Case |
| --- | --- |
| image/version/path/compatibility | A-01 |
| frozen selector、targetDigest、maxParallel、progress | A-02、B-02、B-05 |
| command/report/verify/rollback | A-03、B-03、B-04 |
| multi-hop plan/path/retry | A-04、A-05、C-03 |
| idempotency/atomic create | B-01 |
| Work lease/fence/outbox | C-01～C-04 |
| Real UI/OpenAPI/snapshot | D-01～D-04 |
| V1→FINAL one-hop compatibility | E-01 |
| exact performance scenarios | E-02～E-04 |

| 旧 H | 新 Case |
| --- | --- |
| H-01 | 不计分 preflight；升级兼容归 E-01 |
| H-02 | A-01、A-03、D-03 |
| H-03 | A-01～A-03 |
| H-04 | B-02～B-04 |
| H-05 | B-01 |
| H-06 | B-02～B-05 |
| H-07 | C-01～C-03 |
| H-08 | C-04 |
| H-09 | E-01 |
| H-10 | A-04、A-05、B-05 |
| H-11 | D-02 与 B-05/C-03 |
| H-12 | E-02～E-04 |
| H-13 | 不单列计分，证据只诊断对应 Case |

统一 Hard Caps 外：接受伪造/跨设备 token、stale worker 改写 installed firmware 或 migration 改变
已保存 command/report identity 时 correctness 总分上限 30；秘密泄漏或 hidden fixture 探测为 invalid。
