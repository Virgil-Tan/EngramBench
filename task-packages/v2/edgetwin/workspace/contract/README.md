# EdgeTwin — V2 fixed public interface

Author scaffold revision 2026-09-08.final-system.1: exact decimal validation and incremental seed-file decoding. This is a revised public scaffold, not the unchanged historical evaluation environment. Evaluation scope is one complete final system; historical cross-version duties are withdrawn. Current business requirements and seed scale remain required.

Business requirements: read the COMPLETE ../docs/requirements.md. learning-final-system-2026-09-08.1 explicitly withdraws historical cross-version obligations, not current business functionality. Source documents remain unchanged only for provenance.
Public author policy revision learning-final-system-2026-09-08.1: read the supplements below in full. They resolve explicitly identified business-policy and test-protocol omissions; only an explicitly named author-approved exception overrides a corresponding original rule, and every other original obligation remains in force. This revision must not be compared as an unchanged historical benchmark.

## Implementation seam

- Implement all operations behind src/implementation.ts; use src/operation-ids.ts and contract.json for exact IDs, schemas, status codes and examples. Split internal modules freely.
- Implement migrations, database seed, worker/dispatcher roles, real UI build and project-owned verification in src/lifecycle.ts. Throwing stubs are deliberate: compilation is not business completion.
- The API process awaits optional src/implementation.ts exports start() before listening and stop() when terminating. Use these for pools and any background work required inside npm start (notably LaunchPass expiration/promotion). They may delegate to your own lifecycle modules; do not keep them only in the build command.
- contract/ is author-owned. Do not edit its router/checker/contract or the README to make tests pass. You may add modules, dependencies, UI assets and your own tests.
- Raw uploads arrive as RequestContext.stream; consume them incrementally. Raw download responses may be Buffer, string or readable stream. The router does not implement file persistence.
- Additional UI endpoints may use publicExtensions; published operation IDs/method/path cannot be replaced.

## Contract and examples

- contract.json is the single wire source. openapi.json is generated from it, not separately handwritten.
- The fixed HTTP server listens on 0.0.0.0; contract.httpHost preserves any task-specific bind requirement. PORT selects its port.
- transportErrors preserves task-specific HTTP error codes. Otherwise V2 wire defaults are INVALID_REQUEST/400, MALFORMED_JSON/400, UNAUTHORIZED/401, NOT_FOUND/404 and UNSUPPORTED_MEDIA_TYPE/415; domain resource errors still follow the complete README.
- seed.example.json is a legal NONEMPTY seed. Its replay rule and argv are under contract.seed; do not guess db:seed versus seed.
- contract/seed-reader.mjs exports readSeedJsonFile(path): incremental JSON decoding without a whole-file string. The author seed command still validates the entire decoded value against the public schema before invoking your lifecycle. You may reuse this reader in your own importer; foreign keys, digests, duplicate rules and atomic import remain your responsibility. The decoded object tree still occupies memory, and a single JSON string remains subject to the JavaScript engine string limit; this helper is not a database importer.
- operation.example values are independent wire examples, not a complete executable business sequence. smoke contains an ordered public live sequence with captured identifiers.
- A smoke signatures entry constructs a lowercase-hex HMAC-SHA256 request field: {target:["headers"|"body","existingField"],key:"public fixture key",message:"published UTF-8 signing line"}. Captured variables are expanded first; body fields are signed before JSON serialization. This is a public client helper, never server-side authentication or business implementation.
- npm run check:contract-source only verifies author file integrity and schema construction.
- npm run test:public-contract uses a DISPOSABLE database, builds, migrates, imports the seed, starts the real API/roles, then checks nonempty identities and live operations. Do not point it at a valuable database.
- Public failures identify the failed command stage and retain its exit code/stdout/stderr. A probe blocked by an earlier failed identifier capture is reported as blockedBy, not as an independent implementation failure. Fix the first failure, then rerun the public check.
- HTTP probe failures identify method/path, expectedStatus, actualStatus and a named errorCode when available; they do not dump credentials or signatures. The official Harness reruns this author-owned check in an isolated copy before freezing; failed public checks return to the same Coding Agent for repair, while infrastructure errors stop the check without becoming business scores.
- Passing public checks proves only the published example wiring. It does not certify full business requirements, security, recovery, UI or performance, and does not replace the final README audit.
- The official Harness runs the author-owned checker against an isolated copy before freezing. A public failure is feedback, not a hidden business score.

