# Public release scope

This repository publishes the independent V2 benchmark as **EngramBench** under
MIT. It does not import the parent repository's Git history, account state,
private skill banks, model conversations, submitted project solutions, or
server-specific experiment launch/resume scripts.

All 30 Learning and 13 Transfer packages are included, together with author
contracts, plans, scenarios, public checks, evaluator code, and fixtures.
Original business documents and frozen plans remain unchanged. Legacy-named
authoring inputs are retained because V2 regeneration and provenance checks
depend on them; only `task-packages/v2/` is the supported run entry point.

The import inventories omit 132 references to nested Git metadata that were
not part of the exported source snapshot. Task-content hashes are preserved;
personal source-directory names are replaced with a descriptive source label.
Private server paths in maintenance documentation are redacted. Dated private
run ledgers and unversioned result tables are not presented as public results.
The obsolete DockChain adapter deployment note is also omitted; it is not a
business requirement and does not describe the current V2 evaluator path.

The release includes the later local evaluator fixes for UI control types,
inner-form scoping, CapacityLease controls, and MeterSettle events editors,
with their regression tests. Generated evaluators and runtime locks are
refreshed together; these changes do not edit task requirements or submission
code. Root framework dependencies are updated within the existing major
versions to address the dependency audit. Preserved task starters and their
historical dependency locks are not silently upgraded.
Those starter locks can still contain dependency audit findings (including the
exported CapacityLease starter). Use isolated benchmark environments, not these
unfinished starters as production applications. The root dependency audit is
separate from audits of the preserved per-task dependency trees.

Public-release additions include a baseline/native-only Codex image recipe,
a pinned evaluator-image override for new hosts, and credential-free example
profiles. Historical `FRONTAL_*` and serialized schema names remain compatible.

Evaluator fixtures are publicly inspectable but excluded from development
workspace exports. This is not a claim of secrecy from researchers, immunity
to contamination, or protection from hostile submissions. See the limitations
in the main README.

Package release metadata is preserved, not promoted to `certified` by static
tests. No new model benchmark runs or full task-business certifications are
implied by this publication. Historical author notes describe earlier repairs;
current sources and release records are authoritative for this snapshot.
