# RoutePilot Agent Rules

- Treat `README.md` as the complete product contract.
- PostgreSQL is authoritative for releases, routing decisions, rate windows, circuit windows, leases, idempotency, and events.
- Never log or expose upstream credentials, admin tokens, internal origin URLs, private headers, or cross-tenant state.
- The UI uses only the production HTTP API; process memory and browser state are never authority.
- Do not invent upstream guarantees beyond the published local upstream double.
- Finish with a findings-first review, exact commands and results, remaining risks, and checks not run.

## Benchmark V2
Read contract/README.md. Preserve author-owned contract files. Implement real production business behavior, persistence, UI and verification in src/ and your own modules. Run public checks, then audit the entire README. No fake successful stubs or fixture-specific implementations.
