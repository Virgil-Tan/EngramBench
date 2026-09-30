# V2 任务包与作者接口

## 权威与版本

**30 个 Learning 的当前范围是 `learning-final-system-2026-09-08.1`。** 用户已取消中间 V1 与跨版本升级要求：一次性实现基础与新增功能，只提交一份最终 workspace；从空库经公开 seed/API 建立测试状态。不要准备历史数据库、旧程序、旧服务或迁移专用 legacy 包装。进程重启/崩溃恢复、数据持久性和公开业务要求仍须真实测试。

这 30 题以生成的 `workspace/README.md` → `docs/requirements.md` → `contract/` 为当前入口；`docs/frontal-legacy/` 原文只保留溯源，明确撤销的跨版本条款不再生效。其余原文义务仍有效。13 个 Transfer 暂不改变范围。完整规则见 [单一最终系统评测](v2-evaluator-repair-plan-20260908.zh-CN.md)。这是评测范围修订，不能冒充历史同版本复测。

除上述明确撤销的跨版本条款外，业务要求是完整 README 与已公开 Manager 需求的并集。`contract/README.md` 所列 V2 澄清只解决原文缺失/冲突的表示方式；不能删掉业务能力、降低一致性要求、把技能答案写进脚手架。原文保存不改，澄清另列。

Benchmark version 为 2；沿用已验证的 Task Package protocol `schemaVersion:1`，任务 revision 为 `taskVersion:4`。这三个数字不是同一含义。旧隐藏评测内部 schemaVersion 2 也不表示已经适配本 Benchmark V2。

## 作者要交付的文件

1. `contracts/learning/<id>.mjs` 或 `contracts/transfer/<id>.mjs`：导出 taskId/title/schemas/operations/seed/commands/environmentVariables/smoke/notes。两类使用同一任务包接口，Learning/Transfer 是实验分组，不是两套协议。
2. 公开 README：完整需求、业务不变量、状态变化、兼容与恢复要求、UI 流程、可执行的性能定义。
3. Frozen Plan：固定阶段顺序，不允许模型生成不同计划；具体切片由 Coding Agent 对照完整 README 自主选择。
4. Scenario：只问进度、推动实现和全量 README 审计，不透露方法名、不罗列替代需求表。
5. 私有 evaluator：独立业务断言、合法生成夹具、错误分类与公开反馈。每一个计分断言都必须能映射到已发布要求。

## Operation

每个操作固定 `id,method,path,status,source,response`。JSON mutation 必须有 request schema + example；真正无请求体使用 `requestBody:'none'`，不能用“没写 schema”表示。

- path 占位符是 `:name`，不是业务代码的函数名。
- `parameters` 精确定义 path/query/header 参数及必填、类型、范围。Query/Path 数字由同一验证器从 HTTP 字符串转换，未声明的查询键不接受。
- 参数可单独声明 `transportError:{status,code}`，例如设备签名头非法为 401；它只影响该参数，不把普通 body 校验错误改成鉴权失败。OpenAPI 使用 `x-transport-error` 发布该约定。
- 原文区分“缺失”和“格式非法”时，参数的 `missingTransportError` 只覆写缺失错误；格式非法仍使用 `transportError`。OpenAPI 同步发布 `x-missing-transport-error`，不能把缺失鉴权和非法令牌混成同一码。
- `request.contentMediaType` 缺省为 application/json；二进制上传是 application/octet-stream，并直接提供流，不强迫文件全部入内存。
- response media type 决定 JSON、HTML、NDJSON 或 binary；`successStatuses`/`successResponses` 明确 206/304 等特殊状态。HEAD/204/304 没有响应体。
- `responseHeaders` 进入 OpenAPI。业务方仍负责 Range、ETag、摘要、授权等真实语义，不是写几个响应头就完成。
- 资源字段使用封闭 schema；允许自由 JSON 的业务字段必须显式标明，不能用任意 object 掩盖未设计的资源接口。
- `transportErrors` 按原文覆写传输错误的 status/code；不能把 LaunchPass 的 422 VALIDATION_ERROR 等不同任务规则统一成任意固定错误码。原文没有定义的 wire 默认值必须公开说明。
- 原文要求特殊错误 envelope 时，可在对应 transportErrors 条目明确 `body`；该 body 必须符合公开 Error schema 且 code 一致。例如 Creator 的 MALFORMED_JSON 仅返回 `{error:{code:'MALFORMED_JSON'}}`，其他错误仍保留标准 envelope。
- 某字段的非法值有原文专属错误码时，用操作级 `bodyTransportErrors:[{path:'/amount',when:'number',status:400,code:'...'}]`。path 为 JSON Pointer 字段前缀，`*` 匹配数组索引；省略 when 匹配该字段的 schema 错误，number 仅匹配 JSON 数字，unsafe_integer 仅匹配非安全整数的 JSON 数字。字符串或缺失字段不被数值规则误归类。OpenAPI 用 `x-body-transport-errors` 公布；验证仍拒绝非法值，不放松 schema。

