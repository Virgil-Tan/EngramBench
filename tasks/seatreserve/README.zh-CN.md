# SeatReserve 任务设计

SeatReserve 是一个完全独立的票务与座位预留任务，不依赖其他 Task 的源码、数据库或运行状态。

## 评测重点

- 物理座位集合的原子 Hold、数据库时间过期和安全释放；
- 多 API/Worker 并发抢同一座位且绝不超卖；
- Zone PriceVersion、生效边界、Hold 冻结报价和金额守恒；
- PaymentIntent UNKNOWN、重复/乱序 Provider receipt、主动 reconcile 和稳定 provider identity；
- Hold expiry 与 payment callback 竞争、Worker/Outbox 崩溃恢复；
- Manager 新增连续座位 Waitlist 与有时限的 SeatOffer；
- 真实 React 购票流程、完整项目测试和三条持续压力场景。

## 难度来源

系统必须在同一个数据库权威下协调稀缺座位、时间、价格和不确定支付。测试会从 snapshot 独立重算每个
Seat 的唯一 owner、Hold/Order/Payment 关系、冻结价格、Worker/Event 状态，而不是只信任 API 返回。

## 独立性

公开合同只位于 `workspace/`。Manager、Persona、Checklist、25 阶段剧本、Evaluator 和合同测试均封装
在本目录；共享 Harness 只提供无业务含义的执行原语。
