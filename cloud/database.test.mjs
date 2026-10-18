import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {CLEANUP_SQL,CLAIM_SQL,HEARTBEAT_SQL} from './worker.mjs';

test('real SQLite verifies indexed bounded retention, heartbeat throttling and atomic claims',()=>{
  const result=spawnSync('python3',[new URL('./test_database.py',import.meta.url).pathname],{
    input:JSON.stringify({schema:readFileSync(new URL('./schema.sql',import.meta.url),'utf8'),cleanup:CLEANUP_SQL,claim:CLAIM_SQL,heartbeat:HEARTBEAT_SQL}),encoding:'utf8',
  });
  assert.equal(result.status,0,result.stderr||result.stdout);
});
