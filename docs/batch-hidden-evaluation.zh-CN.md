# Learning 冻结提交的批量评测

`scripts/evaluate-frozen-batch.mjs` 对 Learning 任务的既有冻结提交并行执行
`author-validation`。它不调用模型，不修改提交，不产生正式认证分数。

准备一个 JSON 配置（路径须为实际绝对路径）：

```json
{
  "kind": "frontal-frozen-evaluation-batch",
  "schemaVersion": 1,
  "id": "my-learning-evaluation",
  "mode": "author-validation",
  "tasks": [
    {
      "id": "mediadock",
      "statePath": "/absolute/run/projects/01-mediadock/private/harness-state.json",
      "sourceRuntime": "/absolute/development-runtime"
    }
  ]
}
```

`tasks` 只能使用 `learning-tasks.json` 中不重复的 ID。不能设置整批 `baseTime`：
用例使用各自启动时的业务时钟。Transfer 单次评测见 [Evaluation](EVALUATION.md)。

在原生 Linux x64 主机上，先按[环境说明](../environments/README.md)构建并指定
评测镜像，再执行：

```sh
node scripts/evaluate-frozen-batch.mjs /absolute/batch.json
node scripts/evaluate-frozen-batch.mjs /absolute/batch.json --status
```

入口核对公开检查、冻结代码、公开合同和 runtime lock。已有完整结果经身份验证后
可复用；不完整目录拒绝覆盖。它按任务并行，题内遵守用例依赖顺序。请预留每个并行
容器需要的资源和 Docker 网络，不自动应用旧服务器的固定子网或私有路径。

结果保存在 `hidden-results/<batchId>/`。每题包含请求、启动记录、逐项证据、结果和
状态，批次包含汇总。`diagnostic`、`excluded`、`evaluator_error` 需要单列，不能算通过。
修复后补评必须显式绑定原结果、seed 和冻结提交，不能静默覆盖历史结果。
