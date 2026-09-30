【Product Manager · Maya】

用户反馈活动售罄后只能不断刷新。本期需要增加‘候补队列与自动晋升’，这是现有公开需求的正式增量：

1. 当剩余名额不足以创建锁定时，用户可以申请 1 到 4 个候补名额。
2. 同一用户在同一活动只能有一个 WAITING 候补申请。
3. 候补严格按照加入时间和 ID 稳定排序。队首数量暂时无法完全满足时，不能跳过队首去晋升后面更小的申请。
4. 锁定被主动释放或自动过期后，系统必须自动尝试晋升候补。每次释放容量后可以连续晋升多个队首，直到队首无法满足或没有候补。
5. 晋升会创建一个普通 PENDING 锁定。它使用 WAITLIST_HOLD_TTL_SECONDS，取值范围 1 到 3600，默认 60 秒，之后继续走现有确认、释放和过期流程。
6. 用户可以查询当前候补状态和 1-based 位置，也可以在 WAITING 时退出候补。
7. 前端必须支持加入候补、查看位置、退出，以及晋升后继续完成确认。
8. 两个应用实例可能同时处理同一次容量释放。同一候补最多晋升一次，库存不能超卖，也不能生成重复锁定。
9. 新接口固定为：POST /api/events/{eventId}/waitlist、GET /api/events/{eventId}/waitlist/{customerId}、DELETE /api/events/{eventId}/waitlist/{customerId}。
10. POST body 固定为 {"customerId":"UUID","quantity":1}，继续使用现有 JSON、错误和 Idempotency-Key 契约。quantity 必须是 1 到 4 且不能超过活动总容量。当前容量足够创建普通锁定时返回 409 CAPACITY_AVAILABLE；已有 WAITING entry 时返回 409 WAITLIST_ENTRY_EXISTS。
11. POST 成功返回 201：{"waitlistEntry":{"id":"UUID","eventId":"UUID","customerId":"UUID","quantity":1,"status":"WAITING","position":1,"joinedAt":"RFC3339 UTC","holdId":null}}。GET 使用相同 envelope；WAITING 时 position 是 1-based 且 holdId 为 null，PROMOTED 时 position 为 null 且 holdId 是新锁定 ID。DELETE 只允许退出 WAITING，成功返回 status=WITHDRAWN、position=null、holdId=null；重复操作遵守原有幂等契约。
12. 更新 README、OpenAPI、migration、Integration Test、Browser E2E、双实例并发测试和性能测试。

本轮先不要实现。请先说明它会影响哪些模块、数据模型、接口、状态、数据流、兼容性和测试，然后给出分阶段修改计划。