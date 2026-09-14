# MCP Agent Bootstrap (Hermes & OpenClaw)

How marketplace agent apps connect to the **Hub MCP server** at runtime, and what to verify before dev testing.

## Hub MCP server (control plane edge)

The Hub exposes a platform MCP server (not the per-app stdio bridge):

| Endpoint   | Method                     | Auth                              |
| ---------- | -------------------------- | --------------------------------- |
| `/api/mcp` | POST/GET (Streamable HTTP) | `Authorization: Bearer <API key>` |

The hashed key store is the **sole** auth authority (SEC-MCP-8). Nothing is seeded at boot: every key
in the store was either created by an operator or provisioned to an app, so revoking one really
retires it. The guard deliberately has **no `MCP_API_KEY` env fallback** — that value is derived from
the appliance seed, and a live env compare would be a credential no revoke could retire.

Create a key one of two ways:

- **CLI** — `cihub api-key create --name "<label>"`. Prints the raw key once; store it immediately.
- **UI** — **Settings → Security**. Rotate by creating the new key, rolling it out, then revoking the old one.

`cihub mcp setup` only toggles `MCP_ENABLED`; it does not mint or install a credential.

At **app install**, when `hub_integration.mcp_client: true`, the Hub injects:

| Env var           | Purpose                                                                         |
| ----------------- | ------------------------------------------------------------------------------- |
| `HUB_URL`         | Hub base URL (health, inference REST)                                           |
| `HUB_MCP_URL`     | Streamable HTTP MCP endpoint — `<HUB_URL>/api/mcp`                              |
| `HUB_MCP_API_KEY` | Per-app **managed** MCP key, minted by the Hub key store (revoked on uninstall) |
| `HUB_WAKE_SECRET` | Validates inbound wake webhooks (OpenClaw)                                      |
| `HUB_MCP_ENABLED` | Set `false` to skip MCP wiring                                                  |

Marketplace entries for `ci-hermes` and `ci-openclaw` set `mcp_client: true`.

A managed key may do anything on its own app. On every other app it may operate the app but not change
it ([CI-Hub#1397](https://github.com/companionintelligence/CI-Hub/issues/1397)):

- **Allowed:** read the app (status, logs, config, backups, skill, tools, OpenAPI spec, and operation
  status); start, stop, or restart it, including cancelling an operation in progress; take a backup;
  and call its MCP tools (`hub_call_app_tool`), its API with any method (`hub_call_app_api`), and its
  generated OpenAPI tools.
- **Refused with `APP_ACTION_GRANT_DENIED`:** install it; change its configuration (user config,
  ignored versions, custom-app compose or metadata, availability repair, and app config); uninstall,
  reset, or update it; restore a backup; and delete a backup.

For a managed key, the bulk start, stop, and restart tools act on every app, and the bulk update tool
updates only the key's own app. If an agent must change other apps, give it an operator key, which acts
with the grants of the person who created it.

## CI-Hermes path

Boot order (`entrypoint.sh` / `gateway-entrypoint.sh`):

1. **`bootstrap-from-hub.sh`** — pulls inference credentials, writes `/opt/data/config.yaml` and `.env.hub-bootstrap`.
2. **`bootstrap-ci-context.sh`** — Companion Intelligence plugin, memory MCP, then Hub MCP.
3. **`configure-hub-mcp.py`** — idempotently adds `mcp_servers.hub` to `config.yaml`:

```yaml
mcp_servers:
  hub:
    url: "http://ci-hub:5002/api/mcp"
    headers:
      Authorization: "Bearer <HUB_MCP_API_KEY>"
    timeout: 180
    connect_timeout: 60
```

There is deliberately **no `transport:` line** — omitting it leaves the Hermes agent on its default
Streamable HTTP client, which is what `/api/mcp` speaks. Hermes reaches Hub tools through that native
client; no hand-rolled protocol code is on the hot path.

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

- Exposes `POST /hooks/hub-wake` for Hub → agent wake notifications.
- Optional SSE listener (off by default).

It does **not** register Hub tools or an inference provider. Tools load through OpenClaw's own MCP
client via the `mcp.servers.ci-hub` entry in `openclaw.json`; provider registration was removed
deliberately (CI-Hub#895) and must not be reintroduced.

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

- [ ] MCP enabled (`cihub mcp setup`) and an `mcp`-scoped key created (`cihub api-key create`)
- [ ] `GET /api/health` OK
- [ ] `scripts/qa-mcp-bridge.ts` or e2e `pnpm e2e:mcp` passes

### Install / restart agents

- [ ] Install or restart `ci-hermes` and `ci-openclaw` from marketplace
- [ ] Container logs show Hub MCP registration (Hermes: `[Hub MCP] Server registered`; OpenClaw: `CI-Hub plugin initializing`)

### Hermes

- [ ] `config.yaml` contains `mcp_servers.hub` with the `/api/mcp` URL, Bearer header, and no `transport:` line
- [ ] Agent can list/call a Hub tool (e.g. `hub_get_inference_status`)

### OpenClaw

- [ ] `openclaw.json` has `plugins.entries.ci-hub.enabled: true` and an `mcp.servers.ci-hub` entry
- [ ] Gateway logs show `Hub MCP tools served via native OpenClaw mcp.servers.ci-hub config`
- [ ] `POST /hooks/hub-wake` accepts signed payloads when wake is configured

### Frontend (ci-hub)

- [ ] Registration, onboarding, AI settings, app store install flows
- [ ] Hermes/OpenClaw install injects env (inspect app container env in Hub UI or `docker inspect`)

See also: [MCP_TESTING_STRATEGY.md](./MCP_TESTING_STRATEGY.md)
