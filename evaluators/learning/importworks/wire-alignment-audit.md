# ImportWorks author wire audit

Scope: the existing 22 hidden cases, fixture factory, helper/runtime paths, execution and scoring wrappers. Authority is the frozen `task-packages/v2/importworks/public-contract/contract.json`, with business requirements preserved in `workspace/docs/frontal-legacy`. No submission or trajectory was inspected. Case IDs, weights, manifest, public contract, starter and requirements are unchanged.

Implemented alignment:

- Positive seeds now include required `importBundles` and `bundleMembers` arrays. The existing `db:seed -- --file` command remains; `allowFailure` never disables positive schema validation.
- Import creation sends only tenant/dataset/revision/mode/expected bytes/digest. Schema revision creation omits assigned schema identity and revision, and checks the returned assigned revision.
- Frozen-schema tests still publish a conflicting type revision, using legal `additionalProperties:false` and type-appropriate bounds. Old-schema validation and findings assertions remain.
- Fixture chunks and all bundle member position assertions start at zero. No member, upload or conflict case was removed.
- Snapshot uses `schemaVersion:1`, with no `asOf`. Snapshot event order is checked by public event identity; per-aggregate sequences remain unique. Retry byte comparisons group deliveries by DomainEvent identity so staged and published events are distinct legitimate messages.
- Missing snapshot authentication is the sole explicit malformed-wire exception (`D-03`); its 401/403 rejection check remains. The seed helper forwards only an explicitly supplied `contractExpectation`, without inferring it from failure handling.
- `A-03` now downloads the publicly declared report-content route and checks NDJSON media type, canonical finding bytes including final LF, and the metadata digest. OpenAPI route coverage includes content download. Fixed the missing `expectStatus` import in `B-02`.

Validation: `node --test test/evaluator-wire-importworks.test.mjs` passes five tests: complete registry/weights, all-case positive seeds and schema/request fixtures, 14 actual runtime/helper request shapes plus seed command, canonical report bytes/digest, and event identity/sequence ordering. These are author regression checks, not candidate business acceptance.

Release-review items retained:

- Existing `IW-GAP-01` blocked diagnostics remain in the frozen manifest even though V2 defines report content and `A-03` now checks it. UI download instrumentation remains a separate coverage gap; no diagnostic was silently removed.
- `IW-GAP-02` bundle refresh/history and `IW-GAP-03` precise pre-commit crash windows retain their existing diagnostics.
- The existing payload digest oracle hashes `JSON.stringify(payload)` whereas finding-value digests use canonical JSON. Preserved business text does not state the exact payload byte serialization; this requires review before treating disagreement on serialization as a formal business failure. No new serialization requirement was invented here.
- Live database, browser, recovery and performance runs were not performed by this worker. Parent owns isolated author validation, packaging/runtime locks and release certification.
