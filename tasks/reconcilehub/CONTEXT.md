# ReconcileHub Context

ReconcileHub models auditable statement-to-ledger reconciliation. This vocabulary is authoritative for the public contract,
dialogue, checklist, and evaluator design.

| Term | Canonical definition | Avoid |
| --- | --- | --- |
| Statement Batch | One versioned atomic import of external Statement Lines. | File, upload |
| Statement Line | An immutable dated amount and reference from a Statement Batch. | Transaction, row |
| Ledger Entry | An immutable internal amount available for reconciliation. | Payment, posting |
| Match | A one-to-one association between one Statement Line and one Ledger Entry in V1. | Link, mapping |
| Suggestion Task | Durable leased work that ranks eligible one-to-one candidates. | Job, model |
| Reversal | An audited transition that releases both sides of a confirmed Match. | Delete, unmatch |

## State language

Statement Line: UNMATCHED -> MATCHED | IGNORED; Match: PROPOSED -> CONFIRMED | REJECTED | REVERSED.

## Core invariants

1. A confirmed Statement Line belongs to at most one active Match.
2. A confirmed Ledger Entry belongs to at most one active Match.
3. Every confirmed V1 Match has equal currency and amount on both sides.
4. Batch import is all-or-nothing and same digest replays the same IDs and response.
5. Reversal restores both sides exactly once and never deletes audit history.

Use these exact terms in API fields, UI labels, events, tests, and handoff. A synonym in explanatory
prose must not introduce a second domain concept.
