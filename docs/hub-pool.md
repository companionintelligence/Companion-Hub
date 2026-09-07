# Hub Pool (multi-Hub inference pooling)

Hub Pool lets two or more CI-Hub devices you operate on the same tailnet share inference capacity: an app on one Hub can be served by whichever paired Hub has the requested model and the shortest queue, with automatic failover if a node stops responding. It builds entirely on the existing [Tailscale private VPN](private-vpn.md) integration — there is no separate discovery protocol or certificate system to manage.

This complements, and does not replace, the existing single-node model recommendation described in [`MODEL_REGISTRY.md`](MODEL_REGISTRY.md): hardware-aware model selection still runs per node, unchanged. Hub Pool only changes *where* a resolved model actually runs once more than one Hub is paired.

## How it fits together

- **Discovery**: the Hub with `TAILSCALE_OAUTH_CLIENT_ID` / `TAILSCALE_OAUTH_CLIENT_SECRET` configured can list tailnet devices via the Tailscale Admin API, then probes each one's `GET /api/inference/pool/identify` (already reachable over the tailnet the same way the Hub's own dashboard is) to find which devices are CI-Hub nodes.
- **Pairing**: a two-way handshake — the requesting Hub sends a token to the candidate; the candidate's operator approves or rejects in **Settings → Network → Hub Pool**; on approval, the candidate issues its own token back. Each side ends up trusting the other with one bearer token per direction (see `hub_pool_peer` in `schema.ts` for the exact model). Rejecting, or never approving, leaves nothing paired. Rejecting and unpairing both send a best-effort *authenticated* notification — the caller presents the token the other side issued it — so the other Hub drops its half immediately instead of forwarding work to a node that will now reject it.
- **Routing**: once at least one peer is `connected`, every app using `hub_integration.inference` is routed through this Hub's own pool proxy (`/api/inference/pool/*`) instead of a directly-resolved backend URL — this is a global switch, not a per-app setting. With zero connected peers, nothing changes: a single-node Hub behaves exactly as it did before this feature existed.
- **Ranking**: local backends and connected peers go into a **single** list ordered by queue depth — in-flight inference requests — so a saturated Hub hands work to an idle peer instead of queueing behind itself. The local node gets a deliberate head start of `poolLocalAffinity` queued requests (default 1): a follow-up turn served here reuses the prompt prefix and KV cache the previous turn left resident, while the same turn sent to a peer re-processes the prompt cold — so work only leaves this node once a peer is at least that much emptier. A peer's queue depth is the larger of the two views this Hub has of it: the `inFlightRequests` figure the peer published at its last health poll, and what this Hub has forwarded it since. Both count the same requests, and neither vantage point sees all of them — the peer's snapshot includes work from apps and nodes we cannot observe, our own counter covers the up-to-one-poll the snapshot missed. A snapshot older than three health polls (90 seconds at the default cadence) is discarded and the peer ranks as mid-load: an unmeasured node must never be mistaken for an idle one. Peers that tie on queue depth are ordered by the hardware tier they report.
- **Failover**: the proxy tries candidates in the ranked order above. It fails over on a connection error, a timeout waiting for response headers, a 5xx, or a 408/429 — never on an ordinary 4xx, since retrying a malformed request on a different machine wouldn't help. A peer additionally gets failed over on 401/403/404: those come from the peer's *own* pairing checks (it stopped trusting our token, or was unpaired from its side) and say nothing about the app's request, so the request moves to the next node and that peer's cached capabilities are dropped until its next successful health poll. Failover stops as soon as a response is committed — once status and headers have gone to the app, a stream that then dies is left to die rather than restarted on another node.
- **Recovery**: a peer that fails three consecutive health polls is marked `unreachable` and stops being offered as a candidate, but it keeps being polled — the first successful probe puts it straight back to `connected`. No operator action is needed, and unpairing is never the way to fix a node that was merely offline.

## Required configuration

