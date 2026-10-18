import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import worker, {validateOperation, validateWait, claimOperation, CLAIM_SQL} from './worker.mjs';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const env = {CONTROLLER_TOKEN:'controller-'+ 'a'.repeat(40),AGENT_TOKEN:'agent-'+ 'b'.repeat(40),DEVICE_TOKEN:'device-'+ 'c'.repeat(40),BOT_TOKEN:'bot-'+ 'd'.repeat(40),DEVICE_ID:'test-ipad'};
const call = (path, role, body, scheme='https') => worker.fetch(new Request(`${scheme}://queue.example${path}`,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(role?{Authorization:`Bearer ${env[role]}`}:{})},body:body===undefined?undefined:JSON.stringify(body)}),env);
test('only HTTPS is accepted; health discloses no device information',async()=>{
  assert.equal((await call('/health',null,undefined,'http')).status,400);
  assert.deepEqual(await (await call('/health')).json(),{ok:true,protocol:1});
});
test('console assets contain no credentials and limit connections to the same origin',async()=>{
  const page=await call('/');const source=await page.text();
  assert.equal(page.status,200);
  assert.match(page.headers.get('Content-Security-Policy'),/connect-src 'self'/);
  for(const key of ['CONTROLLER_TOKEN','AGENT_TOKEN','DEVICE_TOKEN'])assert.ok(!source.includes(env[key]));
  const script=await(await call('/console.mjs')).text();
  assert.ok(!script.includes('localStorage'));assert.ok(!script.includes('sessionStorage'));
});
test('unauthenticated and wrong-role requests cannot access device or goal APIs',async()=>{
  assert.equal((await call('/v1/device')).status,401);
  assert.equal((await call('/v1/operations','DEVICE_TOKEN',{action:'home'})).status,403);
  assert.equal((await call('/v1/goals','AGENT_TOKEN',{prompt:'test'})).status,403);
  assert.equal((await call('/v1/device/claim','CONTROLLER_TOKEN',{device_id:'test-ipad'})).status,403);
  assert.equal((await call('/v1/device/claim','DEVICE_TOKEN',{device_id:'another-ipad'})).status,403);
  assert.equal((await call('/v1/agent/claim','DEVICE_TOKEN',{})).status,403);
});
test('bot credentials cannot submit, claim, finish or read Codex goals or impersonate the device',async()=>{
  for (const [path,body] of [
    ['/v1/goals',{prompt:'test'}], ['/v1/agent/claim',{}], ['/v1/agent/result',{}],
    ['/v1/device/claim',{device_id:'test-ipad'}], ['/v1/device/result',{}],
    ['/v1/goals/12345678-1234-1234-1234-123456789abc',undefined],
  ]) assert.equal((await call(path,'BOT_TOKEN',body)).status,403,path);
  assert.equal((await call('/v1/operations','BOT_TOKEN',{action:'shell',args:{command:'id'}})).status,400);
  assert.equal((await call('/v1/operations','BOT_TOKEN',{action:'screenshot',args:{url:'https://elsewhere.invalid'}})).status,400);
});
test('operation schema rejects forwarding, arbitrary URLs, unknown arguments and bad coordinates',()=>{
  for(const value of [
    {action:'shell',args:{command:'id'}},
    {action:'fetch',args:{url:'https://example.com'}},
    {action:'screenshot',args:{url:'https://example.com'}},
    {action:'home',destination:'10.0.0.1'},
    {action:'tap',args:{x:-1,y:0}},
    {action:'tap',args:{x:'1',y:0}},
    {action:'swipe',args:{from_x:0,from_y:0,to_x:1,to_y:1,duration:99}},
    {action:'launch',args:{bundle_id:'../../etc/passwd'}},
    {action:'type',args:{text:'x'.repeat(4097)}},
  ]) assert.throws(()=>validateOperation(value));
  assert.deepEqual(validateOperation({action:'tap',args:{x:12,y:32}}),{action:'tap',args:{x:12,y:32}});
});
test('local sequences validate every step before execution and remain bounded',()=>{
  const sequence={action:'sequence',args:{steps:[
    {action:'tap',args:{x:365,y:220}},
    {action:'wait',args:{duration_ms:200}},
    {action:'swipe',args:{from_x:246,from_y:420,to_x:300,to_y:420,duration:0.3}},
  ],capture_delay_ms:200}};
  assert.deepEqual(validateOperation(sequence),sequence);
  for(const value of [
    {action:'sequence',args:{steps:[]}},
    {action:'sequence',args:{steps:Array(13).fill({action:'tap',args:{x:1,y:1}})}},
    {action:'sequence',args:{steps:[{action:'sequence',args:sequence.args}]}},
    {action:'sequence',args:{steps:[{action:'fetch',args:{url:'https://example.com'}}]}},
    {action:'sequence',args:{steps:[{action:'tap',args:{x:1,y:1}},{action:'tap',args:{x:-1,y:2}}]}},
    {action:'sequence',args:{steps:[{action:'wait',args:{duration_ms:2001}}]}},
    {action:'sequence',args:{steps:Array(5).fill({action:'wait',args:{duration_ms:2000}})}},
    {action:'sequence',args:{steps:sequence.args.steps,capture_delay_ms:-1}},
    {action:'sequence',args:{steps:[{action:'wait',args:{duration_ms:1,extra:true}}]}},
  ])assert.throws(()=>validateOperation(value));
});

