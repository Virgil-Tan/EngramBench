# LaunchPass 项目设计说明

## 文件夹结构

```text
launchpass/
├── README.zh-CN.md
├── workspace/
│   ├── .git/
│   ├── README.md
│   └── AGENTS.md
├── orchestration/
│   └── user-and-manager-prompts.zh-CN.md
└── evaluator/
    └── E2E_TEST_PLAN.zh-CN.md
```

`workspace/` 是唯一交给 Codex 的目录。`orchestration/` 和 `evaluator/` 只供
Benchmark Harness 使用，不能挂载或复制进 Codex workspace。

## 1. 这个项目是做什么的

LaunchPass 是一个专门用来测试 Coding Agent 的全栈项目。项目模拟一家活动平台：
活动名额有限，用户可以先临时锁定名额，再确认购买，也可以主动释放；如果一直
没有确认，锁定会自动过期并把名额还回去。

这个题目看起来像普通的预约网站，但真正要测试的是 Codex 能否完成一整套真实开发：

- 从几乎空白的 Git 仓库开始搭建前端、后端和数据库；
- 把自然语言需求整理成稳定的模块、接口和状态；
- 正确处理幂等、并发、过期任务、应用重启和多实例运行；
- 自己实现 Unit、Integration、Browser E2E、Concurrency 和 Performance 测试；
- 在项目进行到一半时接住 Manager 提出的新需求，而不是推倒重写；
- 向一名初级工程师解释模块职责、接口和数据流，并准确汇报验证证据。

自建的 Coding Domain Benchmark 的其中一个项目

## 2. Codex 一开始能看到什么

每次实验创建一个新的 workspace 和新的 Codex session。初始 workspace 只有：

```text
/workspace/
├── .git/
├── README.md
└── AGENTS.md
```

Codex 看不到项目骨架、参考实现、评分 Checklist、隐藏测试、负载发生器或其他实验
的结果。环境只预装通用开发工具：Node.js 22、npm、PostgreSQL 16、Git 和 Chromium。

Codex 可见的完整任务说明见 [workspace/README.md](./workspace/README.md)，工作边界见
[workspace/AGENTS.md](./workspace/AGENTS.md)。`workspace/` 本身就是任务 fixture。

## 3. Codex 最终要做出什么

Codex 要从零实现一个 TypeScript 全栈应用：

- React 用户界面；
- Node.js HTTP API；
- PostgreSQL 持久化；
- 活动浏览、搜索和分页；
- 临时名额锁定；
- 确认、主动释放和自动过期；
- 用户锁定记录和订单查询；
- OpenAPI 3.1 接口契约；
- 标准化 JSON seed 导入；
- 可重复执行的完整测试命令；
- 生产构建和单进程启动命令。

同一数据库可能同时连接两个应用实例。因此，不能只在 Node.js 进程内放一个锁就
声称解决了并发问题。应用重启后，锁定、订单和过期处理也必须继续正确。

## 4. 为什么要有长交互

真实开发通常不是“用户丢下一段完整答案，Agent 一次写完”。本实验把工作分成约
22 个用户回合：先计划，再讨论职责和数据流，然后逐步实现、Review、测试和优化。

大部分回合由 DeepSeek V4 Flash 扮演初级工程师。这个用户会说“下一步完成哪个
模块”，也会问“这个模块负责什么”“一次请求怎么流动”“哪些状态可能互相竞争”。
它不会写代码、猜 bug 根因或告诉 Codex 应该使用什么锁、事务、索引和缓存。

完整角色提示和阶段剧本见
[orchestration/user-and-manager-prompts.zh-CN.md](./orchestration/user-and-manager-prompts.zh-CN.md)。

## 5. Manager 在中间加入什么功能

第 16 个阶段由 Harness 注入一条固定的 Manager 消息。Manager 提出“候补队列与
自动晋升”：

- 名额不足时，用户可以申请 1 到 4 个候补名额；
- 同一用户在同一活动只能有一个有效候补；
- 候补严格 FIFO，队首暂时无法满足时不能跳过；
- 锁定释放或过期后，系统自动把满足条件的队首晋升成新锁定；
- 晋升后的锁定有效期为 60 秒；
- 用户可以看位置、退出候补，并在前端看到晋升和倒计时；
- 两个实例同时处理释放时，同一个候补只能晋升一次，名额不能超卖。

Manager 只发布产品变更，不参与实现和调试。本轮要求 Codex 先做影响分析和修改
计划，不允许立即写代码。下一轮恢复初级工程师，由其继续逐模块推进。

选择一个 Manager 变更就足够了。一次变更已经可以观察 Codex 是否预留了合理边界、
能否迁移数据模型、更新接口和扩展测试；同时避免把首个项目膨胀成两个独立项目。

