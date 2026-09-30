# CreatorRightsExchange 任务设计

CreatorRightsExchange 是四个递增复合迁移任务中的第二个。候选人从只有 `README.md` 和
`AGENTS.md` 的独立 Git workspace 开始，构建一条连贯的数字媒体商业化链路：分片上传、扫描与转码、
不可变 Edition、风险与支付不确定性、License/Entitlement、refund、royalty ledger/close，以及有序通知。

它复用 MediaDock、EntitlementHub、BillForge、FraudLens 和 NotifyRoute 的能力类型，但全部约束通过
同一个 Edition/License/Royalty lineage 连接；不能用五组无关 CRUD 通过。Dialogue 有 28 个场景、至少
32 轮、最高 80 轮，不使用 `maxVisits` 自动推进。

V1 Review 后唯一 Manager 变更增加 RightsDispute、LicenseHold 和对已结算 posting 的下一期
RoyaltyAdjustment。Harness 在固定 Manager 场景前不允许 DS 泄露这组需求。迁移必须保留 V1 media、
manifest、rights、payment、entitlement、closed digest、Event、Work 和 replay。

独立 evaluator 包含 H-01～H-23：前 13 项复用公共黑盒执行框架，H-14～H-23 在任务 adapter 内覆盖
分片完整性、pipeline fencing、Edition 不可变、checkout unknown、fraud review、royalty remainder、
notification ACK、refund fence、hold race 和 closed adjustment。H-12 强制返回六条 exact metrics。

评分通过公开 npm lifecycle、HTTP/OpenAPI、真实 PostgreSQL、生产 Chromium、进程/Barrier、Webhook、
受控 SIGKILL 和 verification snapshot 观察行为；不导入候选源码、ORM、内部模块或私有数据库表。
