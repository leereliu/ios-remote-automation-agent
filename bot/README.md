# Hosted Bot integration

Run this adapter on a hosted assistant computer with its own model and chat interface, such as Grok Bot. It uses the existing HTTPS operation queue directly. It never runs Codex, the Devbox goal agent, a model API, or a local Mac command.

Requirements: Node 20.19 or newer, an existing queue and a live iPad executor. No npm packages are required. Paid hosted-assistant usage follows that assistant's plan; this adapter never enables additional billing.

1. Keep this repository in the hosted computer's persistent workspace.
2. Create `.local/bot/config-private.json` with `{"url":"https://your-queue.example","token":"YOUR_BOT_RUNTIME_TOKEN"}` and file mode `600`. Use the optional `BOT_TOKEN` Worker secret, never a Cloudflare deployment token. The bot role can read device heartbeat and submit/read operations; it cannot access goals or claim/finish device operations.
3. Register a **Command / stdio** MCP connector with command `node` and one argument: the absolute path to `bot/mcp.mjs` on the hosted computer. Secrets must not appear in command arguments or chat. `IPAD_QUEUE_CONFIG` can select another private config path; `IPAD_BOT_DATA_DIR` and `IPAD_ARTIFACT_DIR` select persistent state and screenshot folders.
4. Install the workflow instructions in `SKILL.md`. Call `ipad_task_begin` for each user request, use its `task_id` for device tools and finish with `ipad_task_end` and an honest outcome. Success requires a screenshot operation from that task. Each task has 20 device calls and a ten-minute deadline; restarting the connector does not clear the persisted task budget. Unknown outcomes block further tasks for manual review.
5. Attach the returned `screenshot_path` directly in the conversation. The image from each existing operation is saved privately on the Bot computer; no second screenshot or public image URL is needed.

All Bots on a Grok Bot account share a computer and credentials. A Bot name is not an access boundary. Keep the device credential narrowly scoped, private and revocable.

Before retiring another controller, stop its goal loop and verify no in-flight device commands remain. Test one screenshot first, then a full task with the Mac offline and the old agent stopped. Platform support and end-to-end operation require live verification; a successful tool listing alone is insufficient.
