# CreatorRightsExchange Hidden Test v2 详细设计

本文件遵循 [`docs/hidden-test-v2-standard.zh-CN.md`](../../../docs/hidden-test-v2-standard.zh-CN.md)，只把
CreatorRightsExchange 的公开 V1 README 与已发布 Manager 合同映射为任务专属黑盒测试。

## 1. 目标、权威来源与合同缺口

本方案定义 **54 个独立计分 case**，贯穿 upload bytes→scan/transcode→immutable Edition→risk/payment→
License/Entitlement→refund/royalty→notification，以及 FINAL dispute/hold/adjustment。测试不导入 Candidate 源码、
ORM、私有表或内部 helper；本文不实现 runner、不修改产品需求。

权威顺序：`workspace/README.md` → 固定 RightsDispute/LicenseHold/RoyaltyAdjustment Manager 消息 →
`workspace/AGENTS.md` → `CONTEXT.md`。现有 E2E 计划只提供历史映射。

`SPEC-GAP-01`：Upload complete 创建 BlobObject 与 ScanJob，但 README 没有发布 `Asset` resource shape、创建响应
中 assetId 的精确位置，也没有把 assets 加入 seed/snapshot resources。Evaluator 可使用公开 response/后续
`GET /assets/:assetId` 暴露的 opaque ID 驱动流程，验证 bytes/blob/rendition lineage；不得规定未发布 Asset 字段。

`SPEC-GAP-02`：ProviderEvent request 没有 `sequence` 字段，但文字说状态“monotonic by provider sequence”。在合同
修订前不得以未发布 sequence 排序；只验证 providerEventId exact replay/conflict、SUCCEEDED authority 不被后到
UNKNOWN/FAILED 撤销，以及 occurredAt 本身不授权回退。

`SPEC-GAP-03`：Manager 要求 adjustment 新 RoyaltyEntries 关联 original posting，但 V1 `RoyaltyEntry.sourceType` 仅
`LICENSE|REFUND`，没有发布 adjustment entry 的新增 sourceType/wire fields。测试验证 RoyaltyAdjustment 公开 response、
新 posting 平衡/金额/冻结 rights 分配与原 period 不变，不发明新 enum/entry 字段。

## 2. 公共 seams 与隔离

| Seam | 允许操作 | 禁止操作 |
| --- | --- | --- |
| Public commands | 公开 migrate/seed/build/start/test commands | 私有入口、source import |
| HTTP/OpenAPI | `/openapi.json`、所有公开 `/api/v1` routes 与 `/` production UI | 未发布 debug route、内部 provider bypass |
| Raw upload | PUT chunk 的 bytes/headers、公开 upload/detail/complete APIs | 读取 Candidate chunk metadata 表 |
| Managed bytes | Harness 自己上传 bytes，再经公开 Blob/Rendition/Edition metadata 及 snapshot 验证 | 直接读取 Candidate storage key/path |
| Verification snapshot | ADMIN_TOKEN 读取公开 resources/work/events | 直查私有 DB 表 |
| Provider/receiver doubles | 调用公开 provider event/receipt/reconcile；控制 webhook ACK | 读取 Candidate outbox/client |
| Recovery barrier | 使用公开 barrier claim/external-response/before-commit 点 | sleep 猜窗口 |
| Production browser | 系统 Chromium + production UI visible controls | 内部 store/function injection |
| Process boundary | 两 API、多 Workers/Dispatchers、真实 signals/restarts | 同进程对象模拟 |
| V1→FINAL checkpoint | 冻结 V1 binary+media root 生成状态，FINAL 原地升级 | FINAL 伪造 V1 |

除 migration case 外，每 case 使用 fresh DB、ports、`MANAGED_DATA_ROOT`、receiver、barrier 与 browser context。
结果统一为 `caseId,dimension,weight,status,durationMs,evidenceDigest,privateFailureCode,publicFeedbackCategory`，Candidate failure 与
`evaluator_error` 分离。

## 3. Deterministic fixtures 与独立 oracle

