# MediaDock Manager 固定需求

在 V1 完成并通过现有测试后，Manager 要求增加稳定 MediaAlias 和原子 Publication Revision：

1. `POST /api/v1/media-aliases` 创建 tenant-scoped 稳定 Alias，并冻结 requiredProfileIds；Alias 初始 revision 为 0、没有 current publication。
2. `POST /api/v1/media-aliases/:aliasId/publish` 必须携带 `expectedRevision` 和一个 READY、CLEAN 的 Asset；所需 Rendition 全部 READY 且 digest 已验证后才能发布。
3. Publish 在一个事务中创建不可变 PublicationRevision，并以 compare-and-swap 将 Alias 切换到新 revision；相同 expectedRevision 的并发发布只能一个成功。
4. `GET /public/media/:aliasId` 必须原子解析同一 PublicationRevision，不能混合新旧 Asset、Rendition 或 digest；下载期间切换 Alias 也不能撕裂响应。
5. 已签发 AccessGrant 永久绑定签发时的 PublicationRevision；后续 publish 不改变旧 Grant，新 Grant 只绑定新 revision。
6. Cleanup 不得删除 current revision、未过保留期的旧 revision或其 Grant 引用的任何 Blob/Rendition。过保留期后才可回收不可达旧 revision。
7. 新增 `MediaAlias`、`PublicationRevision` snapshot resource 和 `PUBLICATION_SWITCH` Work/Event；Worker 崩溃恢复不得产生半发布或重复 revision。
8. 迁移必须保留全部 V1 Upload、Asset、Blob、Scan、Transcode、Grant、Cleanup、Event、Work 和幂等 replay。
9. 更新 OpenAPI、真实发布 UI、Integration、Chromium E2E、多进程竞争和 Barrier/SIGKILL Recovery。

本消息只描述产品需求，不提供代码、SQL、命令、锁策略或 Debug 提示。
