import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
export const root = new URL('.', import.meta.url).pathname;
export async function configuration() {
  const config = JSON.parse(await readFile(new URL('./agent-private.json', import.meta.url), 'utf8'));
  const url = new URL(config.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.port && url.port !== '443')) throw new Error('Only authenticated HTTPS on port 443 is supported');
  if (typeof config.token !== 'string' || config.token.length < 32) throw new Error('Agent credential is missing');
  return config;
}
export async function request(config, path, method = 'GET', body, idempotencyKey) {
  if (!/^\/v1\/[a-z0-9/-]+$/.test(path)) throw new Error('Invalid queue API path');
  const headers = {Authorization: `Bearer ${config.token}`};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  for(let attempt=0;attempt<(method==='GET'?3:1);attempt++) {
    try {
      const response = await fetch(config.url.replace(/\/$/, '') + path, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(25000), redirect: 'error',
      });
      if (!response.ok) throw Object.assign(new Error(`Queue returned HTTP ${response.status}`),{httpStatus:response.status});
      return await response.json();
    } catch(error) {
      if(method!=='GET'||error.httpStatus||attempt===2)throw error;
      // Retry only the read of the same job. Never replay a device mutation.
      await new Promise(resolve=>setTimeout(resolve,500*(attempt+1)));
    }
  }
}
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function operation(config, action, args = {}) {
  const idempotencyKey = randomUUID();
  let task;
  try { task = await request(config, '/v1/operations', 'POST', {action, args}, idempotencyKey); }
  catch {
    try {
      const existing=await request(config,'/v1/operations/'+idempotencyKey);
      if(JSON.stringify(existing.payload)!==JSON.stringify({action,args}))throw new Error('Unexpected task payload');
      task={id:idempotencyKey};
    } catch {throw new Error('Task submission could not be confirmed. Inspect task '+idempotencyKey+' and device state; never replay its mutation.');}
  }
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline) {
    await sleep(1000);
    const state = await request(config, `/v1/operations/${task.id}`);
    if (state.status === 'done') return {...state.result,operation_id:task.id};
    if (state.status === 'error') throw new Error(String(state.result?.error || 'Device operation failed').slice(0, 1000));
  }
  throw new Error(`Task ${task.id} has no result yet. Its outcome is unknown. Do not replay the operation.`);
}

// Queue the observation before execution starts so temporary playback controls
// remain visible in the returned image. Mutations are never replayed.
export async function observedOperation(config, action, args = {}, reveal) {
  if (reveal) {
    if (!['tap','swipe'].includes(action)) throw new Error('Reveal is supported only with a tap or swipe');
    const observation=await operation(config,'sequence',{steps:[
      {action:'tap',args:reveal},
      {action:'wait',args:{duration_ms:180}},
      {action,args},
    ],capture_delay_ms:150});
    return {value:{local_sequence:true},observation,observation_id:observation.operation_id};
  }
  const jobs=[];
  const steps=[...(reveal?[{action:'tap',args:reveal}]:[]),{action,args},{action:'screenshot',args:{}}];
  for(const step of steps) {
    try {jobs.push(await request(config,'/v1/operations','POST',step,randomUUID()));}
    catch {throw new Error('A step could not be confirmed. An earlier step may have executed. Inspect the screen before another mutation.');}
  }
  async function wait(id) {
    const deadline=Date.now()+150000;
    while(Date.now()<deadline) {
      const state=await request(config,'/v1/operations/'+id);
      if(state.status==='done')return state.result;
      if(state.status==='error')throw new Error(String(state.result?.error||'Device operation failed').slice(0,1000));
      await sleep(700);
    }
    throw new Error('Operation '+id+' has no result. Do not replay its mutation.');
  }
  const results=await Promise.allSettled(jobs.map(job=>wait(job.id)));
  const error=results.find(result=>result.status==='rejected');
  if(error)throw error.reason;
  return {value:results[reveal?1:0].value,observation:results[results.length-1].value,observation_id:jobs[jobs.length-1].id};
}
