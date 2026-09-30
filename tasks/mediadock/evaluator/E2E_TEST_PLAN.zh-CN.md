# MediaDock 隐藏测试计划

这是候选工作区之外的 Harness 黑盒测试合同。测试只能使用 README 公布的命令、HTTP/OpenAPI、
Chromium、真实上传/下载字节、受控 `MANAGED_DATA_ROOT`、barrier、进程信号和 verification snapshot。
不得导入候选源码、ORM、数据库表或私有模块。

## H-01 安装、迁移、Seed 与启动

从干净 checkout 安装并执行 build、重复 migration、合法 metadata-only seed、同 digest 重放、冲突版本、
非法引用和被禁止的 path/token 字段。验证整批回滚，API、Worker、Dispatcher 与生产 UI 独立启动、退出，
所有实际字节都位于隔离的 managed root。

## H-02 OpenAPI、浏览器、下载和租户隔离

验证 OpenAPI 3.1、稳定错误、严格字段、分页和全部公开路径。真实 Chromium 创建 Upload、查看进度、Asset、
Scan、Rendition、Grant 与 Cleanup。两个 Tenant 上传相同 digest，验证 API、snapshot、UI、Grant、错误和响应
时间类别不会暴露跨租户 Asset、token、路径或物理 deduplication 事实。

## H-03 乱序分片、断点续传和主流程

上传一个 32-part 对象，随机顺序、重复部分 part，并在一半时重启 API；根据 GET manifest 只补缺失 part。
complete 后重新下载和计算 source/rendition SHA-256，验证一个 Blob、一个 Asset、一个 ScanJob、每 Profile 一个
TranscodeJob/Rendition，状态最终 READY，所有对象内容与冻结 Profile 完全一致。

## H-04 严格 Content-Range 与原子拒绝

测试越界、重叠、错误 total、错误 length、错误 part digest、错误 whole digest、超过 10,000 parts、路径型
filename、跨租户 uploadId 和 malformed body。每次失败前后比较 snapshot 与 managed-root inventory，确认没有
部分 metadata、staging promotion、Work、Event 或越界文件。

## H-05 Part、complete 和 Grant 幂等

在 part、complete 和 Grant 响应提交后主动断开连接，随后相同 key 重试、20 路并发重放并重启 API。相同
part 返回相同 manifest；不同 bytes/range 报 `UPLOAD_PART_CONFLICT`；complete 只有一个 Asset/Scan；Grant
replay 返回相同 grant/token/url，raw token 不出现在 snapshot、Event 或日志。

## H-06 多进程 complete、dedup 和转码竞争

两个 API 同时提交最后 part 和 64 路 complete；四个 Worker 同时 claim Scan/Transcode。验证一次原子 assembly、
一个 tenant-scoped Asset、每 Profile 一个 Job/Rendition、稳定 digest 和无 staging 可见。再让两个 Tenant 上传
相同 bytes，删除其中一个逻辑 Asset 后另一个仍可完整下载。

## H-07 Scan/Transcode UNKNOWN 与 SIGKILL

分别在 scan claim、scanner 可能已返回、transcode staging 写完、digest 验证后和 promotion 前 barrier SIGKILL。
等待 lease 过期并启动替代 Worker。CLEAN 最终只产生一次转换；INFECTED 永不生成 Grant/Rendition；UNKNOWN
用稳定 requestId reconcile；旧 Worker 无权 promotion；损坏输出不能进入 READY。

## H-08 Outbox 与 Cleanup 删除恢复

Dispatcher 在 receiver 204 后、记录 ACK 前 SIGKILL，验证重试 Event ID/body/aggregate sequence 不变。Cleanup
在 mark DELETING、文件删除后、数据库终态前分别 SIGKILL；替代 Worker 必须识别同一对象并完成一次语义删除，
不使用广泛目录扫描或重复 cleanup Event。

## H-09 V1 到 Manager 迁移

在 V1 创建半完成 Upload、QUARANTINED Asset、UNKNOWN Scan、RUNNING Transcode、READY Rendition、Active Grant、
CleanupRun、Pending Work 和已提交 replay，升级到 FINAL。验证所有身份、bytes、digest、lease、Event 和 replay
不变；新增 Alias 表为空；旧 Worker 不得绕过新 publication reference 检查。

## H-10 临时 URL 与 Publication Revision

验证 source/rendition full GET、HEAD、首/中/尾 Range、非法多 Range、416、ETag、Content-Length、expiry 和 revoke。
发布 Alias revision 1 后签发 Grant，再发布 revision 2；并发下载期间结果只能完整属于 revision 1 或 2，旧 Grant
仍下载 revision 1，新 Grant 只绑定 revision 2，任何响应都不能混合 digest 或 bytes。

## H-11 Concurrent publish 与 Cleanup 引用安全

两个 API 对同一 `expectedRevision` 发布不同 READY Asset，只有一个 CAS 成功且只增加一条 PublicationRevision。
并行运行 Cleanup、Grant revoke、旧 revision 过保留期和当前 revision 切换，并在 Worker claim 后 SIGKILL。验证
current、保留期 revision、Active Grant 和 live stream lease 引用的 Blob/Rendition 均不删除；真正不可达对象最终清理。

## H-12 三条专属持续压力场景

正式模式固定运行以下三个 MediaDock 场景；缩放模式只允许 smoke，不计入正式得分：

1. `multipart-ingest`：10,000 个 64 KiB 对象，每个 8 个乱序 part，64 并发并混入 10% exact replay；
   throughput >= 80 completed upload/s，p95 <= 900ms，whole/part digest 错误为 0，unexpected 5xx=0。
2. `resume-contention`：2,000 个 32-part Upload 在两个 API 间上传，随机 SIGKILL API、遗漏 25% part 后根据
   manifest 恢复，并对 complete 发起 32 路竞争；至少 40 asset/s，p95 <= 1,500ms，没有重复 Asset/Blob 引用。
3. `pipeline-cleanup-recovery`：5,000 个待扫描/转码 Asset、10% infected、2,000 个 expired Upload、1,000 个
   expired Grant；四个 Worker 中 SIGKILL 两个，替代 Worker 在 90 秒内排空 eligible Work 并完成 Cleanup，
   READY/INFECTED、Rendition、引用和实际文件 inventory 完全一致。

压力后重新读取所有可访问 bytes 并校验 digest；验证 part coverage、Job/Rendition 唯一性、扫描门禁、Grant
expiry/revoke、Publication 引用、Cleanup candidates、Work 排空、Event 顺序、租户隔离、RSS、磁盘占用和无路径/token 泄漏。

## H-13 项目自带验证

检查并实际运行 unit、真实 PostgreSQL 与 managed-filesystem integration、production Chromium、双 API/四 Worker
concurrency、barrier/SIGKILL recovery、byte/digest/reference invariant 和 performance 命令。拒绝总是通过、只检查
文件存在、mock database/filesystem、开发服务器替代 production build 或没有真实字节和负载指标的占位脚本。
