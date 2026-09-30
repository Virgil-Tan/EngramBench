// Diagnostic wire adapter. No route, status, value, database or business changes.
const { basename, dirname } = require('node:path');
const { ServerResponse } = require('node:http');

// NODE_OPTIONS is inherited by npm, workers and evaluator commands as well.
// Only the known author-owned HTTP entry is allowed to install this adapter.
const entry = process.argv[1] || '';
if (basename(entry) === 'server.mjs' && basename(dirname(entry)) === 'contract') {
  const json = Symbol('json-response'), streamed = Symbol('streamed-response');
  const originalHead = ServerResponse.prototype.writeHead;
  const originalWrite = ServerResponse.prototype.write;
  const originalEnd = ServerResponse.prototype.end;
  let changed = 0;
  const order = value => Array.isArray(value) ? value.map(order)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, order(value[key])]))
      : value;
  ServerResponse.prototype.writeHead = function (...args) {
    const headers = typeof args[1] === 'string' ? args[2] : args[1];
    const type = Object.entries(headers || {}).find(([name]) => name.toLowerCase() === 'content-type')?.[1]
      ?? this.getHeader('content-type');
    this[json] = /^application\/json(?:;|$)/i.test(String(type));
    return Reflect.apply(originalHead, this, args);
  };
  ServerResponse.prototype.write = function (...args) {
    this[streamed] = true;
    return Reflect.apply(originalWrite, this, args);
  };
  ServerResponse.prototype.end = function (...args) {
    const chunk = args[0];
    if (this[json] && !this[streamed] && (typeof chunk === 'string' || Buffer.isBuffer(chunk))
      && (typeof args[1] !== 'string' || /^utf-?8$/i.test(args[1]))) {
      try {
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
        const stable = JSON.stringify(order(JSON.parse(text)));
        // This adapter only reorders compact JSON keys. Do not change a sent
        // Content-Length, pretty/opaque encodings, streams, or non-JSON media.
        if (Buffer.byteLength(stable) === Buffer.byteLength(text) && stable !== text) {
          args[0] = Buffer.isBuffer(chunk) ? Buffer.from(stable) : stable;
          changed++;
        }
      } catch { /* Keep malformed/unsupported output observable, not corrected. */ }
    }
    return Reflect.apply(originalEnd, this, args);
  };
  process.once('exit', () => process.stderr.write(JSON.stringify({ kind:'creator-json-order-v1', responsesReordered:changed }) + '\n'));
}
