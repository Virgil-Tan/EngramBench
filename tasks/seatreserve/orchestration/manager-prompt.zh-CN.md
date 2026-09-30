# SeatReserve Manager Change

【Ticketing Manager】新增连续座位候补 `WaitlistEntry` 和临时 `SeatOffer`。本消息是这次变更的完整公开
合同；不得自行发明其他状态、字段或接口。

Entry 创建时冻结 1..8 的 `seatCount`、排序去重后的 `allowedZoneIds`、每座 `unitAmountMinor+feeMinor`
上限 `maxUnitTotalMinor`，以及未来且最长 30 天的 `expiresAt`。`WAITLIST_MATCH` Work 的 `aggregateId`
是 `waitlistEntryId`，按 `createdAt,waitlistEntryId` 处理 WAITING Entry。候选座位必须同 Event、同 Zone、
同 row 且 number 严格连续；有多个集合时按 `zoneId,row,首个 number` 升序选择。价格超过上限或集合不足
时保持 WAITING，不产生部分 Offer。

Offer 在一个事务中占有全部座位、冻结每席当前 ACTIVE PriceVersion 和金额，并使用数据库时间设置
`expiresAt = createdAt + 120 seconds`。`OFFER_EXPIRY` Work 的 `aggregateId` 是 `seatOfferId`。每个 Entry
最多一个 ACTIVE Offer，每个 Seat 在 Hold、Order、Offer 三类 owner 中最多一个 live owner。accept 只在
未过期 ACTIVE Offer 上成功，原子创建 TTL 300 秒的正常 HELD SeatHold，沿用 Offer 冻结价格并将 Entry
置为 FULFILLED；decline 将 Entry/Offer 分别置为 DECLINED 并释放座位；expiry 将 Offer 置为 EXPIRED、
Entry 恢复 WAITING（若 Entry 自身未过期），并继续匹配后续 Entry。取消将 WAITING/OFFERED Entry 置为
CANCELLED 并释放其 ACTIVE Offer。旧 lease 不能越过 Entry cancel、Offer terminal 或 expiry fence。

公开资源为：

```text
WaitlistEntry = {waitlistEntryId:uuid,tenantId:uuid,eventId:uuid,customerRef:string,seatCount:int,allowedZoneIds:[uuid],maxUnitTotalMinor:int,expiresAt:timestamp,state:WAITING|OFFERED|FULFILLED|DECLINED|CANCELLED|EXPIRED,createdAt:timestamp,cancelledAt:timestamp|null}
SeatOffer = {seatOfferId:uuid,waitlistEntryId:uuid,eventId:uuid,state:ACTIVE|ACCEPTED|DECLINED|EXPIRED,items:[{seatId:uuid,priceVersionId:uuid,unitAmountMinor:int,feeMinor:int}],totalMinor:int,currency:string,expiresAt:timestamp,createdAt:timestamp,holdId:uuid|null,terminalAt:timestamp|null}
```

公开 HTTP 合同为：

```text
POST /api/v1/waitlist-entries
  body {tenantId,eventId,customerRef,seatCount,allowedZoneIds,maxUnitTotalMinor,expiresAt}
  -> 201 WaitlistEntry
POST /api/v1/waitlist-entries/:entryId/cancel
  body {}
  -> 200 WaitlistEntry
GET  /api/v1/seat-offers/:offerId
  -> 200 SeatOffer
POST /api/v1/seat-offers/:offerId/accept
  body {}
  -> 201 {offer:SeatOffer,hold:SeatHold}
POST /api/v1/seat-offers/:offerId/decline
  body {}
  -> 200 SeatOffer
```

所有 mutation 继承 V1 `Idempotency-Key`、未知字段拒绝和稳定错误 envelope。新增且穷举的 well-formed
语义错误是：`409 WAITLIST_ENTRY_TERMINAL`、`409 SEAT_OFFER_TERMINAL`、`409 SEAT_OFFER_EXPIRED`、
`409 SEAT_OFFER_OWNERSHIP_CHANGED`、`400 WAITLIST_INVALID`、`400 INVALID_REQUEST`。不存在的 ID 返回
`404 NOT_FOUND`。

UI 必须提供候补创建/取消、Offer 倒计时、冻结价格、接受和拒绝。兼容迁移保留 V1 Seat、Hold、Order、
Payment、saved replay、pending Work 和 Event。并发释放、匹配、取消、接受、拒绝和 Worker SIGKILL 不得
重复 Offer 或超卖。本轮只做影响分析和分阶段计划，不要编码。
