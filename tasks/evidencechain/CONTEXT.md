# EvidenceChain Context

EvidenceChain models forensic evidence manifest reconciliation and custody. This vocabulary is authoritative for the public contract,
dialogue, checklist, and evaluator design.

| Term | Canonical definition | Avoid |
| --- | --- | --- |
| Case Manifest | An immutable expected list of Collected Items for one Case. | Checklist, order |
| Collected Item | One uniquely labeled evidence item expected by a Case Manifest. | Sample, object |
| Intake Scan | An immutable observed label, seal, timestamp, and facility from one scanner batch. | Reading, upload |
| Custody Match | The confirmed association between an expected Collected Item and Intake Scan in V1. | Link, pairing |
| Custody Transfer | An immutable from/to handoff accepted by exactly one current custodian. | Move, status |
| Verification Task | Durable leased work checking seals, labels, and manifest rules. | Job, inspection |

## State language

Collected Item: EXPECTED -> RECEIVED -> VERIFIED | QUARANTINED; Custody Match: PROPOSED -> CONFIRMED | REVERSED.

## Core invariants

1. An Intake Scan is active in at most one Custody Match.
2. A Collected Item is active in at most one Custody Match in V1.
3. Exactly one custodian owns a received item at an instant and each accepted transfer links to the prior one.
4. A scanner batch is wholly accepted or leaves no scans, tasks, matches, or events.
5. Verification never changes the immutable observed label, seal, device sequence, or scannedAt.

Use these exact terms in API fields, UI labels, events, tests, and handoff. A synonym in explanatory
prose must not introduce a second domain concept.
