# GeoPulse 任务说明

GeoPulse 是一个从空仓库实现的多租户地理围栏平台。候选项目必须接收设备位置事件，依据不可变的
RegionVersion 计算 ENTER、EXIT 和 DWELL，在乱序、重复、边界抖动、多进程和 Worker 崩溃后仍保持
唯一且一致的轨迹，并提供真实 React 运维界面。

V1 的主要难点是设备序号与事件时间的双重排序、polygon 边界语义、hysteresis、迟到事件重放、
版本激活切换、批量点查询、事务性 Work/Event 和租户隔离。README 明确公开所有状态、接口、错误、
性能阈值和验证命令。

中途 Manager 要求新增 RegionBundle：多个 RegionVersion 作为一个不可变 revision 原子发布，设备
评估必须固定到唯一 bundle revision；并发 publish/rollback、旧事件重放、迁移和缓存失效都不能混合
两个 revision 的结果。

隐藏 evaluator 实现 H-01～H-13，其中 H-12 包含三条专属持续压力：`ordered-location-ingest`、
`boundary-jitter-convergence` 和 `bulk-spatial-query`。测试只通过公开命令、HTTP、Chromium、barrier、
进程信号和 verification snapshot 工作，不读取候选源码。

该目录是独立 Task 包，拥有自己的 fixture Git 仓库、Persona、Dialogue、Checklist、Manager Prompt、
实验配置和 evaluator，不依赖任务生成器。
