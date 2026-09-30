import test from 'node:test';
import assert from 'node:assert/strict';
import contract from '../contracts/transfer/creatorrightsexchange.mjs';
import { validator } from '../templates/contract-first/runtime.mjs';
import { createFixtureFactory } from '../evaluators/transfer/creatorrightsexchange/v2/fixtures/index.mjs';
import { canonicalJson, sha256, chunkOracle, renditionOracle, editionManifestDigest } from '../evaluators/transfer/creatorrightsexchange/v2/oracles/index.mjs';

const factory = createFixtureFactory({ evaluationSeed: 'creator-lineage-regression', caseId: 'A-02', baseTime: '2032-04-05T06:07:08.000Z' });
const validateSeed = validator(contract)(contract.seed.schema);

test('Creator bootstrap profiles do not depend on an unspecified cross-profile revision allocator', () => {
  const families = ['upload', 'pipeline', 'work', 'edition', 'purchase', 'review', 'refund', 'royalty', 'notification', 'dispute', 'idempotency', 'migration', 'browser'];
  for (const seed of [contract.seed.example, ...families.map(name => factory[name]().seed), factory.commercialSeed(3).seed, factory.notificationSeed(3).seed]) {
    assert(validateSeed(seed), JSON.stringify(validateSeed.errors));
    assert(seed.transcodeProfiles.length >= 2, 'exercise multiple immutable profiles');
    const keys = seed.transcodeProfiles.map(profile => `${profile.tenantId}:${profile.revision}`);
    assert.equal(new Set(keys).size, keys.length, 'ordinary seed works with tenant-wide revision allocation too');
    for (const row of [...seed.transcodeJobs, ...seed.renditions]) {
      assert(seed.transcodeProfiles.some(profile => profile.profileId === row.profileId && profile.revision === row.profileRevision), 'frozen references retain the exact imported revision');
    }
  }
  const snapshot = contract.smoke.find(probe => probe.operationId === 'verificationSnapshot');
  for (const profile of contract.seed.example.transcodeProfiles) {
    assert(snapshot.expectContains.some(probe => probe.path.join('.') === 'resources.transcodeProfiles' && probe.match.profileId === profile.profileId && probe.match.revision === profile.revision), 'public check verifies both persisted profile revisions');
  }
});

// Public README §§2–4, 11: completed media must retain its exact upload,
// chunk, scan, frozen profile and same-Work publication relationships.
function assertMediaLineage(seed) {
  assert(validateSeed(seed), JSON.stringify(validateSeed.errors));
  for (const blob of seed.blobObjects) {
    const bytes = Buffer.from(blob.contentBase64, 'base64');
    assert.equal(sha256(bytes), blob.sha256, 'Blob digest');
    assert.equal(bytes.length, blob.sizeBytes, 'Blob size');
    const uploads = seed.uploadSessions.filter(upload => upload.tenantId === blob.tenantId && upload.contentSha256 === blob.sha256 && upload.totalBytes === blob.sizeBytes);
    assert.equal(uploads.length, 1, 'one exact completed Upload lineage');
    const upload = uploads[0];
    assert.equal(upload.state, 'COMPLETED', 'Upload state');
    assert.equal(Date.parse(upload.completedAt), Date.parse(blob.createdAt), 'atomic completion time');
    assert(Date.parse(upload.createdAt) <= Date.parse(upload.completedAt));
    assert(Date.parse(upload.completedAt) < Date.parse(upload.expiresAt));
    assert(seed.works.some(work => work.workId === upload.workId && work.tenantId === upload.tenantId), 'Upload Work tenant');
    const chunks = seed.uploadChunks.filter(chunk => chunk.uploadId === upload.uploadId);
    const expected = chunkOracle(bytes, upload.chunkSize).chunks;
    assert.deepEqual(chunks.map(({ createdAt, ...chunk }) => chunk), expected.map(({ bytes, contentRange, ...chunk }) => ({ uploadId: upload.uploadId, ...chunk })), 'gapless exact chunk manifest');
    for (const chunk of chunks) assert(Date.parse(chunk.createdAt) >= Date.parse(upload.createdAt) && Date.parse(chunk.createdAt) <= Date.parse(upload.completedAt), 'chunk precedes completion');
    assert.equal(blob.state, 'READY');
    const scan = seed.scanJobs.find(job => job.assetId === blob.blobId);
    assert.equal(scan?.state, 'CLEAN', 'READY Blob has CLEAN scan');
    assert(seed.scanResults.some(result => result.scanJobId === scan.scanJobId && result.assetId === blob.blobId && result.verdict === 'CLEAN' && result.contentSha256 === blob.sha256), 'CLEAN result binds Blob digest');
    for (const profileId of upload.requiredProfileIds) {
      const job = seed.transcodeJobs.find(job => job.assetId === blob.blobId && job.profileId === profileId);
      assert.equal(job?.state, 'READY', 'required profile is READY');
      const profile = seed.transcodeProfiles.find(profile => profile.profileId === profileId && profile.revision === job.profileRevision && profile.tenantId === upload.tenantId);
      assert(profile, 'frozen same-tenant profile revision');
      const rendition = seed.renditions.find(row => row.assetId === blob.blobId && row.profileId === profileId && row.profileRevision === job.profileRevision);
      assert.equal(rendition?.state, 'READY');
      const expectedRendition = renditionOracle(bytes, profile);
      assert.equal(rendition.sha256, expectedRendition.sha256, 'rendition digest');
      assert.equal(rendition.sizeBytes, expectedRendition.sizeBytes, 'rendition size');
      assert.deepEqual(Buffer.from(rendition.contentBase64, 'base64'), expectedRendition.bytes);
    }
    for (const asset of seed.editionAssets.filter(asset => asset.assetId === blob.blobId)) {
      const edition = seed.editions.find(edition => edition.editionId === asset.editionId);
      assert.equal(edition?.workId, upload.workId, 'Edition same Work upload lineage');
      assert.equal(edition.tenantId, upload.tenantId, 'Edition same tenant');
      const rendition = seed.renditions.find(row => row.renditionId === asset.renditionId && row.assetId === blob.blobId);
      assert(rendition, 'Edition rendition belongs to asset');
      assert.equal(asset.assetSha256, blob.sha256);
      assert.equal(asset.renditionSha256, rendition.sha256);
    }
  }
}

