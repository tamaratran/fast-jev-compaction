import test from 'node:test';
import assert from 'node:assert/strict';
import {handlers,host,transcript,answers} from './helpers.mjs';
async function captured(options, instructions) {
  const h=handlers({apiKey:'test',preserveRecentMessages:0,...options}),$=host();let state;
  $.http.fetch=async(_url,init)=>{const request=JSON.parse(init.body);state=request.state;return {status:200,ok:true,text:JSON.stringify(answers(request.questions))};};
  await h['session.compact']($,{messages:transcript(),instructions},async()=>({native:true}));
  return state;
}
test('manual compaction instructions are included alongside the inferred task',async()=>{
  const state=await captured({},'Keep the one-time recovery code from the deployment output.');
  assert.match(state.goal,/one-time recovery code/);assert.match(state.goal,/Keep the constraint/);
});
test('manual instructions do not replace a configured goal',async()=>{
  const state=await captured({goal:'Ship the release safely'},'Retain deployment approval evidence.');
  assert.match(state.goal,/Ship the release safely/);assert.match(state.goal,/deployment approval evidence/);
});
test('an absent or blank instruction keeps the existing configured goal',async()=>{
  assert.equal((await captured({goal:'existing goal'},'   ')).goal,'existing goal');
});
