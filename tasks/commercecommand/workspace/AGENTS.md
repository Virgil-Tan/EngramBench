# CommerceCommand Engineering Rules

- Treat `README.md` as the complete product contract. Ask the user when the contract is genuinely ambiguous.
- Work in small, reviewable stages and report the command and result for every claimed verification.
- Keep HTTP handlers, domain transitions, persistence, workers, dispatch, and UI separated by explicit interfaces.
- Use PostgreSQL transactions and database-enforced constraints for cross-process correctness; in-memory locks are not authority.
- Store money only as integer minor units with an explicit currency. Never use floating point for commercial arithmetic.
- Make idempotency, leases, fencing, outbox identity, event identity, and migration behavior observable through public APIs and the verification snapshot.
- Do not weaken published thresholds, replace real tests with placeholders, or special-case fixture values.
- Never log tokens, payment credentials, provider secrets, webhook secrets, authorization headers, or raw private payloads.
- Preserve existing data, saved replays, event identities, and documented V1 clients when the Manager requirement arrives.