私有 `evaluationSeed + caseId + ordinal` 决定 UUID、bytes、chunk boundaries、rights shares、money、provider IDs、
release schedule；时间从可观察 DB 基准 `T0` 派生。Fixture families：`F-EMPTY`、`F-UPLOAD`、`F-PIPELINE`、
`F-EDITION`、`F-PURCHASE`、`F-REVIEW`、`F-REFUND`、`F-ROYALTY`、`F-NOTIFICATION`、`F-DISPUTE`、
`F-IDEMPOTENCY`、`F-WORK`、`F-MIGRATION`、`F-BROWSER`、`F-PERF`。

独立 oracle 计算：

- raw chunk range/size/SHA-256、whole-object stream digest、COPY/PREFIX_BASE64 bytes；
- RFC8785 Edition manifest payload digest 与 immutable frozen lineage；
- fraud v1 score/recommendation；
- License/Grant/refund authority state machine；
- integer royalty remainder、posting debit=credit、period half-open membership/snapshot digest；
- per aggregate gapless Event/Notification sequence、unknown ACK identity/body；
- active Hold 与 entitlement/purchase fences、adjustment remaining amount/next-open-period balance。

Worked example：10,001 minor units 按 creatorId 排序的 shares `3333/3333/3334` 分配，floors 后剩余按 fractional
remainder DESC、creatorId ASC 分发，第三位 creator 得 3,335，其他各 3,333。它稳定捕获 float/round-to-nearest 实现。

## 4. 固定评分

| 维度 | 分值 | Cases |
| --- | ---: | ---: |
| A. 需求与公共接口覆盖 | 30 | 18 |
| B. 数据正确性、幂等与并发 | 25 | 10 |
| C. Worker、恢复与持久性 | 20 | 8 |
| D. OpenAPI、UI 与跨层闭环 | 15 | 8 |
| E. 迁移、性能与可运维性 | 10 | 10 |
| **合计** | **100** | **54** |

## 5. A — 需求与公共接口覆盖（30 分）

### A-01 Clean lifecycle and independent roles（2 分）
- **前置**：clean checkout/DB/root，无 artifacts。
- **操作**：install、migrate 两次、build；独立启动 API/Worker/Dispatcher；以 `/` UI、`/openapi.json` 和公开业务 route 验证 readiness；SIGTERM。
- **断言**：全部非交互；production UI 非空；roles 独立；无 child/file/port/DB-lock 残留。

### A-02 Repeatable migration and legal seed replay（2 分）
- **前置**：empty 与完整合法 V1 seed，含 media contentBase64。
- **操作**：seed、same version/digest replay、runtime mutation、migration/restart。
- **断言**：资源、bytes digest、Work/Event/replay/period digest 不变；safe derived paths；replay no-op。

### A-03 Atomic seed rejection and media cleanup（2 分）
- **前置**：snapshot/root baseline 与单缺陷 seeds。
- **操作**：unknown/duplicate/broken ref/cross-tenant/bad rights/money/sequence/digest/base64/size/version conflict。
- **断言**：整份非零失败；DB/snapshot/root 无 partial rows/files/temp；contentBase64/storage keys 不泄露。

### A-04 OpenAPI 3.1 complete contract（2 分）
- **前置**：V1/FINAL live APIs 与 independent schemas。
- **操作**：枚举 routes、headers、JSON/raw bodies、success/errors/provider callbacks。
- **断言**：runtime 与文档一致；closed objects、nullable/enums、Manager states/routes 可表达；SPEC-GAP 不私自补字段。

### A-05 Common validation, tenancy and errors（1.5 分）
- **前置**：两个 Tenants 的相似 resources。
- **操作**：malformed/unknown/range/bad UUID/cursor/auth、cross-tenant refs、not found、idempotency conflict。
- **断言**：published status/error envelope；foreign ID/storage/buyer/payout/SQL/path 不泄露；失败零 resource/Work/Event/file。

### A-06 Boundary values, money, rights and cursors（1.5 分）
- **前置**：边界 uploads/offers/periods/rights fixtures。
- **操作**：1/2GiB bytes、64KiB/8MiB chunk、prefix64KiB、money safe int/currency、shares、territories、cursor。
- **断言**：合法边界接受；越界 atomic reject；arrays unique/sorted；所有 money integer、period half-open。

