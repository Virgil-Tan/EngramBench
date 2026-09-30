# Public V2 contract audit — ten learning tasks

Scope: the complete public `README.md`, `manager-requirements.md`, and workspace `AGENTS.md` for each task under the old repository's `task-packages/legacy/<task>/workspace/`. The old repository was read-only. No private evaluator, hidden case, submission, or hidden answer was used to author these V2 contracts. All seed identities, names, geometry, rules and bytes are independent public examples.

## Coverage and static verification

| Task | Distinct original published routes, including Manager | V2 operations | Named schemas |
| --- | ---: | ---: | ---: |
| launchpass | 13 | 16 | 11 |
| schemaharbor | 17 | 18 | 20 |
| importworks | 19 | 21 | 22 |
| rulebench | 19 | 20 | 24 |
| auctionguard | 12 | 13 | 19 |
| queueforge | 18 | 19 | 20 |
| ledgerbridge | 11 | 12 | 17 |
| geopulse | 17 | 18 | 21 |
| mediadock | 21 | 28 | 33 |
| quotamesh | 20 | 21 | 19 |

All **186 operations** have a fixed successful response schema and an independent request example. Operations without a request body explicitly declare `requestBody:'none'`. Parameter schemas cover path identities and published queries/headers. Structural checks compiled every named schema, request, response, and parameter with Ajv 2020; every seed example and operation request/parameter example passed. UUID and UTC date-time formats were installed, and `multipleOfPrecision:9` was used for decimal coordinates. Public source route extraction, normalizing `{name}` and `:name` parameters, found no missing original routes.

Every seed contains a legal nonempty domain graph, not merely empty arrays. Every smoke checks seeded resource identities through a real snapshot/read and an independent write followed by a read. GeoPulse also executes a nonempty interior point query; ImportWorks writes actual independent upload bytes and reads their recorded coverage. These are structural and minimal live-contract probes, not complete business acceptance, concurrency, recovery, or performance tests. No service, database, or benchmark was started for this audit.

## Explicit V2 wire additions

- All tasks give the production UI an explicit `/` HTML operation. LaunchPass adds `/openapi.json` and the admin verification snapshot; it retains its original `/api/health`.
- ImportWorks fixes Schema/SchemaRevision input fields, byte-range response additions, and exposes the previously unwired report download at `GET /api/v1/imports/:importId/error-report/content`. Its exact NDJSON bytes and digest definition are public. The original ban on unknown imported row fields is retained.
- RuleBench fixes RuleSet, version creation, conflict rows and digest bytes. `evaluationInputs` is an explicit **seed-only** companion to imported Evaluation metadata, permitting original facts to be restored for replay/comparison without adding facts to public snapshots. Manager comparison digest definitions are unchanged.
- GeoPulse fixes Tenant/Device/Region, bundle selection, and no-bundle V1 behavior. Optional `bundleId` disambiguates multiple published bundles; no bundle still selects RegionVersions by event/point time. Query results use the Manager's exact envelope, with nullable bundleRevisionId for the preserved V1 path. This is a new public choice, not an assertion that the old contract specified it.
- MediaDock fixes scanner/cleanup resource schemas, profile-revision creation, and all Manager alias/publish/resolve/grant wires. It publishes raw binary transport and alternate success status schemas, and preserves metadata-only seeds. Manager requirements supplied no concrete routes or full new resource fields; all such additions are explicitly labelled in contract notes.
- Other task-local clarifications are recorded in their `notes`; no adapter or domain implementation is included.

## Original contradictions or lifecycle exceptions

1. **QueueForge: unresolved original performance conflict.** The published policy permits maxRuns 1..20, while a published performance scenario uses 25. The V2 schema retains the explicit domain maximum 20. The performance scenario must be publicly corrected or the domain maximum publicly changed before running that scenario. The contract does not silently accommodate an invalid private/public test input.
2. **AuctionGuard: explicit snapshot/detail distinction.** The FINAL snapshot text still literally lists the old Auction/Bid/Outcome projections while Manager detail responses extend them. The contract preserves the literal snapshot projection and fixes the expanded detail response separately; these are not interchangeable.
3. **MediaDock: public signature conflict resolved explicitly for V2.** Exact ScanJob includes signature, but virus-scan/privacy prose forbids signatures in public persisted data. V2 keeps the field and fixes it to null in public outputs/seeds, while scanner input may accept a private signature. This is recorded as a new public resolution, not a hidden evaluator assumption.
4. **LaunchPass: seed is not replay-idempotent.** Original README requires importing into empty application tables and rejecting a second import. Contract sets `seed.replay:false` and `seed.command:['npm','run','seed','--','--file','${SEED_PATH}']`. Migration remains `npm run db:migrate`; production remains `npm start`. There are no original independent worker/dispatcher commands; the application must run durable expiration/promotion without traffic.

## Fixed-shell integration obligations

- Honor `requestBody:'none'`, rejecting nonempty bodies; GET/HEAD must not accept request bytes either.
- Honor operation `parameters` without generating duplicate path parameter entries. Validate query/header/path values, including numeric coercion from HTTP text according to their declared schemas.
- Support raw request and response `contentMediaType`, including ImportWorks `application/x-ndjson`, MediaDock `application/octet-stream`, and HTML. Binary bodies are bytes at the implementation seam, not JSON/base64 responses.
- Honor `successStatuses` and `successResponses`, including no-body HEAD/304 and partial 206; media response headers carry the range/digest contract.
- Execute the confirmed smoke format: response `capture` paths; recursive `${name}` interpolation; `expectContains` exact-one subset matches. Do not replace these with submission-specific adapters.
- Respect LaunchPass's seed command/replay setting and original production lifecycle. A universal “seed twice, start worker, start dispatcher” sequence would be wrong for that task.

No files outside the new repository's `contracts/learning/` were changed by this subtask. The helpers are `helpers-a.mjs` and `helpers-a2.mjs`; they build contract data only.
