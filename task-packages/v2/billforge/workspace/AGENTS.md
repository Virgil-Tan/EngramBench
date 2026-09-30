# BillForge Agent Rules

- Treat `README.md` as the complete product contract.
- Use PostgreSQL as the authority for billing, payments, refunds, ledger entries, idempotency, leases, and events.
- Use integer minor currency units and UTC timestamps; never use floating point for money.
- The payment provider is a local test double exposed by the task environment. Do not call real payment services.
- Do not invent behavior outside the README or an explicit Manager request.
- Finish with a findings-first review, exact commands and results, risks, and checks not run.

## Benchmark V2
Read contract/README.md. Preserve author-owned contract files. Implement real production business behavior, persistence, UI and verification in src/ and your own modules. Run public checks, then audit the entire README. No fake successful stubs or fixture-specific implementations.
