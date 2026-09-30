# ExportVault Context

ExportVault models recoverable privacy export generation and retention. This vocabulary is authoritative for the public contract,
dialogue, checklist, and evaluator design.

| Term | Canonical definition | Avoid |
| --- | --- | --- |
| Export Request | A scoped request for one Subject and captured dataset revision. | Download, report |
| Dataset Revision | The immutable source watermark all export sections must observe. | Timestamp, database state |
| Export Task | Durable leased work producing an archive from the captured revision. | Job, query |
| Export Object | Verified immutable bytes with digest, size, media type, and retention deadline. | File, blob |
| Download Grant | A short-lived server record authorizing bounded range reads. | Token, URL |
| Deletion Proof | The immutable fact that an expired or cancelled Export Object is no longer readable. | Log, tombstone |

## State language

Export: REQUESTED -> GENERATING -> READY -> EXPIRED, or REQUESTED/GENERATING -> CANCELLED | FAILED.

## Core invariants

1. Every section in one Export observes the same captured Dataset Revision.
2. A READY Export has exactly one readable object whose digest and size match metadata.
3. A cancelled, failed, or expired Export is never newly downloadable.
4. Equivalent active requests for the same Subject, scope, and revision produce one Export and stable replay.
5. Cleanup never removes an object before its retention deadline or while an unexpired grant is active.

Use these exact terms in API fields, UI labels, events, tests, and handoff. A synonym in explanatory
prose must not introduce a second domain concept.
