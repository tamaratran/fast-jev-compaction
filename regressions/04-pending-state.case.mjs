import test from 'node:test';
import assert from 'node:assert/strict';

import {core,call,result,message} from './helpers.mjs';
test('pending tool calls are visible to the classifier without becoming candidates',()=>{
  const input=[message('user','start'),call('old'),result('old'),call('pending','Bash',{command:'deploy --unique-pending-marker'})];
  const calls=core.collectToolCalls(input,0);
  assert.equal(calls.length,1);
  const fitted=core.fitState(input,calls,core.resolveOptions());
  assert.match(JSON.stringify(fitted.state),/unique-pending-marker/);
  assert.equal(fitted.state.history.find(e=>e.i===3).pending_calls[0].tool_use_id,'pending');
  assert.equal(fitted.state.history.find(e=>e.i===3).tool_calls,undefined);
});
test('pending calls survive deeper fitting alongside completed calls',()=>{
  const input=[message('user','start')];
  for(let i=0;i<30;i++){const m=call('c'+i);if(i===5)m.toolUses.push({tool_use_id:'pending',tool:'Deploy',input:{target:'pending-marker'}});input.push(m,result('c'+i));}
  input.push(message('user','done'));
  const calls=core.collectToolCalls(input,0);
  const full=core.fitState(input,calls,core.resolveOptions());
  const fitted=core.fitState(input,calls,core.resolveOptions({maxStateTokens:Math.floor(full.tokens*0.6),preserveRecentMessages:0}));
  assert.notEqual(fitted.stage,'full');
  assert.match(JSON.stringify(fitted.state),/pending-marker/);
  assert.ok(fitted.tokens<=Math.floor(full.tokens*0.6));
});
