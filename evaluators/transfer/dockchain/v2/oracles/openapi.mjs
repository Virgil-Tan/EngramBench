import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Isolated evaluations consume the author copy; local tests use the same source.
// Submission-owned OpenAPI never defines the expected business response.
const authorRoot = process.env.FRONTAL_PUBLIC_CONTRACT_ROOT;
export const contract = authorRoot
  ? JSON.parse(readFileSync(join(authorRoot, 'contract.json'), 'utf8'))
  : (await import('../../../../../contracts/transfer/dockchain.mjs')).default;
const { openApi, validator } = await import(authorRoot
  ? pathToFileURL(join(authorRoot, 'runtime.mjs')).href
  : new URL('../../../../../templates/contract-first/runtime.mjs', import.meta.url).href);
const expected = openApi(contract), compile = validator(contract);
export const REQUIRED_PATHS = Object.freeze(Object.keys(expected.paths).filter(path => path.startsWith('/api/')));

function resolve(document, value) {
  if (!value?.$ref) return value;
  assert.match(value.$ref, /^#\//, 'OpenAPI references must be local');
  return value.$ref.slice(2).split('/').reduce((current, part) => current?.[part.replaceAll('~1', '/').replaceAll('~0', '~')], document);
}

function shape(document, value, seen = new Set()) {
  if (Array.isArray(value)) return value.map(item => shape(document, item, seen));
  if (!value || typeof value !== 'object') return value;
  if (value.$ref) {
    if (seen.has(value.$ref)) return { recursive: true };
    const target = resolve(document, value);
    assert(target, `Unresolved schema ${value.$ref}`);
    return shape(document, target, new Set([...seen, value.$ref]));
  }
  const annotations = new Set(['description', 'title', '$comment', '$schema', 'examples', 'example', 'contentMediaType']);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !annotations.has(key)).map(([key, item]) => [key,
    key === 'required' || key === 'enum' ? [...item].sort() : shape(document, item, seen),
  ]));
}

export function assertPublishedOpenApi(document, { includeManager = true } = {}) {
  assert.match(document?.openapi ?? '', /^3\.1(?:\.|$)/, 'OpenAPI 3.1');
  for (const operation of contract.operations) {
    if (!includeManager && operation.source.includes('manager-requirements')) continue;
    const path = operation.path.replace(/\/:([^/]+)/g, '/{$1}');
    const baseline = expected.paths[path][operation.method.toLowerCase()];
    const actual = document.paths?.[path]?.[operation.method.toLowerCase()];
    assert(actual, `${operation.method} ${path} is published`);
    for (const parameter of baseline.parameters) {
      const live = [...(document.paths[path].parameters ?? []), ...(actual.parameters ?? [])].map(item => resolve(document, item)).find(item => item?.name.toLowerCase() === parameter.name.toLowerCase() && item.in === parameter.in);
      assert(live, `${path} parameter ${parameter.name}`);
      assert.equal(live.required ?? false, parameter.required ?? false, `${path} ${parameter.name} required`);
      assert.deepEqual(shape(document, live.schema), shape(expected, parameter.schema), `${path} ${parameter.name} schema`);
    }
    if(baseline["x-body-transport-errors"])assert.deepEqual(actual["x-body-transport-errors"],baseline["x-body-transport-errors"],path+" body transport errors");
    if (baseline.requestBody) {
      const body = resolve(document, actual.requestBody);
      assert.equal(body?.required, true, `${path} request body required`);
      for (const [media, entry] of Object.entries(baseline.requestBody.content)) {
        assert.deepEqual(shape(document, body.content?.[media]?.schema), shape(expected, entry.schema), `${path} request schema`);
      }
    }
    for (const status of [...(operation.successStatuses ?? [operation.status]), ...Object.keys(operation.errors ?? {}).map(Number)]) {
      const response = resolve(document, actual.responses?.[status]);
      assert(response, `${path} success status ${status}`);
      for (const [media, entry] of Object.entries(baseline.responses[status].content ?? {})) {
        assert.deepEqual(shape(document, response.content?.[media]?.schema), shape(expected, entry.schema), `${path} response schema`);
      }
    }
  }
  return true;
}

export function assertLiveSchema(_document, path, method, status, body) {
  const operation = contract.operations.find(item => item.method === method.toUpperCase() && item.path.replace(/\/:([^/]+)/g, '/{$1}') === path);
  assert(operation, `${method} ${path} is author-published`);
  assert(status >= 400 || (operation.successStatuses ?? [operation.status]).includes(status), `${path} published success status`);
  if ([204, 304].includes(status) || method.toUpperCase() === 'HEAD') return true;
  const schema = status >= 400 ? operation.errors?.[status] ?? contract.schemas.Error : operation.successResponses?.[status]?.response ?? operation.response;
  const valid = compile(schema);
  assert(valid(body), `${method} ${path} ${status} violates author schema: ${JSON.stringify(valid.errors)}`);
  return true;
}

export function assertSnapshotSchema(snapshot) {
  const valid = compile(contract.schemas.VerificationSnapshot);
  assert(valid(snapshot), `Snapshot violates author schema: ${JSON.stringify(valid.errors)}`);
}
