# ExportVault

## Goal

Deliver the complete ExportVault product without changing the legacy task requirements.

## Starting Point

This is a lossless Task Package v1 adapter over the legacy starter workspace. Source content is copied without rewriting; only dependency directories, desktop metadata, and Git metadata are omitted. The original user-facing task introduction is preserved at [docs/frontal-legacy/public-task.txt](docs/frontal-legacy/public-task.txt) for traceability.

## Required Behaviour

The complete product contract is the union of [the original public contract](docs/frontal-legacy/README.md) and [the original Manager requirements](docs/frontal-legacy/manager-requirements.md). Both source texts are visible from the first turn and are reproduced without rewriting. Statements only about conversation timing, publishing a later message, producing a new plan, or delaying code are legacy orchestration metadata; they do not alter product behaviour and the frozen Harness Plan governs execution.

## Public Interfaces

Every public interface, schema, command, error, default, compatibility rule, and observable behaviour in the two linked source contracts remains binding exactly as written.

## Constraints and Invariants

The original `AGENTS.md` is preserved unchanged and remains the engineering working agreement. Product requirements come only from the two linked source contracts; the frozen Plan controls execution order.

## Required Commands

Implement and run every non-interactive command required by the two linked source contracts, preserving each published name and exit-status semantic.

## Acceptance

The frozen FINAL submission must satisfy the complete combined source contract, preserve all stated compatibility behaviour, pass every applicable public project command, and report verification evidence accurately.

## Out of Scope

The new Harness does not create or evaluate an Agent-produced intermediate V1 workspace snapshot. Product migration and compatibility requirements in the linked source contracts remain in scope.
