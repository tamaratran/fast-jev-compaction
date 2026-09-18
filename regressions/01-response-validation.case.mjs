import test from 'node:test';
import assert from 'node:assert/strict';

import {core,transcript,fakeAsker} from './helpers.mjs';
for(const value of [-1,1.01,NaN,Infinity,-Infinity]) test('reject invalid probability '+value,()=>{
  assert.throws(()=>core.noulAnswer({x:{type:'noul',noul:value}},'x'),/Invalid/);
});
test('accept valid probability boundaries and legacy absent discriminator',()=>{
  assert.equal(core.noulAnswer({x:{noul:0}},'x'),0);
  assert.equal(core.noulAnswer({x:{type:'noul',noul:1}},'x'),1);
});
test('reject arrays, primitive answers and mismatched discriminators',()=>{
  assert.throws(()=>core.parseJevResponse(200,true,'{"answers":[]}'),/answers/);
  for(const value of [null,0,'no',[],{type:'choice',noul:0}])
    assert.throws(()=>core.noulAnswer({x:value},'x'),/Invalid/);
});
test('reject inherited answers and inherited probability properties',()=>{
  assert.throws(()=>core.noulAnswer(Object.create({x:{noul:0}}),'x'),/Invalid/);
  assert.throws(()=>core.noulAnswer({x:Object.create({noul:0})},'x'),/Invalid/);
});
test('invalid injected answers reject the compaction without changing its input',async()=>{
  const input=transcript(); const before=JSON.stringify(input);
  await assert.rejects(core.compact(input,fakeAsker(-1),{preserveRecentMessages:0}),/Invalid/);
  assert.equal(JSON.stringify(input),before);
});
