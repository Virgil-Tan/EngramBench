# FirmwareFleet Context

FirmwareFleet models device firmware campaign delivery and acknowledgement. This vocabulary is authoritative for the public contract,
dialogue, checklist, and evaluator design.

| Term | Canonical definition | Avoid |
| --- | --- | --- |
| Device | A registered hardware unit with model, bootloader, and installed firmware version. | Agent, client |
| Firmware Image | Immutable bytes, digest, size, model compatibility, and version. | Artifact, package |
| Firmware Campaign | A captured set of Devices targeted with one Firmware Image. | Deployment, rollout |
| Device Update | One Device's durable campaign state and current command sequence. | Assignment, job |
| Command Task | Leased delivery work for download, install, verify, or rollback commands. | Message, queue |
| Device Report | A sequence-numbered idempotent observation tied to one command token. | Heartbeat, ack |

## State language

Device Update: WAITING -> DOWNLOADING -> INSTALLING -> VERIFYING -> SUCCEEDED, any active state -> FAILED -> ROLLED_BACK, or WAITING -> CANCELLED; Campaign: PENDING -> RUNNING -> SUCCEEDED | FAILED, or PENDING|RUNNING -> CANCELLED.

## Core invariants

1. A Device executes at most one active Device Update and one current command at an instant.
2. Installed firmware changes only after a valid verify report for the exact image digest and token.
3. Device Report sequence is strictly increasing; identical duplicate batches have no second effect.
4. A Campaign target set and Firmware Image never change after creation.
5. Rollback returns to the captured prior version exactly once and cannot install an unrelated image.

Use these exact terms in API fields, UI labels, events, tests, and handoff. A synonym in explanatory
prose must not introduce a second domain concept.
