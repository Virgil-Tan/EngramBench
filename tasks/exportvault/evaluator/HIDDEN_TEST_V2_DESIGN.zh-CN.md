# ExportVault Hidden Test v2（Learning）设计

本文件遵循 docs/learning-hidden-test-v2-profile.zh-CN.md 与 docs/hidden-test-v2-standard.zh-CN.md，
只定义 ExportVault 的领域计分项。install、migration、build、boot、health 和进程清理是不计分
preflight；失败按统一 Hard Cap 处理，不能换名混入 Case。

## 1. 权威、公开 seam 与 SPEC-GAP

权威依次为 workspace/README.md、T16 固定 Manager 消息、CONTEXT.md。测试只使用公开 HTTP、
production Chromium、verification snapshot、事件 receiver、公开进程、V1→FINAL checkpoint、
TEST_BARRIER_URL 和公开性能命令；禁止 import Candidate 模块、读取私有表或对象目录。

- EV-GAP-01：Manager 同时说 Export 增加 manifest/shards，又说 legacy one-object Export 保留
  “exact V1 shape”，未明确 legacy 响应是否出现新增字段。A-05/D-03 对 legacy 只断言 V1 exact body，
  对 sharded Export 断言新增字段，不猜统一 schema。
- EV-GAP-02：ExportShard 允许零记录时 throughRecordId:null，但 Manifest member 将它写成非空 uuid，
  未说明零记录 Shard 能否发布。计分 fixture 只创建非空 Shard；零记录 Manifest 行为标记
  blockedBy: EV-GAP-02，合同补全前不执行且不重分配权重。

每个 Case 使用新数据库、端口、managed data root、receiver 和 barrier；只有 E-01 跨 binary 复用数据库。

## 2. 独立 oracle、fixtures 与 worked example

Evaluator 自己实现 RFC 8785、SHA-256、RFC 4180 CSV、byte range、半开时间与稳定 UUID 排序；
OpenAPI 只是被测产物。Fixture：F-BYTES（多 scope/revision/转义字符）、F-LIFECYCLE
（READY/CANCELLED/FAILED/EXPIRED）、F-GRANT（有效/撤销/过期）、F-SHARD（100001、200000 和
跨 section 记录）、F-RECOVERY（staged object/pending Work/unacked Event）、F-V1-FINAL
（V1 全状态、saved replay），以及 README 原样的三个性能 seed。

**Worked example EV-W1**：scope 为 [profile,activity]；profile 有 100001 条按 recordId 排序的记录，
activity 有 2 条。独立 oracle 得到 ordinal 0 为 profile 前 100000 条，ordinal 1 为 profile 最后一条，
ordinal 2 为 activity 两条，Shard 不得跨 section。Manifest bytes 是 ordered shards array 的 RFC 8785
JSON，canonicalDigest 与 object.sha256 都必须等于 SHA256(manifestBytes)；只信公开下载后重算值。

## 3. 评分

| Family | 领域 | Cases | 分值 |
| --- | --- | ---: | ---: |
| A | 公共合同与主流程 | 5 | 30 |
| B | 数据正确性、幂等与并发 | 5 | 25 |
| C | 持久工作、恢复与事件 | 4 | 20 |
| D | UI、OpenAPI、snapshot 跨层闭环 | 4 | 15 |
| E | 兼容与合同形状性能 | 4 | 10 |
| **总计** |  | **22** | **100** |

Case 内任一 mandatory assertion 失败则该 Case 为 0 分；同一行为只在一个主 Case 计分。

## 4. A — 公共合同与主流程

### A-01 捕获 Dataset Revision 并生成确定性 JSONL/CSV — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：README “Deterministic policy、POST exports、sections”；F-BYTES 含 revision 切换、CSV 引号/换行/Unicode。
- **公开动作 / oracle**：HTTP 创建同 scope 的 JSONL/CSV Export，随后变更当前 revision；排空生成并下载，按被捕获 revision、scope 顺序和 recordId 独立编码逐 byte 比较。
- **Mandatory / 禁止副作用**：datasetRevision 永不漂移，section 次序、recordCount、digest、size、mediaType 精确；生成期间的新记录不混入，非法 scope/format 整体零 Export/Work/Event。
- **primarySkill**：S09 cross-store-atomic-publication；**feedback**：export.bytes；**mutant**：M-EV-01。

