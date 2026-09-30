# MediaDock 任务设计

MediaDock 是一个完全独立的文件与媒体任务，不依赖其他 Task 的源码、数据库、配置或运行状态。

## 评测重点

- 分片上传、断点续传、重复分片和 complete 竞争；
- 全文件 digest、原子组装、内容寻址和跨租户隔离；
- 病毒扫描门禁、UNKNOWN/重试和感染文件不可访问；
- 转码任务的租约、staging、原子 promotion 和 Worker 崩溃恢复；
- 短期 AccessGrant、Range 下载、撤销、过期和 token 零泄漏；
- orphan part、过期 upload、感染对象和无引用 rendition 的安全清理；
- Manager 中途新增的稳定 MediaAlias 与原子 Publication revision 切换。

## 难度来源

HTTP 成功并不代表文件正确。测试会在 part 写入、complete、扫描、转码 promotion、临时 URL 下载和
cleanup mark/sweep 的不同边界杀死进程，并从公开 snapshot、真实下载字节和受控数据目录重新验证 digest、
引用关系、租户隔离与删除安全。系统还必须区分“Provider 可能已处理”和“本地事务尚未提交”。

## 独立性

公开合同只在 `workspace/`。Checklist、Persona、对话剧本、Manager Prompt、固定 seed、H-01～H-13
计划和可执行 Adapter 都封装在本目录；共享 Harness 只提供通用进程、HTTP、PostgreSQL、Chromium、
Barrier 与负载原语。MediaDock 未加入全局业务生成器或业务注册表。
