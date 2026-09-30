import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => { assertUnicode(key); return `${JSON.stringify(key)}:${canonical(value[key])}`; }).join(",")}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError("RFC 8785 rejects non-finite numbers");
  if (typeof value === "string") assertUnicode(value);
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("RFC 8785 rejects unsupported JSON values");
  return encoded;
}

function assertUnicode(value) {
  for (let index=0;index<value.length;index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError("RFC 8785 rejects lone surrogates");
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) throw new TypeError("RFC 8785 rejects lone surrogates");
  }
}

export function sha256(value) {
  const bytes = typeof value === "string" ? value : canonical(value);
  return createHash("sha256").update(bytes).digest("hex");
}

export function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(String(left)), Buffer.from(String(right)));
}

export function digestMembers(agentIds) {
  return sha256([...agentIds].sort(compareUtf8).join("\n"));
}

export function basisPoints(count, denominator) {
  assert.ok(Number.isSafeInteger(count) && count >= 0);
  assert.ok(Number.isSafeInteger(denominator) && denominator > 0);
  return Number((BigInt(count) * 10_000n) / BigInt(denominator));
}

export function cohortVerdict(cohort, { deadline = false } = {}) {
  const result = {
    successCount:cohort.successCount,
    failureCount:cohort.failureCount,
    pendingCount:cohort.pendingCount,
  };
  assert.equal(result.successCount + result.failureCount + result.pendingCount, cohort.targetCount);
  if (deadline) {
    result.failureCount += result.pendingCount;
    result.pendingCount = 0;
  }
  if (result.pendingCount > 0) return { ...result,state:"OBSERVING" };
  const succeeds = basisPoints(result.successCount, cohort.targetCount) >= cohort.minimumSuccessBasisPoints && basisPoints(result.failureCount, cohort.targetCount) <= cohort.maximumFailureBasisPoints;
  return { ...result,state:succeeds ? "SUCCEEDED" : "FAILED" };
}

export function affectedAgents(commands, failedOrdinal) {
  return [...new Set(commands.filter((command) => command.kind === "APPLY" && command.state === "ACKED" && command.cohortOrdinal <= failedOrdinal && command.fromRevision < command.toRevision).map(({ agentId }) => agentId))].sort(compareUtf8);
}

