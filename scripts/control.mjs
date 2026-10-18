#!/usr/bin/env node
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
const root = new URL('../',import.meta.url);
const configPath = process.env.IPAD_QUEUE_CONFIG || new URL('.local/queue-private.json',root);
const config = JSON.parse(await readFile(configPath,'utf8'));
const base = new URL(config.url);
if(base.protocol!=='https:' || base.username || base.password || base.search || base.hash || (base.port && base.port!=='443')) throw new Error('HTTPS on port 443 is required');
async function api(path,body,key) {
  const response = await fetch(config.url+path,{method:body===undefined?'GET':'POST',
    headers:{Authorization:'Bearer '+config.controller_token,...(body===undefined?{}:{'Content-Type':'application/json'}),...(key?{'Idempotency-Key':key}:{})},
    body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(25000)});
  if(!response.ok) throw new Error('Queue HTTP '+response.status);
  return response.json();
}
const [command,...args]=process.argv.slice(2);
const validActions=['status','screenshot','source','home','launch','tap','swipe','type','foreground','sequence'];
try {
  if(command==='status') console.log(JSON.stringify(await api('/v1/device'),null,2));
  else if(['op','goal','wait'].includes(command)) {
    const kind=command==='wait'?args[0]:command==='op'?'operations':'goals';
    if(!['operations','goals'].includes(kind)) throw new Error('Expected operations or goals');
    let id=command==='wait'?args[1]:randomUUID();
    if(!/^[a-f0-9-]{36}$/.test(id||'')) throw new Error('Invalid task id');
    if(command!=='wait') {
      if(command==='op' && !validActions.includes(args[0])) throw new Error('Unsupported operation');
      const payload=command==='op'?{action:args[0],args:JSON.parse(args[1]||'{}')}:{prompt:args.join(' ')};
      console.log('任务编号：'+id);
      // Never automatically replay a submission whose outcome is unknown.
      await api('/v1/'+kind,payload,id);
    }
    const deadline=Date.now()+(kind==='goals'?650000:170000);
    let finished=false;
    while(Date.now()<deadline) {
      const task=await api('/v1/'+kind+'/'+id);
      if(['done','error'].includes(task.status)) {
        const result=task.result||{};
        if(result.image_base64) {
          await mkdir(new URL('outputs/ipad-screenshots/',root),{recursive:true});
          const path=new URL('outputs/ipad-screenshots/'+id+'.jpg',root);
          await writeFile(path,Buffer.from(result.image_base64,'base64'),{mode:0o600});
          delete result.image_base64; result.screenshot_path=decodeURIComponent(path.pathname);
        }
        console.log(JSON.stringify({...task,result},null,2));
        process.exitCode=task.status==='error'?1:0;finished=true;break;
      }
      await new Promise(resolve=>setTimeout(resolve,2000));
    }
    if(!finished) throw new Error('尚未收到结果，操作状态待核查。可用 wait 查询原任务，请勿自动重复提交。');
  } else console.log('用法：\n  node ipad-https-control.mjs status\n  node ipad-https-control.mjs op screenshot\n  node ipad-https-control.mjs op launch \'{"bundle_id":"com.apple.Preferences"}\'\n  node ipad-https-control.mjs goal "返回主屏幕并截图"\n  node ipad-https-control.mjs wait operations <任务编号>');
} catch(error) {console.error(error.message);process.exitCode=2;}
