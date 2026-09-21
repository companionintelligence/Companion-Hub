# Hub Pool (multi-Hub inference pooling)

Hub Pool lets two or more CI-Hub devices you operate on the same tailnet share inference capacity: an app on one Hub can be served by whichever paired Hub has the requested model and the shortest queue, with automatic failover if a node stops responding. It builds entirely on the existing [Tailscale private VPN](private-vpn.md) integration — there is no separate discovery protocol or certificate system to manage. (Hub Pool does have a peer protocol of its own — a version-negotiated `/identify`, the PIN handshake and pinned Ed25519 identities, described below — but it rides the tailnet rather than replacing it.) More than one directory can *name* a candidate (see [Where pairing candidates come from](#where-pairing-candidates-come-from)), but the transport never changes: every peer is stored under its tailnet name and reached at `https://<fqdn>` over the tailnet.

This complements, and does not replace, the existing single-node model recommendation described in [`MODEL_REGISTRY.md`](MODEL_REGISTRY.md): hardware-aware model selection still runs per node, unchanged. Hub Pool only changes *where* a resolved model actually runs once more than one Hub is paired.

## How it fits together

- **Discovery**: `GET /api/inference/pool/peers/discoverable` lists every unpaired node this Hub can *name*, from up to three directories — the local Tailscale daemon's peer map, the Tailscale Admin API when `TAILSCALE_OAUTH_CLIENT_ID` / `TAILSCALE_OAUTH_CLIENT_SECRET` are configured, and the CI Portal device registry on a registered Hub (which [returns nothing today](#where-pairing-candidates-come-from)) — and probes each unpaired candidate's `GET /api/inference/pool/identify` (reachable over the tailnet the same way the Hub's own dashboard is) to confirm it is a CI-Hub node. None of the three is required, and a node two of them both name is offered once. A Hub with no directory at all is found by address instead. See [Where pairing candidates come from](#where-pairing-candidates-come-from).
- **Pairing**: a two-way handshake — the requesting Hub sends a token to the candidate; the candidate's operator approves or rejects in **Settings → Network → Hub Pool**; on approval, the candidate issues its own token back. Each side ends up trusting the other with one bearer token per direction (see `hub_pool_peer` in `schema.ts` for the exact model). Rejecting, or never approving, leaves nothing paired. Rejecting and unpairing both send a best-effort *authenticated* notification — the caller presents the token the other side issued it — so the other Hub drops its half immediately instead of forwarding work to a node that will now reject it.
- **Routing**: once at least one peer is `connected`, every app using `hub_integration.inference` is routed through this Hub's own pool proxy (`/api/inference/pool/*`) instead of a directly-resolved backend URL — this is a global switch, not a per-app setting. With zero connected peers, nothing changes: a single-node Hub behaves exactly as it did before this feature existed. A routed app is also handed its chat model from what the *pool* serves — this node's healthy backends plus every usable peer's inventory — filtered by the app's requirements (tool calling, minimum context), and AI apps whose env would change are regenerated and restarted when pool membership changes. See [App inference handout](system/backend.md#app-inference-handout).
- **Ranking**: local backends and connected peers go into a **single** list ordered by queue depth — in-flight inference requests — so a saturated Hub hands work to an idle peer instead of queueing behind itself. The local node gets a deliberate head start of `poolLocalAffinity` queued requests (default 1): a follow-up turn served here reuses the prompt prefix and KV cache the previous turn left resident, while the same turn sent to a peer re-processes the prompt cold — so work only leaves this node once a peer is at least that much emptier. A peer's queue depth is the larger of the two views this Hub has of it: the `inFlightRequests` figure the peer published at its last health poll, and what this Hub has forwarded it since. Both count the same requests, and neither vantage point sees all of them — the peer's snapshot includes work from apps and nodes we cannot observe, our own counter covers the up-to-one-poll the snapshot missed. A snapshot older than three health polls (90 seconds at the default cadence) is discarded and the peer ranks as mid-load: an unmeasured node must never be mistaken for an idle one. Peers that tie on queue depth are ordered by the hardware tier they report, unless `poolPressureWeight` is non-zero, in which case a [GPU-pressure band](#gpu-pressure-a-second-load-signal-amd-only-and-off-by-default) is consulted first — an unmeasured node ranking mid-band, never idle. With `poolPrefixAffinityMaxInFlight` above zero, the node and engine that last served a session's prompt prefix are moved to the front of that list while their queue is under the limit — see [Prefix affinity](#prefix-affinity).
- **The `auto` alias**: an app may ask for model `auto` on any pooled route, exactly as it always could on the peerless `/api/inference/v1` path. The pool resolves it against every node that could take the request — this Hub and each usable peer, by the same rules candidate ranking applies — and picks, in order: the model named in **Settings → Inference** on the Hub that received the request, wherever in the pool it is served; otherwise the best chat model the pool holds, ranked tool-capable first (known, then unknown, then known tool-less), then 7 B parameters or more, then the catalog's intelligence index, parameter count, how many nodes serve it, and whether this Hub does. Embedding and rerank models are never picked, and the ranking never picks an Ollama Cloud (`:cloud`) tag, which would send the prompt off the appliance — only a Settings → Inference choice can name one. The resolved engine id replaces `auto` in the body before candidates are ranked, so a peer holding the model is as eligible as the local engine. `POST /api/show` resolves `auto` the same way, so the model an app is told about is the model its chat runs on; when no local engine holds that model, a peer that does describes it. A pool with no chat model anywhere answers 502 saying so. See `pool-auto-model.ts` for the fleet evidence behind the order: resolving on the entry node alone handed agents `gemma3:1b` and `deepseek-r1:8b` — the latter with `qwen3.6:27b` on the same disk — and a Hub with no local LLM answered 502 while its peers held a dozen. Every Hub in a pool resolves `auto` to the same model unless its Settings say otherwise, so the nodes holding that model carry the pool's `auto` traffic.
- **Failover**: the proxy tries candidates in the ranked order above. It fails over on a connection error, a timeout waiting for response headers (on a streamed request the first byte comes only after model load *and* prompt evaluation, so the budget grows with the prompt: `max(HUB_POOL_FIRST_BYTE_TIMEOUT_MS, bytes/4 ÷ HUB_POOL_MIN_PREFILL_TOKENS_PER_SEC)` — defaults 300 s and 50 tok/s, so a 160 KB agent turn gets 800 s. Ollama's log on beta-max showed a 47k-token turn 98 % evaluated at 296.8 s when a fixed 300 s budget cancelled it and moved the work, cold, to a peer), a 5xx, or a 408/429 — never on an ordinary 4xx, since retrying a malformed request on a different machine wouldn't help. A peer additionally gets failed over on 401/403/404: those come from the peer's *own* pairing checks (it stopped trusting our token, or was unpaired from its side) and say nothing about the app's request, so the request moves to the next node and that peer's cached capabilities are dropped until its next successful health poll. Failover stops as soon as a response is committed — once status and headers have gone to the app, a stream that then dies is left to die rather than restarted on another node.
- **Client hang-ups**: if the app closes its connection before the response finishes, the proxy aborts the upstream request, so the engine stops instead of prefilling a turn nobody will read (a 47k-token agent turn is about 300 s of prefill on a GPU node). This holds on both ends of a pool hop: the peer that served the work sees the sending Hub's aborted forward close and aborts its own engine request. A hang-up before response headers is never failed over — the turn is not placed on another candidate — and the routing log records it as `failed` with no status.
- **Recovery**: a peer that fails three consecutive health polls is marked `unreachable` and stops being offered as a candidate, but it keeps being polled — the first successful probe puts it straight back to `connected`. No operator action is needed, and unpairing is never the way to fix a node that was merely offline.

## Required configuration

- **Tailscale** must already be connected on every Hub that will participate (see [`private-vpn.md`](private-vpn.md)) — Hub Pool has no independent networking of its own.
- **`TAILSCALE_OAUTH_CLIENT_ID`** / **`TAILSCALE_OAUTH_CLIENT_SECRET`**: **optional.** An OAuth client from the Tailscale admin console with the `devices:core:read` scope, set on whichever Hub(s) should be able to enumerate the *whole tailnet* at once. It is one of three candidate directories and the only one that needs a credential: a tailnet-connected Hub already names the peers its own Tailscale daemon can see, and a registered Hub already names the Hubs on your CI account. It is no longer required to find a peer — `cihub pool probe <address>` (below) adds one by address with no credential at all — and it was never required for pairing or for serving traffic. Keep it when a pool spans several networks, which is where enumerating the tailnet earns its keep and where an address on one LAN tells you nothing about a node on another.
- **`HUB_POOL_USER_DISABLED=true`**: explicit opt-out. Forces this Hub to behave as if it had no connected peers (routing reverts to direct/local resolution), makes it stop answering peer capability probes so paired Hubs naturally mark it unreachable, and makes it refuse new inbound pairing requests. Existing pairings are preserved: paired Hubs keep polling an unreachable peer, so within one poll of the flag being removed the pairing is back to `connected` on its own.
- **`HUB_POOL_OUTBOUND_DISABLED=true`** / **`HUB_POOL_INBOUND_DISABLED=true`**: the same kind of operator-of-the-box override for one direction only. Each overrides its persisted setting below and is reported separately by `GET /inference/pool/status`. Like the master flag, neither is projected into `.env` by `generateSystemEnvFile`.
- **`HUB_POOL_MAX_PROMPT_TOKENS=<tokens>`**: this node's [prompt ceiling](#prompt-ceilings), overriding the persisted `poolMaxPromptTokens`. A value outside 1024–1048576, or not a whole number, is ignored rather than guessed at. `GET /inference/pool/status` reports `localNode.maxPromptTokensSetBy: "env"` while it is in force. Not projected into `.env` by `generateSystemEnvFile`.
- **`HUB_POOL_THROUGHPUT_PLACEMENT=off`** (or `0`, `false`): stop [measured throughput](#throughput-aware-placement) from reordering candidates. This node keeps measuring, reporting and advertising, so turning it back on needs no warm-up. Read per request.

## Operator settings

Persisted in `settings.json` and editable over `GET`/`PATCH /api/inference/pool/settings`. Every one of them takes effect on the next request or poll — no restart, and no app is recreated, because each value is read on the Hub's own path rather than injected into an app's environment.

| Setting | Default | Range | What it does |
|---|---|---|---|
| `poolEnabled` | `true` | — | The in-product master kill switch, same effect as the env flag above. |
| `poolOutboundEnabled` | `true` | — | Whether this Hub may **send** work to peers. Off: candidate selection is local-only and a model this node cannot serve fails here with the usual 502 rather than being shipped out. |
| `poolInboundEnabled` | `true` | — | Whether this Hub may **serve** peers' work. Off: peers see a healthy node advertising an empty inventory and `acceptingWork: false`, and route elsewhere; this Hub keeps using them. |
| `poolLocalAffinity` | `1` | 0–20 | Queued-request head start the local node gets over a peer. `0` ranks purely by queue depth — with local still taking an *exact* tie, since serving here costs no hop and reuses a warm cache; higher values make handoff rarer (stickier to local). |
| `poolHealthPollSeconds` | `30` | 10–300 | Seconds between peer capability probes. Also sets how long a peer's snapshot stays trusted — three polls — so slowing the cadence does not silently mark every peer stale. |
| `poolPins` | `[]` | — | Operator routing pins — see [Manual routing pins](#manual-routing-pins). Written through `POST`/`DELETE /api/inference/pool/pins`, not through this PATCH. Empty means the ranker alone decides. |
| `poolRequireSignedPeers` | `false` | — | Refuse the legacy bearer-token path outright, on the inbound guard **and** the outbound client. **Default false on purpose:** setting it while any peer has not finished the bearer→signed upgrade takes both directions of that pairing down. Flip it only once every peer reports `authMode: signed` — `cihub pool status` names the ones that do not, and says when the switch has become safe. |
| `poolShareContainerStats` | `true` | — | Publish this node's aggregate container counts and resource totals to paired peers — counts and totals only, never a container name. **Default on**, so an upgraded Hub starts reporting to the peers its operator already approved; off omits the key entirely, which reads on the far side as "not reported" and never as an idle machine. See [Container counts](#container-counts-what-the-rest-of-the-fleet-is-running). |
| `poolPressureWeight` | `0` | 0–3 | How heavily the 0–3 GPU-pressure band counts in ranking. `0` (the default) removes it from the comparator entirely, so ranking is byte-identical to the build before pressure existed; `1` is `pending + pressure`, which is what lets the pool move work off a node whose queue is empty but whose GPU is busy. See [GPU pressure](#gpu-pressure-a-second-load-signal-amd-only-and-off-by-default). |
| `poolMaxPromptTokens` | `null` | 1024–1048576, or `null` | The largest estimated prompt this node should serve for the pool while another node can take it. `null` (the default) is no ceiling. `HUB_POOL_MAX_PROMPT_TOKENS` in the environment overrides it. See [Prompt ceilings](#prompt-ceilings). |
| `poolProbeSnapshotTtlMs` | `0` | 0–300000 | How long, in milliseconds, a local engine's health answer is reused for placement before a pooled request triggers a fresh probe behind itself. `0` (the default) probes every local engine live on every request, which is the pre-snapshot build, stall included; `10000` is the value the snapshot is being validated at. See [Placement reads a snapshot](#placement-reads-a-snapshot-not-a-live-probe). |
| `poolPrefixAffinityMaxInFlight` | `0` | 0–20 | The queue depth up to which the node and engine that last served a session's prompt prefix are preferred for its next call, counting the request being placed. `0` (the default) turns affinity off — no prefix is hashed or remembered and ranking is byte-identical to the pre-affinity build; `2` is the value it is being validated at. See [Prefix affinity](#prefix-affinity). |

## Manual routing pins

An operator preference for where a model runs: `cihub pool pin core-1.example-tailnet.ts.net --model llama3.2:3b`, `cihub pool pin local`, or the Routing pins block in Settings → Network → Hub Pool. Stored in `settings.json` alongside the settings above — **no table, no migration** — so a pin takes effect on the next pooled request with no restart and costs no query on the inference path.

**A pin reorders; it never forces.** `prefer` is the only mode. The pinned node's candidates are moved to the front of the list the ranker already produced, and every other candidate stays behind them in ranked order, so failover is exactly what it was. Three things follow:

- A pin **cannot resurrect** a node the pool excluded: an unreachable or disabled peer, a peer that answered 401/403 and had its cached capabilities dropped, a peer that says `acceptingWork: false`, or a local backend caught unable to serve the model. The pin filters a finished list.
- A pin whose target has no candidate is a **silent no-op** — the request routes exactly as it would unpinned. That covers a pinned node that is down, and one that was unpaired while the pin still named it (the pin is left in place and simply stops matching).
- A pin can never make inference fail. The 502 for a model nothing can serve names the pin, and says in the same breath that a pin is not what caused it.

Scopes: one pin per exact model id, plus one pool-wide default. A model pin wins over the default and they never stack; the model string is compared **verbatim and case-sensitively**, because that is how candidate matching reads the engine inventory.

**A hard `require` mode was designed and cut.** With a default-scope `require` pin at a peer, every app still discovers *this* node's model list from the local-only listing routes and would then get an unfailoverable 502 for every model the peer lacks — embeddings included, since the embedding host points at the same pool URL. It also turns a peer outage into a first-byte-budget hang per request for the whole 90 s–15 min window before the unreachable threshold trips, while the pin still reads as healthy. Nothing anyone asked for needed it.

`GET /api/inference/pool/status` reports every pin with its target resolved to a node name and `targetAvailable` computed from the same predicates routing uses — which is the only place a pin that has quietly stopped applying is visible. `POST /api/inference/pool/pins` upserts one (the key is `(scope, model)`, not an id); `DELETE /api/inference/pool/pins?scope=model&model=<id>` removes it, addressed by query because model ids contain `/` and `:`.

## Prompt ceilings

A per-node preference about prompt size: `cihub pool ceiling 16000` on a node, or
`PATCH /api/inference/pool/settings {"poolMaxPromptTokens": 16000}`. It exists for nodes that serve a
model on CPU, where prefill slows as the context grows. Measured on the fleet, 2026-09-17, on a node
serving `qwen3-coder:30b` on CPU: a 40 KB (~10.6k-token) streamed turn prefilled at ~123 tok/s and
answered in 103 s, while a 184 KB (~46k-token) turn produced no first byte inside its 922 s budget and
was cancelled. A GPU node served the same 184 KB turn in 268 s. Pins cannot express this: they are
`prefer`-only and do not look at the request.

**The estimate** is `bytes / 4` of the payload the proxy forwards — the same figure the first-byte
budget is sized from, so a request is never judged small for the ceiling and large for the deadline.

**Where it applies.** A node advertises its ceiling in `GET /capabilities` as `maxPromptTokens`, and
omits the key when it has none, which is also what every older build sends. The node an app called —
the entry node — ranks its candidates as usual. It then moves this node's own candidates behind the
rest if its ceiling is below the estimate, and does the same for any peer whose advertised ceiling is.
Both groups keep the ranker's order, and [pins](#manual-routing-pins) reorder within each group, so a
pin at an over-ceiling node cannot move a long prompt back to the front. Only chat and completion
routes are judged (`/v1/chat/completions`, `/v1/completions`, `/api/chat`, and `/api/generate`).
Embeddings are not: a batch is many short inputs, so its size says nothing about the prefill a
ceiling is for. Nor is the peer `POST /api/show` lookup, which ranks the same candidates to find a
node that can describe a model: it is answered from metadata already on disk in under 0.3 s whatever
its body says, so measuring that body would only walk past the node best placed to answer. That
exemption covers both prompt-size decisions — this ceiling and the
[measured-throughput placement](#throughput-aware-placement) below — because the lookup supplies no prompt
to judge at all.

**A ceiling never refuses work.** An over-ceiling node stays at the end of the failover order, so it
still serves the request when every node under its ceiling fails. When every candidate is over its
ceiling, nothing is moved at all. A slow answer beats a 502. The serving node does not check the
ceiling on inbound work for the same reason: only the entry node knows whether there was anywhere else
to send it. A peer on an older build does not read `maxPromptTokens` at all and routes as before.

**Seeing it.** `GET /api/inference/pool/status` reports `localNode.maxPromptTokens` (effective, env
override applied) with `localNode.maxPromptTokensSetBy` (`env`, `setting` or `null`), and
`peers[].maxPromptTokens`. Each routing-log entry carries `promptCeiling`: `null` when no candidate had
a ceiling, otherwise `{ estimatedTokens, excluded: [{ node, maxPromptTokens }], overridden }`, so "the
ceiling skipped that node" can be told apart from "the ranker preferred another". `excluded` lists the
nodes moved to the back. `overridden` is `true` when the request was placed on one of them anyway.
`cihub pool log` marks the requests the ceiling changed.

## Context caps: the window an app asks for is the window the engine runs

A per-node preference about the context window (`num_ctx`) the Hub hands its apps:
`cihub pool context-cap 16384` on a node (`clear` removes it), or across the fleet
`cihub fleet backends --ollama-context 16384 --execute`, which writes the engine's context and every
node's cap in one run — see
[`cihub pool context-cap`](./CLI.md#cihub-pool-context-cap). Over the API it is
`PATCH /api/user-settings {"inferenceMaxNumCtx": 16384}`, or `maxNumCtx` on
`PATCH /api/inference/preferences` (the route that can clear it). Absent (the default) is no cap. It
exists because the handout and the engine's runtime environment never knew about each other.

The Hub sizes `CI_LLM_NUM_CTX` (`HERMES_NUM_CTX` for Hermes) from the model's window and the memory
left after its weights, so an app never inherits Ollama's memory-based default of a full 262144
window. Ollama, meanwhile, runs the context its own environment sets — `OLLAMA_CONTEXT_LENGTH`,
written by [`cihub fleet backends --ollama-context`](./CLI.md#ollamas-runtime-environment-a-second-file-restarted-only-on-change)
next to `OLLAMA_NUM_PARALLEL` — and it multiplies that window by the parallel slots. A request whose
`num_ctx` differs from the window a model is loaded at reloads the model. Measured on core-2,
2026-09-20: Ollama ran `OLLAMA_NUM_PARALLEL=4` at `OLLAMA_CONTEXT_LENGTH=16384`, and its apps were
handed 65536. OpenClaw's first turn (44,340 prompt tokens) reloaded `qwen3-coder:30b` with a 65536
window: `ollama ps` went from 25 GB to 44 GB (four slots of 64k KV cache) over a ~40 s reload, and
every later request at another size — the harness's 16k default, Hermes — flipped it back, each flip
a full reload of a 30B model. On beta-red (10 GB VRAM) the same handout spilled the model to CPU.

**What the cap does.** Every handout is `min(model window, memory-sized recommendation, cap)`, on
both paths (`app.env` generation and `credentials.env`). Set the cap to the node's
`OLLAMA_CONTEXT_LENGTH` and every app asks for the window the engine already runs, so nothing
reloads. The cap wins over an app's declared floor: the floor is what the app would like, the cap is
what the engine serves without reloading, and handing out the floor anyway is the 44 GB reload
above. When a cap is below an app's floor the Hub logs a warning naming both (Hermes refuses to start
below 64000) — the fix is to raise `--ollama-context` and the cap together, or to keep that app off
that node. Changing the cap sweeps the AI apps whose env it changes, like every other inference
preference.

**Why it is a setting and not a probe.** Ollama's API does not expose `OLLAMA_CONTEXT_LENGTH`. The
`context_length` that `GET /api/ps` reports for a loaded model is whatever the last request asked
for — after one oversized handout it is the oversized value — so it cannot size a handout. The Hub
reads it to warn: when the local engine holds the chat model at a window other than the one being
handed out, the log says so, names both numbers, and points at the cap.

**Through the pool.** A node advertises its cap in `GET /capabilities` as `maxNumCtx`, omitting the
key when it has none, which is also what every older build sends. A pooled request may be placed on
any node serving the model, so the entry node caps its apps at the **smallest cap among the nodes
that serve the chosen model**; a node that serves a different model does not count, and neither does
one that advertises no cap. When no serving node advertises a cap, the entry node's own cap applies.
A peer on an older build routes and serves as before; only what its apps ask for changes, and only
if that peer sets a cap itself.

**Seeing it.** `GET /api/inference/pool/status` reports `localNode.maxNumCtx` and
`peers[].maxNumCtx` (`null` for none, through the same clamp a handout reads); `cihub pool status`
shows this node's under **This node**. The handout log lines (`[InferenceEnvResolver]`,
`[AppCredentials]`) carry the two warnings above.

**Sizing the engine.** Size `OLLAMA_CONTEXT_LENGTH` for the largest prompt the node's agents send —
OpenClaw's first turn on core-2 was 44k tokens, which does not fit a 16k window — and remember that
the KV cache is `OLLAMA_NUM_PARALLEL` times that window. A 30B at 4 × 64k is the 44 GB above;
4 × 16k is 25 GB. Then set the cap to the same number on that node — `cihub fleet backends
--ollama-context N --execute` does both on every node it manages.

## Throughput-aware placement

The automatic counterpart to a prompt ceiling. The ranker weighs queue depth and hardware tier, and
neither tells a GPU node from one serving the same model on CPU. For a long prompt that is the whole
difference. Measured on the fleet, 2026-09-17, with `qwen3-coder:30b`: core-6 (GPU) prefilled a 184 KB
(~48k-token) streamed turn at ~496 tok/s and answered in 268 s. fzzy (CPU, `size_vram` 0) read a
10.6k-token turn at ~123 tok/s, but produced no first byte for a ~46k-token turn inside its 922 s
budget, because CPU attention cost grows with the context. Earlier, `qwen3.6:27b` prefilled at
~300 tok/s on GPU nodes and at 27–37 tok/s on fzzy and core-7.

**What is measured.** Every chat or completion request an engine serves (the routes a ceiling judges)
is timed per node, engine, and model, both on the entry node and on the node that serves it:

- **Prefill.** The engine's own prompt-evaluation time when it reports one (Ollama's native
  `prompt_eval_duration`, llama.cpp's `timings.prompt_ms`), which leaves out the model load and the
  queue. Otherwise, for a streamed request, the wait for the first byte. A non-streamed request without
  engine timings gives no prefill sample, because its wait was the whole generation.
- **Missed deadlines.** A streamed request that ran out of its first-byte budget with no answer is
  recorded as "at least this slow". It carries no usage frame, and it is the failure placement exists
  to stop repeating.
- **Decode.** The engine's own generation time, or the stream from the first byte to the end. It is
  reported, not ranked on.

Rates are in the pool's own token estimate, `bytes / 4` of the forwarded body, because that is the unit
the budget is sized in. A sample is taken only when the node had nothing else in flight, as far as this
node can tell, so a queue is never recorded as slow hardware. Prompts under 4096 estimated tokens are
neither measured nor judged: their wait is mostly fixed cost, and the 300 s minimum budget is missed
only below ~14 tok/s.

**How it is kept.** Evidence sits in prompt-size bands that double from 4096 tokens. A band applies to
prompts of that size and larger, never smaller, because prefill only gets slower as the prompt grows.
Most agent turns share a cached prefix with the turn before and reach their first byte in seconds, so
averaging them in would make a CPU node look fast between the cold turns that time out. So slower
evidence replaces a band at once. A faster sample is kept beside it and takes over only as the slow
evidence decays: it holds for 30 minutes, then halves every 30 minutes. Everything is forgotten after
2 hours, which is also how a demoted node gets tried again. All of it is in memory, so a restart
forgets it.

**Predicting a prompt larger than anything measured.** Attention is quadratic in the prompt, so the
cost per token rises with the context: on a CPU-served model that is the dominant term, and on a GPU
one it is nearly invisible. Both halves are on this fleet. fzzy's per-token cost more than doubled
between 10.6k and 46k tokens; beta-max's `qwen3.6:27b` fell only from 192 to 157 tok/s across 47k.
So a measurement is read forward to a larger prompt at `min(N / measured, 3)` times its per-token
cost — the physical worst case, refusing to extrapolate more than threefold however much longer the
prompt is. Only the measurement nearest the requested size is read forward, and never past the
slowest reading at or below that size, which is a bound rather than a guess: a node already that slow
on a shorter prompt cannot be faster on a longer one.

The line this draws: a node is demoted for a much longer prompt when it was measured below about
150 tok/s, three times the 50 tok/s floor the budget is sized from. Every GPU node measured on this
fleet is above it (157–496 tok/s, and higher at the shorter prompts a reading is taken from), and
every CPU-served one is below. This is what places the first long turn correctly instead of learning
it from a missed deadline, and it is also the part most likely to be wrong on hardware unlike this
fleet's: `HUB_POOL_THROUGHPUT_PLACEMENT=off` turns the reordering off, and the routing log names the
size every prediction was read forward from.

**Where it applies.** The entry node predicts each candidate's time to a first byte from the slowest
applicable evidence: what it timed itself, and what the peer advertises in `GET /capabilities` as
`throughput` (omitted when nothing has been timed, as on every older build). It takes the slower of
the two, so a peer cannot advertise its way out of a deadline this node watched it miss. A candidate
predicted to take longer than the request's budget moves behind every candidate that is not. The
rules are a ceiling's:

- **Unmeasured is neither fast nor slow.** It keeps its place, and a measured-fast node is never
  promoted past it.
- **Demoted, never removed.** A slow node stays at the end of the failover order and still serves the
  request when every faster node fails.
- **All slow means nothing moves.** When every candidate is predicted to miss, the ranker's order
  stands.
- **Ceilings stay outside.** A ceiling is an operator's statement and a measurement is an inference,
  so throughput reorders within each ceiling group. [Pins](#manual-routing-pins) then reorder within
  each resulting group, so a pin at a node measured too slow does not bring a long prompt back to it.

**Seeing it.** `GET /api/inference/pool/status` reports `localNode.throughput`, this node's own
estimates and exactly what it advertises, and `peers[].throughput` as `{ observed, advertised }`: what
this node timed, and the peer's report after the validation and ageing routing applies. Each estimate
lists its prefill bands (`fromTokens`, `promptTokens`, `tokensPerSec`, `deadline`, `ageMs`) and its
`decode` rate. Each routing-log entry carries `throughput`: `null` when no candidate had applicable
evidence, otherwise `{ estimatedTokens, budgetMs, estimates: [{ node, backend, tokensPerSec,
fromPromptTokens, extrapolated, predictedMs, source, deadline, slow }], overridden }`. `tokensPerSec`
is the rate as measured, at `fromPromptTokens`, so it can be compared with an engine's own log;
`predictedMs` includes the growth factor when `extrapolated` is true. `overridden` is `true` when the request was
placed on a `slow` node anyway. `cihub pool status` lists measured speed per node, and `cihub pool log`
marks the requests a measurement moved.

## Prefix affinity

The ranker scores queue depth, pressure and tier, and all three read the same for a node that holds a session's prompt prefix in its KV cache and a node that would prefill it cold. For an agent turn that is most of the turn. Measured on core-2 through the pool proxy, 2026-09-20: OpenClaw's first turn was **44,340 prompt tokens, 258 output, 100.8 s wall**, and Ollama's journal put `prompt processing` at **67.34 s (608 tok/s)** of it. The agent's second model call in the same turn — 44,630 tokens, the same prefix — got only a partial cache hit (`cached n_tokens = 15958`, **28,672 tokens re-prefilled in 63 s**): the four Ollama slots (`OLLAMA_NUM_PARALLEL=4`, fleet-wide since that day) are shared with other traffic, and the pool had no notion of which node, or which engine on it, held the session's prefix. The `poolLocalAffinity` head start only hedges the case where the previous turn ran *here*; a session that a pin or a busy queue once sent to a peer re-prefilled wherever the ranker put it next.

So the pool remembers. Every chat, completion or generate request (the routes a [ceiling](#prompt-ceilings) judges — never embeddings) gets a **session key**, and the node and engine that last served that key are moved to the front of the ranked list while their queue is shorter than `poolPrefixAffinityMaxInFlight`. The limit counts the request being placed: at `2` the remembered node takes the call when it is idle or has one other request in flight, and hands it on at two or more, because past that point waiting behind the queue costs more than the ~60 s of prefill it would save.

**The key.** An app that knows where its session begins and ends sends it: `X-Hub-Pool-Session: <any opaque id>` — a chat id, an agent run id — the same on every call of one session (1–128 characters of letters, digits and `. _ : @ / + = -`, starting alphanumeric; anything else is ignored). Without the header the proxy digests the **head** of the prompt: the leading `system` message(s) and the first message after them for a chat body, the `system` and `prompt` fields for a completion or generate body, the first 4 KB of that serialised. The head is identical across every call of an agent session however the conversation grows, so it names the session without the app's help. Two sessions of one agent whose system prompt alone fills the 4 KB share a key, and that is right: the shared prefix is exactly what the cache holds. The model is part of both forms of the key, since a cache is per loaded model. The key is never logged or stored anywhere but the in-memory table below.

**A preference, never a rule** — the same three properties as a [pin](#manual-routing-pins): it reorders the list the ranker built, so it cannot resurrect a node the pool excluded; a key nothing is remembered for changes nothing; every other candidate stays behind in ranked order, so failover is untouched. It is applied *before* the ceiling and throughput splits and the pin, so each of those still wins over it: an operator's ceiling or pin is a statement, affinity is a hint. (A throughput demotion also wins, which is a trade left unmade on purpose — a node that is slow cold is exactly the node whose warm cache matters most, but the pool cannot see whether the cache survived.)

**What it remembers.** Where each key was last placed: the node, the engine, and when — written as each attempt is placed, not when it answers, so a session's next call arriving while this one is still prefilling (an agent's parallel tool calls do) follows to the engine already reading the shared prefix. A failover overwrites the entry with the candidate that actually took the work, and a request that failed on every candidate forgets it, so the next call ranks fresh. Entries expire **10 minutes** after their last placement (`HUB_POOL_PREFIX_AFFINITY_TTL_MS` to change it): a prefix lives in a slot's KV memory, which survives while the model stays loaded and no other prefix has claimed the slot, and with four shared slots whether it is still there after ten idle minutes is a guess. At most 1,000 keys are held, least recently placed dropped first; all of it is in memory and a restart forgets it.

**What it says.** Every judged response carries `X-Hub-Pool-Affinity` beside the [serving-node headers](#operator-status-and-routing-log), and the routing-log row carries `affinity`:

| `outcome` | Meaning |
|---|---|
| `hit` | The remembered node and engine were under the limit and were placed first. `X-Hub-Pool-Served-By` still names whoever *answered*: a `hit` that failed over shows the walk in `failedOverFrom`. |
| `skipped` | Remembered, and a candidate, but not placed first. `inFlight >= maxInFlight` on the row means its queue was full; `inFlight < maxInFlight` means a later step — a ceiling, a throughput demotion, or a pin — put another node first, and the row's other sections say which. |
| `miss` | Nothing remembered for this key (a session's first call, an expired entry, a Hub restart), or the remembered node and engine can no longer serve the model (`remembered` still names it). |

The row also carries `key` (`header` or `hashed`), `remembered`, `inFlight` and `maxInFlight`, and never the key itself. `cihub pool log` prints a line for a `hit` and a `skipped`, and nothing for a `miss`. On the all-candidates-failed 502 the header is set too, since a turn that failed everywhere is one an operator will want to know was or was not following its prefix.

**Off by default**, for the same reason as `poolProbeSnapshotTtlMs` and `poolPressureWeight`: at `0` no prefix is hashed or remembered and a node that takes this image with its settings untouched ranks byte for byte as before, so it is a valid control for the one node where affinity is on. Validate it one node at a time:

```bash
curl -X PATCH .../api/inference/pool/settings -d '{"poolPrefixAffinityMaxInFlight": 2}'
```

Then compare an agent session's second-call `prompt processing` in the engine's journal, and the routing log's `affinity` column, against a node still at `0`. Raise the limit on a node whose engine has more slots than the fleet's four, or whose sessions are long enough that even a deep queue beats a cold prefill; `1` is "only when idle".

## GPU pressure: a second load signal, AMD-only and off by default

Queue depth answers "how much work has this node accepted". It does not answer "is this machine's GPU already committed" — a card saturated by ComfyUI, a direct `ollama run`, or another orchestrator sharing the same host engine is invisible to every queue counter in the system, and that node still advertises an empty queue.

The **pressure band** is a second, independent signal for exactly that question: an integer `0`–`3`, or **absent** meaning *unmeasured*.

### How it is measured

A sampler takes one reading every 10 seconds, entirely off the request path — ranking a request reads an in-memory number and forks nothing. Sources are tried in order and the first that answers wins:

| Source | What it reads | Status |
|---|---|---|
| `host-file` | `busyPercent` from `/data/state/hardware/gpu_pressure.json` | **Nothing in this repo writes this file.** It is the extension seam for vendors the Hub container cannot see. |
| `amd-drm` | `gpu_busy_percent` from `/host/sys/class/drm/card*/device` | Works wherever the host `/sys` is mounted — see *Enabling the AMD source* below. |

Readings are smoothed with an EWMA (α = 0.4) and quantised with a 5-point deadband (enter a band at 0.40/0.70/0.85 occupancy, leave it at 0.35/0.65/0.80), so a value oscillating across a boundary does not flap the number every peer is ranking on. Rises may skip bands; falls walk down one at a time.

Sampling only runs while this node has at least one **connected peer** — the band exists to be compared against another node's, so a single-node Hub does one indexed `SELECT` every ten seconds and no file reads at all.

**Why AMD only, and why the other sources were cut.** `gpu_busy_percent` is the amdgpu driver's own duty-cycle counter and is the one number available here that actually tracks whether the device is working. The reviewed design also carried two VRAM-residency sources — Ollama's `/api/ps`, and a CPU-spill fraction. Both were removed: resident weights read the same whether an engine is generating or idling out its `keep_alive`, so a band built on them would have rated the *coldest* node the least busy, which is precisely the inversion `poolLocalAffinity` exists to price. NVIDIA and Apple nodes therefore report **nothing**, which is honest, until someone writes the host file. Adding a vendor is a writer change (a desktop timer, or a systemd timer on a fleet node) plus nothing at all in the Hub.

### Absent means neutral, never idle

This is the property the whole feature turns on, and it holds end to end:

- A node that cannot measure **omits** `gpuPressure` from its capabilities payload rather than sending `0`. Absence and idleness do not share an encoding on the wire.
- A reader turns an absent, stale, or invalid band into `UNKNOWN_PRESSURE = 1` — mid-band, deliberately not `0`, exactly as `UNKNOWN_PEER_LOAD` already works for queue depth.
- A peer's band is discarded entirely once its snapshot is older than three health polls, and clamped to `null` unless it is an integer in `0..3`. `last_capabilities` is JSON a paired peer fully controls.
- A peer's self-reported band is **floored** by what this node has forwarded there and not yet finished reading. Otherwise a peer that hardcodes `gpuPressure: 0` wins every tie forever and the band becomes an attack surface rather than a signal.

On a fleet where most nodes cannot measure, the alternative — reading silence as "idle" — would systematically route work to whichever machine knows least about itself.

### How it enters ranking

`poolPressureWeight` defaults to **`0`**, and at `0` the band is *arithmetically absent*: the score term vanishes and the pressure key is not evaluated by the comparator at all. Ranking on a fresh Hub is byte-for-byte what it was before this feature existed — by construction, not by an argument about what can be measured.

At `1` the score is PAIR's `pending + pressure`, plus the usual local-affinity handicap on peers. That is what lets a node whose queue is empty but whose GPU is committed hand work to a calmer peer. A band is worth one queued request per unit of weight, so a materially shorter queue still wins.

**Do not try to read latency out of this number.** `docs/fleet-benchmark-results.md` §1.1 shows paired throughput ratios swinging 1.57–3.65× on a code prompt and ~1.0× on a prose prompt, on identical hardware, model and build. A 0–3 band cannot predict time-to-first-token and is not intended to. It answers one question — *is this machine's GPU already committed?* — and is used only as an ordering key.

### Enabling the AMD source

The reader ships; the mount does not. `/host/sys` is not bind-mounted by any compose file in this repo, so **out of the box every node reports no band and ranks neutral**, which is the same no-op the default weight already guarantees.

To enable it on a Linux AMD node, add one line to the `ci-hub` service's `volumes:` and recreate the container:

```yaml
      - /sys:/host/sys:ro
```

It must be `/sys`, not `/sys/class/drm`: `card*/device` is a symlink into `/sys/devices/…`, so a narrower mount yields dangling links. The mount is read-only and exposes kernel device metadata rather than data — materially less powerful than the Docker socket already mounted alongside it — but it is a real container-posture change, which is why it is an operator decision rather than a default. It is deliberately not in `docker-compose.prod.yml`: a new unconditional bind mount is the one part of this feature that could stop a Hub booting, peerless single-node ones included, and it has not been verified against Docker Desktop on macOS and Windows where the same compose file runs.

Then set the weight, on each node that should act on it:

```bash
curl -X PATCH .../api/inference/pool/settings -d '{"poolPressureWeight": 1}'
```

### End-to-end lag

A change on one node reaches another node's ranking through: the EWMA (~30 s to 64% of a step), then that peer's next capability poll (`poolHealthPollSeconds`, 30 s by default). Worst case is roughly **90 seconds at the default cadence, and about 5 minutes at the 300 s maximum**. The band is a steady-state signal about a machine, not a per-request measurement.

## Container counts: what the rest of the fleet is running

A paired peer's capabilities payload carries one more optional key, `containers`, so the operator surfaces can answer "how loaded is the rest of my fleet" without a second route or a new probe:

```json
"containers": { "running": 6, "stopped": 2, "total": 8, "cpuPercent": 91.25, "memoryBytes": 5368709120 }
```

**Counts and aggregate resources only.** No container names, no per-container rows. A peer learns how loaded a box is and never which applications it runs. Model ids are already shared by name because models are what the pool *offers* and a peer cannot rank a node without them; containers are offered to nobody, so this stays coarse deliberately.

**Scope is the containers this Hub manages** — the compose projects `AppRuntimeMonitorService` already samples for `/resource-monitor` — not the whole Docker daemon. A container started by hand outside compose is invisible to that sampler and absent from these totals. `stopped` is `total - running`, so the two sum; everything that is not `running` (including `paused` and `restarting`) lands in `stopped`, and a `docker compose down` removes containers entirely rather than making them stopped.

### Absent means not reported, never zero

The same rule as [GPU pressure](#absent-means-neutral-never-idle), and it is what the shape is designed around. Four states, three encodings:

| State | On the wire | How it must read |
|---|---|---|
| Peer on a pre-container build | key absent | not reported |
| Peer whose operator set `poolShareContainerStats: false` | key absent | not reported |
| Reporting, nothing running | `{ "running": 0, ... }` | 0 containers |
| Reporting, busy | real numbers | real numbers |

The first two being indistinguishable is correct: both mean *"we cannot tell you"*, and neither may ever be drawn as an idle machine. A node whose own sampler has no recent collection omits the key for the same reason rather than publishing zeros it did not measure.

- **No new probing on the poll path.** The producer reads only the sample the runtime monitor's 60 s timer has already collected, and reports nothing at all when the last *successful* collection is over two intervals old. `GET /capabilities` answers every peer's 30 s poll under a 15 s budget, and three overruns mark a healthy node unreachable — a Docker fan-out here is that incident again.
- **`acceptingWork: false` does not blank it.** Container counts are a health signal, not an offer of work, so they follow `inFlightRequests` and not `backends`. A node that has stopped taking work is exactly when an operator needs to see whether it is still busy.
- **Validated on the read path.** `last_capabilities` is free-form JSON a paired peer fully controls, so negative, non-finite, absurd, wrong-typed or self-contradictory figures (more running than exist) are rejected wholesale and surface as `null`. One bad field rejects the whole rollup rather than leaving a half-truth that reads as measured, and a rejected value never becomes `0`.

`GET /api/inference/pool/status` and `GET /api/inference/pool/peers` both carry the clamped, freshness-gated value as `containers` on each peer row — not the raw jsonb, for the same reason `gpuPressure` is not.

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

- **The outbound gate lives in `PoolProxyService.buildCandidateList`, not in `listConnectedPeers()`.** The latter also answers `hasConnectedPeers()`, which `inference-env-resolver.ts` consults when it generates an app's env, to decide whether the app's `CI_LLM_BASE_URL` points at the pool proxy. Gating it there would move every app generated while outbound was off onto a direct backend URL. With the gate on the request path, switching outbound off keeps apps on the proxy and changes only which model a refreshed app is handed, since peers drop out of the inventory it is chosen from. Saving either switch through `PATCH /api/inference/pool/settings` requests that refresh.
- **Two dashboards will legitimately disagree.** A Hub that has disabled a peer still polls it successfully and shows it `connected` (plus a "disabled" pill); the peer shows this node as not accepting work. Both are the honest local truth on each side.

Per-peer disable keeps the pairing, both directional tokens and the health poll intact — that is what makes it instantly reversible, and it means **disabled is not revocation**. An operator who wants the token gone must still Unpair.

**`HUB_POOL_USER_DISABLED` wins over `poolEnabled`.** The env flag is an operator-of-the-box decision that a UI toggle must not be able to undo, so the setting is deliberately *not* projected into `.env`: routing it through `HUB_POOL_USER_DISABLED` would put it behind `generateSystemEnvFile`'s env-first precedence, and pooling could never be turned back on from the UI once the flag had been written to disk. `GET /api/inference/pool/status` reports which switch is in force (`disabledBy: 'env' | 'setting' | null`) precisely so the UI can say "your `.env` overrides this" instead of showing a toggle that appears to do nothing.

## Operator status and routing log

- **`GET /api/inference/pool/status`** (session auth, or see [Reading these without an operator credential](#reading-these-without-an-operator-credential)) answers the whole question in one call: `enabled` / `disabledBy` / `reason` (`active`, `no_peers`, `partially_disabled`, `disabled_by_env`, `disabled_by_setting`), `directions` (each of `outbound`/`inbound` with its own `enabled`/`disabledBy`), `routingActive` — which now means outbound is on **and** at least one connected, *enabled* peer exists — the persisted `settings`, `tailscaleAdminApiConfigured` (whether this Hub can enumerate the *whole* tailnet — the boolean only, never the credentials; it is **not** a report on whether discovery works, since the daemon peer map and the Portal registry need no credential and neither result is reported here — the two fields that come close, `localNode.tailscaleConnected` and `localNode.tailnet`, are preconditions rather than results, the latter gating this very leg, and nothing reports the Portal leg), this node's identity, queue depth and per-backend model inventory, and every peer with its status, `lastSeenAt`, `consecutiveFailures`, cached backends/models, and the number of requests currently forwarded to it. Peer rows go through `toPublicPeer`, so the token columns cannot appear. It is cheap enough to poll: one `SELECT`, in-memory counters, the 30s-cached Tailscale status, and a 20s-cached local inventory — it never runs peer discovery (an HTTPS probe per unpaired candidate, plus a Portal dispatch call and, with a credential, a Tailscale OAuth exchange) and never re-probes peers.
- **Every routed response names the node that served it.** `POST /v1/chat/completions`, `/v1/completions`, `/v1/embeddings`, `/api/generate`, `/api/chat`, `/api/embeddings`, and `/api/embed` through the proxy carry four response headers, set before the first body byte so a `stream: true` completion has them too:

  | Header | Value |
  |---|---|
  | `X-Hub-Pool-Served-By` | `local` when this node's own engine served the request, otherwise the peer's tailnet FQDN (for example `core-14.tailxyz.ts.net`) |
  | `X-Hub-Pool-Backend` | The engine type on the serving node: `ollama`, `vllm`, `lemonade`, `mtplx`, `dspark`, or `lucebox` |
  | `X-Hub-Pool-Model` | The model the request was routed for |
  | `X-Hub-Pool-Request-Id` | The `id` of this request's row in the routing log. Also sent to the serving peer on the `/local/*` forward, so the peer's inbound row carries the same `id` |
  | `X-Hub-Pool-Affinity` | `hit`, `miss` or `skipped` — what [prefix affinity](#prefix-affinity) did, on the chat/completion/generate routes when it is on. Absent otherwise. An app names its session for it with the `X-Hub-Pool-Session` request header |

  A request that failed over names the node that *answered*, not the one tried first. On a 502 only `X-Hub-Pool-Request-Id` (and `X-Hub-Pool-Affinity`, when affinity applied) is set: a failed call is the one most worth looking up, and there is no serving node to name. `local` is deliberately not this node's own MagicDNS name: the proxy admits any caller inside the appliance without a credential, and `/identify` stopped disclosing the name to unauthenticated callers for the same reason — see [What `/identify` no longer says](#what-identify-no-longer-says-and-where-the-name-went-instead). Nothing else about the peer appears: never its node UUID, and never a container name. Any `x-hub-pool-*` header the upstream engine or peer returns is dropped, so the attribution is always this Hub's own statement. To check by hand: `curl -i` and read the headers, or `curl -sD - -o /dev/null` for headers only.
- **`GET /api/inference/pool/routing-log?limit=&since=`** (session auth, or see below) returns recent routing decisions, newest first: `id`, timestamp, `updatedAt`, direction, path, model, the node that served it, how many candidates were ranked, which attempt won, the chain of nodes that were tried and rejected before it, outcome, upstream status and time to response headers, and `pin` — the shape of the operator pin that ordered the candidates, or `null` (always `null` inbound: a peer's forward is never re-routed) — `promptCeiling`, what [prompt ceilings](#prompt-ceilings) did to the decision, or `null` (inbound too, and for the same reason), `throughput`, what [measured throughput](#throughput-aware-placement) did to it, or `null`, and `affinity`, what [prefix affinity](#prefix-affinity) did to it, or `null` when it is off or the route is not one it judges. `stream`, `bodyBytes` and `budgetMs` describe the request: whether it streamed, the UTF-8 size of the body as forwarded, and the header deadline it was given, from the same function the forward's timer uses — a row that failed at exactly `budgetMs` failed on the deadline. A request that failed over is **one** entry carrying `failedOverFrom`, not one per attempt. Inbound entries record work a *peer* forwarded to this node's engines, attributed to the peer the guard authenticated, under the `id` the sender minted. It is bounded, in-memory and process-local — no database table, and nothing survives a restart — and it records metadata only: never a prompt, a request body, or a response.

  - **Joining both nodes' rows for one call.** Take `X-Hub-Pool-Request-Id` from the response, or the `id` of the entry Hub's outbound row, and find the row with the same `id` in the serving peer's routing log. Two concurrent calls for the same model get different ids, which a time window cannot separate.
  - **Polling without losing rows.** Pass the previous response's `nextSince` as `since`. You get the rows placed **or changed** at or after it — including a row you last saw `pending` that has since settled — and the row carrying `nextSince` comes back once more, because `since` is inclusive: keep the newest copy of each `id`. `matched` greater than the number of `entries` means `limit` cut the page; a cut cursor page keeps the *oldest* changes, so following `nextSince` reaches the rest without losing any. A full page whose `nextSince` equals the `since` you sent means more than `limit` rows changed in one millisecond: ask again with a larger `limit`. Without `since` you get the newest placements and a `nextSince` to tail from. `since` must be ISO 8601 with a zone (`Z` or an offset); send an offset's `+` as `%2B`, because a query string reads a bare `+` as a space.
  - **Telling a restart from a quiet pool.** `summary.bootId` is random per process and `summary.startedAt` is when this log began: if `bootId` changed, the log you were paging no longer exists. `summary.totalRecorded − summary.recorded` is how many rows the ring has evicted since boot, and `summary.oldestAt` is the placement time of the oldest row still held.
  - **Ring size.** 200 rows by default. Set `HUB_POOL_ROUTING_LOG_SIZE` (200–10,000, read at start-up) for a larger ring; a row is about 540 bytes of JSON and 0.8 KB of heap, so 10,000 rows is about 8 MB. A call without `limit` still returns at most 200 rows, so the dashboard's 15-second poll does not grow with the ring; ask for up to 10,000 with `limit`.

### Reading these without an operator credential

Two credentials read pool status and the routing log without being operator credentials. Everything else answers them as before.

- **A `qa:read` API key.** Mint one on the Hub with `cihub api-key create --name fleet-qa --scope qa:read`. It reads `GET /api/inference/pool/status`, `GET /api/inference/pool/routing-log`, `GET /api/apps/:urn` (without the app's `config`, which holds install-form secrets), and `GET /api/apps/install-queue`, and every other GET answers it 403 `AUTH_ERROR_QA_READ_KEY_ROUTE_NOT_ALLOWED`. A write answers 401: the Hub looks the key up only on a GET or HEAD, so a pool peer's bearer-authenticated `POST /local/*` forward never pays for a key-store query. Use it for test harnesses and monitoring instead of the Portal device key, which is grant-exempt operator authority that Portal also holds. The handlers it reaches are the ones marked `@ObservabilityRead()`, and a test pins that list.
- **The CLI JWT on a Hub nobody has claimed.** A registered but unclaimed Hub answers host-local credentials 409 `AUTH_ERROR_HUB_NOT_CLAIMED`, because there is no operator for them to act as. Status and the routing log act as nobody, so the CLI JWT (signed with the Hub's own `jwtSecret`) reads those two routes anyway; every other route, and every write, still answers 409. The Portal device key does not get this: Portal holds it too, and until someone claims the Hub nobody has agreed to let a cloud-held credential read the pool's topology. `ObservabilityReadGuard` explains the reasoning in full.

## Peer identity: PIN pairing and signed requests

Each Hub has a stable **pool node UUID** and an **Ed25519 keypair**, minted once and kept in
`hub_pool_identity` (one row, id `self`). The UUID never changes — not on a rename, a tailnet move
or a re-registration — and the private key is the only pool secret this Hub holds: for every peer it
stores a *public* key and nothing else. That is the substantive improvement over the original
directional bearer tokens, where every Hub held, for every peer, an encrypted copy of a secret that
authenticated it to that peer.

**Pairing pins the peer's UUID to its public key (trust on first use, pinned thereafter).** Once
pinned, requests carry a signature instead of a token:

```
X-Hub-Pool-Node:      <sender's pool node UUID>     ← the lookup key
X-Hub-Pool-Peer:      <sender's own nodeFqdn>
X-Hub-Pool-Timestamp: <unix ms>
X-Hub-Pool-Nonce:     <16 random bytes, base64url>
X-Hub-Pool-Signature: v1.ed25519.<base64url>
```

The signature covers a fixed preamble, the method, the path, the sender's UUID, the sender's claimed
FQDN, **this node's UUID as the sender has it pinned**, the timestamp and the nonce — plus a
canonical hash of the body on the control routes (`/pair/*`). The recipient line is what makes a
captured signature non-transferable to another peer; the nonce, kept in a bounded single-use cache
inside a ±300s skew window, is what makes it non-replayable. The body hash is deliberately **not**
included on `/local/*`: the recipient UUID, nonce and timestamp already make a captured forwarding
request unusable, and canonicalizing a megabyte embeddings batch on every hop is not affordable on
the streaming path.

### The PIN, and what it actually buys

`POST /pair/request` is the module's only unauthenticated write. Without a PIN it will create a
`pending` row — and store a caller-supplied token as this Hub's outbound credential — for anyone who
can name a plausible FQDN on this tailnet: the suffix check refuses a name from anywhere else, but a
suffix is only a string, and the device-membership check that would catch a fabricated one needs an
Admin API credential that is optional. **With a PIN, a wrong guess creates nothing**: no pending slot,
no planted outbound token, no pinned identity.

Generate one on the receiving Hub (**Settings → Network → Hub Pool → Pairing PIN**, or the mint
route) and type it into the initiating Hub next to the address. Six digits, ten minutes, single use,
five wrong attempts destroy it, and a source that keeps guessing is refused with a 429 on the same
strike-and-backoff limiter the inference module uses for unservable models. Wrong, expired,
already-used and none-outstanding all answer with the *same* 401 — telling a caller whether a PIN is
even outstanding would make the space searchable in two steps. The digits are returned exactly once,
by the mint call; `GET /pool/status` reports only `pairingPin: { active, expiresAt }`.

**What "a source" means, precisely.** The 429 limiter is keyed on the claimed FQDN and, *when the
Hub can honestly identify it*, on the caller's IP. It usually cannot: Express `trust proxy` is unset
by default, so behind Traefik or the Cloudflare tunnel `request.ip` is the proxy's own private
address, identical for every caller in the world. Keying on that would not be a stricter limit but a
different one — a global lockout, which would let anyone who can reach the tunnel stop the operator
pairing at all. So the IP key is used only when the request carries no reverse-proxy provenance
(the LAN and tailnet case, which is how peers actually arrive) or when `HUB_TRUST_PROXY` is set and
Express has resolved the real client. Otherwise the cooldown runs on the claimed FQDN alone — which
is trivially varied, and is why it was always the second layer. **The real bound on a PIN's exposure
is the per-PIN ceiling: five wrong guesses destroy it, whoever makes them, so total exposure is
5/10⁶ regardless of how many sources try.**

A PIN authenticates the *request*, not the operator's decision. The row still lands **pending** and
still needs a confirm, which now renders the requester's FQDN *and* its key fingerprint side by side.
A PIN read aloud or over a shoulder therefore gets an unintended node into an approval list, never
into the pool.

Pairing **without** a PIN behaves exactly as it did before: same flow, same 20-row ceiling, same
24-hour sweep. The identity exchange still happens, but on `/pair/confirm`, which `PoolPeerGuard` has
already authenticated — so a legacy pairing ends up pinned too, without an unauthenticated identity
claim ever being stored.

### Upgrading an existing bearer pairing

A pairing that predates this ships unchanged and keeps working: every new column is nullable, and the
legacy branch of `PoolPeerGuard` is the same code it was. The upgrade then rides the existing health
poll — a peer still on tokens reports its `nodeUuid` on the (authenticated) `capabilities` response,
and the poller calls `POST /pair/upgrade` with the bearer token it is about to retire.

This is a **transfer of an existing trust relationship onto a stronger carrier**, not a fresh
trust-on-first-use bootstrap. It is exactly as trustworthy as the pairing it inherits, and it does not
launder a pairing that was bad to begin with.

The crossover is bounded and self-healing:

- The side that learns the peer's key from a **response** knows the peer has its key, and signs from
  then on.
- The side that learns it from a **request** cannot know its own reply arrived, so it keeps
  presenting its bearer token and opens `bearer_grace_until` — by default ten minutes, or four health
  polls, whichever is longer.
- The moment a correctly signed request from that peer is *observed*, `signed_seen_at` is stamped,
  both token columns are nulled and the grace window is cleared. An old database backup then holds
  tokens that authenticate nowhere.
- If the window closes with no signed request ever seen, the pinned key is **rolled back** rather
  than enforced, and the exchange is retried on a later tick. Enforcing it would lock out a peer that
  is behaving correctly.

The no-downgrade rule is therefore keyed on evidence, not on a clock: a bearer token is refused only
for a row whose key is pinned **and** which has been seen signing. `poolRequireSignedPeers` (default
**false**) removes the legacy branch outright, on the guard and on the outbound client alike — flip it
only once `GET /pool/status` shows every peer with `authMode: 'signed'`, because on a mixed fleet it
is an outage.

### Identity, addresses and rotation

Identity beats address. A signed peer that turns up under a new MagicDNS name has *moved*: the name
change is authenticated by the signature that carried it, recorded, and applied by the health tick —
never written from inside the guard, because `node_fqdn` is UNIQUE and a collision there would turn an
authenticated request into a 500 and permanently redirect this Hub's outbound pool traffic. This fixes
a live defect: a rename used to break a pairing permanently, with the poll simply failing forever.

`POST /pool/identity/rotate` mints a new keypair, keeps the UUID, and **unpairs every peer** —
every one of them has pinned the old key and there is no signed-rotation message in this protocol. It
runs in two phases: the unpair calls go out first, signed with the key that is about to be destroyed,
and the response names the peers that could not be reached so the operator knows which Hubs still
hold a stale row.

### Failure modes, and why none of them is fatal

`EncryptionService` derives its key from `JWT_SECRET`, so a regenerated `.env` over a retained
Postgres volume — an ordinary reinstall — leaves the stored private key undecryptable. That must never
be fatal, and it is not:

- Identity load is lazy, memoized, retried on a timer, and **never rejects at its caller**. A throw
  would take down whatever touched pooling first, on every appliance running this build, peerless
  single-node ones included.
- There is deliberately **no boot-time warm**. `EncryptionService` runs `pbkdf2Sync` at 100,000
  iterations — measured at 42.8 ms — so warming the cache at startup held the event loop for 43 ms
  on every boot of every Hub, pooling or not. A Hub with no peers whose Hub Pool page is never opened
  now mints no identity at all. Each caller is already async and already awaiting something slower,
  so it is paid once, on first use, off the boot path.
- `node_uuid` and `public_key` are stored in the clear, so such a Hub can still *verify* its peers
  (verification needs only their public keys and this node's own UUID) while it can no longer *sign*.
  **It does not keep routing, though — the pairings need redoing.** The bearer token this node
  would fall back to is `present_token_encrypted`, sealed with the same `JWT_SECRET`-derived key,
  so it is just as unreadable, and every outbound probe fails with `No outbound pairing token
  stored` (or the raw decrypt error). Inbound keeps working for exactly as long as the peer keeps
  signing: the moment this node's grace window for that peer lapses without a signed request of its
  own, the peer rolls its pin back and starts presenting *its* bearer — which this node refuses,
  because it has already seen that peer sign (`bearerStillAccepted`). Both directions end in a 401
  loop that never trips `unreachable` on the node that is actually up (`/identify` still answers),
  and nothing about it self-heals. Seen on core-4 for four days in September 2026.
  **Recovery:** `POST /pool/identity/rotate` on the affected node (it re-seals a fresh keypair under
  the *current* secret, keeping the UUID; the unpair it does is of pairings that are already dead),
  delete that node's row on each peer, and pair again.
- The row is **never silently re-minted**. A new public key would unpair the whole fleet to work
  around a recoverable environment problem.
- The reason appears as `localNode.identity.identityError` on `/pool/status`, exactly the way a down
  inference backend already appears as `capabilitiesError`.

### A peer whose identity changed

A Hub whose database is recreated comes back with a new UUID and key under the same MagicDNS name. On
2026-09-16 a compose project-name fix created a fresh `ci_hub_pgdata` volume on beta-max. Every peer
still had the old identity pinned. Their signed probes addressed a node that no longer existed, so
beta-max answered each one with a 401. The peers logged `capabilities probe ... failed: 401` for 28
hours, and nothing said the pairing had to be redone.

A Hub now tells that case apart from the others:

- A signed request carries `X-Hub-Pool-Recipient`, the UUID the sender has pinned for the receiver.
  The signature already covers that value, and the header only puts it in the clear.
- When the header names a UUID the receiver does not hold, the guard answers 401 with
  `X-Hub-Pool-Refusal: identity-mismatch`. This is the one refusal the guard names. It tells a caller
  only that a UUID it already knew is no longer this node's. The current UUID is never sent.
- The prober classifies each failed health probe as `unreachable` (no answer, a 5xx, or a 403),
  `unauthorized` (a bare 401), or `identity_changed` (a 401 with the refusal header). The verdict
  appears as `probeFailure` on each peer in `GET /pool/status`, with an `action` that names the
  commands to run. `cihub pool status` prints it under **Peers refusing this Hub**, and
  `cihub pool doctor` fails check F1.
- `unreachable` keeps the normal cadence, because it clears on its own. The two refusal kinds back
  off from two polls to at most 15 minutes. `identity_changed` also leaves routing on the first
  strike instead of the third.
- This node never trusts the new key by itself. A far end that says its key changed is exactly what an
  impostor at that name would say.

If `cihub pool status` shows **identity changed** for a peer, re-pair in this order:

1. On this Hub, run `cihub pool unpair <peer name>`. The stale row has to go first, because
   `pair` answers 409 while it exists, and a PIN request from the far side is ignored.
2. On the peer, run `cihub pool pairing-pin`.
3. On this Hub, run `cihub pool pair <peer name> --pin <digits>`.
4. On the peer, compare the key fingerprint with this Hub's `cihub pool status`, then run
   `cihub pool approve <this Hub's name>`.

If it shows **credentials refused** instead, the far end runs a build without the refusal header or
refused for another reason. Run `cihub pool status` on the peer. If this Hub is not listed there,
re-pair as above. If it is listed, compare the two clocks: a signed request allows 5 minutes of skew.

The classification is process-local and rebuilt by the next failed probe after a restart.

### What `/identify` no longer says, and where the name went instead

`GET /api/inference/pool/identify` is unauthenticated and reachable through the Cloudflare tunnel. It
now answers `{ isCiHub: true, poolProtocol: 2 }` and nothing else. The node UUID and public key live
on the guard-protected `capabilities` route instead — a UUID whose whole purpose is surviving renames
is a durable correlator, which is the last thing to publish on an open endpoint.

The MagicDNS name was **moved, not deleted**, and the difference matters: something does consume it.
`cihub pool probe` exists so two Hubs on one LAN can pair with no Tailscale OAuth client, and a peer
row is keyed on `node_fqdn`, so pairing by address is impossible unless the address can somehow
produce a name. It is disclosed in the reply to a `POST /pair/request` **that carried a valid pairing
PIN** — that is, to a caller that has demonstrably been in front of the other Hub's screen. An
anonymous caller on the tunnel-published endpoint still learns nothing but the protocol version.

That boundary is the whole design. The probe answers "is there a CI-Hub here, and can I pair with
it"; the PIN-gated exchange answers "and this is who it is".

## What guards what

- **`POST /pair/request`** is the one unauthenticated write — a would-be peer has no credential yet by definition. It is therefore the most constrained: the kill switch blocks it outright; `fromNodeFqdn` must be a bare hostname (a scheme, credentials, port, path or IP literal is refused, because that value is interpolated into every later `https://<fqdn>/api/...` call this Hub makes to the peer, including the one that carries a freshly issued token); the name must belong to this tailnet, checked in two layers — the MagicDNS suffix always, with no credential needed, and Admin API device membership on top when `TAILSCALE_OAUTH_CLIENT_ID`/`SECRET` are set (an Admin API that is unreachable degrades to a warning rather than blocking a legitimate request, and a Hub that has joined no tailnet has nothing to compare against and accepts); at most 20 inbound requests may await approval at once; and an unanswered request expires after 24 hours, so a squatted name cannot block pairing with the real device indefinitely.
- **`/pair/confirm`, `/pair/reject`, `/pair/unpair`, `/pair/upgrade`, `/capabilities`, `/local/*`** require `PoolPeerGuard`, which admits a caller two ways: an Ed25519 signature over the request, resolved by the caller's pinned pool UUID (preferred — see [Peer identity](#peer-identity-pin-pairing-and-signed-requests)), or the legacy `X-Hub-Pool-Peer: <caller's own FQDN>` plus the bearer token *this* Hub issued that peer. The bearer branch is refused for a row that has been observed signing, and refused outright when `poolRequireSignedPeers` is on.
- **`/peers/*`** are operator routes behind the normal session `AuthGuard`.
- **The app-facing `/v1/*` and `/api/*` proxy routes** admit a caller two ways, through `InferenceAccessGuard` (the same guard as the OpenAI-compatible `/api/inference/v1` routes on `InferenceController`). **By origin:** the request came from inside the appliance — a private source address, no reverse-proxy provenance (`cf-ray` and friends), and no `X-Forwarded-For` hop that is not private. Behind the Cloudflare tunnel `request.ip` is the proxy's own private address unless `HUB_TRUST_PROXY` is set, and these routes spend GPU time on every paired node, so a source-IP check alone would pass public tunnel traffic; the provenance headers are what tell the two apart. Apps reach the proxy container-to-container, carry none of those headers, and are admitted without the guard reading `Authorization` at all — an app sending `Bearer ollama` costs no key lookup. This leg is an origin check, not caller authentication: an app that only declares `hub_integration.inference` is issued no Hub-managed key, so there is no per-app credential to bind to, and any container on the Hub's Docker network can use the pool. **By `inference` API key:** a request the origin check refused is admitted if it carries `Authorization: Bearer <key>` for a key minted with `cihub api-key create --scope inference`. That is how an editor reaches the pool from the public hostname; see [Use your Hub from your editor](editor-inference.md). Refusals are OpenAI-shaped (`{ error: { message, type, code } }`) with `code` `missing_api_key` or `invalid_api_key`, so an OpenAI client shows the reason verbatim.

## Operator workflow

1. On each participating Hub, confirm **Settings → Network** shows Tailscale connected.
2. Find the other Hub, by either route. **The two are not interchangeable**: a directory learns a node's
   name, so its candidates can be paired with from the UI, whereas an address probe deliberately learns no name —
   `/identify` does not disclose one — so pairing by address needs a PIN and happens from the CLI:
   - **By directory:** `cihub pool discover`, or the Discoverable devices list in the UI. On a tailnet-connected Hub this already works with no credential. Set the Tailscale OAuth client env vars above to add the whole tailnet. (The CI Portal registry is wired in as a third directory but [returns nothing today](#where-pairing-candidates-come-from), so registering does not add candidates.) See [Where pairing candidates come from](#where-pairing-candidates-come-from).
   - **By address, no directory needed:** `cihub pool probe 192.168.1.42` (or `192.168.1.42:5002`, or a hostname) confirms a Hub is there; `cihub pool pair 192.168.1.42 --pin <digits>` pairs with it, using a PIN minted on that Hub. See [Finding a peer by address](#finding-a-peer-by-address) for what each half does and does not do.
3. Open **Settings → Network → Hub Pool**. Named candidates appear with a **Pair** button — a Hub found by address is not in that list (it has no name to show yet) and is paired with from the CLI. With no OAuth credential and nothing to list, the section says which variables would add whole-tailnet enumeration rather than showing a bare empty list. It does not claim discovery is off, because it cannot: of the three directories, `GET status` reports only the Tailscale credential and `localNode.tailscaleConnected`, and says nothing at all about the Portal registry.
4. On the *other* Hub, a pending inbound request appears with **Approve** / **Reject**, identified by the requester's FQDN and — when the request carried a pairing PIN — its key fingerprint, which is the value to compare against that Hub's own **Pairing PIN** card.
5. Once connected, both Hubs' **Hub Pool** sections show whether pooling is actually routing (and if not, which of the two kill switches is responsible), the `poolEnabled` and `poolLocalAffinity` controls, each peer's status / last-seen / queue depth / hardware tier / engines, the merged list of models the pool can serve and which nodes hold each, and the recent routing decisions with failovers called out.

A peer shown **unreachable** needs no operator action: it is skipped while it fails probes and rejoins on the next successful one. Unpairing is for removing a Hub from the pool, not for recovering one. The exception is a peer that answers but refuses this Hub, shown as **identity changed** or **credentials refused**. It will not recover by waiting. See [A peer whose identity changed](#a-peer-whose-identity-changed).

To validate a real two-node pool end to end — pairing, routing, load handoff, failover, recovery, the
kill switch, and the security checks — follow [`hub-pool-fleet-testing.md`](hub-pool-fleet-testing.md).

Every step above is also available headlessly through `cihub pool` — `status`, `peers`, `discover`, `probe`, `pairing-pin`, `pair`, `approve`, `reject`, `unpair`, `pin`, `unpin`, `log`, `enable`, `disable`, `peer-enable`, `peer-disable` — which is the path for an SSH-only Hub or a coding agent. It hits the same endpoints with the Portal device key and runs on the Hub it manages, so approval still happens on the receiving Hub. See [`CLI.md` → Hub Pool](CLI.md#hub-pool).

## Where pairing candidates come from

`GET /api/inference/pool/peers/discoverable` (`cihub pool discover`, and the **Discoverable devices**
list in the UI) answers one question: which unpaired nodes can this Hub *name*? A name is the whole
contract, because pairing from that list means handing an entry's `nodeFqdn` to `peers/pair`. Three
directories can supply one, and `HubPoolDiscoveryService` merges them:

| Directory | Needs | Names |
|---|---|---|
| The local Tailscale daemon's peer map | Tailscale connected on this node | Every tailnet peer this node can see, with no credential at all |
| The Tailscale Admin API | `TAILSCALE_OAUTH_CLIENT_ID` / `TAILSCALE_OAUTH_CLIENT_SECRET` (`devices:core:read`) | Every device on the tailnet, including ones the local daemon does not list |
| The CI Portal device registry | A registered Hub (`cihub register`, so a Portal device key is on disk) | Hub devices registered to the same user or organization — **but see below: this leg returns nothing today** |

Every candidate is then probed at `https://<name>/api/inference/pool/identify`, and only a node that
answers `isCiHub` is offered. Already-paired names are excluded before probing, and so is this node
itself. **None of the three is required.** A Hub with none of them still pairs, by address and a PIN.

The credential does not stand on its own: the Admin API is queried with the tailnet name the *local*
daemon reports, so a Hub that has not joined a tailnet enumerates nothing from it however valid the
OAuth client is. A directory that fails contributes nothing and the others still answer, but they are not equally
loud about it. The Admin API leg logs its failure at debug. A failed `tailscale status` read is
logged at warn by `TailscaleService` and answers "not connected", which empties the daemon leg
without failing it. The Portal leg is the quiet one: `PortalClientService.fetchDispatchDevices`
ends `} catch { return []; }`, so the commonest Portal failure — unreachable, or a 4xx/5xx on
`/devices` — produces no log line at any level, and an empty Portal directory is indistinguishable
from a failed one. Only what escapes into `listPortalCandidates`'s own catch reaches debug.

> **The Portal leg contributes no candidates today, for two independent reasons.** Plan around the
> two Tailscale directories and `cihub pool probe`; registering with Portal does not help you find
> pool peers.
>
> 1. **Auth.** `fetchDispatchDevices` calls `GET <portal>/api/devices` with the device key
>    (`Authorization: Bearer <ciHubApiKey>` + `x-device-key`). That route is `ListDevices` behind
>    Portal's `sessionMiddleware`, which authenticates a **browser session** via better-auth
>    `getSession` — a device key is not a session, so the call is refused.
> 2. **Shape.** `listPortalCandidates` names a candidate from `tailscaleDns` alone, and CI-Portal has
>    no such field: the `device` table stores `device_id`, `api_key`, `name`, `slug`, `status`,
>    `pairing_code` and `catalog_channel`, and nothing tailnet-shaped. Even with a session, every row
>    would be skipped for having no MagicDNS name.
>
> Fixing it is a CI-Portal change (a device-key-authenticated device listing that carries a MagicDNS
> name), not a Hub one. Until then the silent `catch` above is what makes it look like an empty
> directory rather than a broken one — which is exactly why this note exists.

**A node two directories both name is offered once.** `mergePoolCandidates` folds on the normalized
FQDN — never on a UUID the far side claims, which would hand a hostile box a way to suppress a real
node from the list — and the tailnet entry wins, because its name is the one the transport will dial.
Only the directory's device id is back-filled onto the winner when it lacks one. That id is a display
value: a Tailscale device id on a tailnet entry, a Portal device id on a Portal one, and `null` in
`hub_pool_peer` either way.

**Portal is a directory, not a transport, and it does not extend reachability.** What it contributes
is a *name* — a MagicDNS name — and everything downstream still dials the tailnet: the `/identify`
probe, and then `https://<fqdn>` for pairing callbacks, health polls and proxied requests. Two
consequences are worth knowing before you expect a device to appear:

- **A device Portal knows only by LAN address is not listed.** `tailscaleDns` is the only field read
  off a Portal row, so a device without one is skipped before anything is normalized — `lanIp`,
  `lanUrl`, `hubUrl` and `tailscaleIp` are never consulted. `normalizePeerFqdn` is the second net,
  refusing an IP literal should Portal ever put one in that field, because such a name could not
  survive the `peers/pair` the row exists to feed. That Hub is paired with by address and a PIN
  instead, which is the route that does learn a name.
- **A device registered to the same account on a *different* tailnet is dropped at the probe**, not
  offered. Listing it would only move the failure to the pairing call. Pooling across networks would
  be a transport change — probing and pairing over Portal's `hubUrl` — not a discovery one, which is
  why neither `hubUrl` nor `lanUrl` is read here.

A Portal-sourced entry carries `source: 'portal'`; a tailnet entry carries no `source` at all, and
absence is the only encoding of "the tailnet named this". Nothing reads the field yet — the UI and
the CLI both render the merged list without saying which directory named a row.

**This route is not pollable, and nothing on a polling path may start calling it.** Every source
probes: one `/identify` per unpaired candidate, a Portal dispatch call, and a Tailscale OAuth
exchange when a credential is configured. Only a Hub that is disconnected from its tailnet, without
an Admin API credential, and without a Portal registration issues zero network calls here. That is
why `getPoolStatus` never touches it.

## Finding a peer by address

`cihub pool probe <address>` and `cihub pool pair <address> --pin <digits>` (`POST
/inference/pool/peers/probe` and `POST /inference/pool/peers/pair`) exist so that two Hubs on one LAN
can find each other without anyone having to go and create a Tailscale OAuth client first. It is
worth being precise about what each half does, because the obvious reading is wrong:

**The probe cannot name the node, and does not try.** It asks `GET /api/inference/pool/identify` at
the address and learns exactly two things: that a CI-Hub is there, and which pool protocol it speaks.
That endpoint is published through the Cloudflare tunnel and deliberately reports no MagicDNS name
(see [What `/identify` no longer says](#what-identify-no-longer-says-and-where-the-name-went-instead)),
so the probe is a *diagnostic*, not a directory lookup.

**The PIN-gated pairing exchange is what names it.** The operator mints a PIN on the other Hub
(`cihub pool pairing-pin`, ten minutes, single-use) and pairs by address with it. The PIN
authenticates the request, and the answer carries that Hub's tailnet FQDN along with its node UUID
and public key. The row is keyed on the FQDN, and from that moment the address is discarded:
pairing callbacks, the health poll and every proxied request go to `https://<fqdn>` — same real TLS,
same credentials, same WireGuard transport. There is no LAN peer transport and no second trust model.
This is why `normalizePeerFqdn` still refuses IP literals for anything that gets *stored*.

```
on hub-b:  cihub pool pairing-pin          # six digits, ten minutes
on hub-a:  cihub pool probe 192.168.1.42   # optional: confirm something is there
on hub-a:  cihub pool pair 192.168.1.42 --pin 123456
on hub-b:  cihub pool peers && cihub pool approve <id>
```

Consequences worth knowing:

- **A probed address is never remembered as a pairing candidate.** Every entry in
  `GET peers/discoverable` was named by a directory that authenticated this Hub before answering —
  the tailnet control plane or the CI Portal registry — because pairing from that list means handing
  a `nodeFqdn` to `peers/pair`. Holding unnamed rows there would mean a second identity space beside
  `node_fqdn`, keyed on something an unauthenticated responder chose — exactly what the peer table
  refuses to do everywhere else. Pairing by address is a single operator act, not a directory entry.
- **A Hub on an older pool protocol cannot be paired with by address.** It ignores the PIN and
  answers `{ received: true }`, so it can never disclose a name. The probe reports that up front
  rather than letting the operator discover it from a failed pairing; pair by MagicDNS name instead.
- **A Hub cannot pair with itself**, and the *receiver* is what enforces it — it is the one party
  that knows its own name for certain, and refusing there is what stops a self-probe leaving a
  phantom inbound request behind.
- The probe refuses any address that is not RFC1918, CGNAT or IPv6 ULA, and a hostname is refused if
  *any* address it resolves to is public. Loopback and link-local are refused too — `169.254.0.0/16`
  contains the cloud metadata endpoint. (`isPrivateOrLocalIp`, which allows both, is for
  `InternalNetworkGuard`, whose question is "did this come from inside".) The check is re-run before
  the pairing request, because that is the call that actually carries a credential outbound.
- With no explicit port, it tries the Hub API port then the dev port. It cannot know the published
  port: every compose file sets `API_PORT: 5002` in the container's own environment while publishing
  `${API_PORT:-5002}` on the host, so a Hub that moved its published port has to be named as
  `<address>:<port>`.

**Inbound pairing checks the tailnet suffix even with no OAuth credential.** `receivePairingRequest`
refuses a `fromNodeFqdn` that is not a name on this node's own tailnet, read from the local Tailscale
CLI. Previously the whole membership check was skipped whenever the Admin API was unconfigured —
which is exactly the credential-less configuration this feature creates. A Hub that has not joined a
tailnet at all still accepts pairing, since it has nothing to compare against.

## A claimed UUID is not an identity

There is exactly **one** node UUID per Hub, and it is the persisted one described under
[Peer identity](#peer-identity-pin-pairing-and-signed-requests) — minted into `hub_pool_identity`
alongside the Ed25519 keypair, reported to paired peers on the authenticated `/capabilities`
response, and stored by them as `hub_pool_peer.peer_node_uuid`. Discovery and trust deliberately do
not have separate answers to "who is this node": a second, differently-derived UUID would make
"renamed" and "different machine" indistinguishable again, which is the exact problem the column
exists to solve.

The rule that keeps that true is simply that **nothing unauthenticated ever supplies a UUID**.
`/identify` reports none, so there is no such thing as a "claimed" node UUID for the Hub to carry
around and be careful with — the type that used to exist for one was removed rather than left as a
field nothing could ever fill. Every value that reaches `peer_node_uuid` came from a route
`PoolPeerGuard` authenticated, or from a `pair/request` that carried a valid PIN.

The same asymmetry runs the other way: `peer_node_uuid` is only ever written together with the public
key that makes it verifiable. A UUID with no key beside it would be a lookup key the guard could
resolve and then refuse — a half-pinned row that reads as identity and is not.

## Endpoints an app sees through the proxy

Apps using `hub_integration.inference` get `CI_LLM_BASE_URL`, `OLLAMA_HOST` and `CI_OLLAMA_EMBED_HOST` pointed at the pool proxy, so it has to answer both protocols. An editor or SDK holding an `inference` key sees the same routes from outside the appliance (see [Use your Hub from your editor](editor-inference.md)):

| Routed across the pool (body carries `model`) | Served by this node only |
|---|---|
| `POST /v1/chat/completions`, `/v1/completions`, `/v1/embeddings` | `GET /v1/models` |
| `POST /api/generate`, `/api/chat`, `/api/embeddings`, `/api/embed` | `GET /api/tags`, `GET /api/ps`, `GET /api/version`, `POST /api/show` |

`POST /api/show` is served by this node's engines first. When none of them holds the model, it is asked of a connected peer that does, through that peer's `local/api/show` route — which is what lets an `auto` resolved to a peer-only model be described at all. A peer on a build without that route answers 404, and the caller gets the same 502 as before — so when rolling this out, upgrade the nodes that hold the pool's `auto` model before the nodes that do not, or an app on `auto` there (OpenClaw) cannot describe its model until they are. A peer that has not sent response headers within 15 s is skipped for the next one: the engine answers `/api/show` in under 0.3 s on every node measured, and the lookup would otherwise wait out the 300 s completion budget per stalled peer. On the asking Hub the lookup opens no routing-log row and adds nothing to the peer's queue depth.

`POST /api/pull` and the other model-management natives are deliberately absent — pulling a model is a node-local administrative action, not something the pool should silently perform on whichever machine answered.

## Known limitations (v1)

- `GET /v1/models` and `GET /api/tags` through the pool proxy list only this node's own local backends — they do not yet merge in what connected peers report. Chat/completion/embedding requests do use the full pool, including peers; only the *listing* endpoints are local-only for now.
- Peer health is polled on an interval (`poolHealthPollSeconds`, 30s by default) rather than pushed, so a peer that just went down may still be offered as a candidate until the next poll — the per-request failover is what actually protects a live request in that gap.
- The routing log holds the last 200 decisions (up to 10,000 with `HUB_POOL_ROUTING_LOG_SIZE`) in memory and is gone on restart; `summary.bootId` says when that happened. Per-request attribution no longer depends on it — the [`X-Hub-Pool-Served-By` response header](#operator-status-and-routing-log) names the serving node to the caller — but there is still no persisted history of *anything* else: no pairing lifecycle (rejected and expired rows are hard-deleted), no per-peer request totals, and no record of why a peer became unreachable beyond the current strike count.
- Time-to-headers is the only latency figure recorded. Token counts and tokens-per-second are not available: the response body is piped through untouched, and counting tokens would mean parsing the stream the proxy deliberately never reads.
- Queue depth is the only load signal **that is on by default**. The [GPU-pressure band](#gpu-pressure-a-second-load-signal-amd-only-and-off-by-default) covers the case queue depth cannot see — a GPU busy with work that never went through the pool — but it is AMD-only, needs a `/sys` mount this repo does not ship, and `poolPressureWeight` defaults to `0`. Until an operator turns both on, a peer whose card is saturated by ComfyUI still reports an empty queue. Reported hardware tier only breaks ties between equally queued peers; it does not deprioritize a slow GPU that happens to be idle.
- Queue depths are per-process and reset when a Hub restarts, so for the first moments after a restart every node looks idle to itself. The peer-side freshness rule covers the other direction (a peer that has gone quiet ranks as mid-load), but nothing corrects a node's view of its own load.
- A node's model inventory is what it has on **disk**, not what is resident in VRAM — Ollama's `/api/tags`, for one, lists every pulled model. A candidate that must cold-load the model therefore ranks alongside one already holding it warm; the local head start hedges this for the common follow-up-turn case, and [prefix affinity](#prefix-affinity) — off by default — covers the session that last ran on a peer, but neither reads residency. What the inventory no longer does is hide a model the node cannot load **at all**: see the note below.

## When a node lists a model it cannot actually serve

Cold-start is the mild version of this. The severe one was found on fleet node core-4, which answered `GET /api/tags` with 200 and `gemma3:1b` in the list while every `POST /api/generate` for that model returned HTTP 500 `model failed to load, this may be due to resource limitations or an internal error`. Selecting candidates on the inventory alone made that node a first-choice destination for a model it failed **every** request for, and the same claim went out to every peer as this node's advertised capabilities.

Nothing cheap distinguishes that node from a healthy one. The only proof a model can be served is serving it, and generating on each health poll would pull every listed model into VRAM on the poll cadence — so the evidence is taken from the requests that were going to run anyway:

- A local candidate that answers **5xx** is reported back to the engine that produced it. 408 and 429 are not: they are the engine talking about its queue, not about the model, and treating load shedding as incapacity would turn a busy minute into an outage. A peer's 5xx is not either — a peer corrects its own capabilities, and the relayed status says nothing about which of *its* backends failed.
- Two such observations within five minutes withhold that **one model on that one backend** from routing, first for 60s, doubling to a 15-minute ceiling if the model keeps failing when it is re-offered. Withholding is never permanent: the entry expires, the model is offered again, and the next request is the re-probe.
- A rejected explicit `loadModel` is decisive on its own — that request asks the engine to do nothing but load the model. A *connection* failure is not: that is the whole daemon being unreachable, which the health check already reports.
- Anything proving the model runs — a completed request, a successful load, or Ollama reporting it resident in `/api/ps` — clears the record and the backoff outright. `/api/ps` is read only while something is withheld, so an untroubled node's health poll is still a single request.

Only routing reads this. `modelsLoaded` keeps its meaning as the on-disk inventory, so the installed badge and the model puller still see a model that is present but currently unloadable — the same distinction, exposed to the pool as `unservableModels`.

## When a node runs the model and the Hub cannot see the engine

The other way a listed model earns a 502 is that the Hub never saw it listed. The Hub probes its engines **from inside its container**, at `VLLM_URL`, `LEMONADE_URL`, `SPECULATIVE_INFERENCE_URL`, `MTPLX_URL`, `DSPARK_URL` (defaults: `http://host.docker.internal:<port>`), and an engine the operator started on the host is only a candidate if that probe answers. On the September 2026 fleet it did not, on six of fifteen nodes, for two reasons that look identical from the outside:

- **A firewall that only knows Ollama.** ufw allowed the Docker bridge to reach `:11434` and nothing else, so vLLM on `:8000` timed out from the container and worked from everywhere else.
- **An engine published on the tailnet address only.** Lemonade and Lucebox containers published on `100.x.y.z:13305` and `:8216` refuse `host.docker.internal`; the fix is to point the env var at the tailnet address, which the Hub container can reach.

The 502 for that case used to read `No pool node currently has model "X" available.` — true of the pool's view, and wrong about where to look. It now carries the container's-eye view of every local backend: `localBackends` in the body lists each backend's probed URL, whether it answered, the error, and `probedMsAgo` — how old that answer was when the request read it, because placement can read a snapshot rather than a live probe (next section). An operator who has just fixed a firewall rule and still sees `running: false` with a `probedMsAgo` of 8000 is looking at the answer from before the fix; one with `probedMsAgo: 0` is not.

### Placement reads a snapshot, not a live probe

An unreachable engine used to cost more than a missing candidate. Every pooled request ran a live health check on all six local backends before it could rank, each with a 5 s transport timeout, and a firewall that **drops** the container's SYN rather than refusing it holds that probe for the full 5 s. On the September 2026 fleet four of fifteen nodes did exactly that, and every pooled request entering them measured a flat 5.0 s to first byte (5035–5200 ms) against 22–100 ms once the port answered — for engines that were never going to serve the request.

Placement can now rank from a per-backend health snapshot, refreshed stale-while-revalidate the way this node's own inventory already is for peers' health polls. It is **off by default** (`poolProbeSnapshotTtlMs: 0`), the same way `poolPressureWeight` is: a node that takes this image with its settings untouched probes live on every request exactly as before, so it is a valid control for the one node where the snapshot is switched on. Turn it on per node:

```bash
curl -X PATCH .../api/inference/pool/settings -d '{"poolProbeSnapshotTtlMs": 10000}'
```

With a TTL set, each backend's answer is in one of three states:

- **Fresh** (younger than `poolProbeSnapshotTtlMs`): served as is. A request costs no probe.
- **Stale** (past the TTL, within a further 60 s): served as is, and a refresh runs behind the caller. The request after that reads what it found.
- **Cold** (nothing cached, or older than that): the request starts the probe and waits for it — but only up to a placement budget of **500 ms**, shared across every cold backend in the read. A backend that has not answered by then is ranked `running: false` with an error saying so, and the probe keeps running in the background; when it lands, the next request reads the real answer. The next request never waits the budget again for the same engine — a dropped port costs one half-second read per TTL, not 5 s per request.

The snapshot changes **when** an engine's answer is read, never what an answered probe means: with every probe answering, the candidate list is the one live probes produced, in the same order. What it costs is lag on three events, each bounded by one TTL: an engine coming up is offered after the next refresh; an engine going down is offered until then (the per-request failover already covers a candidate that fails on contact); and a [serving quarantine](#when-a-node-lists-a-model-it-cannot-actually-serve) that the engine clears on its own — the `/api/ps` check inside its health poll, a direct `loadModel` — is seen one refresh late. A quarantine the proxy itself records is not late at all: the 5xx that withholds a model, and the success that releases one, drop that backend's snapshot on the spot, so the very next request re-probes it rather than offering a model the node just failed.

`poolProbeSnapshotTtlMs: 0` is the build before the snapshot existed, stall included. 10 s is the value to validate at: it sits under the 20 s this node's own inventory is cached for when it answers a peer's health poll, so a local candidate is never staler than the same node's advertisement to the rest of the pool. Raise it on a node whose engines rarely change and whose requests are frequent; there is little reason to go lower once it is on, since a request arriving inside the TTL pays nothing either way.

### Three backends on one port

`vllm`, `mtplx` and `lucebox` all default to host port 8000, and every OpenAI-compatible server answers `GET /v1/models`, so a health check built on that route cannot tell whose server it reached. A node serving vLLM there reported all three backends healthy with vLLM's model: three local candidates for one process (each failover hop re-hit the same engine), the model advertised three times to peers, and a status page claiming two engines the node has never run.

Each of the three names itself in `data[0].owned_by` of its own `/v1/models` body — `vllm`, `mtplx`, and `dflash` for Lucebox — so the backends now honour that claim: a server that names another engine is reported `running: true, healthy: false` with an error that says which env var points the backend at a server of its own. A server that does not name itself is left alone; absent evidence is not evidence of a foreign engine.