export function assertExactKeys(value, keys, label = "object") {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} keys`);
}

function assertUuid(value) {
  assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
}

function assertTimestamp(value) {
  assert.equal(typeof value, "string");
  assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
}

function assertDigest(value) {
  assert.match(value, /^[0-9a-f]{64}$/u);
}

const DEPLOYMENT_KEYS = ["deploymentId","fleetId","configurationRevision","selector","targetCount","targetDigest","state","createdAt","completedAt","sequence"];
const ASSIGNMENT_KEYS = ["assignmentId","deploymentId","agentId","commandSequence","revision","digest","state","deliveryId","assignmentToken","sentAt","ackedAt"];
const COHORT_KEYS = ["cohortId","deploymentId","ordinal","name","selector","targetCount","targetDigest","minimumSuccessBasisPoints","maximumFailureBasisPoints","observationSeconds","successCount","failureCount","pendingCount","state","startedAt","observationDeadlineAt","completedAt"];
const COMMAND_KEYS = ["commandId","deploymentId","cohortId","agentId","commandSequence","kind","fromRevision","toRevision","toDigest","deliveryId","assignmentToken","state","createdAt","ackedAt"];
const ROLLBACK_KEYS = ["rollbackId","deploymentId","failedCohortId","state","commandCount","completedCount","startedAt","completedAt"];

function assertSelector(value) {
  assertExactKeys(value,["labels"],"selector"); assertExactKeys(value.labels,["key","value"],"selector.labels"); assert.match(value.labels.key,/^[a-z][a-z0-9_.-]{0,63}$/u); assert.equal(typeof value.labels.value,"string");
}

export function assertConfiguration(value, expected = {}) {
  assertExactKeys(value,["fleetId","revision","content","canonicalDigest","createdAt"],"Configuration");
  assertUuid(value.fleetId); assert.ok(Number.isSafeInteger(value.revision) && value.revision > 0); assertDigest(value.canonicalDigest); assertTimestamp(value.createdAt);
  assert.equal(value.canonicalDigest, sha256(value.content));
  for (const [key,wanted] of Object.entries(expected)) assert.deepEqual(value[key], wanted);
}

export function assertDeployment(value, { staged = false } = {}) {
  assertExactKeys(value, staged ? [...DEPLOYMENT_KEYS,"cohorts","rollback"] : DEPLOYMENT_KEYS, staged ? "staged Deployment" : "legacy Deployment");
  assertUuid(value.deploymentId); assertUuid(value.fleetId); assert.ok(Number.isSafeInteger(value.configurationRevision) && value.configurationRevision > 0); assertSelector(value.selector); assertDigest(value.targetDigest);
  assert.ok(Number.isSafeInteger(value.targetCount) && value.targetCount >= 0); assert.ok(["PENDING","DELIVERING","APPLIED","FAILED","CANCELLED"].includes(value.state)); assertTimestamp(value.createdAt); if (value.completedAt !== null) assertTimestamp(value.completedAt);
  if (staged) { assert.ok(Array.isArray(value.cohorts)); value.cohorts.forEach(assertCohort); assert.deepEqual(value.cohorts.map(({ ordinal }) => ordinal), value.cohorts.map((_item,index) => index)); if (value.rollback !== null) assertRollback(value.rollback); }
}

export function assertAssignment(value) {
  assertExactKeys(value,ASSIGNMENT_KEYS,"Assignment");
  for (const key of ["assignmentId","deploymentId","agentId","deliveryId"]) assertUuid(value[key]);
  assert.ok(Number.isSafeInteger(value.commandSequence) && value.commandSequence > 0); assert.ok(Number.isSafeInteger(value.revision) && value.revision > 0); assertDigest(value.digest); assert.ok(["WAITING","SENT","ACKED","FAILED","SUPERSEDED"].includes(value.state)); assert.ok(typeof value.assignmentToken === "string" && value.assignmentToken.length > 0); if (value.sentAt !== null) assertTimestamp(value.sentAt); if (value.ackedAt !== null) assertTimestamp(value.ackedAt);
}

export function assertAcknowledgement(value) {
  assertExactKeys(value,["agentId","deploymentId","commandSequence","revision","digest","assignmentToken","outcome","reportedAt"],"Acknowledgement");
  assertUuid(value.agentId); assertUuid(value.deploymentId); assert.ok(Number.isSafeInteger(value.commandSequence) && value.commandSequence > 0); assert.ok(Number.isSafeInteger(value.revision) && value.revision > 0); assertDigest(value.digest); assert.ok(typeof value.assignmentToken === "string" && value.assignmentToken.length > 0); assert.ok(["APPLIED","REJECTED"].includes(value.outcome)); assertTimestamp(value.reportedAt);
}

export function assertCohort(value) {
  assertExactKeys(value,COHORT_KEYS,"DeploymentCohort");
  assertUuid(value.cohortId); assertUuid(value.deploymentId); assert.ok(Number.isSafeInteger(value.ordinal) && value.ordinal >= 0); assert.equal(typeof value.name,"string"); assertSelector(value.selector); assertDigest(value.targetDigest);
  for (const key of ["targetCount","minimumSuccessBasisPoints","maximumFailureBasisPoints","observationSeconds","successCount","failureCount","pendingCount"]) assert.ok(Number.isSafeInteger(value[key]) && value[key] >= 0);
  assert.ok(value.targetCount > 0); assert.ok(value.minimumSuccessBasisPoints <= 10_000); assert.ok(value.maximumFailureBasisPoints <= 10_000); assert.ok(value.observationSeconds >= 1 && value.observationSeconds <= 86_400); assert.equal(value.successCount + value.failureCount + value.pendingCount,value.targetCount); assert.ok(["WAITING","DELIVERING","OBSERVING","SUCCEEDED","FAILED","ROLLED_BACK"].includes(value.state));
  for (const key of ["startedAt","observationDeadlineAt","completedAt"]) if (value[key] !== null) assertTimestamp(value[key]);
}

export function assertRolloutCommand(value) {
  assertExactKeys(value,COMMAND_KEYS,"RolloutCommand");
  for (const key of ["commandId","deploymentId","cohortId","agentId","deliveryId"]) assertUuid(value[key]);
  for (const key of ["commandSequence","fromRevision","toRevision"]) assert.ok(Number.isSafeInteger(value[key]) && value[key] >= 0); assert.ok(value.commandSequence > 0); assertDigest(value.toDigest); assert.ok(typeof value.assignmentToken === "string" && value.assignmentToken.length > 0); assert.ok(["APPLY","ROLLBACK"].includes(value.kind)); assert.ok(["WAITING","SENT","ACKED","FAILED","SUPERSEDED"].includes(value.state)); assertTimestamp(value.createdAt); if (value.ackedAt !== null) assertTimestamp(value.ackedAt);
}

export function assertRollback(value) {
  assertExactKeys(value,ROLLBACK_KEYS,"DeploymentRollback");
  for (const key of ["rollbackId","deploymentId","failedCohortId"]) assertUuid(value[key]); assert.ok(["PENDING","DELIVERING","COMPLETED","FAILED"].includes(value.state)); assert.ok(Number.isSafeInteger(value.commandCount) && value.commandCount >= 0); assert.ok(Number.isSafeInteger(value.completedCount) && value.completedCount >= 0 && value.completedCount <= value.commandCount); assertTimestamp(value.startedAt); if (value.completedAt !== null) assertTimestamp(value.completedAt);
}

export function assertAgentPoll(value) {
  assertExactKeys(value,["status","command"],"AgentPollResponse");
  assert.ok(["COMMAND","NO_CHANGE"].includes(value.status)); assert.equal(value.status === "NO_CHANGE",value.command === null);
  if (value.command !== null) {
    if (Object.hasOwn(value.command,"assignmentId")) assertAssignment(value.command); else assertRolloutCommand(value.command);
  }
}

export function assertPublicError(response,status,code) {
  assert.equal(response.status,status); assertExactKeys(response.json,["error"],"error response"); assertExactKeys(response.json.error,["code","message","details"],"error"); assert.equal(response.json.error.code,code); assert.equal(typeof response.json.error.message,"string"); assert.ok(response.json.error.details && typeof response.json.error.details === "object");
}

export function assertWork(value) {
  assertExactKeys(value,["workId","kind","aggregateId","state","terminal","attempt","leaseOwner","leaseExpiresAt"],"Work"); assertUuid(value.workId); assertUuid(value.aggregateId); assert.ok(["ASSIGNMENT_DELIVERY","COHORT_DEADLINE","ROLLBACK_DELIVERY"].includes(value.kind)); assert.ok(["PENDING","LEASED","SUCCEEDED","FAILED","CANCELLED"].includes(value.state)); assert.equal(value.terminal,["SUCCEEDED","FAILED","CANCELLED"].includes(value.state)); assert.equal(value.state === "LEASED",value.leaseOwner !== null && value.leaseExpiresAt !== null);
}

export function assertEvent(value) {
  assertExactKeys(value,["eventId","aggregateId","sequence","type","occurredAt","schemaVersion","payload"],"DomainEvent"); assertUuid(value.eventId); assertUuid(value.aggregateId); assert.ok(Number.isSafeInteger(value.sequence) && value.sequence > 0); assert.ok(["deployment.created","assignment.sent","assignment.acknowledged","assignment.failed","deployment.completed","deployment.cancelled"].includes(value.type)); assertTimestamp(value.occurredAt); assert.equal(value.schemaVersion,1); assert.deepEqual(value.payload,{});
}

function assertNoTokens(value,path = "snapshot") {
  if (Array.isArray(value)) return value.forEach((item,index) => assertNoTokens(item,`${path}[${index}]`));
  if (!value || typeof value !== "object") return;
  for (const [key,item] of Object.entries(value)) { assert.ok(!key.endsWith("Token"),`${path}.${key} leaks a *Token field`); assertNoTokens(item,`${path}.${key}`); }
}

function assertSorted(items, selector, label) {
  const actual = items.map(selector); const expected = [...actual].sort((left,right) => { for (let index=0;index<left.length;index += 1) { const order = compareUtf8(left[index] ?? "",right[index] ?? ""); if (order) return order; } return 0; }); assert.deepEqual(actual,expected,`${label} ordering`);
}

function assertAgent(value) {
  assertExactKeys(value,["agentId","fleetId","labels","appliedRevision","appliedDigest","desiredRevision","desiredDigest","drift","lastCommandSequence","lastSeenAt"],"Agent");
  assertUuid(value.agentId); assertUuid(value.fleetId); assert.ok(value.labels && typeof value.labels === "object" && !Array.isArray(value.labels)); for (const [key,label] of Object.entries(value.labels)) { assert.match(key,/^[a-z][a-z0-9_.-]{0,63}$/u); assert.equal(typeof label,"string"); } assert.ok(Number.isSafeInteger(value.appliedRevision) && value.appliedRevision >= 0); if (value.appliedDigest !== null) assertDigest(value.appliedDigest); if (value.desiredRevision !== null) assert.ok(Number.isSafeInteger(value.desiredRevision) && value.desiredRevision > 0); if (value.desiredDigest !== null) assertDigest(value.desiredDigest); assert.equal(typeof value.drift,"boolean"); assert.ok(Number.isSafeInteger(value.lastCommandSequence) && value.lastCommandSequence >= 0); assertTimestamp(value.lastSeenAt);
}

function assertSnapshotAssignment(value) {
  assertExactKeys(value,ASSIGNMENT_KEYS.filter((key) => key !== "assignmentToken"),"snapshot Assignment");
  assertAssignment({ ...value,assignmentToken:"redacted" });
}

function assertSnapshotAcknowledgement(value) {
  assertExactKeys(value,["agentId","deploymentId","commandSequence","revision","digest","outcome","reportedAt"],"snapshot Acknowledgement");
  assertAcknowledgement({ ...value,assignmentToken:"redacted" });
}

function assertSnapshotCommand(value) {
  assertExactKeys(value,COMMAND_KEYS.filter((key) => key !== "assignmentToken"),"snapshot RolloutCommand");
  assertRolloutCommand({ ...value,assignmentToken:"redacted" });
}

export function assertCommittedResourcesPreserved(before, after) {
  assert.deepEqual(after.resources, before.resources, "restart retains the complete committed resource graph");
}

export function reconcileSnapshot(snapshot,{ final = true } = {}) {
  assertExactKeys(snapshot,["asOf","resources","work","events"],"verification snapshot"); assertTimestamp(snapshot.asOf);
  const keys = final ? ["agents","configurations","deployments","assignments","acknowledgements","deploymentCohorts","rolloutCommands","deploymentRollbacks"] : ["agents","configurations","deployments","assignments","acknowledgements"];
  assertExactKeys(snapshot.resources,keys,"snapshot resources"); assertNoTokens(snapshot);
  const resources = snapshot.resources;
  resources.agents.forEach(assertAgent); resources.configurations.forEach(assertConfiguration); resources.deployments.forEach((item) => assertDeployment(item,{ staged:Object.hasOwn(item,"cohorts") })); resources.assignments.forEach(assertSnapshotAssignment); resources.acknowledgements.forEach(assertSnapshotAcknowledgement); resources.deploymentCohorts?.forEach(assertCohort); resources.rolloutCommands?.forEach(assertSnapshotCommand); resources.deploymentRollbacks?.forEach(assertRollback); snapshot.work.forEach(assertWork); snapshot.events.forEach(assertEvent);
  const deployments = new Set(resources.deployments.map(({ deploymentId }) => deploymentId)); const agents = new Set(resources.agents.map(({ agentId }) => agentId));
  for (const item of resources.assignments) { assert.ok(deployments.has(item.deploymentId)); assert.ok(agents.has(item.agentId)); }
  for (const item of resources.deploymentCohorts ?? []) assert.ok(deployments.has(item.deploymentId));
  for (const item of resources.rolloutCommands ?? []) { assert.ok(deployments.has(item.deploymentId)); assert.ok(agents.has(item.agentId)); }
  assertSorted(resources.agents,(item) => [item.agentId,canonical(item)],"agents"); assertSorted(resources.configurations,(item) => [item.fleetId,String(item.revision).padStart(16,"0"),canonical(item)],"configurations"); assertSorted(resources.deployments,(item) => [item.deploymentId,canonical(item)],"deployments"); assertSorted(resources.assignments,(item) => [item.assignmentId,canonical(item)],"assignments"); assertSorted(resources.acknowledgements,(item) => [item.agentId,item.deploymentId,String(item.commandSequence).padStart(16,"0"),canonical(item)],"acknowledgements");
  if (final) {
    assertSorted(resources.deploymentCohorts,(item) => [item.deploymentId,String(item.ordinal).padStart(16,"0"),item.cohortId,canonical(item)],"deploymentCohorts");
    assertSorted(resources.rolloutCommands,(item) => [item.deploymentId,item.agentId,String(item.commandSequence).padStart(16,"0"),canonical(item)],"rolloutCommands");
    assertSorted(resources.deploymentRollbacks,(item) => [item.deploymentId,canonical(item)],"deploymentRollbacks");
  }
  assertSorted(snapshot.work,(item) => [item.workId],"work"); assertSorted(snapshot.events,(item) => [item.aggregateId,String(item.sequence).padStart(16,"0"),item.eventId],"events");
  return true;
}

export function percentile(values,fraction) {
  assert.ok(values.length > 0); const sorted = [...values].sort((left,right) => left-right); return sorted[Math.max(0,Math.ceil(sorted.length * fraction)-1)];
}
