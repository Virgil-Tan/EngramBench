【Product Manager · Maya】

V1 已完成并通过基础验收。本期正式增加“dependency-aware run graphs”。以下业务规则、wire schema、接口和错误全部是公开增量合同。

业务规则：

1. A Workflow Run contains 1-50 node Runs connected by an acyclic dependency graph.
2. Nodes become eligible only after all required predecessors succeed; independent nodes may execute concurrently.
3. When a node becomes FAILED, every non-terminal transitive descendant with that failed ancestor becomes BLOCKED. A BLOCKED Run has no Execution Lease, consumes no Attempt, and cannot be claimed.
4. Cancelling a Workflow Run cancels every non-terminal node atomically and never changes completed nodes.
5. Retry is legal for any FAILED node below its captured maxAttempts, including a leaf node. The retry transaction changes that node to QUEUED and changes only BLOCKED descendants whose sole FAILED ancestor was that node to QUEUED without changing their attemptCount; other BLOCKED descendants remain unchanged. It changes a FAILED Workflow Run back to RUNNING with terminalAt null and leaves claim eligibility gated on all immediate predecessors being SUCCEEDED.
6. Workflow Run is QUEUED before its first claim, RUNNING after that point while any node is QUEUED or RUNNING, SUCCEEDED when every node succeeds, FAILED when no node is QUEUED or RUNNING and at least one node is FAILED or BLOCKED, and CANCELLED after workflow cancellation.
7. Legacy standalone Run endpoints and response bodies remain unchanged; graph nodes expose workflowRunId and nodeKey.
8. Existing Runs remain standalone with workflowRunId null and unchanged histories.
9. Pending and leased V1 Runs continue after migration with the same lease and attempt semantics.
10. Existing idempotency records and Run Event sequences remain replayable.
11. The versioned seed schema remains exactly V1; Manager-only state is created through the public APIs above, and tests must not require unpublished seed members.
12. The only new Domain Event type names are those written literally in the Manager rules or contracts above. Other Manager transitions reuse a V1 event type only for the same aggregate transition and otherwise emit no Domain Event.
13. Update OpenAPI and runtime API, workers, real UI, Integration Test, production Chromium E2E, multi-process concurrency, SIGKILL recovery, and sustained performance coverage.
14. Preserve all V1 data, public error semantics, saved idempotency replay results, and already committed event identity, body, and sequence unless a rule above explicitly changes a new response field.

新增 wire schema：

- WorkflowNode = {nodeKey:string,runId:uuid,dependsOn:[string],state:QUEUED|RUNNING|SUCCEEDED|FAILED|BLOCKED|CANCELLED}; Run adds workflowRunId:uuid|null and nodeKey:string|null, and workflow node Runs additionally permit state BLOCKED
- WorkflowRun = {workflowRunId:uuid,state:QUEUED|RUNNING|SUCCEEDED|FAILED|CANCELLED,nodes:[WorkflowNode],createdAt:timestamp,terminalAt:timestamp|null,sequence:int}

新增或变更接口：

- POST /api/v1/workflow-runs with {nodes:[{nodeKey,jobDefinitionId,jobVersion,queueId,priority,input,dependsOn:[nodeKey]}]} atomically creates 1..50 Runs after validating a DAG
- GET /api/v1/workflow-runs/:workflowRunId returns WorkflowRun in nodeKey order; POST /api/v1/workflow-runs/:workflowRunId/cancel with {reason} cancels all non-terminal nodes
- POST /api/v1/workflow-runs/:workflowRunId/nodes/:nodeKey/retry with {} performs the published FAILED/BLOCKED-to-QUEUED transaction; the next worker claim creates the next Attempt and Execution Lease

新增稳定错误：

- 400 WORKFLOW_GRAPH_CYCLE: dependsOn contains a cycle, missing key, duplicate key, or self-edge
- 409 WORKFLOW_NODE_NOT_RETRYABLE: node state or dependent state makes retry illegal

FINAL snapshot 与性能兼容合同：

The FINAL verification snapshot 'resources' object has exactly the union of these V1 and Manager resource specifications, with no other keys:

- 'queues' uses exact shape 'Queue = {queueId:uuid,name:string,capacity:int}' and sorts ascending by scalar field-path tuple 'queueId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'jobDefinitions' uses exact shape 'JobDefinition' and sorts ascending by scalar field-path tuple 'jobDefinitionId', 'version', then by RFC 8785 canonical JSON as the tie-breaker.
- 'runs' uses exact shape 'Run' and sorts ascending by scalar field-path tuple 'runId', then by RFC 8785 canonical JSON as the tie-breaker.
- 'executionLeases' uses exact shape 'ExecutionLease' and sorts ascending by scalar field-path tuple 'runId', 'attempt', then by RFC 8785 canonical JSON as the tie-breaker.
- 'attempts' uses exact shape 'Attempt' and sorts ascending by scalar field-path tuple 'runId', 'attempt', then by RFC 8785 canonical JSON as the tie-breaker.
- 'workflowRuns' uses exact shape 'WorkflowRun' and sorts ascending by scalar field-path tuple 'workflowRunId', then by RFC 8785 canonical JSON as the tie-breaker.

The Manager-added resource specifications are exactly:

- 'workflowRuns' uses exact shape 'WorkflowRun' and sorts ascending by scalar field-path tuple 'workflowRunId', then by RFC 8785 canonical JSON as the tie-breaker.

The FINAL Work kind enum is exactly the union 'RUN_EXECUTION'. The Manager-added
Work kinds are exactly (none). All V1 snapshot point-in-time,
recursive '*Token' omission, sorting, Work state/lease/retention/drain, and Domain Event rules remain
mandatory. The FINAL binary reruns exactly these three V1-compatible scenarios:

- 'run-enqueue': enqueue 300 Runs/s with p95 <= 250 ms; threshold: At least 300 successful enqueues/s for 60 seconds and p95 <= 250 ms; unexpected 5xx = 0.
- 'short-run-execution': claim and complete 5,000 short Runs within 60 s using four workers; threshold: The complete set finishes in <= 60 seconds; stale-lease responses and unexpected 5xx are zero.
- 'expired-lease-recovery': recover 2,000 expired leases within 45 s without capacity oversubscription; threshold: All expired leases recover in <= 45 seconds; unexpected worker failures = 0.

Their published setup, selector, request, concurrency, warm-up, measurement, timer, success condition,
and threshold remain unchanged. This Manager change adds correctness, concurrency, and recovery
assertions only; it does not replace or relax a performance scenario.

本轮先不要实现。请先说明它会影响哪些领域关系、模块、schema、migration、接口、状态、成功与失败数据流、兼容性、Worker、事件、前端、并发、恢复和性能测试，然后给出分阶段修改计划。