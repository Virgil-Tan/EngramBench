// Author-approved evaluation scope. No hidden fixtures or candidate implementation.
export const FINAL_SYSTEM_REVISION = 'learning-final-system-2026-09-08.1';

export const FINAL_SYSTEM_RULES = [
  'Build one complete system from the start. Base features and the formerly named Manager features are required together; there is no intermediate submission, old program, historical workspace, or cross-version upgrade assessment.',
  'V1 in an API or source description denotes the base feature contract, not a separately running program. The published /api/v1 paths and schemaVersion values do not change.',
  'Cross-version-only duties are withdrawn: importing an unspecified historical physical database, upgrading an earlier binary, migration-time availability of an earlier binary, and synthesizing migration-only legacy wrappers. Current public resource shapes, base APIs, additional features and their ordinary business relationships remain required.',
  'Initialize an empty database using the published commands. db:migrate is current-system schema initialization, not an obligation to recognize a hidden old schema. Preserve the original current-system seed validation, atomicity and replay rules.',
  'Evaluation creates fresh data through the published seed or APIs, then checks actual behavior and durable state. Restart and recovery assertions use this same final system. A snapshot is a read-only observation, not a database backup format.',
  'Persistence, transactionality, idempotency, concurrency, authorization, real UI, OpenAPI, recovery and explicitly specified performance requirements remain in scope. This policy does not remove an otherwise explicit business or security requirement.',
  'No external legacy service is required. An isolated receiver or provider simulator is used only for an external interaction actually required by the public product contract; no real account or production service is required.',
  'Hidden assertions must use published inputs and observable requirements. Unspecified algorithms, exact error strings, control points or performance thresholds cannot silently become requirements. Code defects fail; invalid author fixtures and infrastructure faults are evaluator errors, not zero-score business outcomes.',
];

export function applyFinalSystemPolicy(contract) {
  const previous = [...new Set([...(contract.policyRevisions ?? []), contract.policyRevision].filter(Boolean))];
  contract.policyRevisions = [...previous.filter(item => item !== FINAL_SYSTEM_REVISION), FINAL_SYSTEM_REVISION];
  contract.policyRevision = FINAL_SYSTEM_REVISION;
  contract.evaluationScope = 'final-system';
  contract.notes = [...contract.notes, ...FINAL_SYSTEM_RULES.map(rule => `${FINAL_SYSTEM_REVISION}: ${rule}`)];
  return contract;
}

