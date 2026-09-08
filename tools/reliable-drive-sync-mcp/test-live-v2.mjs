import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { handleRequest } from './stdio-bridge.mjs';
import { classifySubmission } from '../../shared/rds2-protocol.mjs';
const profile=process.argv.includes('--canary')?'v2-canary':'v2-client';
const ps=`$s=Import-Clixml -LiteralPath (Join-Path $env:LOCALAPPDATA 'ReliableDriveSync/${profile}.credential.xml');[Console]::Write([Net.NetworkCredential]::new('',$s).Password)`;
const secret=spawnSync('powershell.exe',['-NoProfile','-Command',ps],{encoding:'utf8',windowsHide:true});
if(secret.status!==0) throw new Error('credential_load_failed');
const options={writeVersion:'v2',workerUrl:'https://reliable-drive-sync.qiaobingyuan886.workers.dev',token:secret.stdout.trim()};
async function query(operation,params={}){
 const result=await handleRequest({id:1,method:'tools/call',params:{name:'submit_event',arguments:{storageVersion:2,operation,params}}},options);
 if(result.error) throw new Error(result.error.message);
 return result.result.structuredContent;
}
const name=profile==='v2-canary'?'rds2-synthetic-canary-20260908':'乔炳源';
const who=await query('user.resolve',{displayName:name});
console.log(JSON.stringify({identity:who,capabilities:await query('capabilities')}));
if(process.argv.includes('--write')){
 if(profile!=='v2-canary') throw new Error('synthetic_only');
 const identity={userId:who.userId,username:who.displayName},now=new Date().toISOString();
 const base=(eventType)=>({schemaVersion:'1.2',eventType,...identity,eventId:randomUUID(),eventKey:`full-v2-canary:${eventType}:${randomUUID()}`});
 const events=[
  {...base('algorithm.learning.completed'),observedAt:now,source:'qa',topic:'synthetic-only',problem:{title:'V2 transport test',source:'synthetic',url:''},evidence:'Synthetic deployment verification, not learner evidence',outcome:'consulted',tags:[],confidence:'high'},
  {...base('interview.session.completed'),sessionId:`MOCK-canary-${randomUUID()}`,interviewType:'mock',domain:'java_backend',startedAt:now,completedAt:now,status:'review_pending',resumeContext:{used:false,source:'synthetic',claims:[]},questions:[]},
  {...base('resume-knowledge.question-bank-created'),resumeVersion:'canary-v2',generatedAt:now,questions:[]},
  {schemaVersion:'1.0',eventId:randomUUID(),eventKey:`canary-profile:${randomUUID()}`,observedAt:now,sourceSkill:'profile-aware-skill-creator',action:'observe',observations:[{dimensionKey:'transport',subjectKey:'v2',outcome:'observed',evidence:'Synthetic deployment verification',confidence:'high',sourceRef:'deployment:full-v2-canary'}]}
 ];
 for(let i=0;i<events.length;i++){
  const eventType=i===3?'profile.evidence.recorded':events[i].eventType;
  const envelope={schemaVersion:'1.2',namespace:eventType.split('.')[0],eventType,identity,payload:i===3?{domain:'v2-canary',event:events[i]}:{event:events[i]},requestId:randomUUID()};
  classifySubmission(envelope);
  const response=await fetch(options.workerUrl+'/v2/events',{method:'POST',headers:{authorization:`Bearer ${options.token}`,'content-type':'application/json'},body:JSON.stringify(envelope)});
  const result=await response.json();
  if(!response.ok) throw new Error(result.error?.code??`http_${response.status}`);
  console.log(JSON.stringify({namespace:envelope.namespace,requestId:envelope.requestId,eventId:result.eventId,cloudPersistence:result.cloudPersistence}));
 }
} else {
 console.log(JSON.stringify({sessions:await query('interview.session.list')}));
}
