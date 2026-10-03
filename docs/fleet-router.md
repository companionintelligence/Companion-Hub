# Fleet router (tailnet inference harness)

`scripts/fleet-router.ts` prompts every inference node on the tailnet from one command. It exists to
exercise [Hub Pool](hub-pool.md) routing on a machine that **cannot run the Hub** — the pool proxy is
a NestJS service needing Postgres and RabbitMQ, so a box without Docker has no way to reach it.

It is a test harness, not a second router to maintain. The routing rules are copied from
`packages/backend/src/modules/hub-pool/hub-pool-proxy.service.ts` on purpose: the same prompts should
route the same way through `cihub pool` once a Hub is running, and any divergence is the finding.

Use `cihub pool` whenever a Hub is available. Reach for this only when one is not.

## Commands

```bash
pnpm run fleet:discover                        # probe the tailnet and classify every reachable node
pnpm run fleet:prompt "why is the sky blue?"   # fan ONE prompt out to EVERY node holding the model
pnpm run fleet:route  "..." --model qwen3:8b   # route to the single best node, with failover
pnpm run fleet:serve  --port 5099              # OpenAI-compatible endpoint that routes across the fleet
```

`discover` and `prompt` take `--json`. `prompt` exits non-zero only when *no* node answered, so a
partial fleet outage still returns the answers it got.

## What it mirrors, and what it does not

| Hub Pool behaviour | Here |
|---|---|
| One ranked candidate list, local and remote together | Same. Concatenating instead would make it a failover list, not a balancer |
| `poolLocalAffinity` head start for the local node (default 1) | Same, as `FLEET_LOCAL_AFFINITY` |
| A stale snapshot ranks as mid-load, never idle (`UNKNOWN_PEER_LOAD`) | Same: a node whose load probe failed ranks as 1, not 0 |
| Fails over on connection error, 5xx, 408, 429 — never on an ordinary 4xx | Same |
| Discovery via the Tailscale **Admin API** (needs an OAuth client) | Reads the **local** `tailscale status --json`, so no credential is needed |
| Peers are `hub_pool_peer` rows that both sides approved | Any tailnet node answering on the Ollama port — there is no pairing and no approval |
| Queue depth from an authenticated `/capabilities` poll | Models resident in VRAM (`GET /api/ps`), the closest signal Ollama exposes |
| Ties broken by the peer's reported hardware tier | Not available without a Hub; ties keep discovery order |
| `/v1/models` and `/api/tags` are local-only in v1 | Merged across the fleet, because a merged catalog is the point of pointing an agent at it |
| Response body streamed through untouched | Buffered, then returned whole — fine for a test, not for a long generation |
| Guarded by `InternalNetworkGuard` + `PoolAppGuard` | Bound to loopback only. **The socket is the whole boundary** |

The routed path set matches the Hub's: `/v1/chat/completions`, `/v1/completions`, `/v1/embeddings`,
`/api/generate`, `/api/chat`, `/api/embeddings`, `/api/embed`. `/api/pull` is deliberately absent for
the same reason it is there — pulling a model is a node-local administrative act, not something a
pool should silently perform on whichever machine answered.

Every routed response carries `X-CI-Hub-Fleet-Served-By`, `-Candidates`, and `-Failed-Over-From`, so a
decision can be read without turning on logging.

## Pointing an agent at it

`fleet:serve` is the seam an agent plugs into — it speaks both protocols the Hub's pool proxy answers,
so anything that talks OpenAI or Ollama works unmodified. For OpenClaw, see
[`openclaw-test-account.md`](openclaw-test-account.md).

## Limits worth knowing before you trust a result

- **A model's tool support decides more than its size.** A small model that rejects a tool payload
  answers `400`, and the router correctly does *not* fail over — a genuine 4xx means the request is
  wrong, and retrying it elsewhere just wastes a hop. Give an agent a tool-capable model.
- **Discovery is cached for 30 seconds** in `serve`. A node that dies inside that window is still
  offered; the per-request failover is what protects the live request, exactly as in the Hub.
- **Queue depth is resident models, not in-flight requests.** A node busy with work that never went
  through this harness still looks idle, the same blind spot the Hub documents.
- **A large model on one node has no redundancy.** `candidates: 1` in the response headers means a
  failover has nowhere to go.
