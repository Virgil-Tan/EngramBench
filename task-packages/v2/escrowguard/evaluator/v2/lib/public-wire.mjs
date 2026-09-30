import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.FRONTAL_PUBLIC_CONTRACT_ROOT;
const mounted = root ? {
  contract: JSON.parse(readFileSync(join(root, 'contract.json'), 'utf8')),
  runtime: await import(pathToFileURL(join(root, 'runtime.mjs')).href),
} : undefined;

// Production uses the immutable author mount; tests may explicitly inject that same pair.
// This compares public transport, never adapts a submission's requests or responses.
export function assertPublishedOpenApi(document, author = mounted) {
  if (!author) return false;
  const expected = author.runtime.openApi(author.contract);
  assert.equal(document.openapi, expected.openapi, 'published OpenAPI dialect');
  for (const [path, methods] of Object.entries(expected.paths)) {
    for (const [method, operation] of Object.entries(methods)) assert.deepEqual(document.paths?.[path]?.[method], operation, `published ${method.toUpperCase()} ${path}`);
  }
  for (const [name, schema] of Object.entries(expected.components.schemas)) assert.deepEqual(document.components?.schemas?.[name], schema, `published schema ${name}`);
  return true;
}

