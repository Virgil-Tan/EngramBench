# QuotaMesh Context

QuotaMesh models multi-dimension tenant quota reservation. This vocabulary is authoritative for the public contract,
dialogue, checklist, and evaluator design.

| Term | Canonical definition | Avoid |
| --- | --- | --- |
| Quota Pool | A tenant-owned integer capacity vector for declared Dimensions. | Limit, bucket |
| Dimension | A named unit such as cpuMillis, memoryMiB, or storageMiB. | Resource, field |
| Reservation | An atomic temporary claim on a non-empty capacity vector. | Hold, allocation |
| Commitment | The durable conversion of held capacity into active usage. | Usage, confirmation |
| Expiry Task | Durable work that releases an uncommitted Reservation after expiresAt. | Timer, cron |
| Admission Queue | A deterministic FIFO-with-priority list for requests that cannot currently fit. | Waitlist, backlog |

## State language

Reservation: HELD -> COMMITTED | RELEASED | EXPIRED; terminal transitions are mutually exclusive.

## Core invariants

1. For each Pool and Dimension, held plus committed quantity never exceeds capacity and no value is negative.
2. A Reservation owns its complete requested vector or owns none.
3. Commit, release, or expiry adjusts each Dimension exactly once.
4. An Admission Queue entry produces at most one Reservation and cannot bypass an eligible earlier entry of equal priority.
5. All mutation replay remains stable across restart and concurrent API instances.

Use these exact terms in API fields, UI labels, events, tests, and handoff. A synonym in explanatory
prose must not introduce a second domain concept.
