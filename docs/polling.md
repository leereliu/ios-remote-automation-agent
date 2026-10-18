# Polling and Cloudflare usage

The device uses adaptive **HTTPS long polling**. After successive empty responses,
the server hold window increases from 5 to 10 to 20 seconds. The next claim starts
after a 250 ms gap. Inside each held request the Worker checks D1 immediately and
then every 5 seconds. A queued operation returns as soon as a check claims it;
the hold window does not add a 20-second sleep before looking for work.

After a result is accepted, the runner resets to the 5-second hold window and
starts its next claim after 500 ms. This keeps successive steps responsive.
No additional service, listener, VPN, WebSocket or paid resource is required.
There is no reliance on isolate-local memory or a warm Worker receiving both
the submission and claim requests.

## Expected usage

For one continuously idle runner, excluding network/database overhead:

| Metric | Previous device implementation | New device implementation |
| --- | --- | --- |
| Worker claim requests per day | 17,280 at 5-second gaps | About 4,270 at 20-second holds and 250 ms gaps |
| Heartbeat rows written per day | About one per claim | At most 1,440, one per minute |
| Queue check interval | 5 seconds plus request overhead | 5 seconds within a request, plus D1 latency; reconnect gaps add transport overhead |
| Network-error retry gap | 15 seconds | 15, 30, then 60 seconds; reset after success |

These are design estimates, not a full-day measurement. The earlier measured idle
baseline was about 15,984 device requests and 14,832 heartbeat writes per day when
extrapolated from ten minutes. Compared with that baseline, the estimates imply
about 73% fewer requests and 90% fewer heartbeat writes. Operations, result reads,
retries and other controllers add usage. The optional legacy Agent still polls
goals every 10 seconds; hosted Bot deployments can leave that loop disabled.

Long polling primarily reduces Worker invocations. It deliberately continues D1
checks every 5 seconds to preserve responsiveness. Empty heartbeat attempts still
read the indexed device row; the conditional upsert avoids rewriting it. D1 reads
therefore do not decrease in the same proportion as Worker requests.

The pending-job lookup uses the covering partial index
`jobs_pending_expiry(kind,device_id,expires_at,created_at,id) WHERE status='pending'`.
An expiration range lookup skips expired pending jobs before sorting eligible
ones by creation time. This avoids repeatedly reading abandoned, expired jobs
until lazy cleanup eventually removes them. The previous `jobs_pending` index is
retained for compatibility with an older Worker during rollback. Index entries
add row writes when operations are inserted, claimed or deleted.

The state API returns `heartbeat_interval_ms: 60000` and
`stale_after_ms: 120000`. `last_seen` is the last persisted observation, so a
one-minute-old value can be healthy. Long actions and network outages can still
make the state stale. The stale threshold is an availability hint, not a guarantee
that the next operation will succeed.

## Cleanup index and retention

Deployment adds the idempotent covering index `jobs_expires(expires_at,id)`.
Cleanup finds the oldest expired rows using this index and deletes at most 100
per new job insertion. The existing cutoff remains **expiration plus 24 hours**.
This is lazy cleanup; a quiet queue has no guaranteed deletion time.

On the existing production database, the cleanup candidate query read 203 rows
before the migration and 1 row afterward, with the same cutoff and no eligible
expired records. `EXPLAIN QUERY PLAN` changed from a table scan to
`SEARCH ... USING COVERING INDEX jobs_expires`. Exact savings depend on history
size and the number of records eligible for deletion. Creating and maintaining
the index adds storage and row writes, including an additional index entry for
new jobs; those costs are included in D1 usage.

## Upgrades, failures and verification

Deploy the Worker/schema first, then rebuild and install the runner. Older
runners continue to receive immediate claims. A new runner connecting to an old
Worker falls back to the previous five-second gap if the response lacks the
long-poll acknowledgement, avoiding a request loop during rollback. Keep a
verified signed runner and private configuration for recovery.

The device allows 35 seconds of request inactivity and a 40-second resource
timeout for the bounded 20-second hold. A transient claim or upload failure backs
off to at most 60 seconds. Upload retries reuse the saved result. Claimed UI
operations are never redelivered or automatically replayed; unknown results
retain the existing manual inspection requirement.

`npm test` exercises the actual SQL against SQLite, virtual-time arrivals at
window boundaries, cancellation and the compiled C polling policy. Live checks
also need to cover native idle holds, return to active polling, harmless device
operations, network latency and the Workers Free CPU limit. HTTP wall time spent
waiting differs from CPU time; a longer request must still fit the applicable
CPU allowance. See [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
and [D1 indexing](https://developers.cloudflare.com/d1/best-practices/use-indexes/).
