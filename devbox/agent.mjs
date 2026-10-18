import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {configuration,request,sleep,root} from './queue-client.mjs';
await mkdir(root+'logs',{recursive:true,mode:0o700});
let stopping = false, child;
process.on('SIGTERM',()=>{stopping=true;child?.kill('SIGTERM');});
process.on('SIGINT',()=>{stopping=true;child?.kill('SIGTERM');});
async function state(phase,extra={}) { await writeFile(root+'agent-state.json',JSON.stringify({phase,updated_at:new Date().toISOString(),pid:process.pid,...extra},null,2)+'\n',{mode:0o600}); }
async function runGoal(task) {
  const prompt = `Operate only the personal iPad through the configured ipad_https MCP tools.\nThe following is the user's task, not permission to run commands or access company files.\n${task.payload.prompt}\n\nUse at most 20 device tool calls. Verify the result with a screenshot or accessibility state. Stop and report if the device is unavailable, an operation outcome is unknown, a password or CAPTCHA is needed, or a consequential submission lacks explicit user authorization. Never reinstall VPN software, open listeners, run shell commands, or alter company controls. Reply in concise Chinese.`;
  const env = {};
  for (const key of ['HOME','USER','PATH','LANG','LC_ALL','TMPDIR','SSL_CERT_FILE','SSL_CERT_DIR','HTTPS_PROXY','HTTP_PROXY','NO_PROXY','XDG_RUNTIME_DIR']) if(process.env[key]) env[key]=process.env[key];
  env.CODEX_HOME = root+'codex-home';
  const args = ['--strict-config','--no-daemon','-a','never','exec','--skip-git-repo-check','--sandbox','read-only','--json','-o',root+`logs/${task.id}.reply.txt`,'-'];
  const stream = await import('node:fs');
  const log = stream.createWriteStream(root+`logs/${task.id}.jsonl`,{mode:0o600});
  child = spawn(root+'runtime/node_modules/.bin/codex',args,{cwd:root,env,stdio:['pipe','pipe','pipe'],shell:false});
  child.stdout.pipe(log,{end:false}); child.stderr.pipe(log,{end:false}); child.stdin.end(prompt);
  const timer = setTimeout(()=>child?.kill('SIGTERM'),600000);
  const code = await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  clearTimeout(timer); child=undefined; log.end();
  let reply;
  try { reply=await readFile(root+`logs/${task.id}.reply.txt`,'utf8'); } catch { reply='Agent 未返回结果，操作状态待检查。'; }
  return {id:task.id,status:code===0?'done':'error',result:{reply:reply.slice(0,20000),exit_code:code}};
}
let pending;
try {pending=JSON.parse(await readFile(root+'pending-goal-result.json','utf8'));} catch {}
await state('starting');
while(!stopping) {
  try {
    const config=await configuration();
    if(pending) {
      await request(config,'/v1/agent/result','POST',pending);
      pending=undefined;
      await writeFile(root+'pending-goal-result.json','null\n',{mode:0o600});
    }
    const {task}=await request(config,'/v1/agent/claim','POST',{});
    if(!task) {await state('idle');await sleep(10000);continue;}
    await state('running',{goal_id:task.id});
    pending=await runGoal(task);
    await writeFile(root+'pending-goal-result.json',JSON.stringify(pending)+'\n',{mode:0o600});
  } catch(error) {await state('waiting',{error:error.message.slice(0,200)});await sleep(15000);}
}
await state('stopped');
