#!/usr/bin/env node
// Runs on the hosted Bot computer. No model API, goal runner or local Mac access.
import {createInterface} from 'node:readline';
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir,rename,open,unlink} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {request} from '../devbox/queue-client.mjs';

const directory=resolve(process.env.IPAD_BOT_DATA_DIR || new URL('../.local/bot/',import.meta.url).pathname);
const configPath=resolve(process.env.IPAD_QUEUE_CONFIG || join(directory,'config-private.json'));
const statePath=join(directory,'task-private.json');
const lockPath=join(directory,'task-lock-private.json');
const artifacts=resolve(process.env.IPAD_ARTIFACT_DIR || join(directory,'screenshots'));
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
let backend, backendTaskId, backendId=0, current, serial=Promise.resolve();
const pending=new Map();
await mkdir(directory,{recursive:true,mode:0o700});
await mkdir(artifacts,{recursive:true,mode:0o700});
try {current=JSON.parse(await readFile(statePath,'utf8'));} catch(error) {if(error.code!=='ENOENT')throw error;}
async function save() {
  const temp=statePath+'.tmp-'+randomUUID();
  await writeFile(temp,JSON.stringify(current,null,2)+'\n',{mode:0o600});
  await rename(temp,statePath);
}
async function config() {
  const value=JSON.parse(await readFile(configPath,'utf8'));
  const url=new URL(value.url);
  if(url.protocol!=='https:' || url.port && url.port!=='443' || url.username || url.password || url.search || url.hash)throw new Error('HTTPS on port 443 is required');
  if(typeof value.token!=='string' || value.token.length<32)throw new Error('Bot runtime credential is missing');
  return value;
}
function rpc(method,params) {
  return new Promise((resolvePromise,reject)=>{
    const id=++backendId;
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Backend response timed out; inspect the original operation. Never replay it.'));},170000);
    pending.set(id,{resolve:resolvePromise,reject,timer});
    backend.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  });
}
async function startBackend() {
  if(backend)return;
  // Only this repository's fixed-device MCP is launched, using Node directly.
  const child=spawn(process.execPath,[new URL('../devbox/mcp.mjs',import.meta.url).pathname],{
    env:{...process.env,IPAD_QUEUE_CONFIG:configPath,IPAD_TOOL_BUDGET:String(current?.tool_budget??20)},stdio:['pipe','pipe','pipe'],shell:false,
  });
  backend=child;
  backendTaskId=current?.id;
  createInterface({input:child.stdout}).on('line',line=>{
    let message;try{message=JSON.parse(line);}catch{return;}
    const item=pending.get(message.id);if(!item)return;
    clearTimeout(item.timer);pending.delete(message.id);
    if(message.error)item.reject(new Error(message.error.message));else item.resolve(message.result);
  });
  child.stderr.resume();
  child.on('error',()=>failBackend(child));child.on('exit',()=>failBackend(child));
  await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'hosted-bot-bridge',version:'1.0.0'}});
}
function failBackend(child) {
  if(backend!==child)return;
  backend=undefined;
  for(const item of pending.values()){clearTimeout(item.timer);item.reject(new Error('Device MCP stopped; do not replay an uncertain action.'));}
  pending.clear();
}
function stopBackend() {const process=backend;backend=undefined;backendTaskId=undefined;process?.kill('SIGTERM');}
const taskIdSchema={type:'string',pattern:'^[a-f0-9-]{36}$'};
const additional=[
  {name:'ipad_queue_status',description:'Read the configured iPad heartbeat over HTTPS. Does not submit a device action.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  {name:'ipad_task_begin',description:'Begin one user-requested task. Required before any device tool. Defaults to 20 tool calls and ten minutes. For an explicitly requested bulk workflow, choose up to 100 calls and 30 minutes. Set archive_images=false when only aggregate results are requested. Never create a replacement task to bypass a budget or uncertain result.',inputSchema:{type:'object',properties:{description:{type:'string',minLength:1,maxLength:1000},tool_budget:{type:'integer',minimum:1,maximum:100},timeout_minutes:{type:'integer',minimum:1,maximum:30},archive_images:{type:'boolean'}},required:['description'],additionalProperties:false}},
  {name:'ipad_task_end',description:'Record the actual task outcome. For success, evidence_operation_id must identify an image returned during this task. Attach an existing screenshot only when requested and archive_images is enabled; aggregate-only tasks can use the observation operation ID without attaching a personal image.',inputSchema:{type:'object',properties:{task_id:taskIdSchema,outcome:{enum:['success','failed','needs_user']},summary:{type:'string',maxLength:2000},evidence_operation_id:taskIdSchema},required:['task_id','outcome','summary'],additionalProperties:false}},
];
async function listTools() {
  await startBackend();
  const {tools}=await rpc('tools/list');
  return {tools:[...additional,...tools.map(tool=>({...tool,inputSchema:{...tool.inputSchema,properties:{...tool.inputSchema.properties,task_id:taskIdSchema},required:[...(tool.inputSchema.required||[]),'task_id']},description:tool.description+' Images are saved only when the active task enables archive_images; in that mode attach screenshot_path directly when requested. With archive_images=false, use observations for navigation and return aggregate results without personal image attachments.'}))]};
}
async function imageArtifacts(result) {
  const textContent=(result.content||[]).filter(c=>c.type==='text').map(c=>c.text);
  let operationId;
  for(const value of textContent){try{const metadata=JSON.parse(value);operationId=metadata.observation_id||metadata.operation_id||operationId;}catch{}}
  if(!operationId || !/^[a-f0-9-]{36}$/.test(operationId))return result;
  const images=(result.content||[]).filter(c=>c.type==='image');
  if(images.length>1)throw new Error('Ambiguous screenshot response');
  if(!images.length)return result;
  const image=images[0],bytes=Buffer.from(image.data,'base64');
  if(image.mimeType!=='image/jpeg' || bytes.length>500000 || bytes[0]!==0xff || bytes[1]!==0xd8)throw new Error('Invalid JPEG response');
  let screenshotPath;
  if(current.archive_images!==false){
    screenshotPath=join(artifacts,current.id+'-'+operationId+'.jpg');
    await writeFile(screenshotPath,bytes,{mode:0o600});
  }
  current.evidence.push({operation_id:operationId,...(screenshotPath?{screenshot_path:screenshotPath}:{}),captured_at:new Date().toISOString()});
  await save();
  return {...result,content:[...result.content,{type:'text',text:JSON.stringify({task_id:current.id,operation_id:operationId,...(screenshotPath?{screenshot_path:screenshotPath,attach_this_existing_file:true}:{archive_images:false})})}]};
}
async function callTool(name,args={}) {
  if(name==='ipad_queue_status')return {content:[{type:'text',text:JSON.stringify(await request(await config(),'/v1/device'))}]};
  if(name==='ipad_task_begin') {
    if(current?.status==='running')throw new Error('Task '+current.id+' is still active. Inspect or finish it; do not create another task.');
    if(typeof args.description!=='string'||!args.description.trim()||args.description.length>1000)throw new Error('Task description required');
    const budget=args.tool_budget??20,minutes=args.timeout_minutes??10,archive=args.archive_images??true;
    if(!Number.isInteger(budget)||budget<1||budget>100||!Number.isInteger(minutes)||minutes<1||minutes>30||typeof archive!=='boolean')throw new Error('Invalid task limits or archive_images option');
    current={id:randomUUID(),description:args.description,status:'running',started_at:Date.now(),deadline:Date.now()+minutes*60000,tool_budget:budget,archive_images:archive,calls:0,evidence:[]};
    await save();stopBackend();
    return {content:[{type:'text',text:JSON.stringify({task_id:current.id,tool_budget:current.tool_budget,archive_images:current.archive_images,deadline:current.deadline})}]};
  }
  if(!current || current.status!=='running' || args.task_id!==current.id)throw new Error('An active matching task_id is required');
  if(name==='ipad_task_end') {
    if(!['success','failed','needs_user'].includes(args.outcome)||typeof args.summary!=='string'||args.summary.length>2000)throw new Error('Valid outcome and summary required');
    if(current.uncertain)throw new Error('Task outcome is uncertain. Device state and the original operation require human review before another task.');
    if(args.outcome==='success'&&!current.evidence.some(e=>e.operation_id===args.evidence_operation_id))throw new Error('Success requires screenshot evidence from this task');
    current={...current,status:args.outcome,summary:args.summary,finished_at:Date.now(),evidence_operation_id:args.evidence_operation_id};
    await save();stopBackend();
    return {content:[{type:'text',text:JSON.stringify(current)}]};
  }
  if(Date.now()>current.deadline)throw new Error('Task deadline reached. Report failure; do not begin another task automatically.');
  if(current.uncertain&&!['ipad_status','ipad_screenshot','ipad_read_screen','ipad_foreground'].includes(name))throw new Error('An earlier action is uncertain. Only read-only inspection is permitted pending human review.');
  if(current.calls>=(current.tool_budget??20))throw new Error('Task reached its '+(current.tool_budget??20)+'-tool budget. Report partial completion; do not begin another task automatically.');
  if(backend && backendTaskId!==current.id)stopBackend();
  const known=await listTools();
  if(!known.tools.some(t=>t.name===name&&!additional.some(a=>a.name===name)))throw new Error('Unknown device tool');
  const {task_id,...argumentsValue}=args;
  current.calls++;current.in_flight={tool:name,started_at:Date.now()};await save();
  let result;
  try {result=await rpc('tools/call',{name,arguments:argumentsValue});}
  catch(error){current.uncertain=true;await save();throw error;}
  delete current.in_flight;await save();
  if(result.isError && /unknown|could not be confirmed|no result|timed out|unconfirmed|may have executed/i.test(JSON.stringify(result))) {current.uncertain=true;await save();}
  return imageArtifacts(result);
}
async function lockedCall(name,args) {
  if(name==='ipad_queue_status')return callTool(name,args);
  let lock;
  try {lock=await open(lockPath,'wx',0o600);}catch(error){
    if(error.code==='EEXIST')throw new Error('Another MCP process owns the device task lock. Wait for its current call. A stale lock requires manual review; do not bypass it.');
    throw error;
  }
  try {
    await lock.writeFile(JSON.stringify({pid:process.pid,created_at:Date.now()}));
    try {current=JSON.parse(await readFile(statePath,'utf8'));}catch(error){if(error.code==='ENOENT')current=undefined;else throw error;}
    if(current?.in_flight){current.uncertain=true;await save();}
    return await callTool(name,args);
  } finally {await lock.close();await unlink(lockPath);}
}
async function handle(message) {
  if(message.id===undefined)return;
  try {
    let result;
    if(message.method==='initialize')result={protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'ios-remote-bot',version:'1.0.0'},instructions:'Control only the configured personal iPad. Use the hosted Bot model directly; never start Codex or the Devbox goal agent. Begin one task, use its task_id, verify the result, attach a saved JPEG only if requested and image archiving is enabled, then end the task. Never replay uncertain actions.'};
    else if(message.method==='ping')result={};
    else if(message.method==='tools/list')result=await listTools();
    else if(message.method==='tools/call') {
      try{result=await lockedCall(message.params?.name,message.params?.arguments);}catch(error){result={isError:true,content:[{type:'text',text:error.message}]};}
    } else {send({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Method not found'}});return;}
    send({jsonrpc:'2.0',id:message.id,result});
  } catch {send({jsonrpc:'2.0',id:message.id,error:{code:-32603,message:'Bot adapter failed; do not replay a device action.'}});}
}
createInterface({input:process.stdin}).on('line',line=>{
  let message;try{message=JSON.parse(line);}catch{send({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Invalid JSON'}});return;}
  serial=serial.then(()=>handle(message));
}).on('close',()=>{serial.finally(()=>{stopBackend();process.exit();});});
process.on('SIGTERM',()=>{stopBackend();process.exit();});
