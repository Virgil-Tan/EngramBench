# ArtifactVault Hidden Test V2 设计

> 状态：设计稿；只定义黑盒 Case，不实现 runner。计分权威仅为 `workspace/README.md`、`CONTEXT.md` 与固定 Manager 消息；旧 `E2E_TEST_PLAN.zh-CN.md` 只用于追溯旧 H，不产生 expected value。共享 install/build/migrate/boot/health 仅执行 `hidden-test-v2-standard` preflight，**不计入下列 22 个 Case 或 100 分**。

## 1. 测试画像与隔离

- **两项主机制**：内容寻址上传（顺序 range、流式验证、引用安全 GC）；多平台 Release（成员独立验证、manifest 原子发布、V1 兼容迁移）。
- **领域 family**：`STREAM`、`RELEASE`、`RACE`、`MIGRATE`、`LOAD` 只用于定位业务主题；评分以每个 Case 的显式 A–E dimension 为准。
- **核心 primarySkill（4 个）**：`S09` cross-store-atomic-publication、`S04` database-owned-atomic-idempotency、`S07` durable-work-fenced-recovery、`S02` compatibility-seed-bootstrap-gate；性能与跨层验收只在适用 Case 列为 `secondarySkills`。
- **公开 seam**：公开 HTTP/OpenAPI、Range 下载、receiver、barrier、进程信号、production Chromium、verification snapshot；禁止读取候选源码、数据库表、ORM、staging/digest 私有路径。
- **failure isolation**：每个 Case 使用新数据库、新端口、新 `MANAGED_DATA_ROOT` 与独立固定 seed；每条 LOAD Case 另起生产拓扑。Case 只按自身 oracle 得分，公共 preflight 失败记为不可运行证据，不换名重复计分；hard cap 单独应用而不二次扣分。

## 2. 计分 Case（22 个，100 分）

### STREAM-01 顺序 Content-Range 与精确重放 — 6 分

- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture / seam 动作**：README「Deterministic policy」1–2；生成 9 MiB 固定字节流，以 8 MiB+1 MiB PUT，并重放首段。
- **独立 oracle / mandatory assertions / 禁止副作用**：本地字节模型计算 `nextOffset`；断言 inclusive range、短尾段及同字节重放响应稳定；不得重复增长 offset、创建版本/引用或暴露 staging 路径。
- **primarySkill / feedback / mutant**：`S09` / `STREAM_RANGE_CONTRACT` / `AV-M01`。

### STREAM-02 Gap、overlap 与异字节 range 原子拒绝 — 6 分

- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture / seam 动作**：README「Deterministic policy」2 与错误表；对同一 session 注入 gap、overlap、越界和相同 range 异字节。
- **独立 oracle / mandatory assertions / 禁止副作用**：以提交前 snapshot+后续合法 PUT 验证 offset 未动且稳定错误精确；不得写入拒绝字节、推进状态、产生 Work/Event。
- **primarySkill / feedback / mutant**：`S09` / `ATOMIC_REJECTION` / `AV-M01`。

### STREAM-03 声明 size/digest 的流式验证 — 6 分

- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture / seam 动作**：README「Domain」「Verification」；上传已知 SHA-256 的 96 MiB 流并 complete，另测 size 与 digest 各一处错误。
- **独立 oracle / mandatory assertions / 禁止副作用**：外部 SHA-256/byte count 为 oracle；正确项最终可读且 metadata 一致，错误项 REJECTED；不得在验证前出现 ArtifactVersion/BlobReference，错误项不得可下载。
- **primarySkill / feedback / mutant**：`S09` / `STREAM_VERIFY` / `AV-M02`。

### STREAM-04 跨 Package 内容寻址去重 — 5 分

- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture / seam 动作**：README「Domain」3、Mandatory invariants 1/4；两个 package/version 上传同一字节与 digest。
- **独立 oracle / mandatory assertions / 禁止副作用**：snapshot 重算一份 Blob、两份 committed reference，两个下载逐字节相同；不得复制可观察 Blob 身份、泄漏路径或让任一引用丢失。
- **primarySkill / feedback / mutant**：`S09` / `CONTENT_ADDRESSING` / `AV-M03`。

### STREAM-05 ETag、Range 下载与不可变内容 — 6 分

- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture / seam 动作**：README「HTTP」「Mandatory invariants」；对 committed 版本做全量、首/中/尾 Range，并尝试复用 package/version；README 未发布条件请求语义，测试不发送 `If-Match`/`If-None-Match`。
- **独立 oracle / mandatory assertions / 禁止副作用**：原始 fixture 切片与 digest ETag 为 oracle；断言 byte/status/header 精确且版本冲突稳定；不得改写已提交 bytes、mediaType、digest 或 audit/event 历史。
- **primarySkill / feedback / mutant**：`S09` / `IMMUTABLE_DOWNLOAD` / `AV-M03`。

### RELEASE-01 多平台成员独立 VERIFIED、无提前引用 — 5 分

- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture / seam 动作**：Manager 规则 1–2 及 ReleaseArtifact；创建 linux/darwin/windows Release，依次完成成员验证。
- **独立 oracle / mandatory assertions / 禁止副作用**：ReleaseDetail/snapshot 显示每个成员独立 `VERIFIED` 且 `artifactVersionId=null`；不得提前创建任一 ArtifactVersion、BlobReference、manifest 或 PUBLISHED 状态。
- **primarySkill / feedback / mutant**：`S09` / `RELEASE_STAGING` / `AV-M04`。

### RELEASE-02 canonical manifest 与全员原子发布 — 5 分

- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture / seam 动作**：Manager 规则 2–3、publish 接口；以逆序平台输入，全部 VERIFIED 后 publish。
- **独立 oracle / mandatory assertions / 禁止副作用**：独立生成 ASCII 平台排序、固定键序、无空白 UTF-8 JSON 的 SHA-256；断言一次事务生成全部版本/引用并匹配 manifest；不得保留部分 COMMITTED 或使用请求顺序散列。
- **primarySkill / feedback / mutant**：`S09` / `ATOMIC_RELEASE` / `AV-M04`。

### RELEASE-03 未就绪、失败与 abandon 不泄漏版本 — 5 分

- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture / seam 动作**：Manager 规则 4、`RELEASE_NOT_READY`、retry 接口；制造一项 REJECTED、一项 ABANDONED、一项 VERIFIED 并尝试 publish/retry。
- **独立 oracle / mandatory assertions / 禁止副作用**：拒绝前后资源差仅允许合法 replacement session；其他已验证 Blob 身份不变，Release 保持 DRAFT；不得泄漏部分 package version、引用或 manifest。
- **primarySkill / feedback / mutant**：`S09` / `RELEASE_ATOMIC_REJECTION` / `AV-M04`。

### RELEASE-04 平台下载的 OpenAPI/UI/snapshot 闭环 — 4 分

- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture / seam 动作**：Manager 规则 5–7、content/OpenAPI/UI/snapshot 要求；发布含两个相同 Blob 平台和一个不同 Blob 的 Release，用 Chromium 选择平台并下载。
- **独立 oracle / mandatory assertions / 禁止副作用**：live traffic 符合 OpenAPI，UI 选择、ReleaseDetail、snapshot referenceCount 与按 platform 下载的 bytes/ETag 闭合；singular 精确 `409 PLATFORM_REQUIRED`，未知平台精确 `404 RELEASE_PLATFORM_NOT_FOUND`；不得猜默认平台、读私有路径或复制 Blob。
- **primarySkill / secondarySkills / feedback / mutant**：`S09` / `S15` / `PLATFORM_RESOLUTION` / `AV-M03`。

### RELEASE-05 引用保护、二次检查与 GC grace — 5 分

- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture / seam 动作**：README「Deterministic policy」4；制造孤儿 Blob 与仍被 V1/Release 引用 Blob，在 600 秒边界运行 GC 并并发建立引用。
- **独立 oracle / mandatory assertions / 禁止副作用**：snapshot+公开下载证明仅超过 grace 且二次检查仍无引用的 digest 消失；不得删除任何可下载 Blob、早删孤儿或由 stale worker 删除新引用 Blob。
- **primarySkill / feedback / mutant**：`S09` / `REFERENCE_SAFE_GC` / `AV-M05`。

### RACE-01 complete/publish 的 unknown response 与持久 replay — 5 分

