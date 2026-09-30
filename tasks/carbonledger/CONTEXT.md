# CarbonLedger Context

CarbonLedger models carbon credit lot reservation and retirement. This vocabulary is authoritative for the public contract,
dialogue, checklist, and evaluator design.

| Term | Canonical definition | Avoid |
| --- | --- | --- |
| Credit Lot | An immutable issuance batch with project, vintage, methodology, and integer grams available. | Balance, inventory |
| Retirement | A beneficiary request that permanently consumes reserved carbon quantity. | Purchase, offset |
| Lot Allocation | A quantity reserved from one Credit Lot for one Retirement. | Hold, line |
| Certificate | The immutable verified result of a completed Retirement. | Receipt, report |
| Certificate Task | Durable leased work producing and publishing one Certificate. | Job, renderer |
| Registry Event | A sequenced fact committed with lot and Retirement state. | Log, webhook |

## State language

Retirement: RESERVED -> CERTIFYING -> RETIRED, or RESERVED -> RELEASED | EXPIRED | FAILED.

## Core invariants

1. For every Credit Lot, issuedGrams = availableGrams + reservedGrams + retiredGrams and all terms are non-negative.
2. A V1 Retirement allocates exactly one eligible Credit Lot or allocates nothing.
3. Each Retirement publishes at most one Certificate whose quantity, beneficiary, Lot, and digest match committed state.
4. Released, expired, or failed Retirements never increase retiredGrams.
5. Registry Events and Certificate publication cannot exist for rolled-back retirement state.

Use these exact terms in API fields, UI labels, events, tests, and handoff. A synonym in explanatory
prose must not introduce a second domain concept.
