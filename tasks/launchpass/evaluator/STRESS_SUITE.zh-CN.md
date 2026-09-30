# LaunchPass 29 场景压力套件

这套测试从冻结的 candidate workspace 外部运行，不修改 Codex/Terra 交付代码，也不读取
应用内部模块或业务表。每个场景使用独立容器、bridge network、PostgreSQL tmpfs、workspace
volume 和私有随机 seed。

## 场景矩阵

| 类别 | 数量 | 覆盖重点 |
| --- | ---: | --- |
| Browser E2E | 12 | 搜索、分页、hold 全生命周期、刷新、候补、FIFO、移动端和键盘操作 |
| Concurrency | 6 | 200 请求争抢、64 路幂等、终态/截止时间竞争、双实例候补晋升 |
| Recovery | 6 | SIGKILL、被动过期、跨重启幂等、seed 原子性和 10k/10k/100k 大 seed |
| Performance | 4 | 查询、写入、候补晋升、重启中的混合负载和事后不变量 |
| Audit | 1 | 1050 次随机 mutation 后通过公共 API 审计容量、history 和幂等 |

共 29 个 required case。权威定义在
`hidden/launchpass-stress/manifest.json`，机器结果由每个 case 单独写入 JSON。

## 运行

联网环境默认执行干净安装：

```sh
authbash node scripts/run-launchpass-stress.mjs \
  --snapshot runs/<run-id>/workspace \
  --run-root runs/<run-id>/launchpass-stress
```

若 registry 暂时不可达，可以显式复用同一冻结 run 已安装的 Linux arm64 依赖树；结果会记录
`dependencyTreeProvided: true`：

```sh
authbash node scripts/run-launchpass-stress.mjs \
  --snapshot runs/<run-id>/workspace \
  --dependency-tree runs/<run-id>/workspace/node_modules \
  --run-root runs/<run-id>/launchpass-stress
```

单场景诊断使用 `--cases LP-CON-04`。`--perf-scale` 只用于 evaluator 开发 smoke，正式评分
必须省略并使用 manifest 的完整并发、预热和持续时间。
