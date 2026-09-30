import { createHash } from "node:crypto";

function digest(seed, label) {
  return createHash("sha256").update(`${seed}\0${label}`).digest("hex");
}

function uuidFrom(hex) {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function contentDigest(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function bytewise(values) {
  return [...values].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

export function createFixtureFactory({ evaluationSeed, caseId, baseTime }) {
  const seed = `${evaluationSeed}\0${caseId}`;
  const epoch = Date.parse(baseTime);
  if (!Number.isFinite(epoch)) throw new TypeError("baseTime must be an ISO timestamp");
  return Object.freeze({
    uuid: (label) => uuidFrom(digest(seed, `uuid:${label}`)),
    key: (label) => `cr-${String(label).replace(/[^a-z0-9-]/giu, "-").slice(0, 72)}-${digest(seed, `key:${label}`).slice(0, 24)}`,
    at: ({ milliseconds = 0, seconds = 0 } = {}) => new Date(epoch + milliseconds + seconds * 1000).toISOString(),
    seed,
  });
}

export function agentCatalog(fixtures, options = {}) {
  const count = options.count ?? 7;
  const cohortCount = options.cohortCount ?? Math.min(3, count);
  const fleetId = fixtures.uuid(`fleet:${options.label ?? "primary"}`);
  const content = options.content ?? { enabled:true, limit:7, nested:{ region:"global" } };
  const configuration = {
    fleetId,
    revision: 1,
    content,
    canonicalDigest: contentDigest(content),
    createdAt: fixtures.at(),
  };
  // Rollback acknowledgements require a real positive configuration revision.
  // Keep legacy zero-state fixtures unchanged; staged recovery opts into 1 -> 2.
  const baseline = options.rollbackBaseline ? { ...configuration } : undefined;
  if (baseline) {
    configuration.revision = 2;
    configuration.content = { rollout: "next", previous: content };
    configuration.canonicalDigest = contentDigest(configuration.content);
  }
  const agents = Array.from({ length:count }, (_, index) => ({
    agentId: fixtures.uuid(`agent:${options.label ?? "primary"}:${String(index).padStart(6, "0")}`),
    fleetId,
    labels: {
      environment: options.environment ?? "production",
      cohort: `c${index % cohortCount}`,
      parity: index % 2 === 0 ? "even" : "odd",
    },
    appliedRevision: baseline?.revision ?? 0,
    appliedDigest: baseline?.canonicalDigest ?? null,
    lastCommandSequence: 0,
    lastSeenAt: fixtures.at({ milliseconds:index }),
  }));
  return Object.freeze({
    fleet: { fleetId, name:options.name ?? "Primary Fleet", currentRevision:configuration.revision },
    configuration,
    configurations: baseline ? [baseline, configuration] : [configuration],
    agents,
    outerSelector: { labels:{ key:"environment",value:options.environment ?? "production" } },
  });
}

export function stagedPlan(catalog, count = 3, overrides = {}) {
  return Array.from({ length:count }, (_, ordinal) => ({
    name: `Cohort ${ordinal + 1}`,
    selector: { labels:{ key:"cohort",value:`c${ordinal}` } },
    minimumSuccessBasisPoints: overrides.minimumSuccessBasisPoints ?? 5714,
    maximumFailureBasisPoints: overrides.maximumFailureBasisPoints ?? 4285,
    observationSeconds: overrides.observationSeconds ?? 30,
  }));
}

export function configurationBody(content, expectedFleetRevision = 1) {
  return { content, expectedFleetRevision };
}

export function deploymentBody(catalog, options = {}) {
  return {
    fleetId: catalog.fleet.fleetId,
    configurationRevision: options.configurationRevision ?? catalog.configuration.revision,
    selector: options.selector ?? catalog.outerSelector,
    expectedFleetRevision: options.expectedFleetRevision ?? catalog.fleet.currentRevision,
    ...(Object.hasOwn(options, "cohorts") ? { cohorts:options.cohorts } : {}),
  };
}

export function acknowledgementBody(command, outcome = "APPLIED") {
  return {
    deploymentId: command.deploymentId,
    commandSequence: command.commandSequence,
    revision: command.revision ?? command.toRevision,
    digest: command.digest ?? command.toDigest,
    assignmentToken: command.assignmentToken,
    outcome,
  };
}

export function v1Seed(fixtures, seedVersion = "configrelay-v1", options = {}) {
  const catalog = options.catalog ?? agentCatalog(fixtures, options);
  return {
    schemaVersion: 1,
    seedVersion,
    fleets: options.fleets ?? [catalog.fleet],
    agents: options.agents ?? catalog.agents,
    configurations: options.configurations ?? catalog.configurations ?? [catalog.configuration],
    deployments: options.deployments ?? [],
    assignments: options.assignments ?? [],
  };
}

export function seededLegacyDeployment(fixtures, catalog, label = "legacy", options = {}) {
  const members = bytewise(options.members ?? catalog.agents.map(({ agentId }) => agentId));
  return {
    deploymentId: fixtures.uuid(`deployment:${label}`),
    fleetId: catalog.fleet.fleetId,
    configurationRevision: options.configurationRevision ?? catalog.configuration.revision,
    selector: options.selector ?? catalog.outerSelector,
    targetCount: members.length,
    targetDigest: createHash("sha256").update(members.join("\n")).digest("hex"),
    state: options.state ?? "PENDING",
    createdAt: options.createdAt ?? fixtures.at({ seconds:1 }),
    completedAt: options.completedAt ?? null,
    sequence: options.sequence ?? 1,
  };
}

export function seededAssignment(fixtures, deployment, agent, index = 0, options = {}) {
  return {
    assignmentId: fixtures.uuid(`assignment:${deployment.deploymentId}:${agent.agentId}`),
    deploymentId: deployment.deploymentId,
    agentId: agent.agentId,
    commandSequence: options.commandSequence ?? 1,
    revision: options.revision ?? deployment.configurationRevision,
    digest: options.digest,
    state: options.state ?? "WAITING",
    deliveryId: fixtures.uuid(`delivery:${deployment.deploymentId}:${agent.agentId}`),
    assignmentToken: `token-${digest(fixtures.seed, `assignment-token:${deployment.deploymentId}:${agent.agentId}`).slice(0, 40)}`,
    sentAt: options.sentAt ?? null,
    ackedAt: options.ackedAt ?? null,
  };
}

function scaled(value, factor, minimum = 1) {
  return factor === 1 ? value : Math.max(minimum, Math.round(value * factor));
}

export function performanceContract(factor = 1) {
  if (!(factor > 0 && factor <= 1)) throw new RangeError("performance scale must be in (0,1]");
  return Object.freeze({
    factor,
    seed: {
      fleetCount:scaled(100, factor),
      agentCount:scaled(100_000, factor, 2),
      configurationCount:scaled(1_000, factor),
      deploymentCount:scaled(500, factor),
      assignmentCount:scaled(50_000, factor),
    },
    poll: {
      concurrency:64,
      warmupSeconds:factor === 1 ? 10 : 1,
      measureSeconds:factor === 1 ? 60 : 1,
      targetPerSecond:factor === 1 ? 2_000 : 1,
      p95Ms:80,
      agentCount:scaled(100_000, factor, 2),
      commandCount:scaled(50_000, factor),
    },
    acknowledgement: {
      concurrency:64,
      warmupSeconds:factor === 1 ? 10 : 1,
      measureSeconds:factor === 1 ? 60 : 1,
      targetPerSecond:factor === 1 ? 1_000 : 1,
      p95Ms:180,
      warmupUnique:scaled(5_000, factor),
      measuredUnique:scaled(30_000, factor),
    },
    delivery: {
      concurrency:2,
      maximumSeconds:factor === 1 ? 120 : 10,
      assignmentCount:scaled(50_000, factor),
    },
  });
}

export function performanceSeed(fixtures, factor = 1) {
  const contract = performanceContract(factor);
  const { fleetCount, agentCount, configurationCount, deploymentCount, assignmentCount } = contract.seed;
  const fleets = Array.from({ length:fleetCount }, (_, index) => ({
    fleetId:fixtures.uuid(`perf:fleet:${index}`),
    name:`Perf Fleet ${index}`,
    currentRevision:Math.max(1, Math.ceil(configurationCount / fleetCount)),
  }));
  const configurations = Array.from({ length:configurationCount }, (_, index) => {
    const fleetIndex = index % fleetCount;
    const revision = Math.floor(index / fleetCount) + 1;
    const content = { fleet:fleetIndex, revision, mode:"performance" };
    return { fleetId:fleets[fleetIndex].fleetId,revision,content,canonicalDigest:contentDigest(content),createdAt:fixtures.at({ milliseconds:index }) };
  });
  const deploymentMembers = Array.from({ length:deploymentCount }, () => []);
  const agents = Array.from({ length:agentCount }, (_, index) => {
    const fleetIndex = index % fleetCount;
    const eligible = index < assignmentCount;
    const deploymentIndex = eligible ? index % deploymentCount : -1;
    const agent = {
      agentId:fixtures.uuid(`perf:agent:${String(index).padStart(6, "0")}`),
      fleetId:fleets[fleetIndex].fleetId,
      labels:eligible ? { mode:"command",slot:`s${deploymentIndex}` } : { mode:"current" },
      appliedRevision:eligible ? 0 : fleets[fleetIndex].currentRevision,
      appliedDigest:eligible ? null : configurations.find((item) => item.fleetId === fleets[fleetIndex].fleetId && item.revision === fleets[fleetIndex].currentRevision)?.canonicalDigest ?? null,
      lastCommandSequence:eligible ? 1 : 0,
      lastSeenAt:fixtures.at({ milliseconds:index }),
    };
    if (eligible) deploymentMembers[deploymentIndex].push(agent.agentId);
    return agent;
  });
  const deployments = Array.from({ length:deploymentCount }, (_, index) => {
    const fleetIndex = index % fleetCount;
    const revision = (Math.floor(index / fleetCount) % fleets[fleetIndex].currentRevision) + 1;
    const configuration = configurations.find((item) => item.fleetId === fleets[fleetIndex].fleetId && item.revision === revision);
    const members = bytewise(deploymentMembers[index]);
    return {
      deploymentId:fixtures.uuid(`perf:deployment:${index}`),
      fleetId:fleets[fleetIndex].fleetId,
      configurationRevision:revision,
      selector:{ labels:{ key:"slot",value:`s${index}` } },
      targetCount:members.length,
      targetDigest:createHash("sha256").update(members.join("\n")).digest("hex"),
      state:"PENDING",
      createdAt:fixtures.at({ seconds:1,milliseconds:index }),
      completedAt:null,
      sequence:Math.floor(index / fleetCount) + 1,
      configuration,
    };
  });
  const assignmentByAgent = new Map(agents.slice(0, assignmentCount).map((agent, index) => [agent.agentId, index % deploymentCount]));
  const assignments = agents.slice(0, assignmentCount).map((agent) => {
    const deployment = deployments[assignmentByAgent.get(agent.agentId)];
    const configuration = deployment.configuration;
    return {
      assignmentId:fixtures.uuid(`perf:assignment:${agent.agentId}`),
      deploymentId:deployment.deploymentId,
      agentId:agent.agentId,
      commandSequence:1,
      revision:deployment.configurationRevision,
      digest:configuration.canonicalDigest,
      state:"WAITING",
      deliveryId:fixtures.uuid(`perf:delivery:${agent.agentId}`),
      assignmentToken:`token-${digest(fixtures.seed, `perf:token:${agent.agentId}`).slice(0, 40)}`,
      sentAt:null,
      ackedAt:null,
    };
  });
  return {
    schemaVersion:1,
    seedVersion:"perf-v1",
    fleets,
    agents,
    configurations,
    deployments:deployments.map(({ configuration: _configuration, ...deployment }) => deployment),
    assignments,
  };
}