### A-02 Export 生命周期、读取与取消终态 — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：README “Domain and V1 behavior、Mandatory invariants、cancel”；F-LIFECYCLE。
- **公开动作 / oracle**：创建后查询 sections/detail，在 REQUESTED/GENERATING/READY 三处发起 cancel 并重放；状态机 oracle 验证 sequence、timestamps 与事件。
- **Mandatory / 禁止副作用**：仅合法单向终态；cancel 胜出时无 READY object/grant，publication 胜出时 cancel 返回已发布稳定错误；FAILED/CANCELLED/EXPIRED 不可下载且无重复终态事件。
- **primarySkill**：S09 cross-store-atomic-publication；**feedback**：export.lifecycle；**mutant**：M-EV-02。

### A-03 Download Grant、ETag 与精确 Range — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：README “Download Grants、byte-range support、stable errors”；F-GRANT。
- **公开动作 / oracle**：对 READY object 创建、重放、revoke Grant；请求整对象、首尾、单 byte 和越界 range，独立切片原始 bytes。
- **Mandatory / 禁止副作用**：206、Content-Range、Content-Length、ETag 与 bytes 精确；撤销/到期后 410；未 READY、坏 range、跨 Export target 不创建 Grant、不泄漏对象存在性或内容。
- **primarySkill**：S09 cross-store-atomic-publication；**feedback**：grant.range；**mutant**：M-EV-03。

### A-04 Retention cleanup 与 Deletion Proof — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：README “cleanup、Deletion Proof、retention”；F-LIFECYCLE/F-GRANT。
- **公开动作 / oracle**：组合 retention 前后、active/expired/revoked Grant、共享 blob，排空 EXPORT_CLEANUP 后读取 snapshot、proof 与控制对象 bytes。
- **Mandatory / 禁止副作用**：仅无活跃 Grant 且到期的逻辑对象删除；每个删除 exact one proof/event，live 或仍可达 bytes 不删，共享对象不因一个 Export 到期而消失。
- **primarySkill**：S09 cross-store-atomic-publication；**feedback**：cleanup.reachability；**mutant**：M-EV-04。

### A-05 Shard 计划、Manifest 与定向 Grant — 6 分
- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture**：T16 “sharded export manifests、wire schema/routes/errors”；F-SHARD 与 EV-W1。
- **公开动作 / oracle**：创建阈值上下 Export，查询 detail，下载各 Shard/Manifest，创建 MANIFEST/SHARD Grant，以 evaluator 重算边界和 canonical bytes。
- **Mandatory / 禁止副作用**：2–100 稳定 Shard、每 shard ≤100000、section 不交叉、stable shardId/ordinal/range；全 VERIFIED 前 manifest/object 均 null；发布后 Manifest exact；错误 target 返回已发布 code 且零 Grant。零记录 Manifest 分支 blockedBy: EV-GAP-02。
- **primarySkill**：S17 frozen-fanout-aggregate-closure；**feedback**：shard.manifest；**mutant**：M-EV-05。

## 5. B — 数据正确性、幂等与并发

### B-01 Object、Section、Manifest 三层摘要闭合 — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：README deterministic bytes/invariants 与 T16 Manifest digest；F-BYTES/F-SHARD。
- **公开动作 / oracle**：下载 object/Shard/Manifest，独立重算每 section、完整对象及 Manifest 的 size/SHA-256，并与 detail/snapshot 交叉核对。
- **Mandatory / 禁止副作用**：所有 bytes 只对应捕获 revision，摘要链逐层相等；Candidate 不能以自报 digest 掩盖截断、重排、换行或 mediaType 错误。
- **primarySkill**：S09 cross-store-atomic-publication；**feedback**：publication.digest-closure；**mutant**：M-EV-06。

### B-02 活跃 Export 去重与 durable idempotency — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：README active-request dedupe 与 durable idempotency；同/异 semantic body、两个 API、response shield。
- **公开动作 / oracle**：20 路同 subject/scope/format/revision 创建，未知响应后跨重启 replay；再用同 key 异 body及新 key相同 active request。
- **Mandatory / 禁止副作用**：唯一 active Export/plan/Work，same key 返回原 status/semantic body，冲突用稳定 error；终态后新请求按合同重新创建，不能复用旧对象。
- **primarySkill**：S04 database-owned-atomic-idempotency；**feedback**：export.idempotency；**mutant**：M-EV-07。

