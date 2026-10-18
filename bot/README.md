# Hosted Bot integration

Run this adapter on a hosted assistant computer with its own model and chat interface, such as Grok Bot. It uses the existing HTTPS operation queue directly. It never runs Codex, the Devbox goal agent, a model API, or a local Mac command.

Requirements: Node 20.19 or newer, an existing queue and a live iPad executor. No npm packages are required. Paid hosted-assistant usage follows that assistant's plan; this adapter never enables additional billing.

1. Keep this repository in the hosted computer's persistent workspace.
2. Create `.local/bot/config-private.json` with `{"url":"https://your-queue.example","token":"YOUR_BOT_RUNTIME_TOKEN"}` and file mode `600`. Use the optional `BOT_TOKEN` Worker secret, never a Cloudflare deployment token. The bot role can read device heartbeat and submit/read operations; it cannot access goals or claim/finish device operations.
3. Register a **Command / stdio** MCP connector with command `node` and one argument: the absolute path to `bot/mcp.mjs` on the hosted computer. Secrets must not appear in command arguments or chat. `IPAD_QUEUE_CONFIG` can select another private config path; `IPAD_BOT_DATA_DIR` and `IPAD_ARTIFACT_DIR` select persistent state and screenshot folders.
4. Install the workflow instructions in `SKILL.md`. Call `ipad_task_begin` for each user request, use its `task_id` for device tools and finish with `ipad_task_end` and an honest outcome. Success requires a screenshot operation from that task. Tasks default to 20 device calls and a ten-minute deadline. An explicitly requested bulk task can select `tool_budget` up to 100 and `timeout_minutes` up to 30 at task start; restarting the connector does not clear the persisted task budget. Unknown outcomes block further tasks for manual review.
5. When an image is requested, attach the returned `screenshot_path` directly in the conversation. For aggregate-only requests, begin with `archive_images: false`: the adapter saves operation IDs for evidence without writing screenshot files or returning attachment paths. The queue and model context still process operational screenshots. With image archiving enabled, the image from each existing operation is saved privately on the Bot computer; no second screenshot or public image URL is needed.

All Bots on a Grok Bot account share a computer and credentials. A Bot name is not an access boundary. Keep the device credential narrowly scoped, private and revocable.

For a second hosted assistant, the deployment config can optionally include a
separate random `dot_token` of at least 32 characters. The deployer stores it as
the `DOT_TOKEN` Worker secret, with the same fixed-device operation permissions
as the Bot role. Put only the queue URL and this runtime token in that assistant's
private config. It can be revoked independently of `BOT_TOKEN`; never copy the
Cloudflare deployment credential, controller key or device key to an assistant.
Both runtime credentials can read operation results in this single-device queue,
so they should be given only to assistants authorized for that data. Keep task
execution serial across controllers.

Before retiring another controller, stop its goal loop and verify no in-flight device commands remain. Test one screenshot first, then a full task with the Mac offline and the old agent stopped. Platform support and end-to-end operation require live verification; a successful tool listing alone is insufficient.

## Validated hosted Bot workflow

On October 18, 2026, a Grok Bot on its own hosted computer controlled the existing physical iPad and returned an actual JPEG attachment in its conversation. The request was initiated through the iPhone app using iPhone Mirroring. The newest video was shorter than the original requested timestamp, so the owner changed the target to its displayed **02:00 / 02:15**. The Bot completed that target in six device tool calls and eight underlying operations, with no new Codex goal submitted. The player was visibly paused at 02:00, and the video title and publication date were checked in the same image. This validates the displayed seconds, not a decoded frame timestamp.

The old Devbox agent was stopped and its startup links removed. The Mac stayed on as a chat and observation client; physically powering it off was not part of this acceptance run. Initial signing and runner recovery still require a paired Mac. Private credentials, screenshots, operation IDs and personal runtime state are excluded from the repository.

## ChatGPT Dot terminal transport

A hosted ChatGPT Dot also completed a live iPad task on October 18, 2026. Its
cloud computer ran Node 24.19 and called this adapter through a terminal-launched
stdio subprocess using newline-delimited JSON-RPC. Native MCP registration in
the chat interface was not required or validated. The Dot used its own model,
returned a real JPEG attachment showing a paused **01:00 / 02:15**, and submitted
no Devbox goals. The Mac remained on as the setup and observation client.

Use the separate optional runtime credential described above. Keep the repository,
private config, task state and any terminal bootstrap helper in the assistant's
persistent workspace, and save the workflow instructions using its supported
skill or memory mechanism. Recheck these files after a cloud computer rebuild;
workspace persistence is not guaranteed by this adapter. Assistant platform
permissions, usage limits and file attachment support still apply.
