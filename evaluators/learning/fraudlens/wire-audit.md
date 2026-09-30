# FraudLens author wire audit

Authority: frozen `task-packages/v2/fraudlens/public-contract/contract.json` and the preserved public README/Manager requirements. No submissions or trajectories were consulted.

Changes:

- Seed RuleSet now has exactly `ruleSetId`, `tenantId`, `name`. The two ACTIVE RuleVersion rows retain active-version authority.
- The A-01 worked scoring example uses integer `1` in both rules and event attributes; it retains the same three matches, ordered hits, final score 800 and REVIEW outcome. Rule `value` has always been string or integer in the public shape.
- Rollback sends `fromRuleVersionId`; activation still sends `expectedActiveRuleVersionId`.
- Every author claim includes the observed ReviewCase revision. Decisions use the successful claim response's revision, including race, migration, expiry and full-scale workload cases.
- Only A-01's extra `ruleVersionId` and B-01's nested attribute object use explicit invalid-wire expectation. Their rejection and no-new-version/event/work assertions remain in place. Invalid thresholds and overflow-capable rules remain schema-valid business negatives.

Validation: `node --test test/evaluator-wire-fraudlens.test.mjs` checks all 22 registry entries, all case seeds, the scoring example, actual positive helper requests, explicit malformed requests and required revision fences against the frozen public validator.

Preserved limitations: existing FL-GAP diagnostics and manifest/weights/IDs are unchanged. The public recovery checkpoint gaps and existing blocked assertions require separate review; no live business pass or release certification is claimed here. Performance datasets and thresholds are unchanged.
