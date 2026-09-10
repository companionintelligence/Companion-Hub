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

### 1. Discovery — mDNS broadcast vs authenticated directories

PAIR runs `nvpair-node-scanner`, advertising one `_nvpair-node._tcp` mDNS record per host carrying
UUID, cluster membership, ports and a ranked address list, plus manual direct-address probing.
Eviction needs **twelve** consecutive misses at a 5 s scan — a full minute
(`missThresholdDefault = 12`, `services/shared/discovery/discovery.go:93`), and three further
mechanisms sit in front of it: from ~15 s a missing node is TCP-probed on its advertised ports every
scan; a scan that returns *none* of several known nodes penalises nobody for up to six scans, on the
reasoning that machines do not leave together but a starved process hears silence from all of them;
and `discovery:node-activity` counts inference response bytes seen in the last 60 s as proof of life.
PAIR's own note for the last one — that it is the only liveness evidence that gets *stronger* the
busier a node is — is the idea worth taking, because our three-failed-polls rule fails hardest exactly
when a node is busy serving.

Hub Pool asks directories that authenticate it first, and every one of them supplies a *name*: the
local Tailscale daemon's peer map, the **Tailscale Admin API** when an OAuth client is configured,
and the **CI Portal device registry** on a registered Hub. It then probes each candidate's
`GET /inference/pool/identify` to confirm it is a Hub (which is all that route discloses — see §2), and
merges the results on the normalized FQDN so a node two directories both name is offered once. Hub
Pool also has PAIR's manual half: `cihub pool probe <address>` finds a Hub on the LAN with no
directory at all, and a six-digit PIN turns that address into a name (§2).

- PAIR works on any flat LAN with zero external dependency; it is confined to one broadcast domain.
- Hub Pool spans LAN, WAN and NAT for free, and inherits WireGuard transport encryption — but is
  inert without a tailnet. No credential is required for any of it: the daemon peer map and the
  address probe both work on a Hub that has never seen an OAuth client.
- The extra directories buy names, not reach. A Portal-registered Hub on a *different* tailnet is
  dropped at the probe rather than listed, because pairing and every pooled request afterwards dial
  `https://<fqdn>` over this node's own tailnet.

Neither is strictly better. PAIR's is more self-contained; ours reaches machines PAIR cannot, and a
broadcast domain is not one of its requirements.

### 2. Trust bootstrap — PIN/mTLS vs PIN + pinned Ed25519 identity

PAIR: six-digit PIN bootstraps **mutual TLS**; each node holds a stable UUID and self-signed leaf
certificate, and "pairing pins each side's certificate against the other's UUID". It multiplexes
plaintext loopback and TLS on one port by sniffing the first byte (`0x16` = TLS handshake).

Hub Pool now has **the same identity model on a different carrier**: a six-digit PIN authenticates the
pairing request, each node holds a stable pool UUID and an Ed25519 keypair, and pairing pins each
side's *public key* against the other's UUID. Requests carry a signature over method, path, both
UUIDs, the sender's claimed name, a timestamp and a single-use nonce, rather than a bearer token. The
gap that remains is a carrier difference, not a model difference: PAIR authenticates the transport,
we authenticate the request. See [`hub-pool.md` → Peer identity](hub-pool.md#peer-identity-pin-pairing-and-signed-requests).

**Signatures are the stronger half of what mTLS was buying**: the verifier stores only public data, so
a stolen database yields nothing that authenticates anywhere — where the original directional bearer
tokens meant every Hub held, for every peer, an encrypted copy of a secret that authenticated it to
that peer. X.509 was deliberately deferred rather than built: it needs a new dependency to mint a
leaf (Node can parse certificates but not create them), a raw-TCP Tailscale Serve forward that
`getServeStatus` cannot currently see or reconcile, and a rewrite of the whole outbound peer client
away from global `fetch`, which accepts no client certificate. It buys nothing extra while Hub Pool
runs on a tailnet.

**The first-byte multiplexing was rejected outright, not deferred.** Peers reach a Hub on port 443,
which is `tailscale serve --https`; tailscaled terminates the TLS and forwards *plaintext* to the Nest
process, so a peer's ClientHello never reaches our socket and there is no first byte to sniff. PAIR
needs the trick because it owns its listener; we do not own ours.

One point in our favour throughout: PAIR's telemetry surface is "plaintext HTTP, not authenticated".
Hub Pool's only unauthenticated peer surface is `GET /identify`, which answers
`{ isCiHub: true, poolProtocol: 2 }` and nothing else.

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
  documented host-file probe. **PAIR has the mirror-image gap, not parity:** on Linux it reads
  utilization only from `nvidia-smi`, and its own comment says an AMD/Intel-only host falls back to
  ghw and lists GPUs "without dynamic VRAM/utilization"
  (`services/nvpair-node-info/gpu_linux.go:25-31`). Each project implemented the vendor it runs on.
  The honest framing is that neither has fleet-wide telemetry, not that PAIR solved it.
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

- **Supervised worker processes.** PAIR's broker restarts workers with exponential backoff (~1s→16s,
  five attempts). Hub Pool is a NestJS module inside the Hub; engine supervision is Docker's.
