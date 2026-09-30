# ImportWorks 任务设计

ImportWorks 是独立的大文件数据导入任务，从空白 Git fixture 开始实现，不复用其他任务源码或状态。

## 评测重点

- 分片上传、乱序重试、断点恢复与整文件摘要校验；
- 冻结 Schema Revision 下的流式校验和稳定错误报告；
- `ALL_OR_NOTHING` 与 `VALID_ROWS` 两种提交模式；
- 相同外部行身份的 exactly-once 发布、并发提交和 durable idempotency；
- Worker 租约、SIGKILL 恢复、事务性 outbox 与未知 ACK；
- Manager 引入跨文件 ImportBundle 原子发布及 V1 兼容迁移；
- 三条真实持续压力场景后的记录、错误、事件和 Work 一致性。

所有被测行为、接口、错误码、阈值和命令都提前写在 `workspace/README.md`。Evaluator 只使用公开边界，
不读取候选源码、ORM 或表结构。

## 完成度

本目录包含独立 fixture、机器合同、多轮剧本、H-01～H-13 可执行适配器、三条专属压力场景和静态合同测试。
