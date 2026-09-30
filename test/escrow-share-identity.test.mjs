import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { assertDetail } from '../evaluators/transfer/escrowguard/v2/oracles/index.mjs';

// Exercise the actual A-13 assertion segment, preceded by the unchanged getDetail oracle.
const source = readFileSync(new URL('../evaluators/transfer/escrowguard/v2/cases/a.mjs', import.meta.url), 'utf8');
const a13 = source.slice(source.indexOf('const A13 ='));
const segment = a13.slice(a13.indexOf('const sharesByMilestone ='), a13.indexOf('const captured ='));
assert.ok(segment.includes('captured Share cardinalities') && segment.includes('legacy Seller Share'));
const checkA13 = new Function('ctx', 'detail', 'fixture', segment);
const uuid = n => `${String(n).padStart(8,'0')}-0000-4000-8000-000000000000`;
function fixture() {
  const sellerId = uuid(1), escrowId = uuid(2);
  const counts = [1, 1, 2, 20], milestoneIds = [uuid(20),uuid(40),uuid(30),uuid(10)];
  const milestones = counts.map((count,index) => ({milestoneId:milestoneIds[index],escrowId,
    ordinal:index+1,title:index===0?'Legacy':`Milestone ${index}`,amountMinor:count*15,
    state:'PENDING',submittedAt:null,decidedAt:null,releasedAt:null}));
  const beneficiaryShares = milestones.flatMap((m,index)=>Array.from({length:counts[index]},(_,i)=>({
    beneficiaryShareId:uuid(100+index*20+i),milestoneId:m.milestoneId,ordinal:i+1,
    beneficiaryId:index===0?sellerId:uuid(300+index*20+i),amountMinor:15})));
  const totalMinor=milestones.reduce((sum,m)=>sum+m.amountMinor,0);
  return {sellerId, detail:{escrow:{escrowId,buyerId:uuid(3),sellerId,currency:'USD',totalMinor,
    availableMinor:totalMinor,releasedMinor:0,refundedMinor:0,state:'FUNDED',
    expiresAt:'2026-09-09T00:00:00.000Z',createdAt:'2026-09-08T00:00:00.000Z',terminalAt:null,sequence:1},
    milestones,dispute:null,releases:[],beneficiaryShares,beneficiaryPayouts:[],
    fundPosition:{totalMinor,availableMinor:totalMinor,releasedMinor:0,refundedMinor:0}}};
}
function verify(f) { const { escrow, ...rest } = f.detail; assertDetail({ ...escrow, ...rest }); checkA13({equal:assert.deepEqual},f.detail,f); }
test('unchanged ordered legal control passes',()=>verify(fixture()));
test('legal cross-milestone shuffle passes without changing cardinalities',()=>{
  const f=fixture();f.detail.beneficiaryShares.sort((a,b)=>a.milestoneId.localeCompare(b.milestoneId)||a.ordinal-b.ordinal);verify(f);
});
test('wrong cardinality is rejected even if the global count is unchanged',()=>{
  const f=fixture();f.detail.beneficiaryShares[3].milestoneId=f.detail.milestones[3].milestoneId;assert.throws(()=>verify(f));
});
test('wrong legacy beneficiary is rejected',()=>{
  const f=fixture();f.detail.beneficiaryShares[0].beneficiaryId=uuid(999);assert.throws(()=>verify(f),/legacy Seller Share/);
});
test('orphan Share is rejected',()=>{
  const f=fixture();f.detail.beneficiaryShares[0].milestoneId=uuid(999);assert.throws(()=>verify(f),/references a Milestone/);
});
test('missing Share is rejected',()=>{
  const f=fixture();f.detail.beneficiaryShares.shift();assert.throws(()=>verify(f));
});
test('crosslinked equal-cardinality allocations cannot hide behind sorted counts',()=>{
  const f=fixture();[f.detail.beneficiaryShares[0].milestoneId,f.detail.beneficiaryShares[1].milestoneId]=
    [f.detail.beneficiaryShares[1].milestoneId,f.detail.beneficiaryShares[0].milestoneId];
  assert.throws(()=>verify(f),/legacy Seller Share/);
});
test('Share conservation remains required',()=>{
  const f=fixture();f.detail.beneficiaryShares[4].amountMinor+=1;assert.throws(()=>verify(f),/conservation/);
});
test('Share ordinals remain contiguous',()=>{
  const f=fixture();f.detail.beneficiaryShares[4].ordinal=99;assert.throws(()=>verify(f),/ordinals contiguous/);
});
