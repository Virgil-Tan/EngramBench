import { ref, str, name, uuid, time, sha, int, nat, pos, bool, nullable, list, obj, enumeration as en, page, pick, empty, T, uid, basic, work, event, seedShape, snapshotShape, operation as op, standardOps, commands, environmentVariables, keyed, admin, source, manager, wire, pagination, parameter, sharedNotes } from './helpers-a.mjs';

const tenantId = uid(1, 1), schemaId = uid(1, 2), importId = uid(1, 3), bundleId = uid(1, 4);
const bytes = '{"rowKey":"public-1","title":"Public"}\n';
const digest = '8a8d96281308a0a4d028c95c7a520dc845e3411e2ecd3d04060ab43acc45198d';
const mode = en('ALL_OR_NOTHING', 'VALID_ROWS');
const schemas = {
  ...basic,
  Schema: obj({ schemaId: uuid, tenantId: uuid, datasetKey: name, name }),
  SchemaField: obj({ name, type: en('string', 'integer', 'number', 'boolean', 'object'), required: bool, maxLength: nat, minimum: { type: 'number' }, maximum: { type: 'number' } }, ['name', 'type', 'required']),
  SchemaRevision: obj({ schemaId: uuid, revision: pos, externalIdField: name, additionalProperties: { const: false }, fields: list(ref('SchemaField'), { minItems: 1 }) }),
  ImportJob: obj({ importId: uuid, tenantId: uuid, datasetKey: name, schemaRevision: pos, commitMode: mode, state: en('UPLOADING', 'UPLOADED', 'VALIDATING', 'VALIDATED', 'COMMITTING', 'COMMITTED', 'PARTIALLY_COMMITTED', 'REJECTED', 'CANCELLED'), expectedBytes: pos, expectedSha256: sha, receivedBytes: nat, totalRows: nat, validRows: nat, invalidRows: nat, createdAt: time, completedAt: nullable(time), sequence: nat }),
  UploadChunk: obj({ importId: uuid, chunkNumber: nat, start: nat, end: nat, size: pos, sha256: sha, receivedAt: time }),
  ValidationFinding: obj({ findingId: uuid, importId: uuid, rowNumber: pos, externalRowId: nullable(str), field: str, code: str, message: str, valueDigest: nullable(sha) }),
  CommittedRecord: obj({ recordId: uuid, tenantId: uuid, datasetKey: name, externalRowId: str, sourceImportId: uuid, payload: ref('JsonValue'), payloadDigest: sha, committedAt: time }),
  ErrorReport: obj({ reportId: uuid, importId: uuid, state: en('PENDING', 'READY', 'FAILED'), rowCount: nat, sha256: nullable(sha), createdAt: time, readyAt: nullable(time) }),
  ImportBundle: obj({ bundleId: uuid, tenantId: uuid, name, state: en('DRAFT', 'STAGED', 'PUBLISHING', 'PUBLISHED', 'REJECTED', 'CANCELLED'), createdAt: time, stagedAt: nullable(time), publishedAt: nullable(time) }),
  BundleMember: obj({ bundleId: uuid, importId: uuid, position: nat, schemaRevision: pos, sourceSha256: sha, commitMode: mode }),
  ByteRange: obj({ start: nat, end: nat }),
  Work: work(['UPLOAD_EXPIRY', 'IMPORT_VALIDATE', 'IMPORT_COMMIT', 'ERROR_REPORT', 'EVENT_DELIVERY', 'BUNDLE_PUBLISH']),
  DomainEvent: event(['import.created', 'import.uploaded', 'import.validated', 'import.committed', 'import.partially_committed', 'import.cancelled', 'import_bundle.staged', 'import_bundle.published', 'import_bundle.rejected'], obj({ importId: uuid, bundleId: uuid, state: str, sourceSha256: sha, committedCount: nat }, [])),
};
schemas.CreateSchemaRevision = pick(schemas.SchemaRevision, ['externalIdField', 'additionalProperties', 'fields']);
schemas.CreateImport = pick(schemas.ImportJob, ['tenantId', 'datasetKey', 'schemaRevision', 'commitMode', 'expectedBytes', 'expectedSha256']);
schemas.ImportRead = obj({ ...schemas.ImportJob.properties, receivedRanges: list(ref('ByteRange')), missingRanges: list(ref('ByteRange')) });
const collections = Object.fromEntries(Object.entries({ tenants: 'Tenant', schemas: 'Schema', schemaRevisions: 'SchemaRevision', imports: 'ImportJob', uploadChunks: 'UploadChunk', validationFindings: 'ValidationFinding', committedRecords: 'CommittedRecord', errorReports: 'ErrorReport', importBundles: 'ImportBundle', bundleMembers: 'BundleMember' }).map(([key, type]) => [key, list(ref(type))]));
schemas.Snapshot = snapshotShape(collections);
const revisionInput = { externalIdField: 'rowKey', additionalProperties: false, fields: [{ name: 'rowKey', type: 'string', required: true }, { name: 'title', type: 'string', required: true, maxLength: 100 }] };
const importInput = { tenantId, datasetKey: 'public-notes', schemaRevision: 1, commitMode: 'ALL_OR_NOTHING', expectedBytes: 39, expectedSha256: digest };
const seed = { schema: seedShape(collections, false), example: { schemaVersion: 1, seedVersion: 'importworks-public-v2-1', tenants: [{ tenantId, name: 'Public Library' }], schemas: [{ schemaId, tenantId, datasetKey: 'public-notes', name: 'Public Notes' }], schemaRevisions: [{ schemaId, revision: 1, ...revisionInput }], imports: [{ importId, ...importInput, state: 'UPLOADING', receivedBytes: 0, totalRows: 0, validRows: 0, invalidRows: 0, createdAt: T, completedAt: null, sequence: 0 }], uploadChunks: [], validationFindings: [], committedRecords: [], errorReports: [], importBundles: [], bundleMembers: [] } };
const operations = [
  op('createTenant', 'POST', '/api/v1/tenants', obj({ name }), ref('Tenant'), { body: { name: 'New Public Tenant' }, headers: keyed('import-example-tenant') }),
  op('createSchema', 'POST', '/api/v1/schemas', obj({ tenantId: uuid, datasetKey: name, name }), ref('Schema'), { body: { tenantId, datasetKey: 'new-notes', name: 'New Notes' }, headers: keyed('import-example-schema') }),
  op('createSchemaRevision', 'POST', '/api/v1/schemas/:schemaId/revisions', ref('CreateSchemaRevision'), ref('SchemaRevision'), { params: { schemaId }, body: revisionInput, headers: keyed('import-example-schema-revision') }),
  op('createImport', 'POST', '/api/v1/imports', ref('CreateImport'), ref('ImportJob'), { body: importInput, headers: keyed('import-example-import') }, source('Upload and resume')),
  op('getImport', 'GET', '/api/v1/imports/:importId', null, ref('ImportRead'), { params: { importId } }, source('Upload and resume')),
  op('putChunk', 'PUT', '/api/v1/imports/:importId/chunks/:chunkNumber', { type: 'string', contentMediaType: 'application/octet-stream', minLength: 1 }, ref('UploadChunk'), { params: { importId, chunkNumber: 0 }, body: bytes, headers: { ...keyed('import-example-chunk'), 'Content-Type': 'application/octet-stream', 'Content-Range': 'bytes 0-38/39', 'X-Chunk-SHA256': digest } }, source('Upload and resume'), [parameter('Content-Range', { type: 'string', pattern: '^bytes [0-9]+-[0-9]+/[0-9]+$' }, 'header', true), parameter('X-Chunk-SHA256', sha, 'header', true)]),
  ...['complete', 'commit', 'cancel'].map(action => op(`${action}Import`, 'POST', `/api/v1/imports/:importId/${action}`, empty, ref('ImportJob'), { params: { importId }, body: {}, headers: keyed(`import-example-${action}`) }, source('Upload and resume / Validation, commit, and reports'))),
  op('getFindings', 'GET', '/api/v1/imports/:importId/findings', null, page(ref('ValidationFinding')), { params: { importId }, query: { limit: 20 } }, source('HTTP contract'), pagination),
  op('getErrorReport', 'GET', '/api/v1/imports/:importId/error-report', null, ref('ErrorReport'), { params: { importId } }, source('Exact public shapes / HTTP contract')),
  op('downloadErrorReport', 'GET', '/api/v1/imports/:importId/error-report/content', null, { type: 'string', contentMediaType: 'application/x-ndjson' }, { params: { importId } }),
  op('listRecords', 'GET', '/api/v1/records', null, page(ref('CommittedRecord')), { query: { tenantId, datasetKey: 'public-notes', limit: 20 } }, source('HTTP contract'), [parameter('tenantId', uuid, 'query', true), parameter('datasetKey', name, 'query', true), ...pagination]),
  op('createBundle', 'POST', '/api/v1/import-bundles', obj({ tenantId: uuid, name }), ref('ImportBundle'), { body: { tenantId, name: 'Public Bundle' }, headers: keyed('import-example-bundle') }, manager),
  op('addBundleMember', 'POST', '/api/v1/import-bundles/:bundleId/members', obj({ importId: uuid }), ref('BundleMember'), { params: { bundleId }, body: { importId }, headers: keyed('import-example-member') }, manager),
  ...['stage', 'publish'].map(action => op(`${action}Bundle`, 'POST', `/api/v1/import-bundles/:bundleId/${action}`, empty, ref('ImportBundle'), { params: { bundleId }, body: {}, headers: keyed(`import-example-bundle-${action}`) }, manager)),
  ...standardOps(),
];
export default {
  taskId: 'importworks', title: 'ImportWorks', environmentVariables: [...environmentVariables, 'MANAGED_DATA_ROOT'], commands, seed, schemas, operations,
  smoke: [
    { operationId: 'snapshot', headers: admin, expectContains: [{ path: ['resources', 'schemas'], match: { schemaId, tenantId, datasetKey: 'public-notes' } }, { path: ['resources', 'schemaRevisions'], match: { schemaId, revision: 1, externalIdField: 'rowKey' } }, { path: ['resources', 'imports'], match: { importId, state: 'UPLOADING', receivedBytes: 0 } }] },
    { operationId: 'getImport', params: { importId }, expectBody: { importId, state: 'UPLOADING', receivedRanges: [], missingRanges: [{ start: 0, end: 38 }] } },
    { operationId: 'createImport', body: importInput, headers: keyed('import-smoke-create'), capture: { newImportId: ['importId'] }, expectBody: { tenantId, datasetKey: 'public-notes', state: 'UPLOADING', expectedSha256: digest } },
    { operationId: 'putChunk', params: { importId: '${newImportId}', chunkNumber: 0 }, body: bytes, headers: { ...keyed('import-smoke-chunk'), 'Content-Type': 'application/octet-stream', 'Content-Range': 'bytes 0-38/39', 'X-Chunk-SHA256': digest }, expectBody: { importId: '${newImportId}', chunkNumber: 0, start: 0, end: 38, size: 39, sha256: digest } },
    { operationId: 'getImport', params: { importId: '${newImportId}' }, expectBody: { importId: '${newImportId}', receivedBytes: 39, receivedRanges: [{ start: 0, end: 38 }], missingRanges: [] } },
  ],
  notes: [...sharedNotes,
    'V2 public wire clarification: Schema is {schemaId,tenantId,datasetKey,name}; one Schema exists per (tenantId,datasetKey). SchemaRevision is the declared immutable closed object; server assigns revisions starting at 1. Field names are unique; externalIdField names a required string field. additionalProperties is always false, preserving the original rule that unknown row fields produce findings. Type-specific bounds apply only to the matching type; minimum<=maximum. No arbitrary JSON Schema extensions or executable validators are accepted.',
    'V2 public wire clarification: fields has at least the external identity field. Missing optional maxLength/minimum/maximum means no such constraint. These are public schema-language additions, not requirements silently inferred from private seeds. Import creation resolves schema by tenantId+datasetKey+schemaRevision, not current revision.',
    'V2 public wire clarification: chunkNumber starts at 0; byte ranges are inclusive. Import GET returns exact ImportJob fields plus receivedRanges and missingRanges as ascending coalesced {start,end} intervals. All mutation responses retain the exact primary resource at top level. Initial ImportJob sequence is 0; accepted state transitions increment it.',
    'V2 public wire clarification: GET error-report returns only ErrorReport metadata. Added GET /api/v1/imports/:importId/error-report/content serves a READY report as UTF-8 application/x-ndjson: each sorted ValidationFinding is RFC 8785 canonical JSON followed by LF; sha256 hashes precisely those bytes, empty report hashes the empty byte string. Non-READY content returns IMPORT_NOT_VALIDATED. This explicit extra route makes the original download requirement usable without leaking rejected values.',
    'V2 public wire clarification: seed keeps the original absence of importedAt and adds importBundles/bundleMembers arrays. The public example contains a tenant, populated schema revision, and byte-free UPLOADING job. Bundle members use zero-based insertion positions, contiguous within the bundle. Snapshot collection identities are schemaId+revision, importId+chunkNumber and bundleId+position for composite rows, otherwise the named ID.',
    'The smoke performs a real independent upload and resume read but deliberately does not claim validation, atomic commit, recovery or performance acceptance. All 15 original routes, all 4 Manager routes, and the explicit report-content clarification route are declared.',
  ],
};