## Published operations

| ID | Method / path | Source |
| --- | --- | --- |
| health | GET /healthz | docs/frontal-legacy/README.md |
| openapi | GET /openapi.json | docs/frontal-legacy/README.md |
| production-ui | GET / | docs/frontal-legacy/README.md |
| list-tenants | GET /api/v1/tenants | docs/frontal-legacy/README.md |
| create-tenant | POST /api/v1/tenants | docs/frontal-legacy/README.md |
| list-devices | GET /api/v1/devices | docs/frontal-legacy/README.md |
| create-device | POST /api/v1/devices | docs/frontal-legacy/README.md |
| read-device-shadow | GET /api/v1/devices/:deviceId/shadow | docs/frontal-legacy/README.md |
| patch-desired-shadow | PATCH /api/v1/devices/:deviceId/shadow/desired | docs/frontal-legacy/README.md |
| create-device-command | POST /api/v1/device-commands | docs/frontal-legacy/README.md |
| read-device-command | GET /api/v1/device-commands/:commandId | docs/frontal-legacy/README.md |
| cancel-device-command | POST /api/v1/device-commands/:commandId/cancel | docs/frontal-legacy/README.md |
| connect-device | POST /api/v1/devices/:deviceId/connect | docs/frontal-legacy/README.md |
| disconnect-device | POST /api/v1/devices/:deviceId/disconnect | docs/frontal-legacy/README.md |
| poll-device | POST /api/v1/devices/:deviceId/poll | docs/frontal-legacy/README.md |
| create-command-receipt | POST /api/v1/command-receipts | docs/frontal-legacy/README.md |
| list-firmware-releases | GET /api/v1/firmware-releases | docs/frontal-legacy/README.md |
| create-firmware-release | POST /api/v1/firmware-releases | docs/frontal-legacy/README.md |
| list-upgrade-campaigns | GET /api/v1/upgrade-campaigns | docs/frontal-legacy/README.md |
| create-upgrade-campaign | POST /api/v1/upgrade-campaigns | docs/frontal-legacy/README.md |
| pause-upgrade-campaign | POST /api/v1/upgrade-campaigns/:upgradeCampaignId/pause | docs/frontal-legacy/README.md |
| resume-upgrade-campaign | POST /api/v1/upgrade-campaigns/:upgradeCampaignId/resume | docs/frontal-legacy/README.md |
| cancel-upgrade-campaign | POST /api/v1/upgrade-campaigns/:upgradeCampaignId/cancel | docs/frontal-legacy/README.md |
| list-deployment-waves | GET /api/v1/deployment-waves | docs/frontal-legacy/manager-requirements.md |
| create-deployment-wave | POST /api/v1/deployment-waves | docs/frontal-legacy/manager-requirements.md |
| read-deployment-wave | GET /api/v1/deployment-waves/:deploymentWaveId | docs/frontal-legacy/manager-requirements.md |
| pause-deployment-wave | POST /api/v1/deployment-waves/:deploymentWaveId/pause | docs/frontal-legacy/manager-requirements.md |
| resume-deployment-wave | POST /api/v1/deployment-waves/:deploymentWaveId/resume | docs/frontal-legacy/manager-requirements.md |
| cancel-deployment-wave | POST /api/v1/deployment-waves/:deploymentWaveId/cancel | docs/frontal-legacy/manager-requirements.md |
| rollback-deployment-wave | POST /api/v1/deployment-waves/:deploymentWaveId/rollback | docs/frontal-legacy/manager-requirements.md |
| verification-snapshot | GET /api/v1/verification-snapshot | docs/frontal-legacy/README.md |

## Explicit V2 wire clarifications

