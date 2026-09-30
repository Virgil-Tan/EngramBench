# SchemaHarbor Hidden Test v2 设计

## 边界与权重

- 权威：`workspace/README.md`、T16 fixed Manager message、`CONTEXT.md`；旧 E2E 只作覆盖映射。
- 22 Case，A/B/C/D/E=30/25/20/15/10，总分 100。核心 primarySkill 聚焦 S01、S04、S07、S17；独立 oracle、迁移、snapshot、性能与跨层能力只作对应 Case 的 secondarySkills；S03/S16 仅 observer。
- install/build/migrate replay/boot/health/OpenAPI parse/Chromium shell/evaluator isolation 是不计分 preflight。
- Oracle 使用 evaluator 自己的 restricted RecordSchema parser、RFC 8785/SHA-256、compatibility/dependency DAG 和版本账本；候选 canonicalDigest、findings、snapshot 不能自证。

## SPEC-GAP

- `SPEC-GAP-SH-01`：Manager 要求“member events followed by bundle.published with stable ordering”，但 V1 只保证每 aggregate sequence，未发布跨 aggregate 全序字段/查询/dispatcher 保证。A-05/C-04 断言原子存在、稳定 identity/body 与每 aggregate 顺序；跨 aggregate 先后断言 `blockedBy=SPEC-GAP-SH-01`。
- `SPEC-GAP-SH-02`：`RELEASE_BUNDLE_INCOMPATIBLE` 未明确由 async validation 的哪个 HTTP 操作返回；A-04 断言最终 REJECTED/findings/零 Publication，精确 409 触发点待补，不从实现推断。
- 其余 Case 可执行；blocked 子断言的权重不得转移。

## Worked example

Subject A head v2，Subject B head v4。Bundle 成员 A prospective v3 依赖 `BUNDLE_MEMBER B`，B prospective v5 依赖一个 published C@1；oracle 将 A/B/C 的 `{headVersion,modeRevision}` 按 subjectId 冻结，成员/依赖按 Manager 顺序 canonicalize 并算 digest。若 validation 后 B standalone 发布 v5，则 bundle publish 必须整组 STALE、A/B 均无新版本；若无变化，则 A v3、B v5、两 Draft 和 Bundle 必须一事务 PUBLISHED，不能出现半组。

## Scoring Cases

### A-01 RecordSchema canonicalDigest、dialect与依赖 DAG — 6 分
来源：README「Deterministic policy」；Fixture：object key permutations、unknown/nested values、duplicate fields、自/跨 Subject cycles、dependency order；动作：公开 draft create/read。
Oracle/Mandatory：restricted schema 精确验证，dependencies 按 subject/version，digest=SHA-256 RFC8785 `{schema,dependencies}`，合法 pins 已发布且 DAG acyclic；禁止副作用：INVALID/CYCLE 不得留 Draft/Work/Event。
归因：dimension=A；primarySkill=S01；secondarySkills=S13；feedback=A.canonical-contract；mutant=M01。

### A-02 BACKWARD/FORWARD/FULL 全历史兼容 — 6 分
来源：README compatibility deterministic policy；Fixture：required/type/add/remove 的最小边界及多版本历史；动作：create draft、drain validation。
Oracle/Mandatory：独立 compatibility interpreter 对每个 required historical version 应用发布规则，findings/state 精确且 deterministic；禁止副作用：REJECTED 不得产生 SchemaVersion/publication event。
归因：dimension=A；primarySkill=S01；secondarySkills=S13；feedback=A.compatibility-oracle；mutant=M02。

### A-03 Validation snapshot 与 standalone gapless publication — 6 分
来源：README V1 behavior/mandatory invariants/publish route；Fixture：validation 后 head、modeRevision 或 dependency head 改变；动作：publish Draft。
Oracle/Mandatory：只有 expected head/mode/digest/dependency heads 全匹配才原子分配 `head+1`；任一漂移 Draft→STALE、409 且无 version/event；禁止副作用：不得重验最新状态后偷过或产生版本缺口。
归因：dimension=A；primarySkill=S04；secondarySkills=S06；feedback=A.validation-freeze；mutant=M03。

