# ModerationFlow Context

ModerationFlow models tenant-scoped content review with immutable evidence and policy history.

- `ContentItem` is the immutable submitted subject.
- `EvidenceVersion` is append-only and belongs to one ContentItem.
- `PolicyVersion` is immutable after activation; every ModerationCase freezes one version.
- `ReviewStage` records one level of the review workflow.
- `ModerationDecision` is append-only and never edits evidence or a prior decision.
- `Appeal` creates a distinct review lineage referencing the challenged decision.
- `AuditEntry` belongs to a tenant sequence and digest chain.
- `PolicyRecallRun` and `Reconsideration` are introduced only by the Manager message.

Do not call a reconsideration an edit, or treat a later policy as retroactively changing a closed case.
