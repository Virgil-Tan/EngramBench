import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { applyFinalSystemPolicy, currentRequirements, finalWorkspaceReadme, FINAL_SYSTEM_REVISION } from '../contracts/learning/final-system-policy.mjs';

test('final-system README retains the existing V2 workspace identity and complete requirements entry', () => {
  const readme = finalWorkspaceReadme('Example');
  assert.ok(readme.includes('Frontal Benchmark V2 fixed-interface starter'));
  assert.ok(readme.includes('docs/requirements.md'));
  assert.ok(readme.includes('no intermediate submission or earlier program to upgrade'));
});
import { validateFinalSystemManifest } from '../src/task-package-v2-evaluator.mjs';

test('final-system policy changes scope, not public wire, and keeps prior revision attribution', () => {
  const contract = { policyRevision:'earlier-wire', operations:[{ path:'/api/v1/items' }], seed:{ schemaVersion:1 }, notes:['original'] };
  const before = structuredClone(contract);
  applyFinalSystemPolicy(contract);
  assert.equal(contract.evaluationScope,'final-system');
  assert.equal(contract.policyRevision,FINAL_SYSTEM_REVISION);
  assert.deepEqual(contract.policyRevisions,['earlier-wire',FINAL_SYSTEM_REVISION]);
  assert.deepEqual(contract.operations,before.operations);
  assert.deepEqual(contract.seed,before.seed);
});

test('withdrawal preserves mixed business/wire clauses and fenced code verbatim', () => {
  const code = '```json\n{"example":"第一句。第二句；迁移时"}\n```';
  const {text} = currentRequirements({title:'Fixture',base:'ALL BASE REQUIREMENTS',manager:[
    '新增 Campaign、CAMPAIGN_FANOUT Work；迁移保留旧库。',
    '新增 disputes、resolve 和 adjustments 接口，迁移必须保留旧库。',
    '7. A Package has at most one Release for a version. Within a Release, identity is packageName plus version plus platform; migrated V1 versions use platform default.',
    '- Reservation add organizationId:uuid and projectId:uuid. New hierarchy records have poolId null; records migrated from a flat Pool retain poolId',
    '迁移保留旧记录；并发释放不得超卖。', code, '本轮先不要实现。请先说明计划。',
  ].join('\n')});
  for (const requirement of ['ALL BASE REQUIREMENTS','CAMPAIGN_FANOUT','disputes、resolve 和 adjustments','at most one Release','packageName plus version plus platform','organizationId:uuid','poolId null','并发释放不得超卖',code]) assert.ok(text.includes(requirement),requirement);
  assert.doesNotMatch(text,/本轮先不要实现|migrated V1 versions|迁移必须保留旧库/);
});

test('every Learning document retains its complete base and newly required Work/events', async () => {
  const {tasks}=JSON.parse(await readFile(new URL('../learning-tasks.json',import.meta.url)));
  for (const id of tasks) {
    const path=new URL(`../task-packages/legacy/${id}/workspace/docs/frontal-legacy/`,import.meta.url);
    const base=await readFile(new URL('README.md',path),'utf8'), manager=await readFile(new URL('manager-requirements.md',path),'utf8');
    const {text}=currentRequirements({title:id,base,manager});
    assert.ok(text.includes(base.trim()),id);
    for (const token of manager.match(/\b[A-Z][A-Z_]+(?:_EXECUTE|_SWITCH|_FANOUT)\b/g)??[]) assert.ok(text.includes(token),`${id}: ${token}`);
  }
});

test('final manifest rejects historical prerequisites and placeholders before candidate actions', () => {
  const final=cases=>({evaluationScope:'final-system',cases});
  for (const prerequisite of ['V1','V1_CHECKPOINT','frozen_v1_checkpoint']) {
    assert.throws(()=>validateFinalSystemManifest(final([{id:'E-01',prerequisites:[prerequisite]}])),/historical prerequisite/);
  }
  assert.throws(()=>validateFinalSystemManifest(final([{id:'A-01',blockedAssertions:[{id:'not-written'}]}])),/author placeholder/);
  assert.doesNotThrow(()=>validateFinalSystemManifest(final([{id:'A-01',prerequisites:['FINAL']}])));
  assert.doesNotThrow(()=>validateFinalSystemManifest({cases:[{id:'E-01',prerequisites:['V1']}]}));
});

