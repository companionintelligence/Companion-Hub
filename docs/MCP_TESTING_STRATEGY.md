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

Result: **~25 MCP apps are scored `skip` and get zero verification.** A marketplace MCP
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
  "args": ["-y", "@modelcontextprotocol/server-memory@2025.10.0"],
  "env": [{ "key": "MEMORY_FILE_PATH", "required": false, "secret": false }],
  "manifest": { "tools": [ { "name": "create_entities", … }, { "name": "read_graph", … } ] }
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

An optional **read-only `tools/call`** (a no-arg or trivially-arg'd tool that doesn't mutate
or need creds — e.g. memory's `read_graph`) can be added later to prove tools actually
execute; it's not part of the v1 smoke because tool-call safety varies per app.

## Credentials — the coverage unlock

8 of 25 apps declare a `required: true, secret: true` env (github, notion, obsidian,
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

## Integration into the harness

Minimal, additive change to `qa-stream.ts`'s skip path:

```ts
// before: every no_gui app → skip
// after:  an app that declares `.mcp` is MCP-testable; only non-MCP no_gui stays skip
if (config.no_gui) {
  if (config.mcp) return await qaMcpApp(appId, config.mcp, services, result);  // route to MCP smoke
  result.score = 'skip'; result.notes = 'no_gui: non-MCP CLI service'; return result;
}
```

`qaMcpApp` lives in `scripts/qa-mcp.ts` (the prototype below), shares the readiness/teardown
discipline of `qaApp`, and emits the same `app_result`. The dashboard already renders `skip`
and the new scores; add an `mcp` category chip to the filter so MCP apps are reviewable as a
group. Work-stealing dispatch and the fleet runner need **no** changes — an MCP app is just
another id off the shared queue whose verdict comes from the protocol smoke instead of HTTP.

## Inventory (25 apps)

| App | Transport | Needs real secret to *boot*? |
|-----|-----------|------------------------------|
| memory-mcp, fetch-mcp, playwright-mcp, chess-mcp, blender-mcp, excalidraw-mcp, lego-oracle-mcp, smartest-tv-mcp, unity-mcp, unity-mcp-ivanmurzak, unreal-engine-mcp, youtube-transcript-mcp, brewers-almanack-mcp, n8n-mcp | stdio | No → full smoke |
| filesystem-mcp, git-mcp, sqlite-mcp | stdio | No, but need a synthesized path arg |
| github-mcp, notion-mcp, obsidian-mcp, doordash-mcp, steam-mcp, postgres-mcp, onlyoffice-docspace-mcp | stdio | Maybe — placeholder first, `skip(needs-secret)` only if it refuses to boot |
| miro-mcp | remote http | `skip(remote)` (Layer 2 only, with token) |

So **~17 apps get a full no-credential smoke today**, 3 more with a synthesized path, and the
remaining secret-gated ones get at least a boot+advertise attempt before any `skip`.

## Roadmap

- **v1 (this doc + `scripts/qa-mcp.ts`):** stdio handshake + manifest-drift assertion, scored
  into the existing harness.
- **Read-only `tools/call` probe** for a curated safe tool per app (proves execution, not just
  advertisement).
- **Layer 2 automation:** install via the Hub, drive `/api/mcp/sse` `tools/list`, assert the
  bridge re-exposes `<appUrn>__<tool>` — promote to the source of truth.
- **SSE / streamable-HTTP transport** support in qa-mcp (for future local SSE servers + miro
  with a token).
- **Catalog-manifest sync:** when Layer 1 finds drift, open a marketplace PR updating
  `.mcp.manifest.tools` (the same diagnose→fix→PR fan-out the web-app triage uses).