test('Creator Edition and every derived positive seed retain the complete media lineage', () => {
  const families = ['edition', 'purchase', 'review', 'refund', 'royalty', 'notification', 'dispute', 'idempotency', 'migration', 'browser'];
  for (const family of [...families.map(name => factory[name]()), factory.royalty({ closed: false }), factory.commercialSeed(3), factory.commercialSeed(3, { withRoyalty: false }), factory.notificationSeed(3)]) {
    assertMediaLineage(family.seed);
    assert.deepEqual(family.uploadSession, family.seed.uploadSessions[0], 'returned Upload matches seeded completion');
    assert.equal(family.uploadId, family.seed.uploadSessions[0].uploadId);
  }
  const draft = factory.edition('b02');
  assertMediaLineage({ ...draft.seed, editions: [], editionAssets: [] });
  assert.deepEqual(factory.edition('repeat'), factory.edition('repeat'), 'same fixture is deterministic');
  for (const name of ['upload', 'pipeline', 'work']) {
    const family = factory[name]();
    assert.equal(family.uploadSession.state, 'OPEN');
    assert.equal(family.seed.uploadSessions.length, 0, 'live uploads are created by the API');
    assert.equal(family.seed.uploadChunks.length, 0);
  }
});

test('Creator lineage regression rejects missing or mismatched upload, chunk and frozen media references', () => {
  const seed = factory.edition('negative').seed;
  assertMediaLineage(seed);
  const mutations = [
    ['missing Upload', value => { value.uploadSessions = []; }],
    ['wrong state', value => { value.uploadSessions[0].state = 'OPEN'; }],
    ['missing completion', value => { value.uploadSessions[0].completedAt = null; }],
    ['wrong tenant', value => { value.uploadSessions[0].tenantId = value.tenants[1].tenantId; }],
    ['wrong Work', value => { value.uploadSessions[0].workId = factory.uuid('other-work'); }],
    ['wrong digest', value => { value.uploadSessions[0].contentSha256 = '0'.repeat(64); }],
    ['wrong size', value => { value.uploadSessions[0].totalBytes += 1; }],
    ['missing chunk', value => { value.uploadChunks.pop(); }],
    ['wrong chunk range', value => { value.uploadChunks[0].endByte -= 1; }],
    ['wrong chunk digest', value => { value.uploadChunks[0].sha256 = '0'.repeat(64); }],
    ['missing required rendition', value => { value.renditions = []; }],
    ['wrong frozen profile', value => { value.transcodeJobs[0].profileRevision += 1; }],
    ['wrong scan digest', value => { value.scanResults[0].contentSha256 = '0'.repeat(64); }],
    ['wrong Edition Work', value => { value.editions[0].workId = factory.uuid('other-work'); }],
    ['wrong Edition rendition', value => { value.editionAssets[0].renditionId = factory.uuid('other-rendition'); }],
  ];
  for (const [name, mutate] of mutations) {
    const invalid = structuredClone(seed);
    mutate(invalid);
    assert.throws(() => assertMediaLineage(invalid), undefined, name);
  }
});

test('Creator manifest oracle hashes all public EditionAsset fields and preserves exact checks', () => {
  const { edition, editionAsset } = factory.edition('manifest');
  const manifest = { rightsRevision: edition.rightsRevision, assets: [editionAsset] };
  assert.equal(editionManifestDigest(manifest), sha256(canonicalJson(manifest)), 'public RFC8785 payload includes editionId');
  assert.equal(editionManifestDigest(manifest), edition.manifestDigest, 'seed and oracle agree');
  for (const field of Object.keys(editionAsset)) {
    const asset = { ...editionAsset, [field]: field === 'ordinal' ? 2 : field.endsWith('Sha256') ? '0'.repeat(64) : factory.uuid(`other-${field}`) };
    assert.notEqual(editionManifestDigest({ ...manifest, assets: [asset] }), edition.manifestDigest, `${field} is authenticated`);
  }
  assert.notEqual(editionManifestDigest({ ...manifest, rightsRevision: 2 }), edition.manifestDigest);
  assert.throws(() => editionManifestDigest({ ...manifest, rightsRevision: -1 }), /rights revision/);
  assert.throws(() => editionManifestDigest({ ...manifest, assets: [{ ...editionAsset, ordinal: 2 }, editionAsset] }), /edition assets sorted/);
});
