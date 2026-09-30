import { createHash } from "node:crypto";

const MISSING = Symbol("missing");
const LEAF_OPERATORS = new Set(["eq", "neq", "lt", "lte", "gt", "gte", "in", "exists"]);
const PATH = /^\$\.[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/u;

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("canonical JSON accepts safe integers only");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new TypeError("value is outside the RuleBench JSON dialect");
}

export function sha256Canonical(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function jsonDialect(value) {
  try { canonicalJson(value); return true; }
  catch { return false; }
}

function invalid(code, path, message) { return { ok: false, code, path, message }; }

export function validateExpression(expression, options = {}) {
  const maximumDepth = options.maximumDepth ?? 20;
  const visit = (value, depth, expressionPath) => {
    if (depth > maximumDepth) return invalid("EXPRESSION_TOO_DEEP", expressionPath, `expression depth exceeds ${maximumDepth}`);
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("INVALID_EXPRESSION", expressionPath, "expression must be an object");
    if (Object.hasOwn(value, "all") || Object.hasOwn(value, "any")) {
      const key = Object.hasOwn(value, "all") ? "all" : "any";
      if (!exactKeys(value, [key])) return invalid("UNKNOWN_FIELD", expressionPath, "composite expression has unknown fields");
      if (!Array.isArray(value[key]) || value[key].length < 1 || value[key].length > 100) return invalid("EXPRESSION_CARDINALITY", expressionPath, `${key} requires 1..100 children`);
      for (let index = 0; index < value[key].length; index += 1) {
        const result = visit(value[key][index], depth + 1, `${expressionPath}.${key}[${index}]`);
        if (!result.ok) return result;
      }
      return { ok: true };
    }
    if (Object.hasOwn(value, "not")) {
      if (!exactKeys(value, ["not"])) return invalid("UNKNOWN_FIELD", expressionPath, "not expression has unknown fields");
      return visit(value.not, depth + 1, `${expressionPath}.not`);
    }
    if (!exactKeys(value, ["op", "path", "value"])) return invalid("UNKNOWN_FIELD", expressionPath, "leaf fields must be op/path/value");
    if (!LEAF_OPERATORS.has(value.op)) return invalid("UNKNOWN_OPERATOR", expressionPath, `unknown operator ${String(value.op)}`);
    if (typeof value.path !== "string" || !PATH.test(value.path)) return invalid("INVALID_PATH", expressionPath, "path must contain ASCII identifiers");
    if (!jsonDialect(value.value)) return invalid("INVALID_OPERAND", expressionPath, "operand is outside the JSON dialect");
    if (["lt", "lte", "gt", "gte"].includes(value.op) && !Number.isSafeInteger(value.value)) return invalid("INVALID_OPERAND", expressionPath, "ordering operand must be a safe integer");
    if (value.op === "in" && !Array.isArray(value.value)) return invalid("INVALID_OPERAND", expressionPath, "in operand must be an array");
    return { ok: true };
  };
  return visit(expression, 1, "$");
}

function pathValue(facts, path) {
  let current = facts;
  for (const segment of path.slice(2).split(".")) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, segment)) return MISSING;
    current = current[segment];
  }
  return current;
}

function sameJson(left, right) {
  if (left === MISSING || right === MISSING) return left === right;
  try { return canonicalJson(left) === canonicalJson(right); }
  catch { return false; }
}

function leafResult(expression, facts) {
  const actual = pathValue(facts, expression.path);
  if (expression.op === "exists") return actual !== MISSING;
  if (expression.op === "eq") return actual !== MISSING && sameJson(actual, expression.value);
  if (expression.op === "neq") return actual === MISSING || !sameJson(actual, expression.value);
  if (expression.op === "in") return actual !== MISSING && expression.value.some((item) => sameJson(actual, item));
  if (!Number.isSafeInteger(actual) || !Number.isSafeInteger(expression.value)) throw new TypeError("ordering comparisons require safe integers");
  if (expression.op === "lt") return actual < expression.value;
  if (expression.op === "lte") return actual <= expression.value;
  if (expression.op === "gt") return actual > expression.value;
  return actual >= expression.value;
}

