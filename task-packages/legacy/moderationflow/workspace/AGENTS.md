# ModerationFlow Agent Rules

- Treat `README.md` as the complete product contract.
- PostgreSQL is authoritative for content, evidence versions, policy versions, review state, decisions, appeals, leases, events, and audit ordering.
- Never mutate frozen evidence, policy versions, decisions, appeal lineage, or audit entries.
- Never expose private evidence payloads, reviewer credentials, signing material, private paths, or cross-tenant data.
- The production UI uses only the public HTTP API; browser state is never authoritative.
- Finish with a findings-first review, exact commands and results, risks, and checks not run.
