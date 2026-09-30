# Learning V2 public contract audit — group B

Scope: `billforge`, `clinicgrid`, `configrelay`, `dispatchboard`, `notifyroute` and author-only `helpers-b.mjs`. `reconcilehub.mjs` was initially authored here and then transferred to group D; its subsequent audit belongs to that group. No original repository file or hidden fixture was edited or used to infer these public schemas.

## Authority and coverage

For each task, the complete public sources read were `task-packages/legacy/<task>/workspace/docs/frontal-legacy/README.md`, `manager-requirements.md`, and `task-packages/legacy/<task>/workspace/AGENTS.md`. The existing public `contracts/superhard/coldchaincontrol.mjs` and `templates/contract-first/{runtime,server,check}.mjs` supplied the contract format, not business answers.

| Task | Operations | Schemas | Public probes | Seed rows | Public route omissions |
| --- | ---: | ---: | ---: | ---: | ---: |
| billforge | 24 | 26 | 5 | 9 | 0 |
| clinicgrid | 18 | 21 | 5 | 5 | 0 |
| configrelay | 14 | 26 | 6 | 3 | 0 |
| dispatchboard | 15 | 23 | 6 | 4 | 0 |
| notifyroute | 24 | 26 | 5 | 7 | 0 |

Counts include health, OpenAPI, production HTML and verification snapshot operations. Route coverage was checked against every literal method/path in README and Manager, with query syntax removed. New routes where Manager names behavior but no path are explicitly marked as V2 wire clarifications. Every business operation has a request example and complete success schema; closed records forbid unspecified fields, while source-defined arbitrary JSON remains JSON.

## New V2 wire clarifications, not original requirements

- Shared: `/healthz` returns `{status:"ok"}`; successful unspecified statuses are 200; collection completion is `nextCursor:null`. Snapshot root is `{asOf,resources,work,events}` for these five tasks. BillForge and NotifyRoute had no exact event envelope; V2 publishes the common identity/sequence/type/time/version/object-payload envelope. ClinicGrid, ConfigRelay and DispatchBoard preserve their original exact `{}` event payload. HTML is explicitly `text/html`.
- BillForge: fully defines previously untyped Tenant, Customer, Plan, PriceVersion, Subscription, ExchangeRateSnapshot and LedgerAccount seed/resource fields; fixes creation bodies and provider webhook body. Disputes, resolution and adjustments receive new public paths and named resource shapes. Original invoice/payment/refund/ledger/settlement fields are retained, with Manager `CHARGEBACK`/`ADJUSTMENT` ledger reference kinds separately extended in snapshot output.
- ClinicGrid: calendar entries are `{appointmentId,startAt,endAt}` inside `{items}`; `resourceType` spellings are `clinician`, `room`, `equipmentUnit`. Care-plan visit mutations return CarePlan. Manager visit indices are one-based; the original `/waitlist-entries` spelling and disjoint single/multi-visit request shapes are preserved.
- ConfigRelay: assignment history is `{items:[Assignment]}`; acknowledgement returns the named Acknowledgement. Preserves published singleton selector `{labels:{key,value}}`, rather than silently accepting a different multi-predicate structure. Agent labels are a string map, consistent with its seed object notation. Legacy/staged response variants remain separate. Snapshot assignment, acknowledgement and rollout-command schemas omit `assignmentToken` entirely; they do not substitute a placeholder. Snapshot deliberately does not add `fleets`, which the original exact resource list excludes.
- DispatchBoard: legacy acceptance returns Assignment, aligning with the original performance success definition (README hot-offer-claims); team acceptance/readiness returns TeamAssignment. Original route prose says “ASSIGNED”, so the return-type ambiguity is made explicit. Idle `activeLoadUnits:0` is accepted: seed prose's “positive load” conflicts with its published zero-assignment performance setup. Actual assignment load and capacity remain positive. Legacy and Manager delivery/offer variants remain distinct.
- NotifyRoute: fully defines previously untyped Tenant and Template fields; fixes consent scope/revision inputs; defines reproducible template-content digest as SHA-256 of canonical `{channel,subject,body}`. Campaign creation/get return `{campaign,campaignRecipients}`, controls return Campaign, and the new campaign paths and snapshot resources are explicit V2 additions. Input recipient duplicates are accepted because Manager expressly requires audience deduplication.

