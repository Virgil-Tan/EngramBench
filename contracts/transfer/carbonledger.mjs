import {T,S,U,I,N,P,D,H,E,R,A,O,Q,uid,digest,admin,page,query,pagination,post,get,define,manager} from '../learning/helpers-c.mjs';

// Public-only derivation: immutable V1 seed and the published cross-lot increment.
const eligibility=O({projectId:U,vintageFrom:I,vintageTo:I,methodology:T},[]);
const allocation=O({creditLotId:U,quantityGrams:P});
const legacyRetirement=O({retirementId:U,beneficiaryId:U,quantityGrams:P,state:E('RESERVED','CERTIFYING','RETIRED','RELEASED','EXPIRED','FAILED'),allocation:Q(allocation),expiresAt:D,certificateDigest:Q(H),createdAt:D,terminalAt:Q(D),sequence:N});
const allocationFields={ordinal:P,creditLotId:U,quantityGrams:P,projectId:U,vintage:I,methodology:T,provenanceDigest:H};
const certificate=O({certificateVersion:{const:1},retirementId:U,beneficiaryId:U,quantityGrams:P,creditLotId:U,projectId:U,vintage:I,methodology:T,provenanceDigest:H,retiredAt:D});
const resources={projects:'CarbonProject',beneficiaries:'Beneficiary',creditLots:'CreditLot',retirements:'Retirement',certificates:'Certificate',lotAllocations:'LotAllocation',splitCertificates:'SplitCertificate'};
const project={projectId:uid(1),name:'Public project'};
const beneficiary={beneficiaryId:uid(2),name:'Public beneficiary'};
const lot={creditLotId:uid(3),projectId:uid(1),vintage:2025,methodology:'public-method',priority:1,issuedGrams:1000,availableGrams:1000,reservedGrams:0,retiredGrams:0,provenanceDigest:digest};
const body={beneficiaryId:uid(2),quantityGrams:10,eligibility:{projectId:uid(1),vintageFrom:2025,vintageTo:2025,methodology:'public-method'}};
const contract=define({taskId:'carbonledger',title:'CarbonLedger',resources,seedResources:{projects:'CarbonProject',beneficiaries:'Beneficiary',creditLots:'CreditLot',retirements:'LegacyRetirement',certificates:'Certificate'},importedAt:false,seedValues:{projects:[project],beneficiaries:[beneficiary],creditLots:[lot]},workKinds:['CERTIFICATE_GENERATION','RETIREMENT_EXPIRY'],eventTypes:['retirement.reserved','retirement.released','retirement.expired','retirement.completed','certificate.published'],eventPayload:O({}),environmentVariables:['CHROMIUM_PATH','MANAGED_DATA_ROOT'],schemas:{
  Error:O({error:O({code:S,message:T,details:O({})})}),
  CarbonProject:O({projectId:U,name:T}),Beneficiary:O({beneficiaryId:U,name:T}),
  CreditLot:O({creditLotId:U,projectId:U,vintage:I,methodology:T,priority:I,issuedGrams:P,availableGrams:N,reservedGrams:N,retiredGrams:N,provenanceDigest:H}),
  LegacyRetirement:legacyRetirement,Retirement:O({...legacyRetirement.properties,allocations:A(R('LotAllocation'),{minItems:1,maxItems:20})}),RetirementReply:{oneOf:[R('LegacyRetirement'),R('Retirement')]},
  LotAllocation:O({lotAllocationId:U,retirementId:U,...allocationFields}),Certificate:certificate,
  SplitCertificate:O({certificateVersion:{const:2},retirementId:U,beneficiaryId:U,totalQuantityGrams:P,allocations:A(O(allocationFields),{minItems:2,maxItems:20}),retiredAt:D}),
  CertificatePending:O({retirementId:U,state:E('RESERVED','CERTIFYING')}),
},operations:[
  get('list-retirements','/api/v1/retirements',page('Retirement'),{query:{limit:50}},{parameters:pagination}),
  get('get-retirement','/api/v1/retirements/:retirementId','Retirement',{params:{retirementId:uid(10)}},{source:manager}),
  post('create-retirement','/api/v1/retirements','RetirementReply',O({beneficiaryId:U,quantityGrams:P,eligibility}),{body},{status:202,source:manager}),
  post('release-retirement','/api/v1/retirements/:retirementId/release','RetirementReply',O({reason:T}),{params:{retirementId:uid(10)},body:{reason:'Public release'}},{source:manager}),
  get('get-certificate','/api/v1/retirements/:retirementId/certificate',{oneOf:[R('Certificate'),R('SplitCertificate')]},{params:{retirementId:uid(10)}},{source:manager,successStatuses:[200,202],successResponses:{202:{response:R('CertificatePending')}},responseHeaders:{ETag:{...T,description:'For status 200, the SHA-256 certificateDigest of the exact RFC 8785 JSON bytes.'}}}),
  get('list-credit-lots','/api/v1/credit-lots',page('CreditLot'),{query:{projectId:uid(1),vintage:2025,methodology:'public-method',limit:50}},{parameters:[...query({projectId:U,vintage:I,methodology:T}),...pagination]}),
  get('get-credit-lot','/api/v1/credit-lots/:creditLotId','CreditLot',{params:{creditLotId:uid(3)}}),
  get('retirement-allocations','/api/v1/retirements/:retirementId/allocations',O({items:A(R('LotAllocation'),{minItems:1,maxItems:20})}),{params:{retirementId:uid(10)}},{source:manager}),
  get('domain-events','/api/v1/domain-events',page('DomainEvent'),{query:{aggregateId:uid(10),afterSequence:0,limit:50}},{parameters:query({aggregateId:U,afterSequence:N,limit:{...P,maximum:100,default:50}})}),
],smoke:[
  {operationId:'create-retirement',body,headers:{'Idempotency-Key':'public-carbon-create'},expectStatus:202,capture:{retirementId:['retirementId']}},
  {operationId:'get-retirement',params:{retirementId:'${retirementId}'},expectStatus:200,capture:{allocationId:['allocations',0,'lotAllocationId']},expectBody:{retirementId:'${retirementId}',beneficiaryId:uid(2),quantityGrams:10},expectContains:[{path:['allocations'],match:{retirementId:'${retirementId}',creditLotId:uid(3),quantityGrams:10,ordinal:1}}]},
  {operationId:'retirement-allocations',params:{retirementId:'${retirementId}'},expectStatus:200,expectContains:[{path:['items'],match:{lotAllocationId:'${allocationId}',retirementId:'${retirementId}',creditLotId:uid(3),quantityGrams:10,ordinal:1}}]},
  {operationId:'verification-snapshot',headers:admin,expectStatus:200,expectContains:[{path:['resources','retirements'],match:{retirementId:'${retirementId}',quantityGrams:10}},{path:['resources','lotAllocations'],match:{lotAllocationId:'${allocationId}',retirementId:'${retirementId}',quantityGrams:10}}]},
],notes:[
  'V2 compatibility clarification: new and current Retirement resources expose ordered allocations, while the mutation reply union preserves exact saved V1 idempotency JSON. Seed keeps the exact V1 Retirement and Certificate v1 shapes, with no importedAt or Manager-only members. Migration creates one LotAllocation for each legacy Retirement without rewriting historical Certificate bytes or events.',
  'The certificate operation has status 202 with the exact pending envelope while RESERVED or CERTIFYING, status 200 with Certificate v1 or SplitCertificate v2 after RETIRED, and the published 409 otherwise. A successful certificate body is application/json encoded as exact UTF-8 RFC 8785 bytes; ETag is the published digest, not a newly introduced payload field. No certificate wrapper or extra singular lot field is added.',
  'Retirement collection order is retirementId; CreditLot collection order is the exact published priority-descending/projectId/vintage/creditLotId tuple. Allocation detail has {items} only, no nextCursor or query parameters. Domain-event afterSequence defaults to zero; nextCursor is null and continuation uses aggregateId plus the last returned sequence. Without aggregateId, use snapshot event order.',
  'Eligibility bounds, ordered single-lot preference, greedy 2..20 lot fallback, exact conserved integer grams, immutable provenance, release/certification races and canonical-byte digest correctness remain business implementation obligations. The smoke identifies committed allocation records but does not certify worker completion or conservation under concurrency.',
  'Stable errors remain CREDIT_UNAVAILABLE, RETIREMENT_EXPIRED, RETIREMENT_NOT_RELEASABLE, CERTIFICATE_NOT_READY, CROSS_LOT_LIMIT_EXCEEDED, SPLIT_RETIREMENT_NOT_RELEASABLE (409), INVALID_ELIGIBILITY_FILTER (400), plus the common published transport/resource/idempotency errors. No new Manager event type or payload field is introduced. Snapshot sorting remains retirementId/ordinal for allocations and each exact published resource identity tuple.',
]});
contract.httpHost='127.0.0.1';contract.transportErrors={auth:{status:401,code:'ADMIN_AUTH_REQUIRED'},unknownField:{status:400,code:'UNKNOWN_FIELD'}};
contract.seed.command=['npm','run','db:seed','--','--file','${SEED_PATH}'];contract.seed.replay=true;
for(const operation of contract.operations){
  operation.errors=Object.fromEntries([400,401,404,409,415].map(code=>[code,R('Error')]));
  if(operation.id==='create-retirement')operation.bodyTransportErrors=[{path:'/quantityGrams',when:'number',status:400,code:'INVALID_ELIGIBILITY_FILTER'},{path:'/eligibility',status:400,code:'INVALID_ELIGIBILITY_FILTER'}];
}
export default contract;
