# LedgerBridge Context

LedgerBridge models durable double-entry account transfers. This vocabulary is authoritative for the public contract,
dialogue, checklist, and evaluator design.

| Term | Canonical definition | Avoid |
| --- | --- | --- |
| Account | A balance owner identified by a stable accountId and one integer minor-unit currency. | Wallet, purse |
| Transfer | One requested movement between two distinct Accounts. | Payment, transaction |
| Posting | The immutable balanced debit and credit pair for a Transfer. | Balance update |
| Settlement Task | Durable leased work that finalizes a pending Transfer. | Job, queue item |
| Reversal | A compensating Posting linked to exactly one posted Transfer. | Delete, refund |
| Domain Event | A versioned fact committed with aggregate state and sequence. | Message, log |

## State language

Transfer: PENDING -> POSTED | CANCELLED; POSTED -> REVERSED. CANCELLED and REVERSED are terminal.

## Core invariants

1. For every currency, the sum of Account balanceMinor values is conserved; reservations never participate in that sum.
2. Every posted Transfer has exactly two Posting legs whose signed amounts sum to zero.
3. For each Account, reservedMinor equals the sum of amountMinor for its outgoing PENDING Transfers, availableMinor equals balanceMinor minus reservedMinor, and none of those values is negative.
4. A Transfer has at most one successful Posting and at most one Reversal.
5. A committed state transition has exactly one Domain Event; a rolled-back transition has none.

Use these exact terms in API fields, UI labels, events, tests, and handoff. A synonym in explanatory
prose must not introduce a second domain concept.
