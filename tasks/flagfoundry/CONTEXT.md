# FlagFoundry Context

FlagFoundry models versioned feature-flag rollout publication. This vocabulary is authoritative for the public contract,
dialogue, checklist, and evaluator design.

| Term | Canonical definition | Avoid |
| --- | --- | --- |
| Flag | A stable typed decision key owned by one Project. | Toggle, setting |
| Flag Revision | Immutable rules, variants, and allocation captured for one Environment. | Config, version |
| Evaluation Context | The published attributes accepted by deterministic rule evaluation. | User, request |
| Compilation Task | Durable leased work that validates and compiles a Draft to a content-addressed Snapshot. | Job, build |
| Snapshot | An immutable evaluation artifact identified by digest. | Cache, JSON file |
| Activation | The atomic change of the active Snapshot pointer. | Deploy, save |

## State language

Flag Revision: COMPILING -> READY -> ACTIVE -> SUPERSEDED, or COMPILING -> REJECTED; activating READY supersedes the prior ACTIVE revision for that Flag and Environment.

## Core invariants

1. Exactly one Flag Revision is active for a Flag and Environment at an instant.
2. The same Snapshot digest and Evaluation Context always produce the same variant and reason.
3. Variant allocation basis points sum to exactly 10,000 for every percentage rule.
4. Activation succeeds only for the exact active revision and rule schema captured by Compilation Task.
5. An inactive, rejected, or stale revision cannot become observable through evaluation.

Use these exact terms in API fields, UI labels, events, tests, and handoff. A synonym in explanatory
prose must not introduce a second domain concept.
