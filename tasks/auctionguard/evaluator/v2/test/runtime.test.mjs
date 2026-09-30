import assert from "node:assert/strict";
import test from "node:test";

import { createCaseContext } from "../lib/runtime.mjs";

test("AuctionGuard context owns its domain fixtures and public route helpers", async () => {
  const context = await createCaseContext({
    caseId: "BID-01",
    workspace: new URL("../../../workspace", import.meta.url).pathname,
    evaluationSeed: "runtime-contract",
    baseTime: "2035-06-01T12:00:00.000Z",
    manageDatabase: false,
  });
  try {
    const bidder = context.bidder("runtime");
    const lot = context.lot("runtime");
    const auction = context.auction("runtime", lot.lotId);
    assert.equal(auction.lotId, lot.lotId);
    assert.match(bidder.bidderId, /^[0-9a-f-]{36}$/u);
    for (const method of ["createAuction", "openAuction", "placeBid", "cancelAuction", "getAuction", "getBids", "getEvents", "getTime", "getOpenApi", "withPage"]) {
      assert.equal(typeof context[method], "function", `${method} is not task-local`);
    }
  } finally {
    await context.teardown();
  }
});
