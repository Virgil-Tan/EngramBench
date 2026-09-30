# ClinicGrid Context

ClinicGrid models multi-resource clinical appointment holds. This vocabulary is authoritative for the public contract,
dialogue, checklist, and evaluator design.

| Term | Canonical definition | Avoid |
| --- | --- | --- |
| Clinician | A practitioner with versioned availability intervals. | Doctor, provider |
| Room | A physical treatment room with independent availability. | Location, office |
| Equipment Unit | A uniquely reservable device required by a Service Type. | Asset, tool |
| Appointment | One patient request that holds a Clinician, Room, and required Equipment Units for one interval. | Booking, visit |
| Waitlist Entry | A prioritized request for one Service Type and acceptable time range. | Queue item |
| Expiry Task | Durable work that expires an unconfirmed Appointment and releases every resource once. | Timer, cron |

## State language

Appointment: HELD -> CONFIRMED | CANCELLED | EXPIRED; terminal transitions are mutually exclusive.

## Core invariants

1. No resource has overlapping HELD or CONFIRMED Appointments.
2. An Appointment owns all required resources for its complete interval or owns none.
3. Cancellation or expiry releases each resource exactly once.
4. A Waitlist Entry produces at most one Appointment and the published head blocking order is preserved.
5. The persisted expiresAt instant, not a process-local timer, determines expiry.

Use these exact terms in API fields, UI labels, events, tests, and handoff. A synonym in explanatory
prose must not introduce a second domain concept.
