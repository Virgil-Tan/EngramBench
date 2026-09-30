# LaunchPass Engineering Instructions

## Scope and authority

- Work only inside this repository.
- Do not inspect parent directories, credentials, other workspaces, or unrelated processes.
- The current user request, this file, `README.md`, and `openapi.yaml` define the public contract.
- A later explicit user requirement overrides older project documentation. Update README, OpenAPI,
  implementation, and tests when that happens.
- Never hardcode sample IDs, seed values, expected test sequences, environment-specific responses,
  or behavior that only works for one fixture.

## Required technology

- Use Node.js 22 and TypeScript for application and test code.
- Use React for the browser application.
- Use PostgreSQL 16 as the durable business-state authority.
- Do not require Redis, another database, a message broker, or a hosted runtime service.
- Keep dependencies and module boundaries proportional to the problem.

## Working method

- Start by reading the complete public specification and producing a phased plan.
- Explain module responsibilities, interfaces, ownership, and data flow before major implementation.
- Implement one coherent infrastructure or vertical slice at a time.
- Keep the application runnable after each completed stage.
- When implementation or tests fail, diagnose and fix the problem yourself. Do not ask the user for
  code or debugging hints.
- Review existing code before introducing another abstraction, dependency, or duplicate path.
- Use English for source identifiers, comments, API names, schemas, and technical documentation.

## Contract discipline

- Treat root `openapi.yaml` as the canonical machine-readable HTTP contract.
- Keep runtime validation, TypeScript types, tests, OpenAPI, and README behavior aligned.
- Validate every trust boundary.
- Reject unknown fields, malformed input, unsafe numeric values, and unsupported media types as
  required by README.
- Do not silently coerce, truncate, repair, or ignore invalid client input.
- Use stable machine-readable error codes.
- Never include stack traces, SQL text, authorization values, database URLs, credentials, or internal
  paths in client errors or logs.

## Data and concurrency

- PostgreSQL is the authority for event capacity, holds, orders, idempotency, and other durable
  workflow state.
- Assume multiple application processes operate on the same records concurrently.
- Do not rely on process-local locks, timers, caches, or queues for correctness.
- Make business mutations durable and preserve their invariants across retries, races, failures, and
  restarts.
- Treat correctness as more important than throughput. Optimize only after measuring a correct
  implementation.
- Version every schema change through migrations; do not require manual database edits.

## Frontend

- Implement complete user flows against the real API.
- Include visible loading, empty, validation, conflict, expiry, and unexpected-error states.
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
npm run test:all
npm run test:perf
```

- Unit tests may isolate pure logic.
- Integration tests must use real PostgreSQL and the real HTTP boundary.
- Browser E2E tests must use the production build and a real browser.
- Concurrency tests must include multiple application processes sharing one database.
- Performance tests must report latency, throughput, error rate, and post-load correctness.
- Tests must be deterministic, non-interactive, repeatable, and isolated from development data.
- Do not weaken assertions, skip failing cases, replace integration coverage with mocks, or
  special-case test inputs to make a gate pass.
- Run the smallest relevant gate after each change, then run the complete gate before delivery.

## Repository hygiene

- Do not commit credentials, local database state, dependency directories, logs, screenshots, traces,
  coverage output, generated load-test reports, or temporary debugging artifacts.
- Commit the npm lockfile and keep clean `npm ci` installation reproducible.
- Keep generated build output out of source control unless the public task explicitly requires it.
- Avoid unrelated refactors, dependency upgrades, formatting sweeps, and speculative infrastructure.
- Document a known limitation instead of hiding incomplete behavior or claiming unrun verification.

## Handoff

Before declaring completion:

- run migrations against a clean database;
- run the versioned seed import;
- build and start the production application;
- run all project-owned functional tests;
- verify operation with at least two application processes;
- run and record the performance test;
- update README and OpenAPI to the delivered behavior;
- report exact verification commands, results, and any remaining risks.
