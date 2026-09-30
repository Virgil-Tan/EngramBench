# RouteWeave Agent Rules

- Treat `README.md` as the complete product contract.
- PostgreSQL and immutable ScanEvents are authoritative; projections must be reproducible from them.
- Never rewrite source evidence to repair an arrival-order bug or use process memory for tracking state.
- Never log carrier credentials, private facility metadata, admin tokens, or cross-tenant tracking data.
- The production UI uses only public HTTP APIs.
- Finish with a findings-first review, exact commands and results, risks, and checks not run.

## Benchmark V2
Read contract/README.md. Preserve author-owned contract files. Implement real production business behavior, persistence, UI and verification in src/ and your own modules. Run public checks, then audit the entire README. No fake successful stubs or fixture-specific implementations.
