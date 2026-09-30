# FraudLens Context

FraudLens models tenant-scoped, versioned risk decisions and their correction history.

- `RiskEvent` is an immutable fact submitted for one subject and transaction.
- `RuleVersion` is immutable after activation; each `Assessment` freezes exactly one version.
- `RuleHit` explains one deterministic score contribution.
- `ReviewCase` is the human-review lifecycle for one Assessment.
- `Decision` is append-only; a correction supersedes but never rewrites an earlier decision.
- `RuleRollback` changes only the active version for future Assessments.
- `RemediationRun` and `AssessmentCorrection` are introduced only by the Manager message.

Do not conflate idempotency identity, external event identity, subject identity, and rule-version identity.
