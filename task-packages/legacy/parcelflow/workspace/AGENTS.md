# ParcelFlow Engineering Instructions

## Scope and authority

- Work only inside this repository.
- Do not inspect parent directories, credentials, other workspaces, or unrelated processes.
- The current user request, this file, `README.md`, and `openapi.yaml` define the public contract.
- A later explicit user requirement overrides older project documentation. Update README, OpenAPI,
  implementation, migrations, and tests when that happens.
- Never hardcode sample IDs, seed values, expected test sequences, environment-specific responses,
  or behavior that only works for one fixture.

## Required technology

- Use Node.js 22 and TypeScript for application and test code.
- Use React for the browser application.
- Use PostgreSQL 16 as the durable authority for business and workflow state.
- Do not require Redis, another database, a message broker, a hosted service, or external network
  access.
- Keep dependencies and module boundaries proportional to the problem.

## Working method

- Read the complete public specification before producing a phased plan.
- Explain module responsibilities, interfaces, ownership, and data flow before major implementation.
- Implement one coherent infrastructure or vertical slice at a time.
- Keep the application runnable after each completed stage.
- When implementation or tests fail, diagnose and fix the problem yourself. Do not ask the user for
  code or debugging hints.
- Review existing code before introducing another abstraction, dependency, or duplicate path.
- Use English for source identifiers, comments, API names, schemas, and technical documentation.

## Contract discipline

- Treat root `openapi.yaml` as the canonical machine-readable HTTP and webhook contract.
- Keep runtime validation, TypeScript types, tests, OpenAPI, and README behavior aligned.
- Validate every trust boundary.
- Reject unknown fields, malformed input, unsafe numeric values, unsupported media types, and invalid
  cursors as required by README.
- Do not silently coerce, truncate, repair, or ignore invalid input.
- Use stable machine-readable error codes.
- Never include stack traces, SQL text, authorization values, database URLs, webhook URLs,
  credentials, or internal paths in client errors or logs.

## Data and concurrency

- PostgreSQL is the authority for inventory, allocations, orders, fulfillments, dispatch work,
  shipments, idempotency, events, and webhook delivery progress.
- Assume multiple API, worker, and dispatcher processes operate on the same records concurrently.
- Do not rely on process-local locks, timers, caches, or queues for correctness.
- Preserve every business invariant across retries, races, unknown response outcomes, process kills,
  and restarts.
- Commit business state, its domain event, and the required outbox work atomically.
- Make abandoned dispatch and delivery work recoverable without duplicate business effects.
- Preserve event identity and per-order sequence across every webhook retry.
- Version every schema change through migrations; do not require manual database edits.
- Treat correctness as more important than throughput. Optimize only after measuring a correct
  implementation.

## Frontend

- Implement complete user flows against the real API.
- Include visible loading, empty, validation, allocation-conflict, cancellation-conflict, retry, and
  unexpected-error states.
- Poll or refresh durable server state while fulfillment is pending; do not invent client-side
  completion.
- Use semantic HTML, accessible labels, keyboard interaction, visible focus, and responsive layouts.
- Do not replace production browser behavior with mocked data.
- Do not expose `ADMIN_TOKEN` or other credentials in browser assets.

## Testing

The repository must own and maintain all of these gates:

```sh
npm run test:unit
npm run test:integration
npm run test:e2e
npm run test:concurrency
npm run test:recovery
npm run test:all
npm run test:perf
```

- Unit tests may isolate pure logic.
- Integration tests must use real PostgreSQL and real HTTP/process boundaries.
- Browser E2E tests must use the production build and real Chromium.
- Concurrency tests must include two API and two worker processes sharing one database.
- Recovery tests must kill real processes and prove durable continuation and idempotent results.
- Webhook tests must use a real local HTTP receiver and exercise non-`2xx`, timeout, duplicate, and
  ordering behavior.
- Performance tests must report latency, throughput, status counts, recovery progress, and post-load
  correctness.
- Tests must be deterministic, non-interactive, repeatable, and isolated from development data.
- Do not weaken assertions, skip failing cases, replace integration coverage with mocks, or
  special-case test inputs to make a gate pass.
- Run the smallest relevant gate after each change, then run the complete gates before delivery.

## Repository hygiene

- Do not commit credentials, local database state, dependency directories, logs, screenshots,
  traces, coverage output, generated load reports, or temporary debugging artifacts.
- Commit the npm lockfile and keep clean `npm ci` installation reproducible.
- Keep generated build output out of source control unless the public task explicitly requires it.
- Avoid unrelated refactors, dependency upgrades, formatting sweeps, and speculative infrastructure.
- Document a known limitation instead of hiding incomplete behavior or claiming unrun verification.

## Handoff

Before declaring completion:

- run migrations against a clean database;
- run the versioned seed import at its required scale;
- build and start the production API and UI;
- start two workers and the webhook dispatcher;
- run all project-owned functional, concurrency, and recovery tests;
- run and record the performance test;
- update README and OpenAPI to the delivered behavior;
- report exact verification commands, results, and any remaining risks.
