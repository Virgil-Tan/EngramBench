# FlagFoundry 作者侧公开接线澄清

政策版本：`flagfoundry-public-observation-v2`。这是公开作者澄清版，保留 `flagfoundry-rollout-authority-v1` 的阶段授权规则；不是未经变化的历史版本。

## 公开依据与边界

依据完整原 README 的 ASCII 1..64、CompilationFinding、捕获 Environment schema、旧激活与 Manager 的 Outcome/Step/Event 规则。原始需求文档、历史生成提交、Seed 字段、FlagRevision 和 VerificationSnapshot 的闭合资源字段均未改动。不得使用 per-submission adapter。

- ASCII 键按 U+0000..U+007F、长度 1..64 校验，不得误用只允许可见字符的 Idempotency-Key 规则。
- `GET /api/v1/flag-revisions/:revisionId/findings` 返回完整、按 path/code 排序的 CompilationFinding 数组；拒绝结果可观察且稳定。字段定义未变。
- Admin `POST /api/v1/projects/:projectId/environments/:environment/context-schema` 接收 `{contextAttributes}`，返回 Environment；变更列表时事务性递增 schemaRevision，幂等重放不重复递增。没有新增 expectedSchemaRevision 协议。
- schema 修改不改已捕获 Snapshot 或 Compilation 输入；过时 READY 激活失败，未完成的过时编译拒绝，旧 active 保持有效。
- 新的旧式 `/activate` 保持旧响应，不创建新的 ProgressiveRollout、EvaluationOutcome 或 deadline Work。已有 RUNNING rollout 按原规则可变 STALE；历史数据和保存的重放响应不回写。
- 当前开放 Step 的错误 Snapshot Outcome 用 `409 SNAPSHOT_MISMATCH`；wrong-step 与 deadline 原错误不变。`outcomeId` 保持普通 JSON string，不加私有限长、ASCII、非空或 UUID 限制。

以上接口和说明全部写在作者 contract 中，由统一 materializer 生成给模型看的公开文档和固定传输层；这里不含隐藏 seed 内容或提交专用行为。

## 作者断言闭合

| 旧诊断 | 实际检查 |
|---|---|
| SPEC-GAP-02 / A-13 | 调用真实旧式激活并重放，比较前后 Manager 记录/Work，拒绝合成新记录 |
| SPEC-GAP-03/04 / A-14 | 错误 Snapshot 批次精确错误与全量回滚；空格、Unicode、空串及长字符串 Outcome IDs 按原 string 合同验收 |
| SPEC-GAP-05/07 / A-11、B-07 | 捕获后经公开路由修改 schema，验证拒绝、Snapshot 不变、旧 active 不变、findings 可读且稳定 |
| SPEC-GAP-06 / C-08 | 实际开始观察及推进非终局 Step，事件前后完全一致；复用旧事件名伪造事件也失败 |
| SPEC-GAP-08 / A-09 | 无规则匹配必须走百分比分配；未公开 Context 属性按既有错误拒绝 |

修正 A-07 新 Flag 没有 Active 时作者请求误用 `expectedActiveRevision:0` 为公开 nullable 协议的 `null`；B-07 在制造 stale race 前停止其已完成编译的专属 worker，避免目标被提前编译造成错误起点。

## 验证与未验证

定向命令：`node --test test/transfer-flagfoundry.test.mjs test/transfer-flagfoundry-observation.test.mjs`。

作者回归包含公共/私有 ASCII 差分、真实检查 helper 的协议模拟、错误路由/早激活/缺失 findings/部分写入/额外事件反例。协议模拟不是完整参考实现，也不证明业务提交已通过。

Release 保持 `pending_live_validation`。尚无完整业务提交通过原生 AMD64 上的 PostgreSQL、并发、SIGKILL、Chromium 与性能全量验证；不得称为 certified，不得从源码测试推导正式分数。没有修改共享 runtime，没有 materialize 运行 workspace，也没有启动模型。
