# AccessSentinel Agent Rules

- Treat `README.md` as the complete product contract. Do not invent product behavior.
- PostgreSQL is authoritative for sessions, device trust, policy and risk revisions, requests, grants, revocations, work, events, idempotency, and audit records.
- Keep API, worker, dispatcher, and production UI as independently runnable processes.
- Never log or persist raw refresh tokens, device challenges, signing material, credentials, authorization headers, or administrator tokens.
- Enforce tenant isolation, revision fences, leases, and state transitions transactionally; process-local locks and caches are not authority.
- Use only public interfaces in project-owned E2E, concurrency, recovery, and performance tests.
- Finish with a findings-first review, exact commands and results, residual risks, and checks not run.

## Benchmark V2
Read contract/README.md. Preserve author-owned contract files. Implement real production business behavior, persistence, UI and verification in src/ and your own modules. Run public checks, then audit the entire README. No fake successful stubs or fixture-specific implementations.
