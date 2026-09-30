# LaunchPass Integration / E2E / Concurrency / Performance 测试方案

## 1. 文档目的

这份文档定义 LaunchPass 怎样被验证。它是 Benchmark 私有设计文档，不会复制进
Codex 的 workspace。

测试分两套：

1. **Project-owned tests**：公开 README 要求 Codex 自己实现并放进项目；
2. **Harness-owned tests**：Codex session 结束并冻结 workspace 后，由 Benchmark 从
   应用外部运行的隐藏测试。

隐藏测试不会偷偷增加业务规则。它只用未公开的数据、请求顺序、并发时序、多实例、
重启和负载组合验证 README 及 Manager 已经公开的行为。

## 2. 测试环境

建议首版固定：

| 项目 | 配置 |
| --- | --- |
| OS | Linux x86_64 OCI image |
| CPU / RAM | 4 vCPU / 8 GiB |
| Node.js | 22.x，固定 patch version |
| PostgreSQL | 16.x，固定 patch version |
| Browser | 固定版本 Chromium |
| Application instances | 1 或 2，按场景决定 |
| Network | 应用运行时禁止访问外部服务 |
| Clock | VM 实时时钟，统一 UTC |

每个测试场景使用新的 PostgreSQL database 或独立 schema。测试不得复用上一场景的
业务数据。Harness 用 readiness probe 等待 `/api/health`，不把固定 sleep 当作启动成功。

环境给应用设置公开变量：

```text
DATABASE_URL
TEST_DATABASE_URL
PORT
ADMIN_TOKEN
HOLD_TTL_SECONDS
WAITLIST_HOLD_TTL_SECONDS   # 仅在 Manager 需求公开后使用
```

隐藏测试不会读取应用内部模块，也不依赖 Codex 选择的表名和 ORM。业务断言通过 HTTP、
浏览器行为和已知请求结果完成。

## 3. 冻结与挂载边界

顺序必须是：

```text
Codex 完成最后一个开发回合
→ 冻结 workspace 副本和 commit/diff
→ 停止 Agent 对 workspace 的写入
→ 将隐藏测试只读挂载到 /hidden/<test-id>
→ 在冻结副本上安装/复用依赖、迁移数据库、启动应用
→ 运行隐藏测试
```

隐藏代码、测试数据、负载文件和评分映射在冻结前绝不能存在于 `/workspace`。最终运行
Frontal Session Evolution 时也不能挂载这些材料。

## 4. Codex 必须交付的测试命令

### 4.1 Unit

```text
npm run test:unit
```

允许隔离纯逻辑，适合输入校验、状态判断和格式化。Unit Test 不能代替其他测试层。

### 4.2 Integration

```text
npm run test:integration
```

必须满足：

- 使用 `TEST_DATABASE_URL`；
- 执行真实 migrations；
- 使用真实 PostgreSQL；
- 启动真实 HTTP Server；
- 通过 HTTP 请求验证，不用 repository/service 内部调用冒充接口测试；
- 自行创建和清理隔离数据；
- 退出码准确反映结果。

### 4.3 Browser E2E

```text
npm run test:e2e
```

必须满足：

- 运行 production build；
- 连接真实 PostgreSQL 和真实 API；
- 启动真实 Chromium；
- 通过页面可见控件完成用户流程；
- 不 mock API，不直接调用 React 组件或后端函数；
- 可以无头运行；
- 单命令可重复执行。

### 4.4 Concurrency

```text
npm run test:concurrency
```

必须至少启动两个应用进程，使用不同 `PORT` 和同一个 `DATABASE_URL`，通过真实 HTTP
请求验证超卖、幂等和状态竞争。

### 4.5 Aggregate 和 Performance

```text
npm run test:all
npm run test:perf
```

`test:all` 运行 Unit、Integration、Browser E2E 和 Concurrency，不包含耗时较长的
Performance。`npm test` 是 `test:all` 的 alias。

`test:perf` 使用 production build，先预热，再输出环境、数据量、吞吐、HTTP 状态数、
p50/p95/p99 和负载结束后的业务不变量。它不能只计算假数据或调用内部函数。

## 5. 公开 Seed 输入

Project-owned 和 Harness-owned 测试都使用 README 中公开的 `seed.v1.json` schema。下面
是最小有效形状：

```json
{
  "schemaVersion": 1,
  "events": [
    {
      "id": "2fd846d8-2652-4bd2-97e7-37a863d305b6",
      "slug": "summer-launch",
      "title": "Summer Launch",
      "startsAt": "2027-06-01T09:00:00Z",
      "capacity": 100
    }
  ],
  "customers": [
    {
      "id": "2e990641-6a51-4c85-86d9-cd92d86cd935",
      "displayName": "Test Customer"
    }
  ],
  "orders": []
}
```

