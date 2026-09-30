# NotifyRoute Agent Rules

- Treat `README.md` as the complete product contract.
- PostgreSQL is authoritative for routing, preferences, rate limits, idempotency, leases, provider receipts, events, and campaign state.
- Never log or expose recipient contact data beyond its published shape, endpoint secrets, provider credentials, or webhook signing material.
- Do not invent provider guarantees beyond the local provider double and README contract.
- Use the production HTTP API from the UI; browser state is never authoritative.
- Finish with a findings-first review, exact commands and results, risks, and checks not run.
