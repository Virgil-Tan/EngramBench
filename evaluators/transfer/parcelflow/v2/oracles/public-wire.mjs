import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Production has only /evaluator, /shared-v2 and the immutable author /public-contract.
// The local fallback is used by repository-only tests, never to inspect submissions.
export async function loadPublicWire(root = process.env.FRONTAL_PUBLIC_CONTRACT_ROOT) {
  const contract = root
    ? JSON.parse(await readFile(resolve(root, 'contract.json'), 'utf8'))
    : (await import('../../../../../contracts/transfer/parcelflow.mjs')).default;
  const runtime = await import(root
    ? pathToFileURL(resolve(root, 'runtime.mjs')).href
    : new URL('../../../../../templates/contract-first/runtime.mjs', import.meta.url).href);
  const expected = runtime.openApi(contract);
  const validEvent = runtime.validator(contract)(contract.schemas.DomainEvent);
  return {
    assertOpenApiSource(source) {
      const actual = JSON.parse(source);
      assert.match(actual.openapi, /^3\.1\./u, 'OpenAPI 3.1 is required');
      assert.deepEqual(actual.components?.schemas, expected.components.schemas, 'author public schemas are synchronized');
      for (const [path, methods] of Object.entries(expected.paths)) {
        for (const [method, operation] of Object.entries(methods)) {
          const found = actual.paths?.[path]?.[method];
          assert.ok(found, `${method} ${path} is declared`);
          for (const field of ['parameters', 'requestBody', 'responses']) assert.deepEqual(found[field], operation[field], `${method} ${path} ${field} matches the author contract`);
        }
      }
      assert.deepEqual(actual.webhooks, expected.webhooks, 'outbound webhook schemas and headers are synchronized');
      return actual;
    },
    assertPublicEvent(event) {
      assert.ok(validEvent(event), `Event violates the public wire schema: ${JSON.stringify(validEvent.errors)}`);
      return event;
    },
  };
}

export const { assertOpenApiSource, assertPublicEvent } = await loadPublicWire();
