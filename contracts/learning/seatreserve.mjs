import {T,S,U,N,P,B,D,C,E,R,A,O,Q,uid,time,admin,page,query,pagination,post,get,define,manager} from './helpers-c.mjs';
const schemas={
  Venue:O({venueId:U,tenantId:U,name:S}),
  Event:O({eventId:U,tenantId:U,venueId:U,name:S,startsAt:D,state:E('DRAFT','ON_SALE','SALES_CLOSED','CANCELLED'),createdAt:D}),
  Zone:O({zoneId:U,eventId:U,name:S}),
  Seat:O({seatId:U,eventId:U,zoneId:U,row:S,number:P,accessible:B,createdAt:D}),
  PriceVersion:O({priceVersionId:U,zoneId:U,version:P,state:E('DRAFT','ACTIVE','SUPERSEDED'),unitAmountMinor:N,feeMinor:N,currency:C,effectiveFrom:D,effectiveTo:Q(D),createdAt:D}),
  SeatHold:O({holdId:U,tenantId:U,eventId:U,customerRef:S,state:E('HELD','CHECKOUT','CONVERTED','EXPIRED','CANCELLED'),expiresAt:D,paymentGraceExpiresAt:Q(D),totalMinor:N,currency:C,createdAt:D,terminalAt:Q(D),sequence:N}),
  HoldSeat:O({holdId:U,seatId:U,priceVersionId:U,unitAmountMinor:N,feeMinor:N}),
  Order:O({orderId:U,holdId:U,tenantId:U,eventId:U,customerRef:S,state:E('PENDING_PAYMENT','PAYMENT_UNKNOWN','CONFIRMED','CANCELLED'),totalMinor:N,currency:C,paymentIntentId:U,createdAt:D,confirmedAt:Q(D),sequence:N}),
  OrderSeat:O({orderId:U,seatId:U,priceVersionId:U,unitAmountMinor:N,feeMinor:N}),
  PaymentIntent:O({paymentIntentId:U,orderId:U,amountMinor:N,currency:C,state:E('CREATED','PROCESSING','SUCCEEDED','FAILED','UNKNOWN'),providerRequestId:S,providerTransactionId:Q(S),createdAt:D,resolvedAt:Q(D),sequence:N}),
  ProviderReceipt:O({providerReceiptId:U,providerEventId:S,providerRequestId:S,outcome:E('SUCCEEDED','FAILED'),providerTransactionId:Q(S),occurredAt:D,receivedAt:D}),
  SeatAvailability:O({seat:R('Seat'),available:B,priceVersionId:Q(U),unitAmountMinor:Q(N),feeMinor:Q(N),currency:Q(C)}),
  WaitlistEntry:O({waitlistEntryId:U,tenantId:U,eventId:U,customerRef:S,seatCount:{...P,maximum:8},allowedZoneIds:A(U,{minItems:1,uniqueItems:true}),maxUnitTotalMinor:N,expiresAt:D,state:E('WAITING','OFFERED','FULFILLED','DECLINED','CANCELLED','EXPIRED'),createdAt:D,cancelledAt:Q(D)}),
  SeatOffer:O({seatOfferId:U,waitlistEntryId:U,eventId:U,state:E('ACTIVE','ACCEPTED','DECLINED','EXPIRED'),items:A(O({seatId:U,priceVersionId:U,unitAmountMinor:N,feeMinor:N}),{minItems:1,maxItems:8}),totalMinor:N,currency:C,expiresAt:D,createdAt:D,holdId:Q(U),terminalAt:Q(D)})
};
const base={tenants:'Tenant',venues:'Venue',events:'Event',zones:'Zone',seats:'Seat',priceVersions:'PriceVersion',holds:'SeatHold',holdSeats:'HoldSeat',orders:'Order',orderSeats:'OrderSeat',paymentIntents:'PaymentIntent',providerReceipts:'ProviderReceipt'};
const tenant={tenantId:uid(1),name:'Public Ticket Tenant'};
const venue={venueId:uid(2),tenantId:uid(1),name:'Public Hall'};
const event={eventId:uid(3),tenantId:uid(1),venueId:uid(2),name:'Public Concert',startsAt:'2035-01-01T18:00:00.000Z',state:'ON_SALE',createdAt:time};
const zone={zoneId:uid(4),eventId:uid(3),name:'Main Floor'};
const seat={seatId:uid(5),eventId:uid(3),zoneId:uid(4),row:'A',number:1,accessible:false,createdAt:time};
const price={priceVersionId:uid(6),zoneId:uid(4),version:1,state:'ACTIVE',unitAmountMinor:2000,feeMinor:100,currency:'USD',effectiveFrom:time,effectiveTo:null,createdAt:time};
const holdInput={tenantId:uid(1),eventId:uid(3),customerRef:'public-customer',seatIds:[uid(5)],ttlSeconds:300};
export default define({taskId:'seatreserve',title:'SeatReserve',schemas,resources:{...base,waitlistEntries:'WaitlistEntry',seatOffers:'SeatOffer'},seedResources:base,seedValues:{tenants:[tenant],venues:[venue],events:[event],zones:[zone],seats:[seat],priceVersions:[price]},environmentVariables:['PROVIDER_BASE_URL'],workKinds:['HOLD_EXPIRY','PAYMENT_CAPTURE','PAYMENT_RECONCILE','WAITLIST_MATCH','OFFER_EXPIRY'],eventTypes:['hold.created','hold.expired','hold.cancelled','checkout.started','payment.unknown','order.confirmed','order.cancelled'],
  operations:[
    post('create-tenant','/api/v1/tenants','Tenant',O({name:S}),{body:{name:'Another Ticket Tenant'}}),
    post('create-venue','/api/v1/venues','Venue',O({tenantId:U,name:S}),{body:{tenantId:uid(1),name:'Second Hall'}}),
    post('create-event','/api/v1/events','Event',O({tenantId:U,venueId:U,name:S,startsAt:D}),{body:{tenantId:uid(1),venueId:uid(2),name:'Future Concert',startsAt:'2035-02-01T18:00:00.000Z'}}),
    post('create-zone','/api/v1/events/:eventId/zones','Zone',O({name:S}),{params:{eventId:uid(3)},body:{name:'Balcony'}}),
    post('create-seat','/api/v1/events/:eventId/seats','Seat',O({zoneId:U,row:S,number:P,accessible:B}),{params:{eventId:uid(3)},body:{zoneId:uid(4),row:'A',number:2,accessible:false}}),
    post('create-price-version','/api/v1/zones/:zoneId/price-versions','PriceVersion',O({unitAmountMinor:N,feeMinor:N,currency:C,effectiveFrom:D,effectiveTo:Q(D)}),{params:{zoneId:uid(4)},body:{unitAmountMinor:2500,feeMinor:100,currency:'USD',effectiveFrom:'2030-01-01T00:00:00.000Z',effectiveTo:null}}),
    post('activate-price-version','/api/v1/price-versions/:priceVersionId/activate','PriceVersion',O({expectedActivePriceVersionId:Q(U)}),{params:{priceVersionId:uid(7)},body:{expectedActivePriceVersionId:uid(6)}}),
    post('open-event-sales','/api/v1/events/:eventId/on-sale','Event',O({}),{params:{eventId:uid(3)},body:{}}),
    get('read-availability','/api/v1/events/:eventId/availability',page('SeatAvailability'),{params:{eventId:uid(3)},query:{zoneId:uid(4),limit:50}},{parameters:[...query({zoneId:U}),...pagination]}),
    post('create-hold','/api/v1/holds','SeatHold',O({tenantId:U,eventId:U,customerRef:S,seatIds:A(U,{minItems:1,maxItems:12,uniqueItems:true}),ttlSeconds:{...P,minimum:30,maximum:900}}),{body:holdInput}),
    get('read-hold','/api/v1/holds/:holdId','SeatHold',{params:{holdId:uid(8)}}),
    post('cancel-hold','/api/v1/holds/:holdId/cancel','SeatHold',O({}),{params:{holdId:uid(8)},body:{}}),
    post('checkout-hold','/api/v1/holds/:holdId/checkout','Order',O({providerScenario:E('SUCCEEDED','FAILED','TIMEOUT','CONNECTION_RESET')}),{params:{holdId:uid(8)},body:{providerScenario:'SUCCEEDED'}}),
    get('read-order','/api/v1/orders/:orderId','Order',{params:{orderId:uid(9)}}),
    post('reconcile-payment','/api/v1/payment-intents/:paymentIntentId/reconcile','PaymentIntent',O({}),{params:{paymentIntentId:uid(10)},body:{}}),
    post('provider-receipt','/api/v1/provider/receipts','ProviderReceipt',O({providerEventId:S,providerRequestId:S,outcome:E('SUCCEEDED','FAILED'),providerTransactionId:Q(S),occurredAt:D}),{body:{providerEventId:'public-payment-event',providerRequestId:'public-payment-request',outcome:'SUCCEEDED',providerTransactionId:'public-transaction',occurredAt:time}}),
    post('create-waitlist-entry','/api/v1/waitlist-entries','WaitlistEntry',O({tenantId:U,eventId:U,customerRef:S,seatCount:{...P,maximum:8},allowedZoneIds:A(U,{minItems:1,uniqueItems:true}),maxUnitTotalMinor:N,expiresAt:D}),{body:{tenantId:uid(1),eventId:uid(3),customerRef:'public-waitlist-customer',seatCount:1,allowedZoneIds:[uid(4)],maxUnitTotalMinor:3000,expiresAt:'2026-09-08T00:00:00.000Z'}},{source:manager,status:201}),
    post('cancel-waitlist-entry','/api/v1/waitlist-entries/:entryId/cancel','WaitlistEntry',O({}),{params:{entryId:uid(11)},body:{}},{source:manager}),
    get('read-seat-offer','/api/v1/seat-offers/:offerId','SeatOffer',{params:{offerId:uid(12)}},{source:manager}),
    post('accept-seat-offer','/api/v1/seat-offers/:offerId/accept',O({offer:R('SeatOffer'),hold:R('SeatHold')}),O({}),{params:{offerId:uid(12)},body:{}},{source:manager,status:201}),
    post('decline-seat-offer','/api/v1/seat-offers/:offerId/decline','SeatOffer',O({}),{params:{offerId:uid(12)},body:{}},{source:manager})
  ],smoke:[
    {operationId:'read-availability',params:{eventId:uid(3)},query:{zoneId:uid(4)},expectStatus:200,expectContains:[{path:['items'],match:{seat,available:true,priceVersionId:uid(6),unitAmountMinor:2000,feeMinor:100,currency:'USD'}}]},
    {operationId:'create-hold',body:holdInput,headers:{'Idempotency-Key':'smoke-create-hold'},expectStatus:200,expectBody:{tenantId:uid(1),eventId:uid(3),state:'HELD',totalMinor:2100,currency:'USD'},capture:{newHoldId:['holdId']}},
    {operationId:'read-hold',params:{holdId:'${newHoldId}'},expectStatus:200,expectBody:{holdId:'${newHoldId}',customerRef:'public-customer',state:'HELD',totalMinor:2100}},
    {operationId:'read-availability',params:{eventId:uid(3)},query:{zoneId:uid(4)},expectStatus:200,expectContains:[{path:['items'],match:{seat:{seatId:uid(5)},available:false}}]},
    {operationId:'verification-snapshot',headers:admin,expectStatus:200,expectContains:[{path:['resources','holdSeats'],match:{holdId:'${newHoldId}',seatId:uid(5),priceVersionId:uid(6),unitAmountMinor:2000,feeMinor:100}}]}
  ],notes:[
    'V2 wire clarification: Venue, Event and Zone fields are explicit in these schemas. Seat creation creates one Seat; layout mutation remains DRAFT-only. Price activation takes expectedActivePriceVersionId, nullable only before first activation. Hold cancellation takes {}, checkout returns the newly created Order immediately, and only the Worker calls the published Provider double.',
    'V2 wire clarification: availability items contain the full Seat plus available and current price fields; price fields are null if no applicable active price exists. Hold and Order reads retain the exact named primary resource, while seat ownership edges are visible in the snapshot. SEAT_UNAVAILABLE error.details is {seatIds:[uuid]} sorted ascending.',
    'Waitlist examples with absolute expiry show wire shape; callers choose database-relative future dates within 30 days. All Manager seatCount, adjacency, frozen price, all-or-nothing ownership, 120-second Offer and 300-second accepted Hold rules remain exact. Existing provider protocol and Work.aggregateId assignments remain unchanged.'
  ]});
