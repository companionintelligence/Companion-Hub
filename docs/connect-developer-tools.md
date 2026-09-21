# Connect your developer tools

Point an editor assistant, a coding agent, or any OpenAI-compatible client at this Hub, so it runs on
the models and the hardware you already own.

The Hub speaks the OpenAI API and the Ollama native API. A client that can be given a base URL and an
API key needs nothing else — Cursor, Continue, Cline, Aider, Zed, the OpenAI SDKs, and anything else
that follows the same shape.

## What you need

| Field | Value |
|---|---|
| Base URL | `http://<hub-host>:5002/api/inference/v1` |
| API key | An `inference`-scoped Hub key — see below |
| Model | Any id from `GET /v1/models`, or `auto` |

`<hub-host>` is this appliance's address on your network: its tailnet name when you use the
[private VPN](private-vpn.md), its LAN address otherwise. `5002` is the default `API_PORT`.

## Create the key

In **Settings → Security**, create a key and choose the **Inference** scope. Or, on the host:

```bash
cihub api-key create --name "Cursor" --scope inference
```

The raw key is printed once. Store it when you see it.

An `inference` key reaches the inference routes and nothing else. It cannot install an app, pair a
peer, read the routing log, or call an MCP tool, and it carries no operator identity — so pasting it
into an editor's settings file does not put the appliance behind it. Revoke it in
**Settings → Security** when the tool no longer needs it.

## Check it works

```bash
curl -s http://<hub-host>:5002/api/inference/v1/models -H "Authorization: Bearer $CI_HUB_INFERENCE_KEY"
```

```bash
curl -s http://<hub-host>:5002/api/inference/v1/chat/completions \
  -H "Authorization: Bearer $CI_HUB_INFERENCE_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"Say hello."}]}'
```

`"model": "auto"` lets the Hub choose. On a single Hub it resolves to your **Settings → Inference**
model, or the best chat model this node holds. In a [pool](hub-pool.md) it resolves across every
paired Hub, and the request runs wherever there is capacity. The `X-Hub-Pool-Served-By` response
header names the node that answered.

## Client settings

Most clients call this an "OpenAI-compatible provider" or a "custom base URL".

**Continue** (`~/.continue/config.yaml`):

```yaml
models:
  - name: Companion Hub
    provider: openai
    apiBase: http://<hub-host>:5002/api/inference/v1
    apiKey: <your inference key>
    model: auto
```

**Anything using the OpenAI Python SDK:**

```python
from openai import OpenAI

client = OpenAI(base_url="http://<hub-host>:5002/api/inference/v1", api_key="<your inference key>")
print(client.chat.completions.create(model="auto", messages=[{"role": "user", "content": "Say hello."}]))
```

**A client that speaks Ollama rather than OpenAI** — set `OLLAMA_HOST` to
`http://<hub-host>:5002/api/inference/pool`. The Hub answers `/api/tags`, `/api/version`,
`/api/chat`, `/api/generate`, `/api/ps`, `/api/show`, and the embedding routes under that prefix.
The Hub's own root answers `/api/tags` and `/api/version` as well, so a client that probes those two
to decide whether it is talking to Ollama gets the right answer either way — but generation lives
only under the prefix, so set the whole URL.

## Pooled routing

To have requests spread across every paired Hub, use the pooled base URL instead:

```
http://<hub-host>:5002/api/inference/pool/v1
```

The same key works on both. The direct path serves from this node's own engines; the pooled path
ranks this node against every connected peer by queue depth and measured throughput, and fails over
when one stops answering. See [`hub-pool.md`](hub-pool.md).

## Troubleshooting

**401 or 403.** The key is missing, revoked, or carries the wrong scope. `cihub api-key list` shows
each key's scopes. A key created before this feature carries `mcp`, which the inference routes do not
accept — create a new one with `--scope inference`.

**403 from a remote machine, with no key.** Without a key, these routes admit only callers on the
appliance's own network. That is the case the key exists for; create one.

**502 saying no backend can serve the model.** No engine on this Hub holds it. `GET /v1/models`
lists what is available. If you asked for `auto` and got a 502, this Hub has no chat model at all —
install one in **Settings → Inference**.

**The first request takes minutes.** A cold model has to load, and a long prompt has to be evaluated
before the first token. A 47,000-token turn takes about 300 seconds to first byte on a GPU node. This
is expected, not a hang; the Hub's own timeouts scale with prompt size.

## Related

- [`hub-pool.md`](hub-pool.md) — routing across several Hubs
- [`MODEL_REGISTRY.md`](MODEL_REGISTRY.md) — which models the Hub recommends for this hardware
- [`security/hub-portal-trust.md`](security/hub-portal-trust.md) — the Hub's trust boundaries
