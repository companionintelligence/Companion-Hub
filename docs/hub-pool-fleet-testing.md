# Hub Pool two-node fleet test

A step-by-step validation plan for [Hub Pool](hub-pool.md) on two real appliances. It exercises the
paths no unit test can reach: a genuine tailnet, two independent Postgres rows, two inference engines,
and real TLS between them.

Budget about 90 minutes. Nothing here is destructive beyond pairing state, and the
[teardown](#10-teardown) returns both nodes to where they started.

## Fill these in first

Every command below uses a placeholder. Substitute your own values before you run anything — this
document is published on the public tip, so it must never carry real lab names, MagicDNS suffixes, or
tailnet addresses.

| Placeholder | What it is | Example |
|---|---|---|
| `<core-node>` | MagicDNS name of the first appliance | `hub-a.example-tailnet.ts.net` |
| `<beta-node>` | MagicDNS name of the second appliance | `hub-b.example-tailnet.ts.net` |
| `<core-ip>` | Tailscale address of the first appliance | `100.64.0.1` |
| `<beta-ip>` | Tailscale address of the second appliance | `100.64.0.2` |
| `<api-port>` | `API_PORT` from that node's Hub env file | `5002` |
| `<model-both>` | A model pulled on **both** nodes | `llama3.2:3b` |
| `<model-beta>` | A model pulled on **`<beta-node>` only**| `qwen3:0.6b` |
| `<env>` | Hub environment name, if not the default | `dev` |

`<model-beta>` existing on exactly one node is what makes most of the interesting cases observable: it
is the only model whose routing decision has one correct answer.

## How to read a step

- **`core$`** means run it in a shell on `<core-node>`; **`beta$`** means `<beta-node>`. `cihub` always
  talks to `http://127.0.0.1:<api-port>` on the machine it runs on, so it can never manage the other
  node — the prompt is part of the instruction.
- Each step gives the CLI command first and the **Settings → Network → Hub Pool** path as the
  alternative. Either is a valid way to run the test.
- PASS/FAIL is stated per step. Record the result in the [table](#results) as you go.
- `cihub pool` needs the Portal device key, so each node must have completed `cihub register`.

Set this once per shell so the `curl` steps stay readable:

```bash
core$ HUB=http://127.0.0.1:<api-port>/api/inference/pool
```

---

## 1. Preflight

### 1.1 Both nodes are on the tailnet

```bash
core$ cihub pool status <env>
beta$ cihub pool status <env>
```

**Expected** — on each node, `Tailscale ✓ connected`, and `Node` shows that node's own MagicDNS name
and tailnet.

**PASS** both nodes report connected and their names differ.
**FAIL** either shows `✗ not connected`. Hub Pool has no networking of its own; fix Tailscale first
(see [`private-vpn.md`](private-vpn.md)) and restart this plan.

### 1.2 Each node can reach the other's Hub over TLS

```bash
core$ curl -s https://<beta-node>/api/inference/pool/identify
beta$ curl -s https://<core-node>/api/inference/pool/identify
```

**Expected** — `{"isCiHub":true,"poolProtocol":2}` in both directions. There is deliberately no name in
that answer: `/identify` is unauthenticated and published through the Cloudflare tunnel, so it
discloses no MagicDNS name, no node UUID, and no public key.

**PASS** both return `isCiHub: true`.
**FAIL** a TLS error means Tailscale HTTPS certificates are not provisioned on that node; a connection
refusal means its Hub is not serving. Every later handshake and health probe uses this exact URL shape,
so nothing downstream can pass until this does.

### 1.3 Whole-tailnet enumeration on at least one node

```bash
core$ cihub pool status <env>
```

**Expected** — `Discovery  Tailscale Admin API configured` on `<core-node>`.

This step pins the *credentialed* directory, which is the one this plan's 2.1 depends on. It is not
the only one: a tailnet-connected Hub also names the peers its own Tailscale daemon can see, and a
registered Hub also names the Hubs on its CI account. The `Discovery` line reports the credential
alone and says nothing about those two.

**PASS** at least one node reports the Admin API as configured. `<beta-node>` may report no
credential; that is supported, and step 1.4 confirms it still pairs.
**FAIL** neither node has it. Set `TAILSCALE_OAUTH_CLIENT_ID` and `TAILSCALE_OAUTH_CLIENT_SECRET`
(a Tailscale OAuth client with `devices:core:read`) on `<core-node>` and restart it.

### 1.4 Model inventory differs between the nodes

```bash
core$ curl -s $HUB/api/tags | grep -o '"name":"[^"]*"'
beta$ curl -s http://127.0.0.1:<api-port>/api/inference/pool/api/tags | grep -o '"name":"[^"]*"'
```

**Expected** — `<model-both>` appears on both nodes. `<model-beta>` appears on `<beta-node>` and **not**
on `<core-node>`.

**PASS** the two inventories differ exactly as described.
**FAIL** if `<model-beta>` is present on `<core-node>`, pull a different model on `<beta-node>` and
repoint the placeholder, or remove it from `<core-node>`. Do not continue with identical inventories —
sections 3 and 4 cannot distinguish a correct routing decision from a lucky one.

Model inventory is what a node has **on disk**, not what is resident in VRAM. A node listing a model may
still cold-load it on the first request, which shows up as latency, not as a routing error.

---

## 2. Pairing

### 2.1 Discovery lists the other node

**Precondition:** 1.1–1.3 pass, and the two nodes are not yet paired.

```bash
core$ cihub pool discover <env>
```

UI: **Settings → Network → Hub Pool → Discoverable devices**.

**Expected** — a table with a row for `<beta-node>`, its hostname, and a device ID.

`<beta-node>` can be named by any of three directories here — the local Tailscale daemon's peer map,
the Admin API credential from 1.3, or the CI Portal registry if both nodes are registered to the same
account — and it is listed once however many of them know it. The device ID column shows whichever
directory named it, so a Portal-sourced row carries a Portal device ID rather than a Tailscale one.

**PASS** `<beta-node>` is listed exactly once.
**FAIL** an empty table means the Hub on `<beta-node>` did not answer `/identify` (retry 1.2) or the two
are already paired (paired nodes are excluded — check `cihub pool peers`). A duplicate row is also a
failure: the merge folds on the normalized FQDN, so two rows for one node means the two directories
disagree about its name.

### 2.2 Initiate pairing from core

```bash
core$ cihub pool pair <beta-node> --name "beta appliance" <env>
```

UI: **Pair** next to the discovered device.

**Expected** — the command confirms the request was sent and says nothing is pooled until the other Hub
approves.

```bash
core$ cihub pool peers <env>
```

**Expected** — one row: `<beta-node>`, `DIR out`, `STATUS pending`.

**PASS** core holds exactly one outbound pending row.
**FAIL** a `409` means a row for that FQDN already exists — `cihub pool unpair <beta-node>` on core and
retry. A rejection at this stage deletes core's row rather than leaving it pending; a pending row that
survives an error is a defect worth reporting.

### 2.3 Approve on beta

```bash
beta$ cihub pool peers <env>
```

**Expected** — one row: `<core-node>`, `DIR in`, `STATUS pending`, plus the hint naming
`cihub pool approve`.

```bash
beta$ cihub pool approve <core-node> <env>
```

UI: **Approve** on the pending inbound request.

**PASS** the command reports the peer as connected.
**FAIL** `404 No pending inbound pairing request with that id` means the request never arrived — recheck
1.2 in the core → beta direction.

### 2.4 Both sides report connected, each holding its half

```bash
core$ cihub pool status <env>
beta$ cihub pool status <env>
```

**Expected** — on both nodes:

- `Pooling  ✓ active — apps on this Hub are routed through the pool`
- `Peers  1 total · 1 connected · 0 pending · 0 unreachable`
- the peer row shows a `LAST SEEN` timestamp within the last poll interval, and an `ENGINES` column
  listing at least `ollama ✓ <n>`

**PASS** both nodes show `connected` **and** a populated `ENGINES` column. Engines are the observable
proof that both halves of the handshake work: core can only fill that column by calling
`GET /capabilities` on beta with the token beta issued, and beta only fills its own by doing the reverse
with core's token. One side connected with an empty engines list means one direction of the handshake
failed.
**FAIL** either side shows `pending`. If core is still `pending` while beta says `connected`, beta's
confirm callback did not land — beta logs `pairing confirmed locally but callback to … failed`. Unpair on
beta and repeat from 2.2.

Wait one poll interval (30 seconds by default) and re-run if `LAST SEEN` is still `-`.

### 2.5 The reject path

**Precondition:** unpair first, so there is no existing row.

```bash
core$ cihub pool unpair <beta-node> <env>
core$ cihub pool pair <beta-node> <env>
beta$ cihub pool reject <core-node> <env>
```

**Expected** — beta deletes its inbound pending row, and the authenticated reject callback deletes
core's outbound pending row.

```bash
core$ cihub pool peers <env>
beta$ cihub pool peers <env>
```

**PASS** both nodes report `No paired peers`.
**FAIL** core still shows a pending row after ~10 seconds. The reject callback is best-effort, so this is
survivable — `cihub pool unpair` clears it — but record it: it means the authenticated callback to core
failed and the operator is left with a row that will never resolve itself.

### 2.6 Re-pair after an unpair

```bash
core$ cihub pool pair <beta-node> <env>
beta$ cihub pool approve <core-node> <env>
core$ cihub pool status <env>
```

**Expected** — connected again, with fresh tokens.

**PASS** both sides return to `connected`.
**FAIL** `409 Already paired or pairing` on core means the earlier reject left a row behind; unpair and
retry. A pairing that cannot be re-established after an unpair makes the reject path a trap, so record
this one carefully.

Leave the pair **connected** for the rest of the plan.

### 2.7 The bearer → signed upgrade, on the pairing you already have

**Precondition:** section 2.6 left the pair `connected`. Both nodes are running this build.

The upgrade rides the health poll, so it needs at most three poll intervals (~90s at the default
cadence) to settle on both sides.

```bash
core$ cihub pool status <env> | grep -i 'auth\|fingerprint'
beta$ cihub pool status <env> | grep -i 'auth\|fingerprint'
```

**Expected** — every peer row reports `authMode: signed` with a key fingerprint, on both nodes.

**PASS** both sides show `signed`, and routing (section 3) still works unchanged.
**FAIL** either side still shows `bearer` after three polls. Record which side, and whether its peer row
has `bearer_grace_until` set — a row whose grace window closes with no signed request observed is
*rolled back* to bearer on purpose and retried, so a node that oscillates between the two is the
symptom to report, not a node that simply has not converged yet.

Then confirm the old credential is actually gone:

```bash
core$ docker exec ci-hub-db psql -U <user> -d <db> -c \
  "select node_fqdn, peer_node_uuid is not null as pinned, verify_token_hash is null as verify_cleared, present_token_encrypted is null as present_cleared, signed_seen_at is not null as seen_signing from hub_pool_peer;"
```

**PASS** `pinned`, `verify_cleared`, `present_cleared` and `seen_signing` are all `t`.
**FAIL** a row that is `pinned` and `seen_signing` but still holds a token. That is a dormant secret the
sweep should have cleared on the tick after the first signed request; report it with the row.

### 2.8 PIN pairing end to end

**Precondition:** unpair first, so there is no existing row.

```bash
core$ cihub pool unpair <beta-node> <env>
```

On **beta**, open Settings → Network → Hub Pool → **Pairing PIN** and press **Generate PIN**. Note the
six digits and beta's own key fingerprint shown above it.

On **core**, type that PIN into the PIN field next to the address and pair.

**Expected** — beta shows a *pending* inbound request (not a connected peer), carrying core's FQDN and
core's key fingerprint. Core's Hub Pool card shows beta's fingerprint on its outbound pending row.

**PASS** the fingerprint beta renders for core matches the one core's own card reports for itself, and
vice versa. Approve on beta; both sides go `connected` with `authMode: signed` immediately — no
upgrade poll needed.
**FAIL** the row lands `connected` without an approval. A PIN authenticates the *request*; it must never
stand in for the operator seeing who is asking.

### 2.9 A wrong PIN creates nothing, and says nothing

**Precondition:** unpair first. Generate a fresh PIN on beta but do **not** use it.

```bash
core$ cihub pool pair <beta-node> <env>   # then enter 000000, or any wrong six digits, in the UI
beta$ cihub pool peers <env>
```

**Expected** — core's pairing call fails with `401 Invalid or expired pairing PIN`, and beta has **no**
row at all.

**PASS** `beta` reports `No paired peers`, and repeating the wrong guess four more times produces the
same 401 each time, then a `429` on the sixth from the same source.
**FAIL** a pending row appears on beta, or the error text differs between a wrong PIN, an expired one and
none outstanding. Any difference there is an oracle: it makes the six-digit space searchable in two
steps instead of one. Record the exact strings.

Now confirm the PIN itself is single use: generate a new PIN, pair successfully, unpair, and try to
pair again with the *same* digits.

**PASS** the second attempt is refused.
**FAIL** it succeeds. A PIN read aloud or seen in a support screenshot must not pair a second node.

### 2.10 A renamed node keeps routing

**Precondition:** the pair is `connected` and both sides report `authMode: signed` (2.7 or 2.8).

Rename **beta** in the Tailscale admin console, then wait for MagicDNS to propagate and for beta's Hub
to pick up its new name (restart beta's Hub if impatient).

```bash
beta$ cihub pool status <env>
core$ cihub pool peers <env>
```

**Expected** — beta's next signed call to core carries the new name; core follows the identity and
rewrites `node_fqdn` on its own health tick.

**PASS** core lists beta under the new FQDN and routing (section 3) still works.
**FAIL** core keeps the old name and its probes fail. On a bearer-only pairing this was permanent and
Unpair was the only recovery — which is the defect the pinned UUID exists to fix, so this one is worth
recording carefully either way.

### 2.11 Identity rotation unpairs, and says who it could not tell

**Precondition:** the pair is `connected`. Run this LAST in section 2 — it is destructive.

Call `POST /api/inference/pool/identity/rotate` on core (session auth).

**Expected** — the response names beta under `unpaired`, and both nodes end with no peer rows.

**PASS** `unpaired: ["<beta-node>"]`, `unreachable: []`, and `cihub pool peers` is empty on both sides.
**FAIL** beta still holds a row for core. The unpair calls go out *before* the old key is destroyed
precisely so this cannot happen; if it does, note whether beta was reachable at the time — a peer that
was down is expected to appear under `unreachable` and to need clearing by hand.

Re-pair (2.6 or 2.8) before continuing.


---

## 3. Routing

Peer capabilities are cached from the last health poll, so after pulling or deleting a model, wait one
poll interval before asserting on routing.

### 3.1 A model only beta has, requested on core

**Precondition:** 2.6 connected; `<model-beta>` on beta only (1.4).

```bash
core$ curl -si $HUB/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"<model-beta>","messages":[{"role":"user","content":"reply with the word ok"}],"stream":false}'
```

**Expected** — a normal OpenAI-shaped completion, not a 502, with these response headers above it:

```
X-Hub-Pool-Served-By: <beta-node>
X-Hub-Pool-Backend: ollama
X-Hub-Pool-Model: <model-beta>
```

```bash
core$ cihub pool log --limit 5 <env>
```

**Expected** — the newest row has `DIR out`, `MODEL <model-beta>`, `NODE <beta-node>`, `ATT 1/1`,
`✓ served 200`.

```bash
beta$ cihub pool log --limit 5 <env>
```

**Expected** — a matching row with `DIR in` and `NODE <core-node>`.

**PASS** `X-Hub-Pool-Served-By` on the response names `<beta-node>`, the routing log on core agrees,
**and** beta records the matching inbound row. The header is the per-request answer and the one an
app can read; the log is the operator's history of it. The response body alone is not evidence — the
same model on either node produces the same shape.
**FAIL** `X-Hub-Pool-Served-By: local` (and `NODE local` in the log) means core somehow has the model —
recheck 1.4. No `X-Hub-Pool-*` headers at all means core is on a build that predates them. A 502
(`No pool node currently has model …`) means beta's cached capabilities do not list it: check
`cihub pool peers` on core for `<model-beta>` under "Models on each peer", and wait a poll interval.

### 3.2 A model both nodes have, with both idle

```bash
core$ curl -si $HUB/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"<model-both>","messages":[{"role":"user","content":"reply with the word ok"}],"stream":false}'
core$ cihub pool log --limit 5 <env>
```

**Expected** — `X-Hub-Pool-Served-By: local` on the response, and `NODE local`, `ATT 1/2` in the log
(two candidates were ranked; the local one won). The header says `local`, not core's own MagicDNS
name, by design.

**PASS** `X-Hub-Pool-Served-By: local` and `NODE local` with `ATT 1/2`. `ATT 1/2` is the meaningful
half: it proves beta *was* a candidate and lost on rank rather than being invisible.
**FAIL** `ATT 1/1` means beta was never a candidate — its cached capabilities are missing or stale
(`cihub pool peers` on core). `NODE <beta-node>` on an idle core means the affinity handicap is not being
applied.

### 3.3 Local affinity does what the setting says

```bash
core$ cihub pool status <env>            # note Settings poolLocalAffinity=1
```

Hold one request open so core's queue depth is 1, then send a second:

```bash
core$ curl -sN $HUB/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"<model-both>","messages":[{"role":"user","content":"write 400 words about tides"}],"stream":true}' > /dev/null &
core$ sleep 1
core$ curl -s $HUB/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"<model-both>","messages":[{"role":"user","content":"reply with the word ok"}],"stream":false}'
core$ cihub pool log --limit 5 <env>
```

**Expected** — the second request is still served locally: one queued request is exactly the head start
`poolLocalAffinity=1` grants, so it ties, and local wins the tie.

**PASS** `NODE local` for the second request.
**FAIL** `NODE <beta-node>` at a queue depth of 1 means the handicap is off by one — the setting says work
should stay local until a peer is *more* than one request emptier.

Wait for the background stream to finish before continuing.

---

## 4. Load handoff

This is the capability the whole feature exists for: a saturated node handing work to an idle peer.

### 4.1 Deterministic handoff

**Precondition:** both nodes connected and idle (`In flight 0 request(s) now` on both);
`poolLocalAffinity=1`; `<model-both>` on both.

Hold **two** streamed requests open on core, then send a third:

```bash
core$ for i in 1 2; do
        curl -sN $HUB/v1/chat/completions \
          -H 'Content-Type: application/json' \
          -d '{"model":"<model-both>","messages":[{"role":"user","content":"write 800 words about tides"}],"stream":true}' > /dev/null &
      done
core$ sleep 2
core$ cihub pool status <env>            # expect: In flight 2 request(s) now
core$ curl -s $HUB/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"<model-both>","messages":[{"role":"user","content":"reply with the word ok"}],"stream":false}'
core$ cihub pool log --limit 5 <env>
```

**Expected** — core ranks itself at queue depth 2 and beta at 0 + 1 affinity = 1, so beta wins.

**PASS**, precisely: `cihub pool status` on core showed `In flight 2` before the third request, and the
newest `DIR out` entry in core's log names `NODE <beta-node>` with `ATT 1/2` and `✓ served`, and beta's
own log carries the matching `DIR in` row from `<core-node>`.
**FAIL** the third request shows `NODE local`. That is the headline defect: a saturated node queueing
behind itself while a paired peer sits idle. Before filing it, confirm from `cihub pool status` that core
really read `In flight 2` — two requests that finished early make the test vacuous — and that beta's
`QUEUE` column reads `0` or `-`.

Wait for the two background streams to end.

### 4.2 Burst

```bash
core$ for i in $(seq 1 6); do
        curl -sN $HUB/v1/chat/completions \
          -H 'Content-Type: application/json' \
          -d '{"model":"<model-both>","messages":[{"role":"user","content":"write 400 words about tides"}],"stream":true}' > /dev/null &
      done
core$ wait
core$ cihub pool log --limit 12 <env>
```

**Expected** — the first one or two land locally, then work starts alternating as each forward raises
beta's counted depth and each completion lowers core's.

**PASS** at least two of the six show `NODE <beta-node>`, and at least one shows `NODE local`. A split is
what the ranking should produce; all-six-on-one-node in either direction is the failure.
**FAIL** all six local (no handoff under load) or all six remote (the affinity handicap is not applied).

---

## 5. Failover

### 5.1 Beta's engine dies mid-pool

**Precondition:** connected pair; `<model-both>` on both.

```bash
beta$ docker stop <beta ollama container>
core$ curl -s $HUB/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"<model-both>","messages":[{"role":"user","content":"reply with the word ok"}],"stream":false}'
core$ cihub pool log --limit 5 <env>
```

**Expected** — the request succeeds. Beta is still `connected` (its Hub answers health probes; only its
engine is down), so it may be ranked first and then fail; the log records **one** entry with
`↳ failed over from <beta-node>` rather than two entries.

**PASS** HTTP 200, and either `NODE local ATT 1/2` (beta ranked second and was never tried) or
`NODE local ATT 2/2` with the `↳ failed over from` line.
**FAIL** a 502 reaching the client. A dead engine on one node must never fail a request the other node
could serve.

### 5.2 Core's engine dies

```bash
beta$ docker start <beta ollama container>
core$ docker stop <core ollama container>
core$ curl -s $HUB/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"<model-both>","messages":[{"role":"user","content":"reply with the word ok"}],"stream":false}'
core$ cihub pool log --limit 5 <env>
```

**Expected** — served by `<beta-node>`. With core's engine down, core contributes no local candidate at
all, so this is usually `ATT 1/1` rather than a failover.

**PASS** HTTP 200 with `NODE <beta-node>`, and beta's log shows the matching `DIR in` row.
**FAIL** a 502. Restart core's engine before continuing either way.

### 5.3 A mid-stream failure does not corrupt the response

**Precondition:** core's engine running again; both nodes connected.

Start a long streamed generation on core, and kill the engine that is serving it while tokens are
flowing:

```bash
core$ curl -sN $HUB/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"<model-both>","messages":[{"role":"user","content":"write 2000 words about tides"}],"stream":true}' | tee /tmp/pool-stream.txt
# in a second shell, once tokens are visible:
core$ docker stop <core ollama container>
```

**Expected** — the stream ends early. `curl` reports a transfer error, and `/tmp/pool-stream.txt` holds a
truncated but well-formed prefix of SSE frames.

**PASS** the captured output contains **one** response: no second `data:` stream restarting from the
beginning, no duplicated `role":"assistant"` opening frame, and no HTTP status line embedded in the body.
Once status and headers are on the wire, the proxy must let the stream die rather than restart the answer
on another node.
**FAIL** the file contains two overlapping generations, or the tail of the file is a JSON error object
appended after generated tokens. That is the commit-boundary bug: the client cannot tell where one answer
ends and the next begins.

Restart core's engine.

---

## 6. Recovery

### 6.1 Beta leaves the tailnet

**Precondition:** connected pair, both healthy.

```bash
beta$ tailscale down
```

Watch core for three poll intervals (about 90 seconds at the default cadence):

```bash
core$ cihub pool peers <env>       # after ~30s:  connected 1/3
                                   # after ~60s:  connected 2/3
                                   # after ~90s:  unreachable
```

**Expected** — the strike counter climbs, then the status flips to `unreachable`. Requests for
`<model-beta>` now 502 on core (nothing else has it); requests for `<model-both>` are served locally.

**PASS** beta reaches `unreachable` after three failed polls and stops being offered as a candidate —
`cihub pool log` shows `ATT 1/1` for `<model-both>`, meaning beta is no longer even ranked.
**FAIL** beta stays `connected` past three polls, or flips to `unreachable` on the first failure.

### 6.2 Beta comes back on its own

```bash
beta$ tailscale up
core$ cihub pool peers <env>       # within one poll interval
```

**Expected** — `unreachable` returns to `connected`, `LAST SEEN` refreshes, and the strike counter
resets to 0.

**PASS** core recovers the peer within one poll interval **with no operator action**, and a
`<model-beta>` request routes to beta again.
**FAIL** the peer stays `unreachable`. Unreachable rows must keep being polled; if unpairing is the only
way back, recovery is broken. Record it before working around it.

---

## 7. Kill switch

### 7.1 Disable pooling on beta from its .env

```bash
beta$ echo 'HUB_POOL_USER_DISABLED=true' >> <beta hub env file>
beta$ cihub restart <env>
beta$ cihub pool status <env>
```

**Expected on beta** — `Pooling  ✗ disabled — HUB_POOL_USER_DISABLED=true in this Hub's .env`.

**Expected on core**, within three poll intervals — beta becomes `unreachable`, because a disabled node
refuses capability probes outright instead of answering "I have nothing".

```bash
core$ cihub pool peers <env>
core$ curl -s $HUB/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"<model-beta>","messages":[{"role":"user","content":"hi"}],"stream":false}'
```

**PASS** beta reads `unreachable` on core, the `<model-beta>` request 502s with
`No pool node currently has model`, and the pairing row still exists on both sides.
**FAIL** core keeps routing to beta, or the pairing is deleted. A kill switch that discards pairing state
turns a temporary opt-out into a re-pair.

### 7.2 Confirm the env flag beats the setting

```bash
beta$ cihub pool enable <env>
```

**Expected** — the command saves the setting and then states plainly that nothing changed in effect,
naming the env file to edit and the restart needed.

**PASS** the output does not claim success it did not deliver.
**FAIL** it reports pooling as enabled while `HUB_POOL_USER_DISABLED=true` is still in force.

### 7.3 Remove it and recover

```bash
beta$ # delete the HUB_POOL_USER_DISABLED line from <beta hub env file>
beta$ cihub restart <env>
core$ cihub pool peers <env>       # within one poll interval
```

**PASS** beta returns to `connected` on its own, and a `<model-beta>` request routes there again.
**FAIL** recovery needs an unpair/re-pair.

### 7.4 Inbound only: beta stops serving but keeps using core

The asymmetry the directional switches exist for. Unlike the master switch, beta must stay **healthy**
on core's status card throughout — this is "not right now", not "I have left the pool".

```bash
beta$ cihub pool disable --inbound <env> --yes
core$ cihub pool status <env>       # within one poll interval
core$ curl -s http://localhost:<core hub port>/api/inference/pool/api/chat \
        -d '{"model":"<model-beta>","messages":[{"role":"user","content":"hi"}],"stream":false}'
beta$ cihub pool status <env>
```

**PASS** core still shows beta `connected` with `consecutiveFailures 0` and lists it under "Not accepting
work from this node"; the `<model-beta>` request fails on core with the 502 (no node has it) rather than
being sent to beta; beta's own status still shows core serving, and beta can still route its work to core.
**FAIL** core marks beta `unreachable`, or beta stops using core as well.

```bash
beta$ cihub pool enable --inbound <env> --yes
core$ cihub pool status <env>       # within one poll interval
```

**PASS** routing to beta resumes on the next poll with no re-approval.

### 7.5 Outbound only: core stops sending but keeps serving

```bash
core$ cihub pool disable --outbound <env> --yes
core$ curl -s http://localhost:<core hub port>/api/inference/pool/api/chat \
        -d '{"model":"<model-beta>","messages":[{"role":"user","content":"hi"}],"stream":false}'
beta$ cihub pool status <env>
```

**PASS** core answers 502 for the beta-only model instead of forwarding it, while beta's status still
shows core `connected` and serving; work beta sends to core is still served.
**FAIL** core still forwards, or beta sees core as unreachable / not accepting work.

Re-enable with `cihub pool enable --outbound <env> --yes`.

### 7.6 Per-peer: take one node out of the pool without unpairing

```bash
core$ cihub pool peers <env>                          # note beta's id prefix
core$ cihub pool peer-disable <id> <env> --yes
core$ cihub pool peers <env>
```

**PASS** beta prints as `connected/off`, core keeps polling it successfully, no work moves in either
direction, and both directional tokens survive — `cihub pool peer-enable <id>` restores routing with no
approval on beta.
**FAIL** the pairing is gone, beta goes `unreachable`, or re-enabling needs a re-pair.

---

## 8. Native API coverage

Every endpoint an app actually reaches through `CI_LLM_BASE_URL` / `OLLAMA_HOST`. The Ollama natives
matter as much as the OpenAI ones: their absence from the proxy was a live regression, and an app pointed
at `OLLAMA_HOST` gets a 404 rather than a fallback.

**Precondition:** connected pair; `<model-beta>` on beta only, so each row's expected node is unambiguous.

| # | Command on core | Expected |
|---|---|---|
| 8.1 | `curl -s $HUB/api/chat -d '{"model":"<model-beta>","messages":[{"role":"user","content":"hi"}],"stream":false}'` | 200; log row `NODE <beta-node>` |
| 8.2 | `curl -sN $HUB/api/chat -d '{"model":"<model-beta>","messages":[{"role":"user","content":"count to twenty"}],"stream":true}'` | NDJSON frames, last one `"done":true`; one log row |
| 8.3 | `curl -s $HUB/api/generate -d '{"model":"<model-beta>","prompt":"hi","stream":false}'` | 200; `NODE <beta-node>` |
| 8.4 | `curl -s $HUB/api/embed -d '{"model":"<model-both>","input":"hello"}'` | 200 with an `embeddings` array |
| 8.5 | `curl -s $HUB/api/embeddings -d '{"model":"<model-both>","prompt":"hello"}'` | 200 with an `embedding` array |
| 8.6 | `curl -s $HUB/v1/chat/completions -d '{"model":"<model-beta>","messages":[{"role":"user","content":"hi"}],"stream":false}'` | 200; `NODE <beta-node>` |
| 8.7 | `curl -sN $HUB/v1/chat/completions -d '{"model":"<model-beta>","messages":[{"role":"user","content":"count to twenty"}],"stream":true}'` | SSE frames ending `data: [DONE]` |
| 8.8 | `curl -s $HUB/v1/embeddings -d '{"model":"<model-both>","input":"hello"}'` | 200 with a `data[0].embedding` array |
| 8.9 | `curl -s $HUB/api/tags` | 200; **core's own** models only |
| 8.10 | `curl -s $HUB/v1/models` | 200; core's own models only |
| 8.11 | `curl -s $HUB/api/version` and `curl -s $HUB/api/ps` | 200 from core's engine |
| 8.12 | `curl -s $HUB/api/show -d '{"model":"<model-both>"}'` | 200 from core's engine |
| 8.13 | `curl -s $HUB/v1/chat/completions -d '{"messages":[]}'` | **400** `Request body must include a "model" field` |

Add `-H 'Content-Type: application/json'` to every POST above.

**PASS** 8.1–8.8 return 200 and the log names `<beta-node>` wherever `<model-beta>` was requested;
8.9–8.12 return 200; 8.13 returns 400.
**FAIL** any 404 from the proxy — that endpoint is missing from the app-facing surface and every app using
it breaks the moment a peer connects. 8.9 and 8.10 listing beta's models is *not* a failure: cross-node
merging of the listing endpoints is a known v1 limitation, recorded in
[`hub-pool.md`](hub-pool.md#known-limitations-v1).

---

## 9. Security spot-checks

Neither needs an attacker, only a second shell.

### 9.1 The app-facing proxy refuses tunnel-marked traffic

```bash
core$ curl -s -o /dev/null -w '%{http_code}\n' $HUB/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'cf-ray: 0000000000000000-TEST' \
  -d '{"model":"<model-both>","messages":[{"role":"user","content":"hi"}],"stream":false}'
core$ curl -s -o /dev/null -w '%{http_code}\n' $HUB/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'X-Forwarded-For: 203.0.113.10, 172.18.0.2' \
  -d '{"model":"<model-both>","messages":[{"role":"user","content":"hi"}],"stream":false}'
```

**Expected** — `403` for both. The same request without those headers returns 200 (that is step 3.2).

**PASS** both print `403`, and no new row appears in `cihub pool log`.
**FAIL** either returns 200. These routes spend GPU time on every paired node, so anything carrying
reverse-proxy provenance must be refused whatever the source IP says.

### 9.2 An unpaired tailnet device cannot call a peer-facing route

Run from any tailnet device that is **not** paired with `<core-node>` — your laptop is fine:

```bash
$ curl -s -o /dev/null -w '%{http_code}\n' https://<core-node>/api/inference/pool/capabilities
$ curl -s -o /dev/null -w '%{http_code}\n' https://<core-node>/api/inference/pool/capabilities \
  -H 'X-Hub-Pool-Peer: <beta-node>' -H 'Authorization: Bearer not-the-real-token'
$ curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<core-node>/api/inference/pool/local/api/chat \
  -H 'Content-Type: application/json' -H 'X-Hub-Pool-Backend: ollama' \
  -H 'X-Hub-Pool-Peer: <beta-node>' -H 'Authorization: Bearer not-the-real-token' \
  -d '{"model":"<model-both>","messages":[{"role":"user","content":"hi"}]}'
```

**Expected** — `401` for all three. The second is the important one: naming a *genuinely paired* peer
without holding its token must still fail.

**PASS** all three print `401`, and core's routing log gains no `DIR in` row.
**FAIL** anything other than 401. Being on the tailnet must not by itself grant use of a peer-facing
route; only a device this Hub has explicitly paired with can.

---

## 10. Teardown

```bash
core$ cihub pool unpair <beta-node> <env>
beta$ cihub pool peers <env>        # expect: No paired peers
```

Then, on each node as applicable:

- Remove `HUB_POOL_USER_DISABLED` from the env file if 7.3 was skipped, and restart.
- Restore `poolLocalAffinity` and `poolHealthPollSeconds` if you changed them.
- `cihub pool enable <env>` if you disabled pooling through the setting.
- Restart any engine container you stopped in section 5.
- Delete `<model-beta>` if you pulled it only for this run.

```bash
core$ cihub pool status <env>       # expect: enabled, 0 peers, Tailscale connected
beta$ cihub pool status <env>
```

Both nodes should read `enabled, not routing — no connected peers`. That is the pre-test state: a
single-node Hub with zero peers behaves exactly as it did before Hub Pool existed.

The routing log is in-memory and process-local, so it clears on the next restart. Nothing else from this
run persists.

---

## Results

Date: ________  ·  Hub version core: ________  ·  beta: ________  ·  Tester: ________

| # | Check | Result | Notes |
|---|---|---|---|
| 1.1 | Both nodes on the tailnet | ☐ pass ☐ fail | |
| 1.2 | TLS reachable in both directions | ☐ pass ☐ fail | |
| 1.3 | Whole-tailnet enumeration on one node | ☐ pass ☐ fail | |
| 1.4 | Inventories differ as required | ☐ pass ☐ fail | |
| 2.1 | Discovery lists the other node exactly once | ☐ pass ☐ fail | |
| 2.2 | Pairing initiated from core | ☐ pass ☐ fail | |
| 2.3 | Approved on beta | ☐ pass ☐ fail | |
| 2.4 | Both connected, engines populated | ☐ pass ☐ fail | |
| 2.5 | Reject clears both sides | ☐ pass ☐ fail | |
| 2.6 | Re-pair after unpair | ☐ pass ☐ fail | |
| 3.1 | Beta-only model served by beta | ☐ pass ☐ fail | |
| 3.2 | Shared model stays local when idle | ☐ pass ☐ fail | |
| 3.3 | Affinity holds at depth 1 | ☐ pass ☐ fail | |
| 4.1 | Deterministic handoff at depth 2 | ☐ pass ☐ fail | |
| 4.2 | Burst splits across both nodes | ☐ pass ☐ fail | |
| 5.1 | Beta engine down, core serves | ☐ pass ☐ fail | |
| 5.2 | Core engine down, beta serves | ☐ pass ☐ fail | |
| 5.3 | Mid-stream failure is not corrupted | ☐ pass ☐ fail | |
| 6.1 | Three strikes to unreachable | ☐ pass ☐ fail | |
| 6.2 | Self-recovery within one poll | ☐ pass ☐ fail | |
| 7.1 | Kill switch stops routing | ☐ pass ☐ fail | |
| 7.2 | Env flag beats the setting | ☐ pass ☐ fail | |
| 7.3 | Recovery after removing the flag | ☐ pass ☐ fail | |
| 8.1–8.8 | Routed endpoints, streaming and not | ☐ pass ☐ fail | |
| 8.9–8.13 | Local-only endpoints and the 400 | ☐ pass ☐ fail | |
| 9.1 | Tunnel headers refused | ☐ pass ☐ fail | |
| 9.2 | Unpaired device refused | ☐ pass ☐ fail | |
| 10 | Teardown clean | ☐ pass ☐ fail | |

---

## Troubleshooting

**Pairing sticks at `pending` on core while beta says `connected` (2.4).** Beta's confirm callback did
not reach core. Beta approved regardless — that is deliberate, since beta *did* approve and rolling its
own row back would be wrong. Unpair on beta, then repeat from 2.2. Check core's TLS certificate first:
1.2 in the beta → core direction is exactly the call that failed.

**`ENGINES` stays empty on a `connected` peer (2.4).** Capabilities are only cached by a successful
health probe. An empty column with a fresh `LAST SEEN` means the peer answered but reports no healthy
backend; an empty column with `LAST SEEN -` means no probe has ever succeeded. Check the peer's own
`cihub pool status` for a `✗` line under `Engines`.

**502 `No pool node currently has model` for a model you can see on the peer (3.1).** Peer model lists
come from the cached snapshot, not a live query. Wait one `poolHealthPollSeconds` after pulling a model,
then check `cihub pool peers` on core for the model under "Models on each peer".

**Everything routes locally, never to the peer (4.1).** Three causes, in order of likelihood: core's
in-flight count was lower than you thought (check `cihub pool status` at the moment of the request);
`poolLocalAffinity` is higher than 1; or the peer's snapshot is stale, in which case its self-reported
queue depth is discarded and it ranks as mid-load rather than idle. A snapshot older than three polls is
always treated as unmeasured — never as idle.

**Everything routes to the peer, even from an idle core (3.2).** Check that `<model-both>` really is in
core's own inventory (1.4): a node without the model contributes no local candidate at all, and the
affinity handicap has nothing to apply to.

**A peer flips between `connected` and `unreachable`.** Probes time out after 8 seconds. A node whose
engines are slow enough to delay the whole Hub API past that will strike out, recover, and strike out
again. Raise `poolHealthPollSeconds` and watch whether the strike counter still climbs.

**`cihub pool` returns 401 or reports no device key.** These routes use the Portal device key from
`state/settings.json`, not an MCP key from `cihub api-key create`. Run `cihub register` on that node.

**`cihub pool approve` on the wrong machine (2.3).** `cihub` only ever talks to the Hub it runs on.
Approval happens on the node that *received* the request, which is never the node you paired from.

**Routing log is empty after a restart.** Expected. It holds the last 200 decisions in memory, is
process-local, and does not survive a restart. An empty log means "nothing routed since this Hub
started", not "nothing ever routed".
