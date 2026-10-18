import test from 'node:test';
import assert from 'node:assert/strict';
import {request,operation} from './queue-client.mjs';
const config={url:'https://test.invalid',token:'a'.repeat(40)};
test('a truncated result retries only the identical read',async t=>{
  const calls=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    calls.push({url,method:options.method});
    if(calls.length===1)return {ok:true,json:async()=>{throw new Error('terminated');}};
    return Response.json({status:'done'});
  });
  assert.deepEqual(await request(config,'/v1/operations/abc'),{status:'done'});
  assert.deepEqual(calls,[{url:'https://test.invalid/v1/operations/abc',method:'GET'},{url:'https://test.invalid/v1/operations/abc',method:'GET'}]);
});
test('an unconfirmed submission is recovered by its original id without a second mutation',async t=>{
  const calls=[];let identifier;
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    calls.push({url,method:options.method});
    if(options.method==='POST'){
      identifier=options.headers['Idempotency-Key'];
      throw new Error('connection reset after submission');
    }
    assert.equal(url,config.url+'/v1/operations/'+identifier);
    return Response.json({id:identifier,status:'done',payload:{action:'tap',args:{x:12,y:30}},result:{captured:true}});
  });
  const result=await operation(config,'tap',{x:12,y:30});
  assert.equal(result.captured,true);
  assert.equal(result.operation_id,identifier);
  assert.equal(calls.filter(c=>c.method==='POST').length,1);
});
test('an access rejection is returned immediately',async t=>{
  let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('',{status:403});});
  await assert.rejects(request(config,'/v1/device'),/HTTP 403/);
  assert.equal(calls,1);
});