- **Tailscale** must already be connected on every Hub that will participate (see [`private-vpn.md`](private-vpn.md)) — Hub Pool has no independent networking of its own.
- **`TAILSCALE_OAUTH_CLIENT_ID`** / **`TAILSCALE_OAUTH_CLIENT_SECRET`**: an OAuth client from the Tailscale admin console with the `devices:core:read` scope, set on whichever Hub(s) should be able to *discover* candidate peers. A Hub without these can still be discovered and paired by another Hub that has them, and still participates fully in routing once paired — the credential is only needed for the discovery/listing step, not for pairing or serving traffic.
- **`HUB_POOL_USER_DISABLED=true`**: explicit opt-out. Forces this Hub to behave as if it had no connected peers (routing reverts to direct/local resolution), makes it stop answering peer capability probes so paired Hubs naturally mark it unreachable, and makes it refuse new inbound pairing requests. Existing pairings are preserved: paired Hubs keep polling an unreachable peer, so within one poll of the flag being removed the pairing is back to `connected` on its own.
- **`HUB_POOL_OUTBOUND_DISABLED=true`** / **`HUB_POOL_INBOUND_DISABLED=true`**: the same kind of operator-of-the-box override for one direction only. Each overrides its persisted setting below and is reported separately by `GET /inference/pool/status`. Like the master flag, neither is projected into `.env` by `generateSystemEnvFile`.

## Operator settings

Persisted in `settings.json` and editable over `GET`/`PATCH /api/inference/pool/settings`. All three take effect on the next request or poll — no restart, and no app is recreated, because every value is read on the Hub's own path rather than injected into an app's environment.

| Setting | Default | Range | What it does |
|---|---|---|---|
| `poolEnabled` | `true` | — | The in-product master kill switch, same effect as the env flag above. |
| `poolOutboundEnabled` | `true` | — | Whether this Hub may **send** work to peers. Off: candidate selection is local-only and a model this node cannot serve fails here with the usual 502 rather than being shipped out. |
| `poolInboundEnabled` | `true` | — | Whether this Hub may **serve** peers' work. Off: peers see a healthy node advertising an empty inventory and `acceptingWork: false`, and route elsewhere; this Hub keeps using them. |
| `poolLocalAffinity` | `1` | 0–20 | Queued-request head start the local node gets over a peer. `0` ranks purely by queue depth — with local still taking an *exact* tie, since serving here costs no hop and reuses a warm cache; higher values make handoff rarer (stickier to local). |
| `poolHealthPollSeconds` | `30` | 10–300 | Seconds between peer capability probes. Also sets how long a peer's snapshot stays trusted — three polls — so slowing the cadence does not silently mark every peer stale. |

## Kill switches: three levels, one precedence

Resolved in `common/helpers/hub-pool.ts` (`resolveHubPoolDirections`) and nowhere else, highest first:

1. `HUB_POOL_USER_DISABLED=true` — both directions off.
2. persisted `poolEnabled === false` — both directions off.
3. `HUB_POOL_OUTBOUND_DISABLED` / `HUB_POOL_INBOUND_DISABLED` — that direction off.
4. persisted `poolOutboundEnabled` / `poolInboundEnabled === false` — that direction off.
5. per-peer `hub_pool_peer.enabled === false` — that peer only, in **both** directions.

The master short-circuits both directions rather than being folded in per-axis, so an operator who turns pooling off never has to reason about what the directional switches were left at. Every switch is opt-out (absent = on), so an untouched `settings.json`, no new env vars and `enabled DEFAULT true` on every migrated row resolve to exactly the behaviour of the build before they existed.

