# Local Codex connection

Local Codex and a hosted assistant can both use the existing HTTPS operation
queue. The selected client's model plans each task. No extra background agent,
model API, VPN or inbound listener is needed for the local connection.

## Configure

1. Use Node 20.19 or newer and keep this repository at a stable absolute path.
2. Add a separate cryptographically random `codex_token` of at least 32 characters
   to the private deployment file `.local/queue-private.json`, then redeploy with
   `scripts/deploy-cloud.py`. It is bound as the optional `CODEX_TOKEN` secret and
   can be revoked independently of the hosted assistant keys. It has the same
   fixed-device operation role: heartbeat and operations, without goal or device
   claim/result access.
3. Create `.local/codex/config-private.json` with only the queue URL and that runtime
   token, in the same `{"url":"https://your-queue.example","token":"YOUR_RUNTIME_TOKEN"}`
   format as the hosted adapter. Keep its directory private and the file mode at
   `600`. Never put Cloudflare administration credentials here.
4. Register the adapter using absolute paths:

```bash
codex mcp add home-ios \
  --env IPAD_CLIENT_KIND=codex \
  --env IPAD_QUEUE_CONFIG=/absolute/repo/.local/codex/config-private.json \
  --env IPAD_BOT_DATA_DIR=/absolute/repo/.local/codex \
  --env IPAD_ARTIFACT_DIR=/absolute/repo/.local/codex/screenshots \
  -- /absolute/path/to/node /absolute/repo/bot/mcp.mjs
```

In the resulting `[mcp_servers.home-ios]` entry, set `startup_timeout_sec = 20`
and `tool_timeout_sec = 200`. The latter lets the adapter report its bounded
operation timeout instead of the default client timeout cutting it off first.
Use `codex mcp get home-ios --json` to inspect this entry. The config contains
file paths, never the runtime token. Reload the server in the desktop MCP settings
after changing configuration, or start a fresh CLI session.

The adapter advertises 13 tools: ten device actions plus `ipad_queue_status`,
`ipad_task_begin` and `ipad_task_end`. Its instructions select the current local
Codex chat as the planner. Begin one task, pass its ID to every device tool, verify
the actual result and finish the task. Budgets and uncertain results remain
persisted across server restarts. Use `ipad_sequence` for transient controls.

## Switching between clients

Choose local Codex for a local task and the hosted assistant for a cloud task.
Both configurations can stay enabled. The local Codex computer must remain awake
for its own active task; a hosted task can continue on the hosted computer.

This queue supports one device. The adapter's file lock coordinates processes on
one host; it does not reserve the iPad across hosts. The owner must serialize local
and hosted tasks. Independent keys are separate revocation controls, not isolated
result histories: authorized runtime clients can read this device's operation
results. Keep each client's task files and screenshot directory separate.

## Validation

On October 18, 2026, Codex CLI 0.163 discovered all 13 tools through its app-server
MCP inventory, without creating a model turn. The saved global `home-ios` entry
was then exercised from a different working directory: it initialized as
`ios-remote-codex`, read a fresh heartbeat and foreground app, captured an actual
JPEG from the physical iPad, and completed its task with that operation's evidence.
Only runtime queue requests were used; the old direct WDA connection and the
persistent-host goal runner were not used. Personal test data is excluded.

For setup or model-generated tasks, Codex account limits still apply. This adapter
does not grant an offline model or unlimited usage. Existing iPad signing, runner
availability and device lock-screen limitations remain unchanged.
