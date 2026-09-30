# IdentityMesh Manager 固定需求

在 V1 完成并通过现有测试后，Manager 要求增加 Tenant Compromise Quarantine：

1. `POST /api/v1/compromise-incidents` 创建一个 Incident，并原子提高 Tenant compromise epoch、撤销全部 Session、暂停 Device Trust、停止旧 Signing Key 签发并创建传播 Work。
2. Incident 捕获 2-10 个不同 approverId 和 requiredApprovals。审批按 approverId 唯一，达到阈值只产生一次 `QUARANTINED -> RECOVERY_READY` 转换。
3. `POST /api/v1/compromise-incidents/:incidentId/recover` 只有在达到审批阈值、所有旧 Session 已撤销、Revocation 已传播且新 Signing Key ACTIVE 后才能成功。
4. 恢复创建新的 recovery epoch，但不得恢复旧 Session、旧 Refresh Token family、旧 Device challenge 或 RETIRED Key。
5. 并发最终审批和并发 recover 必须只有一个状态转换和一条 AuditEntry；Worker 崩溃恢复不得重复撤销或重新启用旧身份。
6. 新增 `CompromiseIncident` 和 `RecoveryApproval` snapshot resource，以及 `TENANT_QUARANTINE`、`TENANT_RECOVERY` Work。
7. 迁移必须保留 V1 Session、Device、Signing Key、Revocation、Audit chain、Event 和幂等 replay。
8. 更新 OpenAPI、真实安全控制台、Integration、Chromium E2E、多进程并发和 Barrier/SIGKILL Recovery。

本消息只描述产品需求，不提供实现或 Debug 提示。
