# FraudLens Agent Rules

- Treat `README.md` as the complete public product contract.
- PostgreSQL is authoritative for events, rules, assessments, decisions, idempotency, leases, audit, and ordering.
- Keep historical rule versions, scores, RuleHits, reviews, decisions, and audit records immutable.
- Never expose raw device signals, provider credentials, private paths, or cross-tenant subject data.
- The production UI must use the public HTTP API; browser state is never authoritative.
- Finish with a findings-first review, exact commands and results, risks, and checks not run.

## Benchmark V2
Read contract/README.md. Preserve author-owned contract files. Implement real production business behavior, persistence, UI and verification in src/ and your own modules. Run public checks, then audit the entire README. No fake successful stubs or fixture-specific implementations.