### B-03 Generation publication 与 cancel 竞争 — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：README cancel race、atomic publication；公开 worker.before-commit 控制交错。
- **公开动作 / oracle**：两个 API cancel、两个 worker publish，固定三组交错并在每组后下载/查 snapshot。
- **Mandatory / 禁止副作用**：恰一合法终态；READY 必须 bytes/metadata/Event 同时可见，CANCELLED 必须无可下载 object/Manifest；不得半 READY、孤儿 Grant 或双事件。
- **primarySkill**：S09 cross-store-atomic-publication；**feedback**：publication.race；**mutant**：M-EV-02。

### B-04 Grant create/revoke/expiry 与 cleanup 竞争 — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：README grant/cleanup invariants；数据库时间边界附近的 F-GRANT。
- **公开动作 / oracle**：并发创建 Grant、revoke 与 cleanup claim/commit；以响应提交顺序和数据库时间判断合法线性化结果。
- **Mandatory / 禁止副作用**：已提交 active Grant 必保对象；cleanup 先删除则 Grant 不得成功；revoke once、proof once、无复活/双删，所有公开读一致。
- **primarySkill**：S09 cross-store-atomic-publication；**feedback**：cleanup.grant-race；**mutant**：M-EV-04。

### B-05 Shard fan-out 验证与 Manifest all-or-none — 5 分
- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture**：T16 “each shard verified、all shards before READY、cancel/fail siblings”；一个 Shard 注入失败及 40 路 worker。
- **公开动作 / oracle**：并发生成 Shards，重复完成同 shard，令中间 shard fail/cancel，并查询 ordered Shards/Manifest/Event。
- **Mandatory / 禁止副作用**：每 shard effect once；任一失败时 siblings 达合同终态且无 Manifest/READY；全部通过才一次发布唯一 Manifest，计数/范围不漂移。
- **primarySkill**：S17 frozen-fanout-aggregate-closure；**feedback**：shard.aggregate-closure；**mutant**：M-EV-08。

## 6. C — 持久工作、恢复与事件

### C-01 Generation claim 后崩溃的租约恢复 — 5 分
- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture**：README Work/barrier/fencing；F-RECOVERY。
- **公开动作 / oracle**：在 worker.claimed SIGKILL，等公开 lease 到期，启动 replacement，再放行 stale worker 尝试提交。
- **Mandatory / 禁止副作用**：同一 operation identity 恢复、attempt 有界、replacement 唯一完成；stale token 不可发布，最终 bytes/digest/Work/Event 各一次。
- **primarySkill**：S09 cross-store-atomic-publication；**secondarySkills**：S07；**feedback**：generation.lease-recovery；**mutant**：M-EV-09。

### C-02 staged bytes 完成后、数据库提交前崩溃 — 5 分
- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture**：README atomic object publication 与 worker.effect-complete/before-commit。
- **公开动作 / oracle**：两个 barrier 各自 SIGKILL，replacement 重试；全过程轮询 Export/下载 seam。
- **Mandatory / 禁止副作用**：staging bytes 永不经 Grant 暴露；READY 出现时完整 immutable bytes 同时存在；恢复不重复对象身份、不留下可观察孤儿或错误 digest。
- **primarySkill**：S09 cross-store-atomic-publication；**feedback**：publication.crash-window；**mutant**：M-EV-06。

### C-03 Cleanup 删除与 Proof 提交崩溃恢复 — 5 分
- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture**：README EXPORT_CLEANUP、Deletion Proof、barriers；到期对象及 live controls。
- **公开动作 / oracle**：在 effect-complete/before-commit SIGKILL cleanup worker，再恢复并复查 object/grant/proof/event。
- **Mandatory / 禁止副作用**：已删对象最终有唯一 Proof/EXPIRED state/event；未满足资格者仍 byte-readable；重试不制造第二 proof 或把物理 delete 失败伪成成功。
- **primarySkill**：S09 cross-store-atomic-publication；**secondarySkills**：S07；**feedback**：cleanup.recovery；**mutant**：M-EV-09。

