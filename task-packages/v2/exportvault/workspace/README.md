# ExportVault

## Goal

Implement the complete ExportVault system in this workspace. Read [the complete requirements](docs/requirements.md), [the public interface](contract/README.md), and [the exact schemas and examples](contract/contract.json).

## Starting Point

This is a Frontal Benchmark V2 fixed-interface starter for the complete final system. Use this workspace and an empty database. There is no intermediate submission or earlier program to upgrade.

## Required Behaviour

- Deliver one final workspace implementing both base and additional product features. The same Frozen Plan applies to every experiment arm.
- Start from an empty database. Tests create fresh data through published seed/API interfaces. No earlier program, intermediate V1 snapshot, historical database or cross-version deployment is required.
- Implement the actual business operations, durable storage, workers, UI and verification. Passing a schema or public smoke check is not task completion.

## Public Interfaces

Implement the exact published operations, commands, seed, errors and snapshot schemas in contract/. Read docs/requirements.md for their full business meaning.

## Constraints and Invariants

Preserve all current-system business, integrity, concurrency, security and recovery requirements. README is authoritative; the Frozen Plan only orders execution.
- Do not edit author-owned interfaces or checks to make an implementation pass. Do not return hard-coded fixtures.

## Required Commands

Implement and execute the commands published in docs/requirements.md and contract/contract.json, including public verification. db:migrate initializes the current system.

## Acceptance

- Re-read the full requirements, audit the complete system, run required public checks and report evidence before delivery.
- Acceptance evaluates the actual final system; schema checks and local self-tests alone do not prove business completion.

## Out of Scope

Historical physical databases, old binaries, cross-version upgrade choreography and migration-only legacy wrapper generation are not required.

Scope: **learning-final-system-2026-09-08.1**. Original source texts under docs/frontal-legacy/ are retained for provenance, not as a second execution route.