export function evaluateExpression(expression, facts, expressionPath = "$") {
  const validation = validateExpression(expression);
  if (!validation.ok) throw new TypeError(`${validation.code}: ${validation.message}`);
  const visit = (value, path) => {
    if (Object.hasOwn(value, "all")) {
      const nodes = [];
      for (let index = 0; index < value.all.length; index += 1) {
        const child = visit(value.all[index], `${path}.all[${index}]`);
        nodes.push(...child.nodes);
        if (!child.result) return { result: false, nodes };
      }
      return { result: true, nodes };
    }
    if (Object.hasOwn(value, "any")) {
      const nodes = [];
      for (let index = 0; index < value.any.length; index += 1) {
        const child = visit(value.any[index], `${path}.any[${index}]`);
        nodes.push(...child.nodes);
        if (child.result) return { result: true, nodes };
      }
      return { result: false, nodes };
    }
    if (Object.hasOwn(value, "not")) {
      const child = visit(value.not, `${path}.not`);
      return { result: !child.result, nodes: child.nodes };
    }
    const result = leafResult(value, facts);
    return { result, nodes: [{ path, result, reason: result ? "LEAF_TRUE" : "LEAF_FALSE" }] };
  };
  return visit(expression, expressionPath);
}

function validateRule(rule) {
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) return "INVALID_RULE";
  if (typeof rule.ruleId !== "string" || !Number.isSafeInteger(rule.priority)) return "INVALID_RULE";
  if (!rule.effect || !["ALLOW", "DENY", "REVIEW", null].includes(rule.effect.decision) || !Array.isArray(rule.effect.tags)) return "INVALID_RULE";
  if (typeof rule.terminal !== "boolean") return "INVALID_RULE";
  const expression = validateExpression(rule.condition);
  return expression.ok ? undefined : expression.code;
}

export function evaluateRuleSet({ rules, defaultDecision, facts }) {
  if (!Array.isArray(rules) || rules.length < 1 || rules.length > 5_000) throw new TypeError("a version requires 1..5000 Rules");
  if (!["ALLOW", "DENY", "REVIEW"].includes(defaultDecision)) throw new TypeError("invalid default decision");
  canonicalJson(facts);
  if (Buffer.byteLength(canonicalJson(facts)) > 256 * 1024) throw new TypeError("facts exceed 256KiB");
  const ordered = [...rules].sort((left, right) => left.priority - right.priority || left.ruleId.localeCompare(right.ruleId));
  const nodes = [];
  const matchedRuleIds = [];
  const tags = [];
  const seenTags = new Set();
  let decision;
  let stopped = false;
  for (const rule of ordered) {
    const invalidRule = validateRule(rule);
    if (invalidRule) throw new TypeError(`${invalidRule}: ${rule.ruleId ?? "unknown Rule"}`);
    if (stopped) {
      nodes.push({ ruleId: rule.ruleId, path: "$", result: "SKIPPED", reason: "TERMINAL_MATCH" });
      continue;
    }
    const evaluated = evaluateExpression(rule.condition, facts, "$.condition");
    nodes.push({ ruleId: rule.ruleId, path: "$", result: evaluated.result, reason: evaluated.result ? "RULE_MATCHED" : "RULE_NOT_MATCHED" });
    nodes.push(...evaluated.nodes.map((node) => ({ ruleId: rule.ruleId, ...node })));
    if (!evaluated.result) continue;
    matchedRuleIds.push(rule.ruleId);
    for (const tag of rule.effect.tags) if (!seenTags.has(tag)) { seenTags.add(tag); tags.push(tag); }
    if (rule.effect.decision !== null) decision = rule.effect.decision;
    if (rule.terminal) {
      if (rule.effect.decision === null) throw new TypeError("terminal Rule requires a decision");
      stopped = true;
    }
  }
  const explanationNodes = nodes.map((node, index) => ({ ordinal: index + 1, ...node }));
  return {
    decision: decision ?? defaultDecision,
    tags,
    matchedRuleIds,
    nodes: explanationNodes,
    explanationDigest: sha256Canonical(explanationNodes),
  };
}

