# MediaDock Agent Rules

- Treat `README.md` as the complete product contract.
- PostgreSQL is authoritative for upload state, parts, object references, scan/transcode jobs, grants, leases, cleanup, events, and idempotency.
- Store bytes only below `MANAGED_DATA_ROOT`; reject traversal and never expose host paths.
- Never log raw grant tokens, storage paths, signing material, scanner payloads, or another tenant's deduplication facts.
- Do not invent scanner or transcoder behavior outside the deterministic local doubles in README.
- Finish with a findings-first review, exact commands and results, risks, and checks not run.
