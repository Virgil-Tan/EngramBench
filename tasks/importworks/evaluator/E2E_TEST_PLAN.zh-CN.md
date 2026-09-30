# ImportWorks H-01～H-13 黑盒测试计划

Evaluator 位于候选 workspace 外，只调用 README 公布的命令、HTTP/OpenAPI、production Chromium、
verification snapshot、本地 receiver、barrier 和进程信号。每个 Case 使用隔离数据库，不导入候选源码、
ORM、内部模块或表名。测试数据、竞争交错和 kill 时点私有，但所有产品行为与阈值均已在 README 公开。

## H-01 Clean lifecycle

从空白 checkout 安装、build、重复 migration；执行空 seed、相同 seed replay、冲突和未知成员拒绝；分别
启动 API、Worker、dispatcher 和 production UI，检查健康、退出码和子进程清理。

## H-02 Contract、浏览器与安全边界

验证 OpenAPI 3.1 覆盖全部公开路径、严格 JSON/UUID/timestamp/media type/范围错误、稳定 cursor、租户隔离，
并用系统 Chromium 操作 production build。Snapshot、错误、日志不得暴露原文件、拒绝值或私有路径。

## H-03 Resumable happy path

创建 ImportJob，倒序上传四个真实 chunk，查询缺口，重放 chunk，完成校验并提交。重新计算整文件 digest、
valid/invalid/committed row count、外部身份、findings 排序和 error report digest。

## H-04 原子拒绝

覆盖错误 chunk digest、交叠范围、缺口 complete、错误整文件 digest、非法 NDJSON、未知字段和
ALL_OR_NOTHING 校验失败。每次拒绝前后 snapshot 除时间外必须完全一致，不能残留 Work 或 Event。

## H-05 Durable idempotency

Response shield 在上游提交后断开；同 key 重试、20 路并发 replay 和 API 重启后必须返回同一身份与正文，
并只存在一个 ImportJob、chunk 集、Work 和事件序列。不同 payload 复用 key 返回 `IDEMPOTENCY_CONFLICT`。

## H-06 多实例提交竞争

两个 API 并发 complete/commit 相同导入，并让不同 ImportJob 竞争同一外部行身份。验证一个合法结果、
无重复记录、无部分替换，VALID_ROWS 与 ALL_OR_NOTHING 的计数始终守恒。

## H-07 Worker SIGKILL 恢复

在 validation、commit 和 report claimed barrier 后杀死 Worker；租约过期后启动 replacement。验证 stale
owner 不能提交，最终任务排空，每个 finding、record 和 report 只出现一次。

## H-08 Outbox unknown ACK

Receiver 收到完整事件后暂停 ACK，杀死 dispatcher，再启动 replacement。两次投递必须保持相同 Event ID、
aggregate sequence、header 和 byte-identical body，业务状态不回滚也不重复。

## H-09 V1 到 FINAL 兼容迁移

在冻结 V1 workspace 导入、校验、提交并保存 replay；切换 FINAL migration 后检查全部 ID、摘要、计数、
pending Work、Event 和 replay。历史 committed ImportJob 不得被改写为新的 Bundle 成员。

## H-10 ImportBundle 行为

创建多个已验证成员，stage 后尝试修改必须失败；publish 验证所有成员记录和事件同事务可见。
ALL_OR_NOTHING 成员存在 finding 时整个 Bundle `REJECTED` 且零成员发布。

## H-11 ImportBundle 竞争与恢复

两个 API 竞争添加成员、stage、publish，同时注入未知响应和 Worker SIGKILL。验证最多一个冻结成员集合，
没有一半发布的 Bundle，重启后 replay 稳定，production UI 仍可访问。

## H-12 三条专属持续压力场景

1. `resumable-upload`：2,000 个 1 MiB import、每个四个乱序 chunk、64 clients；吞吐 >= 40 upload/s，
   p95 <= 1,500ms，零意外 5xx，重放后 range coverage 和 digest 精确。
2. `partial-commit`：5,000 个各 100 行的 VALID_ROWS import，每个恰好 10 个无效行、32 clients；
   吞吐 >= 20 committed import/s，p95 <= 2,500ms，最终 450,000 records 和 50,000 findings。
3. `validation-recovery`：10,000 个 completed import，在两个 claimed barrier 杀死 Worker，3 秒租约后以四个
   replacement 在 120 秒内排空；不得重复 finding、record、report 或 event。

正式评分要求 `BENCH_PERF_SCALE=1`。缩放运行仅用于 smoke，不能记分。每条场景后重新计算字节覆盖、
行守恒、外部身份唯一、租户隔离、Event sequence 和 Work drain。

## H-13 Project-owned gates

静态拒绝 `true`、`exit 0`、placeholder 等脚本；从 clean install 真实运行 unit、PostgreSQL integration、
production Chromium、两 API/两 Worker concurrency、barrier/SIGKILL recovery 和 aggregate gate。

## Hard caps 与 invalid sample

无法 build/boot、越权读取、ALL_OR_NOTHING 部分提交、外部身份重复、丢失已提交记录、Bundle 部分发布、
业务无事件、拒绝有事件或迁移破坏 V1 时触发 hard cap。读取 hidden assets、硬编码 fixture、逃逸工作区或
伪造测试结果标记为 invalid sample，而不是普通失败。