- **dimension**：B（数据正确性、幂等与并发）
- **来源 / fixture / seam 动作**：README「Durable idempotency」、Manager publish；response shield 在 commit 后断开，再跨两个 API 20 路同 key 重放及异 payload。
- **独立 oracle / mandatory assertions / 禁止副作用**：保存的 status/semantic JSON、releaseId/manifestSha256 为 oracle；只一次验证/发布效果，异 payload 精确 conflict；不得生成第二 Work、版本、引用或 event。
- **primarySkill / feedback / mutant**：`S04` / `DURABLE_IDEMPOTENCY` / `AV-M06`。

### RACE-02 V1/Release 唯一冲突的跨层一致性 — 4 分

- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture / seam 动作**：Manager 规则 7、OpenAPI/UI/snapshot；两 API 同时创建 V1 upload 与多平台 Release 占用同 package/version，再用 UI/公开 detail 查看获胜资源与冲突。
- **独立 oracle / mandatory assertions / 禁止副作用**：live 409 code/envelope 与 OpenAPI 一致，UI、detail、snapshot 只显示恰一 authority；不得出现两个 DRAFT/Version、混合成员、遗留 upload sessions 或前端伪成功。
- **primarySkill / secondarySkills / feedback / mutant**：`S04` / `S15` / `UNIQUENESS_RACE` / `AV-M06`。

### RACE-03 verification/expiry/GC lease fencing — 5 分

- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture / seam 动作**：README「Workers」「Controlled recovery barrier」；分别在 claimed/effect-complete/before-commit SIGKILL，等待 lease 后 replacement 接管。
- **独立 oracle / mandatory assertions / 禁止副作用**：barrier 身份、attempt 与终态 snapshot 为 oracle；合法 Work 排空且每一业务终态一次；不得由过期 owner 提交、双重 rename、重复引用或误删 Blob。
- **primarySkill / feedback / mutant**：`S07` / `LEASE_FENCING` / `AV-M07`。

### RACE-04 outbox unknown ACK 的稳定正文 — 5 分

- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture / seam 动作**：README「events/recovery」；receiver 持久化完整事件后悬挂 ACK 并 SIGKILL dispatcher，再启动替代者。
- **独立 oracle / mandatory assertions / 禁止副作用**：receiver 解析后的 eventId、type、semantic JSON 与聚合 sequence 为 oracle；至少重发一次且 eventId 与 semantic body 等价、顺序连续；不得要求未发布的 JSON 字节序、创建新事件身份或泄漏路径/token/raw staging 数据。
- **primarySkill / feedback / mutant**：`S07` / `OUTBOX_REPLAY` / `AV-M09`。

### MIGRATE-01 V1 默认平台映射且 Blob 零重写 — 2.5 分

- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture / seam 动作**：Manager 规则 6、8；用 V1 binary 写入大小/Range/ETag 已记录的版本，再运行 FINAL migration。
- **独立 oracle / mandatory assertions / 禁止副作用**：迁移前下载 hash、ETag、IDs 与 snapshot 对照；生成一成员 `default` Release，legacy 响应精确不增 platform；不得移动/重写 bytes、更换 ArtifactVersion/Blob 身份。
- **primarySkill / feedback / mutant**：`S02` / `MIGRATION_COMPATIBILITY` / `AV-M08`。

### MIGRATE-02 pending verification 与 expiry deadline 保真 — 2.5 分

- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture / seam 动作**：Manager 规则 10；迁移前留一 LEASED verification、一 PENDING expiry 与部分 staging bytes，迁移后恢复 worker。
- **独立 oracle / mandatory assertions / 禁止副作用**：迁移前 Work/offset/deadline/attempt 记录与迁移后公开状态一致，replacement 按原 deadline 收敛；不得重置 offset、延长 deadline、换 workId 或重复 member。
- **primarySkill / feedback / mutant**：`S02` / `INFLIGHT_MIGRATION` / `AV-M08`。

### MIGRATE-03 Artifact/Blob V1 seed 原子导入、replay/conflict 与 FINAL 兼容 — 6 分