### A-04 ReleaseBundle 创建冻结 CatalogSnapshot 与 combined DAG — 6 分
精确 409 触发子断言 blockedBy=`SPEC-GAP-SH-02`；来源：Manager rules 1–3、exact shapes/digest；Fixture：1/20/21 distinct subjects、member/external deps、cycles、incompatible member；动作：public bundle create/read/drain validation。
Oracle/Mandatory：members/drafts IDs 稳定、prospective versions、catalog entries、dependency order/canonicalDigest/findings 等于独立 oracle，整图合法才 READY；禁止副作用：非法/REJECTED 不得部分 Draft/Publication。精确 409 触发点受 SH-02 限制。
归因：dimension=A；primarySkill=S17；feedback=A.bundle-freeze；mutant=M04。

### A-05 Bundle all-or-none publish 与版本/事件闭合 — 6 分
跨 aggregate event order 子断言 blockedBy=`SPEC-GAP-SH-01`；来源：Manager rules 3–5；Fixture：worked-example、1/20 members；动作：bundle publish/read/snapshot/receiver。
Oracle/Mandatory：所有 member Draft/SchemaVersion 与 Bundle 同事务 PUBLISHED，每 Subject 恰好 next version、releaseBundleId 精确；事件均存在且 identity/body稳定；禁止副作用：不得 partial publish、gap、duplicate member event。
归因：dimension=A；primarySkill=S04；feedback=A.atomic-bundle-publication；mutant=M05。

### B-01 Standalone mutations durable replay — 5 分
来源：README「Durable idempotency」；Fixture：same key/canonical equivalent、semantic conflict、20 concurrent、shield/restart；动作：跨 API create/publish/mode change replay。
Oracle/Mandatory：method+canonical path+key 的 original status/body/IDs 保持且一个业务 effect；禁止副作用：conflict 不得改 Subject/Draft/Version/Work/Event。
归因：dimension=B；primarySkill=S04；feedback=B.idempotency；mutant=M06。

### B-02 同 Subject concurrent publish 无重复/缺口 — 5 分
来源：README mandatory invariants/SCHEMA_HEAD_CHANGED；Fixture：两个 VALID drafts 捕获同 head；动作：双 API 并发 publish。
Oracle/Mandatory：至多一个 next version，另一 Draft 按发布 stale/conflict 语义且无 Publication，history 1..N 连续；禁止副作用：不得两个同 version 或跳号。
归因：dimension=B；primarySkill=S04；feedback=B.version-contention；mutant=M03。

### B-03 Mode/head/dependency CAS 与 validation commit 竞争 — 5 分
来源：README mode revision/publish stale rules；Fixture：worker before-commit barrier 与 mode/head/dependency mutations；动作：并发 validation completion/publication changes。
Oracle/Mandatory：每次 result 绑定 captured snapshot；漂移只可 STALE/REJECTED，matching 才 VALID/PUBLISHED；禁止副作用：不得用 split reads 形成混合 snapshot 或错发 event。
归因：dimension=B；primarySkill=S04；secondarySkills=S06；feedback=B.snapshot-race；mutant=M02。

### B-04 Bundle 与 standalone publications 热点竞争 — 5 分
来源：Manager rule 4；Fixture：bundle 包含 A/B，standalone draft 竞争 A；动作：双 API concurrent publish。
Oracle/Mandatory：只接受“bundle 全成功、standalone stale”或“standalone 成功、bundle 整体 STALE”，所有 histories gapless；禁止副作用：不得 A standalone+B bundle 的 partial mix。
归因：dimension=B；primarySkill=S04；feedback=B.cross-publication-race；mutant=M05。

### B-05 Bundle create/publish replay 保存全部 member IDs — 5 分
来源：Manager create retries preserve draftId + V1 idempotency；Fixture：20-member request、unknown response/restart/semantic conflict；动作：cross-instance replay。
Oracle/Mandatory：Run/member draft/version IDs 与 original status/body 精确，单一 Bundle/effect；禁止副作用：不得重建 member IDs、重复 Work/Version/Event 或用新 shape 改旧 saved body。
归因：dimension=B；primarySkill=S04；feedback=B.bundle-idempotency；mutant=M06。

### C-01 SCHEMA_VALIDATION lease reclaim/stale fence — 5 分
来源：README Workers/barrier/recovery；Fixture：claimed/effect/before-commit、short lease、two workers；动作：SIGKILL/reclaim。
Oracle/Mandatory：Work recover、attempt/lease shape正确、old token cannot commit、one final Draft result/event；禁止副作用：不得永久 LEASED、重复 finding/event 或持事务等待 barrier。
归因：dimension=C；primarySkill=S07；feedback=C.validation-recovery；mutant=M07。

