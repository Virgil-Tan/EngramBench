# FirmwareFleet Harness-owned E2E / Concurrency / Recovery / Performance 方案

## 1. 边界与等级

本文件位于 candidate workspace 外，只定义 D1 黑盒评测方案。当前没有 runner、中央 score
manifest、gold 或 calibration 证据，不能声称 D3。Evaluator 只使用公开命令、HTTP、浏览器、
webhook receiver、文件下载和进程信号；不得 import 候选源码、ORM、表名或 'dist' 路径。

## 2. 固定环境

- Node.js 22、PostgreSQL 16、Chromium 和 Docker-compatible OCI；容器限制为 4 logical CPUs、
  8 GiB RAM，两个 API、两个 workers、一个 dispatcher 和 PostgreSQL 共享该限制；
- 每个 scenario 使用新数据库、新端口和独立 managed data directory；
- 两个 API、至少两个 Command Task workers 和一个 dispatcher 共享同一 PostgreSQL；
- command timeout 60 分钟，project timeout 24 小时；
- 合法随机输入和交错保存私有 seed，失败报告只公开脱敏后的断言与复现 ID。

## 3. Snapshot 与 barrier

T15 后冻结 'V1_SNAPSHOT'，T22 后冻结 'FINAL_SNAPSHOT'。H-09 先用 V1 binary/contract 写入
历史数据、pending work、event 和 idempotency replay，再切换到 FINAL migration。

- unknown HTTP outcome：response shield 收到完整 upstream response 后断开 candidate client；
- unknown webhook ACK：receiver 收到并持久化完整 request 后暂停 ACK，再 SIGKILL dispatcher；
- worker recovery：按公开 'TEST_BARRIER_URL' 协议在 'worker.claimed'、
  'worker.effect-complete' 或 'worker.before-commit' 收到完整 barrier body 后暂停，再 SIGKILL
  worker 并等待 'WORK_LEASE_SECONDS'；
- 不允许随机 sleep 推断 commit、claim、delivery 或 ACK 时点。

## 4. Hidden scenario design

### H-01 Clean install, migration, seed, build, and boot

从 fixture commit 开始执行公开命令；migration 重放；合法 seed、同 digest 重放、冲突版本和随机
非法成员；生产 API/UI/worker/dispatcher 全部启动。断言 OpenAPI 与 runtime 基础状态一致。

### H-02 Contract, validation, query, and browser baseline

随机 UUID、边界整数、未知字段、媒体类型、游标和时间；验证稳定错误、分页、排序、真实 React
页面、键盘路径、移动布局和 refresh 后状态。

### H-03 V1 successful main flow

通过公开 API 和浏览器完成：

- Register compatible Firmware Images and create one-wave Campaigns from an immutable Device selector.
- Deliver download, install, and verify commands in order with stable IDs and fencing tokens.
- Accept offline Device Reports in atomic ordered batches and replay duplicates safely.
- Recover Command Tasks and fail or roll back updates under the exact timeout policy.
- Expose fleet versions, device timelines, campaign progress, failures, and event deliveries in the UI.

对每个成功状态同时检查响应、查询、历史、异步工作和事件。

### H-04 Atomic rejection and conservation

在每个公开失败边界生成合法但不可满足的请求，断言无 partial aggregate、任务、事件或守恒量
变化。核心断言：

1. A Device executes at most one active Device Update and one current command at an instant.
2. Installed firmware changes only after a valid verify report for the exact image digest and token.
3. Device Report sequence is strictly increasing; identical duplicate batches have no second effect.
4. A Campaign target set and Firmware Image never change after creation.
5. Rollback returns to the captured prior version exactly once and cannot install an unrelated image.

### H-05 Durable idempotency and unknown response

对每个 mutation 测试相同 key replay、语义冲突、20 路并发、response shield、API SIGKILL 和
重启。状态码与语义 JSON 保持原结果，且只出现一次业务效果和事件。

### H-06 Multi-process contention

两个 API 和两个 workers 对同一热点 authority 进行有 seed 的竞争；随机化合法请求数量和顺序，
最后通过公开查询重算全部不变量，不依赖数据库内部结构。

### H-07 Worker lease and terminal recovery

分别在 claim 后、外部工作后、commit 前 barrier SIGKILL worker；等待 'WORK_LEASE_SECONDS' 后
启动另一 worker，断言任务可恢复、stale token 失败、终态和副作用最多一次。

### H-08 Transactional outbox and unknown ACK

