# RoutePilot Agent Rules

- Treat `README.md` as the complete product contract.
- PostgreSQL is authoritative for releases, routing decisions, rate windows, circuit windows, leases, idempotency, and events.
- Never log or expose upstream credentials, admin tokens, internal origin URLs, private headers, or cross-tenant state.
- The UI uses only the production HTTP API; process memory and browser state are never authority.
- Do not invent upstream guarantees beyond the published local upstream double.
- Finish with a findings-first review, exact commands and results, remaining risks, and checks not run.
