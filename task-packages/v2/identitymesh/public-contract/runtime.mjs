import Ajv from "ajv/dist/2020.js";

// Public UTC wire format: fractional seconds are optional, not fixed to milliseconds.
export const utcTimestampSchema = { type: "string", format: "date-time", pattern: "(?:[Zz]|\\+00:00)$" };

function decimalParts(value) {
  const [mantissa, exponent = '0'] = String(value).toLowerCase().split('e');
  return { integer: BigInt(mantissa.replace('.', '')), scale: (mantissa.split('.')[1]?.length ?? 0) - Number(exponent) };
}

function decimalMultipleOf(divisor, value) {
  if (!Number.isFinite(value) || !Number.isFinite(divisor) || divisor <= 0) return false;
  const number = decimalParts(value), unit = decimalParts(divisor), scale = Math.max(number.scale, unit.scale);
  return (number.integer * 10n ** BigInt(scale - number.scale)) % (unit.integer * 10n ** BigInt(scale - unit.scale)) === 0n;
}

export function validator(contract, options = {}) {
  const ajv = new Ajv({ strict: false, allErrors: true, ...options });
  // JSON wire decimals need exact divisibility, not binary division plus epsilon.
  ajv.removeKeyword('multipleOf');
  ajv.addKeyword({ keyword: 'multipleOf', type: 'number', schemaType: 'number',
    validate: decimalMultipleOf, errors: false });
  ajv.addFormat("uuid", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  ajv.addFormat("date-time", (value) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/.exec(value);
    if (!match) return false;
    const [, year, month, day, hour, minute, second, , offsetHour = "0", offsetMinute = "0"] = match;
    const leap = Number(year) % 4 === 0 && (Number(year) % 100 !== 0 || Number(year) % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= days[Number(month) - 1]
      && Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 60 && Number(offsetHour) <= 23 && Number(offsetMinute) <= 59;
  });
  return (schema) => ajv.compile({ ...schema, $defs: contract.schemas });
}

export function matchOperation(operations, method, pathname) {
  // A colon inside a literal segment (access-requests:batch) is NOT a parameter.
  for (const operation of [...operations].sort((a, b) => a.path.split('/').filter(s => s.startsWith(':')).length - b.path.split('/').filter(s => s.startsWith(':')).length)) {
    if (operation.method !== method) continue;
    const names = [];
    const expression = operation.path.split("/").map((segment) => {
      if (/^:[A-Za-z][A-Za-z0-9_]*$/.test(segment)) { names.push(segment.slice(1)); return "([^/]+)"; }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }).join("/");
    const match = new RegExp(`^${expression}$`).exec(pathname);
    if (match) return { operation, params: Object.fromEntries(names.map((name, i) => [name, decodeURIComponent(match[i + 1])])) };
  }
  return undefined;
}

export function openApi(contract) {
  const paths = {};
  const fixRefs = (value) => JSON.parse(JSON.stringify(value).replaceAll("#/$defs/", "#/components/schemas/"));
  for (const operation of contract.operations) {
    const path = operation.path.replace(/\/:([A-Za-z][A-Za-z0-9_]*)/g, "/{$1}");
    const content = operation.request?.contentMediaType ?? "application/json";
    const responseContent = operation.response?.contentMediaType ?? (operation.path === "/" ? "text/html" : "application/json");
    paths[path] ??= {};
    paths[path][operation.method.toLowerCase()] = {
      operationId: operation.id,
      "x-public-source": operation.source,
      ...(operation.bodyTransportErrors && { 'x-body-transport-errors': operation.bodyTransportErrors }),
      parameters: [...[...operation.path.matchAll(/\/:([A-Za-z][A-Za-z0-9_]*)/g)].filter(([, name]) => !(operation.parameters ?? []).some(p => p.in === "path" && p.name === name)).map(([, name]) => ({ name, in: "path", required: true, schema: { type: "string" } })), ...(operation.parameters ?? []).map(({ transportError, missingTransportError, ...parameter }) => ({ ...fixRefs(parameter), ...(transportError && { 'x-transport-error': transportError }), ...(missingTransportError && { 'x-missing-transport-error': missingTransportError }) }))],
      ...(operation.request && { requestBody: { required: true, content: { [content]: { schema: fixRefs(operation.request) } } } }),
      responses: {
        ...Object.fromEntries([...new Set([400, 401, 403, 404, 409, 500, ...Object.keys(operation.errors ?? {}).map(Number)])].map((status) => [status, {
          description: "Public error envelope; exact business conditions remain defined by README",
          content: { "application/json": { schema: operation.errors?.[status] ? fixRefs(operation.errors[status]) : { $ref: "#/components/schemas/Error" } } },
        }])),
        ...Object.fromEntries((operation.successStatuses ?? [operation.status ?? 200]).map(status => [status, {
          ...(operation.responseHeaders && { headers: Object.fromEntries(Object.entries(operation.responseHeaders).map(([name, schema]) => [name, { schema: fixRefs(schema) }])) }),
          description: operation.response ? "Published public success shape" : "Success shape not fully specified in the original public text; see contract notes",
          ...(![204,304].includes(status) && operation.method !== "HEAD" && (operation.successResponses?.[status]?.response ?? operation.response) && { content: { [operation.successResponses?.[status]?.response?.contentMediaType ?? responseContent]: { schema: fixRefs(operation.successResponses?.[status]?.response ?? operation.response) } } }),
        }])),
        default: { description: "Application errors must use the public error envelope", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
      },
    };
  }
  return { openapi: "3.1.0", info: { title: contract.title, version: "2.0.0" }, paths, ...(contract.webhooks && { webhooks: fixRefs(contract.webhooks) }), components: { schemas: fixRefs(contract.schemas) } };
}

export function expand(value, variables) {
  if (typeof value === 'string') {
    const exact = /^\$\{([A-Za-z0-9_]+)([+-]\d+ms)?\}$/.exec(value);
    const get = (name, offset) => {
      if (!Object.hasOwn(variables, name) || variables[name] === undefined) throw new Error(`Missing public variable: ${name}`);
      const anchor = variables[name];
      if (!offset) return anchor;
      const time = typeof anchor === 'string' ? Date.parse(anchor) : NaN;
      const shifted = time + Number(offset.slice(0, -2));
      if (!Number.isFinite(time) || !Number.isSafeInteger(shifted) || Math.abs(shifted) > 8640000000000000) throw new Error(`Invalid public timestamp offset: ${name}${offset}`);
      return new Date(shifted).toISOString();
    };
    return exact ? get(exact[1], exact[2]) : value.replace(/\$\{([A-Za-z0-9_]+)([+-]\d+ms)?\}/g, (_, name, offset) => String(get(name, offset)));
  }
  if (Array.isArray(value)) return value.map(item => expand(item, variables));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item, variables)]));
  return value;
}

