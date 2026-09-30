# CommerceCommand 独立端到端测试方案

本方案只使用候选项目公开命令、HTTP/OpenAPI、真实 PostgreSQL、system Chromium、verification snapshot、接收器、Barrier 和进程信号。Evaluator 不导入候选源码、ORM、私有表或测试 helper。

## 执行环境

- 每个 H case 使用独立临时 PostgreSQL database；
- `npm install`、production build 和 migration 从候选 workspace 执行；
- API、Worker、dispatcher 是独立 OS process；
- H-09/H-28 由 Harness 提供 Manager 前的 V1 workspace snapshot；
- H-12 正式评分只允许 `BENCH_PERF_SCALE=1`；
- 每个 case 结束后清理进程、receiver 和 database。

## H-01～H-13 基础工程门

| ID | 独立场景 | 关键断言 |
| --- | --- | --- |
| H-01 | Clean build/boot/strict seed | clean install、build、重复 migration、空 seed 重放、未知 seed 字段拒绝、四个生产角色启动。 |
| H-02 | OpenAPI 与 Chromium 基线 | OpenAPI 3.1 包含所有公开路径；production UI 由 system Chromium 渲染。 |
| H-03 | Frozen quote 主流程 | 一个 quote 原子创建 Order、冻结 line、holds、event、notification 和 Work。 |
| H-04 | 原子拒绝 | 幂等正文冲突、malformed JSON、跨 tenant 引用都不留下局部状态。 |
| H-05 | 持久幂等 | 丢失已提交响应、20 路并发重放和 API restart 始终返回一个 Order。 |
| H-06 | 两 API 竞争 | 同 key 收敛；额外热库存竞争出现合法拒绝但永不 oversell。 |
| H-07 | Worker lease/fencing | fulfillment claim 后 SIGKILL；替代 Worker 只完成一次。 |
| H-08 | dispatcher unknown ACK | response 后 SIGKILL；重试 event ID 和 bytes 完全相同。 |
| H-09 | V1→FINAL migration | V1 数据、ID、immutable payload 和保存 replay 不变；新增资源可用。 |
| H-10 | Manager 主流程 | conserved seller allocation 成功并进入公开 snapshot。 |
| H-11 | Manager 多进程竞争 | 32 路 allocation replay 收敛，数量与金额完整守恒。 |
| H-12 | 十场景正式压力 | 执行下述全部 10 条，不允许 placeholder 或缩减为单次 smoke。 |
| H-13 | Project-owned gates | Unit、Integration、Chromium、Concurrency、Recovery 和 all gate 从 clean install 真实通过。 |

## H-14～H-30 专属组合压力

| ID | 场景 | 组合压力与验收 |
| --- | --- | --- |
| H-14 | Multi-pool conservation | 两 API、160 个大额 quote 同时争抢两个 pool；成功/失败并存，pool equation 和每 line 完整 allocation 成立。 |
| H-15 | Tenant/security isolation | 交叉 Tenant Buyer、Product 和 opaque ID 探测；返回安全错误且 Order/Hold/Event 均不增加。 |
| H-16 | Out-of-order payment convergence | DECLINED、UNKNOWN、CAPTURED 并发乱序与 duplicate/provider conflict；最终只 capture 一次。 |
| H-17 | Multi-worker fulfillment | 24 个 captured order、4 Worker 竞争并杀死其中一个；所有 plan 唯一完成。 |
| H-18 | Entitlement/refund race | digital grant 后 full refund 与 revoke 跨 API 竞争；最终 REVOKED 且财务平衡。 |
| H-19 | Notification order + unknown ACK | 同 Order 多事件，response barrier 后杀 dispatcher；重试 bytes 不变且 aggregate sequence 有序。 |
| H-20 | Production browser reload | 真实 Chromium 通过可见控件完成 mixed quote、checkout、capture 与 refund；reload 后仍显示 server-authoritative state。 |
| H-21 | Refund/restock compensation | 12 路 refund + restock 竞争；只退一次数量，不超 refund，不重复补库存。 |
| H-22 | Ledger/event determinism | capture + refund + exact replay；snapshot bitwise canonical 稳定、每 journal 平衡、event sequence 唯一。 |
| H-23 | Multi-role recovery | 18 个 mixed order；杀 API、Worker、dispatcher 后替代角色 drain，所有不变量保持。 |
| H-24 | Seller allocation conservation | 先验证少 1 minor unit 整体回滚，再让两个不同合法 split 进行 32 路竞争；只持久化一个集合。 |
| H-25 | Settlement close race | 两 API 32 路 close；一个 immutable CLOSED settlement，每条 eligible allocation 最多捕获一次。 |
| H-26 | Refund/dispute reservation | 各请求 75% captured amount 并发竞争；只能一个提交，refund + reserve 始终不超 capture。 |
| H-27 | Closed-period adjustment | CLOSED 后 correction 只 append 下一周期 adjustment；exact replay 不增加记录且旧 settlement 不改写。 |
| H-28 | Blue-green schema/replay | 旧、新 API binary 同库并存；V1 保存 replay 跨版本一致，旧客户端仍能创建新 quote。 |
| H-29 | Sustained invariant soak | 两 API、64 并发、物理/数字 mixed quote 持续负载；结束后两个 API snapshot 一致且全量重算不变量。 |
| H-30 | Full catastrophe drill | mixed Order、allocation、dispute、settlement 存在时杀 API/Worker/dispatcher；替代角色完成 LOST chargeback、close 和 drain。 |

## H-12 十条正式性能场景

Evaluator 精确执行并返回以下 scenario ID：

1. `quote-read-mix`
2. `checkout-contention`
3. `inventory-hotspot`
4. `payment-unknown-reconcile`
5. `fulfillment-drain`
6. `notification-unknown-ack`
7. `entitlement-revocation-storm`
8. `seller-settlement-close`
9. `refund-dispute-race`
10. `full-catastrophe-recovery`

前 7 条阈值来自初始 README，后 3 条只在 Manager 消息中发布。Evaluator 的 adapter、contract 和 metrics ID 必须完全一致。每条压力结束后重新读取公开 snapshot 并重算库存、金额、账本、事件、租户、allocation、settlement 和 Work/outbox 状态；吞吐达标但不变量失败仍为失败。

## 输入和输出规范

单独运行：

```bash
node /hidden/H-14/task/run.mjs --case H-14 --snapshot FINAL
node /hidden/H-28/task/run.mjs --case H-28 --snapshot V1_TO_FINAL
node /hidden/H-30/task/run.mjs --case H-30 --snapshot FINAL
```

成功时 stdout 只输出一个 JSON object：

```json
{
  "schemaVersion": 1,
  "taskId": "commercecommand",
  "caseId": "H-30",
  "status": "passed",
  "durationMs": 1234,
  "assertions": ["..."]
}
```

任何 assertion、进程提前退出、timeout、非法 contract 或性能 metric 缺失都以非零退出结束，不把基础测试当成隐藏场景成功。