### A-07 Creator, Work and immutable RightsSplit revisions（1.5 分）
- **前置**：Tenant、3 Creators、Work revision 0。
- **操作**：设置 10k splits、stale expectedRevision、duplicate/foreign creator、再建新 revision。
- **断言**：rows normalized creatorId ASC；sum exact10k；old revision immutable；Work current revision CAS 单调。

### A-08 Resumable upload and chunks（2.5 分）
- **前置**：active profiles 与 deterministic 1/final/multiple-chunk bytes。
- **操作**：create upload、PUT chunks out of arrival order、GET resume、exact replay/conflict、abort/expiry。
- **断言**：range/digest/number exact；same chunk replay；bad chunk no row/file；OPEN-only abort；progress survives restart。

### A-09 Completion, scan and transcode pipeline（2 分）
- **前置**：gapless upload manifest、CLEAN/EICAR bytes、COPY/PREFIX profiles。
- **操作**：complete concurrently，built-in/external scanner，run Workers，query asset/renditions。
- **断言**：one Blob/ScanJob；INFECTED no transcode；CLEAN one Work/profile；READY only when all frozen renditions verified。

### A-10 Immutable Edition publication（2 分）
- **前置**：READY lineage 与 rights revision。
- **操作**：create DRAFT、publish expected0、read detail、later rights/profile change、stale republish。
- **断言**：frozen rights/assets/digests；manifest oracle exact；revision1/PUBLISHED immutable；one `edition.published` Event。

### A-11 Offer, Purchase and deterministic fraud（2 分）
- **前置**：PUBLISHED Edition/offers 与 APPROVE/REVIEW/BLOCK risk fixtures。
- **操作**：create offers/purchases，run fraud Worker，query Purchase。
- **断言**：terms/rights/rules frozen；score thresholds exact；REVIEW one case、BLOCK no payment authority；riskContext never exposed。

### A-12 Review, payment, License and entitlement（2 分）
- **前置**：APPROVE 与 REVIEW purchases。
- **操作**：claim/decide review；provider UNKNOWN/SUCCEEDED；query License/entitlement across APIs。
- **断言**：active reviewer lease only；success creates License+Grant+posting+notifications atomically；before authority allowed=false。

### A-13 Refund and entitlement revocation（2.5 分）
- **前置**：ACTIVE License/captured price。
- **操作**：partial/full refunds、UNKNOWN/SUCCEEDED/reconcile、late events、entitlement reads。
- **断言**：cumulative nonterminal+success <= capture；partial keeps access；full revokes once；balanced exact reversal、不复活。

### A-14 Royalty ledger and period close（2 分）
- **前置**：多 currencies/owners/postings 与 boundary timestamps。
- **操作**：ledger page/totals、create/advance period、Worker close、repeat/query。
- **断言**：每 posting balanced/single currency；running totals from immutable entries；[start,end) membership；CLOSED digest immutable。

### A-15 Notifications, delivery and snapshot（1 分）
- **前置**：Edition/license/refund/period facts 与 receiver。
- **操作**：run Dispatcher、query snapshot、restart/retry deliveries。
- **断言**：facts 与 Notifications 同事务；sequence gapless；payload redacted；snapshot point-in-time/sorted/no tokens/bytes/paths。

### A-16 FINAL RightsDispute evidence and resolution（0.5 分）
- **前置**：PUBLISHED Edition、其冻结 rights revision 中 Creator、可选同 Edition License，以及 foreign/non-frozen variants。
- **操作**：用 1/20 个合法升序 opaque `evidenceRefs` 创建争议；测试 empty/duplicate/unsorted/>512-byte refs、stale edition revision、错误租户/Creator/License、duplicate OPEN；resolve CAS 为 REJECTED/UPHELD。
- **断言**：合法 response shape/evidenceRefs/revision 精确；invalid 全部零副作用；receiver 证明服务端从未抓取 opaque refs；每 `(editionId,claimantCreatorId)` 最多一个 OPEN；resolve 写 gapless Event 且不改 frozen facts。

