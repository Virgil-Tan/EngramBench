# CreatorRightsExchange Delivery Rules

- Treat `README.md` as the complete product authority; ask before inventing behavior.
- Keep PostgreSQL authoritative for state, idempotency, leases, fences, ordering, money, and events.
- Store money as integer minor units and rights shares as integer basis points; never use binary floating point.
- Never log media bytes, access material, provider payloads, creator payout details, secrets, tokens, or private paths.
- Exercise real PostgreSQL, production Chromium, independent processes, barriers, and controlled `SIGKILL` in tests.
- Keep every command non-interactive, bounded, and responsible for cleaning up its own processes and files.
- Finish each stage with actual command evidence, remaining risks, and checks not run.

## Benchmark V2
Read contract/README.md. Preserve author-owned contract files. Implement real production business behavior, persistence, UI and verification in src/ and your own modules. Run public checks, then audit the entire README. No fake successful stubs or fixture-specific implementations.
