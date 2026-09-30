# EdgeTwin Agent Rules

- Treat `README.md` as the complete product contract.
- PostgreSQL is authoritative for shadows, commands, expiry, receipts, campaigns, leases, idempotency, and events.
- Never infer device success from dispatch, receipt arrival order, or process memory.
- Never expose device credentials, firmware signing material, private broker endpoints, admin tokens, or cross-tenant state.
- The production UI uses only the public HTTP API.
- Finish with a findings-first review, exact commands and results, remaining risks, and checks not run.
