# NotifyRoute 任务设计

NotifyRoute 是一个完全独立的通知路由平台任务，不依赖其他 Task 的源码、数据库、配置或运行状态。

## 评测重点

- Email、SMS、Webhook 的确定性路由、优先级和 fallback；
- 模板版本、RoutePolicy revision 与请求内容冻结；
- 租户和收件人双层限流，以及跨进程竞争下的配额守恒；
- 即时退订、发送前二次检查和退订/发送竞争；
- Provider timeout、connection reset、重复和乱序 receipt 下的重复发送防护；
- Worker lease、Outbox 未知 ACK、迁移兼容和真实 React 运维界面；
- Manager 中途新增的 Campaign 冻结受众、并发取消和崩溃恢复。

## 难度来源

系统必须同时维护三类彼此竞争的边界：业务请求已经接受但用户刚刚退订；当前窗口还有配额但多个
Worker 同时争抢；Provider 已经接受发送但响应丢失。正确实现不能依靠单进程内存锁，而要从公开
snapshot 证明每个逻辑 Delivery 的路由、配额、同意状态、Provider identity、事件和 Work 都一致。

## 独立性

公开产品合同只位于 `workspace/`。Checklist、Manager Prompt、Persona、对话剧本和 H-01～H-13
Evaluator 都封装在本目录中；共享 Harness 只提供通用进程、HTTP、PostgreSQL、Chromium、Barrier
和负载执行原语。NotifyRoute 未加入任何全局业务生成器或任务注册表。