test('wrapped prose is removed as a complete upgrade clause, not as orphaned continuation lines', () => {
  const {text,removed}=currentRequirements({title:'Wrapped',base:'Unchanged base',manager:[
    '> 新增 comparison.cancelled Events；迁移保留 V1 identity、saved replay、',
    '> pending Work、Event 和 audit chain。UI 必须提供进度和取消。',
    '迁移保留 V1 Seat、Hold、Order、',
    'Payment、saved replay、pending Work 和 Event。并发释放不得超卖。',
    '本轮只做影响分析和计划，',
    '不要立即编码。',
  ].join('\n')});
  assert.ok(text.includes('comparison.cancelled Events'));
  assert.ok(text.includes('UI 必须提供进度和取消'));
  assert.ok(text.includes('并发释放不得超卖'));
  assert.doesNotMatch(text,/\n(?:Payment、|pending Work、|不要立即编码)/);
  assert.ok(removed.some(value=>value.includes('V1 Seat、Hold、Order、 Payment、saved replay')));
  assert.ok(removed.some(value=>value.includes('V1 identity、saved replay、 pending Work、Event 和 audit chain')));
});

test('current enum and ordinary resource duties survive migration-qualified source prose', () => {
  const {text}=currentRequirements({title:'Mixed',base:'Base',manager:[
    'FINAL migration 将 ReviewStage.level 扩展为 `LEVEL_1|LEVEL_2|APPEAL|RECONSIDERATION`。',
    '迁移保留旧记录，旧 Release 不自动加入 Train。',
    '9. Previously completed Campaigns remain terminal and never trigger migration-time commands.',
    '- Published ArtifactVersion adds platform:string, with default used for migrated V1 versions; legacy V1 response bodies omit this Manager field.',
    '- Legacy /api/v1/quota-pools/:poolId routes map to the migrated default Project and retain V1 request and response fields.',
  ].join('\n')});
  for(const item of ['ReviewStage.level 扩展为 `LEVEL_1|LEVEL_2|APPEAL|RECONSIDERATION`','旧 Release 不自动加入 Train','Completed Campaigns remain terminal','ArtifactVersion adds platform:string','response bodies omit this Manager field','/api/v1/quota-pools/:poolId routes map to the default Project']) assert.ok(text.includes(item),item);
  assert.doesNotMatch(text,/FINAL migration 将|for migrated V1 versions|migration-time commands/);
});

test('all historical wrapper phrasings are withdrawn but current legacy-reference fields stay public', async () => {
  for(const id of ['edgetwin','routeweave','routepilot']) {
    const manager=await readFile(new URL(`../tasks/${id}/orchestration/manager-prompt.zh-CN.md`,import.meta.url),'utf8');
    const {text}=currentRequirements({title:id,base:'Base',manager});
    const additional=text.split('## Additional product requirements — required in the same final system')[1];
    assert.doesNotMatch(additional,/兼容迁移|迁移为|在迁移中|重复 migration|legacy-global|requestRef="legacy:"/);
    if(id==='routeweave') assert.ok(additional.includes('legacyShipmentId:null|uuid'));
    assert.ok(additional.includes(id==='edgetwin'?'DEPLOYMENT_WAVE_ADVANCE':id==='routeweave'?'CONSIGNMENT_PROJECT':'ROLLOUT_ADVANCE'));
  }
});

test('new ambiguous mixed wire clauses stop projection instead of silently deleting current requirements', () => {
  assert.throws(()=>currentRequirements({title:'Unknown',base:'Base',manager:'- CurrentResource adds field:uuid while migrated variants retain another shape.'}),/explicit author rewrite/);
});

test('all Learning active additions retain business boundaries beside withdrawn upgrade wording', async () => {
  const expectations={
    configorbit:['旧 Release 不自动加入 Train','PROMOTION_ADVANCE','PROMOTION_ROLLBACK'],
    notifyroute:['CAMPAIGN_FANOUT','并发 pause/resume/cancel、Worker 崩溃必须保持'],
    moderationflow:['ReviewStage.level 扩展为 LEVEL_1|LEVEL_2|APPEAL|RECONSIDERATION','completedCount=changedCount+noChangeCount<=totalCount'],
    entitlementhub:['省略','INDIVIDUAL','PlanRevision feature limit','个人订阅保持个人订阅语义'],
    artifactvault:['packageName plus version plus platform','Published ArtifactVersion adds platform:string','ordinary one-member default-platform Release'],
    exportvault:['one-object form without synthesizing a Shard or Manifest','a sharded Export returns object:null'],
    firmwarefleet:['Completed Campaigns remain terminal','legacy direct-compatible updates contain exactly one Hop'],
    mergeboard:['The base document history belongs to branch main','legacy endpoints continue to imply main'],
    seatreserve:['并发释放、匹配、取消、接受、拒绝和 Worker SIGKILL 不得重复 Offer 或超卖'],
  };
  for(const[id,clauses]of Object.entries(expectations)) {
    const manager=await readFile(new URL(`../task-packages/legacy/${id}/workspace/docs/frontal-legacy/manager-requirements.md`,import.meta.url),'utf8');
    const{text}=currentRequirements({title:id,base:'BASE',manager});
    for(const clause of clauses) assert.ok(text.includes(clause),`${id}: ${clause}`);
  }
});
