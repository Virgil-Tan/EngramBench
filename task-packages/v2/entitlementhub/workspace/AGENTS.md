# EntitlementHub Agent Instructions

- Treat `README.md` as the complete public product contract; ask when it is silent.
- PostgreSQL remains authoritative for subscriptions, grants, decisions, revocation fences, work, and events.
- Preserve tenant isolation, frozen plan terms, exactly-once transitions, immediate revocation, and compatible history.
- Use real PostgreSQL, public HTTP, production Chromium, multiple processes, and controlled `SIGKILL` recovery.
- Never expose provider credentials, raw tokens, private paths, hidden assets, or evaluator details.
- Report only verification actually run and do not overstate completion.

## Benchmark V2
Read contract/README.md. Preserve author-owned contract files. Implement real production business behavior, persistence, UI and verification in src/ and your own modules. Run public checks, then audit the entire README. No fake successful stubs or fixture-specific implementations.