### A-17 FINAL Hold scope selectivity and waiting payment（0.5 分）
- **前置**：OPEN/UPHELD dispute、两条同 Edition Licenses、已收款但尚未授权 Purchase 与既有 ACTIVE License。
- **操作**：创建 EDITION Hold（省略 licenseId）和 LICENSE Hold（必须指定同 Edition License）；测试错误 scope/foreign License；读取 entitlement，release 并排空 waiting payment。
- **断言**：每 scope authority 最多一个 ACTIVE；EDITION Hold 阻止新 Purchase、令 waiting Purchase 停在 `LICENSE_HELD` 且无 License/Entitlement/posting；LICENSE Hold 只影响指定 License；release 后未退款/未撤销 authority 恢复且等待支付只授权一次。

### A-18 FINAL adjustment creates target OPEN period（0.5 分）
- **前置**：CLOSED original posting 与其 Edition 冻结 RightsSplit；`targetPeriodStart` 尚无 OPEN period。
- **操作**：创建合法正/负 adjustment，再查 target period、entries、原 posting/period/digest；另测 zero/over-balance/currency/tenant/open-source invalid requests。
- **断言**：目标 OPEN period 与 adjustment posting 原子创建且 adjustment 引用它；新 entries 按原 Edition frozen split 与 deterministic remainder oracle 平衡分配；原 entries/CLOSED period/digest/notification byte-unchanged；不发明 `SPEC-GAP-03` enum/字段。

## 6. B — 数据正确性、幂等与并发（25 分）

### B-01 Chunk identity and completion contention（2.5 分）
- **前置**：two APIs、32-way same chunk、complete manifest。
- **操作**：same bytes/digest replay、changed bytes conflict、64-way complete barrier。
- **断言**：one chunk file/metadata、one assembled Blob/ScanJob/Event；conflict leaves original bytes；temp files cleaned。

### B-02 Rights/Edition immutable CAS race（2 分）
- **前置**：Work revision and DRAFT Edition。
- **操作**：concurrent rights updates/publish/profile updates across APIs。
- **断言**：one revision winner；Edition freezes one complete 10k split/assets/profile revisions；later changes cannot mutate manifest。

### B-03 Unknown-response durable replay（2 分）
- **前置**：response shield 与 representative JSON/raw mutations。
- **操作**：upstream complete 后断 client；另一 API/restart same key/request replay。
- **断言**：exact original status/body/IDs/timestamps；one effect/Work/Event/file；domain failures replay without extra effects。

### B-04 Same-key multi-API semantic convergence（2.5 分）
- **前置**：two APIs，same key same/different canonical requests。
- **操作**：20/64-way storms；JSON order variants、raw chunk variants、restart third API。
- **断言**：one authoritative result；semantic mismatch 409；tenant/method/canonical route scopes independent；process-local map 被捕获。

### B-05 Provider event authority and uncertainty（2.5 分）
- **前置**：Payment/Refund intents 与 unique providerRequestId。
- **操作**：UNKNOWN、SUCCEEDED、duplicate SUCCEEDED、later FAILED/UNKNOWN、conflicting providerEventId。
- **断言**：SUCCEEDED 不回退；one authority/result；reconcile respects same rule；不按未发布 sequence 猜排序（SPEC-GAP-02）。

### B-06 License/Grant/posting atomicity（2.5 分）
- **前置**：APPROVE+SUCCEEDED purchase，Workers/API concurrency。
- **操作**：多 Workers/reconcile/provider replay 同时尝试 grant。
- **断言**：License、Grant、balanced posting、Purchase LICENSED、Notifications/Events 全有或全无；每 purchase 至多一套。

### B-07 Refund cap and grant-revision race（3 分）
- **前置**：captured License，64 clients partial/full refund requests。
- **操作**：并发 create/provider success/reconcile/entitlement reads 两 APIs。
- **断言**：accepted cumulative <= capture；每 reversal 一次；commit fence 后所有 reads false；revision gap-free，不 double-reverse。

### B-08 Deterministic royalty remainder and close race（3 分）
- **前置**：第 3 节 worked example、multiple posting timestamps near period end。
- **操作**：concurrent grant/refund posting 与 close Worker。
- **断言**：allocation exact integer oracle；period includes exactly linearized [start,end) entries；balanced totals/digest reproducible。

