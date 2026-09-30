// Policy revision: learning-final-system-2026-09-08.1. Current FINAL state and public lifecycle only; no historical binary upgrade.
import { mkdir,symlink,writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { releaseDeclaration,seedBundle,sha256 } from "../lib/fixtures.mjs";
import { assertArtifactVersion,assertReferenceClosure,assertReleaseDetail } from "../lib/oracle.mjs";
import { boot,caseResult,createRelease,createUpload,defineCase,exactBinary,exerciseReleaseUi,findRelease,putSequential,publishReadyRelease,snapshot,uploadReleaseMembers,uploadView,waitUpload } from "./helpers.mjs";
import { EvaluationInfrastructureError } from "../lib/runtime.mjs";

function legacyBundle(ctx,label="legacy"){return seedBundle(ctx.fixtures,label,[{packageName:`${label}-pkg`,version:"1.0.0",bytes:ctx.fixtures.bytes(`${label}-bytes`,4096),artifactVersionId:ctx.fixtures.uuid(`${label}-version`)}]);}

const MIGRATE01=defineCase("MIGRATE-01","committed base-system Artifact plus saved replay","Create current content and saved replay, SIGKILL the API, initialize twice, then verify the same bytes and metadata","No Blob rewrite or public identity, response, event or content drift occurs",["FINAL runtime","FINAL reinitialization","public HTTP"],async(ctx)=>{
  const initialRuntime=ctx,bundle=legacyBundle(ctx,"reinitialize-01");await initialRuntime.migrate();await ctx.seedBundle(bundle,{workspace:ctx.workspace});const oldApi=await initialRuntime.startApi(),entry=bundle.seed.artifactVersions[0],oldMetadata=await ctx.getVersion(oldApi.baseUrl,entry.packageName,entry.version),oldContent=await ctx.getContent(oldApi.baseUrl,entry.packageName,entry.version),oldSnapshot=await snapshot(ctx,oldApi.baseUrl,{final:true});ctx.equal("base-system metadata status",oldMetadata.status,200);ctx.assert("base-system ArtifactVersion exact",()=>assertArtifactVersion(oldMetadata.json));exactBinary(ctx,oldContent,bundle.assets[entry.assetPath],"base-system content");const etag=oldContent.headers.get("etag");
  const replayBytes=ctx.fixtures.bytes("reinitialize-01-replay",128),key=ctx.key("persisted-create"),body={packageName:"saved-replay",version:"1",mediaType:"application/octet-stream",expectedSize:replayBytes.length,expectedSha256:sha256(replayBytes)},saved=await ctx.createUpload(oldApi.baseUrl,body,{key});ctx.equal("base-system saved mutation status",saved.status,201);await ctx.kill(oldApi);await ctx.migrate();await ctx.migrate();const api=await ctx.startApi(),legacy=await ctx.getVersion(api.baseUrl,entry.packageName,entry.version),content=await ctx.getContent(api.baseUrl,entry.packageName,entry.version),replay=await ctx.createUpload(api.baseUrl,body,{key});ctx.equal("legacy response byte shape preserved",legacy.json,oldMetadata.json,{hardCapIds:["MIGRATION_CORRECTNESS"]});ctx.ok("legacy body omits Manager platform",!Object.hasOwn(legacy.json,"platform"));ctx.equal("saved replay status preserved",replay.status,saved.status,{hardCapIds:["MIGRATION_CORRECTNESS","IDEMPOTENCY_CORRECTNESS"]});ctx.equal("saved replay semantic body preserved",replay.json,saved.json,{hardCapIds:["MIGRATION_CORRECTNESS","IDEMPOTENCY_CORRECTNESS"]});exactBinary(ctx,content,bundle.assets[entry.assetPath],"retained legacy content");ctx.equal("ETag preserved",content.headers.get("etag"),etag,{hardCapIds:["MIGRATION_CORRECTNESS"]});
  const after=await snapshot(ctx,api.baseUrl);ctx.equal("retained artifact identity preserved",after.resources.artifactVersions.find(({artifactVersionId})=>artifactVersionId===entry.artifactVersionId)?.blob.sha256,oldMetadata.json.blob.sha256);ctx.equal("preexisting Events preserved",after.events.filter((item)=>oldSnapshot.events.some(({eventId})=>eventId===item.eventId)),oldSnapshot.events);ctx.assert("reference closure",()=>assertReferenceClosure(after));return caseResult(ctx,{artifactVersionId:entry.artifactVersionId,etag});
});

const MIGRATE02=defineCase("MIGRATE-02","partial staging plus leased verification","Create partial and VERIFYING current sessions, SIGKILL a claimed worker, then reinitialize","Offset, expiry, exact verification Work identity/attempt and reclaimable outcome survive reinitialization",["worker.claimed","SIGKILL","FINAL worker"],async(ctx)=>{
  await ctx.migrate();
  const initialApi=await ctx.startApi();
  const partialBytes=ctx.fixtures.bytes("reinitialize-02-partial",2048);
  const partial=await createUpload(ctx,initialApi.baseUrl,"reinitialize-02-partial",partialBytes,{packageName:"reinitialization-partial",version:"1"});
  const chunk=await ctx.putChunk(initialApi.baseUrl,partial.upload.uploadId,partialBytes.subarray(0,1024),0,partialBytes.length);
  ctx.equal("partial chunk accepted",chunk.status,200);
  ctx.equal("partial chunk offset",chunk.json.nextOffset,1024);
  const pendingBytes=ctx.fixtures.bytes("reinitialize-02-pending",4096);
  const pending=await createUpload(ctx,initialApi.baseUrl,"reinitialize-02-pending",pendingBytes,{packageName:"reinitialization-pending",version:"1"});
  await putSequential(ctx,initialApi.baseUrl,pending.upload.uploadId,pendingBytes);
  const completion=await ctx.completeUpload(initialApi.baseUrl,pending.upload.uploadId);
  ctx.equal("verification requested",completion.status,202);
  const barrier=await ctx.workerBarrier("worker.claimed",({aggregateId})=>aggregateId===pending.upload.uploadId);
  const stale=await ctx.startWorker({env:{TEST_BARRIER_URL:barrier.url,TEST_BARRIER_TOKEN:barrier.token}});
  const held=await barrier.waitFor((entry)=>entry.json.aggregateId===pending.upload.uploadId,{processes:[stale]});
  await ctx.kill(stale);
  const before=await ctx.snapshot(initialApi.baseUrl);
  const partialBefore=before.resources.uploadSessions.find(({uploadId})=>uploadId===partial.upload.uploadId);
  // The same upload also owns expiry Work: aggregateId alone is not an identity.
  const workBefore=before.work.find(({workId})=>workId===held.json.workId);
  ctx.ok("barrier identifies leased verification Work",workBefore?.state==="LEASED"&&workBefore.kind==="ARTIFACT_VERIFICATION"&&workBefore.aggregateId===pending.upload.uploadId);
  const expiryBefore=before.work.find(({kind,aggregateId,terminal})=>kind==="UPLOAD_EXPIRY"&&aggregateId===partial.upload.uploadId&&!terminal);
  ctx.ok("partial upload has PENDING expiry Work",expiryBefore?.state==="PENDING");
  await ctx.kill(initialApi);
  await ctx.migrate();
  const api=await ctx.startApi(),after=await snapshot(ctx,api.baseUrl);
  const partialAfter=after.resources.uploadSessions.find(({uploadId})=>uploadId===partial.upload.uploadId);
  const workAfter=after.work.find(({workId})=>workId===workBefore.workId),expiryAfter=after.work.find(({workId})=>workId===expiryBefore.workId);
  ctx.equal("partial offset preserved",partialAfter.nextOffset,partialBefore.nextOffset,{hardCapIds:["MIGRATION_CORRECTNESS"]});
  ctx.equal("expiry deadline preserved",partialAfter.expiresAt,partialBefore.expiresAt,{hardCapIds:["MIGRATION_CORRECTNESS"]});
  ctx.equal("exact claimed verification Work preserved",workAfter,workBefore,{hardCapIds:["MIGRATION_CORRECTNESS","WORK_RECOVERY_CORRECTNESS"]});
  ctx.equal("exact partial expiry Work preserved",expiryAfter,expiryBefore,{hardCapIds:["MIGRATION_CORRECTNESS"]});
  await ctx.sleep(Math.max(0,Date.parse(workBefore.leaseExpiresAt)-Date.now()+100));
  const replacement=await ctx.startWorker();
  const settled=await waitUpload(ctx,api.baseUrl,pending.upload.uploadId,"COMMITTED",{processes:[replacement]});
  await ctx.stop(replacement);
  const final=await snapshot(ctx,api.baseUrl),recovered=final.work.find(({workId})=>workId===workBefore.workId);
  ctx.ok("the killed verification Work is reclaimed and terminal",recovered?.terminal&&recovered.attempt>workBefore.attempt,undefined,{hardCapIds:["WORK_RECOVERY_CORRECTNESS"]});
  ctx.equal("pending verification recovers",settled.upload.state,"COMMITTED");
  return caseResult(ctx,{workId:workBefore.workId,expiryWorkId:expiryBefore.workId,partialOffset:partialAfter.nextOffset});
});

const MIGRATE03=defineCase("MIGRATE-03","base-system seed contract matrix","Import a valid seed, exact replay, digest conflict and path/file attacks through db:seed","Import is atomic across PostgreSQL and managed bytes; FINAL keeps schemaVersion 1",["task-local asset fixtures","db:seed","snapshot"],async(ctx)=>{
  const legal=seedBundle(ctx.fixtures,"reinitialize-03",[{packageName:"seed-legal",version:"1",bytes:ctx.fixtures.bytes("seed-legal",1024)}]);const first=await ctx.seedBundle(legal),replay=await ctx.seedBundle(legal);ctx.equal("exact seed replay succeeds",replay.result.exitCode,0);const{api}=await boot(ctx),baseline=await snapshot(ctx,api.baseUrl);ctx.equal("one seeded Version",baseline.resources.artifactVersions.length,1);exactBinary(ctx,await ctx.getContent(api.baseUrl,"seed-legal","1"),legal.assets[legal.seed.artifactVersions[0].assetPath],"seeded content");
  const conflict=structuredClone(legal);conflict.seed.packages[0].displayName="different";const conflictResult=await ctx.seedBundle(conflict,{expectFailure:true});ctx.ok("seed conflict reports stable code",/SEED_VERSION_CONFLICT/u.test(`${conflictResult.result.stdout}\n${conflictResult.result.stderr}`));const invalids=[];
  for(const[name,assetPath]of[["absolute","/tmp/escape.bin"],["dot","../escape.bin"],["nested-dot","x/../escape.bin"]]){const bundle=structuredClone(legal);bundle.seed.seedVersion=`bad-${name}`;bundle.seed.artifactVersions[0].artifactVersionId=ctx.fixtures.uuid(`bad-${name}`);bundle.seed.artifactVersions[0].assetPath=assetPath;invalids.push(await ctx.seedBundle(bundle,{expectFailure:true,contractExpectation:"invalid"}));}
  const badDigest=structuredClone(legal);badDigest.seed.seedVersion="bad-digest";badDigest.seed.artifactVersions[0].artifactVersionId=ctx.fixtures.uuid("bad-digest");badDigest.seed.artifactVersions[0].expectedSha256="0".repeat(64);invalids.push(await ctx.seedBundle(badDigest,{expectFailure:true}));
  const badSize=structuredClone(legal);badSize.seed.seedVersion="bad-size";badSize.seed.artifactVersions[0].artifactVersionId=ctx.fixtures.uuid("bad-size");badSize.seed.artifactVersions[0].expectedSize+=1;invalids.push(await ctx.seedBundle(badSize,{expectFailure:true}));const badReference=structuredClone(legal);badReference.seed.seedVersion="bad-reference";badReference.seed.artifactVersions[0].artifactVersionId=ctx.fixtures.uuid("bad-reference");badReference.seed.artifactVersions[0].packageName="missing-package";invalids.push(await ctx.seedBundle(badReference,{expectFailure:true}));
  const linkRoot=ctx.tempPath("seed-symlink"),assets=resolve(linkRoot,"assets");await mkdir(assets,{recursive:true});await writeFile(resolve(linkRoot,"outside.bin"),Buffer.from("outside"));await symlink(resolve(linkRoot,"outside.bin"),resolve(assets,"link.bin"));const linkSeed=structuredClone(legal.seed);linkSeed.seedVersion="bad-symlink";linkSeed.artifactVersions[0].artifactVersionId=ctx.fixtures.uuid("bad-symlink");linkSeed.artifactVersions[0].assetPath="link.bin";linkSeed.artifactVersions[0].expectedSize=7;linkSeed.artifactVersions[0].expectedSha256=sha256(Buffer.from("outside"));await writeFile(resolve(linkRoot,"seed.json"),JSON.stringify(linkSeed));const linkResult=await ctx.seedFile(resolve(linkRoot,"seed.json"),{allowFailure:true});ctx.ok("symlink seed rejected",linkResult.exitCode!==0,undefined,{hardCapIds:["MIGRATION_CORRECTNESS"]});
  const directoryRoot=ctx.tempPath("seed-directory-asset"),directoryAssets=resolve(directoryRoot,"assets");await mkdir(resolve(directoryAssets,"not-a-file"),{recursive:true});const directorySeed=structuredClone(legal.seed);directorySeed.seedVersion="bad-directory";directorySeed.artifactVersions[0].artifactVersionId=ctx.fixtures.uuid("bad-directory");directorySeed.artifactVersions[0].assetPath="not-a-file";await writeFile(resolve(directoryRoot,"seed.json"),JSON.stringify(directorySeed));const directoryResult=await ctx.seedFile(resolve(directoryRoot,"seed.json"),{allowFailure:true});ctx.ok("non-regular asset rejected",directoryResult.exitCode!==0,undefined,{hardCapIds:["MIGRATION_CORRECTNESS"]});const after=await snapshot(ctx,api.baseUrl);ctx.equal("invalid seeds have no business side effects",{resources:after.resources,work:after.work,events:after.events},{resources:baseline.resources,work:baseline.work,events:baseline.events},{hardCapIds:["MIGRATION_CORRECTNESS"]});ctx.equal("published seed schema remains base-system",legal.seed.schemaVersion,1);return caseResult(ctx,{invalidSeedCount:invalids.length+3});
});

const MIGRATE04=defineCase("MIGRATE-04","current singular and multi-platform Release APIs","reinitialize base-system data, publish a new multi Release, inspect OpenAPI/snapshot and exercise real UI","Legacy and Manager shapes coexist without invented list API or wire drift",["FINAL public operations","OpenAPI","Chromium"],async(ctx)=>{
  const initialRuntime=ctx,legacy=legacyBundle(ctx,"reinitialize-04");await initialRuntime.migrate();await ctx.seedBundle(legacy,{workspace:ctx.workspace});await ctx.migrate();const api=await ctx.startApi(),entry=legacy.seed.artifactVersions[0],legacyResponse=await ctx.getVersion(api.baseUrl,entry.packageName,entry.version);ctx.assert("legacy ArtifactVersion exact",()=>assertArtifactVersion(legacyResponse.json));ctx.ok("legacy response omits platform",!Object.hasOwn(legacyResponse.json,"platform"));
  const members=[{platform:"linux",bytes:ctx.fixtures.bytes("reinitialize-04-linux",512)},{platform:"windows",bytes:ctx.fixtures.bytes("reinitialize-04-windows",768)}],declaration=releaseDeclaration(ctx.fixtures,"reinitialize-04-new",members),created=await createRelease(ctx,api.baseUrl,declaration);await uploadReleaseMembers(ctx,api.baseUrl,created.release,Object.fromEntries(members.map(({platform,bytes})=>[platform,bytes])));await publishReadyRelease(ctx,api.baseUrl,created.release);const detail=await ctx.getRelease(api.baseUrl,declaration.packageName,declaration.version);ctx.assert("multi ReleaseDetail exact",()=>assertReleaseDetail(detail.json));const openapi=await ctx.readOpenApi(api.baseUrl);ctx.ok("OpenAPI has singular content",Object.hasOwn(openapi.paths,"/api/v1/packages/{packageName}/versions/{version}/content"));ctx.ok("OpenAPI has platform content",Object.hasOwn(openapi.paths,"/api/v1/packages/{packageName}/releases/{version}/artifacts/{platform}/content"));ctx.ok("OpenAPI does not invent Release list GET",!openapi.paths?.["/api/v1/releases"]?.get);
  const state=await snapshot(ctx,api.baseUrl);ctx.equal("the explicitly published multi-platform Release is present",state.resources.releases.filter(({releaseId})=>releaseId===created.release.releaseId).length,1);ctx.assert("current content reference closure",()=>assertReferenceClosure(state));exactBinary(ctx,await ctx.getContent(api.baseUrl,entry.packageName,entry.version),legacy.assets[entry.assetPath],"legacy singular UI-compatible content");await exerciseReleaseUi(ctx,api,{packageName:declaration.packageName,version:declaration.version,platforms:members.map(({platform})=>platform)});return caseResult(ctx,{legacyArtifactVersionId:entry.artifactVersionId,newReleaseId:created.release.releaseId});
});

export const MIGRATE_CASES=Object.freeze([MIGRATE01,MIGRATE02,MIGRATE03,MIGRATE04]);
