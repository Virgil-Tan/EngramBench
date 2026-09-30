# MeterSettle Context

MeterSettle models deduplicated usage ingestion and invoice settlement. This vocabulary is authoritative for the public contract,
dialogue, checklist, and evaluator design.

| Term | Canonical definition | Avoid |
| --- | --- | --- |
| Meter | A tenant-scoped source of monotonically identified Usage Events. | Counter, device |
| Usage Event | An immutable quantity for one Meter, eventId, and occurredAt instant. | Reading, request |
| Rate Plan | A versioned set of integer minor-unit pricing tiers effective over time. | Price, tariff row |
| Statement | One tenant and billing-period aggregate of rated Usage Events. | Invoice, bill |
| Rating Task | Durable leased work that applies the correct Rate Plan and finalizes a Statement. | Job, cron |
| Watermark | The published cutoff proving which occurredAt instants may be finalized. | Current time |

## State language

Statement: OPEN -> FINALIZING -> FINALIZED; finalized V1 Statements are immutable.

## Core invariants

1. Each tenant eventId contributes to usage and charge totals at most once.
2. A Statement total equals the sum of its immutable rated line amounts in integer minor units.
3. The applied Rate Plan is the version effective at each Usage Event occurredAt, not ingestion time.
4. A Watermark never moves backward and no finalized Statement changes in V1.
5. Batch rejection leaves no Usage Event, Rating Task, Statement mutation, or Domain Event.

Use these exact terms in API fields, UI labels, events, tests, and handoff. A synonym in explanatory
prose must not introduce a second domain concept.
