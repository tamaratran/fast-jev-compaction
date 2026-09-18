import test from 'node:test';
import assert from 'node:assert/strict';

import {core,call,result,message,fakeAsker} from './helpers.mjs';
test('duplicate call identifiers fail closed rather than deleting a pinned message',async()=>{
  const input=[call('same'),result('same'),call('same'),message('user','continue')];
  let requests=0;
  await assert.rejects(core.compact(input,{ask:async(...a)=>{requests++;return fakeAsker().ask(...a);}},{preserveRecentMessages:0}),/Duplicate tool_use_id/);
  assert.equal(requests,0);
  assert.equal(input[0].toolUses[0].tool_use_id,'same');
});
test('duplicate results are rejected instead of silently selecting the last',()=>{
  assert.throws(()=>core.collectToolCalls([message('user','start'),call('x'),result('x','first'),result('x','last')],0),/Duplicate tool_result/);
});
test('a result cannot precede its call',()=>{
  assert.throws(()=>core.collectToolCalls([result('x'),call('x')],0),/precedes/);
});
test('applyDecisions cannot override a pinned call',()=>{
  const input=[call('x'),result('x'),message('user','end')]; const calls=core.collectToolCalls(input,0);
  const decisions=[{id:calls[0].id,tool:'Read',keepCall:0,keepResult:0,action:'drop_call',reason:'call_dropped'}];
  assert.deepEqual(core.applyDecisions(input,decisions,calls,300),input);
});
test('unpaired calls and orphan results are still accepted as partial histories',()=>{
  assert.deepEqual(core.collectToolCalls([call('pending'),result('orphan')],0),[]);
});