### B-09 Hold/payment/refund contention（2.5 分）
- **前置**：OPEN dispute、Edition/License scopes、in-flight payment/existing grant。
- **操作**：32-way create Hold，concurrent payment success/license grant/refund/release。
- **断言**：每 scope one ACTIVE Hold；LICENSE scope 只 fence 指定 License，EDITION scope fence 全 Edition；allowed=true 与 active Hold 不同见；已收款未授权 Purchase 稳定停在 `LICENSE_HELD`；合法 serial outcome；release 仅一次恢复未退款/未撤销 authority 并至多生成一次 grant。

### B-10 Adjustment uniqueness and remaining balance（2.5 分）
- **前置**：CLOSED original posting、原 Edition frozen split、分别有/无 OPEN target period 的 fixtures、adjustable balance。
- **操作**：32-way same/different adjustment requests、over-limit/currency/tenant/open-source invalid cases。
- **断言**：unique tuple one posting；无 target period 时恰好原子创建一个 OPEN period；总 adjustment 不超余额；new entries 按 frozen split/remainder oracle 平衡；invalid zero effect；original entries/period/digest/notification byte unchanged。

## 7. C — Worker、恢复与持久性（20 分）

### C-01 Work lifecycle, leases and retention（2 分）
- **前置**：all V1/FINAL Work kinds pending/leased/terminal。
- **操作**：claim/retry/complete，snapshot observation。
- **断言**：attempt/owner/expiry/terminal consistency；bounded lease；terminal retained；usable lease token never exposed publicly。

### C-02 Scan Worker killed after claim（2.5 分）
- **前置**：uploaded asset/VIRUS_SCAN Work，claimed barrier。
- **操作**：kill A，lease expiry，two replacements，release stale A if stopped。
- **断言**：one ScanResult/verdict；stale token cannot schedule duplicate transcodes/Event；Work converges。

### C-03 Local transcode claim recovery（2.5 分）
- **前置**：CLEAN asset、COPY/PREFIX Works。
- **操作**：在 README 发布的 after-claim barrier kill 本地 COPY/PREFIX claimants，等待 lease 后由 replacements drain；不调用只适用于外部响应的 barrier 点。
- **断言**：one verified Rendition/profile revision；no orphan/temp/partial metadata；stale result rejected；READY only complete。

### C-04 Fraud/payment reconcile recovery（2.5 分）
- **前置**：APPROVE/REVIEW/UNKNOWN purchases and Work。
- **操作**：kill Worker after external response, replacement/reconcile, concurrent provider event。
- **断言**：frozen fraud result/review decision/payment authority monotonic；one License path；Work terminalizes without predicting provider success。

### C-05 Royalty period close fencing（3 分）
- **前置**：100k balanced entries、close Work。
- **操作**：A claim then kill/expire，B close，release stale A。
- **断言**：one CLOSED transition/digest；entry set/totals immutable；A cannot overwrite B or create second Notification/Event。

### C-06 Manual abort/Hold/refund fences obsolete Work（2 分）
- **前置**：OPEN upload、in-flight grant/refund、active Hold。
- **操作**：abort/revoke/Hold commit，then run old Workers across lease deadlines。
- **断言**：obsolete Work terminal/cancel or safe no-op；no media publish/License/allow after authority fence；no immortal backlog。

### C-07 Dispatcher unknown acknowledgement（3 分）
- **前置**：receiver persists complete request then pauses ACK。
- **操作**：kill Dispatcher A；B receives disconnect/500 then ACK；provider receipt/reconcile replay。
- **断言**：same stable event ID/raw body/aggregate sequence；at-least-once no loss；provider receipt dedupe；no sensitive payload。

### C-08 Aggregate order and transactional events（2.5 分）
- **前置**：multiple aggregates with 2+ Notifications/Events。
- **操作**：two Dispatchers, concurrent facts, kill/restart at response barrier。
- **断言**：business+Event+Notification atomic；rollback none；same aggregate success in sequence；different aggregates may interleave。

## 8. D — OpenAPI、UI 与跨层闭环（15 分）

### D-01 Independent OpenAPI/live traffic validation（2 分）
- **前置**：V1/FINAL APIs 与独立 schema validator。
- **操作**：每 route success/error、raw chunk headers/body、provider callbacks、Manager states。
- **断言**：live traffic 全通过；不能用 unconstrained schemas；README/OpenAPI/runtime 一致且 SPEC-GAP 不偷补。