Harness 为每次运行生成不同 UUID、slug、title、容量、顺序和历史订单。随机 seed 记录在
私有运行 artifact 中用于复现，但不发送给 DS、Codex 或 Sol judge。

Seed 导入的历史订单没有对应 hold，API 中 `holdId` 必须为 `null`；运行时确认 hold 创建的
订单则必须返回非空 hold UUID。

Seed 测试包含：

- 最小有效文件；
- 10,000 events / 10,000 customers / 100,000 orders 的大文件；
- 未知字段、重复 ID、重复 slug、错误类型、非法 timestamp、悬空引用；
- 订单总量超过容量；
- 非空数据库导入；
- 文件中间出现错误时数据库仍然为空。

## 6. Project-owned 测试的最低用例

下面是公开验收要求。Codex 可以增加用例，但不能删除或用 mock 替代。

### 6.1 Integration 最低用例

| ID | 用例 | 最低断言 |
| --- | --- | --- |
| PI-01 | Migration + valid seed | 新数据库可迁移、导入、查询 |
| PI-02 | Invalid seed atomicity | 命令非零退出，数据库没有部分记录 |
| PI-03 | HTTP input validation | content type、JSON、schema、unknown field、cursor 错误稳定 |
| PI-04 | Create hold | 容量足够时完整成功，available 正确减少 |
| PI-05 | Insufficient capacity | 返回 409，不创建 hold，不改变 available |
| PI-06 | Idempotent retry | 相同 key 重放原结果，不重复扣减 |
| PI-07 | Idempotency conflict | 相同 key 不同请求返回 409 |
| PI-08 | Confirm hold | 只生成一个 order，重复确认不重复生成 |
| PI-09 | Release hold | 容量只恢复一次 |
| PI-10 | Expire hold | deadline 后不可确认，容量自动恢复 |
| PI-11 | Restart recovery | 重启后能读取状态并继续处理过期 |
| PI-12 | Terminal race | confirm/release/expire 最终只允许一个状态 |

Manager 需求公开后再增加：

| ID | 用例 | 最低断言 |
| --- | --- | --- |
| PI-M01 | Join/query/leave | WAITING、PROMOTED、WITHDRAWN envelope、位置和 holdId 正确 |
| PI-M02 | Duplicate waitlist | 同用户同活动只有一个 WAITING entry |
| PI-M03 | Strict FIFO | 队首不满足时不能跳过 |
| PI-M04 | Promotion | 释放/过期后生成一个普通 PENDING hold |
| PI-M05 | Promotion idempotency | 多次触发不生成重复 hold |
| PI-M06 | Join conflicts | 有足够现货、重复 entry、quantity 超过总容量时返回公开错误 |

### 6.2 Browser E2E 最低用例

| ID | 用户流程 |
| --- | --- |
| PE-01 | 活动列表 → 搜索 → 详情 → 创建 hold → 确认 → 订单历史出现订单 |
| PE-02 | 活动详情 → 创建 hold → 主动释放 → 页面显示 RELEASED 和恢复容量 |
| PE-03 | 创建短 TTL hold → 页面显示倒计时 → 自动 EXPIRED → 恢复容量 |
| PE-04 | 创建 pending hold → 整页刷新 → 继续看到服务端状态并确认 |

Manager 需求公开后再增加：

| ID | 用户流程 |
| --- | --- |
| PE-M01 | 售罄活动 → 加入候补 → 查看位置 → 退出候补 |
| PE-M02 | 两名用户排队 → 原 hold 释放 → 队首晋升 → 页面出现倒计时 → 确认 |

### 6.3 Concurrency 最低用例

| ID | 场景 | 最低断言 |
| --- | --- | --- |
| PC-01 | 两实例同时争抢少量容量 | 成功 quantity 总数不超过 capacity，available 非负 |
| PC-02 | 两实例并发发送同一 idempotent 请求 | 一个逻辑 hold、相同重放结果 |
| PC-03 | confirm 与 release 竞争 | 一个最终状态，order 数量最多一个，容量守恒 |
| PC-04 | confirm/release 与 deadline 竞争 | 任意合法赢家均可，但不能双重副作用 |
| PC-05 | 两个 expiration worker | 同一 hold 最多过期和恢复一次 |

Manager 需求公开后再增加：