### C-04 Export/Grant Event transactional outbox 与 unknown ACK — 5 分
- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture**：README exact event types/order/dispatcher barrier；成功、回滚、V1 与 sharded flow。
- **公开动作 / oracle**：receiver 500/断线，在 dispatcher.before-ack-commit SIGKILL 后重启；按 aggregate 记录 eventId/body/sequence。
- **Mandatory / 禁止副作用**：业务成功必有 event、回滚无 event；重投保持 eventId/body，aggregate sequence 连续；不得为未字面发布的 Manager transition 发明类型。
- **primarySkill**：S09 cross-store-atomic-publication；**secondarySkills**：S07；**feedback**：event.delivery；**mutant**：M-EV-10。

## 7. D — UI、OpenAPI、snapshot 跨层闭环

### D-01 浏览器完成 V1 Export、Grant、Range 与撤销 — 4 分
- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture**：README “Real UI”；F-BROWSER V1 数据。
- **公开动作 / oracle**：production Chromium 仅经可见控件创建/取消 Export、等待 READY、创建 Grant、下载与撤销，refresh 并用 HTTP/snapshot 对账。
- **Mandatory / 禁止副作用**：loading/error/terminal 状态真实，键盘和移动布局可用；UI 不伪造成功、不直连存储、不泄露 token/绝对路径。
- **primarySkill**：S09 cross-store-atomic-publication；**feedback**：ui.v1-export；**mutant**：M-EV-03。

### D-02 浏览器展示 Shard 进度、Manifest 与定向下载 — 4 分
- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture**：T16 UI 更新与 sharded schema；F-SHARD。
- **公开动作 / oracle**：浏览器创建大 Export，观察每 shard ordered state、aggregate failure/success，下载选定 shard/Manifest 并 refresh。
- **Mandatory / 禁止副作用**：页面 ordinal/range/count/digest 与 API bytes 一致；partial shards 不显示 READY，legacy UI 仍可操作且不被强迫理解 Manager 字段。
- **primarySkill**：S17 frozen-fanout-aggregate-closure；**feedback**：ui.sharded-export；**mutant**：M-EV-08。

### D-03 OpenAPI 与 FINAL snapshot 的精确联合合同 — 4 分
- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture**：README OpenAPI/snapshot 与 T16 FINAL resource union；多页全状态资源。
- **公开动作 / oracle**：独立冻结 contract map 校验 routes/schema/errors，再读取同一 point-in-time snapshot 并重算 sort。
- **Mandatory / 禁止副作用**：sharded routes/fields、legacy body、Work enum、exact resource keys/shapes/sorts 正确，递归省略 *Token/秘密；legacy shape 按 EV-GAP-01 不作推断。
- **primarySkill**：S17 frozen-fanout-aggregate-closure；**secondarySkills**：S11；**feedback**：contract.snapshot；**mutant**：M-EV-05。

### D-04 请求到 bytes、Event、Proof 的跨层可追溯闭环 — 3 分
- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture**：README audit/verification/handoff invariants；成功、取消、删除三条链。
- **公开动作 / oracle**：从 create response 追到 section/object或Manifest、Grant、Event、cleanup proof，按公开 IDs 与 digest 对账。
- **Mandatory / 禁止副作用**：每条链无孤儿/缺口/重复 identity，失败链不留 artifact；snapshot/download/log/error 不泄漏 Grant 凭据、私有 seed 或文件路径。
- **primarySkill**：S09 cross-store-atomic-publication；**feedback**：cross-layer.trace；**mutant**：M-EV-10。

## 8. E — 兼容与合同形状性能

### E-01 V1 one-object 数据到 FINAL 的无损兼容 — 2.5 分
- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture**：T16 migration/legacy rules；V1 binary 生成全终态、pending Work、active Grant、unacked Event、saved replay。
- **公开动作 / oracle**：同库运行 FINAL migration，使用旧 request/endpoint/replay 再读全部历史和 bytes。
- **Mandatory / 禁止副作用**：ID/body/event sequence/replay/bytes 不变，legacy Export/Grant 精确工作；新 sharded 数据不倒灌进 V1 seed，pending Work 保持原语义。
- **primarySkill**：S04 database-owned-atomic-idempotency；**secondarySkills**：S02；**feedback**：migration.v1-compat；**mutant**：M-EV-07。

