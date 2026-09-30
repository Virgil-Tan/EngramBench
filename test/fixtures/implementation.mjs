// Toy implementation for transport tests ONLY. Never copied into task starters.
const rows = new Map();
export async function execute(id, context) {
  if (id === 'health') return { body: { status: 'ok' } };
  if (id === 'create') { const row = { id: 'row-1', name: context.body.name }; rows.set(row.id, row); return { status: 201, body: row }; }
  if (id === 'read') return { body: rows.get(context.params.id) };
  if (id === 'snapshot') return { body: { rows: [...rows.values()] } };
  if (id === 'query') return { body: { limit: context.query.limit } };
  if (id === 'wrong-response') return { body: { inventedEnvelope: {} } };
  if (id === 'wrong-status') return { status: 202, body: { name: 'bad' } };
  if (id === 'upload') { let length = 0; for await (const bytes of context.stream) length += bytes.length; return { body: { length } }; }
  if (id === 'download') return { status: 206, body: Buffer.from([0, 255, 1]), headers: { 'content-range': 'bytes 0-2/3' } };
  if (id === 'cached') return { status: 304 };
  if (id === 'ui') return { body: '<!doctype html><title>Wire fixture</title>' };
  if (id === 'batch') return { body: { literal: true } };
  if (id === 'none') return { body: { accepted: true } };
  throw Object.assign(new Error(`Implement ${id}`), { status: 501, code: 'NOT_IMPLEMENTED' });
}
