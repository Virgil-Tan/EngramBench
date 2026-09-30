# MergeBoard Context

MergeBoard models revisioned collaborative document changes and merges. This vocabulary is authoritative for the public contract,
dialogue, checklist, and evaluator design.

| Term | Canonical definition | Avoid |
| --- | --- | --- |
| Document | A stable ordered block collection with one head revision in V1. | File, page |
| Revision | An immutable canonical Document state identified by documentId and integer revision. | Version, save |
| Change | A client-authored ordered list of block operations against one baseRevision. | Patch, edit |
| Conflict | A deterministic explanation that a Change cannot be safely applied to current head. | Error, merge |
| Snapshot Task | Durable leased work compacting an operation prefix into a verified Snapshot. | Job, backup |
| Client Sequence | A per-client monotonically increasing number used for offline replay. | Idempotency key, timestamp |

## State language

Change: PENDING -> APPLIED | CONFLICTED | REJECTED; Document revisions are immutable and strictly increasing.

## Core invariants

1. Document revision numbers are contiguous and each applied Change creates exactly one next revision.
2. One client sequence maps to one semantic Change and stable response forever.
3. Replaying the same accepted Change cannot duplicate, lose, or reorder blocks.
4. A Snapshot digest equals the canonical state obtained by replaying its exact operation prefix.
5. A conflicted or rejected Change does not mutate head state or emit document.changed.

Use these exact terms in API fields, UI labels, events, tests, and handoff. A synonym in explanatory
prose must not introduce a second domain concept.
