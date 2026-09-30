import { createHash } from "node:crypto";

const FIELD_NAME = /^[a-z][a-zA-Z0-9_]{0,63}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TYPES = new Set(["STRING", "INTEGER", "BOOLEAN"]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, expected, label) {
  invariant(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const keys = Object.keys(value).sort();
  invariant(JSON.stringify(keys) === JSON.stringify([...expected].sort()), `${label} has an unknown ${label} key`);
}

export function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    invariant(Number.isFinite(value), "canonical JSON rejects non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  invariant(value && typeof value === "object", "canonical JSON rejects unsupported values");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

export function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
}

export function validateRecordSchema(schema) {
  exactKeys(schema, ["name", "fields"], "RecordSchema");
  invariant(typeof schema.name === "string" && schema.name.length > 0, "RecordSchema name is invalid");
  invariant(schema.fields && typeof schema.fields === "object" && !Array.isArray(schema.fields), "RecordSchema fields are invalid");
  for (const [name, definition] of Object.entries(schema.fields)) {
    invariant(FIELD_NAME.test(name), `invalid field name ${name}`);
    exactKeys(definition, ["required", "type"], `field ${name}`);
    invariant(TYPES.has(definition.type), `field ${name} has invalid type`);
    invariant(typeof definition.required === "boolean", `field ${name} required must be boolean`);
  }
  return structuredClone(schema);
}

export function normalizeDependencies(dependencies) {
  invariant(Array.isArray(dependencies), "dependencies must be an array");
  const seen = new Set();
  return dependencies.map((item) => {
    exactKeys(item, ["subjectId", "version"], "Dependency");
    invariant(UUID.test(item.subjectId) && Number.isSafeInteger(item.version) && item.version > 0, "Dependency pin is invalid");
    const key = `${item.subjectId}\0${item.version}`;
    invariant(!seen.has(key), "duplicate Dependency pin");
    seen.add(key);
    return { subjectId: item.subjectId, version: item.version };
  }).sort((left, right) => Buffer.from(left.subjectId).compare(Buffer.from(right.subjectId)) || left.version - right.version);
}

export function assertDependencyCatalog({ publishedVersions, additions = [] }) {
  invariant(Array.isArray(publishedVersions), "publishedVersions must be an array");
  invariant(Array.isArray(additions), "dependency additions must be an array");
  const pins = new Set();
  const graph = new Map();
  for (const version of publishedVersions) {
    invariant(UUID.test(version.subjectId) && Number.isSafeInteger(version.version) && version.version > 0, "published version identity is invalid");
    pins.add(`${version.subjectId}\0${version.version}`);
    graph.set(version.subjectId, new Set([...(graph.get(version.subjectId) ?? []), ...normalizeDependencies(version.dependencies).map(({ subjectId }) => subjectId)]));
  }
  for (const addition of additions) {
    invariant(UUID.test(addition.subjectId), "prospective Subject is invalid");
    const dependencies = normalizeDependencies(addition.dependencies);
    for (const dependency of dependencies) {
      invariant(pins.has(`${dependency.subjectId}\0${dependency.version}`), "Dependency pin is unpublished");
      invariant(dependency.subjectId !== addition.subjectId, "self-dependency is invalid");
    }
    graph.set(addition.subjectId, new Set([...(graph.get(addition.subjectId) ?? []), ...dependencies.map(({ subjectId }) => subjectId)]));
  }
  assertAcyclic(new Map([...graph].map(([subjectId, dependencies]) => [subjectId, [...dependencies]])));
  return true;
}

export function canonicalDigest(schema, dependencies) {
  validateRecordSchema(schema);
  return sha256({ schema, dependencies: normalizeDependencies(dependencies) });
}

export function compatibilityFindings(mode, history, prospective) {
  invariant(new Set(["BACKWARD", "FORWARD", "FULL"]).has(mode), "unknown compatibility mode");
  validateRecordSchema(prospective);
  const findings = [];
  const add = (code, field, message) => findings.push({ code, field, message });
  for (const [versionIndex, previous] of history.entries()) {
    validateRecordSchema(previous);
    const version = versionIndex + 1;
    const oldFields = previous.fields;
    const nextFields = prospective.fields;
    if (mode === "BACKWARD") {
      for (const [name, oldField] of Object.entries(oldFields)) {
        if (!nextFields[name]) add("FIELD_REMOVED", name, `field required by history version ${version} is absent`);
        else if (nextFields[name].type !== oldField.type) add("FIELD_TYPE_CHANGED", name, `field type differs from history version ${version}`);
      }
      for (const [name, nextField] of Object.entries(nextFields)) {
        if (!oldFields[name] && nextField.required) add("NEW_REQUIRED_FIELD", name, `new field is required against history version ${version}`);
      }
    } else if (mode === "FORWARD") {
      for (const [name, oldField] of Object.entries(oldFields)) {
        if (!oldField.required) continue;
        if (!nextFields[name]) add("REQUIRED_FIELD_REMOVED", name, `required field is absent against history version ${version}`);
        else if (!nextFields[name].required || nextFields[name].type !== oldField.type) add("REQUIRED_FIELD_CHANGED", name, `required field differs from history version ${version}`);
      }
    } else {
      for (const [name, oldField] of Object.entries(oldFields)) {
        const next = nextFields[name];
        if (!next) {
          if (oldField.required) add("REQUIRED_FIELD_REMOVED", name, `required field is absent against history version ${version}`);
          else add("FIELD_REMOVED", name, `field is absent against history version ${version}`);
        } else if (next.type !== oldField.type || next.required !== oldField.required) {
          add("FIELD_CHANGED", name, `field contract differs from history version ${version}`);
        }
      }
      for (const [name, next] of Object.entries(nextFields)) {
        if (!oldFields[name] && next.required) add("NEW_REQUIRED_FIELD", name, `new field is required against history version ${version}`);
      }
    }
  }
  return findings.sort((left, right) => Buffer.from(left.field ?? "").compare(Buffer.from(right.field ?? "")) || left.code.localeCompare(right.code));
}

export function assertAcyclic(graph) {
  const visiting = new Set();
  const visited = new Set();
  const visit = (node) => {
    if (visiting.has(node)) throw new Error(`dependency cycle at ${node}`);
    if (visited.has(node)) return;
    visiting.add(node);
    for (const dependency of graph.get(node) ?? []) visit(dependency);
    visiting.delete(node);
    visited.add(node);
  };
  for (const node of graph.keys()) visit(node);
  return true;
}

function normalizeBundleDependencies(dependencies) {
  invariant(Array.isArray(dependencies), "bundle dependencies must be an array");
  return dependencies.map((item) => {
    if (item.kind === "BUNDLE_MEMBER") {
      exactKeys(item, ["kind", "subjectId"], "BUNDLE_MEMBER");
      invariant(UUID.test(item.subjectId), "BUNDLE_MEMBER Subject is invalid");
      return { kind: item.kind, subjectId: item.subjectId };
    }
    invariant(item.kind === "PUBLISHED", "unknown BundleDependency kind");
    exactKeys(item, ["kind", "subjectId", "version"], "PUBLISHED dependency");
    invariant(UUID.test(item.subjectId) && Number.isSafeInteger(item.version) && item.version > 0, "published BundleDependency version is invalid");
    return { kind: item.kind, subjectId: item.subjectId, version: item.version };
  }).sort((left, right) => {
    const kind = (left.kind === "BUNDLE_MEMBER" ? 0 : 1) - (right.kind === "BUNDLE_MEMBER" ? 0 : 1);
    return kind || Buffer.from(left.subjectId).compare(Buffer.from(right.subjectId)) || (left.version ?? 0) - (right.version ?? 0);
  });
}

export function releaseBundleOracle({ members, catalogSnapshot, publishedVersions = [] }) {
  invariant(Array.isArray(members) && members.length >= 1 && members.length <= 20, "ReleaseBundle requires 1 through 20 members");
  const normalizedMembers = members.map((item) => {
    exactKeys(item, ["dependencies", "expectedHeadVersion", "schema", "subjectId"], "ReleaseBundle member");
    validateRecordSchema(item.schema);
    invariant(UUID.test(item.subjectId), "ReleaseBundle member Subject is invalid");
    invariant(item.expectedHeadVersion === null || (Number.isSafeInteger(item.expectedHeadVersion) && item.expectedHeadVersion > 0), "expectedHeadVersion is invalid");
    return { subjectId: item.subjectId, expectedHeadVersion: item.expectedHeadVersion, schema: item.schema, dependencies: normalizeBundleDependencies(item.dependencies) };
  }).sort((left, right) => Buffer.from(left.subjectId).compare(Buffer.from(right.subjectId)));
  invariant(new Set(normalizedMembers.map(({ subjectId }) => subjectId)).size === normalizedMembers.length, "ReleaseBundle Subjects must be distinct");
  const memberIds = new Set(normalizedMembers.map(({ subjectId }) => subjectId));
  const pins = new Set(publishedVersions.map(({ subjectId, version }) => `${subjectId}\0${version}`));
  const graph = new Map();
  for (const version of publishedVersions) {
    graph.set(version.subjectId, new Set([...(graph.get(version.subjectId) ?? []), ...normalizeDependencies(version.dependencies).map(({ subjectId }) => subjectId)]));
  }
  for (const { subjectId, dependencies } of normalizedMembers) {
    const targets = dependencies.map((dependency) => {
      if (dependency.kind === "BUNDLE_MEMBER") {
        invariant(memberIds.has(dependency.subjectId), "BUNDLE_MEMBER must name a member Subject");
      } else {
        invariant(pins.has(`${dependency.subjectId}\0${dependency.version}`), "PUBLISHED dependency must name a published version");
      }
      invariant(dependency.subjectId !== subjectId, "self-dependency is invalid");
      return dependency.subjectId;
    });
    graph.set(subjectId, new Set([...(graph.get(subjectId) ?? []), ...targets]));
  }
  assertAcyclic(graph);
  const normalizedCatalog = [...catalogSnapshot].map((entry) => {
    exactKeys(entry, ["headVersion", "modeRevision", "subjectId"], "CatalogSnapshotEntry");
    return structuredClone(entry);
  }).sort((left, right) => Buffer.from(left.subjectId).compare(Buffer.from(right.subjectId)));
  return {
    members: normalizedMembers,
    catalogSnapshot: normalizedCatalog,
    canonicalDigest: sha256({ members: normalizedMembers, catalogSnapshot: normalizedCatalog }),
  };
}

export function expectedCatalogSnapshot(subjects, referencedSubjectIds) {
  const byId = new Map(subjects.map((subject) => [subject.subjectId, subject]));
  return [...new Set(referencedSubjectIds)].map((subjectId) => {
    const subject = byId.get(subjectId);
    invariant(subject, `Catalog Subject ${subjectId} is missing`);
    return {
      subjectId,
      headVersion: subject.headVersion ?? null,
      modeRevision: subject.modeRevision,
    };
  }).sort((left, right) => Buffer.from(left.subjectId).compare(Buffer.from(right.subjectId)));
}

export function assertGaplessVersions(versions) {
  const bySubject = Map.groupBy(versions, ({ subjectId }) => subjectId);
  for (const [subjectId, items] of bySubject) {
    const numbers = items.map(({ version }) => version).sort((a, b) => a - b);
    invariant(numbers.every((value, index) => value === index + 1), `${subjectId} has a version gap`);
  }
  return true;
}
