# iMessage Bridge for CI-OpenClaw on macOS Hubs — Plan

**Status:** proposal · **Date:** 2026-07-27
**Goal:** OpenClaw (running in Docker via the Hub) can read and send iMessages on a macOS Hub host, making iMessage a first-class OpenClaw channel and a flagship use case for running the Hub on a Mac.

## What already exists (survey of the companion repos)

There is **no iMessage bridge today**, but every layer of the required architecture already has a working precedent:

| Layer needed | Existing precedent | Where |
|---|---|---|
| Container → host-service bridge over `host.docker.internal`, with failure classification and operator remediation | Ollama host bridge | `ci-hub/packages/backend/src/modules/inference/backends/ollama-host-bridge.ts` |
| Native macOS process with elevated/host privileges that already shells out to `osascript` (AppleScript) | Desktop app (Tauri) | `ci-hub/packages/desktop/src-tauri/src/hub_manager.rs` (Docker/Ollama/Colima installers) |
| Hub → OpenClaw push (wake webhook with urgency filtering, plus SSE app-event stream) | agent-notify + openclaw-plugin | `ci-hub/packages/backend/src/modules/agent-notify/`, `ci-hub/packages/openclaw-plugin/` |
| OpenClaw → Hub tool calls | Native MCP server (`mcp.servers.ci-hub`, written by CI-OpenClaw config-reconcile) | `ci-hub/packages/backend/src/modules/mcp/` |
| Marketplace packaging of OpenClaw (already advertises iMessage as a supported platform in its description) | openclaw app manifest | `ci-marketplace/apps/openclaw/config.json` |

Note: `CI-Marketing/docs/strategy/hub-apps/research/macos.md` is about `dockur/macos` (macOS *inside* Docker) — unrelated and legally fraught; this plan is about the Hub desktop app running **natively on a Mac**, which has no such problem.

## Architecture

```
iMessage / Messages.app  (macOS host)
        │                        │
   chat.db (read,           AppleScript /
   FSEvents watch)          Shortcuts (send)
        └────────┬───────────────┘
        Messages Bridge (new module in the Tauri desktop app)
        localhost HTTP API + event forwarding, token-authenticated
                 │  host.docker.internal (Ollama-bridge pattern)
        CI-Hub backend (Docker)
          ├─ new `messages` module: normalize, store cursor, expose MCP tools
          ├─ agent-notify: wake OpenClaw on new inbound messages (existing path)
          └─ SSE /sse/app stream (existing, consumed by openclaw-plugin)
                 │
        OpenClaw container (session per chat / sender)
```

### Why the bridge lives in the desktop app
- It is already a signed, native, always-running macOS process — no second helper to install, launch-agent, or keep alive.
- It already executes `osascript`; sending via `tell application "Messages"` is a small addition.
- TCC permissions (Full Disk Access for `chat.db`, Automation for Messages.app) attach to **one** app the user already trusts, with UI to walk them through granting it — far better than telling users to grant Full Disk Access to Docker Desktop just to mount `~/Library/Messages` read-only (the mount approach also can't send at all, so it's strictly worse).

## Components

### 1. Desktop: `messages_bridge.rs` (new Tauri module)
- **Send:** `POST /v1/messages/send { handle, body, attachments? }` → AppleScript `send … to buddy X of service "iMessage"`. Fall back to a user-installed Shortcut (`shortcuts run`) if Automation permission is denied.
- **Read/receive:** open `~/Library/Messages/chat.db` read-only (WAL-safe); FSEvents watch on the directory, debounce, then query `message ROWID > cursor` and push each new message to the Hub (`POST /api/v1/messages/ingest`) — plus `GET /v1/messages/history?chat=…` for on-demand backfill/search.
- **Auth:** bind to an interface reachable from the Docker VM via `host.docker.internal`, require a bearer token minted by the Hub at pairing time (same trust model as the gateway token).
- **Permissions UX:** a settings pane that detects missing Full Disk Access / Automation grants and deep-links to the right System Settings pane (the remediation-hint pattern from the Ollama bridge, applied to TCC instead of firewalls).

### 2. Hub backend: `messages` module (new)
- Ingest endpoint (bridge → Hub), message normalization, per-chat cursor persistence in the existing Drizzle store.
- **MCP tools** on the existing `ci-hub` MCP server: `messages_send`, `messages_search`, `messages_list_chats`, `messages_get_thread`. OpenClaw gets them with zero plugin changes, since it already consumes this server natively.
- **Inbound wake:** on ingest, call `agent-notify` with a wake text built by the existing `wake-text.ts` urgency machinery, so OpenClaw wakes on new messages exactly the way it wakes for other app events today. Also emit on the SSE app stream the `openclaw-plugin` already listens to.
- Reuse `classifyBridgeFailure` / `buildBridgeRemediation` (generalize the `service` name — it already takes one) for bridge-down diagnostics in the UI.

### 3. OpenClaw side: nothing new required
- The wake webhook (`wakeSecret`) and SSE listener in `ci-hub/packages/openclaw-plugin` already deliver events into sessions; MCP tools arrive via config-reconcile. iMessage becomes a use case, not a new integration surface.

## Phases

1. **Send-only MVP (1–2 weeks):** bridge module with `send` endpoint + AppleScript, Hub `messages_send` MCP tool, pairing token, permissions UX. Demo: ask OpenClaw to text someone.
2. **Receive (2–3 weeks):** chat.db watcher + ingest + cursor, wake-on-message through agent-notify, `messages_get_thread`/`messages_list_chats`. Demo: OpenClaw auto-replies in a chosen thread.
3. **Assistant polish:** history search tool, attachment handling (paths → Hub file proxy), per-chat session mapping in OpenClaw config, allowlist of chats the agent may read/respond to (safety default: opt-in per chat).

## Risks / open questions
- **chat.db schema drift** across macOS versions (attributedBody blobs on Ventura+ need decoding for message text) — budget for a small parser with per-OS-version fixtures.
- **AppleScript send reliability** degrades on newer macOS for non-existing conversations; the Shortcuts fallback covers that gap.
- **TCC prompts** can't be granted programmatically — the permissions UX in phase 1 is load-bearing, not polish.
- Group-chat sending via AppleScript is limited (use `chat id` targeting; verify per OS version).
- Only applies to macOS Hub hosts; the module must no-op cleanly on Linux/Windows (same platform-gating the desktop app already does).