## 6. 输入为什么要规范

“接口大概能用”无法稳定评分，因此公开任务从第一天就规定：

- Codex 必须创建 `openapi.yaml`，并让实现与文档一致；
- 所有请求 ID、时间、分页、错误响应和幂等行为都有固定格式；
- Mutation 请求拒绝未知字段和错误类型，不能静默修正错误输入；
- Codex 必须实现 `npm run seed -- --file <path>`；
- seed 文件采用公开的版本化 JSON schema；
- 隐藏测试只更换数据和值，不改变公开格式或偷偷增加业务规则。

这样既能防止 evaluator 依赖 Codex 私有实现，也能阻止 Codex只针对一个固定 fixture
硬编码答案。

## 7. 测试分成哪两层

### Codex 自己必须实现的测试

项目公开要求以下命令存在并真正执行测试：

```text
npm run test:unit
npm run test:integration
npm run test:e2e
npm run test:concurrency
npm run test:all
npm run test:perf
```

Integration Test 必须连接真实 PostgreSQL 并通过真实 HTTP Server 测试。Browser E2E
必须启动 production build，通过 Chromium 操作真实页面，不能直接调用 React 组件、
数据库 repository 或后端内部函数。

### Harness 自己运行的隐藏测试

Codex session 结束并冻结最终 workspace 后，Harness 才挂载隐藏测试。隐藏测试不信任
Codex 自己的测试结果，而是从应用外部重新执行 API、浏览器、并发、多实例、重启和
性能场景。

完整用例、环境、输入数据和判定方法见
[evaluator/E2E_TEST_PLAN.zh-CN.md](./evaluator/E2E_TEST_PLAN.zh-CN.md)。

## 8. 评分如何组成

建议首版总分 100 分：

| 维度 | 分值 | 主要判定方式 |
| --- | ---: | --- |
| 安装、迁移、构建和启动 | 8 | 自动测试 |
| OpenAPI 与输入契约 | 10 | 自动契约测试 |
| 基础业务功能 | 17 | API 和 Browser E2E |
| 幂等、并发和数据一致性 | 20 | 并发、多实例和重启测试 |
| Manager 候补功能 | 15 | API、Browser E2E 和竞争测试 |
| Codex 自己实现的测试 | 10 | 命令、覆盖场景和重复执行 |
| 性能 | 15 | 独立负载发生器 |
| 架构、证据和交互质量 | 5 | 隔离的 Codex 5.6 Sol max |

如果项目不能构建或启动，总分为 0。发生超卖、重复扣减、重复恢复或重复晋升时，
性能分为 0，并把总分上限限制在 40。性能只奖励“正确而且快”的实现。

除总分外，报告还应保留每个维度的原始分数。这样即使两个结果总分相近，也能看出
差异来自正确性、适应需求、性能还是交互质量。

## 9. 谁能看到哪些信息

信息分三层，不把所有秘密都交给 DS：

1. **Codex 可见层**：README、AGENTS、已经发布的 Manager 变更和可见对话。
2. **DS 私有层**：高层需求覆盖清单和当前阶段，不包含具体隐藏输入、竞争时序、
   评分权重或 reference output。
3. **Grader 私有层**：隐藏测试代码、随机 seed、并发调度、性能负载和评分 Checklist。

如果把完整隐藏测试交给 DS，仅靠一句“不要泄露”无法建立可靠隔离。DS 只需要知道
当前公开需求是否已经被覆盖，具体怎样测试必须留在 Grader。

## 10. 一次完整运行

```text
创建干净 workspace 和 Codex session
→ DS 初级工程师要求计划和分阶段实现
→ 固定 Manager 回合发布候补需求
→ DS 初级工程师继续推进测试、性能和 handoff
→ 冻结最终 workspace
→ 同一 Codex session 运行 Frontal Session Evolution
→ 在冻结副本上运行隐藏测试
→ 独立 Codex 5.6 Sol max 盲评
→ 输出分项结果、总分和完整 user-agent transcript
```

任务 README、Manager 消息和测试要求都不应提及 Treatment、Control、Frontal、Skill
Evolution 或评分。Codex 应该把它当成普通项目完成。

## 11. 当前 Harness 还需要补什么

现有 Harness 已经支持 scene 驱动的 DS 多轮对话、私有 requirement、防泄漏检查和
同 session resume。LaunchPass 落地前还需要两项最小扩展：

1. scene 增加由 Harness 决定的 `speakerRole`，支持 `junior_engineer` 和 `manager`；
2. 第 16 阶段使用固定 Manager 文本，不让 DS 临场改写需求。

除此之外，现有“冻结产物、隐藏测试后挂载、独立 judge”的边界可以继续复用。