对成功和回滚业务检查 event existence；receiver 返回 500、断开连接、在完整 body 后暂停 ACK，
dispatcher 重启。重试保持 eventId/body，成功顺序递增，不能丢 event 或制造新身份。

### H-09 Populated V1 to FINAL migration

V1_SNAPSHOT 生成普通、边界、terminal、pending、leased、undelivered 和已保存 replay 数据。
FINAL migration 后逐项验证：

- Migrate every V1 Campaign and Device Update to a one-hop Upgrade Plan without changing commands, tokens, reports, versions, or events.
- In-flight Command Tasks retain their sequence and retry identity.
- Previously completed Campaigns remain terminal and never trigger migration-time commands.

### H-10 Manager core behavior

仅在 T16 已发布后按黑盒方式验证：

- A target Firmware Image may require a Device to install 1-5 intermediate Images through declared compatibleFromVersions edges.
- At Campaign creation, compute and persist one immutable Upgrade Plan per Device: fewest hops first, then lexicographically smallest version sequence, then imageId.
- Each hop has DOWNLOAD, INSTALL, and VERIFY commands and the next hop cannot start before the prior digest verifies.
- Failure rolls back only the current hop to its captured prior Image; a successful earlier intermediate remains the starting point for an explicit retry.
- Campaign progress aggregates Devices and hop states, while maxParallel counts Devices rather than hop commands.
- Legacy direct-compatible Campaigns remain one-hop and keep prior response fields; multi-hop updates expose upgradePlan[] and currentHopIndex.

新增 wire schema 与接口同样属于断言面：

- UpgradePlan = {deviceUpdateId:uuid,sourceVersion:string,targetVersion:string,pathDigest:sha256,currentHopIndex:int,hops:[UpgradeHop],createdAt:timestamp}
- UpgradeHop = {hopIndex:int,firmwareImageId:uuid,fromVersion:string,toVersion:string,imageDigest:sha256,state:WAITING|RUNNING|SUCCEEDED|FAILED,attempts:[UpgradeHopAttempt]}
- UpgradeHopAttempt = {attempt:int,state:DOWNLOADING|INSTALLING|VERIFYING|SUCCEEDED|FAILED|ROLLED_BACK,firstCommandSequence:int,lastCommandSequence:int|null,startedAt:timestamp,completedAt:timestamp|null}
- POST /api/v1/firmware-campaigns computes every target Device UpgradePlan in the creation transaction using fewest hops, then lexicographically smallest version sequence, then imageId sequence; if any target has no path of 1..5 hops, no Campaign, Device Update, command, or event is created.
- pathDigest is SHA-256 of RFC 8785 {deviceId,sourceVersion,targetVersion,imageIds:[uuid]} for the selected ordered path.
- GET /api/v1/device-updates/:deviceUpdateId/upgrade-plan returns the immutable UpgradePlan; legacy direct-compatible updates contain exactly one Hop and retain existing singular fields.
- POST /api/v1/device-updates/:deviceUpdateId/retry with {expectedCurrentHopIndex,expectedAttempt} is legal only after the current attempt failed and rolled back; it preserves successful earlier Hops and creates a new attempt with fresh tokens and continuing commandSequence values.
- Device commandSequence is global across all Hops and attempts. Poll and report APIs never reset it at a Hop boundary, and a report for a non-current Hop, attempt, command, or token cannot change installed firmware or plan state.
- 409 UPGRADE_PATH_UNAVAILABLE: a target Device has no deterministic path to the target Image within five hops
- 409 UPGRADE_HOP_NOT_CURRENT: the command or report references another Hop or attempt
- 409 DEVICE_UPDATE_NOT_RETRYABLE: the current Hop lacks a completed failed rollback or expected attempt is stale
- The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
- The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
- Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
- Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

FINAL snapshot 与性能兼容断言：

The FINAL verification snapshot 'resources' object has exactly the union of these V1 and Manager resource specifications, with no other keys:

- 'deviceModels' uses exact shape 'DeviceModel = {modelId:uuid,name:string}' and sorts ascending by scalar field-path tuple 'modelId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'devices' uses exact shape 'Device = {deviceId:uuid,modelId:uuid,labels:object,installedVersion:string,installedDigest:sha256,lastReportSequence:int}' and sorts ascending by scalar field-path tuple 'deviceId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'firmwareImages' uses exact shape 'FirmwareImage' and sorts ascending by scalar field-path tuple 'firmwareImageId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'firmwareCampaigns' uses exact shape 'FirmwareCampaign' and sorts ascending by scalar field-path tuple 'campaignId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'deviceUpdates' uses exact shape 'DeviceUpdate' and sorts ascending by scalar field-path tuple 'deviceUpdateId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'deviceCommands' uses exact shape 'DeviceCommand' and sorts ascending by scalar field-path tuple 'deviceUpdateId', 'sequence', then by RFC 8785 canonical JSON as the tie-breaker.
- 'deviceReports' uses exact shape 'DeviceReport' and sorts ascending by scalar field-path tuple 'deviceUpdateId', 'sequence', then by RFC 8785 canonical JSON as the tie-breaker.
- 'upgradePlans' uses exact shape 'UpgradePlan' and sorts ascending by scalar field-path tuple 'deviceUpdateId', then by RFC 8785 canonical JSON as the tie-breaker.

The Manager-added resource specifications are exactly:

- 'upgradePlans' uses exact shape 'UpgradePlan' and sorts ascending by scalar field-path tuple 'deviceUpdateId', then by RFC 8785 canonical JSON as the tie-breaker.

The FINAL Work kind enum is exactly the union 'COMMAND_DELIVERY', 'REPORT_TIMEOUT', 'ROLLBACK'. The Manager-added
Work kinds are exactly (none). All V1 snapshot point-in-time,
recursive '*Token' omission, sorting, Work state/lease/retention/drain, and Domain Event rules remain
mandatory. The FINAL binary reruns exactly these three V1-compatible scenarios:

- 'device-command-poll': serve 3,000 command polls/s with p95 <= 80 ms; threshold: At least 3,000 successful polls/s for 60 seconds and p95 <= 80 ms; unexpected 5xx = 0.
- 'device-report-batch': ingest 2,000 Device Reports/s with p95 <= 200 ms; threshold: At least 2,000 successful one-report batch responses/s for 60 seconds and p95 <= 200 ms; exactly half the requests are replays.
- 'command-recovery': recover and drain 100,000 pending Command Tasks within 180 s after restart; threshold: All 100,000 pending commands drain in <= 180 seconds after replacement spawn; stale commit and unexpected failure counts are zero.

Their published setup, selector, request, concurrency, warm-up, measurement, timer, success condition,
and threshold remain unchanged. This Manager change adds correctness, concurrency, and recovery
assertions only; it does not replace or relax a performance scenario.

同时验证每个失败分支整组回滚和重复请求一致。

### H-11 Manager UI, concurrency, and recovery

用 production Chromium 完成新旧流程；两个 API/worker 竞争 Manager 新基数或状态；在可观察
barrier 崩溃并恢复；检查 compatibility fields、聚合状态、成员状态、事件顺序和无重复效果。

### H-12 Sustained performance plus post-load correctness

严格对 FINAL binary 重跑 workspace README 的同三个 V1-compatible scenario，不得改变任何字段或
阈值；Manager 增量只增加 correctness、concurrency 和 recovery 断言。每个 scenario 使用独立新库，
严格执行公开 dataset、setup、selector、request、concurrency、warm-up、measurement、success、
threshold 和 timer，记录 p50/p95/p99、吞吐、成功 mutation、预期冲突、unexpected 5xx、
worker/dispatcher backlog 与排空时间。固定 dataset 为：seedVersion perf-v1 contains exactly 100 deviceModels, 100,000 devices, 500 firmwareImages, 100 campaigns, 100,000 deviceUpdates, 100,000 current commands, and zero reports; every Device is offline with exactly one current command and one pending Command Task.。三个场景是：

### Scenario 'device-command-poll'

- Target: serve 3,000 command polls/s with p95 <= 80 ms
- Mode: 'http'
- Method: 'POST'
- Path: '/api/v1/devices/:deviceId/commands/poll'
- Setup: All 100,000 Devices have one current command. Half of the poll targets report the preceding sequence and half report the current sequence; polling does not consume commands.
- Selector: Alternate COMMAND and NO_CHANGE Device IDs from separate bytewise-sorted lists.
- Request: {lastCommandSequence}; use current-1 for COMMAND and current for NO_CHANGE.
- Concurrency: 64
- Warm-up seconds: 10
- Measure seconds: 60
- Success: Only 200 exact poll responses count; each complete 100-request block is exactly 50 COMMAND and 50 NO_CHANGE, and command tokens never cross Device IDs.
- Threshold: At least 3,000 successful polls/s for 60 seconds and p95 <= 80 ms; unexpected 5xx = 0.
- Timer: The throughput window starts with the first measured request after warm-up; each latency sample runs from request dispatch through the complete response body.