- **dimension**：A（需求与公共接口覆盖）
- **来源 / fixture / seam 动作**：README「Seed contract」与 Manager V1 seed 保持规则；导入合法相对 asset、同 version+digest replay、同 version 异 digest、坏引用、digest/size mismatch、绝对/dot/symlink/非 regular asset，再在 FINAL 重放 V1 seed。
- **独立 oracle / mandatory assertions / 禁止副作用**：合法导入产生 exact Package/ArtifactVersion/Blob/Reference 与可下载原 bytes；同 digest no-op，异 digest 精确 `SEED_VERSION_CONFLICT`；任一坏 member 对数据库与 managed root 均零可见效果，FINAL 不要求 Manager seed member、不改历史 identity/bytes。
- **primarySkill / feedback / mutant**：`S02` / `WIRE_COMPATIBILITY` / `AV-M08`。

### MIGRATE-04 Release UI/OpenAPI/snapshot 双形态证据 — 4 分

- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture / seam 动作**：Manager wire/API/snapshot 及 UI 更新要求；Chromium 查看 migrated singular 与新 multi-platform Release 并下载指定平台。
- **独立 oracle / mandatory assertions / 禁止副作用**：OpenAPI/runtime shape、ReleaseDetail、FINAL snapshot exact key/sort 与浏览器可见结果互相印证；不得让 legacy body 出现 Manager 字段、让 UI 读私有路径或用非公开 API。
- **primarySkill / secondarySkills / feedback / mutant**：`S02` / `S15` / `COMPATIBLE_UI_EVIDENCE` / `AV-M08`。

### LOAD-01 20 路 64 MiB 流式上传 — 2.5 分

- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture / seam 动作**：README `concurrent-upload-stream`；正式规模、20 并发、固定 64 MiB payload，按公开 timer 测量。
- **独立 oracle / mandatory assertions / 禁止副作用**：独立计数完整 PUT bytes/latency；聚合 ≥120 MiB/s，replay/gap/5xx=0；不得缩放、预写 bytes、以 buffered 假响应计成功或突破公开 RSS 约束。
- **primarySkill / secondarySkills / feedback / mutant**：`S09` / `S14` / `PERFORMANCE_STREAM` / `AV-M10`。

### LOAD-02 artifact metadata 持续读取 — 2.5 分

- **dimension**：E（迁移、性能与可运维性）
- **来源 / fixture / seam 动作**：README `artifact-metadata-read`；使用固定 seed、64 clients、60 秒生产读取。
- **独立 oracle / mandatory assertions / 禁止副作用**：仅 exact metadata 200 计数，≥200 read/s、p95≤120ms、unexpected 5xx=0；不得返回错 package/version、泄漏路径或用缓存绕过 committed reference authority。
- **primarySkill / secondarySkills / feedback / mutant**：`S09` / `S14` / `PERFORMANCE_READ` / `AV-M10`。

### LOAD-03 2 GiB verification crash recovery — 5 分

- **dimension**：C（Worker、恢复与持久性）
- **来源 / fixture / seam 动作**：README `verification-recovery`；两 worker claimed 后 SIGKILL，lease 到期后两 replacement，正式 2 GiB backlog。
- **独立 oracle / mandatory assertions / 禁止副作用**：snapshot 证明 90 秒内排空，worker peak RSS≤768 MiB 且验证阶段增量≤64 MiB；不得 stale commit、全量内存读取、重复版本/引用或 unexpected failure。
- **primarySkill / secondarySkills / feedback / mutant**：`S07` / `S14` / `PERFORMANCE_RECOVERY` / `AV-M02`。

### LOAD-04 负载后 snapshot/下载/Event 跨层对账 — 3 分

- **dimension**：D（OpenAPI、UI 与跨层闭环）
- **来源 / fixture / seam 动作**：README performance post-load invariants、OpenAPI/UI/snapshot 与 Manager compatibility；三条负载各自结束后抓 point-in-time snapshot、经 UI/detail 抽样并下载。
- **独立 oracle / mandatory assertions / 禁止副作用**：重算 package/version/platform 唯一、digest/size、referenceCount、manifest、event sequence 与 Work drain；任一错误使对应 LOAD 失败；不得只报吞吐、跳过 invariants 或跨 scenario 复用数据库。
- **primarySkill / secondarySkills / feedback / mutant**：`S09` / `S14,S15` / `POST_LOAD_INVARIANTS` / `AV-M10`。

## 3. Worked example：RELEASE-02

