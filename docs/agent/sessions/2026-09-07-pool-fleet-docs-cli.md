# Session Worksheet — pool-fleet-docs-cli

## Meta

| Field | Value |
|-------|-------|
| **Slug** | `pool-fleet-docs-cli` |
| **Date** | 2026-09-07 |
| **Agent** | Claude |
| **Model** | Opus 5 |
| **Task** | User request: update code documentation, UI, and CLI across Hub and Portal account/device management, focused on LLM backend pooling and overall fleet / user setup |

---

## Goal

Bring the pooling, fleet, and account/device surfaces into agreement with the code: implement the one
`cihub pool` command that was documented but never routed, close the information gaps between the web
UI and the CLI, correct doc claims that no longer hold, and give the fleet path a single end-to-end
guide it did not have.

---

## Steps taken

1. Audited `cihub pool` against `POOL_SUBCOMMANDS`, the backend controller, and the docs. Found
   `pairing-pin` documented in two docs and named in the CLI's own `pool probe` output and tests, but
   absent from the dispatcher — so the documented headless LAN-pairing flow could not be completed.
2. Implemented `cihub pool pairing-pin` (mint, plus `--cancel`), with API helpers and a formatter that
   leads with which machine the digits are typed on.
3. Compared the CLI's hand-mirrored `PoolStatusResponse` with `hub-pool.types.ts`. It was missing
   `pairingPin`, `localNode.identity`, `settings.poolRequireSignedPeers`, and per-peer `authMode`.
   Added them and surfaced all four in `cihub pool status`.
4. Added the same peer auth-mode indicator to the web UI, which showed key fingerprints only on
   pending peers.
5. Traced the third pool discovery directory (CI Portal device registry) end to end and found it
   inert for two independent reasons. Corrected the docs and code comments that promised it.
6. Repaired lossy-transcode artifacts (`?` for `—`, `–`, `…`, `•`) across the registration and wizard
   flows, and a test whose assertions had been corrupted the same way.
7. Wrote `docs/fleet-setup.md`; refreshed `docs/CLI.md`, `docs/hub-pool.md`, `docs/system/backend.md`;
   updated the stale status blocks in CI-Engineering ADR-0010, the roadmap, and the glossary.

---

## Decisions

| Decision | Rationale |
|----------|-----------|
| Implement `pairing-pin` rather than delete it from the docs | It is the only way to mint a PIN on a headless appliance, and the UI explicitly routes address-pairing to the CLI. Removing the docs would have left the flow genuinely unreachable |
| Report peer auth mode as a status footer, not a new table column | The peer table's widths are asserted by tests and sized for a terminal. The actionable fact is the list of peers still on bearer, which reads better as a named list |
| Surface `poolRequireSignedPeers` state in the UI but do not add a toggle | Setting it while any peer is unupgraded takes both directions of that pairing down. The missing thing was the information, not the control; adding the control was not asked for |
| Document the dead Portal discovery leg instead of fixing it | Both causes are in CI-Portal (session-only auth on `GET /api/devices`, no MagicDNS column). A Hub-side change cannot fix either |
| Fix the corrupted `box sections` test rather than work around it | It asserted `?` where it meant `│`, so it was testing nothing and blocked a legitimate question mark in help text |

---

## Files touched

- `scripts/lib/cli-pool.ts`, `scripts/hub-pool-cli.ts`, `scripts/lib/cli-ui.ts`
- `scripts/lib/cli-register.ts`, `scripts/lib/cli-wizard.ts`, `scripts/lib/cli-models.ts`
- `scripts/__tests__/cihub-cli.test.ts`, `scripts/__tests__/hub-pool-cli.test.ts`
- `packages/backend/src/modules/hub-pool/hub-pool-discovery.service.ts`
- `packages/frontend/src/modules/settings/containers/hub-pool-settings.tsx` and its test
- `packages/common/i18n/translations/en.json`, `en-US.json`
- `docs/fleet-setup.md` (new), `docs/CLI.md`, `docs/hub-pool.md`, `docs/README.md`, `docs/system/backend.md`
- CI-Engineering: `adr/0010-hub-pool-tailnet-peer-trust.md`, `architecture/roadmap.md`, `resources/glossary.md`

---

## Tests run

- [x] `npx vitest run scripts/__tests__/` — 753 passed (29 files)
- [x] `packages/backend` `vitest run src/modules/hub-pool` — 501 passed (14 files)
- [x] `packages/frontend` `vitest run src/modules/settings` — 106 passed (13 files)
- [x] `npx tsc --noEmit` — clean for every file touched
- [x] `npx biome check --write` on the changed areas
- [ ] App run — **not possible on this machine: no Docker.** `cihub pool pairing-pin`, `--cancel`, and
      `status` were instead driven against a stub Hub API on `127.0.0.1:5002` with a device key in
      `.internal/state/settings.json`, and the rendered output verified by hand
- [ ] `bin/agent-validate-shift`

---

## Merge note (2026-09-08)

`dev` gained [#1290](https://github.com/companionintelligence/CI-Hub/pull/1290), which fixed the same
`pairing-pin` gap independently while this branch was open, and [#1293](https://github.com/companionintelligence/CI-Hub/pull/1293),
which added `cihub pool doctor`. Resolved in favour of the shipped surface: upstream's `cancel-pin`
**subcommand** replaces the `--cancel` flag described above, and upstream's `mintPairingPin` /
`cancelPairingPin` / `formatPairingPinLines` replace the duplicates this branch introduced. Two things
from here were folded into upstream's formatter rather than dropped: the copy-pasteable local node name
in the printed `pool pair` line, and the note that minting is not pre-approval. Everything with no
upstream equivalent — the `pool status` PIN/identity/auth-mode blocks, the Portal discovery correction,
the transcode repairs, and `docs/fleet-setup.md` — is unchanged.

## Open items / handoff

- **CI-Portal work is needed to make pool discovery's Portal leg real.** It needs a device-key
  authenticated device listing (`GET /api/devices` is `sessionMiddleware`-only today) that carries a
  MagicDNS name (`device` has no such column). Until then `HubPoolDiscoveryService.listPortalCandidates`
  returns `[]` on every Hub, silently. Documented in `docs/hub-pool.md`, the service comment, and ADR-0010.
- **The pool CLI's response types are hand-mirrored** from `hub-pool.types.ts` because the pool routes
  declare empty response schemas in `swagger.json`. This session found four fields that had drifted.
  Either give the pool routes real response schemas so the generated client types them, or add a test
  that fails when the two diverge.
- **`poolRequireSignedPeers` has no UI control**, only an indicator. Deliberate for now — see Decisions.
- The transcode artifacts were confined to `scripts/lib/` and one test. A wider sweep of `packages/`
  found none, but the corrupted test shows they can hide inside assertions.

---

## Reviews run

| Phase | Persona | Model | Notes |
|-------|---------|-------|-------|
| impl | self-review | Opus 5 | Verified every changed CLI path against a stub Hub API rather than only unit tests |
