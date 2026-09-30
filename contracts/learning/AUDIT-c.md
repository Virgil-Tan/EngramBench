# Public contract audit: group C

Scope: ArtifactVault, ExportVault, FirmwareFleet, ConfigOrbit, EntitlementHub,
ModerationFlow, FraudLens, IdentityMesh, SeatReserve and RoutePilot.

Only new `contracts/learning/*.mjs` files and this audit were edited. The legacy
repository was read-only. The specification sources were each task's complete
`task-packages/legacy/<task>/workspace/docs/frontal-legacy/README.md`, complete
`manager-requirements.md` (including the seven one-line Manager documents), and
`workspace/AGENTS.md`. The existing public ColdChainControl author contract and
contract-first runtime, server and checker were read as format references.
During initial specification design, no private evaluator, hidden tests, private
fixture, solution implementation, benchmark run, or server was inspected or
executed. A later, separately requested read-only evaluator-alignment inspection
began only after the ten contracts were frozen; it did not alter their public
definitions and was interrupted when the additional five-task assignment arrived.

## Completed validation

`validatePublicContract` from the new repository compiled all resource schemas,
each seed schema/example, all operation request and success schemas, additional
success response schemas, and every mutation's public example. It also checked
operation identity, path construction and nonempty seed/smoke requirements.
An additional check generated OpenAPI for every operation, validated supplied
path/query/header examples, rejected an unknown seed member, and rejected an
empty snapshot resource object. All ten contracts passed without schema-format
warnings. No live implementation success is implied by these author checks.

| Task | Operations | Public probes | Schemas | Missing published routes |
| --- | ---: | ---: | ---: | ---: |
| artifactvault | 18 | 8 | 25 | 0 |
| exportvault | 13 | 7 | 25 | 0 |
| firmwarefleet | 16 | 9 | 26 | 0 |
| configorbit | 20 | 6 | 19 | 0 |
| entitlementhub | 23 | 6 | 22 | 0 |
| moderationflow | 21 | 6 | 21 | 0 |
| fraudlens | 18 | 6 | 20 | 0 |
| identitymesh | 25 | 6 | 25 | 0 |
| seatreserve | 25 | 8 | 24 | 0 |
| routepilot | 29 | 7 | 24 | 0 |
| Total | 208 | 69 | 231 | 0 |

Route coverage was checked by extracting literal HTTP method plus public route
occurrences from both source documents, expanding `GET/POST`, stripping query
names, and comparing with the final operation set. Provider-double routes are
external protocols, not application routes. Every task also publishes the
production UI root. IdentityMesh additionally publishes four explicitly marked
V2 quarantine routes because its Manager document gave behavior but no routes.
Health/OpenAPI are present even in the three source documents that mention their
paths without repeating the HTTP verb.

## Public identity probes

Every seed is a nonempty legal graph and every initial snapshot checks at least
one exact seeded identity. The public probes then create a new resource through
the public interface, capture the returned identifier, and independently read
the stored record by detail, collection or snapshot. Reads never substitute the
write response. Existing controls remain present in the snapshot.

- ArtifactVault: Package; create UploadSession, read it, upload literal public
  `hello` bytes, then independently read offset and snapshot identity.
- ExportVault: Subject and DatasetRevision with one public record; verify its
  computed summary digest, create Export, read detail/list/snapshot identity.
- FirmwareFleet: DeviceModel and idle Device; register FirmwareImage, independently
  read snapshot, create Campaign and read captured target membership.
- ConfigOrbit: Tenant/Application/Environment; create draft ConfigRevision and
  read it by ID and snapshot.
- EntitlementHub: Tenant/Plan/published PlanRevision; create another Plan and
  read it from snapshot; check an unsubscribed subject is disabled.
- ModerationFlow: Tenant/Policy/active PolicyVersion; submit ContentItem and
  read the separately captured ModerationCase and snapshot identity.
- FraudLens: Tenant/RuleSet/active RuleVersion; submit RiskEvent and read its
  independently captured Assessment and snapshot identity.