### D-02 Browser upload-to-published-Edition（2 分）
- **前置**：production Chromium、real API/DB/Workers/root。
- **操作**：create/resume chunks、observe scan/transcode、rights history、create/publish Edition、refresh。
- **断言**：可见控件完成；progress/digests/frozen manifest 与后端一致；不隐藏 backend 缺失。

### D-03 Browser checkout-to-entitlement/refund（2 分）
- **前置**：published Edition/offer、APPROVE/REVIEW fixtures。
- **操作**：checkout、review、payment uncertainty、License/entitlement、partial/full refund。
- **断言**：async states真实；fence 后 access false；错误/retry不重复 fact；second browser/refresh 一致。

### D-04 Browser FINAL disputes/Holds/adjustments（2.5 分）
- **前置**：Edition/license/closed posting。
- **操作**：create/resolve dispute 并查看 evidenceRefs；分别 activate/release EDITION/LICENSE Holds 并观察等待支付；在无 target OPEN period 时创建 adjustment，比较原/新 posting。
- **断言**：scope-selective authority/entitlement 与 `LICENSE_HELD` 可见；target OPEN period/新 entries 可见；original CLOSED facts 不变；动态 resources/entries 不固定数量。

### D-05 Loading, empty, validation, conflict, stale, offline, permission（1.5 分）
- **前置**：transparent proxy 与各类 fixture。
- **操作**：delay/error/restart APIs，stale revision/lease，bad admin/auth/provider failures。
- **断言**：可见、可访问、可恢复；retry 无 duplicate mutation；media/risk/payout/secret/path 不在 DOM/log/bundle。

### D-06 Keyboard, labels and focus（1.5 分）
- **前置**：production UI；viewport 由 Harness 仅作执行 fixture，不作为产品要求或评分阈值。
- **操作**：纯键盘完成 upload、Edition、checkout、review/refund/hold primary flows。
- **断言**：README 已发布流程具有 visible labels/pending/status/success/error、keyboard access 与可恢复 focus；无不可达 controls。

### D-07 Project-owned tests are real（1.5 分）
- **前置**：外部 DB/process/browser/file observer。
- **操作**：逐项运行 unit/integration/e2e/concurrency/recovery/perf/all。
- **断言**：real PostgreSQL/managed files/production Chromium/2 API/2 Workers/barrier SIGKILL；无 core skip/placeholder/always-zero。

### D-08 README-to-evidence closure（2 分）
- **前置**：固定 full-lifecycle requirement ledger。
- **操作**：README→HTTP/raw bytes→OpenAPI→UI→snapshot/Work/Event/receiver→hidden evidence 映射。
- **断言**：每个适用节点实际执行且 lineage 一致；route/file/test 名/自报通过不能闭环。

## 9. E — 迁移、性能与可运维性（10 分）

### E-01 Populated V1→FINAL migration（2 分）
- **前置**：V1 media/Edition/rights/Purchase/Payment/License/Grant/royalty/CLOSED digest/Notifications/Work/replays。
- **操作**：cold stop V1，保留 DB+root；FINAL migration 两次、boot/read。
- **断言**：全部 bytes/identity/value/attempt/lease/sequence/digest/replay 不变；Manager resources initially empty；无业务副作用。

### E-02 Saved replay and Event compatibility（1 分）
- **前置**：V1 success/domain conflict/unknown response saved bodies 与 unacked Events。
- **操作**：FINAL 跨 APIs replay、Dispatcher replacement。
- **断言**：exact response bytes/status/identity；旧 Event/body/sequence 不重写；Manager fields 不倒灌旧 replay。

### E-03 Pending Work and managed bytes compatibility（1 分）
- **前置**：V1 pending/leased scan/transcode/payment/close Work、temp/ready media、unknown delivery。
- **操作**：upgrade、lease expiry、replacement drain、cold restart。
- **断言**：safe paths/digests/attempts 保持；stale token failed；只一个 final effect；无 lost/orphan media/work/delivery。