### C-02 Standalone publish unknown response 不重编号 — 5 分
来源：README durable replay/publication atomicity；Fixture：server full 201 后 shield/client loss、API kill；动作：restart/replay/read history。
Oracle/Mandatory：original version/id/body 重放，Subject head 只增加一次、sequence/event 一次；禁止副作用：不得再分配 next number 或改 saved response。
归因：dimension=C；primarySkill=S04；feedback=C.publication-response-loss；mutant=M06。

### C-03 BUNDLE_VALIDATION crash/restart 保持 snapshot/digest — 5 分
来源：Manager BUNDLE_VALIDATION/frozen catalog + README fencing；Fixture：20-member combined DAG、worker barriers；动作：kill two workers/replacements。
Oracle/Mandatory：final READY/REJECTED/findings/digest 等于 frozen independent oracle，一 Bundle one terminal Work；禁止副作用：不得 restart 后抓新 heads、重复 Draft 或 stale token commit。
归因：dimension=C；primarySkill=S07；feedback=C.bundle-recovery；mutant=M08。

### C-04 Publication event unknown ACK 与原子存在 — 5 分
跨 aggregate order 子断言 blockedBy=`SPEC-GAP-SH-01`；来源：README dispatcher + Manager event rule；Fixture：standalone/bundle success/rollback、receiver 500/ACK barrier；动作：dispatcher kill/restart。
Oracle/Mandatory：committed publication 有稳定 eventId/body、每 aggregate sequence递增，rollback无event；禁止副作用：retry不换 identity、不得丢 bundle/member event 或自造 type。
归因：dimension=C；primarySkill=S07；feedback=C.outbox；mutant=M09。

### D-01 Subject/Draft/Version/Bundle wire 与 errors — 4 分
来源：README HTTP/OpenAPI + Manager exact routes/shapes/errors；Fixture：unknown fields、bad cursor/range/dialect/deps/tenant/missing IDs；动作：仅 HTTP。
Oracle/Mandatory：exact status/body/enums/error envelope/pagination/sorts；禁止副作用：GET/拒绝零 mutation，runtime 不得接受 extra keys 或 float。
归因：dimension=D；primarySkill=S01；secondarySkills=S15；feedback=D.api-contract；mutant=M01。

### D-02 浏览器完成 V1 schema validate→diff→publish — 4 分
来源：README「Real UI」；Fixture：真实 DB/API/workers、桌面移动；动作：visible controls create Subject/Draft、observe findings/stale、publish/history/diff。
Oracle/Mandatory：canonical digest、mode/dependency/findings/version/event 与 HTTP/oracle 一致，refresh/keyboard/error/offline 可用；禁止副作用：不得 mock、client-side authority 或隐藏 STALE。
归因：dimension=D；primarySkill=S01；secondarySkills=S15；feedback=D.browser-v1；mutant=M02。

### D-03 浏览器完成 multi-subject Bundle 与 all-or-none evidence — 4 分
来源：Manager UI update；Fixture：worked-example 与 incompatible/cycle bundle；动作：visible create/progress/publish/detail。
Oracle/Mandatory：members/catalog/findings/versions/releaseBundleId 和整组 failure 可见且 refresh 保持；禁止副作用：不得显示 partial success 或由 UI 重算不同 digest。
归因：dimension=D；primarySkill=S17；secondarySkills=S15；feedback=D.browser-manager；mutant=M05。

### D-04 FINAL snapshot 同点时 Catalog closure — 3 分
来源：README V1 snapshot + Manager exact resource/Work union；Fixture：all Subject/Draft/Version/Bundle/work/event states；动作：authorized snapshot。
Oracle/Mandatory：exact keys/shapes/sorts/same asOf/Work retention/drain/recursive token omission；harness 重算 head/version/dependency/releaseBundle closure；禁止副作用：不得 multi-snapshot 拼接或泄露 key/token/path。
归因：dimension=D；primarySkill=S17；secondarySkills=S11；feedback=D.snapshot；mutant=M10。

### E-01 Populated V1→Bundle FINAL 兼容迁移 — 3 分
来源：Manager rules 6–10/compatibility；Fixture：V1 versions/digests/deps/modes/events/pending Work/saved publish replay；动作：upgrade/recover/replay。
Oracle/Mandatory：standalone SchemaVersion `releaseBundleId=null`，全部旧 identity/body/sequence/replay不变，pending按旧 snapshot完成/STALE；禁止副作用：seed schema不得新增 bundle members或补历史event。
归因：dimension=E；primarySkill=S01；secondarySkills=S02；feedback=E.compatibility；mutant=M10。