export function requestPath(operation, example = {}) {
  const path = (example.path ?? operation.path).replace(/\/:([A-Za-z][A-Za-z0-9_]*)/g, (_, name) => {
    if (example.params?.[name] === undefined) throw new Error(`Missing path parameter: ${name}`);
    return `/${encodeURIComponent(example.params[name])}`;
  });
  const query = new URLSearchParams(example.query ?? {}).toString();
  return query ? `${path}${path.includes('?') ? '&' : '?'}${query}` : path;
}

export function contains(actual, expected) {
  if (expected === null || typeof expected !== "object") return Object.is(actual, expected);
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((item, i) => contains(actual[i], item));
  return actual !== null && typeof actual === "object" && Object.entries(expected).every(([key, value]) => Object.hasOwn(actual, key) && contains(actual[key], value));
}

export function errorBody(contract, code, message, details = {}, explicitBody) {
  const valid = validator(contract)(contract.schemas.Error);
  if (explicitBody !== undefined) {
    if (!valid(explicitBody) || explicitBody.error?.code !== code) throw new Error('Published transport error body violates its Error schema/code');
    return structuredClone(explicitBody);
  }
  for (const candidate of [details, [], {}]) {
    const body = { error: { code, message, details: candidate } };
    if (valid(body)) return body;
  }
  throw new Error('Author Error schema cannot encode a standard transport error');
}

