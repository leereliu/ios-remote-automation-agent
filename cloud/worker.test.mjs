import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import worker, {validateOperation} from './worker.mjs';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const env = {CONTROLLER_TOKEN:'controller-'+ 'a'.repeat(40),AGENT_TOKEN:'agent-'+ 'b'.repeat(40),DEVICE_TOKEN:'device-'+ 'c'.repeat(40),DEVICE_ID:'test-ipad'};
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
