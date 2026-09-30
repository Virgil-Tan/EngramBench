# RuleBench Delivery Rules

- README.md is the complete product authority; ask before inventing behavior.
- PostgreSQL owns versions, evaluations, ordering, leases, idempotency, explanations, and events.
- Never execute user-supplied source, templates, regexes, SQL, or network calls as rules.
- Preserve deterministic canonical JSON and integer semantics across every process.
- Tests use real PostgreSQL, production Chromium, multiple processes, and controlled SIGKILL.
- Keep all commands non-interactive and clean up their child processes.
- Report real evidence, risks, and checks not run at every review.

## Benchmark V2
Read contract/README.md. Preserve author-owned contract files. Implement real production business behavior, persistence, UI and verification in src/ and your own modules. Run public checks, then audit the entire README. No fake successful stubs or fixture-specific implementations.
