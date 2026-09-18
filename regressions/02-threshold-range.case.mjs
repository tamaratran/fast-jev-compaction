import test from 'node:test';
import assert from 'node:assert/strict';

import {core,transcript,fakeAsker} from './helpers.mjs';
for(const threshold of [-0.1,1.01]) test('reject out-of-range keep threshold '+threshold,async()=>{
  assert.throws(()=>core.resolveOptions({keepThreshold:threshold}),/keepThreshold/);
  await assert.rejects(core.compact(transcript(),fakeAsker(1),{keepThreshold:threshold,preserveRecentMessages:0}),/keepThreshold/);
});
test('decideCall enforces the threshold contract for direct callers',()=>{
  assert.throws(()=>core.decideCall({id:'t1',tool:'Read',pinned:false},{keepCall:1,keepResult:1},{keepThreshold:1.1}),/keepThreshold/);
});
test('existing default and non-finite-option behavior stays compatible',()=>{
  assert.equal(core.resolveOptions({keepThreshold:NaN}).keepThreshold,0.5);
  assert.equal(core.resolveOptions({keepThreshold:0}).keepThreshold,0);
  assert.equal(core.resolveOptions({keepThreshold:1}).keepThreshold,1);
});