### Scenario 'device-report-batch'

- Target: ingest 2,000 Device Reports/s with p95 <= 200 ms
- Mode: 'http'
- Method: 'POST'
- Path: '/api/v1/devices/:deviceId/report-batches'
- Setup: Reserve 70,000 Device commands: 10,000 unique reports for warm-up and 60,000 for measurement. Every request contains exactly one report.
- Selector: Repeat a new one-report batch then its exact idempotent replay. Across each 100 unique reports, 90 are SUCCEEDED and 10 are FAILED.
- Request: {firstSequence,reports:[{sequence,commandId,commandToken,outcome,installedDigest}]}; replay reuses key and body.
- Concurrency: 64
- Warm-up seconds: 10
- Measure seconds: 60
- Success: A first atomic stored batch or exact replay counts; no partial batch, sequence gap, or cross-command token is accepted.
- Threshold: At least 2,000 successful one-report batch responses/s for 60 seconds and p95 <= 200 ms; exactly half the requests are replays.
- Timer: The throughput window starts with the first measured request after warm-up; each latency sample runs from request dispatch through the complete response body.

### Scenario 'command-recovery'

- Target: recover and drain 100,000 pending Command Tasks within 180 s after restart
- Mode: 'worker'
- Method: 'N/A'
- Path: 'work:COMMAND_DELIVERY'
- Setup: Exactly 100,000 Devices each have one pending COMMAND_DELIVERY Work. Hold two workers at worker.claimed, SIGKILL, wait for lease expiry, then start two replacements.
- Selector: Process campaignId,deviceId,command sequence order while respecting each Campaign maxParallel bound.
- Request: No measured client request is issued; setup uses only the published seed and public APIs before the worker timer starts.
- Concurrency: 2
- Warm-up seconds: 0
- Measure seconds: 180
- Success: Every selected command becomes durably pollable with one identity, no COMMAND_DELIVERY Work remains nonterminal, and Campaign active counts never exceed maxParallel.
- Threshold: All 100,000 pending commands drain in <= 180 seconds after replacement spawn; stale commit and unexpected failure counts are zero.
- Timer: Start when both replacements spawn and stop only after snapshot plus representative poll responses prove every postcondition.

负载后重新执行 H-04 的全部不变量；任何不变量失败都使性能 assertion 失败。不得从旧的目标
摘要推断 workload，也不得把 Manager 增量改成第四个性能阈值。

### H-13 Project-owned gates and handoff truthfulness

从干净数据库逐个运行公开 test 命令，检查真实进程、真实 PostgreSQL、真实 Chromium、barrier
故障和 meaningful assertions；交叉核对最终回复所称命令、结果、性能、风险和未运行项。

## 5. 100 分映射

H-01 -> 5；H-02 -> 5；H-03 -> 10；H-04/H-05 -> 10；H-07/H-08 -> 15；
H-06 -> 10；H-09 -> 15；H-10/H-11 -> 10；H-13 tests -> 8；H-12 -> 7；
blind Judge explanation -> 2；evidence/handoff -> 3。最终 D3 必须把每个 assertion ID、唯一权重、
Checklist testGate 和 hard cap 写入一个 'score-manifest.v1.json'，不能重复计分。

## 6. Hard caps 与 invalid sample

- clean build、migration 或 production boot 失败：总分上限 25；
- 任一守恒、非负、唯一终态、at-most-once business effect 或 atomic rejection 不变量失败：上限 35；
- durable idempotency 在并发、未知响应或重启后产生第二效果：上限 30；
- 已提交业务缺 event、回滚业务有 event、event 重试改变身份/正文：上限 40；
- SIGKILL 后合法 pending work 永久丢失或 stale worker 可提交：上限 40；
- migration 丢历史数据、改变已保存 replay 或破坏旧客户端：上限 35；
- 性能后核心不变量失败：性能项 0 且应用相应 correctness cap。

读取 hidden assets、硬编码私有 fixture、访问 workspace 外路径或逃逸隔离标记为 invalid sample，
不是普通低分。

## 7. Calibration gate

实现 runner 后，先准备 gold 以及至少五个 mutants：process-local idempotency、非原子 event、
无 fencing lease、Manager partial migration、只测吞吐不验 invariant。相同 candidate/seed 至少
重复三次；所有 mutant 必须触发预期 assertion/cap，再冻结 image、fixture commit、README、
Manager、dialogue、score manifest、seed generator 和阈值。
