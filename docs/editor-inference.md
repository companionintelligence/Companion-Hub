# Use your Hub from your editor

Companion Hub answers the OpenAI chat-completions API at `/api/inference/v1`, so an editor or SDK that takes a base URL, an API key, and a model id gets its completions from your own hardware instead of a cloud provider. A single Hub serves the request from its own engine. A Hub with [paired peers](hub-pool.md) routes it to whichever node holds the model and has the shortest queue, fails over when a node stops answering, and names the node that served it in the response headers. Ask for model `auto` and the Hub picks the best chat model the pool holds, or the model you set in **Settings → Inference**.

## Before you begin

Mint the key in **Settings → Security** — create a key and choose the **Inference** scope — or on the Hub host with the CLI. `cihub api-key create` writes the row over `docker exec` into the Hub's own database, so it cannot run from your laptop: `ssh` to the Hub, or open a terminal on it.

```bash
cihub api-key create --name "laptop-zed" --scope inference
```

The raw key prints once. Store it before you close the terminal; the Hub keeps only a hash. `inference` must be the only scope on the key, and the CLI refuses `--scope mcp,inference`. A Hub built before the `inference` scope existed accepts the row but authenticates nothing with it (see [Troubleshooting](#troubleshooting)).

## The three values

| Field | Value |
|---|---|
| Base URL | `http://<hub-host>:5002/api/inference/v1` |
| API key | The key `cihub api-key create --scope inference` printed |
| Model | `auto`, or an installed tag as `ollama list` prints it on the Hub (for example `qwen3.6:27b`) |

`5002` is the Hub API port. If you changed `API_PORT`, use that port.

## Where `<hub-host>` comes from

The LAN address is the Hub host's own: `ip -4 addr` on the Hub, or your router's client list. The public hostname is the `hub url` line `cihub register` printed, which is also the address the dashboard opens at through the tunnel. **Settings → Network** shows the Tailscale hostname.

| You are on | Base URL | Key |
|---|---|---|
| The Hub's LAN | `http://192.168.1.42:5002/api/inference/v1` | Any value works; the Hub admits you by network origin |
| The Hub's tailnet | `https://core-14.tailxyz.ts.net/api/inference/v1` — the Tailscale Serve hostname from [`private-vpn.md`](private-vpn.md#access-the-hub-itself) | Any value works |
| Anywhere else | `https://<hub-subdomain>.<domain>/api/inference/v1` — the public hostname Portal assigned at registration | Required |

The Hub admits a request whose address and every forwarded hop are private, with no Cloudflare marker, without reading the key at all. A request that arrived through the Cloudflare tunnel, or through any hop with a public address, must carry a valid `inference` key. Configure the real key everywhere anyway: the same config then works from anywhere.

## Continue

Verified against Continue's `config.yaml` reference. Continue's default roles for a model are chat, edit, apply, and summarize; autocomplete is not among them, and [Limits](#limits) says why not to add it.

```yaml
models:
  - name: Companion Hub
    provider: openai
    model: auto
    apiBase: http://<hub-host>:5002/api/inference/v1
    apiKey: <key>
```

## Zed

Verified against Zed's *Use API access* page. Add the provider to `settings.json`; enter the key in the Agent panel's provider settings or export `COMPANION_HUB_API_KEY` (Zed derives the variable from the provider id and tells you not to put keys in `settings.json`). `max_tokens` is the model's context window.

```json
{
  "language_models": {
    "openai_compatible": {
      "companion-hub": {
        "api_url": "http://<hub-host>:5002/api/inference/v1",
        "available_models": [
          { "name": "auto", "display_name": "Companion Hub (auto)", "max_tokens": 32768 }
        ]
      }
    }
  }
}
```

## Cline

In Cline's settings choose the **OpenAI Compatible** provider and fill in **Base URL** (`http://<hub-host>:5002/api/inference/v1`), **API Key**, and **Model** (`auto`). Cline's docs name these three fields; the model-configuration section below them (context window, max output tokens) is optional.

## Aider

Verified against Aider's OpenAI-compatible page. The `openai/` prefix is what sends the model to `OPENAI_API_BASE`.

```bash
export OPENAI_API_BASE=http://<hub-host>:5002/api/inference/v1
export OPENAI_API_KEY=<key>
aider --model openai/auto
```

## Cursor

Cursor's docs say custom API keys are sent to Cursor's backend "because all requests are routed through Cursor's servers for final prompt building", and that Tab completion keeps using Cursor's own models. A LAN or tailnet address is therefore unreachable from Cursor: if your Cursor build offers an OpenAI base URL override, the public hostname with the key is the only address that can work. Cursor's current docs describe the key field and not a base URL field, so check your build.

## OpenAI Python SDK

Verified against the `openai-python` README. Any OpenAI SDK that takes a base URL works the same way; the Python client also reads `OPENAI_BASE_URL` and `OPENAI_API_KEY` from the environment.

```python
from openai import OpenAI

client = OpenAI(base_url="http://<hub-host>:5002/api/inference/v1", api_key="<key>")
completion = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Say hello."}],
)
print(completion.choices[0].message.content)
```

## curl

```bash
curl -s http://<hub-host>:5002/api/inference/v1/chat/completions \
  -H "Authorization: Bearer <key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Say hello."}]}'
```

`curl -sD - -o /dev/null` with the same arguments prints the headers alone, including `X-Hub-Pool-Served-By` on a pooled Hub.

## Ollama-speaking clients

A client that speaks Ollama's native API takes the pool proxy as its server — the same value the Hub hands its own apps as `OLLAMA_HOST`:

```bash
export OLLAMA_HOST=http://<hub-host>:5002/api/inference/pool
```

The same key opens this base, and the same origin rule applies. A client that cannot add an `Authorization` header works on the LAN and tailnet only; from the public hostname use the OpenAI-compatible base with a client that can.

## What the key can and cannot do

- It opens exactly the inference routes: `/api/inference/v1/*` and the app-facing `/api/inference/pool/*` (both the `/v1/*` and Ollama-native `/api/*` paths). Every other route refuses it.
- On the LAN or tailnet the Hub admits your editor by network origin and never looks the key up, so a placeholder there costs nothing and proves nothing. From the public hostname the key is checked on every request.
- It never opens MCP, the Hub dashboard, the operator API, or Portal. It carries no operator authority, which is why it may sit in an editor config that syncs to a cloud: a leaked key spends GPU time and nothing else.
- Create and revoke it in **Settings → Security**, where it lists with the **Inference** badge. The CLI has `create` and `list` only.

## Bringing your own engine

The reverse direction works too: if you already run a model server, the Hub can serve from it rather
than asking you to switch. Point it at one and the pool places work on it like any other backend.

| Engine | Variable | Notes |
|---|---|---|
| oMLX | `OMLX_URL` | Apple Silicon. Default `http://host.docker.internal:8000`. `owned_by` is `omlx`. |
| vLLM | `VLLM_URL` | Also settable in **Settings → AI**. |
| Manual endpoints | decode and encode fields in Settings | Either URL may be set alone. Re-check probes the typed URL. |

Hub does not download weights for oMLX or vLLM. Whatever the server reports on `/v1/models` is what it can serve. A typed decode or encode endpoint is probed the same way, and its models show up in this Hub's `GET /v1/models` alongside everything else.

## Limits

- `POST /v1/completions` answers 400 on the `/api/inference/v1` base: the Hub serves chat completions there and does not translate the legacy shape. A client that needs the legacy route — some autocomplete features do — takes `http://<hub-host>:5002/api/inference/pool/v1` as its base, where `/v1/completions` is forwarded to the engine.
- `GET /v1/models` on the `/api/inference/v1` base lists the curated catalog, including models the Hub has not pulled yet (`"state": "available"`), and never lists `auto`. Pick `auto` or a row in state `loaded`, `pinned`, or `pulled`; a request for a model in state `available` answers 502 rather than pulling it. Through the pool base, `GET /v1/models` lists this node's own models only — see [Known limitations](hub-pool.md#known-limitations-v1).
- `/v1/audio/speech` and `/v1/audio/transcriptions` exist for apps. Transcription takes a raw body rather than the multipart form an OpenAI client sends, so neither is an editor route.
- A pooled response carries `X-Hub-Pool-Served-By`, `X-Hub-Pool-Backend`, `X-Hub-Pool-Model`, and `X-Hub-Pool-Request-Id` (see [Operator status and routing log](hub-pool.md#operator-status-and-routing-log)). A pooled stream also ends with a usage-only chunk whose `choices` array is empty, because the proxy sets `stream_options.include_usage` on your behalf to record token counts; a client that reads `choices[0]` from every chunk must check for it.
- There is no rate limit on the key. A key in a shared config file is a shared GPU budget.

## Troubleshooting

The 401 and 503 refusals, and a single-node Hub's 502s, are OpenAI-shaped — `{ "error": { "message", "type" } }`, the 401s with a `code` as well — so an editor shows `error.message` verbatim. A pooled Hub writes its 502s as `{ "error": "<message>" }`, a plain string: the pooled rows below quote that string, and a client that reads only `error.message` shows a bare 502 for them.

| Response | Meaning | Fix |
|---|---|---|
| 401 `code: "missing_api_key"` | The request arrived from outside the appliance network with no `Authorization` header, or one that is not exactly `Bearer <key>` | Configure the key; check that the client sends it as a bearer token and not as a query parameter or a custom header |
| 401 `code: "invalid_api_key"` | The token is not a key this Hub minted (a placeholder such as `ollama`), is not in this Hub's key store, has expired, or does not carry the `inference` scope | Mint the key on **this** Hub with `--scope inference`; an `mcp` key is refused here by design |
| 403 `This endpoint is only available on the local appliance network`, or `The pool proxy is only available to apps on the local appliance network` — a plain `{ "statusCode", "message" }` body, not the OpenAI shape | The Hub was built before the `inference` scope existed and admits by origin only | Update the Hub; until then use the LAN or tailnet address |
| 502 `No models available — no local models loaded and no cloud providers configured`, or on a pooled Hub `No chat model on this Hub or its connected peers can stand in for "auto"` | `auto` found nothing to run | Pull a chat model in **Settings → Inference** or with `cihub models install <name>`, or name a tag that `ollama list` shows |
| 502 `Model <id> not found or not available`, or on a pooled Hub `No pool node currently has model "<id>" available.` | You named a catalog model the Hub has not pulled, or a tag no engine holds | Pull it first, or pick a row `GET /v1/models` shows as `loaded` or `pulled` |
| 502 with another message | The engine, or every pool candidate, failed the request; the message is the upstream error | On a pooled Hub, `cihub pool log` names the node and the upstream status; otherwise **Settings → Inference** shows the engine's state |
| 503 `Authentication temporarily unavailable — API key store unreachable` | The Hub could not reach its database to check the key. Your key is not wrong | Retry; `cihub status` shows whether `ci-hub-db` is up |
