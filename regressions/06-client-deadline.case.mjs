import test from 'node:test';
import assert from 'node:assert/strict';

import {core,sleep} from './helpers.mjs';
async function bounded(p){let timer;try{return await Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('test deadline reached before client deadline')),150);})]);}finally{clearTimeout(timer);}}
const question={q:{type:'noul',instructions:'keep?'}};
const response=()=>new Response('{"answers":{"q":{"noul":1}}}',{status:200});
test('request deadline aborts stalled fetch, including an injected fetch that ignores abort',async()=>{
  let signal;const client=new core.JevClient({apiKey:'test',timeoutMs:10,fetch:async(_u,i)=>{signal=i.signal;return new Promise(()=>{});}});
  await assert.rejects(bounded(client.ask({},question)),/timed out/i);
  assert.equal(signal.aborted,true);
});
test('the deadline also bounds response body consumption',async()=>{
  const client=new core.JevClient({apiKey:'test',timeoutMs:10,fetch:async()=>({status:200,ok:true,text:async()=>new Promise(()=>{})})});
  await assert.rejects(bounded(client.ask({},question)),/timed out/i);
});
test('already-aborted clients send no request',async()=>{
  const controller=new AbortController();controller.abort(Error('cancelled by caller'));let requests=0;
  const client=new core.JevClient({apiKey:'test',signal:controller.signal,fetch:async()=>{requests++;return response();}});
  await assert.rejects(client.ask({},question),/cancelled by caller/);assert.equal(requests,0);
});
test('caller abort interrupts an outstanding request',async()=>{
  const controller=new AbortController();const client=new core.JevClient({apiKey:'test',signal:controller.signal,timeoutMs:1000,fetch:async()=>new Promise(()=>{})});
  const pending=client.ask({},question);controller.abort(Error('stop now'));
  await assert.rejects(bounded(pending),/stop now/);
});
test('successful completion clears the deadline',async()=>{
  let signal;const client=new core.JevClient({apiKey:'test',timeoutMs:20,fetch:async(_u,i)=>{signal=i.signal;return response();}});
  assert.equal((await client.ask({},question)).answers.q.noul,1);await sleep(35);assert.equal(signal.aborted,false);
});
test('timeout configuration must be a positive timer-safe integer',()=>{
  for(const timeoutMs of [0,-1,NaN,Infinity,1.5,2**31])assert.throws(()=>new core.JevClient({apiKey:'test',timeoutMs}),/timeoutMs/);
});
