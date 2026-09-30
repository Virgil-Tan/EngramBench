# CreatorRightsExchange Delivery Rules

- Treat `README.md` as the complete product authority; ask before inventing behavior.
- Keep PostgreSQL authoritative for state, idempotency, leases, fences, ordering, money, and events.
- Store money as integer minor units and rights shares as integer basis points; never use binary floating point.
- Never log media bytes, access material, provider payloads, creator payout details, secrets, tokens, or private paths.
- Exercise real PostgreSQL, production Chromium, independent processes, barriers, and controlled `SIGKILL` in tests.
- Keep every command non-interactive, bounded, and responsible for cleaning up its own processes and files.
- Finish each stage with actual command evidence, remaining risks, and checks not run.

## Version 4 fixed public interface, free implementation

Read contract/README.md before implementation. Preserve author-owned specifications/checks and public command names, but freely replace starter modules, router, directories, build configuration and command bodies. Implement the full README with real business behavior. Passing the public create → operation → query check is necessary but never sufficient for task completion. Do not modify the public checker or return fixture-only/mock responses.