| ID | 场景 | 最低断言 |
| --- | --- | --- |
| PC-M01 | 两实例同时触发候补晋升 | 每个 entry 最多晋升一次，不能超卖 |
| PC-M02 | 队首大请求、后面小请求 | 容量不够队首时后面不能跳过 |

## 7. Harness-owned 隐藏测试

隐藏测试使用另一套实现和数据，不导入 Codex 的测试模块。

### H-01 Clean install, build and boot

步骤：

1. 从冻结 workspace 准备干净依赖环境；
2. 检查精确 lockfile；
3. 运行 migrations；
4. 导入随机有效 seed；
5. 运行 production build；
6. 启动应用并轮询 health；
7. 请求浏览器入口和一个 API endpoint。

通过条件：所有命令非交互成功，health 和 UI 可访问，没有依赖开发服务器。

### H-02 OpenAPI and input conformance

步骤：读取 `openapi.yaml`，校验 OpenAPI 3.1，并针对所有公开 mutation 生成有效和无效
JSON。组合包含错误 content type、malformed JSON、missing field、unknown field、wrong type、
超界 integer、blank string、invalid UUID、invalid timestamp、invalid idempotency key 和
invalid cursor。

通过条件：实现、README、OpenAPI 的 endpoint、status、schema 和 error code 一致；错误
不泄露 stack、SQL、token、database URL 或绝对路径。

### H-03 Seed conformance and atomicity

运行最小、随机、大型和多种非法 seed。非法输入在靠近文件末尾处出现，以确认实现不是
边读边留下部分数据。

通过条件：有效文件完整导入；非法文件非零退出且无业务记录；大型文件在任务 timeout
内完成；重新读取结果与输入一致。

### H-04 Base API lifecycle

对多个随机 event/customer 执行 create hold、get、confirm、release、expire 和 history。
在每个状态后重新查询 event availability。

通过条件：状态机、响应码、历史、order 数量和容量守恒均符合公开需求。

### H-05 Browser base flows

用 Playwright 在 390x844 和 1280x800 两种 viewport 执行 PE-01 至 PE-04。测试只通过
可见 label、role 和文本寻找控件，不依赖实现私有 CSS selector。

通过条件：真实页面可完成流程；loading/error/status 可理解；键盘可以完成关键操作；
刷新后状态来自服务器。

### H-06 Contended capacity

准备一个随机小容量 event，启动两个应用实例，将 200 个不同 idempotency key、不同
customer 和 `quantity=1..4` 的请求随机分发到两个端口。TTL 设置为足够长，测试结束前
不会过期。

通过条件：成功响应的 quantity 总和不超过初始容量；失败没有创建可查询 hold；event
available 与成功总量一致；没有 5xx 和悬挂请求。

### H-07 Concurrent idempotency

向两个实例并发发送 64 份相同 create-hold 请求，然后重启其中一个实例并再次发送；
再用同一个 key 发送不同 quantity。

通过条件：所有合法重放指向同一个 hold 和同一逻辑响应；容量只减少一次；不同请求
得到 409；重启不改变结果。

### H-08 Terminal-state races

重复创建短 TTL hold，并在 deadline 附近随机并发发送 confirm 和 release。某些轮次在
请求进行时终止并重启一个实例。允许 CONFIRMED、RELEASED 或 EXPIRED 中任意一个合法
赢家。

通过条件：每轮只有一个最终状态；最多一个 order；释放或过期最多恢复一次；最终
available 与响应历史守恒。

### H-09 Passive expiration and restart

创建 hold 后停止所有业务请求，终止创建它的实例，等待 deadline，再通过另一个实例
读取 event 和 hold。

通过条件：两秒容忍窗口内 hold 为 EXPIRED，容量已恢复；不需要访问 hold 才触发正确性。

### H-10 Manager waitlist API and browser flows

Manager 需求公开后的最终版本执行 PI-M01 至 PI-M06 和 PE-M01 至 PE-M02。随机化客户、
数量和等待队列长度。

通过条件：API 契约、UI、position、withdraw、promotion、TTL 和 normal confirmation flow
全部工作。

### H-11 Strict FIFO and concurrent promotion

准备 capacity=4 的 event，用两个 quantity=2 的 hold 占满容量；按顺序加入 quantity=3
的 A 和 quantity=1 的 B。先释放一个 hold，只产生 2 个空位；随后释放另一个 hold。
两个应用实例同时观察和处理这些变化。

通过条件：第一次释放后 A 不晋升，B 不能跳过；第二次释放后 A 晋升 3 个，再由 B 晋升
1 个；A、B 各只有一个 hold；available 为 0；重复触发不会产生新 hold。

### H-12 Project-owned test quality

