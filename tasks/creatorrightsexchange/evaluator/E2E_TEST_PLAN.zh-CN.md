# CreatorRightsExchange 独立黑盒验证计划

## 1. 边界

Evaluator 只通过候选项目公开的 npm lifecycle、HTTP/OpenAPI、生产 Chromium、真实 PostgreSQL、
`MANAGED_DATA_ROOT`、Webhook receiver、进程信号、Barrier 与 verification snapshot 观察行为。它不得
导入候选源码、ORM、内部模块、私有表或测试 helper，也不得修改候选实现。

每个 H case 使用 fresh database 和临时 managed-data root。H-09 把 T20 后冻结的 V1 workspace 只读
复制后写入 V1 状态，再由 FINAL binary 做 migration。所有进程、数据库和临时文件在 case 结束清理。

## 2. H-01～H-13 基线 gates

| ID | 独立验证内容 |
|---|---|
| H-01 | clean install/build；migration 两次；empty seed、exact replay、unknown member rollback；API/Worker/dispatcher 独立启动。 |
| H-02 | OpenAPI 3.1 覆盖 V1+Manager 全部路径；严格 404/validation；生产 React 由系统 Chromium 渲染。 |
| H-03 | Upload create→chunks→complete→CLEAN scan→frozen transcode 的公开主流程；snapshot/Work/Event 一致。 |
| H-04 | 幂等 key 内容冲突、malformed JSON、错误 chunk digest 均整笔无副作用。 |
| H-05 | API 响应丢失、20-way replay、API restart 后仍只存在一个 UploadSession 和 exact response。 |
| H-06 | 两个 API、64-way shared request 和 32-way raw chunk replay 收敛，不产生重复文件或行。 |
| H-07 | asset pipeline 在 `worker.claimed` 后 SIGKILL，lease 到期由 replacement drain，stale completion 被 fence。 |
| H-08 | dispatcher 收到成功 response 后 SIGKILL，replacement 使用相同 Event ID 和 byte-identical body 重试。 |
| H-09 | V1 populated state、pending Work、Event、media identity、saved idempotency response 经过 FINAL migration 不变。 |
| H-10 | Manager create→hold→resolve→release 完整生命周期产生公开资源、Work、Event 和 authority change。 |
| H-11 | 两 API 32-way Manager replay 与竞争只产生一个 active authority，生产 UI 仍可用。 |
| H-12 | 强制执行六条专属压力场景并返回六个 exact scenario metrics。 |
| H-13 | 项目自己的 unit/integration/e2e/concurrency/recovery/all gates 从 clean install 实际通过，脚本不是 placeholder。 |

## 3. H-14～H-23 深层组合 evaluators

### H-14 Multipart integrity

创建 UploadSession，上传一个合法 chunk，验证 exact replay，再以同 chunk number 上传不同 bytes/digest。
必须返回 `409 CHUNK_CONFLICT`，原 chunk、blob、临时文件和 Event 数量不变。随后补齐 manifest 并并发
complete，所有 response 收敛到一个 asset digest。

### H-15 Scan/transcode fencing

完成真实媒体上传，在 pipeline Worker claim 后 barrier 阻塞并 SIGKILL。lease 过期后启动两个 replacement。
最终只有一个 CLEAN ScanResult、每个 frozen profile 一个 READY Rendition；被杀 Worker 即使恢复也不能
提交 stale token。校验 media digest 与 rendition lineage。

### H-16 Edition and rights immutability

对 READY asset 创建并发布 Edition，冻结 rights revision 与 manifest digest。并发 stale publish 和随后
Work rights revision 变化都不能修改已发布 Edition、EditionAsset 或 frozen RightsSplit。3-way split 必须
精确等于 10,000 basis points。

### H-17 Checkout unknown outcome

在 API 完成 Purchase transaction 后切断客户端 response；用相同 key 重放并并发 20 次。发送 UNKNOWN、
SUCCEEDED、duplicate SUCCEEDED 和更早 FAILED provider event。最终一个 PurchaseOrder、PaymentIntent、
License、Grant 和 source posting；状态不能从 SUCCEEDED 回退。

### H-18 Fraud review lease

输入确定触发 REVIEW 的 purchase，确认支付与授权保持冻结。两个 reviewer 对同 case claim/decide，只有
有效 lease token 的一方成功。APPROVE 后允许 payment；过期/重复/BLOCK 决定不能再改变结果。规则版本、
hits、reason 与 audit 必须保持 frozen。

