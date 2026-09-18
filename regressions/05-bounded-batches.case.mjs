import test from 'node:test';
import assert from 'node:assert/strict';

import {core,transcript,answers,sleep} from './helpers.mjs';
function options(input,limit){const resolved=core.resolveOptions({preserveRecentMessages:0,maxConcurrentRequests:limit}); const calls=core.collectToolCalls(input,0);const state=core.fitState(input,calls,resolved);return {...resolved,maxRequestTokens:state.tokens+20+Math.max(...calls.map(c=>core.estimateTokens(JSON.stringify(core.questionsFor(c)))))};}
test('batch fan-out respects the configured concurrency bound',async()=>{
  const input=transcript(12); let active=0,peak=0,requests=0;
  const out=await core.compact(input,{ask:async(_s,q)=>{requests++;active++;peak=Math.max(peak,active);await sleep(4);active--;return answers(q);}},options(input,2));
  assert.ok(requests>2);assert.ok(peak<=2,'peak='+peak);assert.equal(active,0);assert.equal(out.stats.requests,requests);
});
test('the default scheduler does not send every batch at once',async()=>{
  const input=transcript(12);let active=0,peak=0;
  const opts=options(input,undefined);
  await core.compact(input,{ask:async(_s,q)=>{active++;peak=Math.max(peak,active);await sleep(2);active--;return answers(q);}},opts);
  assert.ok(peak<=4,'peak='+peak);
});
test('a failed batch stops queued requests and no partial output is returned',async()=>{
  const input=transcript(10);let requests=0;const before=JSON.stringify(input);
  await assert.rejects(core.compact(input,{ask:async()=>{requests++;throw Error('provider unavailable');}},options(input,1)),/provider unavailable/);
  assert.equal(requests,1);assert.equal(JSON.stringify(input),before);
});
