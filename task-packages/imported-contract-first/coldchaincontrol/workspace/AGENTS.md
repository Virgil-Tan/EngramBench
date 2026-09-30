# ColdChainControl Working Agreement

- `README.md` is the complete public contract. Do not infer hidden requirements.
- Build a production-shaped TypeScript application with PostgreSQL as the durable authority and React as the production UI.
- Keep API, worker, and dispatcher as independently startable processes. Process-local state cannot be correctness authority.
- Treat device credentials, tenant data, provider payloads, and operational telemetry as sensitive. Never log secrets or expose them in verification snapshots.
- Use database transactions, database time, durable idempotency, fenced leases, and a transactional outbox where the public contract requires them.
- Published project commands must run real checks. Placeholder, mocked-database, or always-green gates are not acceptable.
- Preserve existing behavior when a later Manager message adds requirements. That message is public only when the user publishes it.
- Report actual commands and outcomes. Do not claim checks that were not run.

## Version 4 fixed public interface, free implementation

Read contract/README.md before implementation. Preserve author-owned specifications/checks and public command names, but freely replace starter modules, router, directories, build configuration and command bodies. Implement the full README with real business behavior. Passing the public create → operation → query check is necessary but never sufficient for task completion. Do not modify the public checker or return fixture-only/mock responses.
