import assert from 'node:assert/strict';
import { validator, requestPath, expand, requestValidator } from '../templates/contract-first/runtime.mjs';
import { prepareProbe } from '../templates/contract-first/check.mjs';

export function validatePublicContract(contract) {
  assert.match(contract.taskId, /^[a-z][a-z0-9]+$/);
  assert(contract.title && contract.commands.length && contract.notes.length, 'Missing public documentation');
  const compile = validator(contract), seed = compile(contract.seed.schema);
  assert(seed(contract.seed.example), `${contract.taskId}: invalid seed: ${JSON.stringify(seed.errors)}`);
  assert(Object.values(contract.seed.example).some(value => Array.isArray(value) && value.length), `${contract.taskId}: seed must be nonempty`);
  for (const schema of Object.values(contract.schemas)) compile(schema);
  const contentSchemas = container => {
    for (const media of Object.values(container?.content ?? {})) {
      assert(Object.hasOwn(media, 'schema'), 'Webhook media type requires a public schema');
      compile(media.schema);
    }
  };
  for (const [name, item] of Object.entries(contract.webhooks ?? {})) {
    const methods = Object.entries(item).filter(([method]) => ['get', 'head', 'post', 'put', 'patch', 'delete', 'options', 'trace'].includes(method));
    assert(methods.length, `Webhook must publish an inline operation: ${name}`);
    for (const [, operation] of methods) {
      for (const parameter of [...(item.parameters ?? []), ...(operation.parameters ?? [])]) {
        assert(parameter.name && parameter.in && Object.hasOwn(parameter, 'schema'), `Webhook parameter requires a name, location and schema: ${name}`);
        compile(parameter.schema);
      }
      contentSchemas(operation.requestBody);
      assert(Object.keys(operation.responses ?? {}).length, `Webhook responses missing: ${name}`);
      for (const response of Object.values(operation.responses)) {
        contentSchemas(response);
        for (const header of Object.values(response.headers ?? {})) {
          assert(Object.hasOwn(header, 'schema'), `Webhook response header requires a public schema: ${name}`);
          compile(header.schema);
        }
      }
    }
  }
  const ids = new Set(), routes = new Set();
  for (const operation of contract.operations) {
    assert(operation.id && !ids.has(operation.id), 'Duplicate/missing operation ID'); ids.add(operation.id);
    const key = `${operation.method} ${operation.path}`;
    assert(!routes.has(key), `Duplicate route: ${key}`); routes.add(key);
    assert.match(operation.path, /^\//); assert(operation.source, `Missing source: ${key}`);
    assert(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(operation.method), key);
    assert(operation.response, `Unspecified success shape: ${key}`);
    compile(operation.response);
    for (const value of Object.values(operation.successResponses ?? {})) if (value.response) compile(value.response);
    for (const parameter of operation.parameters ?? []) compile(parameter.schema);
    for (const rule of operation.bodyTransportErrors ?? []) {
      assert(typeof rule.path === 'string' && rule.path.startsWith('/'), 'bodyTransportErrors requires a JSON Pointer field path');
      assert([undefined, 'number', 'unsafe_integer'].includes(rule.when), 'Unsupported bodyTransportErrors condition');
      assert(Number.isInteger(rule.status) && rule.status >= 400 && rule.status <= 499 && typeof rule.code === 'string' && rule.code.length, 'Invalid bodyTransportErrors error');
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(operation.method)) assert(operation.request || operation.requestBody === 'none', `Unspecified request: ${key}`);
    if (operation.request) {
      const valid = compile(operation.request);
      assert(operation.example, `Missing wire example: ${key}`);
      const body = expand(operation.example.body, { ADMIN_TOKEN: 'public-example-only' });
      assert(valid(body), `${key}: invalid wire example: ${JSON.stringify(valid.errors)}`);
    }
    if (operation.example) requestPath(operation, operation.example);
  }
  assert(contract.smoke.length >= 3, 'Public live checks required');
  assert(contract.smoke.some(item => item.expectContains?.length), 'Need nonempty snapshot/read identity assertion');
  for (const probe of contract.smoke) assert(ids.has(probe.operationId), `Unknown probe: ${probe.operationId}`);
  validateWireExamples(contract);
  return { operations: ids.size, probes: contract.smoke.length, schemas: Object.keys(contract.schemas).length };
}

export function validateWireExamples(contract) {
  const check = requestValidator(contract);
  const checkRawBody = example => {
    if (!Object.hasOwn(example, 'rawBody')) return;
    assert.equal(typeof example.rawBody, 'string', 'rawBody must be a string');
    assert(!Object.hasOwn(example, 'body'), 'rawBody and body are mutually exclusive');
  };
  const variables = Object.fromEntries(contract.environmentVariables.map(name => [name, name.endsWith('URL') ? 'http://127.0.0.1:9999/public-fixture' : 'public-fixture-token']));
  variables.ADMIN_TOKEN = 'public-example-token';
  const run = (operation, example) => {
    checkRawBody(example);
    const item = prepareProbe(example, variables), url = new URL(requestPath(operation, item), 'http://localhost');
    const headers = { ...(item.headers ?? {}) };
    let body = item.body;
    if (item.rawBody !== undefined) {
      if (operation.request?.contentMediaType === 'application/octet-stream') body = item.rawBody;
      else assert.doesNotThrow(() => { body = JSON.parse(item.rawBody); }, `${contract.taskId}/${operation.id}: positive rawBody must be valid JSON`);
    }
    if (body !== undefined && !Object.keys(headers).some(key => key.toLowerCase() === 'content-type')) headers['content-type'] = operation.request?.contentMediaType ?? 'application/json';
    const checked = check(operation, { params: { ...item.params }, query: Object.fromEntries(url.searchParams), headers, body, hasBody: body !== undefined });
    assert(checked.valid, `${contract.taskId}/${operation.id} example: ${checked.message}: ${JSON.stringify(checked.violations)}`);
  };
  for (const operation of contract.operations) if (operation.example) run(operation, operation.example);
  const dereference = schema => {
    const seen = new Set();
    while (schema?.$ref?.startsWith('#/$defs/')) {
      assert(!seen.has(schema.$ref), `Circular capture schema: ${schema.$ref}`);
      seen.add(schema.$ref);
      schema = contract.schemas[schema.$ref.slice('#/$defs/'.length)];
    }
    return schema;
  };
  const captureSchemas = (input, path) => {
    const schema = dereference(input);
    if (!schema) return [];
    if (!path.length) return [schema];
    const child = schema.type === 'array' ? schema.items : schema.properties?.[path[0]];
    if (child) return captureSchemas(child, path.slice(1));
    const alternatives = schema.anyOf ?? schema.oneOf;
    if (alternatives) {
      const results = alternatives.filter(item => dereference(item)?.type !== 'null').map(item => captureSchemas(item, path));
      return results.length && results.every(item => item.length) ? results.flat() : [];
    }
    return (schema.allOf ?? []).flatMap(item => captureSchemas(item, path));
  };
  for (const probe of contract.smoke) {
    checkRawBody(probe);
    prepareProbe(probe, variables); // Negative probes must not hide invalid author signing metadata.
    const operation = contract.operations.find(op => op.id === probe.operationId);
    if ((probe.expectStatus ?? operation.status ?? 200) < 400) run(operation, probe);
    for (const [name, path] of Object.entries(probe.capture ?? {})) {
      const response = operation.successResponses?.[probe.expectStatus]?.response ?? operation.response;
      let [schema] = captureSchemas(response, path);
      assert(schema, `${contract.taskId}/${operation.id}: capture path missing from response schema: ${path.join('.')}`);
      schema = dereference((schema.anyOf ?? schema.oneOf)?.find(candidate => dereference(candidate)?.type !== 'null') ?? schema);
      variables[name] = schema.const ?? schema.enum?.[0] ?? (schema.type === 'integer' || schema.type === 'number' ? Math.max(1, schema.minimum ?? 0) : schema.format === 'uuid' ? '00000000-0000-4000-8000-000000000001' : schema.format === 'date-time' ? '2099-01-01T00:00:00.000Z' : 'public-captured-value');
    }
  }
}
