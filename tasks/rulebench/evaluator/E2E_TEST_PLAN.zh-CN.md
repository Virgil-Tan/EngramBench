# RuleBench 隐藏端到端测试计划

Evaluator 位于候选 workspace 外，只使用公开命令、HTTP/OpenAPI、真实 Chromium、Webhook receiver、
barrier、进程信号和 verification snapshot。禁止导入候选源码、ORM、表或私有模块。每个测试使用
隔离数据库和可复现私有 seed；所有断言均来自 README 或已发布 Manager 需求。

## H-01 安装、迁移、Seed 与启动

干净 fixture 执行安装、重复 migration、build、合法 seed、同 digest replay、冲突 digest、非法规则和
跨租户引用 seed。验证整批原子回滚，API、四 Worker、Dispatcher 和 production UI 可启动并清理进程。

## H-02 OpenAPI、表达式边界、浏览器和隔离

验证全部公开路径、严格 JSON、错误 media type、深度/数量/大小、path、missing/null、整数类型、非法 op
和 executable input 拒绝。真实 Chromium 完成 version、conflict、publish、Evaluation、Explanation、
Replay 流程。两个 Tenant 的 API、UI、cursor、snapshot、Work、Event 和 facts 不得交叉泄漏。

## H-03 优先级、短路、解释和回放

构造 all/any/not/exists/in 与各比较 op，验证左到右短路、priority、terminal、last decision、tags、
matchedRuleIds 和 SKIPPED nodes。相同 version/facts 在不同 Worker、API restart 和 ReplayRun 中必须产生
相同 decision、node 顺序和 explanationDigest。

## H-04 冲突报告和原子拒绝

提交 duplicate priority/ruleId、unreachable、terminal null、invalid type/path、同优先级相同 condition
不同 decision，以及 malformed JSON 和同 key 不同 body。Publish 必须整体失败；RuleSetVersion、Rules、
ConflictReport、Work、Event、Evaluation 和 idempotency snapshot 不得出现部分副作用。报告稳定排序。

## H-05 Durable idempotency 与未知响应

在 Evaluation commit 后由 response shield 丢弃响应，再执行同 key replay、20 路并发和 API restart。
所有成功响应身份/body 一致，只有一个 Evaluation、一个 facts digest 和一组 Work。不同 canonical body
返回 IDEMPOTENCY_CONFLICT 且不覆盖原结果。

## H-06 两 API publication/evaluation 竞争

两个 API 同时 publish 同 revision、提交相同 Evaluation、提交不同 idempotency body，并让四 Worker 争抢
同 Work。只能存在一个 published revision 和一个 canonical Evaluation；ExplanationNodes ordinal 连续，
terminal 后规则全部 SKIPPED，过期 owner 不能提交。

## H-07 Evaluation 与 Replay Worker 恢复

分别在 `worker.claimed`、Explanation 写入前和 replay digest 提交前 barrier SIGKILL。lease 过期后由
替代 Worker 完成；Work 终态且唯一，Evaluation 只有一个决策，Replay MATCHED，原 Evaluation、facts 和
version 均不变。

## H-08 Outbox unknown ACK

Receiver 已收到 204 后、Dispatcher 记录 ACK 前 SIGKILL。替代 Dispatcher 重投相同 Event；Event ID、
aggregate sequence、canonical body 和签名输入相同。每个 aggregate 顺序连续，一个失败不阻塞其他，
Event 和日志不得包含 facts 或 credential。

## H-09 V1 到 Comparison migration

使用 V1 binary 创建两个 published versions、completed/pending Evaluations、ExplanationNodes、ReplayRun、
pending lease、幂等 replay 和未确认 Event，再运行 FINAL migration。所有 ID、digest、sequence、state、
lease 和 replay 必须不变；Comparison resources 初始为空，旧 Worker 不能绕过新 fencing。

## H-10 Comparison frozen corpus 和 diff

创建 baseline/candidate 与重复乱序 corpus IDs，修改当前 publication 后启动 run。验证 corpus 去重排序和
digest 已冻结，每个 Evaluation 正好一条 ComparisonResult，结果包含双方 decision/tags/explanation digest，
不改变原 Evaluation。`ComparisonResult.status` 只能是 MATCH、DIFF 或 ERROR；`resultDigest` 必须是除自身
外公开字段的 canonical JSON SHA-256。UI 的 progress 和 diff filter 与 snapshot 一致。

## H-11 start/cancel/promote 竞争与崩溃

两个 API 并发 start/cancel，Worker claim 后 SIGKILL，再用替代 Worker。Cancelled fence 阻止旧 owner 新增
result；completed run 上两个 expectedRevision promotion 只能一个成功，有 ERROR 时不得 promote。
ERROR 定义为任一侧无法产生合法确定性结果；本版本没有解释或豁免 API，所以任何 ERROR 都返回
`409 COMPARISON_HAS_ERRORS`。Migration、Event、Work、idempotency 和 publication pointer 始终一致。

## H-12 三条 RuleBench 专属持续压力

正式模式固定 4 CPU、8 GiB、PostgreSQL 16、两个 API、四 Worker 和一个 Dispatcher：

1. `evaluation-throughput`：200-rule version、200,000 mixed Evaluations、64 clients 持续 60 秒；接受
   >=600/s，p95<=250ms，unexpected 5xx=0，随后 60 秒内排空。
2. `deep-short-circuit`：5,000-rule versions，终态命中位于前 10 条，100,000 Evaluations、64 clients
   持续 60 秒；>=400/s，p95<=350ms，所有后续 rule 均 SKIPPED。
3. `comparison-recovery`：50,000 corpus，两个 claimed Worker SIGKILL，四 replacement 接管；60 秒内
   completed，每个 corpus Evaluation 正好一个 Result，无 digest drift 或重复 Event。

负载后重算 version pinning、decision/explanation determinism、replay equality、Comparison uniqueness、
Work/Event order、租户隔离，并记录 p50/p95/p99、throughput、状态、RSS 和数据库增长。缩放模式仅 smoke。
Runner 以这里声明的固定 Evaluation/corpus 数量乘 `BENCH_PERF_SCALE`，指标报告公开基准量、scale 与实际量；
正式评分固定 scale=1。任何非 2xx 接受响应都失败，不能用快速错误响应伪造吞吐。

## H-13 项目自带验证

运行 unit、真实 PostgreSQL integration、production Chromium、双 API/四 Worker concurrency、
barrier/SIGKILL recovery、aggregate/invariant 和 performance 命令。拒绝 mock 数据库、jsdom、开发服务器、
文件存在检查、固定 exit 0 和不产生真实测量的占位脚本。
