# ArtifactVault Context

ArtifactVault models atomic content-addressed artifact publication. This vocabulary is authoritative for the public contract,
dialogue, checklist, and evaluator design.

| Term | Canonical definition | Avoid |
| --- | --- | --- |
| Package | A stable namespace and name owning ordered Artifact Versions. | Project, repository |
| Artifact Version | Immutable metadata plus one content-addressed Blob in V1. | Release, file |
| Blob | Bytes identified by lowercase SHA-256 and exact size. | Artifact, upload |
| Upload Session | A durable bounded staging record for sequential byte ranges. | Temporary file, request |
| Verification Task | Durable leased work that hashes staged bytes and commits or rejects the version. | Job, scanner |
| Blob Reference | A durable ownership edge preventing collection of committed content. | Path, pointer |

## State language

Upload: STAGING -> VERIFYING -> COMMITTED | REJECTED, or STAGING -> ABANDONED; committed Artifact Versions are immutable.

## Core invariants

1. A committed Artifact Version has exactly one readable Blob whose size and digest match metadata.
2. A rejected or abandoned Upload creates no Artifact Version or Blob Reference.
3. Package version identifiers are unique and committed content never changes.
4. A Blob with one or more committed references is never garbage-collected.
5. Retrying a byte range with identical bytes is a replay; different bytes for the same range are rejected.

Use these exact terms in API fields, UI labels, events, tests, and handoff. A synonym in explanatory
prose must not introduce a second domain concept.