Harness 分别在两个新的 `TEST_DATABASE_URL` 上运行 `test:unit`、`test:integration`、
`test:e2e`、`test:concurrency` 和 `test:all`，然后再次重复运行完整 gate。

通过条件：命令真实运行、两次均通过、没有使用开发数据库、没有依赖前一次残留、没有
skip 核心场景。Sol judge 只审查测试是否真的覆盖其声明，不用测试源码代替自动结果。

### H-13 External performance

Harness 使用独立 load generator，不信任 `npm run test:perf` 报告的数字。

场景 A：10,000 events、10,000 customers、100,000 historical orders；50 并发客户端混合
执行 list、search、event detail 和 customer history。

场景 B：一个高容量 hot event；100 并发客户端跨两个实例执行 create hold、confirm、
release 和 read。请求使用随机 customer 和 idempotency key，预期 business conflict 单独
计数。

每个场景：

1. 预热 10 秒；
2. 正式运行 60 秒；
3. 运行三次；
4. 每次结束重新验证容量、hold、order 和 idempotency；
5. 使用三次中位数计分。

公开满分目标：查询 `p95 <= 250 ms`，写操作 `p95 <= 500 ms`，混合吞吐至少 150 req/s，
unexpected 5xx 为 0。任何一致性错误使性能分为 0。

Manager 功能完成后增加一个 waitlist promotion 负载回归，主要检查功能和性能没有严重
退化，不新增未公开的绝对阈值。

## 8. 等待和时间相关测试

时间测试允许状态变化存在公开的两秒容忍窗口。断言采用 bounded polling，而不是要求
某一毫秒精确完成。测试记录 VM wall clock、服务端响应 timestamp 和观察时间，失败时
可以区分业务错误与环境调度抖动。

性能测量不与数据库 migration、seed、首次 JIT、首次浏览器启动或 dependency install
混在一起。

## 9. 防投机设计

- 每次运行随机生成 UUID、slug、title、客户、容量和请求顺序；
- 同一行为用不同数据规模和排列重复验证；
- 使用两个端口和进程重启，避免 process-local 特判；
- 对成功响应做后续状态查询，不只相信 status code；
- 测试相同 input 的重放和相同 key 的不同 input；
- 在 invalid seed 的早、中、晚位置放错误；
- Browser E2E 使用语义 locator，不依赖固定 DOM 路径；
- 独立 load generator 重新计算性能指标；
- 隐藏文件只在 workspace 冻结后挂载；
- 检测 workspace 是否出现 grader 名称、私有 ID 或读取 workspace 外内容的证据。

不能因为实现采用不同目录、ORM、SQL 方案或前端组件结构而扣分。评分只针对公开行为、
项目自带测试质量和少量 Sol 判断的工程质量。

## 10. 结果格式

每个 Harness-owned test 写一个私有 JSON 结果：

```json
{
  "schemaVersion": 1,
  "testId": "H-06",
  "status": "passed",
  "durationMs": 1234,
  "assertions": {
    "passed": 12,
    "failed": 0
  },
  "metrics": {
    "successfulQuantity": 37,
    "initialCapacity": 37,
    "unexpected5xx": 0
  }
}
```

原始请求、数据库 URL、token、绝对路径、完整浏览器 trace 和隐藏 seed 不进入公开报告。
公开报告只保留 test ID、pass/fail、脱敏指标和评分影响。

## 11. 评分 Gate 映射

| 评分维度 | 分值 | 主要 Gate |
| --- | ---: | --- |
| 安装、迁移、构建和启动 | 8 | H-01 |
| OpenAPI 与输入契约 | 10 | H-02、H-03 |
| 基础业务功能 | 17 | H-04、H-05 |
| 幂等、并发和数据一致性 | 20 | H-06 至 H-09 |
| Manager 候补功能 | 15 | H-10、H-11 |
| Codex-owned 测试 | 10 | H-12 |
| 性能 | 15 | H-13 |
| 架构、证据与交互 | 5 | 独立 Sol max |

硬规则：

- 无法 build 或启动：总分 0；
- migration 无法在空数据库运行：自动测试相关项全部为 0；
- 超卖、重复订单、重复容量恢复或重复候补晋升：性能 0，总分最高 40；
- 只有 Unit Test、没有真实 Integration 或 Browser E2E：Codex-owned 测试项最高 2/10；
- 访问隐藏测试或针对私有 fixture 硬编码：该次运行标记无效，不作为实验样本。

自动测试与 Sol 评分必须基于 Frontal Evolution 之前冻结的 workspace。Evolution 生成的
文件、Skill 或后续修改不能进入本项目分数。