export function transportError(contract, kind, operation) {
  const defaults = {
    auth: { status: 401, code: 'UNAUTHORIZED' },
    invalidJson: { status: 400, code: 'MALFORMED_JSON' },
    unsupportedMediaType: { status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' },
    unknownRoute: { status: 404, code: 'NOT_FOUND' },
  };
  return operation?.transportErrors?.[kind] ?? contract.transportErrors?.[kind] ?? defaults[kind] ?? { status: 400, code: 'INVALID_REQUEST' };
}

// One request validator shared by the server and author-side hidden fixture checks.
export function requestValidator(contract) {
  const compile = validator(contract), parameterCompile = validator(contract, { coerceTypes: true, useDefaults: true });
  const cache = new Map(contract.operations.map(operation => [operation.id, {
    body: operation.request ? compile(operation.request) : undefined,
    parameters: (operation.parameters ?? []).map(parameter => ({ ...parameter, validate: parameterCompile({ type: 'object', properties: { value: parameter.schema }, ...(parameter.required ? { required: ['value'] } : {}) }) })),
  }]));
  const declaresProperty = (input, path, name, seen = new Set()) => {
    let schema = input;
    if (!schema || typeof schema !== 'object') return false;
    if (schema.$ref?.startsWith('#/$defs/')) {
      const key = `${schema.$ref}:${path.join('/')}:${name}`;
      if (seen.has(key)) return false;
      seen = new Set(seen).add(key);
      schema = contract.schemas[schema.$ref.slice('#/$defs/'.length)];
      return declaresProperty(schema, path, name, seen);
    }
    if ([...(schema.anyOf ?? []), ...(schema.oneOf ?? []), ...(schema.allOf ?? [])].some(part => declaresProperty(part, path, name, seen))) return true;
    if (path.length) return declaresProperty(schema.type === 'array' ? schema.items : schema.properties?.[path[0]], path.slice(1), name, seen);
    return Object.hasOwn(schema.properties ?? {}, name) || Object.keys(schema.patternProperties ?? {}).some(pattern => new RegExp(pattern).test(name));
  };
  return (operation, { params = {}, query = {}, headers: supplied = {}, body, hasBody = false, checkBody = true } = {}) => {
    const rules = cache.get(operation.id), headers = Object.fromEntries(Object.entries(supplied).map(([name, value]) => [name.toLowerCase(), value]));
    const fail = (message, violations = [], kind = 'invalidRequest') => ({ valid: false, message, violations, ...transportError(contract, kind, operation) });
    const queryNames = new Set(rules.parameters.filter(p => p.in === 'query').map(p => p.name));
    for (const name of Object.keys(query)) if (!queryNames.has(name)) return fail(`Unknown query parameter: ${name}`, [], 'unknownQuery');
    for (const parameter of rules.parameters) {
      const source = parameter.in === 'path' ? params : parameter.in === 'header' ? headers : query;
      const name = parameter.in === 'header' ? parameter.name.toLowerCase() : parameter.name;
      const wrapped = source[name] === undefined ? {} : { value: source[name] };
      if (Array.isArray(wrapped.value) && parameter.schema.type !== 'array') return { ...fail(`Repeated scalar parameter: ${parameter.name}`), ...parameter.transportError };
      if (!parameter.validate(wrapped)) return { ...fail(`Invalid ${parameter.in} parameter: ${parameter.name}`, parameter.validate.errors, name === 'authorization' ? 'auth' : 'invalidRequest'), ...(source[name] === undefined ? parameter.missingTransportError ?? parameter.transportError : parameter.transportError) };
      if (Object.hasOwn(wrapped, 'value')) source[name] = wrapped.value;
    }
    const noBody = operation.requestBody === 'none' || ['GET', 'HEAD'].includes(operation.method);
    if (noBody && hasBody) return fail('This operation has no request body');
    const mediaType = operation.request?.contentMediaType ?? 'application/json';
    if (hasBody && String(headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== mediaType) return fail(`Expected Content-Type: ${mediaType}`, [], 'unsupportedMediaType');
    if (checkBody && rules.body && mediaType !== 'application/octet-stream' && !rules.body(body)) {
      // Union branches can reject fields declared by another branch. Only a
      // genuinely unpublished field takes precedence over field-specific errors.
      const unknown = rules.body.errors.some(error => ['additionalProperties', 'unevaluatedProperties'].includes(error.keyword)
        && !declaresProperty(operation.request, error.instancePath.split('/').slice(1).map(key => key.replaceAll('~1', '/').replaceAll('~0', '~')), error.params.additionalProperty ?? error.params.unevaluatedProperty));
      if (unknown) return fail('Body does not match the published request schema', rules.body.errors, 'unknownField');
      for (const violation of rules.body.errors) {
        const path = violation.instancePath.split('/').slice(1).map(key => key.replaceAll('~1', '/').replaceAll('~0', '~'));
        const value = path.reduce((part, key) => part?.[key], body);
        const override = (operation.bodyTransportErrors ?? []).find(rule => {
          const expected = rule.path.split('/').slice(1).map(key => key.replaceAll('~1', '/').replaceAll('~0', '~'));
          return expected.length <= path.length && expected.every((key, i) => key === '*' ? /^\d+$/.test(path[i]) : key === path[i])
            && (!rule.when || (typeof value === 'number' && (rule.when === 'number' || !Number.isSafeInteger(value))));
        });
        if (override) return { ...fail('Body does not match the published request schema', rules.body.errors), status: override.status, code: override.code };
      }
      return fail('Body does not match the published request schema', rules.body.errors);
    }
    return { valid: true, params, query, headers, body };
  };
}
