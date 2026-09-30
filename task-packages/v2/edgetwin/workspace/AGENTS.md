# EdgeTwin Agent Rules

- Treat `README.md` as the complete product contract.
- PostgreSQL is authoritative for shadows, commands, expiry, receipts, campaigns, leases, idempotency, and events.
- Never infer device success from dispatch, receipt arrival order, or process memory.
- Never expose device credentials, firmware signing material, private broker endpoints, admin tokens, or cross-tenant state.
- The production UI uses only the public HTTP API.
- Finish with a findings-first review, exact commands and results, remaining risks, and checks not run.

## Benchmark V2
Read contract/README.md. Preserve author-owned contract files. Implement real production business behavior, persistence, UI and verification in src/ and your own modules. Run public checks, then audit the entire README. No fake successful stubs or fixture-specific implementations.
