# BillForge 隐藏测试计划

这是候选工作区之外的 Harness 黑盒测试合同。测试只能使用 README 公布的命令、HTTP/OpenAPI、
Chromium、Provider test double、Webhook receiver、barrier、进程信号和 verification snapshot。
不得导入候选源码、ORM、数据库表或私有模块。

## H-01 安装、迁移、Seed 与启动

干净 checkout 执行全部公开命令；重复 migration；验证合法 seed、同 digest 重放、冲突版本和
非法成员都是原子行为；API、Worker、Dispatcher 和 UI 都能启动。

## H-02 合同和账单生成

验证 OpenAPI、稳定错误、分页、时间、金额边界、税费/折扣计算、版本选择和账单行总额。
同租户同周期并发生成只能得到一张账单。

## H-03 订阅变更与按比例计费

测试月中升级、降级、立即取消、周期末取消和同一时刻的竞争变更。验证 proration、账单周期、
价格版本和税费版本被冻结且不会重复应用优惠。

## H-04 多币种和汇率快照

验证账单币种与支付币种不同的换算，支付重试和退款继续使用原汇率快照；快照被引用后不可修改。

## H-05 PaymentIntent 幂等

对创建、确认、reconcile、退款和争议接口执行相同 key 重放、语义冲突、并发请求、响应丢失和
API 重启，验证每个业务效果最多一次。

## H-06 Provider UNKNOWN 恢复

Provider 返回 timeout 或 connection reset 后，PaymentIntent 必须进入 UNKNOWN；系统不得立即重新扣款。
通过查询或 Webhook 恢复后只能产生一次 ProviderTransaction 和一次账务过账。

## H-07 Webhook 重复与乱序

发送重复、延迟、乱序和未知 ACK 的 Provider Webhook。验证最终状态与到达顺序无关，交易号唯一，
事件和账务记录不重复。

## H-08 退款金额守恒

并发部分退款和全额退款，验证成功退款总额不超过 captured amount，失败退款不改变账本，退款重试
保持相同结果和相同退款身份。

## H-09 Chargeback 竞争

让退款、chargeback、人工 resolve 和支付 reconcile 并发发生。验证 dispute reservation、防止重复
冲销、状态转换唯一，以及所有双重记账分录平衡。

## H-10 月末快照与关账

并发创建相同租户和周期的 SettlementRun，冻结账单、支付、退款、争议和汇率输入。快照之后的新交易
不得进入当前结算；同一周期只能有一个有效 Run。

## H-11 Worker 崩溃恢复和 Adjustment

在 SNAPSHOTTING、CALCULATING、POSTING barrier 分别 SIGKILL Worker，等待 lease 过期后恢复。验证
不会重复过账；CLOSED 之后只能创建引用原分录的 Adjustment，不能直接修改历史。

## H-12 持续压力

执行三个固定场景并在压力后重新计算所有账务不变量：

1. `invoice-generation`: 100,000 客户月度账单生成，至少 250 invoice/s，p95 <= 500ms。
2. `payment-reconcile`: 20,000 个并发 PaymentIntent、重复/未知 Webhook，至少 150 mutation/s，p95 <= 600ms。
3. `settlement-recovery`: 10,000 个待结算账单，在 Worker 重启后 60 秒内完成，unexpected 5xx=0。

缩放运行只能作为 smoke，不得计为正式通过；正式运行固定 dataset、阈值和完整指标。

## H-13 项目自带验证

检查项目是否提供并实际运行 unit、真实 PostgreSQL integration、production Chromium、两 API/两
Worker concurrency、barrier/SIGKILL recovery、aggregate/ledger invariant 和 performance 命令。

每个场景最后验证：双重记账平衡、发票余额公式、退款/争议不超额、租户隔离、事件顺序、Work 排空、
幂等 replay 和没有敏感数据泄漏。