OpenAPI 由同一文件生成，不另写第二份隐藏约定。

原文要求出站 webhook 合同时，可在 `contract.webhooks` 放标准 OpenAPI 3.1 webhook 描述；生成器同步处理 schema 引用。私有评测须验证相同的已发布消息/请求头，不把出站 webhook 混成额外的入站业务路由。

## Seed、启动与实现

每题提供合法的非空最小领域图，不只放 Tenant/空数组。固定 ID、外键、版本字段、时间格式、空值、顶层集合、允许重复导入与否。

`seed.command` 为 argv 数组（`${SEED_PATH}` 是路径替换变量），缺省 `npm run db:seed -- --file ...`；`seed.replay:false` 用于只允许空库导入的任务。外键有效性、摘要、一致性、原子提交由模型实现，JSON schema 只负责形状。

`src/implementation.ts` 的 execute 收到 operationId 和已验证的 request context。内部模块、数据库表结构、锁和事务设计由 Agent 自由实现。可导出 async start()/stop() 管理 API 进程生命周期；独立 Worker/Dispatcher 与迁移、build、自测从 lifecycle.ts 派发。

任务可通过 `httpHost` 固定监听地址；未指定时沿用 `0.0.0.0`。CreatorRightsExchange 按原文仅监听 `127.0.0.1`。`PORT` 只选择端口，不能覆盖作者声明的监听范围。

脚手架不能提供目标业务的幂等表实现、事务状态机、Worker fencing 或完整恢复算法；不能从模型旧结果抄一份参考实现。

## 公开检查

`check:contract-source`：只检查 schema/文件与固定命令，没有业务分数。

`test:public-contract`：在一次性数据库和隔离副本中 build → migration → nonempty seed → 必要角色 → 实际 HTTP 请求。至少包括非空持久化读取和独立写后读。

- `capture:{name:['field']}` 保存响应字段。
- 后续请求 params/query/body/headers/expectBody 通过 `${name}` 引用实际生成 ID。
- 对已捕获的公开 RFC3339 时间可用 `${clock+60000ms}` 或 `${clock-1ms}` 计算相对时间；clock 必须来自公开响应。用于短有效期请求，不写死易过期日期，不冻结或更改提交的业务时钟。
- 普通 `body` 按声明的媒体类型编码，JSON 字符串也必须合法 JSON 编码；故意发送畸形字节用显式 `rawBody` 字符串，不能与 `body` 同时出现。
- `expectContains:[{path:['resources','entities'],match:{id:'${name}'}}]` 默认要求恰好一个匹配记录，不能空列表也绿。
- 不允许修改 checker/合同来适应某份提交；官方检查始终使用作者持有的副本。
- 公开检查通过不替代跨层、并发、恢复、权限、UI 与性能验证，更不等于项目完成。

## 隐藏评测

同样消费作者持有的公开合同；请求字段、seed、启动和读取方法不得自行猜测。

正向夹具违反合同是 `evaluator_error`，不是模型业务失败。故意的负向 wire 测试必须显式传 `contractExpectation:'invalid'`，并独立断言错误代码、无副作用等；该标记不能用于正向请求，不得自动全局开启。业务层负向条件（越权、并发冲突、过期状态等）仍使用合法 wire 输入。

隔离 evaluator 只读冻结的 submission，不修改源代码，不通过提交特定 Adapter 改路径/字段/测试结果。基础设施失败单独报告；缺实现和符合公开规范的业务失败正常失败。

新题发布前：公开源的全路由核对、所有 schema/正向示例验证、正负传输回归、真实最小实现冒烟、隐藏夹具对齐检查、至少一个完整真实提交的隔离评测。未完成最后两项的题包必须明确标为尚未认证，不能用静态绿色代替。

`evaluators/learning/<id>/release.json` 或 `evaluators/transfer/<id>/release.json` 为作者侧发布记录；当前认证绑定合同 JSON、私有用例和 runtime lock。注意现有认证摘要尚未完整覆盖 `public-contract/` 中的传输层与 checker 文件；正式认证前还须补齐此覆盖，不能因旧摘要匹配就复用模板变更前的认证。任务开发导出仍可使用，但未认证的包不得进入正式计分实验。