Fixture 以 `windows,linux,darwin` 顺序创建三个成员，分别上传固定 bytes，外部计算各自 SHA-256。Runner 等三项公开状态均为 `VERIFIED` 后调用 publish；oracle 自行构造按 ASCII 排序的 `[{platform,sha256,size,mediaType}]`，固定键序、无多余空白后 SHA-256。通过必须同时满足：manifest digest 相等；三项版本/引用同一观察点全部出现；Release/UploadSession 全部进入正确终态；任意 publication 前 snapshot 均无 ArtifactVersion/BlobReference。只校验 `PUBLISHED` 字段不算通过。

## 4. Mutant 清单（10 个）

| Mutant | 单一故障 | 必杀 Case |
| --- | --- | --- |
| AV-M01 | overlap 或同 range 异字节也当 replay | STREAM-01/02 |
| AV-M02 | 验证时整 Blob 入内存，或 size/digest 错仍提交 | STREAM-03、LOAD-03 |
| AV-M03 | 每次上传复制 Blob，或下载不经 committed reference | STREAM-04/05、RELEASE-04 |
| AV-M04 | 成员一验证即建版本，publish 非原子或 manifest 未排序 | RELEASE-01/02/03 |
| AV-M05 | GC 无 grace/二次引用检查 | RELEASE-05 |
| AV-M06 | 幂等/版本唯一性只在进程内 | RACE-01/02 |
| AV-M07 | Work 无完成 fencing，stale worker 可提交 | RACE-03 |
| AV-M08 | 迁移移动 Blob、换 ID/ETag/replay 或重置 deadline | MIGRATE-01/02/03/04 |
| AV-M09 | dispatcher 重试生成新 eventId/body | RACE-04 |
| AV-M10 | 缩放/伪造性能或不做负载后对账 | LOAD-01/02/04 |

## 5. SPEC-GAP 登记

- `SPEC-GAP-AV-01`：Manager 没有发布新的 Domain Event type 名称。V2 不要求某个未发布名称；只断言 V1 同类 transition 的既有事件规则、历史身份不变，以及不得发明新名称。
- `SPEC-GAP-AV-02`：Manager 未给 Release 列表接口，仅给 detail 与平台 content。V2 不虚构列表 endpoint；UI Case 通过已发布 detail/navigation 证明流程。

## 6. Requirement / contract-map

| README / Manager 合同 | Cases |
| --- | --- |
| README Domain、range 与 streaming policy | STREAM-01..05 |
| README Blob reference、expiry/GC | RELEASE-05、RACE-03 |
| README durable idempotency、events、barrier | RACE-01..04 |
| Manager multi-platform Release 规则与 wire/API | RELEASE-01..04 |
| Manager V1→default migration 与兼容 | MIGRATE-01..04 |
| README 三条 fixed performance contract | LOAD-01..04 |
| README/Manager UI、OpenAPI、snapshot | MIGRATE-04（相关 Case 同时做协议断言） |

## 7. 旧 H → V2 Case 映射

| 旧 H | V2 Cases |
| --- | --- |
| H-01 | 公共 preflight（不计分）；领域 seed 语义由 MIGRATE-03 独立计分 |
| H-02 | STREAM-01/02/05、MIGRATE-04 |
| H-03 | STREAM-01/03/04/05 |
| H-04 | STREAM-02/03、RELEASE-03/05 |
| H-05 | RACE-01/02 |
| H-06 | RACE-02、RELEASE-05 |
| H-07 | RACE-03 |
| H-08 | RACE-04 |
| H-09 | MIGRATE-01/02/03 |
| H-10 | RELEASE-01..05 |
| H-11 | RACE-02/03、MIGRATE-04 |
| H-12 | LOAD-01..04 |
| H-13 | 公共 preflight（不计分）；领域 test truthfulness 由 LOAD-04 |

## 8. 评分与失败规则

按显式 dimension 汇总为 `A=30、B=25、C=20、D=15、E=10`，合计 **22 Case / 100 分**；领域 family 不再决定维度。同一事实只归属一个主 Case；交叉断言只作 hard-cap 证据。已提交 Blob 不可读/被 GC、Release partial publish、幂等产生第二业务效果、stale lease 提交或迁移改写 bytes/历史均触发对应旧计划 hard cap。S03/S16 如需观测，仅由不计分 trajectory observer 记录，不从最终产物反推。