- **Cluster-wide model inventory.** PAIR advertises per-engine inventory across the cluster; our
  `GET /v1/models` and `/api/tags` through the pool proxy still list **only this node's** backends
  (documented gap in `docs/hub-pool.md`). Chat/completion/embedding do use the full pool.

### 6. Features we have that PAIR does not

- **Manual routing pins** — added since this doc was first written, so PAIR's advantage here is gone.
  `hub-pool-pin.service.ts` and `applyPin()` (`hub-pool-proxy.service.ts:169`) are, if anything, more
  carefully specified than PAIR's: a pin *reorders* the finished candidate list rather than forcing a
  target, so it can never resurrect a node ranking already excluded, and a pin naming an unavailable
  node is a silent no-op instead of a failure.

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

1. **Load-signal freshness.** This is the real gap, and it is not the one this doc used to name.
   PAIR samples telemetry every 2 s and recomputes ranking every 1 s; we poll every 30 s and trust a
   snapshot for up to 90 s. A queue depth that old is close to useless for bursty multi-agent traffic,
   which is the traffic this exists to serve. PAIR's scheduler emits only on change, so the cost of
   closing this is low.
2. **Cluster-wide model-list aggregation.** PAIR fans `/v1/models` and `/api/tags` across candidates
   and merges them de-duplicated; ours are local-only. Verified live: the pool proxy on a 5-node mesh
   returned 11 models — one node's inventory — while the pool as a whole could serve far more. This is
   also the specific reason a `require`-mode pin had to be cut, so fixing it unblocks that design.
3. **GPU-pressure signal only on AMD, and off by default.** Kept on the list, but demoted: PAIR is
   NVIDIA-only on Linux (§3), so this is a difference in which vendor each project covers rather than a
   capability one has and the other lacks.

None blocks the current deployment model.

## Provenance

**PAIR's source has now been read**, at tag `v0.1.1` (commit `13b6811`, 2026-08-28) — the earlier
revision of this doc compared our source against PAIR's *prose*, and three of its claims were wrong
because of it: the eviction threshold (stated as 3, actually 12), the GPU-telemetry framing (stated as
fleet-wide for PAIR, actually NVIDIA-only on Linux), and "Hub Pool has no pin" (stale — pins shipped).
Each is corrected above against a cited file and line.

One thing to know when reading PAIR's own documentation: **it contradicts itself.** `known-issues.mdx`
says scheduling "does not consider… current utilization", while the scheduler README and `schedule.go`
both add a GPU-pressure term. Cite the source, not `known-issues.mdx`.

Worth recording as prior art we do not match: PAIR pairs with **EAP-NOOB (RFC 9140)**, a standards-based
out-of-band protocol, where ours is a bespoke PIN handshake. And a weakness we do not share:
`nvpair-node-info` — full hardware inventory and live GPU/CPU utilization — is served as
**unauthenticated plaintext HTTP on the LAN even on a clustered node**, because the desktop's 2 s
telemetry poll holds no cluster identity and gating it would blank the UI
(`services/nvpair-ui-broker/broker.go:1045`). It is recorded as an accepted risk in their
`desktop/SECURITY.md`. Our equivalent surface is behind `PoolPeerGuard`.

Still not done: no head-to-head benchmark of the two routers. The claims above are about design, not
measured throughput.