function virtualQueue(arrivals=[]) {
  let now=0, checks=0;
  const delivered=[];
  const timing={now:()=>now,sleep:async ms=>{now+=ms;}};
  const queue={DEVICE_ID:'test-ipad',DB:{prepare(sql){
    assert.equal(sql,CLAIM_SQL);
    return {bind(){return this;},async first(){
      checks++;
      const index=arrivals.findIndex(item=>item.at<=now);
      if(index<0)return null;
      const [item]=arrivals.splice(index,1);delivered.push(item.id);
      return {id:item.id,payload:'{"action":"status","args":{}}',result:null};
    }};
  }}};
  return {queue,timing,delivered,get now(){return now;},get checks(){return checks;}};
}
test('long claims return queued work immediately and bound arrival latency across reconnects',async()=>{
  for(const at of [0,1,4999,5000,5001,14999,15001,19999]) {
    const v=virtualQueue([{at,id:'one'}]);
    let task=await claimOperation(v.queue,20000,undefined,v.timing);
    if(!task){await v.timing.sleep(250);task=await claimOperation(v.queue,20000,undefined,v.timing);}
    assert.equal(task.id,'one');assert.ok(v.now-at<=5250,`${at}: ${v.now-at}`);
    assert.deepEqual(v.delivered,['one']);
  }
});
test('idle holds bound D1 checks, preserve legacy immediate claims and honour cancellation',async()=>{
  const v=virtualQueue();
  assert.equal(await claimOperation(v.queue,20000,undefined,v.timing),null);
  assert.equal(v.now,20000);assert.equal(v.checks,4);
  const legacy=virtualQueue();
  assert.equal(await claimOperation(legacy.queue,0,undefined,legacy.timing),null);
  assert.equal(legacy.now,0);assert.equal(legacy.checks,1);
  const abort=new AbortController();abort.abort();
  await assert.rejects(claimOperation(v.queue,20000,abort.signal,v.timing),{status:499});
  const during=new AbortController(),q=virtualQueue();
  const timing={...q.timing,sleep:async ms=>{await q.timing.sleep(ms);during.abort();}};
  await assert.rejects(claimOperation(q.queue,20000,during.signal,timing),{status:499});
  assert.equal(q.checks,1);
  for(const bad of [-1,20001,1.5,'20000',null])assert.throws(()=>validateWait(bad));
  assert.equal(validateWait(),0);
});
test('device claim validates wait before touching D1 and advertises heartbeat freshness',async()=>{
  assert.equal((await call('/v1/device/claim','DEVICE_TOKEN',{device_id:'test-ipad',wait_ms:20001})).status,400);
  const old=env.DB;
  try {
    env.DB={prepare(){return {bind(){return this;},async first(){return {last_seen:123,metadata:'{}'};}};}};
    const response=await call('/v1/device','BOT_TOKEN');
    assert.deepEqual(await response.json(),{last_seen:123,metadata:'{}',heartbeat_interval_ms:60000,stale_after_ms:120000});
  } finally {env.DB=old;}
});