// Preserve original source documents separately. Only the explicitly withdrawn
// conversation/cross-version clauses are removed from the active requirements.
function requirementParagraphs(source) {
  const paragraphs = [];
  let pending = [], fence;
  const flush = () => { if (pending.length) paragraphs.push({ text: pending.join(' '), code: false }); pending = []; };
  for (const original of source.split('\n')) {
    const marker = original.match(/^\s*(?:>\s*)?(`{3,}|~{3,})/);
    if (fence) {
      paragraphs.push({ text: original, code: true });
      if (marker?.[1][0] === fence) fence = undefined;
      continue;
    }
    if (marker) { flush(); fence = marker[1][0]; paragraphs.push({ text: original, code: true }); continue; }
    const line = original.replace(/^\s*>\s?/, '').trim();
    if (!line) { flush(); paragraphs.push({ text: '', code: false }); continue; }
    if (/^(?:#{1,6}\s|[-*+]\s|\d+[.)]\s)/.test(line)) flush();
    // A soft newline is not a sentence boundary. In particular, deleting the
    // first line of a wrapped upgrade clause must not leave its tail active.
    pending.push(line);
  }
  flush();
  return paragraphs;
}

export function currentRequirements({ title, base, manager }) {
  const removed = [], rewritten = [];
  const parts = requirementParagraphs(manager).flatMap(part => {
    if (part.code) return [part];
    // Keep independently meaningful business clauses next to an upgrade clause.
    return part.text.split(/(?<=。|；)|，(?=迁移|旧\s*Release\s*不自动)|;\s+(?=[A-Za-z])|(?<=[.!?])(?<!\d\.)\s+(?=[A-Z])/)
      .map(text => ({ text, code: false }));
  });
  const body = parts.map(({ text: original, code }) => {
    if (code) return original;
    let line = original.replace(/【[^】]*Manager[^】]*】\s*/g, '').trim();
    if (!line) return '';
    line = line.replace(/^(?:在\s*)?V1\s*(?:已完成并通过基础验收。|完成并通过现有测试后[，,]\s*|通过后)/, '');
    if (!line || /^(?:本轮|本消息(?:只|仅|不包含)|请先说明|不要(?:立即)?编码|不立即编码|Please first|Do not implement|DS\s|该正文由\s*Harness|在\s*V1.*(?:Harness|Manager\s*只发布))/i.test(line)) {
      removed.push(original); return '';
    }
    // These are mixed current-business declarations, not duties to upgrade a
    // historical binary. Rewrite only the historical qualifier, keep the wire.
    line = line.replace(/并发 pause\/resume\/cancel、Worker 崩溃和迁移必须/g, '并发 pause/resume/cancel、Worker 崩溃必须')
      .replace(/\bFINAL migration 将\s*/g, '完整系统中 ')
      .replace(/for a migrated one-member default-platform Release/g, 'for an ordinary one-member default-platform Release')
      .replace(/, with default used for migrated V1 versions/g, '')
      .replace(/routes map to the migrated default Project/g, 'routes map to the default Project')
      .replace(/V1\s*历史记录和省略该字段的请求均按/g, '省略该字段的请求按')
      .replace(/(?:现有)?个人订阅不自动迁移/g, '个人订阅保持个人订阅语义')
      .replace(/Keep every V1 Export as a legacy one-object Export/g, 'Keep every one-object Export in the one-object form')
      .replace(/The V1 main history becomes branch main/g, 'The base document history belongs to branch main')
      .replace(/Previously completed Campaigns remain terminal and never trigger migration-time commands/g, 'Completed Campaigns remain terminal');
    const prose = line.replace(/^[-*\d.\s]+/, '');
    if (/(?:迁移时|迁移保留|迁移必须|迁移期间|迁移为|迁移把|迁移中|兼容迁移)/.test(prose)
      || /\b(?:Migrate|Migrating)\b/.test(prose)
      || /\b(?:migration|migrated|migrate)\b/i.test(prose) && !/Update .*migration|更新.*migration/i.test(prose)) {
      if (!/^(?:(?:兼容)?迁移|V1.*迁移|Migrate\b|Migrating\b)/i.test(prose)
        && /\/api\/|=\s*\{|\badd(?:s)?\b.*(?:uuid|string)/.test(prose)) {
        throw new Error(`Mixed current wire and historical clause needs an explicit author rewrite: ${line}`);
      }
      removed.push(original); return '';
    }
    line = line.replace(/本期正式增加/g, '完整系统包含').replace(/公开增量合同/g, '公开产品合同');
    if (line !== original) rewritten.push({ original, current: line });
    return line;
  }).join('\n');
  return {
    text: [`# ${title} — Complete system requirements`, '',
      `Public scope revision: **${FINAL_SYSTEM_REVISION}**. This is a single final-system task, not a historical upgrade benchmark.`, '',
      '## Scope and authority', '', ...FINAL_SYSTEM_RULES.map(rule => `- ${rule}`), '',
      'The original source documents are retained under frontal-legacy/ only for provenance. The complete active business requirements are reproduced below; the withdrawn historical orchestration and cross-version-only clauses are not a second source of obligations. contract/ fixes public representation.', '',
      '## Base product requirements', '', base.trim(), '',
      '## Additional product requirements — required in the same final system', '', body, '',
    ].join('\n'),
    removed,
    rewritten,
  };
}

export function finalWorkspaceReadme(title) {
  return [`# ${title}`, '', '## Goal', '',
    `Implement the complete ${title} system in this workspace. Read [the complete requirements](docs/requirements.md), [the public interface](contract/README.md), and [the exact schemas and examples](contract/contract.json).`, '',
    '## Starting Point', '',
    'This is a Frontal Benchmark V2 fixed-interface starter for the complete final system. Use this workspace and an empty database. There is no intermediate submission or earlier program to upgrade.', '',
    '## Required Behaviour', '',
    '- Deliver one final workspace implementing both base and additional product features. The same Frozen Plan applies to every experiment arm.',
    '- Start from an empty database. Tests create fresh data through published seed/API interfaces. No earlier program, intermediate V1 snapshot, historical database or cross-version deployment is required.',
    '- Implement the actual business operations, durable storage, workers, UI and verification. Passing a schema or public smoke check is not task completion.',
    '', '## Public Interfaces', '',
    'Implement the exact published operations, commands, seed, errors and snapshot schemas in contract/. Read docs/requirements.md for their full business meaning.', '',
    '## Constraints and Invariants', '',
    'Preserve all current-system business, integrity, concurrency, security and recovery requirements. README is authoritative; the Frozen Plan only orders execution.',
    '- Do not edit author-owned interfaces or checks to make an implementation pass. Do not return hard-coded fixtures.', '',
    '## Required Commands', '',
    'Implement and execute the commands published in docs/requirements.md and contract/contract.json, including public verification. db:migrate initializes the current system.', '',
    '## Acceptance', '',
    '- Re-read the full requirements, audit the complete system, run required public checks and report evidence before delivery.',
    '- Acceptance evaluates the actual final system; schema checks and local self-tests alone do not prove business completion.', '',
    '## Out of Scope', '',
    'Historical physical databases, old binaries, cross-version upgrade choreography and migration-only legacy wrapper generation are not required.', '',
    `Scope: **${FINAL_SYSTEM_REVISION}**. Original source texts under docs/frontal-legacy/ are retained for provenance, not as a second execution route.`, '',
  ].join('\n');
}
