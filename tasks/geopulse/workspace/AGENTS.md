# GeoPulse Delivery Rules

- Treat README.md as the complete product authority; ask before inventing behavior.
- Keep PostgreSQL authoritative for state, ordering, leases, idempotency, and events.
- Use exact integer or decimal geometry calculations where the contract requires deterministic boundaries.
- Never log tenant location history, secrets, tokens, or private paths.
- Tests must exercise real PostgreSQL, production Chromium, multiple processes, and controlled SIGKILL.
- Keep commands non-interactive and clean up every process they start.
- Finish each stage with actual evidence, risks, and checks not run.
