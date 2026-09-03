# MCP Testing Strategy

> How CI-Hub verifies that every **MCP server** app in the marketplace actually **speaks
> the protocol and advertises the tools it claims** — not just that its container starts.

## The gap

The fleet-QA harness (`scripts/qa-stream.ts`) tests apps by booting their container and
checking **HTTP** readiness. MCP servers have no HTTP surface — they speak JSON-RPC over
**stdio** (or, rarely, SSE/streamable-HTTP). So qa-stream short-circuits them:

```ts
if (config.no_gui) { result.score = 'skip'; result.notes = 'no_gui: stdio/CLI service…'; }
```

Result (before this work): **24 MCP apps were scored `skip` and got zero verification.** A marketplace MCP
entry can be completely broken — wrong package version, server crashes on launch, advertises
no tools, or advertises tools that don't match its catalog manifest — and nothing catches it.

This is the MCP analogue of the web-app failure mode the [E2E strategy](./E2E_TESTING_STRATEGY.md)
exists to catch ("the page loads but the backend is dead"). Here it's **"the container starts
but the server never speaks MCP / lists no tools."**

## What "working" means for an MCP server

Every marketplace MCP app declares its contract in `config.json`:

```jsonc
"mcp": {
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem"],
  "env": [{ "key": "ALLOWED_PATH", "required": true, "secret": false }],
  "manifest": { "tools": [ { "name": "list_directory", … }, { "name": "read_file", … } ] }
}
```

A working server, when launched, must:

1. **Complete the MCP handshake** — respond to `initialize` with a `protocolVersion` +
   `serverInfo` (no JSON-RPC error), then accept `notifications/initialized`.
2. **Advertise tools** — return a non-empty `tools/list`.
3. **Match its declared manifest** — the live `tools/list` should be a **superset of** the
   tools declared in `config.json .mcp.manifest.tools`. A live set that's missing declared
   tools (or empty) is drift — usually a version bump that renamed/removed tools.

That third check is the high-value one: it's a real contract assertion, not just a liveness
ping, and it's free because the marketplace already declares the expected tools.

## Two layers (mirrors the web-app strategy)

| Layer | Code | What it proves | Scale |
|-------|------|----------------|-------|
| **1. Direct protocol smoke** (primary) | `scripts/qa-mcp.ts` | The server's own container boots, completes `initialize`, and advertises a `tools/list` matching its declared manifest | All MCP apps, per-node, fast |
| **2. Hub-bridge regression** | drive the real bridge over the **Streamable HTTP** transport: `POST /api/mcp` `initialize` (captures the `Mcp-Session-Id`) → `tools/list` after a Hub install | The app installs **through the Hub**, the **MCP bridge** (`packages/backend/src/modules/mcp/agents/mcp-bridge.service.ts`) connects it (stdio via `docker exec`, or SSE/HTTP), and re-exposes its tools as `<appUrn>__<tool>` | Per-app, product-accurate |

Layer 1 is the broad, fast signal. Layer 2 is the source of truth — it exercises the Hub's
own bridge and the exact path a user/agent reaches the tools through, and is authoritative
when Layer 1 and reality disagree.

### ⚠ The marketplace↔bridge gap (measured 2026-06)

**Today, installing a catalog MCP app does NOT expose it through the Hub bridge.** The two
layers test different runtime models:

- **Layer 1 / the catalog model:** an app's MCP server *is* the container's main process. The
  `config.json` **top-level `.mcp`** block (`{ transport, command, args, env, manifest.tools }`)
  describes how to *run* that server; its stdio is the container's stdio.
- **Layer 2 / the bridge model:** `agents/mcp-bridge.service.ts` reads an app's **`agents.mcp`**
  block (a *different* field, via `agents/agent-config.service.ts`) and connects stdio by
  `docker exec -i <container> <command>` into an **already-running** container, re-exposing tools
  as `<appUrn>__<tool>`.

A grep of all 168 marketplace apps finds **zero** `agents.mcp` blocks. So the bridge has nothing
to attach to, and even if an app declared one, the `docker exec` model doesn't fit a container
whose main process is the MCP server. **`scripts/qa-mcp-bridge.ts` therefore regression-tests the
bridge's protocol surface** (SSE endpoint → `initialize` → `tools/list` → namespacing) against the
Hub's *own* tools; bridged-app namespacing is only asserted when such an app is present.

**Recommended fix (deferred):** give MCP apps an `agents.mcp` block and teach the
installer/bridge to launch a top-level-`.mcp` server (not only `docker exec`), so installing a
catalog MCP app wires its tools through the Hub's `/api/mcp` endpoint. Until then Layer 1 is the coverage signal
for the catalog and Layer 2 guards the bridge itself.

