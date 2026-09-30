# GeoPulse Delivery Rules

- Treat README.md as the complete product authority; ask before inventing behavior.
- Keep PostgreSQL authoritative for state, ordering, leases, idempotency, and events.
- Use exact integer or decimal geometry calculations where the contract requires deterministic boundaries.
- Never log tenant location history, secrets, tokens, or private paths.
- Tests must exercise real PostgreSQL, production Chromium, multiple processes, and controlled SIGKILL.
- Keep commands non-interactive and clean up every process they start.
- Finish each stage with actual evidence, risks, and checks not run.

## Benchmark V2
Read contract/README.md. Preserve author-owned contract files. Implement real production business behavior, persistence, UI and verification in src/ and your own modules. Run public checks, then audit the entire README. No fake successful stubs or fixture-specific implementations.
