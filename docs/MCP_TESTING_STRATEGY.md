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
| **2. Hub-bridge regression** | drive the real bridge: `POST /api/mcp/sse` → `initialize` + `tools/list` after a Hub install | The app installs **through the Hub**, the **MCP bridge** (`packages/backend/src/modules/mcp/agents/mcp-bridge.service.ts`) connects it (stdio via `docker exec`, or SSE/HTTP), and re-exposes its tools as `<appUrn>__<tool>` | Per-app, product-accurate |

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
catalog MCP app wires its tools through `/api/mcp/sse`. Until then Layer 1 is the coverage signal
for the catalog and Layer 2 guards the bridge itself.

## Transport handling (Layer 1)

| Transport | Count | How qa-mcp tests it |
|-----------|------:|---------------------|
| **stdio** | 23 | `docker run -i --rm [--env …] <image> <command + args>`; write newline-delimited JSON-RPC to **stdin**, read responses from **stdout**. (`config.json .mcp.command === "docker"` apps like `github-mcp` already encode their own `docker run` invocation — use it verbatim.) |
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
tool** (`SAFE_PROBES` in `qa-mcp.ts` — e.g. `filesystem-mcp → list_directory {path:'/qa'}`,
`chess-mcp → new_game`) to prove tools actually *execute*, not just advertise. The probe
**self-guards** against the live tool's real `inputSchema.required`, so a wrong-args entry is
skipped, never failed — and only an advertised-yet-broken tool (`method not found` / internal
error) downgrades `pass→warn`. Disable with `QA_MCP_PROBE=0`; allow network probes with
`QA_MCP_PROBE_NET=1`.

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
MCP container. **Shipping:** `fleet-qa-server.ts` `scpScript()` copies *both* `qa-stream.ts` and
`qa-mcp.ts` to each node's `/tmp/` (both import only Node built-ins). Work-stealing dispatch and the
fleet runner need **no** changes — an MCP app is just another id off the shared queue.

**Surfacing:** the catalog (`generate-catalog-tests.ts` → `catalog.json`) carries an `mcp` flag;
the dashboard renders an **MCP** badge per card and every MCP app already has an `mcp` category, so
the existing filter groups them; `triage.mjs` buckets an MCP **drift** `warn` as *actionable*
(`mcp-drift`, stale manifest) rather than a missing-screenshot false-warn, and an MCP handshake
`fail` as `mcp-fail`.

## Layer 2 in practice (`scripts/qa-mcp-bridge.ts`)

Env-gated regression of the real bridge: `HUB_URL` (default `http://localhost:3000`) + `MCP_API_KEY`
(the Hub's Bearer key). It opens `GET /api/mcp/sse` for the `event: endpoint` line, then
`POST /api/mcp/messages` `initialize` and `tools/list`, asserting `protocolVersion`+`serverInfo`, a
non-empty tool set, and `<appUrn>__<tool>` namespacing on any bridged tool. A down Hub or a missing
key is a clean **`skip`**, so it never breaks a fleet run. See the gap note above for why catalog
apps don't yet appear here.

## Inventory (24 apps)

| App | Transport | Needs real secret to *boot*? |
|-----|-----------|------------------------------|
| fetch-mcp, playwright-mcp, chess-mcp, blender-mcp, excalidraw-mcp, lego-oracle-mcp, smartest-tv-mcp, unity-mcp, unity-mcp-ivanmurzak, unreal-engine-mcp, youtube-transcript-mcp, brewers-almanack-mcp, n8n-mcp | stdio | No → full smoke |
| filesystem-mcp, git-mcp, sqlite-mcp | stdio | No, but need a synthesized path arg |
| github-mcp, notion-mcp, obsidian-mcp, doordash-mcp, steam-mcp, postgres-mcp, onlyoffice-docspace-mcp | stdio | Maybe — placeholder first, `skip(needs-secret)` only if it refuses to boot |
| miro-mcp | remote http | `skip(remote)` (Layer 2 only, with token) |

So **~17 apps get a full no-credential smoke today**, 3 more with a synthesized path, and the
remaining secret-gated ones get at least a boot+advertise attempt before any `skip`.

## Roadmap

- **✅ v1 — stdio handshake + manifest-drift assertion**, wired into `qa-stream.ts` so all 24 MCP
  apps get a verdict in fleet/e2e runs (`scripts/qa-mcp.ts`).
- **✅ Read-only `tools/call` exec probe** for a curated, self-guarded safe tool per app.
- **✅ Layer-2 bridge regression** (`scripts/qa-mcp-bridge.ts`) against the live `/api/mcp` surface.
- **⏳ Wire catalog apps through the bridge (the gap above):** add an `agents.mcp` block to MCP apps
  and teach the installer/bridge to run a top-level-`.mcp` server — only then does Layer 2 reach the
  catalog and become the true source of truth.
- **⏳ Seeded-state + network probes:** extend `SAFE_PROBES` to git/sqlite (seed a scratch repo/db)
  and network tools (`fetch`, gated by `QA_MCP_PROBE_NET`).
- **⏳ SSE / streamable-HTTP transport** support in qa-mcp (for future local SSE servers + miro
  with a token).
- **⏳ Catalog-manifest sync:** when Layer 1 finds drift, open a marketplace PR updating
  `.mcp.manifest.tools` (the same diagnose→fix→PR fan-out the web-app triage uses).
