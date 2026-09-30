// Versioned author transport repair for historical frozen evaluations only.
// No file writes, query rewriting, implementation wrapping or business behavior.
const { registerHooks } = require('node:module');
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const { fileURLToPath } = require('node:url');
const assert = require('node:assert/strict');

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
exports.install = function install({ targets, replacement, originalSha256, replacementSha256 }) {
  assert(Array.isArray(targets) && targets.length > 0 && new Set(targets).size === targets.length);
  assert(targets.every(url => url.startsWith('file:') && /\/(?:contract|public-contract)\/runtime\.mjs$/.test(fileURLToPath(url))), 'Only author runtime modules may be overlaid');
  const source = readFileSync(replacement, 'utf8');
  assert.equal(sha(source), replacementSha256, 'Revised author transport changed');
  return registerHooks({ load(url, context, nextLoad) {
    if (!targets.includes(url)) return nextLoad(url, context);
    assert.equal(sha(readFileSync(fileURLToPath(url))), originalSha256, 'Historical author transport differs; do not overwrite candidate changes');
    process.stderr.write(`[public-ui-entry-overlay] ${url} ${originalSha256} -> ${replacementSha256}\n`);
    return { format: 'module', shortCircuit: true, source };
  } });
};
// Candidate launchers may whitelist NODE_OPTIONS but drop custom environment
// names. A deployed read-only overlay is self-contained beside its manifest.
const manifest = process.env.FRONTAL_UI_ENTRY_OVERLAY_MANIFEST || join(__dirname, 'manifest.json');
if (process.env.FRONTAL_UI_ENTRY_OVERLAY_MANIFEST || existsSync(manifest)) {
  exports.install(JSON.parse(readFileSync(manifest, 'utf8')));
}
