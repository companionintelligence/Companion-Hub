# Hub Pool vs NVIDIA Personal-AI-Router (PAIR)

Comparison of CI-Hub's `hub-pool` module against [NVIDIA/Personal-AI-Router](https://github.com/NVIDIA/Personal-AI-Router),
the closest published prior art. PAIR behaviour below is quoted from its `README.md` and `docs/architecture.mdx`;
CI-Hub behaviour is read from the implementation, not from its own docs.

Both systems solve the same problem — *route one inference request to one of several machines that
might serve it* — and, independently, landed on the same three structural decisions. The differences
are concentrated in discovery, trust, and the load signal.

## Where the designs agree

| Decision | PAIR | Hub Pool |
|---|---|---|
| One request → one node | "routes each independent request to one node"; "the proxy never splits it" | `proxyRequest()` walks candidates, serves from one |
| Ordered failover list, not a single pick | "an ordered failover list of nodes eligible for that request, then walks it" | `buildCandidateList()` → `for (const candidate of candidates)` |
| Model eligibility filters candidates first | "only nodes whose per-engine inventory advertises the requested model" | `localCandidates(model)` + `peerCandidates(model, peers)` |
| Responses stream, never buffered | streams back along the arrival path | `pipeline()` from upstream to `res` |
| Genuine client 4xx is **not** retried | "400 or 422 are not retried, because they would fail identically everywhere" | `shouldFailover()` passes them through untouched |
| No eligible owner → local 502 | "returns an actionable local 502 without sending the request to an engine" | `candidates.length === 0` → 502 |
| **No third-node relay** | "A peer request is served, not re-routed… never re-enters candidate selection" | `forwardToLocalBackendAndRespond()` calls the backend directly |
| Network membership ≠ authorization | mTLS on peer surfaces regardless of LAN | `PoolPeerGuard` required even though the tailnet already gates reachability |
| Unmeasured node ranks neutral, never idle | missing telemetry = "neutral pressure of 1" | `UNKNOWN_PEER_LOAD = 1`, and `UNKNOWN_PRESSURE = 1` on the pressure band |
| Dispatcher reserves its own choice | "adds the requests it has just dispatched itself to its own estimate and reserves its choice before forwarding" | `loadService.acquire(key)` runs *before* `forward()` |

The third-node prohibition is the most striking convergence: both codebases implement it the same
way — a separate peer-facing ingress path that forwards straight to the local engine — and both
comment it as the specific mechanism that prevents chaining.

## Where they differ

### 1. Discovery — mDNS vs Tailscale control plane

PAIR runs `nvpair-node-scanner`, advertising one `_nvpair-node._tcp` mDNS record per host carrying
UUID, cluster membership, ports and a ranked address list, plus manual direct-address probing.
Eviction tolerates "three consecutive misses".

Hub Pool queries the **Tailscale Admin API** for tailnet devices, then probes each candidate's
`GET /inference/pool/identify` to confirm it is a Hub.

- PAIR works on any flat LAN with zero external dependency; it is confined to one broadcast domain.
- Hub Pool spans LAN, WAN and NAT for free, and inherits WireGuard transport encryption — but is
  inert without a tailnet, and needs `TAILSCALE_OAUTH_CLIENT_ID`/`_SECRET`.

Neither is strictly better. PAIR's is more self-contained; ours reaches machines PAIR cannot.

### 2. Trust bootstrap — PIN/mTLS vs pairing handshake + bearer tokens

PAIR: six-digit PIN bootstraps **mutual TLS**; each node holds a stable UUID and self-signed leaf
certificate, and "pairing pins each side's certificate against the other's UUID". It multiplexes
plaintext loopback and TLS on one port by sniffing the first byte (`0x16` = TLS handshake).

Hub Pool: pairing handshake issues **directional bearer tokens**, stored sha256-hashed
(`verify_token_hash`) and compared with `timingSafeEqual`; transport security is WireGuard's.

**PAIR's peer authentication is cryptographically stronger** — mTLS binds identity to a pinned
certificate, ours binds it to a shared secret that the receiving node stores hashed. Ours is simpler
and rides a transport that is already authenticated and encrypted per-device. The honest reading:
PAIR must do mTLS because its transport is an untrusted LAN; we can lean on the tailnet, and would
need something closer to PAIR's model if Hub Pool ever ran off-tailnet.

One point in our favour: PAIR's telemetry surface is "plaintext HTTP, not authenticated". Hub Pool
has no unauthenticated peer surface.

### 3. The load signal — **the one real capability gap**

PAIR ranks on **pending work + GPU pressure**:
- pending = workloads "queued or running", attributed to the placement node
- GPU utilization mapped to "0–3 pressure units at 40%, 70%, and 85%", with hysteresis against thrashing
- sort by *pending + pressure*, then *pressure*, then node ID

Hub Pool ranks on **queue depth + GPU pressure + hardware tier**:
- `score` = in-flight requests, plus `poolPressureWeight × pressure`, plus a `poolLocalAffinity` handicap applied to peers
- tie-break `pressure` (only when `poolPressureWeight` is non-zero), then `tierRank` (high → medium → low → cpu-only → insufficient); local is `-1`, never out-ranked on hardware
- stable sort, so ties keep insertion order

