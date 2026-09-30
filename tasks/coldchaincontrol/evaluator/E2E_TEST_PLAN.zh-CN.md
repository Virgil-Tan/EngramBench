# ColdChainControl 独立端到端测试计划

## 黑盒边界

每个 H case 都在 fresh PostgreSQL database 中执行，使用候选项目公开的 npm lifecycle、HTTP/OpenAPI、production Chromium、独立 API/Worker/dispatcher 进程、Barrier、SIGKILL、webhook receiver 和 verification snapshot。Evaluator 不导入候选源码、不访问 ORM、私有表或内部模块。

H-09 将 T19 后冻结的 V1 workspace 以只读 `/snapshots/v1` 输入，在 V1 binary 中创建状态，再由 FINAL migration 启动并验证。Manager 合同只存在于 FINAL；V1 public workspace 与 T01～T19 transcript 中不得出现 Manager 标识。

## H-01～H-20

| Gate | 独立场景 | 关键断言 |
|---|---|---|
| H-01 | Clean lifecycle | install/build；migration 两次；空 seed 两次；坏 seed 回滚；API/Worker/dispatcher 独立启动 |
| H-02 | Contract/browser/security | OpenAPI 3.1 所有路径；production Chromium 非空；未知字段、错误 envelope、tenant isolation 与 secret redaction |
| H-03 | V1 main journey | 发布配置、分配/确认、创建/激活 Shipment、签名遥测、Worker 投影、温控异常、Audit/Event/Work |
| H-04 | Atomic rejection | 断裂路线、坏签名、重复 sequence 冲突、错误 config version；所有资源/Work/Event/Audit 不变 |
| H-05 | Durable idempotency | upstream 已提交但 client 断开、20 路 replay、semantic conflict、API restart，只有一个 Shipment |
| H-06 | Hot Device contention | 双 API 64 路乱序、重复与 identity 冲突；一个 reading identity、lastSequence 最大、projection 确定 |
| H-07 | Worker fencing | Worker claimed 后 SIGKILL；lease 到期；replacement；旧 worker 不覆盖更高 sequence/config 或 terminal state |
| H-08 | Dispatcher unknown ACK | response-received 后 SIGKILL；replacement 重发相同 event ID/body；quota 与 delivery identity 唯一 |
| H-09 | V1 → FINAL migration | 配置、key、active Shipment、乱序 reading/projection、open excursion、saved replay、pending Work、Event/Audit 全部保留；Manager resources 初始为空 |
| H-10 | Manager behavior | 有效 connected Chain 一次创建全部 Handoff；合法 attestation 推进一次；revision/Carrier 单一 |
| H-11 | Manager concurrency | 双 API 32 路 replay + accept/Recall 竞争；Worker killed/replaced；无 split responsibility、无重复 action |
| H-12 | Five sustained loads | 下列五场景 thresholds、状态分布、恢复时间和 post-load invariants 全部通过 |
| H-13 | Project gates | unit/integration/E2E/concurrency/recovery/all/perf 均存在、非 placeholder；除 perf 外 fresh install 实际运行 |
| H-14 | Credential boundary | rotate 与 ingest 竞争；revoke 后旧 key replay；invalid signature；当前 key 唯一且所有失败零副作用 |
| H-15 | Config convergence | gapless publish、20k assignment、stale/out-of-order ack、expiry、Worker kill；currentConfigVersion 单调 |
| H-16 | Late telemetry correction | 先提交高 sequence 再补低 sequence；历史 Excursion 纠正但 route/current sequence 不回退；全量重放确定 |
| H-17 | Notification control | 多 policy、租户 quota、unknown ACK、dead letter、cancel/resolve fence；稳定 payload 且无 signature/secret |
| H-18 | Responsibility handoff | disconnected/window-overlap 整批拒绝；wrong Carrier/key/revision 拒绝；合法 in-window accept 原子转移 |
| H-19 | Recall containment | 同 lot 多 Shipment + 非目标；冻结集合；kill propagate worker；每目标一个 APPLIED action；非目标不变 |
| H-20 | Cross-feature fault drill | config supersede、key revoke、乱序 telemetry、Handoff、Recall、两组进程与多次 kill；最终 Work 排空、Event 连续、责任/隔离/投影守恒 |

## H-12 五条专属压力场景

正式评分必须 `BENCH_PERF_SCALE=1`。本地缩短运行可设置 `(0,1)`，结果明确标记 `nonScoring=true`，不得用于分数。

### signed-telemetry-ingest

- Seed：100 Tenants、2,000 Devices、500 active Shipments、每 Device 一个有效 key 与已确认 config。
- 64 个 client，10 秒 warm-up、60 秒 measure，唯一签名 reading。
- 门槛：>=1,500 accepted/s，p95<=120ms，非 2xx 为 0。
- 负载后：reading、idempotency、TELEMETRY_PROJECT Work、Event 和 DEVICE Audit 精确 cardinality；secret/signature 不出 snapshot Event/Audit。

### hot-device-ordering

- 500 个 hot Device，每个 100 个唯一 sequence；20% exact duplicate，逆序/随机交错，双 API。
- 64 clients；>=900 requests/s，p95<=180ms。
- 四 Worker 排空后，每个 Device 100 个 reading、lastSequence=100；projection 与独立离线排序 oracle 一致；无重复 Event identity。

### configuration-rollout-recovery

- 20,000 Devices 与一个新 PUBLISHED ConfigRevision；为全部创建 assignment。
- 四 Worker，在 `worker.claimed` 后 kill 两个，等待 lease，再启两个 replacement。
- 60 秒内全部 DELIVERED/CONFIRMED/EXPIRED；p95 queue age<=2s；stale ack 无法降低版本；Work identity 唯一且 terminal。

### excursion-notification-recovery

- 5,000 active Shipments，三次越界后再三次恢复；每 Tenant 两 policy。
- 两 dispatcher 在收到 downstream ACK 后被杀，replacement 重发。
- 60 秒内每 Shipment 一个温控 Excursion 达 RESOLVED；每 policy/event 一个逻辑 delivery；重发 body/header 完全相同；quota 无 process-local 突发。

### recall-quarantine-convergence

- 10,000 active Shipments，2,500 属于目标 lot，500 正在多 Carrier Chain，500 位于 OFFERED Handoff。
- 64 clients 对同 Recall key replay/冲突；四 Worker 中 kill 两个；同时尝试 deliver/accept/telemetry。
- 90 秒内 Recall CONTAINED，目标集恰好 2,500 条 APPLIED QuarantineAction，非目标 0；已接力责任不 split，未接力不越 fence；旧 lease 不释放；外部通知 identity 唯一。

每条 metrics 必须包含 `scenarioId,completed,durationMs,throughput,p50,p95,p99,statuses`，恢复型场景额外包含 `recoveryMs` 和主要 invariant counts。五个 `scenarioId` 与 `contract.json` 顺序完全一致。
