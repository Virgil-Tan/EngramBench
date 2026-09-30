# IncidentRelay Context

IncidentRelay models durable incident escalation and responder acknowledgement. This vocabulary is authoritative for the public contract,
dialogue, checklist, and evaluator design.

| Term | Canonical definition | Avoid |
| --- | --- | --- |
| Service | An operational ownership scope with one Escalation Policy version. | Application, team |
| Incident | One deduplicated alert occurrence requiring acknowledgement. | Alert, ticket |
| Escalation Policy | An immutable ordered set of responder targets and delays. | Workflow, schedule |
| Escalation Step | Durable due work for one policy level and Incident. | Job, timer |
| Responder | A person or endpoint eligible to acknowledge an Incident. | User, assignee |
| Notification Delivery | At-least-once webhook delivery with stable notificationId. | Message, email |

## State language

Incident: OPEN -> ACKNOWLEDGED -> RESOLVED, or OPEN -> EXPIRED; Escalation Steps are PENDING -> SENT | SUPERSEDED.

## Core invariants

1. For one serviceId and dedupKey, at most one active Incident exists at a time; every accepted Idempotency-Key replays its original stable result forever.
2. An Incident captures one immutable Escalation Policy version.
3. At most one Responder wins acknowledgement in V1.
4. No step after acknowledgement or resolution becomes newly deliverable.
5. Successful notifications for one Incident follow increasing step order.

Use these exact terms in API fields, UI labels, events, tests, and handoff. A synonym in explanatory
prose must not introduce a second domain concept.
