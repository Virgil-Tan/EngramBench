# QueueForge Context

QueueForge models lease-based asynchronous job execution. This vocabulary is authoritative for the public contract,
dialogue, checklist, and evaluator design.

| Term | Canonical definition | Avoid |
| --- | --- | --- |
| Job Definition | An immutable versioned command descriptor and retry policy. | Task, script |
| Run | One requested execution of a Job Definition version. | Job, process |
| Execution Lease | A time-bounded ownership record for one worker attempt. | Lock, claim |
| Attempt | One immutable execution interval and outcome for a Run. | Retry, process |
| Queue | A tenant-scoped ordered set with concurrency capacity. | Array, topic |
| Run Event | A sequenced durable fact for one Run. | Log line, webhook |

## State language

Run: QUEUED -> RUNNING -> SUCCEEDED | FAILED | CANCELLED; expired RUNNING leases return to QUEUED until attempts are exhausted.

## Core invariants

1. A Run has at most one live Execution Lease and at most one terminal outcome.
2. Active leases in a Queue never exceed its configured capacity.
3. Each Attempt number is unique and strictly increasing for its Run.
4. A retry uses the immutable Job Definition version captured when the Run was created.
5. Priority, notBefore, createdAt, and ID produce a deterministic claim order among eligible Runs.

Use these exact terms in API fields, UI labels, events, tests, and handoff. A synonym in explanatory
prose must not introduce a second domain concept.
