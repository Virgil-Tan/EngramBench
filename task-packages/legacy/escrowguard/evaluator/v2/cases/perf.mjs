import { createWriteStream } from "node:fs";
import { once } from "node:events";

export const PERF_COUNTS = Object.freeze({ parties: 10_000, escrows: 20_000, milestones: 60_000, releases: 10_000, due: 5_000, activeReadTargets: 10_000 });

async function writeArray(stream, count, factory, chunkSize = 1_000) {
  const write = async (text) => { if (!stream.write(text)) await once(stream, "drain"); };
  await write("[");
  for (let start = 0; start < count; start += chunkSize) {
    const values = [];
    for (let index = start; index < Math.min(start + chunkSize, count); index += 1) values.push(factory(index));
    await write(`${start === 0 ? "" : ","}${values.map(JSON.stringify).join(",")}`);
  }
  await write("]");
}

function escrowShape(ctx, parties, index) {
  const escrowId = ctx.uuid(`perf-escrow-${index}`); const buyerId = parties[(index * 2) % parties.length].partyId; const sellerId = parties[(index * 2 + 1) % parties.length].partyId;
  const active = index < PERF_COUNTS.activeReadTargets; const due = index >= PERF_COUNTS.activeReadTargets && index < PERF_COUNTS.activeReadTargets + PERF_COUNTS.due;
  const state = active ? "ACTIVE" : due ? "FUNDED" : "REFUNDED";
  return { escrowId, buyerId, sellerId, currency: "USD", totalMinor: 100, availableMinor: active ? 70 : due ? 100 : 0, releasedMinor: active ? 30 : 0, refundedMinor: active || due ? 0 : 100, state, expiresAt: active ? ctx.at({ days: 1 }) : ctx.at({ hours: -1 }), createdAt: ctx.at({ days: -2 }), terminalAt: state === "REFUNDED" ? ctx.at({ minutes: -30 }) : null, sequence: active ? 3 : state === "REFUNDED" ? 2 : 1 };
}

function milestoneShape(ctx, escrow, escrowIndex, ordinal) {
  const amounts = [30, 30, 40]; const active = escrowIndex < PERF_COUNTS.activeReadTargets; const due = escrowIndex >= PERF_COUNTS.activeReadTargets && escrowIndex < PERF_COUNTS.activeReadTargets + PERF_COUNTS.due; const state = active ? (ordinal === 1 ? "RELEASED" : "PENDING") : due ? "PENDING" : "REFUNDED";
  return { milestoneId: ctx.uuid(`perf-milestone-${escrowIndex}-${ordinal}`), escrowId: escrow.escrowId, ordinal, title: `Performance Milestone ${ordinal}`, amountMinor: amounts[ordinal - 1], state, submittedAt: state === "RELEASED" ? ctx.at({ days: -1, minutes: ordinal }) : null, decidedAt: ["RELEASED", "REFUNDED"].includes(state) ? ctx.at({ hours: -12, minutes: ordinal }) : null, releasedAt: state === "RELEASED" ? ctx.at({ hours: -12, minutes: ordinal }) : null };
}

export async function writePerformanceSeed(ctx) {
  const parties = Array.from({ length: PERF_COUNTS.parties }, (_, index) => ({ partyId: ctx.uuid(`perf-party-${index}`), displayName: `Performance Party ${String(index + 1).padStart(5, "0")}` }));
  const escrows = Array.from({ length: PERF_COUNTS.escrows }, (_, index) => escrowShape(ctx, parties, index));
  const activeEscrowIds = escrows.slice(0, PERF_COUNTS.activeReadTargets).map(({ escrowId }) => escrowId).sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  const dueEscrowIds = escrows.slice(PERF_COUNTS.activeReadTargets, PERF_COUNTS.activeReadTargets + PERF_COUNTS.due).map(({ escrowId }) => escrowId);
  const path = ctx.tempPath("escrowguard-perf-v1.json"); const stream = createWriteStream(path, { encoding: "utf8", mode: 0o600 }); const write = async (text) => { if (!stream.write(text)) await once(stream, "drain"); };
  await write('{"schemaVersion":1,"seedVersion":"perf-v1","parties":'); await writeArray(stream, PERF_COUNTS.parties, (index) => parties[index]); await write(',"escrows":'); await writeArray(stream, PERF_COUNTS.escrows, (index) => escrows[index]); await write(',"milestones":'); await writeArray(stream, PERF_COUNTS.milestones, (index) => { const escrowIndex = Math.floor(index / 3); return milestoneShape(ctx, escrows[escrowIndex], escrowIndex, index % 3 + 1); }); await write(',"disputes":[],"releases":'); await writeArray(stream, PERF_COUNTS.releases, (index) => { const escrow = escrows[index]; const milestone = milestoneShape(ctx, escrow, index, 1); return { releaseId: ctx.uuid(`perf-release-${index}`), escrowId: escrow.escrowId, milestoneId: milestone.milestoneId, sellerId: escrow.sellerId, amountMinor: milestone.amountMinor, createdAt: milestone.releasedAt }; }); await write("}"); stream.end(); await once(stream, "close");
  return { path, parties, escrows, activeEscrowIds, dueEscrowIds };
}