## Transport handling (Layer 1)

| Transport | Count | How qa-mcp tests it |
|-----------|------:|---------------------|
| **stdio** | 24 | `docker run -i --rm [--env …] <image> <command + args>`; write newline-delimited JSON-RPC to **stdin**, read responses from **stdout**. (`config.json .mcp.command === "docker"` apps like `github-mcp` already encode their own `docker run` invocation — use it verbatim.) |
| **SSE / streamable-HTTP** | (future) | start the container, `POST` the JSON-RPC to the `/sse` (or message) endpoint, read the event stream. None of today's local apps use it; the Hub bridge handles SSE for remote servers. |
| **remote http** | 1 (`miro-mcp`) | hosted/remote endpoint — `skip(remote)` in Layer 1; covered only in Layer 2 with a real token. |

**stdio framing:** current MCP stdio transport is **newline-delimited JSON** (one JSON-RPC
message per line, UTF-8, no `Content-Length` headers). Send `initialize\n`, then
`notifications/initialized\n`, then `tools/list\n`; collect stdout lines and match by `id`.

## The handshake

```jsonc
// → request
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
  "protocolVersion":"2025-06-18",
  "capabilities":{},
  "clientInfo":{"name":"ci-qa-mcp","version":"1.0"}}}
// ← expect: result.protocolVersion + result.serverInfo, NO error
// → notification (no id)
{"jsonrpc":"2.0","method":"notifications/initialized"}
// → request
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
// ← expect: result.tools = [ {name, description, inputSchema}, … ]
```

**Implemented:** after a successful handshake, qa-mcp optionally calls **one curated read-only
tool** (`SAFE_PROBES` in `qa-mcp.ts`) to prove tools actually *execute*, not just advertise. The
probe **self-guards** against the live tool's real `inputSchema.required`, so a wrong-args entry is
skipped, never failed — and only an advertised-yet-broken tool (`method not found` / internal
error) downgrades `pass→warn`. Disable with `QA_MCP_PROBE=0`; allow network probes with
`QA_MCP_PROBE_NET=1`.

The curated set, each **verified `→ok` against the live container** (2026-06-10):

| Probe class | Apps (tool) | Runs |
|-------------|-------------|------|
| **offline, read-only, no-cred** | `filesystem-mcp` (`list_directory`), `chess-mcp` (`new_game`), `brewers-almanack-mcp` (`search_styles`), `git-mcp` (`git_status` on the boot-`git init`'d scratch repo), `sqlite-mcp` (`list_tables`), `n8n-mcp` (`tools_documentation`) | every sweep |
| **network-touching** (`net:true`) | `fetch-mcp` (`fetch`), `youtube-transcript-mcp` (`get_video_info`), `lego-oracle-mcp` (`browse_themes`) | only with `QA_MCP_PROBE_NET=1` |
| **backing-service** (`BACKING_SERVICES`) | `postgres-mcp` (`query "SELECT 1"` against a `postgres:16-alpine` sidecar) | every sweep, self-gates to backing-up |
| **no probe — every tool needs creds** | `reddit-mcp` (all tools hit the authed Reddit API → only `tool-error` without keys), plus the secret/host-gated apps below | handshake is the ceiling |

> The probe args are chosen against each tool's **real** `inputSchema.required` (read live, not
> from the stripped manifest schema). Regression guard: the previous `brewers-almanack-mcp` probe
> named `lookup_style`, **which the server doesn't expose** — so it silently self-skipped and
> proved nothing. The unit tests now pin every probe's tool + args.

## Credentials — the coverage unlock

8 of 24 apps declare a `required: true, secret: true` env (github, notion, obsidian,
doordash, steam, postgres, miro, onlyoffice). **You do not need real credentials to test
most of them**, because MCP servers enforce auth at **`tools/call`** time, not at
`initialize`/`tools/list`. So the handshake + tool advertisement still validate the build.

qa-mcp's credential policy:
- **Required secret, none provided** → inject a **placeholder** (`ci-qa-placeholder`) and
  attempt the handshake anyway. If the server boots and lists tools → `pass`. If the server
  **refuses to start without a real credential** (exits immediately citing the missing key)
  → `skip(needs-secret)` with the offending env in `notes`.
- **Real test credential available** (via `QA_MCP_SECRETS_JSON`) → use it; this also unlocks
  a Layer-2 `tools/call`.
- **Non-secret required arg** (path/URL: `ALLOWED_PATH`, `GIT_REPO_PATH`, `SQLITE_PATH`) →
  synthesize a scratch value (a tmp dir / seeded sqlite file), reusing qa-stream's
  `${VAR}` substitution discipline so a path the server needs actually exists.

