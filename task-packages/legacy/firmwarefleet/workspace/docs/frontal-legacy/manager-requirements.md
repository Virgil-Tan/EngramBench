【Product Manager · Maya】

V1 已完成并通过基础验收。本期正式增加“multi-hop firmware upgrade plans”。以下业务规则、wire schema、接口和错误全部是公开增量合同。

业务规则：

1. A target Firmware Image may require a Device to install 1-5 intermediate Images through declared compatibleFromVersions edges.
2. At Campaign creation, compute and persist one immutable Upgrade Plan per Device: fewest hops first, then lexicographically smallest version sequence, then imageId.
3. Each hop has DOWNLOAD, INSTALL, and VERIFY commands and the next hop cannot start before the prior digest verifies.
4. Failure rolls back only the current hop to its captured prior Image; a successful earlier intermediate remains the starting point for an explicit retry.
5. Campaign progress aggregates Devices and hop states, while maxParallel counts Devices rather than hop commands.
6. Legacy direct-compatible Campaigns remain one-hop and keep prior response fields; multi-hop updates expose upgradePlan[] and currentHopIndex.
7. Migrate every V1 Campaign and Device Update to a one-hop Upgrade Plan without changing commands, tokens, reports, versions, or events.
8. In-flight Command Tasks retain their sequence and retry identity.
9. Previously completed Campaigns remain terminal and never trigger migration-time commands.
10. The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
11. The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
12. Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
13. Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

新增 wire schema：

- UpgradePlan = {deviceUpdateId:uuid,sourceVersion:string,targetVersion:string,pathDigest:sha256,currentHopIndex:int,hops:[UpgradeHop],createdAt:timestamp}
- UpgradeHop = {hopIndex:int,firmwareImageId:uuid,fromVersion:string,toVersion:string,imageDigest:sha256,state:WAITING|RUNNING|SUCCEEDED|FAILED,attempts:[UpgradeHopAttempt]}
- UpgradeHopAttempt = {attempt:int,state:DOWNLOADING|INSTALLING|VERIFYING|SUCCEEDED|FAILED|ROLLED_BACK,firstCommandSequence:int,lastCommandSequence:int|null,startedAt:timestamp,completedAt:timestamp|null}

新增或变更接口：

- POST /api/v1/firmware-campaigns computes every target Device UpgradePlan in the creation transaction using fewest hops, then lexicographically smallest version sequence, then imageId sequence; if any target has no path of 1..5 hops, no Campaign, Device Update, command, or event is created.
- pathDigest is SHA-256 of RFC 8785 {deviceId,sourceVersion,targetVersion,imageIds:[uuid]} for the selected ordered path.
- GET /api/v1/device-updates/:deviceUpdateId/upgrade-plan returns the immutable UpgradePlan; legacy direct-compatible updates contain exactly one Hop and retain existing singular fields.
- POST /api/v1/device-updates/:deviceUpdateId/retry with {expectedCurrentHopIndex,expectedAttempt} is legal only after the current attempt failed and rolled back; it preserves successful earlier Hops and creates a new attempt with fresh tokens and continuing commandSequence values.
- Device commandSequence is global across all Hops and attempts. Poll and report APIs never reset it at a Hop boundary, and a report for a non-current Hop, attempt, command, or token cannot change installed firmware or plan state.

新增稳定错误：

- 409 UPGRADE_PATH_UNAVAILABLE: a target Device has no deterministic path to the target Image within five hops
- 409 UPGRADE_HOP_NOT_CURRENT: the command or report references another Hop or attempt
- 409 DEVICE_UPDATE_NOT_RETRYABLE: the current Hop lacks a completed failed rollback or expected attempt is stale

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

本轮先不要实现。请先说明它会影响哪些领域关系、模块、schema、migration、接口、状态、成功与失败数据流、兼容性、Worker、事件、前端、并发、恢复和性能测试，然后给出分阶段修改计划。