### E-04 `multipart-edition-pipeline`（1 分）
- **前置**：240 different two-chunk assets、32 clients、4 Workers。
- **操作**：complete CLEAN scan+one frozen rendition。
- **断言**：>=20 assets/min、RSS<768MiB；无 duplicate blob/result/rendition/temp/stale lease；全量 digest oracle 通过。

### E-05 `license-checkout-uncertainty`（1 分）
- **前置**：64 clients、10% unknown/duplicate/out-of-order provider events。
- **操作**：10s warm-up+60s measure。
- **断言**：>=150 accepted purchases/s、p95<=500ms；one intent、at most one License/Grant/posting authority。

### E-06 `fraud-review-release`（1 分）
- **前置**：1000 REVIEW purchases、64 reviewers、4 Workers。
- **操作**：concurrent fenced decisions。
- **断言**：>=20 decisions/s；no double decision/premature payment/lease bypass/rules drift；all terminal states oracle-valid。

### E-07 `entitlement-read-storm`（1 分）
- **前置**：20k ACTIVE grants、128 clients、two APIs。
- **操作**：10s+60s checks while committing revocations。
- **断言**：>=2000 checks/s、p95<=80ms；committed fence 后 no false allow；revision gap=0。

### E-08 `royalty-ledger-close`（1 分）
- **前置**：100k balanced entries、4 Workers。
- **操作**：kill first claimant，replacement close within60s。
- **断言**：entry count/balance/totals/source lineage/digest exact；one close、no stale overwrite。

### E-09 `notification-recovery`（0.5 分）
- **前置**：10k pending Notifications、2 Dispatchers。
- **操作**：unknown ACK+SIGKILL，drain <=45s。
- **断言**：10k unique logical IDs、aggregate gap0、retry raw body/ID identical、no sensitive data。

### E-10 Cleanup, reproducibility and log hygiene（0.5 分）
- **前置**：same seed two non-performance runs。
- **操作**：compare evidence；audit processes/ports/DB/root/tmp/logs/artifacts。
- **断言**：deterministic；无残留/污染；bytes/secrets/provider body/buyer/payout/path 不泄露；failure nonzero。

## 10. Hard caps、invalid 与 evaluator error

| 失败 | 总分上限 |
| --- | ---: |
| clean migrate/build/production boot 失败 | 25 |
| upload bytes/digest/manifest lineage 错误或 partial file authority | 35 |
| durable replay 产生第二 commercial fact | 30 |
| stale Worker 可 publish scan/rendition/License/close result | 35 |
| License/Grant/posting 非原子或 entitlement fence 后 false allow | 30 |
| Royalty posting 不平衡、CLOSED digest/history 被改 | 35 |
| Event/Notification 丢失或 retry 改 ID/body/order | 40 |
| active Hold 与 allowed=true 同时可见，或 adjustment 改原 posting | 35 |
| migration 丢 V1/media/replay/identity | 35 |
| load 后核心 invariant 失败 | 对应 case 0，并应用 correctness cap |

读取 hidden assets/seed、按 case 特判、修改 evaluator、容器逃逸或伪造 evidence 为 `invalid`。Harness 自身
PostgreSQL/Chromium/receiver/root/port/image 故障为 `evaluator_error`；Candidate crash/timeout 是普通失败。

## 11. Anti-fake-green、映射与 mutants

- bytes/digest/remainder/risk/period expected 均由独立 oracle；Candidate tests/OpenAPI 不验证自身即止；
- media flow 至少由 raw request + public metadata + snapshot/Work/Event 交叉确认；commerce flow再加 entitlement/ledger；
- recovery 必须命中公开 barrier；unknown ACK 必须 receiver 完整读 body 后；
- performance 每轮后执行全资源 cardinality、uniqueness、balance、fence、Event、temp-file audit；
- Candidate tests 仅 D-07 计真实性；所有 A/B arms 使用同一 frozen evaluator/seed/image。

每个失败断言使用确定性私有 code `CRE.<CASE_ID>.<ASSERTION_SLUG>`；公开结果只返回下表的最小
`publicFeedbackCategory`，不暴露 bytes、fixture、oracle、mutant 或隐藏时序。下表是非重叠 contract-map，展开 range
后每个 Case 恰好出现一次。

