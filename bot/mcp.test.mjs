import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp,writeFile,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('hosted Bot binds screenshots to a task, preserves its budget on restart and never starts the Codex goal loop',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'ios-bot-test-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const configPath=join(directory,'config-private.json');
  await writeFile(configPath,JSON.stringify({url:'https://queue.test.invalid',token:'test-only-'+ 'a'.repeat(40)}),{mode:0o600});
  const preload=join(directory,'fake-fetch.mjs');
  await writeFile(preload,`globalThis.fetch=async(url,options)=>{
    if(new URL(url).origin!=='https://queue.test.invalid')throw new Error('Unexpected host');
    if(options.method==='POST'){
      if(new URL(url).pathname!=='/v1/operations')throw new Error('Unexpected mutation');
      return Response.json({id:options.headers['Idempotency-Key']});
    }
    const id=new URL(url).pathname.split('/').pop();
    return Response.json({id,status:'done',result:{image_base64:'/9j/2Q==',mime_type:'image/jpeg'}});
  };`);
  let id=0;
  function client() {
    const process=spawn(globalThis.process.execPath,[new URL('./mcp.mjs',import.meta.url).pathname],{env:{...globalThis.process.env,IPAD_BOT_DATA_DIR:directory,IPAD_QUEUE_CONFIG:configPath,NODE_OPTIONS:'--import='+preload},stdio:['pipe','pipe','pipe']});
    const waiting=new Map();
    createInterface({input:process.stdout}).on('line',line=>{
      const response=JSON.parse(line);const pending=waiting.get(response.id);
      if(pending){clearTimeout(pending.timer);waiting.delete(response.id);pending.resolve(response.result);}
    });
    process.stderr.resume();
    return {
      call:(method,params)=>new Promise((resolve,reject)=>{const key=++id;waiting.set(key,{resolve,timer:setTimeout(()=>reject(new Error('MCP timeout')),15000)});process.stdin.write(JSON.stringify({jsonrpc:'2.0',id:key,method,params})+'\n');}),
      close:()=>new Promise(resolve=>{process.once('exit',resolve);process.stdin.end();}),
    };
  }
  let c=client();const concurrent=client();
  await concurrent.call('tools/list');
  const tools=await c.call('tools/list');
  assert.equal(tools.tools.length,13);
  const result=await c.call('tools/call',{name:'ipad_task_begin',arguments:{description:'test current image'}});
  const {task_id}=JSON.parse(result.content[0].text);
  const duplicate=await concurrent.call('tools/call',{name:'ipad_task_begin',arguments:{description:'must not overwrite another connection'}});
  assert.equal(duplicate.isError,true);
  const wrong=await c.call('tools/call',{name:'ipad_screenshot',arguments:{task_id:'00000000-0000-0000-0000-000000000000'}});
  assert.equal(wrong.isError,true);
  const shot=await concurrent.call('tools/call',{name:'ipad_screenshot',arguments:{task_id}});
  assert.equal(shot.isError,undefined);
  const evidence=JSON.parse(shot.content.at(-1).text);
  assert.equal(evidence.task_id,task_id);
  assert.deepEqual(await readFile(evidence.screenshot_path),Buffer.from('/9j/2Q==','base64'));
  assert.equal((await stat(evidence.screenshot_path)).mode & 0o777,0o600);
  await c.close();c=client();
  const second=await c.call('tools/call',{name:'ipad_task_begin',arguments:{description:'must not reset active task'}});
  assert.equal(second.isError,true);
  assert.equal(JSON.parse(await readFile(join(directory,'task-private.json'),'utf8')).calls,1);
  const noEvidence=await c.call('tools/call',{name:'ipad_task_end',arguments:{task_id,outcome:'success',summary:'unproven'}});
  assert.equal(noEvidence.isError,true);
  const complete=await c.call('tools/call',{name:'ipad_task_end',arguments:{task_id,outcome:'success',summary:'verified fixture',evidence_operation_id:evidence.operation_id}});
  assert.equal(JSON.parse(complete.content[0].text).status,'success');
  const next=await c.call('tools/call',{name:'ipad_task_begin',arguments:{description:'next user request'}});
  assert.notEqual(JSON.parse(next.content[0].text).task_id,task_id);
  await c.close();await concurrent.close();
});
