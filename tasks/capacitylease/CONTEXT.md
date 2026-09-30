# CapacityLease Context

CapacityLease models time-window capacity holds and gang leases. This vocabulary is authoritative for the public contract,
dialogue, checklist, and evaluator design.

| Term | Canonical definition | Avoid |
| --- | --- | --- |
| Capacity Pool | A named resource with an immutable timezone-free capacity over UTC time. | Quota, server |
| Capacity Lease | A request for integer units over one half-open time interval. | Booking, allocation |
| Hold | Temporary capacity consumed until confirmation or hold expiry. | Lock, cart |
| Admission Entry | A persisted ordered request waiting for capacity without consuming it. | Queue row |
| Lease Expiry Task | Durable leased work that expires a Hold or advances time-based state. | Timer, cron |
| Capacity Slice | A deterministic boundary segment used to prove interval conservation. | Bucket, timeslot |

## State language

Capacity Lease: HELD -> CONFIRMED -> ACTIVE -> RELEASED, or HELD -> EXPIRED; confirmed future Leases may be RELEASED before activation.

## Core invariants

1. For every Pool and instant, the sum of units for overlapping HELD, CONFIRMED, and ACTIVE Leases never exceeds capacity and is never negative.
2. Lease intervals are half-open and every Capacity Slice boundary comes only from a Lease startAt or endAt.
3. One request is either one capacity-consuming Lease or one WAITING Admission Entry, never both.
4. Confirmation, renewal, release, expiry, and promotion serialize to one state transition per expected revision.
5. A stale worker or hold token cannot consume, release, or restore capacity after another transition wins.

Use these exact terms in API fields, UI labels, events, tests, and handoff. A synonym in explanatory
prose must not introduce a second domain concept.
