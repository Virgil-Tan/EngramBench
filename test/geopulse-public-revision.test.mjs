import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import sourceContract from '../contracts/learning/geopulse.mjs';
import { requestValidator as frozenValidator } from '../reports/learning30-v2-hidden-20260907/frozen-packages/geopulse/public-contract/runtime.mjs';
import { requestValidator as revisedValidator } from '../templates/contract-first/runtime.mjs';

const frozenContract = JSON.parse(await readFile(new URL('../reports/learning30-v2-hidden-20260907/frozen-packages/geopulse/public-contract/contract.json', import.meta.url)));
const generatedContract = JSON.parse(await readFile(new URL('../task-packages/v2/geopulse/public-contract/contract.json', import.meta.url)));
const oldCheck = frozenValidator(frozenContract);
const revisions = [
  ['frozen published schema', frozenContract],
  ['current author schema', sourceContract],
  ['generated public schema', generatedContract],
].map(([name, contract]) => ({ name, contract, check: revisedValidator(contract) }));
const operationIds = ['ingestEvent', 'ingestBatch', 'queryRegions', 'createRegionVersion'];

// Derive every request from public examples; no evaluator or submission fixtures.
function coordinateRequest(contract, id, coordinate, value) {
  const operation = contract.operations.find(operation => operation.id === id);
  const request = structuredClone(operation.example), body = request.body;
  let path;
  if (body.polygon) {
    const anchor = value === 0 ? 1 : 0;
    body.polygon = coordinate === 'longitude'
      ? [[value, 10], [anchor, 10], [anchor, 11], [value, 11], [value, 10]]
      : [[10, value], [11, value], [11, anchor], [10, anchor], [10, value]];
    path = `/polygon/0/${coordinate === 'longitude' ? 0 : 1}`;
  } else {
    (body.events?.[0] ?? body.points?.[0] ?? body)[coordinate] = value;
    path = `${body.events ? '/events/0' : body.points ? '/points/0' : ''}/${coordinate}`;
  }
  request.headers['content-type'] = 'application/json';
  request.hasBody = true;
  return { operation, request, path };
}

test('GeoPulse frozen public request validator reproduces valid decimal rejection in all coordinate routes', () => {
  for (const id of operationIds) for (const coordinate of ['longitude', 'latitude']) for (const value of [-9.89, -9.8]) {
    const { operation, request, path } = coordinateRequest(frozenContract, id, coordinate, value);
    const result = oldCheck(operation, request);
    assert.equal(result.valid, false, `${id} ${coordinate}=${value}`);
    assert(result.violations.some(error => error.instancePath === path && error.keyword === 'multipleOf'));
    assert(result.violations.every(error => error.keyword === 'multipleOf'), JSON.stringify(result));
  }
});

test('GeoPulse revised runtime accepts valid microdegrees through unchanged published request schemas', () => {
  for (const { contract } of revisions) for (const schema of ['IngestEvent', 'PointQuery', 'CreateRegionVersion'])
    assert.deepEqual(contract.schemas[schema], frozenContract.schemas[schema]);
  for (const { name, contract, check } of revisions) for (const id of operationIds) {
    assert.deepEqual(contract.operations.find(operation => operation.id === id).request, frozenContract.operations.find(operation => operation.id === id).request);
    for (const coordinate of ['longitude', 'latitude']) {
      const limit = coordinate === 'longitude' ? 180 : 90;
      for (const value of [-limit, -limit + 0.000001, -9.89, -9.8, -0.000001, 0, 0.000001, 9.89, limit - 0.000001, limit]) {
        const { operation, request } = coordinateRequest(contract, id, coordinate, value);
        const result = check(operation, request);
        assert.equal(result.valid, true, `${name} ${id} ${coordinate}=${value}: ${JSON.stringify(result.violations)}`);
      }
    }
  }
});

test('GeoPulse revised public request validation rejects excess precision and coordinate overflow', () => {
  for (const { name, contract, check } of revisions) for (const id of operationIds) for (const coordinate of ['longitude', 'latitude']) {
    const limit = coordinate === 'longitude' ? 180 : 90;
    const invalid = [
      ...[-9.8900001, -9.890000000000002, 0.0000001, 0.30000000000000004].map(value => [value, 'multipleOf']),
      [-limit - 0.000001, 'minimum'], [limit + 0.000001, 'maximum'],
    ];
    for (const [value, keyword] of invalid) {
      const { operation, request, path } = coordinateRequest(contract, id, coordinate, value);
      const result = check(operation, request);
      assert.equal(result.valid, false, `${name} ${id} ${coordinate}=${value}`);
      assert(result.violations.some(error => error.instancePath === path && error.keyword === keyword), JSON.stringify(result));
    }
  }
});