**The refusal is deliberately asymmetric, and this is not an oversight to tidy up.** The master switch means *"I have left the pool"*: `GET /capabilities` answers **503**, and paired Hubs mark this node unreachable after three strikes — documented, tested behaviour. Inbound-off and a per-peer disable mean *"I am still in the pool, still using you, just not serving right now"*: `GET /capabilities` answers **200** with the real `hardwareTier` and live `inFlightRequests`, an empty `backends`, and `acceptingWork: false`. The sending node skips such a peer on that flag explicitly — not on the empty inventory, which is pixel-identical to a node whose engines are down. A peer on an older build sees only the empty inventory and behaves correctly anyway. `POST /local/*` additionally answers **503** (never 403, which the sender reads as "it no longer considers us paired" and which would drop a healthy pairing's cached capabilities), covering the window where a peer is acting on a snapshot up to one poll old.

Two consequences worth knowing:

- **The outbound gate lives in `PoolProxyService.buildCandidateList`, not in `listConnectedPeers()`.** The latter also answers `hasConnectedPeers()`, which `inference-env-resolver.ts` consults **once, at app install time**, to decide whether an app's `CI_LLM_BASE_URL` points at the pool proxy. Gating it there would permanently repoint every app created while outbound was off.
- **Two dashboards will legitimately disagree.** A Hub that has disabled a peer still polls it successfully and shows it `connected` (plus a "disabled" pill); the peer shows this node as not accepting work. Both are the honest local truth on each side.

Per-peer disable keeps the pairing, both directional tokens and the health poll intact — that is what makes it instantly reversible, and it means **disabled is not revocation**. An operator who wants the token gone must still Unpair.

**`HUB_POOL_USER_DISABLED` wins over `poolEnabled`.** The env flag is an operator-of-the-box decision that a UI toggle must not be able to undo, so the setting is deliberately *not* projected into `.env`: routing it through `HUB_POOL_USER_DISABLED` would put it behind `generateSystemEnvFile`'s env-first precedence, and pooling could never be turned back on from the UI once the flag had been written to disk. `GET /api/inference/pool/status` reports which switch is in force (`disabledBy: 'env' | 'setting' | null`) precisely so the UI can say "your `.env` overrides this" instead of showing a toggle that appears to do nothing.

## Operator status and routing log

- **`GET /api/inference/pool/status`** (session auth) answers the whole question in one call: `enabled` / `disabledBy` / `reason` (`active`, `no_peers`, `partially_disabled`, `disabled_by_env`, `disabled_by_setting`), `directions` (each of `outbound`/`inbound` with its own `enabled`/`disabledBy`), `routingActive` — which now means outbound is on **and** at least one connected, *enabled* peer exists — the persisted `settings`, `tailscaleAdminApiConfigured` (whether discovery can work at all — the boolean only, never the credentials), this node's identity, queue depth and per-backend model inventory, and every peer with its status, `lastSeenAt`, `consecutiveFailures`, cached backends/models, and the number of requests currently forwarded to it. Peer rows go through `toPublicPeer`, so the token columns cannot appear. It is cheap enough to poll: one `SELECT`, in-memory counters, the 30s-cached Tailscale status, and a 20s-cached local inventory — it never runs peer discovery (a Tailscale OAuth exchange plus an HTTPS probe per tailnet device) and never re-probes peers.
- **`GET /api/inference/pool/routing-log?limit=`** (session auth) returns the last 200 routing decisions, newest first: timestamp, direction, path, model, the node that served it, how many candidates were ranked, which attempt won, the chain of nodes that were tried and rejected before it, outcome, upstream status and time to response headers. A request that failed over is **one** entry carrying `failedOverFrom`, not one per attempt. Inbound entries record work a *peer* forwarded to this node's engines, attributed to the peer the guard authenticated. It is bounded, in-memory and process-local — no database table, and nothing survives a restart — and it records metadata only: never a prompt, a request body, or a response.

## What guards what

- **`POST /pair/request`** is the one unauthenticated write — a would-be peer has no credential yet by definition. It is therefore the most constrained: the kill switch blocks it outright; `fromNodeFqdn` must be a bare hostname (a scheme, credentials, port, path or IP literal is refused, because that value is interpolated into every later `https://<fqdn>/api/...` call this Hub makes to the peer, including the one that carries a freshly issued token); the name must belong to this tailnet whenever `TAILSCALE_OAUTH_CLIENT_ID`/`SECRET` let the Hub check (with no credential, or with the Admin API unreachable, the check degrades to a warning rather than blocking a legitimate request); at most 20 inbound requests may await approval at once; and an unanswered request expires after 24 hours, so a squatted name cannot block pairing with the real device indefinitely.
- **`/pair/confirm`, `/pair/reject`, `/pair/unpair`, `/capabilities`, `/local/*`** require `PoolPeerGuard`: `X-Hub-Pool-Peer: <caller's own FQDN>` plus the bearer token *this* Hub issued that peer.
- **`/peers/*`** are operator routes behind the normal session `AuthGuard`.
- **The app-facing `/v1/*` and `/api/*` proxy routes** are reachable only from inside the appliance. `InternalNetworkGuard` checks the source IP, and `PoolAppGuard` additionally refuses anything carrying reverse-proxy provenance (`cf-ray` and friends, or an `X-Forwarded-For` hop that is not private) — because behind the Cloudflare tunnel `request.ip` is the proxy's own private address unless `HUB_TRUST_PROXY` is set, and these routes spend GPU time on every paired node. Apps reach the proxy container-to-container and carry none of those headers. Note this is an origin check, not caller authentication: an app that only declares `hub_integration.inference` is issued no Hub-managed key, so there is no per-app credential to bind to. Any container on the Hub's Docker network can use the pool.

## Operator workflow

1. On each participating Hub, confirm **Settings → Network** shows Tailscale connected.
2. On at least one Hub, set the Tailscale OAuth client env vars above and restart.
3. Open **Settings → Network → Hub Pool**. Discoverable devices on the tailnet that identify as CI-Hub nodes appear with a **Pair** button. Without the OAuth credential the section says so and names the two variables, rather than showing an empty list — a Hub with no credential can still be paired *with*, it just cannot enumerate the tailnet itself.
4. On the *other* Hub, a pending inbound request appears with **Approve** / **Reject**, identified by the requester's FQDN.
5. Once connected, both Hubs' **Hub Pool** sections show whether pooling is actually routing (and if not, which of the two kill switches is responsible), the `poolEnabled` and `poolLocalAffinity` controls, each peer's status / last-seen / queue depth / hardware tier / engines, the merged list of models the pool can serve and which nodes hold each, and the recent routing decisions with failovers called out.

A peer shown **unreachable** needs no operator action: it is skipped while it fails probes and rejoins on the next successful one. Unpairing is for removing a Hub from the pool, not for recovering one.

To validate a real two-node pool end to end — pairing, routing, load handoff, failover, recovery, the
kill switch, and the security checks — follow [`hub-pool-fleet-testing.md`](hub-pool-fleet-testing.md).

Every step above is also available headlessly through `cihub pool` — `status`, `peers`, `discover`, `pair`, `approve`, `reject`, `unpair`, `log`, `enable`, `disable` — which is the path for an SSH-only Hub or a coding agent. It hits the same endpoints with the Portal device key and runs on the Hub it manages, so approval still happens on the receiving Hub. See [`CLI.md` → Hub Pool](CLI.md#hub-pool).

## Endpoints an app sees through the proxy

Apps using `hub_integration.inference` get `CI_LLM_BASE_URL`, `OLLAMA_HOST` and `CI_OLLAMA_EMBED_HOST` pointed at the pool proxy, so it has to answer both protocols:

| Routed across the pool (body carries `model`) | Served by this node only |
|---|---|
| `POST /v1/chat/completions`, `/v1/completions`, `/v1/embeddings` | `GET /v1/models` |
| `POST /api/generate`, `/api/chat`, `/api/embeddings`, `/api/embed` | `GET /api/tags`, `GET /api/ps`, `GET /api/version`, `POST /api/show` |

`POST /api/pull` and the other model-management natives are deliberately absent — pulling a model is a node-local administrative action, not something the pool should silently perform on whichever machine answered.

## Known limitations (v1)

- `GET /v1/models` and `GET /api/tags` through the pool proxy list only this node's own local backends — they do not yet merge in what connected peers report. Chat/completion/embedding requests do use the full pool, including peers; only the *listing* endpoints are local-only for now.
- Peer health is polled on an interval (`poolHealthPollSeconds`, 30s by default) rather than pushed, so a peer that just went down may still be offered as a candidate until the next poll — the per-request failover is what actually protects a live request in that gap.
- The routing log holds the last 200 decisions in memory and is gone on restart. There is still no persisted history of *anything* else: no pairing lifecycle (rejected and expired rows are hard-deleted), no per-peer request totals, and no record of why a peer became unreachable beyond the current strike count.
- Time-to-headers is the only latency figure recorded. Token counts and tokens-per-second are not available: the response body is piped through untouched, and counting tokens would mean parsing the stream the proxy deliberately never reads.
- Queue depth is the only load signal. The Hub has no live GPU-utilization or VRAM-pressure telemetry to rank on — `HardwareInspectorService` reports a static hardware profile, not counters — so a peer whose GPU is busy with work that never went through the pool still reports an empty queue. Reported hardware tier only breaks ties between equally queued peers; it does not deprioritize a slow GPU that happens to be idle.
- Queue depths are per-process and reset when a Hub restarts, so for the first moments after a restart every node looks idle to itself. The peer-side freshness rule covers the other direction (a peer that has gone quiet ranks as mid-load), but nothing corrects a node's view of its own load.
- A node's model inventory is what it has on **disk**, not what is resident in VRAM — Ollama's `/api/tags`, for one, lists every pulled model. A candidate that must cold-load the model therefore ranks alongside one already holding it warm; the local head start hedges this for the common follow-up-turn case, it does not fix it. What the inventory no longer does is hide a model the node cannot load **at all**: see the note below.

## When a node lists a model it cannot actually serve

Cold-start is the mild version of this. The severe one was found on fleet node core-4, which answered `GET /api/tags` with 200 and `gemma3:1b` in the list while every `POST /api/generate` for that model returned HTTP 500 `model failed to load, this may be due to resource limitations or an internal error`. Selecting candidates on the inventory alone made that node a first-choice destination for a model it failed **every** request for, and the same claim went out to every peer as this node's advertised capabilities.

Nothing cheap distinguishes that node from a healthy one. The only proof a model can be served is serving it, and generating on each health poll would pull every listed model into VRAM on the poll cadence — so the evidence is taken from the requests that were going to run anyway:

- A local candidate that answers **5xx** is reported back to the engine that produced it. 408 and 429 are not: they are the engine talking about its queue, not about the model, and treating load shedding as incapacity would turn a busy minute into an outage. A peer's 5xx is not either — a peer corrects its own capabilities, and the relayed status says nothing about which of *its* backends failed.
- Two such observations within five minutes withhold that **one model on that one backend** from routing, first for 60s, doubling to a 15-minute ceiling if the model keeps failing when it is re-offered. Withholding is never permanent: the entry expires, the model is offered again, and the next request is the re-probe.
- A rejected explicit `loadModel` is decisive on its own — that request asks the engine to do nothing but load the model. A *connection* failure is not: that is the whole daemon being unreachable, which the health check already reports.
- Anything proving the model runs — a completed request, a successful load, or Ollama reporting it resident in `/api/ps` — clears the record and the backoff outright. `/api/ps` is read only while something is withheld, so an untroubled node's health poll is still a single request.

Only routing reads this. `modelsLoaded` keeps its meaning as the on-disk inventory, so the installed badge and the model puller still see a model that is present but currently unloadable — the same distinction, exposed to the pool as `unservableModels`.
