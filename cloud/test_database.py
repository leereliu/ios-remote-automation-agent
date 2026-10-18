"""Exercise the production SQL against SQLite; no deployed data is touched."""
import json
import sqlite3
import sys

sql = json.load(sys.stdin)
db = sqlite3.connect(':memory:')
db.row_factory = sqlite3.Row
db.executescript(sql['schema'])
# Simulate an existing installation before the expiration index was introduced.
db.execute('DROP INDEX jobs_expires')
db.execute('DROP INDEX jobs_pending_expiry')
for i in range(250):
    db.execute('INSERT INTO jobs(id,kind,device_id,status,payload,created_at,expires_at) VALUES(?,?,?,?,?,?,?)',
               (str(i), 'operation', 'test-ipad', 'done', '{}', i, i))
for identifier, status, expiry in [('live', 'running', 2000), ('recent', 'done', 1001), ('boundary', 'done', 1000)]:
    db.execute('INSERT INTO jobs(id,kind,device_id,status,payload,created_at,expires_at) VALUES(?,?,?,?,?,?,?)',
               (identifier, 'operation', 'test-ipad', status, '{}', 0, expiry))
db.executescript(sql['schema'])
db.executescript(sql['schema'])  # migrations must preserve rows and be repeatable
assert db.execute('SELECT count(*) FROM jobs').fetchone()[0] == 253
plan = [row['detail'] for row in db.execute('EXPLAIN QUERY PLAN '+sql['cleanup'], (1000,))]
assert any('USING COVERING INDEX jobs_expires' in row for row in plan), plan
assert not any('SCAN jobs' in row for row in plan), plan
db.execute(sql['cleanup'], (1000,))
assert db.execute('SELECT count(*) FROM jobs').fetchone()[0] == 153
assert db.execute('SELECT min(expires_at) FROM jobs WHERE expires_at<1000').fetchone()[0] == 100
assert db.execute("SELECT count(*) FROM jobs WHERE id IN ('live','recent','boundary')").fetchone()[0] == 3

for now in range(0, 180000, 5000):
    db.execute(sql['heartbeat'], ('test-ipad', now, json.dumps({'uptime': now})))
assert db.execute('SELECT last_seen FROM device_state').fetchone()[0] == 120000
# The original insert plus two updates, not 36 heartbeat writes.
assert db.execute('SELECT total_changes()').fetchone()[0] == 356
before = db.total_changes
db.execute(sql['heartbeat'], ('test-ipad', 180000, '{}'))
assert db.total_changes == before+1

for identifier, created, expires in [('expired', 0, 0), ('second', 20, 300000), ('first', 10, 300000)]:
    db.execute('INSERT INTO jobs(id,kind,device_id,status,payload,created_at,expires_at) VALUES(?,?,?,?,?,?,?)',
               (identifier, 'operation', 'test-ipad', 'pending', '{}', created, expires))
claimed=[]
plan=[row['detail'] for row in db.execute('EXPLAIN QUERY PLAN '+sql['claim'],(200000,'operation','test-ipad',200000))]
assert any('jobs_pending_expiry' in row and 'expires_at>?' in row for row in plan), plan
for _ in range(3):
    row=db.execute(sql['claim'],(200000,'operation','test-ipad',200000)).fetchone()
    claimed.append(row['id'] if row else None)
assert claimed == ['first','second',None], claimed
assert db.execute("SELECT status FROM jobs WHERE id='expired'").fetchone()[0] == 'pending'
print('SQLite retention/index/heartbeat/claim checks passed')
