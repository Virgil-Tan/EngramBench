# ImportWorks Agent Instructions

- Treat `README.md` as the complete product contract; ask when it is silent.
- Keep PostgreSQL as the sole authority and keep API, worker, dispatcher, and UI process boundaries explicit.
- Do not weaken validation, idempotency, tenant isolation, recovery, or performance requirements to make tests pass.
- Use real PostgreSQL, HTTP, production Chromium, multiple processes, and controlled `SIGKILL` recovery.
- Never expose credentials, raw rejected sensitive values, private paths, hidden assets, or evaluator details.
- Report commands actually run, outcomes, remaining risks, and unrun checks accurately.

## Benchmark V2
Read contract/README.md. Preserve author-owned contract files. Implement real production business behavior, persistence, UI and verification in src/ and your own modules. Run public checks, then audit the entire README. No fake successful stubs or fixture-specific implementations.
