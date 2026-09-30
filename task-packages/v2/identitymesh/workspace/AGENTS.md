# IdentityMesh Agent Rules

- Treat `README.md` as the complete product contract.
- PostgreSQL is authoritative for identities, sessions, devices, keys, revocations, idempotency, leases, and audit records.
- Never log credentials, session secrets, refresh tokens, private keys, or raw authentication assertions.
- Use cryptographically secure random values and constant-time comparison at security boundaries.
- Do not invent OAuth/OIDC provider behavior outside the local test double and README contract.
- Finish with a findings-first review, exact commands and results, risks, and checks not run.

## Benchmark V2
Read contract/README.md. Preserve author-owned contract files. Implement real production business behavior, persistence, UI and verification in src/ and your own modules. Run public checks, then audit the entire README. No fake successful stubs or fixture-specific implementations.
