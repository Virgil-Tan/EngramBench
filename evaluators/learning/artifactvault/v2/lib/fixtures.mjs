import { createHash } from "node:crypto";

function digest(seed,label){return createHash("sha256").update(`${seed}\0${label}`).digest();}
function uuidFrom(bytes){const hex=bytes.toString("hex");return`${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;}

export function createFixtureFactory({evaluationSeed,caseId,baseTime}){
  const seed=`${evaluationSeed}\0${caseId}`,epoch=Date.parse(baseTime);if(!Number.isFinite(epoch))throw new TypeError("baseTime must be an ISO timestamp");
  return Object.freeze({
    seed,
    uuid:(label)=>uuidFrom(digest(seed,`uuid:${label}`)),
    key:(label)=>`av-${String(label).replace(/[^a-z0-9-]/giu,"-").slice(0,72)}-${digest(seed,`key:${label}`).toString("hex").slice(0,20)}`,
    at:({milliseconds=0,seconds=0}={})=>new Date(epoch+milliseconds+seconds*1000).toISOString(),
    bytes:(label,size)=>Buffer.alloc(size,digest(seed,`bytes:${label}`)[0]),
    fillByte:(label)=>digest(seed,`bytes:${label}`)[0],
  });
}

export function sha256(value){return createHash("sha256").update(value).digest("hex");}

export function uploadDeclaration(fixtures,label,bytes,overrides={}){
  return{packageName:overrides.packageName??`pkg-${label}`.toLowerCase().replace(/[^a-z0-9._-]/gu,"-"),version:overrides.version??`v-${label}`,mediaType:overrides.mediaType??"application/octet-stream",expectedSize:overrides.expectedSize??bytes.length,expectedSha256:overrides.expectedSha256??sha256(bytes)};
}

export function releaseDeclaration(fixtures,label,members){
  return{packageName:`release-${label}`.toLowerCase().replace(/[^a-z0-9._-]/gu,"-"),version:`r-${label}`,artifacts:members.map(({platform,bytes,mediaType="application/octet-stream"})=>({platform,expectedSize:bytes.length,expectedSha256:sha256(bytes),mediaType}))};
}

export function seedBundle(fixtures,label,entries=[]){
  const packages=new Map(),assets={};
  const artifactVersions=entries.map((entry,index)=>{
    const bytes=entry.bytes??fixtures.bytes(`${label}:${index}`,entry.size??1),packageName=entry.packageName??`seed-${label}-${index}`,version=entry.version??`v${index+1}`,assetPath=entry.assetPath??`${String(index).padStart(6,"0")}.bin`;
    packages.set(packageName,{packageName,displayName:entry.displayName??`Package ${packageName}`});assets[assetPath]=bytes;
    return{artifactVersionId:entry.artifactVersionId??fixtures.uuid(`${label}:artifact:${index}`),packageName,version,mediaType:entry.mediaType??"application/octet-stream",assetPath,expectedSize:bytes.length,expectedSha256:sha256(bytes),committedAt:entry.committedAt??fixtures.at({seconds:index})};
  });
  return{seed:{schemaVersion:1,seedVersion:`${label}-${sha256(Buffer.from(fixtures.seed)).slice(0,12)}`.slice(0,64),packages:[...packages.values()],artifactVersions},assets};
}

export function emptyPackageBundle(fixtures,label,packageNames){
  return{seed:{schemaVersion:1,seedVersion:`${label}-${sha256(Buffer.from(fixtures.seed)).slice(0,12)}`.slice(0,64),packages:packageNames.map((packageName)=>({packageName,displayName:`Package ${packageName}`})),artifactVersions:[]},assets:{}};
}

export function performanceContract(){
  return Object.freeze({
    stream:{uploadCount:20,bytesPerUpload:64*1024*1024,chunkBytes:8*1024*1024,chunksPerUpload:8,concurrency:20,targetMiBPerSecond:120},
    read:{packageCount:100_000,concurrency:64,warmupSeconds:10,measureSeconds:60,targetPerSecond:200,p95Ms:120},
    recovery:{sessionCount:32,bytesPerSession:64*1024*1024,totalBytes:2*1024*1024*1024,killedWorkers:2,replacementWorkers:2,maximumSeconds:90,peakRssMiB:768,deltaRssMiB:64},
  });
}
