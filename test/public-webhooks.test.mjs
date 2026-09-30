import test from 'node:test';
import assert from 'node:assert/strict';
import parcel from '../contracts/transfer/parcelflow.mjs';
import { validatePublicContract } from '../src/public-contract.mjs';

test('public webhook schemas and references are checked before publishing', () => {
  assert.doesNotThrow(() => validatePublicContract(parcel));
  for (const corrupt of [
    hook => { hook.requestBody.content['application/json'].schema = { type: 'not-a-type' }; },
    hook => { hook.requestBody.content['application/json'].schema = { $ref: '#/$defs/NotPublished' }; },
    hook => { hook.parameters[0].schema = { type: 'not-a-type' }; },
    hook => { hook.responses['2XX'].content = { 'application/json': { schema: { type: 'not-a-type' } } }; },
    hook => { hook.responses['2XX'].headers = { Receipt: { schema: { $ref: '#/$defs/NotPublished' } } }; },
    hook => { delete hook.responses; },
  ]) {
    const changed = structuredClone(parcel);
    corrupt(changed.webhooks.orderEvent.post);
    assert.throws(() => validatePublicContract(changed));
  }
});