These definitions fix transport representation only. They do not supply allocation, matching, billing, consent fencing, provider reconciliation, team activation, rollout, recovery or persistence implementations.

## Nonempty public checks

- BillForge: tenant/customer/plan/price/subscription/exchange-rate/ledger-account graph; create a new tenant and verify that identity in the snapshot. Financial operations are not asserted while their calculation inputs are underspecified.
- ClinicGrid: future clinician, room, equipment, patient and service graph; create a hold and read the returned appointment identity. No timing-sensitive state assertion is made after the hold response.
- ConfigRelay: fleet/configuration/agent graph with a reproducible canonical digest; read agent, create the next configuration, and check its captured revision/content in snapshot.
- DispatchBoard: complete symmetric one-zone distance graph, customer and idle courier; create delivery and read its captured identity. Uses a local receiver example, not a real courier endpoint.
- NotifyRoute: tenant/recipient/endpoint/template/version/route/rate-limit graph; unsubscribe the recipient and verify the captured active Suppression. Seed creates no provider sends.

All identifiers use an independent `b2...` UUID namespace; fixed times and sample contents were independently authored. Seed uses the unchanged V1 root array names, not Manager-only arrays. Same-version/same-digest replay is supported by each of these original public requirements.

## Unresolved source issues

1. **BillForge:** price/tax/discount/exchange-rate freezing is required, but no tax/discount configuration route or seed collection is specified. Proration units, rounding, tax calculation rounding and discount allocation are also not uniquely specified. No formula, invented tax collection or hidden expected monetary answer is introduced. Full financial correctness needs a separately published business decision, not an adapter.
2. **NotifyRoute:** template variable grammar and exact canonical provider/HMAC-signature body composition are not published. The new transport fixes the content digest but does not choose a rendering language or manufacture provider guarantees.
3. **ConfigRelay:** prose mentions AND label matching, while the exact selector declares one `{key,value}` pair; no encoding for several predicates is given. The contract preserves the literal singleton schema. An extension to several predicates requires a separately published shape.
4. **Manager delivery stage:** these Manager texts end by requesting impact analysis/planning before implementation. The present user separately authorized a complete V2 interface scaffold. New Manager HTTP definitions are therefore V2 work, not a claim that original V1 already supplied complete executable interfaces.

## Validation boundary

Validated with the V2 Ajv-backed public contract validator and independent per-parameter compilation: every named schema compiles; each seed example and every operation request/parameter example validates. Literal README/Manager route coverage has no omissions. Public smoke captures and interpolation use the parent-owned generic format. No task business API, PostgreSQL business implementation, provider double, browser or hidden evaluator was run by this author. Static schema success is not business correctness, full semantic completeness, or proof that copied V1 hidden fixtures agree with V2 clarifications.

Follow-up: the parent implemented union-aware capture validation. All five complete public contracts now pass it without weakening Delivery/TeamDelivery schemas.

## Follow-up local transport review

Published `transportErrors` metadata now carries the original common codes: ClinicGrid, ConfigRelay and DispatchBoard specify `ADMIN_AUTH_REQUIRED`, `UNKNOWN_FIELD`, `INVALID_REQUEST`, `MALFORMED_JSON` and `UNSUPPORTED_MEDIA_TYPE` with their original statuses; BillForge and NotifyRoute override only their explicitly published `INVALID_REQUEST`. Unspecified generic codes are not inferred from unrelated business errors.

The independent `test/contract-b-compat.test.mjs` exercises all five contracts, metadata, parameter coercion, normalized headers, success statuses, and negative public probes. Actual localhost HTTP fixtures confirm that 501 stubs and structurally valid empty snapshots fail. The existing `test/wire.test.mjs` also passes its actual-router upload/206/304/HTML tests. These are transport-only toy fixtures, not task solutions. Lifecycle build/migrate/seed/worker/dispatcher invocation was inspected without executing a task database workload.

Reported shared-layer findings include malformed percent-encoded path handling, the TypeScript declaration of coerced path parameters, response media-type validation, and classification of invalid known `anyOf` branches versus truly unknown JSON fields. The independent regression file records the media-type and union-classification expectations; the template owner implements those changes. No shared template is edited by this author.
