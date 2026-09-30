# EngramBench

- Work only in this independent repository. Do not modify the V1 repository or existing server runs.
- `learning-tasks.json` is the authoritative ordered set of 30 Learning task IDs.
- `transfer-tasks.json` is the ordered set of 13 Transfer/Test tasks (six standard, four superhard, three mid-hard); do not relabel Learning or enable Transfer evolution.
- Public business requirements are preserved verbatim under each workspace's `docs/frontal-legacy/`.
- `contracts/learning/<id>.mjs` defines the V2 wire format. Every clarification must be public and must not remove or solve business requirements.
- Transfer author sources are `contracts/transfer/<id>.mjs` and `evaluators/transfer/<id>/v2/`; the same V2 protocol and runtime apply.
- Never derive public requirements or examples from hidden tests, submissions, or trajectories.
- Explicit author-approved business exceptions must be published under a named policyRevision; preserve the original texts and all requirements outside that exception. A revised policy is not the unchanged historical benchmark.
- Generated task packages live under `task-packages/v2/`; edit contract sources/templates, then regenerate. Never regenerate a run workspace.
- Evaluator code and fixtures are public in this repository, but must never be mounted in or copied into the Coding Agent workspace. Do not add per-submission compatibility adapters.
- A compile/schema pass is NOT a business pass. Unimplemented operations and lifecycle scripts must fail visibly.
- Do not add model/turn timeouts or maximum conversation turn counts.
- Use the same frozen plan, workspace, public checks and evaluator for all experiment arms.
- Run `npm test` and `npm run check` before reporting implementation complete. Report unverified live evaluation separately.
- Evaluator repairs belong in `evaluators/<phase>/<id>/v2/` or the shared `src/task-evaluator-v2/`, with a regression that exercises the real failure. An independent retest copy or Adapter alone is not a completed V2 repair.
- After an evaluator repair, run `scripts/refresh-evaluator-only.mjs` for affected packages (all 43 when shared runtime changes) and verify author/generated evaluator and release equality. Preserve public scaffolds, Frozen Plans, historical results and running deployments. New deployments must use the validated generated packages; existing frozen experiments need an explicitly versioned reevaluation, never a silent overwrite.
