# 在现有 workspace 中对齐 V2

使用现有 `scripts/run-v2.mjs`，不新增 Runner。默认 `migration-repair` 仍为历史的复制迁移；只有显式设置以下字段才会原地续跑：

```json
{
  "purpose": "migration-repair",
  "migrationMode": "in-place",
  "evolution": false,
  "sourceWorkspaces": { "coldchaincontrol": "/absolute/original/workspace" },
  "backupWorkspaces": { "coldchaincontrol": "/absolute/private-backups/coldchaincontrol-r1" }
}
```

其余账号、模型、镜像、Skill Bank、任务与实验字段沿用完整 profile。每份使用独立 V2 run ID；原来的状态、轨迹和成绩不复制进新 state，不修改旧 taskDigest 冒充同一次会话。新容器 `/workspace` **直接挂载 `sourceWorkspaces` 指定的原路径**，不建立另一份开发 workspace。

启动前，操作者必须确认旧 Runner、专属容器和任何写入该目录的模型/命令已经正常结束；不能在仍有写入者时迁移。先核对身份、路径和归属，必要时只正常结束该运行，不影响其他运行。代码本身会对备份前后逐文件校验，但这不能替代进程归属检查。

原地准备先把完整原 workspace（包括 Git/隐藏文件、依赖和符号链接）备份到指定的外部私有目录，并记录来源 digest；备份目录应保持私有，不能挂载给 Coding Agent。然后仅安装作者公开保护文件、固定 npm scripts、操作 ID 和缺失的空实现接缝。已有业务源码、`src/implementation.ts`、`src/lifecycle.ts`、现有依赖与自定义脚本保留。被替换的旧公开文件保存在 `legacy/v2-before/`，原依赖锁由模型按合并后的 package.json 更新。

准备完成后才创建新 V2 session。模型从原有代码自主审计、复用和修复，不注入业务答案或私有测试信息。公开 gate 失败继续反馈给同一模型；通过后冻结到 `awaiting_evaluation`。正式隐藏评测仍遵守 evaluator 发布状态，不把接入通过当成业务得分。

同一来源、backup 与 package digest 重试时仅校验备份并继续，不再次覆盖模型修改。已停止的 V2 workspace 可以用相同显式原地模式、新 run ID、新外部备份升级到已授权的新公开合同；记录 `sourceVersion:2`，历史冲突文件按 `legacy/v2-before/<packageDigest前16位>/` 分档。公开合同未变时拒绝重复迁移，应恢复其现有 run。不同来源/版本复用旧 backup、无完成记录的旧备份或部分准备失败会拒绝自动重装；原目录及备份都保留，绝不递归删除原 workspace。已经启动的复制迁移继续在其当前 V2 workspace 中运行，不受新增模式影响。
