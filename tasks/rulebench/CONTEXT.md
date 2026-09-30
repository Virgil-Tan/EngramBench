# RuleBench Domain Language

- **RuleSetVersion**: one immutable, published collection of ordered declarative Rules.
- **Rule**: a condition plus effects, priority, and terminal flag; user-supplied executable code is forbidden.
- **Evaluation**: one durable decision against one frozen RuleSetVersion and canonical facts digest.
- **ExplanationNode**: one ordered, immutable record of a visited condition and result.
- **ReplayRun**: a deterministic re-evaluation using the original frozen version and facts.
- **Conflict**: a statically detectable ambiguity, duplicate priority, unreachable rule, or invalid expression.
- **ComparisonRun**: the Manager-added shadow comparison of baseline and candidate versions over a frozen corpus.

Use these terms consistently. Do not call a RuleSetVersion a policy, an Evaluation a request, or an
ExplanationNode a log line.
