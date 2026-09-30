# ConfigRelay Context

ConfigRelay models durable desired-configuration rollout to agents. This vocabulary is authoritative for the public contract,
dialogue, checklist, and evaluator design.

| Term | Canonical definition | Avoid |
| --- | --- | --- |
| Agent | A registered endpoint with a durable appliedRevision and monotonically increasing commandSequence. | Client, node |
| Configuration | Canonical versioned JSON content owned by one Fleet. | Settings, payload |
| Deployment | The request to make one Configuration revision desired for selected Agents. | Rollout, publish |
| Assignment | One Agent's durable desired revision and delivery state. | Job, mapping |
| Delivery Task | Leased work delivering one Assignment with stable deliveryId and body. | Message, retry |
| Acknowledgement | An Agent report accepting or rejecting one exact revision and fencing token. | Heartbeat, response |

## State language

Deployment: PENDING -> DELIVERING -> APPLIED | FAILED | CANCELLED; Agent assignment: WAITING -> SENT -> ACKED | SUPERSEDED.

## Core invariants

1. For each Agent, the first accepted acknowledgement for a commandSequence is exactly the prior accepted sequence plus one and matches the current assignmentToken; an identical replay has no second effect, and no stale token or sequence can change desired or applied state.
2. One Deployment captures an immutable selector result and Configuration digest.
3. A stale assignment token cannot change current desired or applied state.
4. Every successful acknowledgement matches the exact delivered revision digest.
5. Repeated delivery preserves deliveryId, semantic body, and per-Agent command order.

Use these exact terms in API fields, UI labels, events, tests, and handoff. A synonym in explanatory
prose must not introduce a second domain concept.
