import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('native polling policy bounds idle requests and resets active and failure backoff',()=>{
  const directory=mkdtempSync(join(tmpdir(),'ios-polling-'));
  try {
    const source=join(directory,'test.c'), binary=join(directory,'test');
    writeFileSync(source,`#include <assert.h>
#include "FBHTTPSPolling.h"
int main(void) {
  unsigned empty=0, requests=0; double elapsed=0;
  while(elapsed<86400) { elapsed+=FBHTTPSPollWaitMilliseconds(empty)/1000.0+0.25; requests++; if(empty<2)empty++; }
  assert(requests<4300); assert(requests>4200);
  empty=0; assert(FBHTTPSPollWaitMilliseconds(empty)==5000);
  assert(FBHTTPSPollWaitMilliseconds(1)<FBHTTPSPollWaitMilliseconds(2));
  assert(FBHTTPSPollWaitMilliseconds(1000000)==20000);
  assert(FBHTTPSRetrySeconds(1)==15); assert(FBHTTPSRetrySeconds(2)==30);
  assert(FBHTTPSRetrySeconds(1000000)==60); assert(FBHTTPSRetrySeconds(0)==15);
  return 0;
}`);
    const compile=spawnSync('cc',['-Wall','-Werror','-I',new URL('.',import.meta.url).pathname,source,'-o',binary],{encoding:'utf8'});
    assert.equal(compile.status,0,compile.stderr);
    const result=spawnSync(binary,[],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
  } finally {rmSync(directory,{recursive:true,force:true});}
});