function unconditional(condition) {
  if (!condition || typeof condition !== "object") return false;
  if (Array.isArray(condition.any) && condition.any.length === 2) {
    const [left, right] = condition.any;
    return canonicalJson(left) === canonicalJson(right?.not) || canonicalJson(right) === canonicalJson(left?.not);
  }
  return false;
}

export function detectConflicts(rules) {
  const ordered = [...rules].sort((left, right) => left.priority - right.priority || String(left.ruleId).localeCompare(String(right.ruleId)));
  const ids = new Set();
  const priorities = new Map();
  const structural = new Map();
  const reports = [];
  let terminal;
  const report = (rule, code) => reports.push({ priority: rule.priority, ruleId: rule.ruleId, code });
  for (const rule of ordered) {
    if (terminal) report(rule, "UNREACHABLE_RULE");
    if (ids.has(rule.ruleId)) report(rule, "DUPLICATE_RULE_ID");
    ids.add(rule.ruleId);
    if (priorities.has(rule.priority)) report(rule, "DUPLICATE_PRIORITY");
    else priorities.set(rule.priority, rule.ruleId);
    const invalidRule = validateRule(rule);
    if (invalidRule) report(rule, "INVALID_EXPRESSION");
    if (rule.terminal && rule.effect?.decision === null) report(rule, "TERMINAL_NULL_DECISION");
    if (!invalidRule) {
      const key = `${rule.priority}\0${canonicalJson(rule.condition)}`;
      const previous = structural.get(key);
      if (previous && previous.effect?.decision !== rule.effect?.decision) report(rule, "AMBIGUOUS_CONDITION");
      else structural.set(key, rule);
      if (rule.terminal && unconditional(rule.condition)) terminal = rule;
    }
  }
  return reports.sort((left, right) => left.priority - right.priority || left.ruleId.localeCompare(right.ruleId) || left.code.localeCompare(right.code));
}

export function compareResult({ comparisonRunId, evaluationId, ordinal, baseline, candidate, errorCode = null }) {
  const status = errorCode || baseline === null || candidate === null
    ? "ERROR"
    : canonicalJson(baseline) === canonicalJson(candidate) ? "MATCH" : "DIFF";
  const projection = {
    comparisonRunId,
    evaluationId,
    ordinal,
    status,
    baseline: baseline ?? null,
    candidate: candidate ?? null,
    errorCode: status === "ERROR" ? (errorCode ?? "DETERMINISTIC_EVALUATION_FAILED") : null,
  };
  return { ...projection, resultDigest: sha256Canonical(projection) };
}

export function assertContiguousEvents(events) {
  const identities = new Map();
  const sequences = new Map();
  for (const event of events) {
    const body = canonicalJson(event.body ?? event.payload ?? {});
    if (identities.has(event.eventId) && identities.get(event.eventId) !== body) throw new Error(`Event ${event.eventId} changed body`);
    identities.set(event.eventId, body);
    const values = sequences.get(event.aggregateId) ?? [];
    values.push(event.sequence);
    sequences.set(event.aggregateId, values);
  }
  for (const [aggregateId, values] of sequences) {
    const distinct = [...new Set(values)].sort((left, right) => left - right);
    const expected = Array.from({ length: distinct.at(-1) ?? 0 }, (_, index) => index + 1);
    if (canonicalJson(distinct) !== canonicalJson(expected)) throw new Error(`Event sequence for ${aggregateId} is not contiguous`);
  }
  return { uniqueEvents: identities.size, aggregates: sequences.size };
}

export function percentile(values, fraction) {
  if (!Array.isArray(values) || values.length === 0 || fraction < 0 || fraction > 1) throw new TypeError("invalid percentile input");
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)];
}
