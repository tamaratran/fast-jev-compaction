import test from 'node:test';
import assert from 'node:assert/strict';

import {handlers,host,deferred,sleep} from './helpers.mjs';
test('auto-compaction claims its lock before the first async host call',async()=>{
  const h=handlers(),$=host(),usage=deferred(),done=deferred();let queries=0,compactions=0,next=0;
  $.session.usage=async()=>{queries++;return usage.promise;};$.session.compact=async()=>{compactions++;await done.promise;};
  const run=()=>h['turn.complete']($,{},async()=>{next++;return {};});
  const a=run(),b=run();usage.resolve({context:{percent:80}});await sleep(1);const c=run();
  done.resolve();await Promise.all([a,b,c]);
  assert.equal(queries,1);assert.equal(compactions,1);assert.equal(next,3);
});
test('an error releases the lock and still forwards the event',async()=>{
  const h=handlers(),$=host();let attempts=0,next=0;
  $.session.compact=async()=>{attempts++;throw Error('failed');};
  for(let i=0;i<2;i++)await h['turn.complete']($,{},async()=>{next++;return {};});
  assert.equal(attempts,2);assert.equal(next,2);
});