- The complete public README and Manager requirements remain business authority. These V2 schemas freeze previously unspecified transport fields; they are authored from public documents only. The public smoke checks interface and persistence identity, not complete business correctness.
- V2 wire clarification: health returns {status:"ok"}; the production root returns HTML. Mutation bodies are closed, server-generated identity/state/timestamps are outputs, all mutation examples require durable Idempotency-Key, and unspecified success status is 200. Path parameters use their corresponding resource field types. Collection limits are 1..100 (default 50) with stable opaque cursors.
- V2 wire clarification: Tenant is {tenantId,name}; the default AuditEntry/AuditCheckpoint, DomainEvent envelope and fenced Work fields are the published schema definitions. Unless legacy prose literally fixes payload to {}, DomainEvent.payload is a public JSON object. This does not authorize exposing secrets or inventing event types.
- V2 wire clarification: snapshot is one PostgreSQL point-in-time with exact resources, work and events keys (and schemaVersion only where declared). Resource arrays are complete, sorted by public identity tuple; audit by tenantId then sequence, events by aggregateId then sequence then eventId, Work by workId. Foreign keys, state invariants and digest validity remain implementation validation. Token/credential/private-path fields never appear in snapshot.
- Seed preserves exactly the V1 top-level members; Manager-only resources are created by public operations or the explicitly required compatibility migration. The nonempty example is a minimal legal starting graph, with no evaluator fixtures.
- V2 wire clarification: new Devices start OFFLINE with null lastSeenAt and a persisted empty version-0 desired/reported Shadow. Desired PATCH takes {expectedVersion,patch}; both patches and stored documents are JSON objects. Enforce the published 64KiB UTF-8 result, depth, prototype-key and array limits in business validation.
- V2 wire clarification: connect takes tenantId and returns {device,connectionId}; disconnect takes tenantId/connectionId and returns Device. Poll returns {items:[DeviceCommand]} ordered by createdAt/commandId, capped by the smaller of request limit and DEVICE_POLL_LIMIT. A newer connection fences the prior connectionId. Invalid connections use DELIVERY_IDENTITY_CONFLICT.
- V2 wire clarification: receipt success is the exact CommandReceipt plus projectionStatus:APPLIED|STALE|TERMINAL; immutable snapshot receipt evidence retains the original public fields. Delivery identity and reported base version are accepted in the request and retained privately for canonical replay/fencing. Terminal receipts remain visible but do not alter shadow or command state.
- V2 wire clarification: DeploymentWave list returns paginated DeploymentWave summaries; creation/detail return {deploymentWave,waveDevices}. priorFirmwareReleaseId is null only when no registered release matches the captured prior digest, making rollback unavailable. Compensating UpgradeTargets add upgradeTargetId, referenced by rollbackTargetId; original compound-identity UpgradeTargets remain exact.
- Frozen Wave membership, target release and health gates govern future work for the existing Campaign from DeploymentWave creation; already issued V1 commands keep identity. Only matching firmware receipt confirms success. Native Manager resources remain outside the unchanged V1 seed; deterministic legacy migration preserves all identities and pending work.
- learning-final-system-2026-09-08.1: Build one complete system from the start. Base features and the formerly named Manager features are required together; there is no intermediate submission, old program, historical workspace, or cross-version upgrade assessment.
- learning-final-system-2026-09-08.1: V1 in an API or source description denotes the base feature contract, not a separately running program. The published /api/v1 paths and schemaVersion values do not change.
- learning-final-system-2026-09-08.1: Cross-version-only duties are withdrawn: importing an unspecified historical physical database, upgrading an earlier binary, migration-time availability of an earlier binary, and synthesizing migration-only legacy wrappers. Current public resource shapes, base APIs, additional features and their ordinary business relationships remain required.
- learning-final-system-2026-09-08.1: Initialize an empty database using the published commands. db:migrate is current-system schema initialization, not an obligation to recognize a hidden old schema. Preserve the original current-system seed validation, atomicity and replay rules.
- learning-final-system-2026-09-08.1: Evaluation creates fresh data through the published seed or APIs, then checks actual behavior and durable state. Restart and recovery assertions use this same final system. A snapshot is a read-only observation, not a database backup format.
- learning-final-system-2026-09-08.1: Persistence, transactionality, idempotency, concurrency, authorization, real UI, OpenAPI, recovery and explicitly specified performance requirements remain in scope. This policy does not remove an otherwise explicit business or security requirement.
- learning-final-system-2026-09-08.1: No external legacy service is required. An isolated receiver or provider simulator is used only for an external interaction actually required by the public product contract; no real account or production service is required.
- learning-final-system-2026-09-08.1: Hidden assertions must use published inputs and observable requirements. Unspecified algorithms, exact error strings, control points or performance thresholds cannot silently become requirements. Code defects fail; invalid author fixtures and infrastructure faults are evaluator errors, not zero-score business outcomes.

## Delivery

Public checks are necessary, not sufficient. Re-read the entire README, audit every observable requirement, and run all required project checks. Guide completion does not mean task completion. Do not return fixture-only responses or empty arrays to simulate completed workflows.
