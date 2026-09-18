import test from 'node:test';
import assert from 'node:assert/strict';

import {mkdtempSync,cpSync,existsSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawnSync} from 'node:child_process';
test('a clean npm pack contains the exported JavaScript and declarations',()=>{
  const source=process.env.FJC_TEST_SOURCE;const dir=mkdtempSync(join(tmpdir(),'jev-pack-'));
  try{
    for(const file of ['src','package.json','tsconfig.json','README.md','LICENSE'])if(existsSync(join(source,file)))cpSync(join(source,file),join(dir,file),{recursive:true});
    symlinkSync(join(source,'node_modules'),join(dir,'node_modules'),process.platform==='win32'?'junction':'dir');
    const npm=process.env.npm_execpath;
    const command=npm?process.execPath:(process.platform==='win32'?'npm.cmd':'npm');
    const args=[...(npm?[npm]:[]),'pack','--json','--offline','--pack-destination',dir];
    const run=spawnSync(command,args,{cwd:dir,encoding:'utf8',timeout:30_000,env:{...process.env,npm_config_update_notifier:'false'}});
    assert.equal(run.status,0,run.stderr||run.error?.message);
    const files=JSON.parse(run.stdout)[0].files.map(f=>f.path);
    assert.ok(files.includes('dist/index.js'),JSON.stringify(files));
    assert.ok(files.includes('dist/index.d.ts'),JSON.stringify(files));
  }finally{rmSync(dir,{recursive:true,force:true});}
});
