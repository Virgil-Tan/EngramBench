# FirmwareFleet 项目设计说明

## 1. 定位

FirmwareFleet 是一个从近空白 Git fixture 开始的高难度全栈 Coding Benchmark，主流程是
device firmware campaign delivery and acknowledgement。这是 Learning task；它的 Trajectory 与隐藏测试结果用于 Skill Evolution，不属于 13 个 Transfer/Test task。

本题只用一个主流程承载难度，重点测量：ordered device state、lease fencing、offline replay、campaign waves、rollback recovery。领域词汇以
[CONTEXT.md](./CONTEXT.md) 为准。

## 2. 可见性

Codex 初始只能看到 'workspace/README.md'、'workspace/AGENTS.md' 和独立 fixture Git 历史。
Manager 变更、Checklist、对话状态机、评测方案和实验 metadata 都在 workspace 外，不能在
开发回合、Session Evolution 或盲审前复制或透露。

## 3. 完整 V1

- Register compatible Firmware Images and create one-wave Campaigns from an immutable Device selector.
- Deliver download, install, and verify commands in order with stable IDs and fencing tokens.
- Accept offline Device Reports in atomic ordered batches and replay duplicates safely.
- Recover Command Tasks and fail or roll back updates under the exact timeout policy.
- Expose fleet versions, device timelines, campaign progress, failures, and event deliveries in the UI.

核心状态：Device Update: WAITING -> DOWNLOADING -> INSTALLING -> VERIFYING -> SUCCEEDED, any active state -> FAILED -> ROLLED_BACK, or WAITING -> CANCELLED; Campaign: PENDING -> RUNNING -> SUCCEEDED | FAILED, or PENDING|RUNNING -> CANCELLED.

### 可计算不变量

1. A Device executes at most one active Device Update and one current command at an instant.
2. Installed firmware changes only after a valid verify report for the exact image digest and token.
3. Device Report sequence is strictly increasing; identical duplicate batches have no second effect.
4. A Campaign target set and Firmware Image never change after creation.
5. Rollback returns to the captured prior version exactly once and cannot install an unrelated image.

## 4. Manager 固定变更

V1、真实 Browser E2E、双 API/双 Worker 并发与恢复完成后，T16 才发布
“multi-hop firmware upgrade plans”。它改变核心基数、状态或一致性边界：

- A target Firmware Image may require a Device to install 1-5 intermediate Images through declared compatibleFromVersions edges.
- At Campaign creation, compute and persist one immutable Upgrade Plan per Device: fewest hops first, then lexicographically smallest version sequence, then imageId.
- Each hop has DOWNLOAD, INSTALL, and VERIFY commands and the next hop cannot start before the prior digest verifies.
- Failure rolls back only the current hop to its captured prior Image; a successful earlier intermediate remains the starting point for an explicit retry.
- Campaign progress aggregates Devices and hop states, while maxParallel counts Devices rather than hop commands.
- Legacy direct-compatible Campaigns remain one-hop and keep prior response fields; multi-hop updates expose upgradePlan[] and currentHopIndex.

新增 wire schema：

- UpgradePlan = {deviceUpdateId:uuid,sourceVersion:string,targetVersion:string,pathDigest:sha256,currentHopIndex:int,hops:[UpgradeHop],createdAt:timestamp}
- UpgradeHop = {hopIndex:int,firmwareImageId:uuid,fromVersion:string,toVersion:string,imageDigest:sha256,state:WAITING|RUNNING|SUCCEEDED|FAILED,attempts:[UpgradeHopAttempt]}
- UpgradeHopAttempt = {attempt:int,state:DOWNLOADING|INSTALLING|VERIFYING|SUCCEEDED|FAILED|ROLLED_BACK,firstCommandSequence:int,lastCommandSequence:int|null,startedAt:timestamp,completedAt:timestamp|null}

新增或变更的公开接口：

- POST /api/v1/firmware-campaigns computes every target Device UpgradePlan in the creation transaction using fewest hops, then lexicographically smallest version sequence, then imageId sequence; if any target has no path of 1..5 hops, no Campaign, Device Update, command, or event is created.
- pathDigest is SHA-256 of RFC 8785 {deviceId,sourceVersion,targetVersion,imageIds:[uuid]} for the selected ordered path.
- GET /api/v1/device-updates/:deviceUpdateId/upgrade-plan returns the immutable UpgradePlan; legacy direct-compatible updates contain exactly one Hop and retain existing singular fields.
- POST /api/v1/device-updates/:deviceUpdateId/retry with {expectedCurrentHopIndex,expectedAttempt} is legal only after the current attempt failed and rolled back; it preserves successful earlier Hops and creates a new attempt with fresh tokens and continuing commandSequence values.
- Device commandSequence is global across all Hops and attempts. Poll and report APIs never reset it at a Hop boundary, and a report for a non-current Hop, attempt, command, or token cannot change installed firmware or plan state.

新增稳定错误：

- 409 UPGRADE_PATH_UNAVAILABLE: a target Device has no deterministic path to the target Image within five hops
- 409 UPGRADE_HOP_NOT_CURRENT: the command or report references another Hop or attempt
- 409 DEVICE_UPDATE_NOT_RETRYABLE: the current Hop lacks a completed failed rollback or expected attempt is stale

跨层规则：

- The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
- The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
- Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
- Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

FINAL snapshot 与性能兼容合同：

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

迁移必须同时满足：

- Migrate every V1 Campaign and Device Update to a one-hop Upgrade Plan without changing commands, tokens, reports, versions, or events.
- In-flight Command Tasks retain their sequence and retry identity.
- Previously completed Campaigns remain terminal and never trigger migration-time commands.

T16 只要求影响分析和分阶段修改计划，不允许立即实现。T17-T20 才依次处理迁移、后端、
API、UI、并发和恢复回归。

## 5. 评分结构

| Dimension | Weight |
| --- | ---: |
| Clean build, migration, seed, and operation | 5 |
| Contract, validation, and seed semantics | 5 |
| Complete V1 main flow | 10 |
| Atomicity and durable idempotency | 10 |
| Worker, outbox, and crash recovery | 15 |
| Multi-process consistency | 10 |
| Manager-compatible migration | 15 |
| Manager runtime, UI, and concurrency | 10 |
| Project-owned real tests | 8 |
| Sustained performance plus post-load correctness | 7 |
| Persona-fit explanation | 2 |
| Evidence and handoff | 3 |
| **Total** | **100** |

普通 CRUD 和页面数量不构成主要分值。并发、恢复、幂等、兼容迁移和负载后不变量失败会
触发对应高权重项失分；正式 hard cap 方案见 evaluator 文档。

## 6. 当前完成度

当前为 **D1 设计完成**：公开合同、固定 Manager 正文、22 阶段 Dialogue、100 分 Checklist、
环境设计、独立 fixture commit 和 H-01 至 H-13 黑盒方案已完成。当前**没有 hidden runner**、
'score-manifest.v1.json'、gold、mutant、逐题 project smoke 或 baseline，因此不能声称 D2/D3/D4/D5，
也不能把候选项目自己的 'test:all' 当作正式得分。

## 7. D2 以后仍需完成

- 验证共享 environment profile，并完成当前 task 的真实 project smoke；
- 实现 Harness-owned H-01 至 H-13 runner、中央 score manifest 和 Checklist 'testGates'；
- 冻结 V1/FINAL 双快照并接线 paired scripted curriculum；
- 用 gold、定向 mutants、重复 Control baseline 和 flake run 校准阈值。
