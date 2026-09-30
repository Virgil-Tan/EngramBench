# ConfigRelay Engineering Instructions

## Authority

- 'README.md' is the complete public product contract. Source, tests, and OpenAPI must agree with it.
- Do not infer future requirements or inspect paths outside this Git workspace.
- Use English for source identifiers, comments, documentation, migrations, API fields, and tests.

## Work method

- Begin with a plan and explicit module/process boundaries before editing.
- Deliver the smallest vertical slice that crosses browser, HTTP, PostgreSQL, worker, and visible state.
- Keep domain policy pure where practical; keep SQL, HTTP, process lifecycle, and filesystem effects at
  explicit adapters. Do not create speculative abstraction layers.
- Make each migration forward-only, repeatable, and safe against a populated database.
- Preserve unrelated user changes and avoid unrelated renaming, formatting, or dependency upgrades.

## Correctness boundaries

- PostgreSQL owns Deployment state, durable idempotency, work leases, ordering, and Domain Events.
- Never use an in-memory lock, timer, queue, cache, or singleton as correctness authority.
- Keep remote/file waits outside business transactions and re-prove lease ownership at commit.
- Treat every unknown HTTP or webhook outcome as retryable without changing operation identity.
- Validate untrusted input at HTTP, seed, worker-result, webhook, cursor, and file boundaries.

## Testing

- Use real PostgreSQL and public HTTP for integration tests and production Chromium for browser E2E.
- Multi-process tests must start distinct OS processes; calling two objects in one process is insufficient.
- Recovery tests use observable barriers before SIGKILL and verify durable state after restart.
- Performance results are valid only when post-load business invariants also pass.
- Run the narrowest relevant test first, then 'npm run test:all'; run 'npm run test:perf' after functional
  correctness is stable.

## Security and hygiene

- Bind services to localhost and never log tokens, credentials, idempotency keys, raw webhook payloads,
  private seed content, or absolute paths.
- Do not commit generated output, dependencies, browser reports, performance artifacts, database files,
  credentials, or temporary diagnostics.
- Do not weaken validation, timeouts, accessibility, or tests to make a failing check pass.

## Handoff

Report exact commands and outcomes, current migration and compatibility state, measured performance,
remaining risks, and unrun checks. Claims require visible evidence.
