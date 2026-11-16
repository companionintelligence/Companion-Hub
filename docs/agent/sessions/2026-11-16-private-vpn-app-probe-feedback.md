# Session Feedback: private-vpn-app-probe

## Session

| Field | Value |
|-------|-------|
| **Worksheet** | `docs/agent/sessions/2026-11-16-private-vpn-app-probe.md` |
| **Date** | 2026-11-16 |

## What worked

- A script piped to `docker exec -i ci-hub node -` over SSH measured the whole problem on the node without writing a file there: the host's `ss -ltn` showed the device-bound listeners, a dial from inside the container was refused at every app port, `/usr/bin/tailscale serve status --json` worked from the container, and each target answered. It also found that ci-hermes listens on one port and forwards to another, which the first design would have missed.
- Bundling the branch's own `app-port-probe.ts`, `isPoolProbeTarget` and the parsing function with esbuild (the binary is under `node_modules/.pnpm/esbuild@*/`) and piping the result to the same container ran the real helpers against the live Serve table, which is the nearest to an end-to-end check available while the node stays read-only. The Hub's own `http://localhost:5002` entry on that table was a real negative control for the target rule, and a closed port and an unused address showed the refused and unreachable results on the real network.
- `probeAppPort` already existed for the runtime monitor, with the four results this question needs and its own tests. Finding it before writing a request helper kept the diff small and kept redirects, proxy variables and bodies out of it.
- An independent read-only review by a different model, given the diff, the intended behavior and the consumers but not my conclusions, found two problems in the first cut that neither the tests nor the live check could: a Serve target written as `host.docker.internal` or `localhost` means something else to a `tailscaled` on the host than to the Hub's container, and axios's timeout can fire after the connection opened. Each claim was checked against the code (the compose file, `exposure-sync.service.ts`) before acting. It also corrected an assumption of mine: `probeAppPort` does have a spec.
- A script that applies one mutation at a time, runs the two spec files and writes the original back in a `finally` (then compares the file) found that every behavior of the fix has a test that notices it: 17 mutations, all caught. Swapping `HEAD`'s `apps.service.ts` in for one run showed which new tests are evidence of the fix (14) and which only pin behavior that did not change (30).

## Friction / blockers

- The first design did more than the fix needed. Turning a refusing or silent target into new verdicts added a repair question (a resolvable verdict whose repair cannot help a running app) and a message the page never shows, because the page keys its copy by error code. Narrowing it to "only an answer changes the verdict" removed both. A fix for a false negative should be able to turn a failure into a success and nothing else.
- I wrote the docs and the worksheet before the review, so the review's narrowing made them stale and they were rewritten.
- `Edit` refuses a file that was only read with `sed` in a shell, and again after a script or `biome --write` changes the file. Read it with the Read tool first.
- A fresh worktree has no `node_modules`. `pnpm install --frozen-lockfile --prefer-offline` took 8 seconds with a warm store. `pnpm --filter backend run tsc` alone then fails with "Cannot find module '@ci-hub/common/types'"; `pnpm exec turbo run tsc --filter=backend` builds `@ci-hub/common` first.
- `pnpm run lint:ci` still fails on `origin/dev` (a format diff in `packages/backend/build.ts`), so `bin/agent-validate-shift` cannot pass.
- The `husky` prepare script runs during install in a new worktree and creates `.husky/_` there; the pre-commit hook then runs `lint:fix` and `git add` on staged files.

## Workflow improvements

- `AGENT_WORKFLOW.md`: run the independent review before writing the docs and the worksheet when the change is a judgment call about what counts as evidence, since a review can narrow the change.
- `AGENT_WORKFLOW.md`: for a task in a temporary worktree, say to run `pnpm install --frozen-lockfile --prefer-offline` and to type-check with `turbo run tsc --filter=<package>`.
- Fix the `build.ts` format error on `dev` so the end-of-shift gate can pass.
- A task that must stay read-only on a node should say so in the brief, with the exact reproduction that is allowed. This one did, and it made the live check possible without a request for permission.

## Tooling gaps

- A small, documented script that runs a bundled TypeScript file inside a named container on a fleet node over SSH, read-only, would make "ran the branch's helper against live data" repeatable. The one used here is in the shared notes folder for this session.

## One-line summary (for WORKFLOW_FEEDBACK.md)

> 2026-11-16 — private-vpn-app-probe: A fix for a false negative should only be able to turn a failure into a success, so the Hub asks the app behind a Private VPN Serve entry only after a refusal and changes the verdict only on an answer; the live path was proved read-only by bundling the branch's helpers with esbuild and piping them to `node -` inside `ci-hub`, and a cold review found two problems the tests could not.
