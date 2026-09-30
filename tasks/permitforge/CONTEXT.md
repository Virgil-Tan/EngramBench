# PermitForge Context

PermitForge models revisioned permit applications with role quorum review. This vocabulary is authoritative for the public contract,
dialogue, checklist, and evaluator design.

| Term | Canonical definition | Avoid |
| --- | --- | --- |
| Permit Application | The stable aggregate whose decision is based on one current immutable Revision. | Form, ticket |
| Application Revision | An immutable canonical field set numbered contiguously from one. | Edit, draft |
| Review Policy | The captured role quotas, total approval threshold, and veto roles for one Revision. | ACL, workflow |
| Review Claim | A persisted fenced lease allowing one Reviewer to decide one role slot. | Assignment, lock |
| Review Decision | An immutable APPROVE, REJECT, or REQUEST_CHANGES vote tied to one Revision and Claim. | Comment, status |
| Permit Deadline Task | Durable leased work that expires an undecided current Revision at its deadline. | Timer, cron |

## State language

Application: SUBMITTED -> UNDER_REVIEW -> APPROVED | REJECTED | CHANGES_REQUIRED | EXPIRED; CHANGES_REQUIRED creates one next Revision and returns to SUBMITTED.

## Core invariants

1. Application Revision numbers are contiguous and every Revision is immutable after submission.
2. Every Claim and Decision names the same captured applicationId, revision, reviewerId, and role.
3. A Reviewer records at most one Decision per Revision and a stale lease token can never commit.
4. APPROVED means every captured role quota and total threshold are satisfied with no veto Decision; no other state may expose an approval result.
5. Revision replacement, final Decision, and Deadline expiry serialize to one winner and rolled-back transitions emit no event.

Use these exact terms in API fields, UI labels, events, tests, and handoff. A synonym in explanatory
prose must not introduce a second domain concept.
