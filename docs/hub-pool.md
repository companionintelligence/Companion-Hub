# Hub Pool (multi-Hub inference pooling)

Hub Pool lets two or more CI-Hub devices you operate on the same tailnet share inference capacity: an app on one Hub can be served by whichever paired Hub currently has the requested model loaded and the lightest queue, with automatic failover if a node stops responding. It builds entirely on the existing [Tailscale private VPN](private-vpn.md) integration — there is no separate discovery protocol or certificate system to manage.

This complements, and does not replace, the existing single-node model recommendation described in [`MODEL_REGISTRY.md`](MODEL_REGISTRY.md): hardware-aware model selection still runs per node, unchanged. Hub Pool only changes *where* a resolved model actually runs once more than one Hub is paired.

## How it fits together

- **Discovery**: the Hub with `TAILSCALE_OAUTH_CLIENT_ID` / `TAILSCALE_OAUTH_CLIENT_SECRET` configured can list tailnet devices via the Tailscale Admin API, then probes each one's `GET /api/inference/pool/identify` (already reachable over the tailnet the same way the Hub's own dashboard is) to find which devices are CI-Hub nodes.
- **Pairing**: a two-way handshake — the requesting Hub sends a token to the candidate; the candidate's operator approves or rejects in **Settings → Network → Hub Pool**; on approval, the candidate issues its own token back. Each side ends up trusting the other with one bearer token per direction (see `hub_pool_peer` in `schema.ts` for the exact model). Rejecting, or never approving, leaves nothing paired. Unpairing sends a best-effort authenticated notification so the other Hub drops its half immediately instead of forwarding work to a node that will now reject it.
- **Routing**: once at least one peer is `connected`, every app using `hub_integration.inference` is routed through this Hub's own pool proxy (`/api/inference/pool/*`) instead of a directly-resolved backend URL — this is a global switch, not a per-app setting. With zero connected peers, nothing changes: a single-node Hub behaves exactly as it did before this feature existed.
- **Failover**: the proxy tries the local backend first (if it has the model), then connected peers ordered by lowest current in-flight request count. It fails over on a connection error, a timeout waiting for response headers, a 5xx, or a 408/429 — never on an ordinary 4xx, since retrying a malformed request on a different machine wouldn't help. A peer additionally gets failed over on 401/403/404: those come from the peer's *own* pairing checks (it stopped trusting our token, or was unpaired from its side) and say nothing about the app's request, so the request moves to the next node and that peer's cached capabilities are dropped until its next successful health poll. Failover stops as soon as a response is committed — once status and headers have gone to the app, a stream that then dies is left to die rather than restarted on another node.
- **Recovery**: a peer that fails three consecutive health polls is marked `unreachable` and stops being offered as a candidate, but it keeps being polled — the first successful probe puts it straight back to `connected`. No operator action is needed, and unpairing is never the way to fix a node that was merely offline.

## Required configuration

- **Tailscale** must already be connected on every Hub that will participate (see [`private-vpn.md`](private-vpn.md)) — Hub Pool has no independent networking of its own.
- **`TAILSCALE_OAUTH_CLIENT_ID`** / **`TAILSCALE_OAUTH_CLIENT_SECRET`**: an OAuth client from the Tailscale admin console with the `devices:core:read` scope, set on whichever Hub(s) should be able to *discover* candidate peers. A Hub without these can still be discovered and paired by another Hub that has them, and still participates fully in routing once paired — the credential is only needed for the discovery/listing step, not for pairing or serving traffic.
- **`HUB_POOL_USER_DISABLED=true`**: explicit opt-out. Forces this Hub to behave as if it had no connected peers (routing reverts to direct/local resolution) and makes it stop answering peer capability probes, so paired Hubs naturally mark it unreachable. Existing pairings are preserved: paired Hubs keep polling an unreachable peer, so within one 30s poll of the flag being removed the pairing is back to `connected` on its own.

## Operator workflow

1. On each participating Hub, confirm **Settings → Network** shows Tailscale connected.
2. On at least one Hub, set the Tailscale OAuth client env vars above and restart.
3. Open **Settings → Network → Hub Pool**. Discoverable devices on the tailnet that identify as CI-Hub nodes appear with a **Pair** button.
4. On the *other* Hub, a pending inbound request appears with **Approve** / **Reject**.
5. Once connected, both Hubs' **Hub Pool** sections show the peer's status, last-seen time, and a summary of the models it currently reports.

## Endpoints an app sees through the proxy

Apps using `hub_integration.inference` get `CI_LLM_BASE_URL`, `OLLAMA_HOST` and `CI_OLLAMA_EMBED_HOST` pointed at the pool proxy, so it has to answer both protocols:

| Routed across the pool (body carries `model`) | Served by this node only |
|---|---|
| `POST /v1/chat/completions`, `/v1/completions`, `/v1/embeddings` | `GET /v1/models` |
| `POST /api/generate`, `/api/chat`, `/api/embeddings`, `/api/embed` | `GET /api/tags`, `GET /api/ps`, `GET /api/version`, `POST /api/show` |

`POST /api/pull` and the other model-management natives are deliberately absent — pulling a model is a node-local administrative action, not something the pool should silently perform on whichever machine answered.

## Known limitations (v1)

- `GET /v1/models` and `GET /api/tags` through the pool proxy list only this node's own local backends — they do not yet merge in what connected peers report. Chat/completion/embedding requests do use the full pool, including peers; only the *listing* endpoints are local-only for now.
- Peer health is polled on a fixed interval (every 30s) rather than pushed, so a peer that just went down may still be offered as a candidate for a short window until the next poll — the per-request failover is what actually protects a live request in that gap.
- There is no cost- or capability-aware ranking beyond "local first, then lowest in-flight peer count." A peer with a much slower GPU is not deprioritized relative to a faster one running the same model.
