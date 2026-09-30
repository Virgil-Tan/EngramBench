# NotifyRoute author wire audit

Authority: frozen `task-packages/v2/notifyroute/public-contract/contract.json` and preserved README/Manager requirements. No submissions or trajectories were consulted.

Wire repairs:

- Template digests hash canonical UTF-8 JSON including `channel`, `subject`, and `body`. Default positive fixtures use literal content and empty data because template-variable grammar is explicitly unresolved in the contract.
- A-01's later TemplateVersion includes `version:3`; the later policy includes `revision:2`. Frozen content, route inputs and invalid-render no-side-effect checks remain executable. The strict invalid-data case now supplies an unknown variable to a literal template; no grammar is assumed.
- Every unsubscribe carries its fixture's observed `expectedPreferenceRevision`.
- Notification cancellation and delivery reconciliation send the fixed empty object. Receipt facts still supply delivery outcome/message identity; receipt/reconcile ordering and original delivery/provider identity assertions remain unchanged.
- D-01's extra Notification field and B-01's extra cancellation `reason` are explicitly malformed wire. Both retain rejection and zero-side-effect checks. Cancellation has no well-formed semantic body variant in V2, so adding `reason` cannot validly demand an idempotency conflict; creation's changed-body conflict check remains active.
- No signing secret is injected into the closed ChannelEndpoint seed.
- A-03 now distinguishes the public snapshot's `deliveryId` ordering from route execution order. It checks identity sorting separately, projects the exact frozen ordinals, requires the first step to be FAILED and the final step to succeed, and verifies actual receiver calls follow ordinals 1 then 2 exactly once. Its readiness observation waits for that success to commit; UUID lexical order no longer stands in for send order. The focused test uses UUID order opposite to route order and rejects reversed sends, duplicate calls, missing steps, an unfinished final step, and fallback after an already successful first step.

Explicit unresolved diagnostics (original assertion code retained in named `unresolved*Assertions` functions):

- A-01: missing-template-variable grammar (`SPEC-GAP-NR-TEMPLATE-GRAMMAR`). The public notes explicitly leave the syntax undefined. Known literal-template freeze and strict unknown-variable behavior still execute.
- D-01: Notification collection route (`SPEC-GAP-NR-NOTIFICATION-COLLECTION`). V2 publishes Notification creation/read but no GET collection; the old pagination assertions cannot call an inferred route. Existing create/read/error/tenant/no-effect checks still execute.
- D-02: secret provisioning and signature composition (`SPEC-GAP-NR-WEBHOOK-SIGNING`). The public surface defines neither a secret seed field nor a configuration command. Provider identity and duplicate-receipt checks still execute; the HMAC assertions remain available for a future public clarification.

Existing Campaign/performance diagnostics are retained; some Campaign transport gaps are now resolved by V2 but implementing those previously diagnostic scenarios requires separate author review. Manifest, case IDs, weights, and scoring policy are unchanged. No new diagnostics are silently counted as business passes.

Validation: `node --test test/evaluator-wire-notifyroute.test.mjs` checks all 22 registry entries, base/scripted seeds for every case, content digests, actual positive helper requests, later-version bodies and strict malformed-wire boundaries against the frozen public validator. Live business evaluation and release certification are separate.
