import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { readSeedJsonFile } from '../../templates/contract-first/seed-reader.mjs';

const wireUrl = process.env.FRONTAL_PUBLIC_CONTRACT_ROOT
  ? pathToFileURL(join(process.env.FRONTAL_PUBLIC_CONTRACT_ROOT, 'runtime.mjs'))
  : new URL('../../templates/contract-first/runtime.mjs', import.meta.url);
const { validator: wireValidator, utcTimestampSchema = { type: 'string', format: 'date-time', pattern: '(?:[Zz]|\\+00:00)$' } } = await import(wireUrl);
const validUtcTimestamp = wireValidator({ schemas: {} })(utcTimestampSchema);

export function assertUtcTimestamp(value, label = 'timestamp') {
  assert.ok(validUtcTimestamp(value), `${label} must match the public UTC date-time contract`);
  return true;
}

// Compare public UTC instants without changing signed/hashed JSON bytes or losing sub-ms precision.
export function compareUtcTimestamps(left, right) {
  assertUtcTimestamp(left); assertUtcTimestamp(right);
  const parts = value => value.toUpperCase().replace(/\+00:00$/, 'Z').slice(0, -1).split('.');
  const [a, af = ''] = parts(left), [b, bf = ''] = parts(right);
  if (a !== b) return a < b ? -1 : 1;
  const width = Math.max(af.length, bf.length), x = af.padEnd(width, '0'), y = bf.padEnd(width, '0');
  return x === y ? 0 : x < y ? -1 : 1;
}

// Author-side validation, never a response/source compatibility adapter.
export async function evaluatorContract(root) {
  if (!root) return undefined;
  const contract = JSON.parse(readFileSync(join(root, 'contract.json'), 'utf8'));
  const { validator, matchOperation, requestValidator } = await import(pathToFileURL(join(root, 'runtime.mjs')));
  const compile = validator(contract), seedSchema = compile(contract.seed.schema);
  const validateRequest = requestValidator(contract);
  const issue = (code, message, details) => Object.assign(new Error(message), { name: 'EvaluationInfrastructureError', origin: 'evaluator', code, details });
  const seedCommand = contract.seed.command ?? ['npm', 'run', 'db:seed', '--', '--file', '${SEED_PATH}'];
  const boundary = {
    seed(value, options = {}) {
      if (options.contractExpectation === 'invalid') return;
      if (!seedSchema(value)) throw issue('EVALUATOR_PUBLIC_CONTRACT_MISMATCH', 'Hidden positive seed violates the published V2 contract; fix the evaluator fixture, not the submission', { violations: seedSchema.errors });
    },
    seedCommand(path) { return seedCommand.map(value => value.replaceAll('${SEED_PATH}', path)); },
    async command(binary, args, options = {}) {
      // Legacy task decorators may call npm("seed") directly. Check the public
      // command boundary so they cannot accidentally skip author validation.
      if (basename(binary) !== seedCommand[0] || args[0] !== seedCommand[1] || args[1] !== seedCommand[2]) return;
      if (options.contractExpectation === 'invalid') return;
      const index = args.indexOf('--file');
      if (index < 0 || !args[index + 1]) throw issue('EVALUATOR_PUBLIC_CONTRACT_MISMATCH', 'Hidden positive seed command is missing --file');
      let value;
      try { value = await readSeedJsonFile(args[index + 1]); }
      catch (cause) {
        if (cause.code === 'ERR_STRING_TOO_LONG' || cause.code === 'ERR_FS_FILE_TOO_LARGE')
          throw issue('EVALUATOR_SEED_READER_LIMIT', 'The evaluator reached an engine seed-reader limit; this is not malformed JSON or a submission failure', { cause: cause.message, name: cause.name, ...(cause.code && { code: cause.code }) });
        throw issue('EVALUATOR_PUBLIC_CONTRACT_MISMATCH', 'Hidden positive seed file is missing or malformed JSON', { cause: cause.message });
      }
      boundary.seed(value, options);
    },
    request(path, options = {}) {
      if (options.contractExpectation === 'invalid') return;
      const pathname = new URL(path, 'http://localhost').pathname;
      let route;
      try { route = matchOperation(contract.operations, options.method ?? 'GET', pathname); }
      catch (cause) { throw issue('EVALUATOR_PUBLIC_CONTRACT_MISMATCH', 'Hidden positive request has malformed URL encoding', { cause: cause.message }); }
      if (!route && !pathname.startsWith('/api/') && !pathname.startsWith('/media/')) return; // UI assets are implementation-owned.
      if (!route) throw issue('EVALUATOR_PUBLIC_CONTRACT_MISMATCH', `Hidden request uses an unpublished route: ${options.method ?? 'GET'} ${pathname}`);
      const query = {}, search = new URL(path, 'http://localhost').searchParams;
      for (const name of search.keys()) query[name] = search.getAll(name).length > 1 ? search.getAll(name) : search.get(name);
      const headers = Object.fromEntries(Object.entries(options.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
      const hasJson = Object.hasOwn(options, 'json');
      if (hasJson) headers['content-type'] ??= 'application/json';
      let body = options.json;
      if (!hasJson && options.raw?.length && route.operation.request?.contentMediaType !== 'application/octet-stream') {
        try { body = JSON.parse(String(options.raw)); }
        catch (cause) { throw issue('EVALUATOR_PUBLIC_CONTRACT_MISMATCH', 'Hidden positive request has malformed JSON; intentional malformed-input tests must declare contractExpectation: invalid', { cause: cause.message }); }
      }
      const result = validateRequest(route.operation, { params: route.params, query, headers, body, hasBody: hasJson ? options.json !== undefined : !!options.raw?.length });
      if (!result.valid) throw issue('EVALUATOR_PUBLIC_CONTRACT_MISMATCH', `Hidden positive request violates ${route.operation.id}: ${result.message}; intentional malformed-input tests must declare contractExpectation: invalid`, { violations: result.violations });
    },
  };
  return boundary;
}
