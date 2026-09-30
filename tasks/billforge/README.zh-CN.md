# BillForge 任务设计

BillForge 是新增的独立支付与账单任务，不复用其他任务的源码、数据库或运行状态。

## 评测重点

- 多租户账单、订阅变更和按比例计费；
- 税费、折扣、币种和冻结汇率；
- Provider 未知结果、重复/乱序 Webhook 和主动对账；
- 部分退款、Chargeback 与退款额度竞争；
- 双重记账、金额守恒和不可变历史；
- 月末快照、关账、Worker 崩溃恢复和 Adjustment。

## 为什么是高难度任务

它同时要求模型处理业务状态、金融账本、外部 Provider 不确定性和结算时间边界。测试结果不能
只看 HTTP 状态码，必须从公开 verification snapshot 重新计算账单余额、双重记账、退款上限、
租户隔离、事件顺序和 Work 是否排空。

## 实现边界

公开产品合同只在 `workspace/README.md`；隐藏测试只通过公开命令、HTTP/OpenAPI、Chromium、
Provider test double、Webhook receiver、barrier 和进程信号执行。真实卡号、真实支付网络、
PCI 存储和跨租户财务汇总不属于本任务。

## 当前交付状态

已完成公开 README、Agent 约束、H-01～H-13 黑盒测试计划和静态合同测试。可执行的 BillForge
Harness Adapter、固定 seed 和压力 Runner 应在合同评审通过后单独实现，避免在未确认 API 细节时
伪造运行时行为。
