# Execution Plan

## Objective

Read `README.md` completely before changing the workspace. The README is the authoritative product contract; this frozen plan only fixes the execution order and never adds or replaces requirements.

## Stages

1. Audit the starting point against the README, identify the next coherent delivery slice, and report material risks or contract conflicts.
2. Implement one coherent slice at a time while keeping the project runnable and preserving the README's public interfaces and invariants.
3. Integrate the completed slices, repair failures at their source, and continue until the full README contract is covered.
4. Perform a final contract audit, remove accidental or temporary artifacts, and resolve every material gap found.

For every stage, use the README to choose the concrete work. Do not replace, rewrite, or reorder this plan and do not treat a Scenario message as a second requirements document.

## Verification and Delivery

Run the smallest relevant public verification while implementing, then run every applicable command required by the README before delivery. Report the exact commands actually run, their outcomes, any command not run, remaining risks, and the README coverage status. Deliver only after the final audit is complete.
