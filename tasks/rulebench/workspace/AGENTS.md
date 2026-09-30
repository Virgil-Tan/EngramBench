# RuleBench Delivery Rules

- README.md is the complete product authority; ask before inventing behavior.
- PostgreSQL owns versions, evaluations, ordering, leases, idempotency, explanations, and events.
- Never execute user-supplied source, templates, regexes, SQL, or network calls as rules.
- Preserve deterministic canonical JSON and integer semantics across every process.
- Tests use real PostgreSQL, production Chromium, multiple processes, and controlled SIGKILL.
- Keep all commands non-interactive and clean up their child processes.
- Report real evidence, risks, and checks not run at every review.
