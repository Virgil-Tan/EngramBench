# SchemaHarbor Context

SchemaHarbor models versioned schema compatibility publication. This vocabulary is authoritative for the public contract,
dialogue, checklist, and evaluator design.

| Term | Canonical definition | Avoid |
| --- | --- | --- |
| Subject | A stable name whose Schema Versions form one ordered compatibility history. | Topic, table |
| Schema Version | Canonical JSON schema content with a Subject-local integer version. | Document, revision |
| Compatibility Mode | BACKWARD, FORWARD, or FULL rules captured when validation begins. | Policy, check |
| Validation Task | Durable leased work comparing a Draft to the required published history. | Job, lint |
| Publication | The atomic transition that assigns the next version and makes content discoverable. | Save, upload |
| Dependency | A pinned reference to one published Schema Version. | Import, link |

## State language

Schema Draft: VALIDATING -> VALID -> PUBLISHED, VALIDATING -> REJECTED, and VALIDATING|VALID -> STALE; publication creates one immutable Schema Version.

## Core invariants

1. A Subject has at most one published Schema Version for each integer version and no gaps.
2. Published canonical content and Dependency pins never change.
3. Publication succeeds only against the exact head and Compatibility Mode validated by its task.
4. Semantically equivalent canonical JSON cannot produce two versions in one Subject.
5. A rejected or stale Validation Task creates no Publication or publication event.

Use these exact terms in API fields, UI labels, events, tests, and handoff. A synonym in explanatory
prose must not introduce a second domain concept.
