# ColdChainControl Benchmark Context

## Purpose

ColdChainControl is the first and smallest of four large transfer tasks. It is deliberately larger than the existing single-domain tasks while retaining one coherent product journey: a configured and authenticated edge Device accompanies a cold Shipment, signed telemetry updates a deterministic projection, excursions create notifications, and operations act through a browser. It transfers reusable capabilities from ConfigOrbit, EdgeTwin, GeoPulse, NotifyRoute, and IdentityMesh without copying their product vocabulary.

The task starts from only `workspace/.git`, `workspace/README.md`, and `workspace/AGENTS.md`. A credible implementation should take a medium agent roughly six hours because it combines configuration publication, device identity, ordered event projection, geospatial/time-series state, notifications, multi-process recovery, a production UI, and one late Manager migration.

## Evaluation seam

The evaluator observes only published commands, HTTP/OpenAPI, production Chromium, PostgreSQL state through the privileged verification snapshot, independent processes, controlled barrier/SIGKILL recovery, and webhook/provider doubles. It must never import candidate modules, query private tables, or depend on ORM/schema names.

H-01, H-02, and H-13 are owned by the shared runner. H-03 through H-12 use the shared `standardAdapter` seam. H-14 through H-20 are task-owned adapter cases. H-12 runs five task-specific fresh-database scenarios through a local five-scenario wrapper because the legacy shared validator accepts exactly three metrics; no shared framework file is modified.

## Gate map

- H-01: clean install, build, repeatable migration/seed, and independent process boot.
- H-02: strict OpenAPI 3.1, production Chromium, public routes, validation, redaction, and tenant isolation.
- H-03: create, activate, signed telemetry, projection, excursion, audit, Work, and Event main flow.
- H-04: invalid route, bad signature, duplicate sequence, and config mismatch are atomic.
- H-05: lost response, 20-way replay, semantic conflict, and API restart preserve one effect.
- H-06: two APIs accept shuffled/duplicate hot-Device telemetry and converge deterministically.
- H-07: killed claimed worker cannot defeat a replacement or publish stale projection state.
- H-08: dispatcher unknown ACK retries identical logical delivery/event identity and respects durable quota.
- H-09: V1 snapshot, replay, pending Work, Event, credential, config, Shipment, projection, and audit survive the FINAL migration.
- H-10: the published Manager flow creates a valid connected chain, advances one handoff, and freezes responsibility.
- H-11: concurrent handoff acceptance, recall creation, and worker failure converge without split custody or duplicate actions.
- H-12: all five fixed performance scenarios and post-load invariants.
- H-13: every project-owned unit/integration/E2E/concurrency/recovery/performance/aggregate command is real.
- H-14: key rotation/revocation serializes with signed ingest; old-key replay has no side effect.
- H-15: gapless immutable configuration rollout, stale ack protection, expiry, and worker recovery.
- H-16: late/out-of-order readings rebuild excursion history without regressing current route or sequence.
- H-17: notification policies, tenant-wide quota, retry identity, cancellation fences, and redaction.
- H-18: connected multi-Carrier chain validation and attested in-window handoff authority.
- H-19: batch Recall atomically freezes the affected set and applies quarantine under crash recovery.
- H-20: cross-feature fault drill combining config supersession, credential revoke, telemetry, handoff, recall, two APIs/workers/dispatchers, and final conservation checks.

## Five performance scenarios

1. `signed-telemetry-ingest`: sustained authenticated ingest plus exact cardinality.
2. `hot-device-ordering`: shuffled duplicates across two APIs plus deterministic projection.
3. `configuration-rollout-recovery`: 20k assignments, four workers, two killed claims, no downgrade.
4. `excursion-notification-recovery`: excursion fan-out plus unknown dispatcher acknowledgement.
5. `recall-quarantine-convergence`: 64-client Manager contention plus worker failure and custody/quarantine conservation.

Every metric includes scenarioId, completed, durationMs, throughput, p50, p95, p99, statuses, and scenario-specific recovery or invariant counts. Full-scale scoring rejects `BENCH_PERF_SCALE < 1`; scaled local runs are explicitly non-scoring.

## Manager confidentiality

The only Manager change is the exact content of `orchestration/manager-prompt.zh-CN.md`. It introduces `CustodyChain`, `CustodyHandoff`, `RecallOrder`, `RECALL_PROPAGATE`, and `QUARANTINE_ENFORCE`. Before its scene, neither public workspace file nor DS messages may mention those entities, their interfaces, new Work kinds, or their errors. `CONTEXT.md`, evaluator assets, checklist, and Manager prompt are Harness-owned and absent from the Agent workspace.

## Calibration expectation

Before publication, run the evaluator against a known-correct implementation and mutants for process-local idempotency, non-atomic Event/Work, missing fencing, current-arrival rather than sequence projection, unredacted credentials, partial Manager migration, split custody, incomplete recall set, throughput-only performance, and fake browser tests. Repeat full performance at least three times on the target image.
