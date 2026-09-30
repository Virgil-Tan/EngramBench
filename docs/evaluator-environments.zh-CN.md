# V2 评测环境与接入验证

机器可读来源：`environments/evaluator-execution.v1.json`。本轮未改变镜像、资源限制或任务的环境选择。

| 任务 | 环境 | 特别说明 |
| --- | --- | --- |
| ColdChainControl | 原生平台 PostgreSQL 16 + Node + Chromium | 公开 Seed→凭证签名→读配置→遥测→Snapshot；未定义业务策略不能当环境失败绕过。 |
| AccessSentinel | 同上 | 公开 Seed 包含关联身份/Trust/Risk；Session→Request 的返回标识需出现在 Snapshot。FINAL 与 V1 Snapshot 集合不同。 |
| CreatorRightsExchange | 同上 | API 保留公开规定的 127.0.0.1 绑定；上传使用原始字节与 Content-Range/SHA256，不能当 JSON 字符串传输。 |

## 固定镜像

- 服务器 x64：`linux/amd64`，`sha256:7aaa489e2a3de683c9d319fcbf4209248fdc0833b070b7c07c6b2506af01d554`，使用已有 `scripts/docker-native-amd64-evaluator.mjs`。
- 本机 ARM64：`linux/arm64`，`sha256:11f0760eb37a48ffa89350710657257ff54bb46ea253bc6e83c2184afc5eebc5`，直接使用 Docker。
- 不在异构 QEMU Chromium 结果上认证服务器浏览器；不将单容器 CPU 使用误判为整机耗尽。
- 正式生命周期复用已有公共 gate/evaluator：隔离数据库、公开 Seed、生产构建/启动、真实请求、Snapshot、清理与结果记录。不要另建提交专属 Adapter。

## 2026-09-08 原生 ARM64 组件回归

使用上述固定 ARM64 镜像，新建一次性容器与 `v2_wiring_regression` 数据库，仓库只读挂载，执行 PostgreSQL `SELECT 1` 及：

```sh
FRONTAL_TEST_CHROMIUM=/usr/bin/chromium node --test \
  test/evaluator-browser-live.test.mjs \
  test/evaluator-browser-waits.test.mjs \
  test/public-superhard-chains.test.mjs
```

结果：数据库可连接，8/8 通过，容器已自动移除；未改动任何历史提交。测试中的 HTTP/数据替身只验证作者 checker/oracle，不属于提供给模型的业务脚手架。

这不是三题完整提交端到端认证，也不是服务器 AMD64 认证。真实业务缺失必须正常记失败；环境接入认证不要求提交满分。完整认证前继续保留 release 阻塞，不手改 `certified`。