- IdentityMesh: Tenant/User/pending Device; create User, read snapshot and an
  independently filtered session collection.
- SeatReserve: Tenant/Venue/on-sale Event/Zone/Seat/active PriceVersion; read
  available seat, create Hold, read frozen total and changed availability.
- RoutePilot: Tenant/Backend/RouteDefinition/RouteRevision/policies/active
  ConfigRelease; verify seed release, create route and read list/snapshot.

## Clarifications and limits

These are author-side interface contracts, not business implementations. Missing
legacy mutation bodies, unnamed base resources, audit/checkpoint fields, general
event envelopes, and unnamed response envelopes are explicitly resolved in V2
notes. All route path parameters are typed; all success resources are closed.
General JSON documents, permitted attribute maps and public event payloads retain
their explicitly declared dynamic keys. Business invariants, digest computation,
cross-record references and concurrency still require actual implementation.

Manager-only resources never become extra V1 seed members. Firmware command/report
tokens are operational-only and omitted from snapshot schemas. RoutePilot seed
origin is replaced by `originRedacted:true` in public schemas and smoke checks.
ArtifactVault FINAL snapshot requires platform while legacy response shapes omit
it. ExportVault preserves the disjoint legacy and sharded Export shapes. Binary
downloads publish 200/206 and empty conditional 304; ConfigOrbit publishes empty
304 only under its generation/ETag rule. The shared transport must enforce these
contracts without buffering complete large objects.

IdentityMesh quarantine needed new route names, resource shapes, state names and
event/error names; those decisions are labeled V2 clarifications, not falsely
attributed to literal legacy wire text. RoutePilot's impossible legacy migration
case of a Tenant with no ACTIVE ConfigRelease is explicitly clarified in its
notes; the public seed supplies an active release and exercises the specified
compatibility case.

No live PostgreSQL, HTTP, browser, concurrency, recovery or performance tests ran
in this contract-authoring subtask. The parent owns materialization, immutable
author checks, failing implementation stubs, and runtime/harness verification.

## Additional public-only assignment

RouteWeave, EdgeTwin, MergeBoard and EvidenceChain were subsequently authored from
their complete public README, Manager and AGENTS copies under the new repository's
`task-packages/legacy` directory. ReconcileHub had already been authored by agent B;
it was reviewed against those complete public documents and its missing
CHROMIUM_PATH/MANAGED_DATA_ROOT environment metadata was added. Its schemas and
business interface were preserved. No evaluator for these five tasks was read.

| Additional task | Operations | Probes | Schemas | Missing published routes |
| --- | ---: | ---: | ---: | ---: |
| routeweave | 27 | 6 | 28 | 0 |
| edgetwin | 31 | 7 | 22 | 0 |
| reconcilehub | 18 | 5 | 17 | 0 |
| mergeboard | 21 | 8 | 32 | 0 |
| evidencechain | 19 | 8 | 28 | 0 |

All five pass schema/seed/request-example validation, parameter-example checks,
OpenAPI route generation and unknown-seed-member rejection. Route extraction found
no missing public method/path pairs. The ReconcileHub group reverse route is
present although its Manager source abbreviates the path as `/reverse`.

All five contain meaningful nonempty seed identity probes and an independent
write/read flow: Shipment creation, Shadow patch, StatementBatch import, Document
creation/change, or IntakeScan/CustodyMatch creation. Import-only fields are never
asserted in a public snapshot. MergeBoard numeric revision paths are explicitly
typed as nonnegative integers.

EvidenceChain adds one explicitly marked V2 Aliquot transfer interface because its
Manager rules require independently transferable children and reversal rejection
after transfer but do not name a route. This is a public clarification, not a
hidden evaluator convention. RouteWeave native Consignment route/scan shapes and
EdgeTwin connection/receipt/compensation shapes are similarly explicit and closed.
No runtime implementation or live test was introduced by this additional work.