## Scoring (same vocabulary as the web-app harness)

| Score | Meaning |
|-------|---------|
| `pass` | `initialize` OK **and** `tools/list` non-empty **and** ⊇ the declared manifest tools |
| `warn` | handshake OK but **tool drift** — live tools missing declared ones, empty, or a superset with renamed tools (server works, catalog manifest is stale) — the failing detail in `notes` |
| `fail` | server launched but **never completed `initialize`**, returned a JSON-RPC error to `initialize`, or crashed mid-handshake (the real bug) |
| `error` | infra/harness — image pull failed, `docker run` failed, command not found (retryable, like qa-stream) |
| `timeout` | no handshake response within the deadline (npx/uvx cold-fetch ceiling, e.g. 90s) |
| `skip` | `needs-secret` (server won't boot without a real credential), `remote` (hosted http), or non-MCP |

This reuses the exact `pass/warn/fail/error/timeout/skip` set from the [signal-split work](./E2E_TESTING_STRATEGY.md),
so MCP results flow through the **same** NDJSON events, dashboard tallies, and `triage.mjs`
buckets — no parallel reporting path. The `warn` = manifest-drift case is the MCP equivalent
of the backend-degraded `warn`: the thing technically runs but isn't what the catalog promises.

## Integration into the harness (implemented)

`qa-stream.ts`'s `no_gui` branch routes MCP apps to the protocol smoke via a **guarded dynamic
import** (so a node missing the sibling file degrades only MCP apps, never the whole run):

```ts
if (config.no_gui) {
  if (config.mcp) {
    try {
      const { qaMcpApp } = await import('./qa-mcp.ts');
      return await qaMcpApp(appId, { emit, containerName, result }); // qa-stream-${appId} → watchdog covers it
    } catch (e) {
      result.score = 'skip'; result.failKind = 'mcp-module';
      result.notes = `MCP app but qa-mcp module unavailable: ${e}`; return result;
    }
  }
  result.score = 'skip'; result.notes = 'no_gui: non-MCP CLI service, no HTTP to verify'; return result;
}
```

`qaMcpApp` (in `scripts/qa-mcp.ts`) returns the `result` record — it does **not** emit its own
`app_result`, so the existing `qaApp` retry/watchdog/teardown wrap it for free. Because it reuses
the `qa-stream-${appId}` container name, the per-app watchdog and `forceTeardown` already cover the
MCP container. **Shipping:** private fleet runners copy *both* `qa-stream.ts` and
`qa-mcp.ts` to each node's workdir (both import only Node built-ins). Work-stealing dispatch and the
fleet runner need **no** changes — an MCP app is just another id off the shared queue.

**Surfacing:** the catalog (`generate-catalog-tests.ts` → `catalog.json`) carries an `mcp` flag;
the dashboard renders an **MCP** badge per card and every MCP app already has an `mcp` category, so
the existing filter groups them; `triage.mjs` buckets an MCP **drift** `warn` as *actionable*
(`mcp-drift`, stale manifest) rather than a missing-screenshot false-warn, and an MCP handshake
`fail` as `mcp-fail`.

## Layer 2 in practice (`scripts/qa-mcp-bridge.ts`)

Env-gated regression of the real bridge over the **Streamable HTTP** transport: `HUB_URL` (default
`http://localhost:5002`) + `MCP_API_KEY` (an `mcp`-scoped key from the Hub's key store — mint one
with `cihub api-key create`; the appliance's own derived `MCP_API_KEY` is not a credential). It `POST`s `initialize` to the
single `/api/mcp` endpoint (capturing the `Mcp-Session-Id` response header), then `POST`s
`tools/list` with that session, asserting `protocolVersion`+`serverInfo`, a non-empty tool set, and
`<appUrn>__<tool>` namespacing on any bridged tool. Responses may be JSON or an SSE frame; both are
parsed. A down Hub or a missing key is a clean **`skip`**, so it never breaks a fleet run. See the
gap note above for why catalog apps don't yet appear here.

## Measured baseline (2026-06-10, 25 apps)

Full live sweep on merged `dev` (`APP_STORE_DIR=../CI-Marketplace/apps tsx scripts/qa-mcp.ts --all`
— `--all` auto-discovers every `.mcp` app, so a newly-added MCP server is never silently missed):
**19 pass · 6 skip · 0
fail/warn/error/timeout.** Every testable MCP container boots, completes the handshake, and its
live `tools/list` is a superset of its declared manifest — i.e. **no manifest drift remains in the
catalog** (the `github-mcp` refresh was the last). Re-run it after any catalog bump; it's the
coverage signal.

**19 pass** — boots + handshake + manifest ⊇ declared:
`brewers-almanack` · `chess` · `doordash` · `excalidraw` · `fetch` · `filesystem` · `git` ·
`github` (67 tools) · `lego-oracle` · `n8n` · `notion` (22) · `obsidian` · `onlyoffice` (23) ·
`playwright` (25) · `postgres` · `reddit` · `sqlite` · `unreal-engine` (35) · `youtube-transcript`.

**6 skip** — un-testable headless, correctly classified (not failures):

| App | Why skipped |
|-----|-------------|
| `blender-mcp`, `unity-mcp`, `unity-mcp-ivanmurzak` | needs a running Blender / Unity Editor on the host (`requires.host_software`) |
| `smartest-tv-mcp` | needs a real smart TV / Home Assistant on the LAN |
| `steam-mcp` | `STEAM_API_KEY` is validated **at boot** (server exits without it) → `needs-secret` |
| `miro-mcp` | `transport: http` — remote/Portal-configured endpoint; Layer-1 is stdio-only |

### Depth: handshake vs execution

`pass` means *boots + advertises the right tools*. Proving a tool **executes** is the exec probe —
and that's where coverage was thin (only `chess` + `filesystem` ran a tool at baseline). Now **10
apps are execution-proven**: 6 offline every sweep, 3 net-gated (`QA_MCP_PROBE_NET=1`), and
`postgres` against a hermetic backing-service sidecar. The remaining 9 `pass` apps are
**handshake-only by necessity** — every one of their tools needs a real credential or external host
that headless can't supply, so a no-cred `tools/call` only yields `tool-error`, never a clean `ok`:

| Handshake-only `pass` | What a deeper probe would require |
|-----------------------|-----------------------------------|
| `github`, `notion`, `onlyoffice`, `doordash` | a real API token / tenant |
| `obsidian`, `unreal-engine` | a running Obsidian (REST plugin) / Unreal bridge on the host |
| `reddit` | Reddit API credentials |
| `playwright` | `browser_install` first (downloads Chromium ~150 MB) then a `browser_navigate` |
| `excalidraw` | a connected Excalidraw canvas server |

This is the honest ceiling: **10 execution-proven, 9 handshake-proven** (cred/host-bound), 6
legitimately skipped. The backing-service pattern (`BACKING_SERVICES`) is the lever for the rest — any
app whose only gap is a missing DB/cache can be lifted to execution-proven by adding one map entry,
no real credentials needed.

## Roadmap

- **✅ v1 — stdio handshake + manifest-drift assertion**, wired into `qa-stream.ts` so all 24 MCP
  apps get a verdict in fleet/e2e runs (`scripts/qa-mcp.ts`).
- **✅ Read-only `tools/call` exec probe** for a curated, self-guarded safe tool per app.
- **✅ Layer-2 bridge regression** (`scripts/qa-mcp-bridge.ts`) against the live `/api/mcp` surface.
- **⏳ Wire catalog apps through the bridge (the gap above):** add an `agents.mcp` block to MCP apps
  and teach the installer/bridge to run a top-level-`.mcp` server — only then does Layer 2 reach the
  catalog and become the true source of truth.
- **✅ Seeded-state + network exec probes:** `SAFE_PROBES` now covers git (status on the
  boot-`git init`'d scratch repo), sqlite (`list_tables`), n8n (`tools_documentation`), and
  net-gated `fetch`/`youtube`/`lego` — all verified `→ok`. Execution-proven apps: 2 → **9**.
- **✅ Backing-service fixtures:** `BACKING_SERVICES` brings up a hermetic sidecar on a throwaway
  docker network, joins the app to it, and rewrites the app's connection-string env to the sidecar's
  alias — so a dummy-URL handshake becomes a real connection. `postgres-mcp` boots against a
  `postgres:16-alpine` and its `query "SELECT 1"` probe returns `→ok` (verified). The probe self-gates
  to backing-up only (a node with `QA_MCP_BACKING=0` or a sidecar that fails to start falls back to the
  clean dummy-URL handshake, no false warn). The same map entry pattern extends to any DB/cache-backed
  MCP server. **Execution-proven: 2 → 10.**
- **⏳ Wire catalog apps through the bridge** (the Layer-2 gap above) — add `agents.mcp` blocks +
  teach the installer to run a top-level-`.mcp` server.
- **⏳ SSE / streamable-HTTP transport** support in qa-mcp (for future local SSE servers + miro
  with a token).
- **✅ Catalog-manifest sync:** Layer 1 drives marketplace PRs updating `.mcp.manifest.tools` when it
  finds drift (e.g. the `github-mcp` refresh). The 2026-06-10 sweep finds **zero** remaining drift.
