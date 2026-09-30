# SeatReserve Agent Rules

- Treat `README.md` as the complete public product contract.
- PostgreSQL is authoritative for seats, holds, prices, orders, payments, idempotency, leases, events, and availability.
- Preserve all-or-nothing seat ownership and never infer availability from process memory or the browser.
- Never expose provider credentials, raw payment payloads, private paths, or cross-tenant customer data.
- The production UI uses only the public HTTP API and displays server-authoritative expiry.
- Finish with a findings-first review, exact commands and results, risks, and checks not run.

## Benchmark V2
Read contract/README.md. Preserve author-owned contract files. Implement real production business behavior, persistence, UI and verification in src/ and your own modules. Run public checks, then audit the entire README. No fake successful stubs or fixture-specific implementations.
