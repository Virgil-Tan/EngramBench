import { ref, obj, arr, one, nil, str, text, count, positive, range, uuid, time, currency, en, page, op, paging, manager, T, FUTURE, id, auth, key, admin, environmentVariables, commands, commonSchemas, snapshot, seedSchema, infra, observe, basicSmoke, seedSmoke, commonNotes } from './helpers-a2.mjs';

const schemas = {
  ...commonSchemas(['AUCTION_CLOSE'], ['auction.opened', 'bid.accepted', 'auction.extended', 'auction.closed', 'auction.cancelled']),
  Bidder: obj({ bidderId: uuid, displayName: text }),
  Lot: obj({ lotId: uuid, title: text, description: str }),
  Auction: obj({ auctionId: uuid, lotId: uuid, currency, reservePriceMinor: positive, minimumIncrementMinor: positive, startAt: time, effectiveEndAt: time, state: en('SCHEDULED', 'OPEN', 'CLOSING', 'CLOSED', 'CANCELLED'), leadingBidId: nil(uuid), winnerId: nil(uuid), winningAmountMinor: nil(positive), sequence: count }),
  Bid: obj({ bidId: uuid, auctionId: uuid, bidderId: uuid, amountMinor: positive, committedSequence: positive, state: en('ACCEPTED', 'OUTBID', 'WINNING'), acceptedAt: time, effectiveEndAtAfter: time }),
  AuctionOutcome: obj({ auctionId: uuid, result: en('WINNER', 'NO_SALE'), winnerId: nil(uuid), winningBidId: nil(uuid), winningAmountMinor: nil(positive), closedAt: time }),
  Award: obj({ awardId: uuid, auctionId: uuid, bidId: uuid, bidderId: uuid, allocatedQuantity: range(1, 20), clearingUnitPriceMinor: positive, totalAmountMinor: positive, allocationRank: positive, createdAt: time }),
  MultiUnitAuctionOutcome: obj({ auctionId: uuid, result: en('WINNER', 'NO_SALE'), unitCount: range(2, 100), allocatedUnitCount: range(0, 100), unallocatedUnitCount: range(0, 100), clearingUnitPriceMinor: nil(positive), awards: arr(ref('Award')), closedAt: time }),
};
schemas.MultiUnitBid = obj({ ...schemas.Bid.properties, quantity: range(1, 20) });
schemas.AuctionDetail = obj({ ...schemas.Auction.properties, unitCount: range(1, 100), awards: arr(ref('Award')), outcome: nil(one(ref('AuctionOutcome'), ref('MultiUnitAuctionOutcome'))) });
schemas.BidAcceptance = one(obj({ ...schemas.Bid.properties, effectiveEndAt: time }), obj({ ...schemas.MultiUnitBid.properties, effectiveEndAt: time }));
schemas.AuctionWriteResponse = one(ref('Auction'), obj({ ...schemas.AuctionDetail.properties, unitCount: range(2, 100) }));
schemas.SeedAuction = obj({ ...schemas.Auction.properties, antiSnipingWindowSeconds: { const: 120 } });
schemas.Seed = seedSchema({ bidders: 'Bidder', lots: 'Lot', auctions: 'SeedAuction', bids: 'Bid' });
schemas.VerificationSnapshot = snapshot({ bidders: 'Bidder', lots: 'Lot', auctions: 'Auction', bids: 'Bid', auctionOutcomes: 'AuctionOutcome', awards: 'Award' });
const auctionId = id(21), lotId = id(22), bidderId = id(23), freeLotId = id(24);
const startAt = FUTURE, endAt = '2099-01-02T00:00:00.000Z';
const createBody = { lotId: freeLotId, currency: 'USD', reservePriceMinor: 100, minimumIncrementMinor: 10, startAt, endAt };
const createProperties = { lotId: uuid, currency, reservePriceMinor: positive, minimumIncrementMinor: positive, startAt: time, endAt: time, unitCount: range(2, 100) };
const exampleAuction = { auctionId, lotId, currency: 'USD', reservePriceMinor: 100, minimumIncrementMinor: 10, startAt, effectiveEndAt: endAt, state: 'SCHEDULED', leadingBidId: null, winnerId: null, winningAmountMinor: null, sequence: 0, antiSnipingWindowSeconds: 120 };
export default {
  taskId: 'auctionguard', title: 'AuctionGuard', environmentVariables, commands,
  seed: { schema: schemas.Seed, example: { schemaVersion: 1, seedVersion: 'v2-public-auctionguard-1', bidders: [{ bidderId, displayName: 'Public Bidder' }], lots: [{ lotId, title: 'Public Seed Lot', description: 'Independent public seed' }, { lotId: freeLotId, title: 'Public Write Lot', description: 'Available for a separate auction' }], auctions: [exampleAuction], bids: [] } }, schemas,
  operations: [
    ...infra(),
    op('list-auctions', 'GET', '/api/v1/auctions', 200, page(ref('Auction')), undefined, { query: { limit: 20 } }, { parameters: paging }),
    op('read-auction', 'GET', '/api/v1/auctions/:auctionId', 200, ref('AuctionDetail'), undefined, { params: { auctionId } }, { source: manager }),
    op('create-auction', 'POST', '/api/v1/admin/auctions', 201, ref('AuctionWriteResponse'), obj(createProperties, Object.keys(createProperties).filter((k) => k !== 'unitCount')), { body: createBody, headers: auth }, { source: manager, parameters: admin }),
    op('create-bid', 'POST', '/api/v1/auctions/:auctionId/bids', 201, ref('BidAcceptance'), obj({ bidderId: uuid, amountMinor: positive, quantity: range(1, 20) }, ['bidderId', 'amountMinor']), { params: { auctionId }, body: { bidderId, amountMinor: 100, quantity: 1 } }, { source: manager }),
    op('cancel-auction', 'POST', '/api/v1/auctions/:auctionId/cancel', 200, ref('AuctionWriteResponse'), obj({ reason: text }), { params: { auctionId }, body: { reason: 'Withdraw unsold lot' } }),
    op('open-auction', 'POST', '/api/v1/admin/auctions/:auctionId/open', 200, ref('AuctionWriteResponse'), obj({}), { params: { auctionId }, body: {}, headers: auth }, { parameters: admin }),
    op('list-bids', 'GET', '/api/v1/auctions/:auctionId/bids', 200, page(one(ref('Bid'), ref('MultiUnitBid'))), undefined, { params: { auctionId }, query: { limit: 20 } }, { parameters: paging }),
    op('server-time', 'GET', '/api/v1/time', 200, obj({ now: time })),
    ...observe(),
  ],
  smoke: [
    ...basicSmoke,
    seedSmoke({ bidders: [{ bidderId }], lots: [{ lotId }, { lotId: freeLotId }], auctions: [{ auctionId, lotId, state: 'SCHEDULED', leadingBidId: null }] }),
    { operationId: 'read-auction', params: { auctionId }, expectStatus: 200, expectBody: { auctionId, unitCount: 1, awards: [], outcome: null } },
    { operationId: 'create-auction', body: createBody, headers: { ...auth, ...key('create-auction') }, expectStatus: 201, expectBody: { lotId: freeLotId, state: 'SCHEDULED' }, capture: { createdAuction: ['auctionId'] } },
    { operationId: 'read-auction', params: { auctionId: '${createdAuction}' }, expectStatus: 200, expectBody: { auctionId: '${createdAuction}', lotId: freeLotId, reservePriceMinor: 100, minimumIncrementMinor: 10, state: 'SCHEDULED', unitCount: 1, awards: [], outcome: null } },
  ],
  notes: [...commonNotes,
    'V2 wire clarification: the bid-create phrase "Bid and effectiveEndAt" is the exact Bid (or MultiUnitBid) fields plus top-level effectiveEndAt, equal to effectiveEndAtAfter; it is not {bid,effectiveEndAt}. A fresh legacy one-unit request returns the original Bid fields; a multi-unit bid also returns quantity. Persisted legacy replay bodies remain unchanged.',
    'V2 wire clarification: create/open/cancel return Auction for one-unit auctions and AuctionDetail for multi-unit auctions. GET detail always returns AuctionDetail. GET auction collection retains the original Auction projection, while bid history returns the applicable Bid or MultiUnitBid shape.',
    'The Manager FINAL snapshot literally specifies Auction, Bid and AuctionOutcome plus awards. Those three legacy projection shapes are retained exactly here; multi-unit quantity/outcome are available from bid history and AuctionDetail, and immutable allocations are in resources.awards. This clarifies an otherwise ambiguous distinction between final detail and snapshot projections.',
    'Stateful admission enforces quantity presence for multi-unit auctions and quantity 1 for one-unit auctions; JSON Schema alone cannot know the referenced auction. Product overflow, deadline, increment and winner checks remain required. Explicit unitCount:1 is invalid; omit unitCount for legacy creation.',
    'The seed is a nonempty scheduled Auction/Lot/Bidder graph with no accepted bids and a second unused Lot for independent creation. Fixed future deadlines prevent the smoke relying on a seeded OPEN auction surviving the wall clock. There is no unpublished Lot or Bidder creation route.',
  ],
};
