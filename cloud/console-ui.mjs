export const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>家中 iPad</title><link rel="stylesheet" href="/console.css"><script type="module" src="/console.mjs"></script></head><body><main><header><div><p class="eyebrow">个人设备控制台</p><h1>家中 iPad</h1></div><span id="device-state" class="pill">尚未连接</span></header><section id="login" class="card"><h2>连接设备</h2><p>控制钥匙仅在当前页面内存中使用。</p><form id="login-form"><label for="access-key">控制钥匙</label><input id="access-key" type="password" autocomplete="off" required minlength="32"><button>连接</button></form></section><section id="controls" class="card" hidden><div class="row"><h2>发送任务</h2><button id="logout" class="secondary">退出</button></div><p>任务由开发机后台执行。密码和系统确认仍由本人处理。</p><form id="task-form"><label for="prompt">希望 iPad 完成什么？</label><textarea id="prompt" rows="4" maxlength="4000" required placeholder="例如：打开设置，截图确认当前页面。"></textarea><button id="submit">发送任务</button></form><div class="row actions"><button id="photo" class="secondary">查看截图</button><button id="resume" class="secondary" hidden>继续查询原任务</button></div><p id="task-state" role="status"></p><pre id="reply"></pre><img id="screen" alt="iPad 截图" hidden></section><p id="message" role="status"></p><footer>iPad 需要联网，自动化执行器需要保持运行。</footer></main></body></html>`;

export const css = `:root{font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#18232e;background:#f3f5f7}*{box-sizing:border-box}body{margin:0}main{max-width:780px;margin:auto;padding:30px 20px}header,.row{display:flex;align-items:center;justify-content:space-between;gap:16px}header{margin-bottom:24px}.eyebrow{font-size:13px;color:#61717f;margin:0}h1{font-size:30px;margin:0}h2{font-size:20px;margin:0 0 12px}p{color:#526371}label{display:block;font-weight:600;margin:14px 0 7px}input,textarea{display:block;width:100%;font:inherit;border:1px solid #bbc6ce;border-radius:10px;padding:12px;background:#fff;color:#18232e}textarea{resize:vertical}button{font:inherit;font-weight:600;color:#fff;background:#185ed3;border:0;border-radius:10px;padding:11px 19px;cursor:pointer}form button{margin-top:15px}.secondary{background:#edf2f8;color:#244368;padding:8px 15px}.card{background:#fff;border:1px solid #dfe5ea;border-radius:18px;padding:24px;box-shadow:0 8px 30px #233d5010}.pill{font-size:13px;border-radius:999px;background:#e7edf2;padding:6px 12px;white-space:nowrap}.pill.online{background:#e0f2e6;color:#19683b}.pill.offline{background:#fff0d8;color:#885713}.actions{justify-content:flex-start;margin-top:18px;flex-wrap:wrap}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;background:#f5f7fa;border-radius:10px;padding:16px}pre:empty{display:none}img{display:block;width:100%;height:auto;margin-top:18px;border-radius:12px;border:1px solid #dde4e9}footer{margin:24px 0;color:#77838d;font-size:13px}[hidden]{display:none!important}button:disabled{opacity:.5;cursor:wait}#message{color:#a43b27}#task-state{font-size:14px;overflow-wrap:anywhere}@media(max-width:480px){main{padding:20px 14px}.card{padding:19px}header{align-items:flex-start;gap:8px}h1{font-size:27px}}`;

export const js = String.raw`
const $=id=>document.getElementById(id);
let token='', current=null, imageURL=null, monitoring=false;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function api(path,body,id) {
  const r=await fetch(path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,...(body===undefined?{}:{'Content-Type':'application/json'}),...(id?{'Idempotency-Key':id}:{})},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(25000)});
  if(!r.ok) throw new Error(r.status===401?'控制钥匙无效，请重新连接。':'请求失败，HTTP '+r.status);
  return r.json();
}
function message(value){$('message').textContent=value;}
function busy(value){$('submit').disabled=value;$('photo').disabled=value;}
async function heartbeat(){
  if(!token)return;
  try {
    const state=await api('/v1/device');
    const age=state?Math.max(0,Math.floor((Date.now()-state.last_seen)/1000)):null;
    $('device-state').textContent=age===null?'等待设备上线':age<30?'设备在线':'上次在线 '+age+' 秒前';
    $('device-state').className='pill '+(age!==null&&age<30?'online':'offline');
  } catch(error){$('device-state').textContent='连接待检查';$('device-state').className='pill offline';}
}
async function connect(){
  token=$('access-key').value.trim();message('');
  try {await api('/v1/device');$('access-key').value='';$('login').hidden=true;$('controls').hidden=false;await heartbeat();}
  catch(error){token='';message(error.message);}
}
$('login-form').addEventListener('submit',event=>{event.preventDefault();connect();});
$('logout').addEventListener('click',()=>{token='';current=null;$('login').hidden=false;$('controls').hidden=true;$('reply').textContent='';$('task-state').textContent='';$('screen').hidden=true;$('device-state').textContent='尚未连接';$('device-state').className='pill';if(imageURL)URL.revokeObjectURL(imageURL);imageURL=null;});
function showImage(result){
  if(!result.image_base64)throw new Error('截图结果为空。');
  const bytes=Uint8Array.from(atob(result.image_base64),c=>c.charCodeAt(0));
  if(imageURL)URL.revokeObjectURL(imageURL);
  imageURL=URL.createObjectURL(new Blob([bytes],{type:result.mime_type}));
  $('screen').src=imageURL;$('screen').hidden=false;
}
async function monitor(){
  if(!current||monitoring)return;
  monitoring=true;busy(true);$('resume').hidden=true;
  const task=current;const deadline=Date.now()+(task.kind==='goals'?650000:170000);
  try {
    while(token&&current===task&&Date.now()<deadline){
      const state=await api('/v1/'+task.kind+'/'+task.id);
      $('task-state').textContent=(state.status==='pending'?'等待领取':state.status==='running'?'正在执行':'已收到结果')+' · '+task.id;
      if(state.status==='done'||state.status==='error'){
        current=null;
        if(task.kind==='goals')$('reply').textContent=state.result?.reply||'Agent 未返回说明。';
        else if(state.status==='done')showImage(state.result);
        if(state.status==='error')throw new Error(state.result?.error||'任务执行未成功。');
        if(task.kind==='goals'&&token){monitoring=false;busy(false);await photo();return;}
        return;
      }
      await delay(2000);
    }
    if(current===task)throw new Error('暂未收到结果。可继续查询这条任务，操作状态待核查。');
  }catch(error){message(error.message);$('resume').hidden=!current;}
  finally{monitoring=false;busy(false);await heartbeat();}
}
async function submit(kind,body){
  if(current){message('当前任务尚未结束，可以继续查询原任务。');return;}
  message('');const task={kind,id:crypto.randomUUID()};current=task;busy(true);
  $('task-state').textContent='正在提交 · '+task.id;
  try{await api('/v1/'+kind,body,task.id);await monitor();}
  catch(error){message('提交结果待核查：'+error.message);$('resume').hidden=false;busy(false);}
}
async function photo(){await submit('operations',{action:'screenshot',args:{}});}
$('task-form').addEventListener('submit',event=>{event.preventDefault();const prompt=$('prompt').value.trim();if(prompt)submit('goals',{prompt});});
$('photo').addEventListener('click',photo);
$('resume').addEventListener('click',monitor);
setInterval(heartbeat,10000);
const incoming=new URLSearchParams(location.hash.slice(1)).get('key');
if(incoming){history.replaceState(null,'',location.pathname);$('access-key').value=incoming;connect();}
`;
