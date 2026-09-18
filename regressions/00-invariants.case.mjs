import test from 'node:test';
import assert from 'node:assert/strict';

import {core,hook,transcript,fakeAsker,call,result,message} from './helpers.mjs';
test('empty and tool-free transcripts make no requests', async()=>{
  const asker={ask(){throw Error('Unexpected request');}};
  assert.deepEqual((await core.compact([],asker)).messages,[]);
  const input=[message('user','Never remove this text')];
  assert.equal((await core.compact(input,asker)).messages[0],input[0]);
});
test('valid keep/drop matrix and exact threshold equality',()=>{
  const c={id:'t1',tool:'Read',pinned:false}; const o={keepThreshold:0.5};
  for(const [a,b,action] of [[0,0,'drop_call'],[1,0,'drop_result'],[0,1,'keep'],[0.5,0,'drop_result'],[0,0.5,'keep']])
    assert.equal(core.decideCall(c,{keepCall:a,keepResult:b},o).action,action);
});
test('kept messages and handles retain identity; inputs are not mutated',async()=>{
  const input=transcript(3);input.forEach((m,i)=>m.handle='handle-'+i);
  const before=JSON.stringify(input);
  const output=await core.compact(input,fakeAsker(1),{preserveRecentMessages:0});
  assert.equal(JSON.stringify(input),before);
  output.messages.forEach((m,i)=>assert.equal(m,input[i]));
  const converted=hook.toSessionMessages(input,output.messages);
  converted.forEach((m,i)=>assert.equal(m,input[i]));
});
test('truncation keeps both sides of the pair and clears changed message handles',async()=>{
  const input=transcript();input[1].handle='call';input[2].handle='result';
  input[1].toolUses[0].text=input[2].toolResults[0].text;
  const output=await core.compact(input,fakeAsker(k=>k.startsWith('call_')?1:0),{preserveRecentMessages:0,truncateHeadChars:12});
  assert.equal(output.messages.length,input.length);
  assert.equal(output.messages[1].toolUses[0].text,output.messages[2].toolResults[0].text);
  assert.match(output.messages[2].toolResults[0].text,/^x{12}\n/);
  assert.equal(hook.toSessionMessages(input,output.messages)[2].handle,undefined);
});
test('short results remain untouched and recent pairs stay pinned',async()=>{
  const input=[message('user','first'),call('x'),result('x','ok'),message('user','last')];
  const output=await core.compact(input,fakeAsker(k=>k.startsWith('call_')?1:0),{preserveRecentMessages:0});
  assert.equal(output.messages[2],input[2]);
  assert.deepEqual((await core.compact(input,fakeAsker(0),{preserveRecentMessages:2})).messages,input);
});
test('all surviving tool results still have a matching call',async()=>{
  const input=transcript(24);
  const output=await core.compact(input,fakeAsker(k=>Number(k.match(/t(\d+)/)[1])%3===0?1:0),{preserveRecentMessages:4});
  const ids=new Set(output.messages.flatMap(m=>m.toolUses.map(u=>u.tool_use_id)));
  for(const m of output.messages)for(const result of m.toolResults??[]) assert.ok(ids.has(result.tool_use_id));
  assert.equal(output.messages[0],input[0]);
  assert.equal(output.messages.at(-1),input.at(-1));
});
