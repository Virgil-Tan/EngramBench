// Author-owned transport. Business state, authorization and persistence belong to src/.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { matchOperation, validator, openApi, errorBody, requestValidator, transportError } from './runtime.mjs';
import * as implementation from '../dist/implementation.js';

const contract = JSON.parse(await readFile(new URL('./contract.json', import.meta.url)));
for (const operation of implementation.publicExtensions ?? []) {
  if (!operation.id || !operation.path?.startsWith('/') || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(operation.method)) throw new Error('Invalid public extension');
  if (contract.operations.some(op => op.id === operation.id || (op.method === operation.method && op.path === operation.path))) throw new Error('Cannot replace an author-owned operation');
  contract.operations.push(operation);
}
const api = openApi(contract), compile = validator(contract), checkRequest = requestValidator(contract);
const responses = new Map(contract.operations.filter(op => op.response).map(op => [op.id, compile(op.response)]));
const server = createServer(async (request, response) => {
  const send = (status, body, headers = {}, contentType = 'application/json') => {
    response.writeHead(status, { ...Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'content-type')), 'content-type': contentType });
    response.end(request.method === 'HEAD' || status === 204 || status === 304 ? undefined : JSON.stringify(body));
  };
  const error = (status, code, message, details = {}, body) => send(status, errorBody(contract, code, message, details, body));
  const transportFailure = (issue, message, details = {}) => error(issue.status, issue.code, message, details, issue.body);
  try {
    const url = new URL(request.url, 'http://localhost');
    const route = matchOperation(contract.operations, request.method, url.pathname);
    if (!route) {
      const issue = transportError(contract, 'unknownRoute');
      return transportFailure(issue, 'No published route matches this request');
    }
    const { operation, params } = route;
    const query = {};
    for (const name of url.searchParams.keys()) {
      const values = url.searchParams.getAll(name);
      query[name] = values.length > 1 ? values : values[0];
    }
    let body, bytes;
    const binaryRequest = operation.request?.contentMediaType === 'application/octet-stream';
    const declaredBody = Number(request.headers['content-length'] ?? 0) > 0 || !!request.headers['transfer-encoding'];
    const preliminary = checkRequest(operation, { params, query, headers: request.headers, hasBody: declaredBody, checkBody: false });
    if (!preliminary.valid) return transportFailure(preliminary, preliminary.message, { violations: preliminary.violations });
    if (!binaryRequest) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      bytes = Buffer.concat(chunks);
      if (bytes.length) {
        try { body = JSON.parse(bytes.toString('utf8')); }
        catch {
          const issue = transportError(contract, 'invalidJson', operation);
          return transportFailure(issue, 'Body is not valid JSON');
        }
      }
    }
    const checked = checkRequest(operation, { params, query, headers: request.headers, body, hasBody: binaryRequest ? declaredBody : bytes.length > 0 });
    if (!checked.valid) return transportFailure(checked, checked.message, { violations: checked.violations });
    const headers = checked.headers;
    if (operation.path === '/openapi.json') return send(200, api);
    // Raw uploads are streamed: the scaffold must not force entire files into RAM.
    const result = await implementation.execute(operation.id, { params, query, body, bytes, stream: binaryRequest ? request : undefined, headers });
    const status = result.status ?? operation.status ?? 200;
    const success = (operation.successStatuses ?? [operation.status ?? 200]).includes(status);
    if (status < 400 && !success) return error(500, 'RESPONSE_CONTRACT_VIOLATION', 'Unexpected success status');
    const schema = operation.successResponses?.[status]?.response ?? operation.response;
    const mediaType = schema?.contentMediaType ?? (operation.path === '/' ? 'text/html' : 'application/json');
    if (success && request.method !== 'HEAD' && status !== 204 && status !== 304) {
      if (mediaType !== 'application/json') {
        response.writeHead(status, { ...result.headers, 'content-type': mediaType });
        if (result.body?.pipe || result.body?.[Symbol.asyncIterator]) await pipeline(result.body, response);
        else response.end(result.body);
        return;
      }
      const check = operation.successResponses?.[status]?.response ? compile(schema) : responses.get(operation.id);
      if (check && !check(result.body)) return error(500, 'RESPONSE_CONTRACT_VIOLATION', 'Nonconforming success body', { violations: check.errors });
    } else if (status >= 400 && !compile(operation.errors?.[status] ?? contract.schemas.Error)(result.body)) {
      return error(500, 'RESPONSE_CONTRACT_VIOLATION', 'Nonconforming error envelope');
    }
    send(status, result.body, result.headers, status >= 400 ? 'application/json' : mediaType);
  } catch (failure) {
    if (response.headersSent) { response.destroy(failure); return; }
    if (failure instanceof URIError) {
      const issue = transportError(contract, 'invalidRequest');
      return transportFailure(issue, 'Malformed URL encoding');
    }
    const domain = Number.isInteger(failure.status) && failure.status >= 400 && failure.status <= 599 && typeof failure.code === 'string';
    error(domain ? failure.status : 500, domain ? failure.code : 'INTERNAL_ERROR', domain ? failure.message : 'Unhandled implementation error', domain ? failure.details ?? {} : {});
  }
});
// Optional process lifecycle is part of the implementation seam, not supplied business logic.
await implementation.start?.();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  server.close();
  try { await implementation.stop?.(); } finally { server.closeAllConnections(); process.exit(0); }
});
server.listen(Number(process.env.PORT ?? 3000), contract.httpHost ?? '0.0.0.0', () => process.send?.({ kind: 'public-api-listening', port: server.address().port, address: server.address().address }));
