# Evaluating a frozen delivery

## Three different checks

1. `npm test` / `npm run check`: framework regressions, schemas, inventory,
   original-source hashes, and author/generated package consistency.
2. The public contract gate: builds and runs a submission in an isolated
   environment using author-owned public checks. A failure returns to the agent.
3. Task evaluation: executes the task's case manifest against the frozen delivery.
   Public-gate success is not a substitute for these cases.

## Current release boundary

`evaluators/{learning,transfer}/<task>/release.json` records author certification.
Formal mode checks certification against the exact public contract, evaluator,
and runtime-lock digests. Included records remain `pending_live_validation`
(41 tasks) or `pending_alignment` (IncidentRelay and PermitForge).
Do not change that field merely to bypass the check.

Development profiles stop at `awaiting_evaluation`. To run the actual cases
before certification, use explicit **author-validation**. It records case
outcomes but returns `formalEligible: false`, `score: null`, and `rawScore: null`.
This is intentionally distinguished from a certified benchmark result.

## Evaluate one completed run

Set up the native images as described in [Environment setup](../environments/README.md).
The existing frozen-delivery helper accepts any matching V2 task and verifies
the run identity, frozen plan, successful public gate, and submission digest.
The directory name is historical, not a restriction to one task.

```sh
export FRONTAL_OCI_COMMAND="$PWD/scripts/docker-native-amd64-evaluator.mjs"
node work/superhard-v2-alignment-20260908/evaluate.mjs \
  --run-root "$PWD/runs/my-run" \
  --task-root "$PWD/task-packages/v2/capacitylease" \
  --output-root "$PWD/evaluation-results/my-run-capacitylease" \
  --dry-run
```

Replace `my-run` and the task ID with an actual completed development run.
Remove `--dry-run` to execute. The output directory must be new, or an exactly
matching completed evaluation that can be verified for reuse. Partial results
are preserved, not silently overwritten. An optional `--seed` takes a
64-character lowercase SHA-256 value; use the same explicit seed for paired arms.

**Resource note:** this helper uses the explicit 64 GiB RAM / 32 GiB PostgreSQL
author-validation profile documented in the environment guide, not the smaller
standard catalog profile. Check host capacity before starting concurrent runs.

For a Learning-only batch, see
[Batch evaluation](batch-hidden-evaluation.zh-CN.md). The lower-level
`runV2EvaluatorProcess` API in `src/task-package-v2-evaluator.mjs` also accepts
explicit `mode: 'author-validation'`, a task root, repository root, and
`--request`/`--result` paths. It validates inputs before execution.

## Read results without conflating metrics

The authoritative case inventory is `evaluator/v2/manifest.v2.json` in the
evaluated task package. Preserve `request.json`, `launch.json`, `result.json`,
the case evidence directory, environment details, and the frozen submission.

- `passed`: a confirmed passing case.
- `failed`: a failure attributed to the submission.
- `diagnostic`: an unresolved diagnostic outcome, not a pass.
- `evaluator_error`: an evaluator/infrastructure failure, not a proven agent bug.
- `excluded`: an explicitly justified exclusion, not a pass.

For the unweighted confirmed-case pass fraction, use:

```text
confirmed passed cases / all applicable, non-excluded scheduled cases
```

Applicable cases that are unresolved or unreached remain in the denominator.
Use the scheduled manifest, not just the number of returned case records, when
execution is incomplete. Publish coverage and status counts alongside the ratio.
Infrastructure errors must remain visible and should be investigated separately.

The shared scorer additionally supports dimension weights and manifest-defined
hard caps. Its `score`, `rawScore`, and `accepted`/`rejected` verdict are not the
same thing as the unweighted case fraction. An all-cases-pass acceptance rule
can reject a delivery with a high case fraction. Do not substitute a capped
score for an uncapped pass fraction or report a diagnostic run as certified.

## Evaluator maintenance

Repair author sources under `evaluators/` or the shared runtime under `src/`.
Add a regression, then run:

```sh
npm run build:evaluators
npm test
npm run check
```

This refreshes generated evaluators and locks while preserving public starter
trees and plans. Retest the unchanged frozen submission under a new explicitly
recorded evaluator revision. Never overwrite old evidence, add a per-submission
adapter, or change public requirements to fit observed answers.