**The GPU-pressure gap is now partly closed, on the same 0–3 shape.** See
[GPU pressure](hub-pool.md#gpu-pressure-a-second-load-signal-amd-only-and-off-by-default). Two
caveats keep it from being parity:

- **It is AMD-only.** `gpu_busy_percent` from DRM sysfs is the only live utilization counter the Hub
  container can reach; `nvidia-smi` is not in the Alpine image and the Docker socket is mounted `:ro`
  deliberately. NVIDIA and Apple nodes report nothing and rank mid-band until someone writes the
  documented host-file probe. PAIR runs on a fleet where every node can answer.
- **It ships off** (`poolPressureWeight = 0`) and needs a `/sys` bind mount this repo does not
  install, because the band is unvalidated on real fleet hardware. Where it is not enabled, the
  paragraph this replaces still describes the behaviour: a node running a long generation at 100% GPU
  and one sitting idle look identical if their in-flight counts match, and in-flight count is a poor
  proxy because one 8k-token generation and one one-token completion both count as 1.

What did carry over cleanly is PAIR's shape: the 40/70/85 thresholds, the hysteresis deadband, the
`pending + pressure` score, and above all the rule that a node with no telemetry ranks at a neutral
pressure of 1 rather than at 0.

Conversely, **PAIR explicitly does not consider "GPU model, available memory, model warmness, or how
expensive a request looks"** — and we *do* carry hardware tier as a tie-break, which on a fleet as
heterogeneous as ours (Strix Halo iGPU next to an RTX 3080 next to a Threadripper) is a real signal
PAIR discards. So the ranking comparison is not one-sided: PAIR has the better dynamic signal, we
have the better static one. Both miss model warmness.

### 4. Failover granularity — ours is finer

PAIR retries `404`, and not `400`/`422`.

Hub Pool distinguishes by *candidate kind*:
- local candidate: retry on 5xx, `408`, `429`
- **peer** candidate: additionally retry `401`, `403`, `404` — because from a peer those describe the
  *pairing hop* (its `PoolPeerGuard`, its connected-check, a route its build lacks), not the request

We also drop a peer's cached capabilities when it answers 401/403, and — a case PAIR's docs do not
address — **stop failing over once the response is committed**: after status and headers reach the
client, a second candidate has nowhere to write, so the stream is destroyed rather than restarted
mid-answer.

### 5. Features PAIR has that we do not

- **Manual node pinning.** PAIR's routing priority is (1) pinned nodes, (2) scheduler ranking, (3) node ID.
  Hub Pool has no pin — grep finds no `pinned`/`preferredNode`/node-override header anywhere in the module.
  For "run this on the Threadripper because I said so", we have no answer.
- **Supervised worker processes.** PAIR's broker restarts workers with exponential backoff (~1s→16s,
  five attempts). Hub Pool is a NestJS module inside the Hub; engine supervision is Docker's.
- **Cluster-wide model inventory.** PAIR advertises per-engine inventory across the cluster; our
  `GET /v1/models` and `/api/tags` through the pool proxy still list **only this node's** backends
  (documented gap in `docs/hub-pool.md`). Chat/completion/embedding do use the full pool.

### 6. Features we have that PAIR does not

- **Bidirectional routing log.** We record both outbound decisions (which node, which attempt, what it
  failed over from) *and* inbound forwards, so an operator can answer "which of my peers is spending
  my GPU time". PAIR's telemetry is node-local.
- **Hardware tier in ranking** (above).
- **Operator-tunable local affinity** as an explicit setting rather than an artifact of list order,
  readable per-request so a settings change takes effect on the next request, not the next restart.
- **Layered kill switches**: a master pair (`poolEnabled`, `HUB_POOL_USER_DISABLED`), an independent
  switch per direction (`poolOutboundEnabled` / `poolInboundEnabled`, each with its own env override),
  and one per peer (`hub_pool_peer.enabled`) — so "I will give but not take", and "everyone except that
  node", are single toggles rather than an unpair. All of them keep pairings and tokens intact, and all
  of them are inert on a Hub with no peers.

## Verdict

Hub Pool is a faithful PAIR-equivalent on the parts that determine correctness — single-node
dispatch, ordered failover, streaming, no relay chaining, no retry of genuine client errors — and it
is *better instrumented* and better suited to a heterogeneous fleet. It is behind PAIR in two places
that matter:

1. **GPU-pressure signal only on AMD, and off by default.** The smoothed 0–3 band with hysteresis
   now exists and is wired into ranking, but the only source that can feed it is the amdgpu driver's
   `gpu_busy_percent`, and enabling it takes a `/sys` mount plus a settings change on each node. On
   an NVIDIA or Apple node the gap is unchanged, and closing it needs a host-side writer for the
   documented `gpu_pressure.json` probe rather than any further work in the Hub.
2. **No manual pinning.** Cheap to add — a request header or per-app setting consulted ahead of the
   ranker, mirroring PAIR's priority order.

Neither blocks the current deployment model. Both should be on the roadmap before Hub Pool is
pointed at a fleet where nodes differ sharply in *live* load rather than in static capability.

## Not verified here

Ranking behaviour is compared from source on our side and from PAIR's prose on theirs; PAIR's
scheduler source was not read. No head-to-head benchmark of the two routers was run — the claims
above are about design, not measured throughput.
