import test from 'node:test';
import assert from 'node:assert/strict';

import {handlers,host,transcript} from './helpers.mjs';
for(const method of ['log','toast']) test('missing-key fallback survives '+method+' failure',async()=>{
  const h=handlers(),$=host();$.ui[method]=()=>{throw Error('UI unavailable');};let calls=0;const expected={native:true};
  const result=await h['session.compact']($,{messages:transcript()},async()=>{calls++;return expected;});
  assert.equal(result,expected);assert.equal(calls,1);
});
for(const method of ['log','toast']) test('successful compaction survives '+method+' failure',async()=>{
  const h=handlers({apiKey:'test',preserveRecentMessages:0}),$=host();$.ui[method]=()=>{throw Error('UI unavailable');};let calls=0;
  const output=await h['session.compact']($,{messages:transcript()},async()=>{calls++;return {native:true};});
  assert.equal(calls,0);assert.equal(output.messages.length,2);
});
test('auto-compaction logging cannot swallow event continuation',async()=>{
  const h=handlers(),$=host();$.session.compact=async()=>{throw Error('failure');};$.ui.log=()=>{throw Error('logger failed');};let next=0;
  await h['turn.complete']($,{},async()=>{next++;return {};});assert.equal(next,1);
});
test('native fallback rejection is propagated without invoking it twice',async()=>{
  const h=handlers(),$=host();let next=0;
  await assert.rejects(h['session.compact']($,{messages:[]},async()=>{next++;throw Error('native failed');}),/native failed/);assert.equal(next,1);
});
