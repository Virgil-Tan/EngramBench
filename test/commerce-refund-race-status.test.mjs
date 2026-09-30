import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRefundRaceResponses } from '../evaluators/transfer/commercecommand/v2/cases/b.mjs';
const ok = { status: 201, json: { refundId: 'refund' } };
const rejected = (status, code) => ({ status, json: { error: { code, message: 'restock exceeds remaining quantity', details: {} } } });
const batch = response => [ok, ...Array.from({length:11},()=>response)];
test('refund race accepts only documented conflict or validation rejection and one success',()=>{
  assert.doesNotThrow(()=>assertRefundRaceResponses(batch(rejected(400,'VALIDATION_ERROR'))));
  assert.doesNotThrow(()=>assertRefundRaceResponses(batch(rejected(409,'REFUND_EXCEEDS_CAPTURE'))));
  for(const bad of [rejected(400,'UNAUTHORIZED'),rejected(500,'VALIDATION_ERROR'),{status:400,json:{}},rejected(409,'UNAUTHORIZED')])
    assert.throws(()=>assertRefundRaceResponses(batch(bad)));
  assert.throws(()=>assertRefundRaceResponses(Array(12).fill(ok)));
  assert.throws(()=>assertRefundRaceResponses(Array(12).fill(rejected(400,'VALIDATION_ERROR'))));
});