| Case range | 唯一公开合同族 | publicFeedbackCategory |
| --- | --- | --- |
| A-01～A-03 | lifecycle、migration、seed、managed bytes | `setup_migration_failure` |
| A-04～A-06 | HTTP/OpenAPI、validation、tenancy、boundaries | `public_contract_failure` |
| A-07～A-10 | RightsSplit、upload、scan/transcode、Edition lineage | `media_lineage_failure` |
| A-11～A-12 | offer、risk/review、payment、License/Entitlement | `license_flow_failure` |
| A-13～A-15 | refund、royalty period、notification V1 flow | `settlement_flow_failure` |
| A-16 | FINAL RightsDispute evidence/resolution | `dispute_contract_failure` |
| A-17 | FINAL Hold scope/waiting-payment semantics | `hold_contract_failure` |
| A-18 | FINAL adjustment/target-period/frozen-split semantics | `adjustment_contract_failure` |
| B-01～B-04 | media identity、immutable CAS、durable idempotency | `idempotency_concurrency_failure` |
| B-05～B-08 | provider authority、grant/refund/royalty concurrency | `commerce_correctness_failure` |
| B-09 | Hold/payment/refund contention | `hold_concurrency_failure` |
| B-10 | adjustment uniqueness/balance contention | `adjustment_concurrency_failure` |
| C-01 | Work lifecycle/lease contract | `work_contract_failure` |
| C-02～C-06 | Worker recovery/fencing | `worker_recovery_failure` |
| C-07～C-08 | Dispatcher/Event recovery/order | `delivery_recovery_failure` |
| D-01 | OpenAPI/live validation | `openapi_failure` |
| D-02～D-06 | production UI 与跨层流程 | `cross_layer_failure` |
| D-07～D-08 | project tests 与 evidence closure | `evidence_failure` |
| E-01～E-03 | populated V1→FINAL DB/media compatibility | `upgrade_compatibility_failure` |
| E-04～E-09 | six published performance scenarios | `performance_failure` |
| E-10 | cleanup、reproducibility、log hygiene | `operability_failure` |

| 原 Gate | v2 cases |
| --- | --- |
| H-01～H-02 | A-01～A-06、D-01、E-10 |
| H-03～H-06/H-14 | A-07～A-10、B-01～B-04 |
| H-07/H-15 | C-01～C-03 |
| H-08/H-20 | C-07、C-08 |
| H-09 | E-01～E-03 |
| H-10～H-11/H-22～H-23 | A-16～A-18、B-09、B-10、C-06、D-04 |
| H-12 | E-04～E-09 |
| H-13 | D-07、E-10 |
| H-16～H-21 | A-10～A-15、B-02/B-05～B-08、C-04/C-05/C-07/C-08 |

Calibration mutants：metadata-before-rename（A-08/B-01）、load-whole-2GiB（A-08/E-04）、process-local idempotency
（B-03/B-04）、no lease fence（C-02～C-05）、mutable Edition/rights（B-02）、payment predicts success（A-12）、
late UNKNOWN reverts success（B-05）、partial License/Grant/posting（B-06）、float royalty split（B-08）、entitlement cache
without fence（B-07/E-07）、ACK-before-persist（C-07）、Manager Hold race（B-09）、adjustment rewrites CLOSED entries
（B-10）、migration loses bytes/replay（E-01～E-03）、fake browser/tests（D-02/D-07）、throughput-only perf（E-04～E-09）。

## 12. 实施顺序与完成标准

先实现 A-01/A-03/A-08、B-01/B-03 打通 raw bytes→snapshot；再实现 C-02/C-03/C-07 的 barrier 与 receiver；
实现 A-10/A-12/B-06/B-08 的 immutable commerce oracle，并接 A-16～A-18 的 Manager oracle；接 D-01～D-04；再用真实 V1 binary+root 完成 E-01～E-03；
最后独占固定资源实现六个 E-04～E-09 场景。

正式启用要求：54 个唯一 IDs、各维精确 30/25/20/15/10、总分100、每 case 唯一 requirement mapping、SPEC-GAP
不计分、gold 全过、mutants 三次稳定命中、同 seed 非性能无 flake、public feedback 不泄露 fixture/bytes。
