import { createWriteStream } from "node:fs";
import { once } from "node:events";

import { canonicalJson, sha256Bytes } from "../oracles/index.mjs";

export const PERF_COUNTS = Object.freeze({ projects: 1_000, beneficiaries: 10_000, creditLots: 50_000, retirements: 105_000, certificates: 100_000, reserved: 5_000 });

function certificateFor(ctx, retirementId, beneficiaryId, lot, retiredAt) {
  const certificate = { certificateVersion: 1, retirementId, beneficiaryId, quantityGrams: 1, creditLotId: lot.creditLotId, projectId: lot.projectId, vintage: lot.vintage, methodology: lot.methodology, provenanceDigest: lot.provenanceDigest, retiredAt };
  const bytes = Buffer.from(canonicalJson(certificate));
  return { certificate, digest: sha256Bytes(bytes) };
}

export async function writePerformanceSeed(ctx) {
  const projects = Array.from({ length: PERF_COUNTS.projects }, (_, index) => ({ projectId: ctx.uuid(`perf-project-${index}`), name: `Performance Project ${String(index + 1).padStart(4, "0")}` }));
  const beneficiaries = Array.from({ length: PERF_COUNTS.beneficiaries }, (_, index) => ({ beneficiaryId: ctx.uuid(`perf-beneficiary-${index}`), name: `Performance Beneficiary ${String(index + 1).padStart(5, "0")}` }));
  const creditLots = Array.from({ length: PERF_COUNTS.creditLots }, (_, index) => {
    const measured = index < 10;
    const warmup = index >= 10 && index < 20;
    const retiredGrams = 2;
    const reservedGrams = index < PERF_COUNTS.reserved ? 1 : 0;
    const availableGrams = measured || warmup ? 20_000 : 100;
    return {
      creditLotId: ctx.uuid(`perf-lot-${index}`),
      projectId: measured ? projects[0].projectId : warmup ? projects[1].projectId : projects[index % projects.length].projectId,
      vintage: measured ? 2030 : warmup ? 2031 : 2020 + (index % 15),
      methodology: measured ? "FOREST" : warmup ? "DIRECT_AIR_CAPTURE" : index % 2 === 0 ? "FOREST" : "DIRECT_AIR_CAPTURE",
      priority: measured || warmup ? 10_000 - (index % 10) : index % 100,
      issuedGrams: availableGrams + reservedGrams + retiredGrams,
      availableGrams,
      reservedGrams,
      retiredGrams,
      provenanceDigest: ctx.fixtures.hex(`perf-provenance-${index}`),
    };
  });
  const path = ctx.tempPath("carbonledger-perf-v1.json");
  const stream = createWriteStream(path, { encoding: "utf8", mode: 0o600 });
  const write = async (text) => { if (!stream.write(text)) await once(stream, "drain"); };
  await write(`{"schemaVersion":1,"seedVersion":"perf-v1","projects":${JSON.stringify(projects)},"beneficiaries":${JSON.stringify(beneficiaries)},"creditLots":${JSON.stringify(creditLots)},"retirements":[`);
  for (let start = 0; start < PERF_COUNTS.retirements; start += 1_000) {
    const values = [];
    for (let index = start; index < Math.min(start + 1_000, PERF_COUNTS.retirements); index += 1) {
      const lot = creditLots[index % creditLots.length];
      const retirementId = ctx.uuid(`perf-retirement-${index}`);
      const beneficiaryId = beneficiaries[index % beneficiaries.length].beneficiaryId;
      const createdAt = index < PERF_COUNTS.certificates ? "2029-01-01T00:00:00.000Z" : "2035-06-01T12:00:00.000Z";
      const retiredAt = "2029-01-01T00:01:00.000Z";
      const published = index < PERF_COUNTS.certificates ? certificateFor(ctx, retirementId, beneficiaryId, lot, retiredAt) : undefined;
      values.push({
        retirementId,
        beneficiaryId,
        quantityGrams: 1,
        state: published ? "RETIRED" : "RESERVED",
        allocation: { creditLotId: lot.creditLotId, quantityGrams: 1 },
        expiresAt: published ? "2029-01-01T00:10:00.000Z" : "2035-06-01T12:10:00.000Z",
        certificateDigest: published?.digest ?? null,
        createdAt,
        terminalAt: published ? retiredAt : null,
        sequence: published ? 3 : 1,
      });
    }
    await write(`${start === 0 ? "" : ","}${values.map(JSON.stringify).join(",")}`);
  }
  await write("],\"certificates\":[");
  for (let start = 0; start < PERF_COUNTS.certificates; start += 1_000) {
    const values = [];
    for (let index = start; index < Math.min(start + 1_000, PERF_COUNTS.certificates); index += 1) {
      const lot = creditLots[index % creditLots.length];
      values.push(certificateFor(ctx, ctx.uuid(`perf-retirement-${index}`), beneficiaries[index % beneficiaries.length].beneficiaryId, lot, "2029-01-01T00:01:00.000Z").certificate);
    }
    await write(`${start === 0 ? "" : ","}${values.map(JSON.stringify).join(",")}`);
  }
  await write("]}");
  stream.end();
  await once(stream, "close");
  return { path, projects, beneficiaries, creditLots, measuredHotLots: creditLots.slice(0, 10), warmupHotLots: creditLots.slice(10, 20), reservedRetirementIds: Array.from({ length: PERF_COUNTS.reserved }, (_, index) => ctx.uuid(`perf-retirement-${PERF_COUNTS.certificates + index}`)) };
}
