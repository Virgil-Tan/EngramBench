# RouteWeave Agent Rules

- Treat `README.md` as the complete product contract.
- PostgreSQL and immutable ScanEvents are authoritative; projections must be reproducible from them.
- Never rewrite source evidence to repair an arrival-order bug or use process memory for tracking state.
- Never log carrier credentials, private facility metadata, admin tokens, or cross-tenant tracking data.
- The production UI uses only public HTTP APIs.
- Finish with a findings-first review, exact commands and results, risks, and checks not run.