### E-02 Range 下载持续吞吐与 byte oracle — 2.5 分
- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture**：README scenario range-download，原样 dataset/setup/concurrency/warm-up/window。
- **公开动作 / oracle**：100 concurrent、60 秒，逐响应验证 206/range/ETag/1 MiB bytes 后统计 aggregate MiB/s。
- **Mandatory / 禁止副作用**：≥150 MiB/s；wrong bytes、200 fallback、5xx、live-object deletion 均为零，负载后 A-03/A-04 仍成立。
- **primarySkill**：S14 contract-shaped-performance-and-backlog；**feedback**：perf.range-download；**mutant**：M-EV-03。

### E-03 五百万记录生成时限与摘要闭合 — 2.5 分
- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture**：README scenario five-million-record-generation 原样 fixture 与 timer。
- **公开动作 / oracle**：两 worker 生成固定四 scope JSONL Export，按公开 timer 测量并流式重算 records/order/digest。
- **Mandatory / 禁止副作用**：≤120 秒且 missing/duplicate/misorder/digest mismatch/5xx 为零；Work 排空，负载后 B-01 成立。
- **primarySkill**：S14 contract-shaped-performance-and-backlog；**feedback**：perf.large-generation；**mutant**：M-EV-01。

### E-04 一万过期对象 cleanup 时限与 live 控制 — 2.5 分
- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture**：README scenario expired-object-cleanup 原样 10k expired + 1k live controls。
- **公开动作 / oracle**：两 cleanup workers，以公开 timer 排空，逐一验证 Proof/snapshot 和 live bytes。
- **Mandatory / 禁止副作用**：≤60 秒，10k 精确删除/Proof，1k controls 全部可读；missing proof、live deletion、nonterminal Work、unexpected failure 为零。
- **primarySkill**：S14 contract-shaped-performance-and-backlog；**feedback**：perf.cleanup；**mutant**：M-EV-04。

## 9. Mutant calibration（10 个领域 mutant）

| Mutant | 单一故障 | 必须击杀 |
| --- | --- | --- |
| M-EV-01 | worker 读取生成时当前 revision | A-01、E-03 |
| M-EV-02 | cancel 覆盖已发布 READY | A-02、B-03 |
| M-EV-03 | Range end 错一 byte | A-03、E-02 |
| M-EV-04 | cleanup 忽略 active Grant/共享可达性 | A-04、B-04、E-04 |
| M-EV-05 | shard 跨 section 分割 | A-05、D-03 |
| M-EV-06 | metadata READY 先于 bytes | B-01、C-02 |
| M-EV-07 | idempotency/active dedupe 仅进程内 | B-02、E-01 |
| M-EV-08 | 部分 VERIFIED 即发布 Manifest | B-05、D-02 |
| M-EV-09 | stale worker token 可提交 | C-01、C-03 |
| M-EV-10 | Event 在业务 transaction 外写入 | C-04、D-04 |

Gold 与每个 mutant 使用同 image/fixture/seed 至少重跑三次；Gold 全过且每个 mutant 稳定触发主 Case
后才冻结 runner。

## 10. README→Case 与旧 H→Case

| Requirement | Case |
| --- | --- |
| captured revision、JSONL/CSV、sections | A-01、B-01 |
| lifecycle、cancel、active dedupe | A-02、B-02、B-03 |
| grants、range、revoke、expiry | A-03、B-04 |
| cleanup、retention、proof | A-04、C-03、E-04 |
| sharded plan、Manifest、target Grant | A-05、B-05、D-02 |
| Work lease/fencing、outbox | C-01～C-04 |
| Real UI、OpenAPI、snapshot | D-01～D-04 |
| V1 migration/compatibility | E-01 |
| published performance | E-02～E-04 |

| 旧 H | 新 Case（不重复计分） |
| --- | --- |
| H-01 | 不计分 preflight；migration 行为归 E-01 |
| H-02 | A-01、A-03、D-03 |
| H-03 | A-01～A-04 |
| H-04 | B-01、B-03、B-04 |
| H-05 | B-02 |
| H-06 | B-03～B-05 |
| H-07 | C-01～C-03 |
| H-08 | C-04 |
| H-09 | E-01 |
| H-10 | A-05、B-05 |
| H-11 | D-02 与 B-05/C-01 |
| H-12 | E-02～E-04 |
| H-13 | 不单列计分；项目证据用于对应 Case 诊断 |

统一 Hard Caps 之外：跨租户 bytes 泄漏或探测 hidden fixture 为 invalid；提前 READY、删除 active
Grant 保护对象、或 V1→FINAL 丢失已提交 bytes/replay 时 correctness 总分上限 35。
