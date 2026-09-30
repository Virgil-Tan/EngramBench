import { ref, obj, arr, one, nil, str, text, bool, count, positive, uuid, time, sha, en, pick, page, op, q, paging, manager, wire, T, id, key, digest, environmentVariables, commands, commonSchemas, snapshot, seedSchema, infra, observe, basicSmoke, seedSmoke, commonNotes } from './helpers-a2.mjs';

const mode = en('BACKWARD', 'FORWARD', 'FULL');
const schemas = {
  ...commonSchemas(['SCHEMA_VALIDATION', 'BUNDLE_VALIDATION'], ['schema.validation-started', 'schema.rejected', 'schema.published', 'subject.mode-changed', 'bundle.published']),
  Subject: obj({ subjectId: uuid, name: text, compatibilityMode: mode, modeRevision: positive, headVersion: nil(positive), createdAt: time }),
  RecordSchema: obj({ name: text, fields: { type: 'object', propertyNames: { pattern: '^[a-z][a-zA-Z0-9_]{0,63}$' }, additionalProperties: obj({ type: en('STRING', 'INTEGER', 'BOOLEAN'), required: bool }) } }),
  Dependency: obj({ subjectId: uuid, version: positive }),
  Finding: obj({ code: text, field: nil(str), message: str }),
  SchemaDraft: obj({ draftId: uuid, subjectId: uuid, expectedHeadVersion: nil(positive), compatibilityMode: mode, modeRevision: positive, schema: ref('RecordSchema'), dependencies: arr(ref('Dependency')), canonicalDigest: sha, state: en('VALIDATING', 'VALID', 'PUBLISHED', 'REJECTED', 'STALE'), findings: arr(ref('Finding')), createdAt: time }),
  LegacySchemaVersion: obj({ schemaVersionId: uuid, subjectId: uuid, version: positive, compatibilityMode: mode, modeRevision: positive, schema: ref('RecordSchema'), canonicalDigest: sha, dependencies: arr(ref('Dependency')), publishedAt: time, sequence: positive }),
  SchemaDiff: obj({ addedFields: arr(str), removedFields: arr(str), typeChanges: arr(obj({ field: str, from: str, to: str })), requiredChanges: arr(obj({ field: str, from: bool, to: bool })) }),
  BundleDependency: one(obj({ kind: { const: 'PUBLISHED' }, subjectId: uuid, version: positive }), obj({ kind: { const: 'BUNDLE_MEMBER' }, subjectId: uuid })),
  CatalogSnapshotEntry: obj({ subjectId: uuid, headVersion: nil(positive), modeRevision: positive }),
  ReleaseBundle: obj({ releaseBundleId: uuid, state: en('VALIDATING', 'READY', 'PUBLISHED', 'REJECTED', 'STALE'), members: arr(obj({ draftId: uuid, subjectId: uuid, prospectiveVersion: positive }), { minItems: 1, maxItems: 20 }), catalogSnapshot: arr(ref('CatalogSnapshotEntry')), canonicalDigest: sha, findings: arr(obj({ code: text, path: str, message: str })), createdAt: time, publishedAt: nil(time), sequence: count }),
};
schemas.SchemaVersion = obj({ ...schemas.LegacySchemaVersion.properties, releaseBundleId: nil(uuid) });
schemas.LatestSchemaResponse = obj({ subject: ref('Subject'), version: nil(ref('SchemaVersion')) });
schemas.SeedSubject = pick(schemas.Subject, ['subjectId', 'name', 'compatibilityMode', 'modeRevision']);
schemas.Seed = seedSchema({ subjects: 'SeedSubject', publishedVersions: 'LegacySchemaVersion' });
schemas.VerificationSnapshot = snapshot({ subjects: 'Subject', schemaDrafts: 'SchemaDraft', schemaVersions: 'SchemaVersion', releaseBundles: 'ReleaseBundle' });
const schema = { name: 'PublicCustomer', fields: { active: { type: 'BOOLEAN', required: false } } };
const subjectId = id(1), schemaVersionId = id(2), draftId = id(3), releaseBundleId = id(4);
const published = { schemaVersionId, subjectId, version: 1, compatibilityMode: 'BACKWARD', modeRevision: 1, schema, canonicalDigest: digest({ schema, dependencies: [] }), dependencies: [], publishedAt: T, sequence: 1 };
const draftBody = { schema: { name: 'PublicCustomerV2', fields: { active: { type: 'BOOLEAN', required: false }, label: { type: 'STRING', required: false } } }, dependencies: [], expectedHeadVersion: 1 };
export default {
  taskId: 'schemaharbor', title: 'SchemaHarbor', environmentVariables, commands,
  seed: { schema: schemas.Seed, example: { schemaVersion: 1, seedVersion: 'v2-public-schemaharbor-1', subjects: [{ subjectId, name: 'Public Customer', compatibilityMode: 'BACKWARD', modeRevision: 1 }], publishedVersions: [published] } }, schemas,
  operations: [
    ...infra(),
    op('list-schema-versions', 'GET', '/api/v1/schema-versions', 200, page(ref('SchemaVersion')), undefined, { query: { limit: 20 } }, { parameters: paging }),
    op('read-schema-version', 'GET', '/api/v1/schema-versions/:schemaVersionId', 200, ref('SchemaVersion'), undefined, { params: { schemaVersionId } }),
    op('create-subject', 'POST', '/api/v1/subjects', 201, ref('Subject'), obj({ name: text, compatibilityMode: mode }), { body: { name: 'Independent public subject', compatibilityMode: 'FULL' } }),
    op('create-schema-draft', 'POST', '/api/v1/subjects/:subjectId/schema-drafts', 202, ref('SchemaDraft'), obj({ schema: ref('RecordSchema'), dependencies: arr(ref('Dependency')), expectedHeadVersion: nil(positive) }), { params: { subjectId }, body: draftBody }),
    op('publish-schema-draft', 'POST', '/api/v1/schema-drafts/:draftId/publish', 201, obj({ draft: ref('SchemaDraft'), version: ref('SchemaVersion') }), obj({}), { params: { draftId }, body: {} }),
    op('change-compatibility-mode', 'POST', '/api/v1/subjects/:subjectId/compatibility-mode', 200, ref('Subject'), obj({ mode, expectedRevision: positive }), { params: { subjectId }, body: { mode: 'FULL', expectedRevision: 1 } }),
    op('latest-schema', 'GET', '/api/v1/subjects/:subjectId/versions/latest', 200, ref('LatestSchemaResponse'), undefined, { params: { subjectId } }),
    op('schema-diff', 'GET', '/api/v1/subjects/:subjectId/versions/:version/diff', 200, ref('SchemaDiff'), undefined, { params: { subjectId, version: 1 }, query: { against: 1 } }, { parameters: [q('against', positive, true)] }),
    op('list-subject-versions', 'GET', '/api/v1/subjects/:subjectId/versions', 200, page(ref('SchemaVersion')), undefined, { params: { subjectId }, query: { limit: 20 } }, { parameters: paging }),
    op('read-subject-version', 'GET', '/api/v1/subjects/:subjectId/versions/:version', 200, ref('SchemaVersion'), undefined, { params: { subjectId, version: 1 } }, { source: manager }),
    op('create-release-bundle', 'POST', '/api/v1/release-bundles', 200, ref('ReleaseBundle'), obj({ members: arr(obj({ subjectId: uuid, expectedHeadVersion: nil(positive), schema: ref('RecordSchema'), dependencies: arr(ref('BundleDependency')) }), { minItems: 1, maxItems: 20 }) }), { body: { members: [{ subjectId, ...draftBody }] } }, { source: manager }),
    op('read-release-bundle', 'GET', '/api/v1/release-bundles/:releaseBundleId', 200, ref('ReleaseBundle'), undefined, { params: { releaseBundleId } }, { source: manager }),
    op('publish-release-bundle', 'POST', '/api/v1/release-bundles/:releaseBundleId/publish', 200, ref('ReleaseBundle'), obj({}), { params: { releaseBundleId }, body: {} }, { source: manager }),
    ...observe(),
  ],
  smoke: [
    ...basicSmoke,
    seedSmoke({ subjects: [{ subjectId, name: 'Public Customer', headVersion: 1 }], schemaVersions: [{ schemaVersionId, subjectId, version: 1, canonicalDigest: published.canonicalDigest, releaseBundleId: null }] }),
    { operationId: 'latest-schema', params: { subjectId }, expectStatus: 200, expectBody: { subject: { subjectId, headVersion: 1 }, version: { schemaVersionId, canonicalDigest: published.canonicalDigest } } },
    { operationId: 'create-subject', body: { name: 'Independent public subject', compatibilityMode: 'FULL' }, headers: key('create-subject'), expectStatus: 201, expectBody: { name: 'Independent public subject', compatibilityMode: 'FULL', headVersion: null, modeRevision: 1 }, capture: { createdSubject: ['subjectId'] } },
    { operationId: 'latest-schema', params: { subjectId: '${createdSubject}' }, expectStatus: 200, expectBody: { subject: { subjectId: '${createdSubject}', name: 'Independent public subject', headVersion: null }, version: null } },
  ],
  notes: [...commonNotes,
    'V2 wire clarification: RecordSchema field values are exactly {type:STRING|INTEGER|BOOLEAN,required:boolean}; the stray separator in the original notation does not introduce a fourth type. Empty field maps remain legal because no public minimum was stated.',
    'The V1 seed accepts LegacySchemaVersion without releaseBundleId; FINAL snapshots and fresh version reads add releaseBundleId:null for standalone and seeded versions. Previously saved V1 replay bodies remain LegacySchemaVersion. New standalone publication uses the FINAL response shape.',
    'V2 wire clarification: schema-draft dependencies for bundle members are stored as resolved {subjectId,version} pins, using prospective member versions. ReleaseBundle captures the dependency kind and canonical digest input described by the Manager; this does not alter snapshot/head validation.',
    'Seed Subject.createdAt is the first import transaction timestamp, preserved on replay; headVersion derives from the imported contiguous version history. The example has one valid optional BOOLEAN field, a verified RFC 8785 digest, and no dependency cycle.',
    'Bundle creation and publication use 200 under the original default-status rule. Publication returns the updated ReleaseBundle. Existing subject-version routes return the Manager extension consistently; no unpublished bundle seed fields are required.',
  ],
};
