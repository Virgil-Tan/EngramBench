# DockChain Context

DockChain models port-call berth and tug window allocation. This vocabulary is authoritative for the public contract,
dialogue, checklist, and evaluator design.

| Term | Canonical definition | Avoid |
| --- | --- | --- |
| Berth | A quay position with vessel-size limits and an availability calendar. | Dock, slot |
| Tug Pool | An integer-capacity resource reserved over a movement interval. | Boat list, worker |
| Yard Window | An interval with container throughput capacity. | Storage slot, appointment |
| Port Call | One vessel arrival using one Berth, tug capacity, and yard capacity. | Booking, shipment |
| Clearance Task | Durable leased validation that moves a held Port Call to CLEARED. | Job, approval |
| Standby Entry | A priority request promoted when the exact resource bundle becomes available. | Waitlist, queue |

## State language

Port Call: HELD -> CLEARED -> IN_SERVICE -> COMPLETED, or HELD/CLEARED -> CANCELLED/EXPIRED.

## Core invariants

1. A Berth serves at most one active Port Call at an instant.
2. Reserved tug and yard capacity never exceeds the interval capacity and never becomes negative.
3. A Port Call holds its complete Berth/tug/yard bundle or no resource.
4. Each Clearance Task succeeds at most once and a Port Call starts service at most once.
5. Standby ordering is deterministic and an infeasible head is not bypassed within its priority class.

Use these exact terms in API fields, UI labels, events, tests, and handoff. A synonym in explanatory
prose must not introduce a second domain concept.
