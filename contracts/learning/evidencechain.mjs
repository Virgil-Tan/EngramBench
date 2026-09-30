import {T,S,U,N,P,D,E,R,A,O,Q,uid,time,admin,page,query,pagination,post,get,define,manager,wire} from './helpers-c.mjs';
const schemas={
  Case:O({caseId:U,caseNumber:S}),
  CaseManifest:O({caseId:U,version:P,items:A(O({collectedItemId:U,expectedLabel:S,expectedSealCode:S,quantity:P}))}),
  Facility:O({facilityId:U,name:S,receivingCustodianId:U}),
  Custodian:O({custodianId:U,name:S}),
  DeviceRegistration:O({deviceId:U,facilityId:U,lastBatchSequence:N}),
  IntakeScan:O({intakeScanId:U,scanId:S,deviceId:U,batchSequence:P,label:S,sealCode:S,scannedAt:D,facilityId:U,state:E('UNMATCHED','MATCHED'),revision:N}),
  UnsplitCollectedItem:O({collectedItemId:U,caseId:U,expectedLabel:S,expectedSealCode:S,quantity:P,state:E('EXPECTED','RECEIVED','VERIFIED','QUARANTINED'),currentCustodianId:Q(U),intakeScanId:Q(U),revision:N,sequence:N}),
  CustodyMatch:O({matchId:U,collectedItemId:U,intakeScanId:U,state:E('PROPOSED','CONFIRMED','REVERSED'),createdAt:D,confirmedAt:Q(D),reversedAt:Q(D)}),
  CustodyTransfer:O({transferId:U,collectedItemId:U,fromCustodianId:U,toCustodianId:U,occurredAt:D,acceptedAt:D,priorTransferId:Q(U)}),
  AliquotTransfer:O({transferId:U,aliquotId:U,fromCustodianId:U,toCustodianId:U,occurredAt:D,acceptedAt:D,priorTransferId:Q(U)}),
  EvidenceTimelineItem:O({sequence:P,type:E('MATCH_CONFIRMED','MATCH_REVERSED','ITEM_VERIFIED','ITEM_QUARANTINED','CUSTODY_TRANSFERRED'),occurredAt:D,matchId:Q(U),transferId:Q(U),fromCustodianId:Q(U),toCustodianId:Q(U)}),
  Aliquot:O({aliquotId:U,parentItemId:U,quantity:P,sealCode:S,state:E('EXPECTED','RECEIVED','VERIFIED','QUARANTINED'),currentCustodianId:Q(U),intakeScanId:Q(U),revision:N}),
  ItemSplit:O({splitId:U,parentItemId:U,totalQuantity:P,aliquots:A(R('Aliquot'),{minItems:2,maxItems:20}),state:E('ACTIVE','REVERSED'),createdAt:D,reversedAt:Q(D)}),
  ItemSplitDetail:O({split:R('ItemSplit'),parent:R('CollectedItem'),parentTimeline:A(R('EvidenceTimelineItem')),aliquotTimelines:A(O({aliquotId:U,items:A(R('EvidenceTimelineItem'))}))}),
  CustodyMatchGroup:O({custodyMatchGroupId:U,splitId:Q(U),state:E('PROPOSED','CONFIRMED','REVERSED'),members:A({oneOf:[O({collectedItemId:U,aliquotId:{type:'null'},intakeScanId:U}),O({collectedItemId:{type:'null'},aliquotId:U,intakeScanId:U})]},{minItems:1,maxItems:20}),createdAt:D,confirmedAt:Q(D),reversedAt:Q(D),sequence:N})
};
schemas.SplitCollectedItem=O({...schemas.UnsplitCollectedItem.properties,state:{const:'CONSUMED_BY_SPLIT'},currentCustodianId:{type:'null'},intakeScanId:{type:'null'},aliquots:A(R('Aliquot'),{minItems:2,maxItems:20})});
schemas.CollectedItem={oneOf:[R('UnsplitCollectedItem'),R('SplitCollectedItem')]};
schemas.FinalCustodyTransfer={oneOf:[R('CustodyTransfer'),R('AliquotTransfer')]};
const resources={cases:'Case',caseManifests:'CaseManifest',facilities:'Facility',custodians:'Custodian',deviceRegistrations:'DeviceRegistration',intakeScans:'IntakeScan',collectedItems:'CollectedItem',custodyMatches:'CustodyMatch',custodyTransfers:'FinalCustodyTransfer',itemSplits:'ItemSplit',aliquots:'Aliquot',custodyMatchGroups:'CustodyMatchGroup'};
const seedValues={cases:[{caseId:uid(1),caseNumber:'PUBLIC-CASE'}],caseManifests:[{caseId:uid(1),version:1,items:[{collectedItemId:uid(2),expectedLabel:'PUBLIC-ITEM',expectedSealCode:'PUBLIC-SEAL',quantity:10}]}],custodians:[{custodianId:uid(3),name:'Public Custodian'}],facilities:[{facilityId:uid(4),name:'Public Receiving Facility',receivingCustodianId:uid(3)}],deviceRegistrations:[{deviceId:uid(5),facilityId:uid(4),lastBatchSequence:0}]};
const batchInput={deviceId:uid(5),batchSequence:1,scans:[{scanId:'public-scan-1',label:'PUBLIC-ITEM',sealCode:'PUBLIC-SEAL',scannedAt:time,facilityId:uid(4)}]};
const transferInput=O({fromCustodianId:U,toCustodianId:U,occurredAt:D});
const contract=define({taskId:'evidencechain',title:'EvidenceChain',schemas,resources,seedResources:{cases:'Case',caseManifests:'CaseManifest',facilities:'Facility',custodians:'Custodian',deviceRegistrations:'DeviceRegistration',intakeScans:'IntakeScan',custodyMatches:'CustodyMatch',transfers:'CustodyTransfer'},seedValues,importedAt:false,environmentVariables:['CHROMIUM_PATH','MANAGED_DATA_ROOT'],workKinds:['EVIDENCE_VERIFICATION'],eventTypes:['intake-batch.accepted','custody-match.confirmed','item.verified','item.quarantined','custody.transferred','custody-match.reversed'],eventPayload:O({}),
  operations:[
    get('list-custody-matches','/api/v1/custody-matches',page('CustodyMatch'),{query:{limit:50}},{parameters:pagination}),
    get('read-custody-match','/api/v1/custody-matches/:matchId','CustodyMatch',{params:{matchId:uid(7)}}),
    post('create-intake-batch','/api/v1/intake-batches',O({deviceId:U,batchSequence:P,scans:A(R('IntakeScan'),{minItems:1})}),O({deviceId:U,batchSequence:P,scans:A(O({scanId:S,label:S,sealCode:S,scannedAt:D,facilityId:U}),{minItems:1})}),{body:batchInput},{status:202}),
    post('create-custody-match','/api/v1/custody-matches','CustodyMatch',O({collectedItemId:U,intakeScanId:U}),{body:{collectedItemId:uid(2),intakeScanId:uid(6)}}),
    post('confirm-custody-match','/api/v1/custody-matches/:matchId/confirm','CustodyMatch',O({expectedItemRevision:N,expectedScanRevision:N}),{params:{matchId:uid(7)},body:{expectedItemRevision:0,expectedScanRevision:0}}),
    post('reverse-custody-match','/api/v1/custody-matches/:matchId/reverse','CustodyMatch',O({reason:S}),{params:{matchId:uid(7)},body:{reason:'Public reversal'}}),
    post('transfer-collected-item','/api/v1/collected-items/:itemId/transfers','CustodyTransfer',transferInput,{params:{itemId:uid(2)},body:{fromCustodianId:uid(3),toCustodianId:uid(8),occurredAt:time}}),
    get('read-item-timeline','/api/v1/collected-items/:itemId/timeline',O({item:R('CollectedItem'),items:A(R('EvidenceTimelineItem'))}),{params:{itemId:uid(2)}}),
    get('list-domain-events','/api/v1/domain-events',O({items:A(R('DomainEvent'))}),{query:{aggregateId:uid(2),afterSequence:0,limit:50}},{parameters:query({aggregateId:U,afterSequence:N,limit:{...P,maximum:100,default:50}},['aggregateId'])}),
    post('split-collected-item','/api/v1/collected-items/:itemId/splits','ItemSplit',O({expectedRevision:N,aliquots:A(O({aliquotId:U,quantity:P,sealCode:S}),{minItems:2,maxItems:20})}),{params:{itemId:uid(2)},body:{expectedRevision:2,aliquots:[{aliquotId:uid(9),quantity:4,sealCode:'PUBLIC-A'},{aliquotId:uid(10),quantity:6,sealCode:'PUBLIC-B'}]}},{source:manager}),
    post('reverse-item-split','/api/v1/item-splits/:splitId/reverse','ItemSplit',O({reason:S}),{params:{splitId:uid(11)},body:{reason:'Public split reversal'}},{source:manager}),
    get('read-item-split','/api/v1/item-splits/:splitId','ItemSplitDetail',{params:{splitId:uid(11)}},{source:manager}),
    post('create-custody-match-group','/api/v1/custody-match-groups','CustodyMatchGroup',O({splitId:U,members:A(O({aliquotId:U,intakeScanId:U}),{minItems:2,maxItems:20})}),{body:{splitId:uid(11),members:[{aliquotId:uid(9),intakeScanId:uid(12)},{aliquotId:uid(10),intakeScanId:uid(13)}]}},{source:manager,status:201}),
    get('read-custody-match-group','/api/v1/custody-match-groups/:custodyMatchGroupId','CustodyMatchGroup',{params:{custodyMatchGroupId:uid(14)}},{source:manager}),
    post('transfer-aliquot','/api/v1/aliquots/:aliquotId/transfers','AliquotTransfer',transferInput,{params:{aliquotId:uid(9)},body:{fromCustodianId:uid(3),toCustodianId:uid(8),occurredAt:time}},{source:wire})
  ],smoke:[
    {operationId:'read-item-timeline',params:{itemId:uid(2)},expectStatus:200,expectBody:{item:{collectedItemId:uid(2),caseId:uid(1),expectedLabel:'PUBLIC-ITEM',quantity:10,state:'EXPECTED',revision:0},items:[]}},
    {operationId:'create-intake-batch',body:batchInput,headers:{'Idempotency-Key':'smoke-intake-batch'},expectStatus:202,expectBody:{deviceId:uid(5),batchSequence:1},capture:{newIntakeScanId:['scans',0,'intakeScanId']}},
    {operationId:'verification-snapshot',headers:admin,expectStatus:200,expectContains:[{path:['resources','intakeScans'],match:{intakeScanId:'${newIntakeScanId}',scanId:'public-scan-1',label:'PUBLIC-ITEM',state:'UNMATCHED'}}]},
    {operationId:'create-custody-match',body:{collectedItemId:uid(2),intakeScanId:'${newIntakeScanId}'},headers:{'Idempotency-Key':'smoke-custody-match'},expectStatus:200,expectBody:{collectedItemId:uid(2),intakeScanId:'${newIntakeScanId}',state:'PROPOSED'},capture:{newMatchId:['matchId']}},
    {operationId:'read-custody-match',params:{matchId:'${newMatchId}'},expectStatus:200,expectBody:{matchId:'${newMatchId}',collectedItemId:uid(2),intakeScanId:'${newIntakeScanId}',state:'PROPOSED'}}
  ],notes:[
    'V2 wire clarification: intake batch success is {deviceId,batchSequence,scans:[IntakeScan]}, preserving submitted order and server stable IDs. CustodyMatch create/confirm/reverse return the exact changed CustodyMatch. CaseManifest import derives EXPECTED CollectedItems at revision/sequence 0 with both singular custody fields null; this is checked by a seeded timeline read.',
    'V2 wire clarification: split parent responses include aliquots:[Aliquot] exactly while CONSUMED_BY_SPLIT and have null currentCustodianId/intakeScanId; unsplit legacy response shapes remain exact. ItemSplit reverse returns ItemSplit. Conservation, duplicate aliquot IDs, whole-split membership and expected revision checks remain atomic business validation.',
    'The Manager requires independently transferable Aliquots but gives no transfer route. V2 publishes POST /api/v1/aliquots/:aliquotId/transfers with the existing custody compare-and-set body and AliquotTransfer response. FINAL custodyTransfers includes disjoint CollectedItem and Aliquot transfer shapes. This makes the transferred-child reversal rule externally exercisable without overloading a CollectedItem identifier.',
    'V2 wire clarification: an Aliquot timeline uses existing transition types; MATCH entries identify the corresponding CustodyMatchGroup in matchId. No new Manager DomainEvent types are invented. Timeline nullability and sequence must follow the published type-specific rules. Domain-event reads return {items:[DomainEvent]} with required aggregateId and default afterSequence=0.'
  ]});
contract.smoke[2].expectContains.push({path:['resources','collectedItems'],match:{collectedItemId:uid(2),caseId:uid(1),expectedLabel:'PUBLIC-ITEM',expectedSealCode:'PUBLIC-SEAL',quantity:10,state:'EXPECTED',currentCustodianId:null,intakeScanId:null,revision:0,sequence:0}});
export default contract;
