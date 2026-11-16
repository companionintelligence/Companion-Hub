# Private VPN app probe: ask Serve's target when the Hub is refused

## Meta

| Field | Value |
| ----- | ----- |
| Slug  | `private-vpn-app-probe` |
| Date  | 2026-11-16 |
| Agent | Claude |
| Model | Sonnet 5.5 |
| Task  | The Hub's availability probe reports every Private VPN app on beta-max as "App not responding" (`CONNECTION_REFUSED`) although the apps answer over the tailnet. Fix the probe, keep the genuine `TAILSCALE_NOT_READY`, `TAILSCALE_SERVE_REFUSED` and not-published verdicts, keep the repair in `resolveAppAvailability` consistent with the verdict, add tests, and open a PR for the Hub owners. Stay read-only on beta-max. |

## Goal

Stop `AppsService.checkAppAvailability` from reporting a published, running Private VPN app as refused when the only thing wrong is that the Hub cannot reach the Serve listener from inside its Docker network.

## Steps taken

1. Read `AGENTS.md`, `CLAUDE.md`, `docs/writing-style.md`, `docs/agent/CODING_CONVENTIONS.md` and `docs/agent/AGENT_WORKFLOW.md`.
2. Read the probe and its neighbors: `probeAppAvailability` and `resolveAppAvailability` (`apps.service.ts`), `isRefusedByTailscale`, `TailscaleService.getServeStatus` and `serveApp`, `ExposureSyncService.triggerTailscaleSync` (how a Serve target is written), `getAppNetworkTarget` (where a target comes from), the runtime monitor's `probeAppRoute` (who else reads the verdict), `app-port-probe.ts`, and the frontend's error-code to message map.
3. Confirmed the cause read-only on beta-max, inside `ci-hub`, with scripts piped to `docker exec -i ci-hub node -` (nothing written on the node): `ss -ltn` shows the listeners bound as `100.x.y.z%tailscale0:<port>`; a dial of the tailnet address and of the node's name is refused on every app port; `/usr/bin/tailscale serve status --json` works from the container and lists each port's target; a `GET /` on each target answers (307, 401, 200). ci-hermes listens on `:18790` and forwards to `:18789`.
4. Reused `probeAppPort` (the runtime monitor's helper: answered, refused, silent or unreachable, never throws, plain HTTP, no redirects) for the target, and added `wasRefused`, `parseServedTarget` and `servedAppAnswers` to `apps.service.ts`. The probe's catch block asks them for a Private VPN app that was refused, and only an answer changes its verdict.
5. Added 40 tests to `apps.service.availability.test.ts` and 4 to `apps.service.test.ts`, and checked that the ones asserting the fix fail on the original file (swapped in from `HEAD`, then restored): 13 and 1.
6. Ran the branch's own `probeAppPort` and URL parsing, bundled with esbuild and piped to `ci-hub` on beta-max, against the live Serve table: three apps answered, a port with no entry changed nothing, a closed port gave "refused", an unused address gave "unreachable".
7. Wrote the docs: one paragraph and one troubleshooting row in `docs/private-vpn.md`, an agent note in `docs/system/backend.md`.
8. **Independent review** by a separate agent that read the diff cold (see Reviews run). It found two real problems in the first cut. The first version also asked the target after a timeout or a DNS miss, and turned a refusing or silent target into new verdicts. Both were removed: only a refusal triggers the question, and only an answer changes the verdict.
9. Broke each behavior of the fix one at a time, 17 mutations, and watched a test fail for each one that changes behavior (see Tests run).

## Decisions

| Decision | Rationale |
| -------- | --------- |
| Try the Hub's address first; ask the target only when that was **refused** | A node where the address works, which is every node on an older `tailscaled`, never enters the new path, so its verdicts and cost stay as they were. Only the refusal was measured on a real node. A timeout can fire after the connection opened (axios counts the wait for the response), a name that does not resolve or a TLS failure says nothing about the target, and any of them could hide a real fault behind "available". |
| Only an answer changes the verdict | A target that refuses, stays silent or cannot be reached leaves the probe's own `CONNECTION_REFUSED`. No new error code, detail or repair, so the frontend, the MCP tools, the runtime monitor and `resolveAppAvailability` need no change, and the new code cannot create a failure the old code did not give. The first version mapped a refusing target and a silent one to new verdicts. The review pointed out that the page shows the copy keyed by the code, not the detail, and that a new resolvable verdict would offer a Resolve that cannot help a running app. |
| Ask only a target that is a private-network IP address | `host.docker.internal` is an alias of the Hub itself on the app networks and `localhost` is the Hub's own container, while a `tailscaled` on the host reads them as the host. A host name can resolve differently on each side. The first version read such a target as "answers", which would report an app available that peers cannot reach. The Hub writes the app container's address on its app network, which passes. `isIP` runs before `isPoolProbeTarget` (loopback, link-local, unspecified and public refused), because that helper reads a name that starts with `fc` or `fd` as an IPv6 prefix. |
| Match the entry by port, the node's current name and mount `/` | The same name rule as `isRefusedByTailscale`: a renamed node keeps its old listener, which does not answer the new name. The Hub writes mount `/`. |
| Use the entry's own target, not the app's port | ci-hermes listens on `:18790` and forwards to `:18789`. |
| `probeAppPort`, not axios, for the target | It follows no redirects (an app that redirects to its own Private VPN address would send the probe back to the address that refuses it), reads no body, ignores proxy variables, and has its own tests. |
| `resolveAppAvailability` keeps `downOnly` | A refusal that survives the new check means "not published" or "the app behind a published port does not answer". Restarting a running app publishes nothing and cuts off one that is still starting. Only the comment changed. A healthy app now reads available, so Resolve does nothing for it, where it used to run a full sync. |
| `lint:ci` red on `origin/dev` is left alone | One format diff in `packages/backend/build.ts` (from #2471). Not in this change. The previous worksheet recorded the same. |
| `docs/agent/TEST_INVENTORY.md` is not regenerated | As in earlier worksheets, regenerating pulls unrelated rows into the change. The two spec files keep their top-level names. |

## Files touched

- `packages/backend/src/modules/apps/apps.service.ts`.
- Tests: `packages/backend/src/modules/apps/__tests__/apps.service.availability.test.ts`, `apps.service.test.ts`.
- Docs: `docs/private-vpn.md`, `docs/system/backend.md`, this worksheet and its feedback, `docs/agent/WORKFLOW_FEEDBACK.md`.
- Not touched: the frontend, the error codes and their translations, `TailscaleService`, the exposure sync, `probeAppPort`, the runtime monitor.

## Tests run

Run with pnpm 11.5.1 and Node 22.22.3, on the branch as cut from `origin/dev` 6c4164e44, and again after a rebase onto 3fcd834f1 (the commits it brought in touch none of this change's files except `WORKFLOW_FEEDBACK.md`). The runs against the original file and the mutations were made before the rebase.

- [x] `pnpm run lint:ci`: fails on `origin/dev` and on the branch with the same single error, a format diff in `packages/backend/build.ts`. Biome is clean on every file this change touches. Same on both bases.
- [x] `pnpm run tsc`: passes (common, frontend, backend). Same on both bases.
- [x] `pnpm run knip:ci`: passes (before the rebase).
- [x] `pnpm --filter backend test`: before the rebase 496 files passed, 1 skipped (497), 13,236 tests passed, 2 skipped (13,238). After it, 496 files passed, 1 skipped (497), 13,242 tests passed, 2 skipped (13,244). 44 of them are new.
- [x] The new tests against the original `apps.service.ts` (swapped in from `HEAD`, then restored): 14 fail, 13 in the availability spec and 1 in the resolve spec. The other 30 pin behavior that did not change and pass on both.
- [x] 17 mutations of the new code, one at a time, each undoing one behavior (the refusal-only trigger, ignoring the error code, the node name, the port, the mount point, case folding, the IP check, the private-address check, port 0, the https default port, `https+insecure`, IPv6 brackets, the unreadable-status guard, accepting any non-unreachable answer, the ready stage, the Private VPN scope, and `downOnly` in Resolve): a test failed for every one.
- [x] Live, read-only, on beta-max (Tailscale 1.104.7), inside `ci-hub`: the final branch's `probeAppPort`, `isPoolProbeTarget` and `parseServedTarget` against the live Serve table. pi-web, opencode and ci-hermes: the direct dial was refused, the entry's target parsed, and the target answered. A port with no entry gave no target. The Hub's own `http://localhost:5002` entry, `host.docker.internal`, `127.0.0.1` and `169.254.169.254` gave no target. A closed port on a live container gave "refused", an unused address gave "unreachable".
- [ ] App run (`pnpm run local`): not run. The change is in a backend probe that needs a Tailscale node with Serve entries, and the Hub was not deployed to one.
- [ ] `pnpm run check:openapi`: not run. No controller or DTO changed.
- [ ] `bin/agent-validate-shift` as one command: it stops at `lint:ci` (see Decisions). Its other steps were run one by one.

## Open items / handoff

- **Not seen end to end.** The patched Hub was not deployed to beta-max, which stayed read-only. After it is, `GET /api/apps/<urn>/check-availability` for pi-web, opencode and ci-hermes should return `available: true` with the Private VPN `appUrl`, and Resolve should answer "App is already available." without a sync.
- **"Available" means published and answering.** The Hub reads the Serve entry and dials its target. It cannot dial the listener, so it cannot see whether tailscaled bound it.
- **A host-name target keeps the false negative.** A port-expose app's target is `http://host.docker.internal:<port>` (`ExposureSyncService`). On a node whose listeners are bound to the device, such an app still reads "App not responding" while it works. Judging it needs the target dialed from where `tailscaled` runs, or another signal.
- **Timeouts and DNS misses at the address are unchanged.** Only the refusal was measured on a real node.
- **A running app that does not answer behind a published port.** Resolve restarts nothing and re-syncs, as it did for any refusal. A distinct verdict for "published, but the app behind it is down" and a repair that restarts a running app would be a follow-up. It needs its own message and a decision about restarting an app that may still be starting.
- **The monitor treats the two modes differently.** `probeLocalApp` counts a refusing local app as responsive (still starting). A Private VPN refusal that survives the new check counts against the app through `probeAppRoute`, as before.
- **The old classification still reads message text.** A host name that resolves to both an IPv4 and an IPv6 address gives an axios error with an empty message when every address refuses. `wasRefused` reads the error's `code` too, so the new check runs, but where it has nothing to add the branch below it still classifies such an error as `UNKNOWN`. On beta-max the name resolves to one IPv4 address inside the container.
- **`isPoolProbeTarget` and names.** Given a name that starts with `fc` or `fd` it answers true before it checks that the input is an address. Its only caller passes resolved addresses, and the new code checks `isIP` first, so nothing is wrong today.
- **Sidecar mode.** With the `hub-tailscale` sidecar, tailscaled runs in another container and its Serve targets are addresses on the app network. The same logic applies and was not exercised.
- **TLS targets** (`https+insecure`) are covered by unit tests only. The probe sends plain HTTP, and an answer from a TLS port means something is listening there.

## Reviews run

| Phase | Persona | Model | Notes |
| ----- | ------- | ----- | ----- |
| wrap  | code-quality | Opus (a separate agent, no shared context, read-only) | 8 findings, each checked against the code. **Fixed:** (1) the Hub and a host `tailscaled` read `host.docker.internal` and `localhost` differently, which could report an unreachable app available: only private-network IP targets are asked now. (2) axios's timeout can fire after the connection opened: only a refusal triggers now, which also drops the DNS-miss trigger (5). (7) Doc claims: "as 1.104.7 does" became "seen with 1.104.7", "a running app container" became "an app that is running", and the backend note no longer says the Hub never dials the node's address. (8) Two weak test cases: the `:70000` case passed only because `new URL` throws, and the `tcp://` case cannot come from `getServeStatus`; they became port 0 and a unix socket. **Moot after the narrowing:** (3) a resolvable verdict whose repair cannot help a running app, and (6) a detail the page never shows, because a refusing or silent target no longer creates a verdict. **Left, listed above:** (4) the monitor's local-mode and Private VPN refusals differ, which predates this change; the residual of (5), an entry that exists while the listener is not bound. |