### E-02 `latest-schema-read` 固定负载 — 3 分
来源：README fixed Scenario；Fixture：perf-v1 2,000 subjects/20,000 versions；动作：64 clients、10s warmup+60s round-robin GET。
Oracle/Mandatory：`>=500/s`、p95 `<=80ms`、5xx=0，每 body subject/version同 point-in-time head；禁止副作用：不得 stale cache、缩 dataset 或计 warmup。
归因：dimension=E；primarySkill=S01；secondarySkills=S14；feedback=E.read-performance；mutant=M10。

### E-03 `schema-validation` 固定 worker 负载 — 2 分
来源：README fixed Scenario；Fixture：20 fields/two pins unique drafts；动作：64 clients、公开 timer/request。
Oracle/Mandatory：`>=50 VALID/s`、terminal queue p95 `<=2000ms`、5xx=0，REJECTED/STALE不计且每 digest/compatibility正确；禁止副作用：不得只数202或绕 worker。
归因：dimension=E；primarySkill=S07；secondarySkills=S14；feedback=E.validation-performance；mutant=M07。

### E-04 `gapless-publish` 2,000 Subjects — 2 分
来源：README fixed Scenario；Fixture：预先 VALID 的2,000 distinct-subject drafts；动作：64 clients、60s public publish。
Oracle/Mandatory：exactly 2,000 within 60s、zero conflict/5xx、每 Subject next version/no gap；禁止副作用：不得预发布、缩 workload 或跳 post-load invariants。
归因：dimension=E；primarySkill=S04；secondarySkills=S14；feedback=E.publication-performance；mutant=M03。

## Mutants

| Mutant | 领域缺陷 | 必杀 Case |
|---|---|---|
| M01 | 非 RFC8785 digest/宽松 dialect/漏 DAG cycle | A-01、D-01 |
| M02 | FULL 只验 head 或 required/type 规则错 | A-02、B-03、D-02 |
| M03 | publish 未重检 frozen snapshot/并发产生 gap | A-03、B-02、E-04 |
| M04 | bundle 动态读 catalog 或 member/draft partial create | A-04 |
| M05 | bundle publish 逐 Subject commit | A-05、B-04、D-03 |
| M06 | idempotency 在业务后保存/重试重编号 | B-01、B-05、C-02 |
| M07 | expired validation worker 可 commit | C-01、E-03 |
| M08 | bundle recovery 换 snapshot/digest 或重复 member | C-03 |
| M09 | event 非原子/ACK retry 换 identity | C-04 |
| M10 | migration/snapshot 改旧 identity、漏 closure | D-04、E-01、E-02 |

## Coverage mapping

**README / Manager → Case**

| README/Manager requirement | Cases |
|---|---|
| Dialect/canonical/compatibility/dependencies | A-01..A-03、B-02..B-03 |
| Idempotency/validation Work/events/recovery | B-01、C-01..C-04 |
| ReleaseBundle/catalog/all-or-none | A-04..A-05、B-04..B-05、C-03、D-03 |
| HTTP/UI/snapshot | D-01..D-04 |
| Migration/performance | E-01..E-04 |

**旧 H → Case**

| 旧 H family | v2 Cases |
|---|---|
| H-01 | 不计分 preflight |
| H-02..H-04 | A-01..A-03、D-01..D-02 |
| H-05..H-08 | B-01..B-03、C-01..C-02、C-04 |
| H-09 | E-01 |
| H-10..H-11 | A-04..A-05、B-04..B-05、C-03、D-03..D-04 |
| H-12 | E-02..E-04 |
| H-13 | D/项目证据，不另计分 |

## Evidence/hard caps

保存 fixture、HTTP、barrier/receiver ledger、独立 canonical/compatibility/DAG/version oracle、snapshot digest。版本 gap、published mutation、partial bundle/atomic rejection失败总分上限35；幂等第二效果上限30；stale worker可提交/Work丢失上限40；迁移改V1 identity/digest/replay/event上限35；性能后不变量失败使对应E Case为0并应用correctness cap。SH-01 blocked 子断言不得重分或从实现推断。