### H-19 Royalty conservation

以 10,001 minor units 和 3333/3333/3334 split 完成授权。creator C 得到 3,335，其余各 3,333；所有
posting debit=credit，currency 单一，source lineage 指向唯一 License。重放、refund reversal 与 period
查询都不能重新舍入或产生 orphan entry。

### H-20 Notification order and unknown ACK

完成 License grant 产生 Notification。dispatcher receiver 已接受 body 后在 response barrier SIGKILL，
replacement retry。比较 event ID、raw body、aggregate sequence，验证 byte-identical；同 aggregate 后续
消息不能越过 UNKNOWN 前序，payload 不含 risk/media/provider 私密字段。

### H-21 Refund/entitlement fence

完成 ACTIVE License 后让 64 个 entitlement reads 与 full refund/provider success 竞争。线性化点之前可
返回 true，refund commit 后所有 API 必须 false；License/Grant 只撤销一次，Refund 总额不超过 capture，
royalty reversal 精确平衡且 late event 不得恢复 access。

### H-22 Rights hold contention

FINAL 创建一个合法争议，让两 API 32-way 创建同一 scope authority，同时发起 Purchase/payment/grant。
只能有一个 ACTIVE Hold。Hold commit 后新 Purchase 被 fence，in-flight grant 停止，existing entitlement
false；release 与 refund 竞争后的状态必须属于一个合法 serial order。

### H-23 Settled adjustment immutability

先关闭包含真实 License posting 的 RoyaltyPeriod，冻结全部原 rows 和 snapshot digest。对同 originalPosting
32-way 创建 adjustment，只得到一个新 next-period balanced posting；原 entries、CLOSED period、digest、
Event 与历史 notification 逐字节不变。非法 open-period source、超额余额、currency/tenant mismatch 整笔拒绝。

## 4. H-12 六条 exact 压力场景

### `multipart-edition-pipeline`

- Fixture：240 个不同 digest 的双 chunk 媒体。
- 并发：32 upload clients、4 Workers。
- 门槛：>=20 assets/min；每个 asset 恰好一个 CLEAN result 和 frozen rendition；process RSS <768 MiB。
- 负载后：无 duplicate blob、stale completion、gap、orphan temp file 或 expired claimed Work。

### `license-checkout-uncertainty`

- 64 clients；10 秒 warmup、60 秒 measurement。
- >=150 accepted purchases/s，p95<=500ms。
- 10% 注入 response loss、UNKNOWN、duplicate/out-of-order provider events。
- 负载后每个 purchase 恰好一个 intent，最多一个 License/Grant/posting authority。

### `fraud-review-release`

- 1,000 个 frozen REVIEW purchases、64 reviewers、4 Workers。
- >=20 fenced decisions/s。
- 负载后没有 double decision、premature payment、lease bypass 或 rules-version drift。

### `entitlement-read-storm`

- Seed 20,000 ACTIVE grants；128 clients；10 秒 warmup、60 秒 measurement。
- >=2,000 checks/s，p95<=80ms；同时在第二 API 发出 revocation fences。
- 负载后任何 fence commit 之后不得出现 false allow，revision gap 为 0。

### `royalty-ledger-close`

- 100,000 balanced entries、4 Workers；close <=60s。
- 在第一个 claim 后 SIGKILL，replacement 必须只 close 一次。
- 负载后 entry count、posting balance、account totals、source lineage 和 snapshot digest 全部重算一致。

### `notification-recovery`

- 10,000 pending notifications、2 dispatchers；drain <=45s。
- 至少一次 response ACK unknown 与 dispatcher SIGKILL。
- 负载后 unique event identities=10,000、aggregate order gap=0，unknown retry body/ID 完全相同。

每个 metric 输出 `scenarioId`、fixture、concurrency、completed、duration、throughput、p50/p95/p99、status
counts、RSS 与 post-load assertion。缺少任一 exact metric 或用 placeholder script 均判 H-12 失败。

## 5. 校准

第一份 reference implementation 完成后，H-01～H-23 在同一 image/seed 上连续执行三次。至少构造以下
mutants：process-local idempotency、chunk metadata-before-rename、no lease token fence、mutable Edition
snapshot、payment predicts success、float royalty split、entitlement cache without revision、outbox ACK-before-
commit、Manager partial migration、adjustment rewrites CLOSED entries、throughput-only performance。每个 mutant
必须由预期 assertion 稳定杀死，才能冻结 evaluator 版本。
