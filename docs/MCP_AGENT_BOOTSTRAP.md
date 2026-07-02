# MCP Agent Bootstrap (Hermes & OpenClaw)

How marketplace agent apps connect to the **Hub MCP server** at runtime, and what to verify before dev testing.

## Hub MCP server (control plane edge)

The Hub exposes a platform MCP server (not the per-app stdio bridge):

| Endpoint | Method | Auth |
|----------|--------|------|
| `/api/mcp/sse` | GET (SSE) | `Authorization: Bearer $MCP_API_KEY` |
| `/api/mcp/messages` | POST | Same Bearer key |

Generate or rotate the key with `cihub mcp setup`. The key is stored in Hub env as `MCP_API_KEY`.

At **app install**, when `hub_integration.mcp_client: true`, the Hub injects:

| Env var | Purpose |
|---------|---------|
| `HUB_URL` | Hub base URL (health, inference REST) |
| `HUB_MCP_URL` | MCP base (often same as `HUB_URL`) |
| `HUB_MCP_MESSAGES_URL` | Optional explicit messages URL |
| `HUB_MCP_API_KEY` | Bearer token for MCP SSE/messages |
| `HUB_WAKE_SECRET` | Validates inbound wake webhooks (OpenClaw) |
| `HUB_MCP_ENABLED` | Set `false` to skip MCP wiring |

Marketplace entries for `ci-hermes` and `ci-openclaw` set `mcp_client: true`.

## CI-Hermes path

Boot order (`entrypoint.sh` / `gateway-entrypoint.sh`):

1. **`bootstrap-from-hub.sh`** — pulls inference credentials, writes `/opt/data/config.yaml` and `.env.hub-bootstrap`.
2. **`bootstrap-ci-context.sh`** — Companion Intelligence plugin, memory MCP, then Hub MCP.
3. **`configure-hub-mcp.py`** — idempotently adds `mcp_servers.hub` to `config.yaml`:

```yaml
mcp_servers:
  hub:
    url: "http://ci-hub:5002/api/mcp/sse"
    transport: sse
    headers:
      Authorization: "Bearer <HUB_MCP_API_KEY>"
    timeout: 180
    connect_timeout: 60
```

Hermes agents then reach Hub tools through the native MCP client (SSE transport).

**Tests:** `ci-hermes/tests/configure-hub-mcp.test.sh`, `ci-hermes/tests/hub-mcp-smoke.sh`

## CI-OpenClaw path

Boot order (`entrypoint.sh`):

1. **`bootstrap-from-hub.sh`** — inference + Ollama env.
2. **`bootstrap-ci-memory.sh`** — CI-Server memory plugin.
3. **`bootstrap-ci-hub-mcp.sh`** — registers bundled plugin path in `openclaw.json` when creds present.
4. **`server.cjs`** — on setup/onboarding, `ensureOpenClawPlugin('ci-hub', …)` enables the entry.

The bundled plugin lives at `openclaw-context/plugins/ci-hub/`:

- `index.js` — OpenClaw entry; reads **env only** (no secrets in `openclaw.json`).
- `hub-plugin.mjs` — bundled from `ci-hub/packages/openclaw-plugin` (`pnpm bundle` with `OPENCLAW_PLUGIN_OUT_DIR`).

Plugin behavior:

- Connects to Hub MCP, registers all Hub tools on the OpenClaw agent.
- Exposes `POST /hooks/hub-wake` for Hub → agent wake notifications.
- Auto-configures local inference provider from Hub status / Ollama.

Re-bundle after plugin source changes:

```bash
cd ci-hub/packages/openclaw-plugin
OPENCLAW_PLUGIN_OUT_DIR=/path/to/ci-openclaw/openclaw-context/plugins/ci-hub pnpm bundle
```

## Inference vs MCP

These are **separate** channels:

| Channel | Hermes | OpenClaw |
|---------|--------|----------|
| Chat inference | `OPENAI_API_*` from Hub bootstrap | `ci-hub` Ollama provider in `openclaw.json` |
| Memory MCP | CI-Server via `configure-ci-server.py` | `ci-memory` plugin slot |
| **Hub platform MCP** | `mcp_servers.hub` in `config.yaml` | `ci-hub` OpenClaw plugin |

Intent catalog plugins (`companionintelligence`) from upstream master are orthogonal — they add skills/intents, not Hub MCP wiring.

## Dev test checklist

### Hub

- [ ] `MCP_API_KEY` set (`cihub mcp setup`)
- [ ] `GET /api/health` OK
- [ ] `scripts/qa-mcp-bridge.ts` or e2e `e2e/mcp-openclaw-integration.spec.ts` passes

### Install / restart agents

- [ ] Install or restart `ci-hermes` and `ci-openclaw` from marketplace
- [ ] Container logs show Hub MCP registration (Hermes: `[Hub MCP] Server registered`; OpenClaw: `CI-Hub plugin initializing`)

### Hermes

- [ ] `config.yaml` contains `mcp_servers.hub` with correct SSE URL and Bearer header
- [ ] Agent can list/call a Hub tool (e.g. `hub_get_inference_status`)

### OpenClaw

- [ ] `openclaw.json` has `plugins.entries.ci-hub.enabled: true`
- [ ] Gateway logs show `Registered N Hub MCP tools`
- [ ] `POST /hooks/hub-wake` accepts signed payloads when wake is configured

### Frontend (ci-hub)

- [ ] Registration, onboarding, AI settings, app store install flows
- [ ] Hermes/OpenClaw install injects env (inspect app container env in Hub UI or `docker inspect`)

See also: [MCP_TESTING_STRATEGY.md](./MCP_TESTING_STRATEGY.md)
