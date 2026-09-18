import test from 'node:test';
import assert from 'node:assert/strict';

import {core,call,result,message,answers} from './helpers.mjs';
test('a lower request budget also shrinks the state to leave room for questions',async()=>{
  const input=[message('user','start'),call('x'),result('x'),message('assistant','word '.repeat(2000)),message('user','finish')];let request;
  const output=await core.compact(input,{ask:async(s,q)=>{request=JSON.stringify({model:'jev-latest',state:s,questions:q});return answers(q,1);}},{maxRequestTokens:1000,maxStateTokens:25000,preserveRecentMessages:1,goal:'finish'});
  assert.ok(request);assert.ok(core.estimateTokens(request)<=1000);
  assert.notEqual(output.stats.stateStage,'full');assert.equal(output.messages.length,input.length);
});
test('an impossible request budget fails without sending anything',async()=>{
  let asks=0;await assert.rejects(core.compact([message('user','start'),call('x'),result('x')],{ask:async()=>{asks++;throw Error('unexpected');}},{maxRequestTokens:1,preserveRecentMessages:0}));assert.equal(asks,0);
});
