# CI-Hub Planning & Gap Analysis

**Date:** 2026-05-18
**Branch:** `companion/planning-gap-analysis` (off `dev`)
**Scope:** Snapshot of open PRs, in-flight branches, open issues, and an honest gap analysis of what is genuinely unimplemented and worth taking on next.

---

## 1. PR Landscape (open)

| # | Branch → Base | Title | Status |
|---|---|---|---|
| [#513](https://github.com/companionintelligence/CI-Hub/pull/513) | `companion/vigilant-cerf-e38303` → `dev` | docs: add architecture.md covering CI-Hub and platform fit | **Likely duplicate** — `docs/PLATFORM_ARCHITECTURE.md` (582 lines) and `docs/ARCHITECTURE.md` (816 lines) already exist on `dev` and cover most of the same ground. Recommend closing or repositioning as a *short executive summary* on top of those. |
| [#508](https://github.com/companionintelligence/CI-Hub/pull/508) | `fix/tailscale` → `dev` | Fix/tailscale | Open — merge Tailscale DNS preference enhancement |

Only **two** PRs open against a repo with **~50 active feature/fix branches** — most branches are stale, abandoned, or never opened as PRs. That itself is a finding (see §3).

---

## 2. Branch Landscape

Recent (last 60 days) remote branches, grouped by likely state. Source: `git for-each-ref --sort=-committerdate refs/remotes/origin/`.

### Active (last 14 days)
| Branch | Owner | Last commit | Likely target |
|---|---|---|---|
| `companion/vigilant-cerf-e38303` | Liam | 2026-05-18 | docs (PR #513) |
| `feat/issue-231-public-domain-selection` | Hanzla | 2026-05-18 | issue #231 — public domain selection |
| `fix/tailscale` | Bennett | 2026-05-17 | PR #508 |
| `feat/enhance` | Bennett | 2026-05-17 | desktop UI polish |
| `fix/skip-jenkins` | Bennett | 2026-05-15 | DMG CI fix |
| `fix/dmg-installer` | Bennett | 2026-05-15 | desktop DMG |
| `fix/comfyui-rocm-kfd-install-error` | Bennett | 2026-05-15 | apps preflight |
| `feat/may-14-2` | Bennett | 2026-05-15 | hub status / VPN sidecar polling |
| `feat/less-confusing-signup-1` | Bennett | 2026-05-14 | issue-likely registration UX |
| `feat/auto-restart-on-settings-save` | Bennett | 2026-05-13 | app-lifecycle |
| `fix/openclaw-followup-review-feedback` | Hanzla | 2026-05-13 | openclaw plugin |
| `fix/492-wrap-subdomain-suffix` | Hanzla | 2026-05-11 | issue #492 |

### Stale (15–60 days, no PR found)
~35 branches with significant work that never landed: `feat/dag-pr04..05`, `feat/private-vpn`, `feat/multi-arch-container`, `feat/tauri-desktop`, `feat/130-companion-agent-phase1`, etc. Several look like substantial features that may have been superseded.

### Recommendation
Triage 1×/week: open PR or delete. The current state masks real progress (only 2 open PRs makes the project look idle when 12+ branches are weeks-fresh).

---

## 3. Issue → Branch Mapping (top open issues)

| Issue | Title | In-flight branch? | Status |
|---|---|---|---|
| [#418](https://github.com/companionintelligence/CI-Hub/issues/418) | Epic: post-hardening architecture & truth-contract refactor | `feat/dag-pr04..05` (stale) | Epic, partial |
| [#386](https://github.com/companionintelligence/CI-Hub/issues/386) | Epic: hardening / FTUE / production readiness | many sub-issues `[x]` closed | **Mostly done** — most child items checked |
| [#472](https://github.com/companionintelligence/CI-Hub/issues/472) | Epic: Custom domain via Entri | `feat/issue-231-public-domain-selection` (active) | In flight |
| [#511](https://github.com/companionintelligence/CI-Hub/issues/511) | Manual QA all apps across fleet | `scripts/qa-*.ts`, `scripts/FLEET_QA.md` exist | Tooling exists; ops task |
| [#510](https://github.com/companionintelligence/CI-Hub/issues/510) | Squash git history before OSS release | — | Dangerous, defer |
| [#509](https://github.com/companionintelligence/CI-Hub/issues/509) | **P0** Point prod hub at prod marketplace | — | **Not a code change** (see §4.A) |
| [#494](https://github.com/companionintelligence/CI-Hub/issues/494) | Redesign device registration page | — | UX, sub-branch needed |
| [#491](https://github.com/companionintelligence/CI-Hub/issues/491) | Warn + backup prompt on env save | — | Open |
| [#475](https://github.com/companionintelligence/CI-Hub/issues/475) | App explorer flywheel (E2E AI) | `feat/app-explorer-flywheel` (stale 2026-05-02) | In flight, stalled |
| [#469](https://github.com/companionintelligence/CI-Hub/issues/469) | ActivityPub federation | — | Multi-week, exploratory |
| [#468](https://github.com/companionintelligence/CI-Hub/issues/468) | Hub-managed SMTP | — | Multi-week |
| [#467](https://github.com/companionintelligence/CI-Hub/issues/467) | App ecosystem audit | — | Research, no branch |
| [#455](https://github.com/companionintelligence/CI-Hub/issues/455) | chown `.internal` to current user | `scripts/start.ts::ensureRootFolderOwnership` exists | **Likely already done** (see §4.B) |
| [#453](https://github.com/companionintelligence/CI-Hub/issues/453) | **Bug:** uninstall Tauri should remove tunnel token | — | **Real gap** (see §4.C) |
| [#443](https://github.com/companionintelligence/CI-Hub/issues/443) | Marketplace hardening | — | Manual QA, not code |
| [#438](https://github.com/companionintelligence/CI-Hub/issues/438) | Cross-domain E2E Hub↔Portal registration | — | Large infra work |
| [#434](https://github.com/companionintelligence/CI-Hub/issues/434) | Pass Hub vars into app containers | `packages/backend/.../app.helpers.ts:56-71` injects `HUB_DEVICE_ID`+`HUB_API_KEY` | **2/3 already done** (see §4.D) |
| [#427](https://github.com/companionintelligence/CI-Hub/issues/427) | Realign Hub boundaries (domain/adapter seams) | — | Epic refactor |
| [#400](https://github.com/companionintelligence/CI-Hub/issues/400) | Battle-test Tauri + Hub image update flow | — | QA/test infra |
| [#394](https://github.com/companionintelligence/CI-Hub/issues/394) | Health-aware desktop startup + diagnostics | `feat/394-health-aware-startup` (PR-ready, 2026-04-28) | **Has unmerged branch with PR review feedback** |
| [#386](https://github.com/companionintelligence/CI-Hub/issues/386) | (see above) | many | mostly done |
| [#350](https://github.com/companionintelligence/CI-Hub/issues/350) | E2E test app | `feat/e2e-platform-test-app` (stale) | In flight, stalled |
| [#231](https://github.com/companionintelligence/CI-Hub/issues/231) | Public domain selection | `feat/issue-231-public-domain-selection` (active) | In flight |

---

## 4. Gap Analysis — Findings That Changed the Plan

### 4.A — Issue #509 (P0 prod marketplace pointer) is **not a code change in this repo**

`packages/backend/src/modules/app-stores/app-store.service.ts::registerCloudAppStore` already sources the marketplace URL from `ciCloudUrl` (the `CI_CLOUD_URL` env var). The `.env.example` on `dev` already points to `https://hub.companionintelligence.com`.

**What needs to change:** the `.env.prod` file *on the production deployment host* — not in this repo. Fix is infra, not engineering.

**Action:** confirm production env file with whoever runs prod (Steve per standup notes); no PR here.

### 4.B — Issue #455 (chown `.internal`) is **likely already done**

`scripts/start.ts::ensureRootFolderOwnership` already detects ownership mismatch on `ROOT_FOLDER_HOST` and runs `chown -R <uid>:<gid>` on Linux/macOS before launching. If this is incomplete, the issue should specify which files inside `.internal` still aren't writable.

**Action:** verify against issue, then close or add a focused repro.

### 4.C — Issue #453 (tunnel token on Tauri uninstall) is a **real gap**

No code path in `packages/desktop/src-tauri/src/` deletes `tunnel/token` or invalidates the tunnel at Cloudflare on uninstall. Existing `cleanup_stale_project_containers` (`hub_manager.rs:1239`) only tears down the compose project.

**Smallest tractable cut:**
1. Add a tray "Factory Reset" menu item (file: `src-tauri/src/tray.rs`) that calls a new `factory_reset` command.
2. Implementation removes `tunnel/token`, calls existing compose-down, and (if reachable) hits Portal `DELETE /devices/:id` to invalidate the tunnel server-side.
3. macOS/Windows uninstallers cannot reliably run hooks; the in-app reset is the practical surface.

**Carved out as task #4** (see §6).

### 4.D — Issue #434 (Hub vars into app containers) is **2/3 already implemented**

`packages/backend/src/modules/apps/app.helpers.ts::generateEnvFile` (lines 56–71) already sets `HUB_DEVICE_ID` and `HUB_API_KEY` per app. Only **`HUB_PORTAL_JWT`** from the issue isn't implemented — and that's blocked on Portal-side JWT issuance which isn't in this repo.

**Action:** comment on issue confirming first two are shipped; convert remainder into a Portal-side task. No PR needed here.

### 4.E — My own PR #513 (architecture.md) overlaps existing `docs/`

`docs/ARCHITECTURE.md` (816 lines) and `docs/PLATFORM_ARCHITECTURE.md` (582 lines) exist on `dev` but were not present on the older branch base I worked from (`companion/vigilant-cerf-e38303` is based on a commit before those landed). My `architecture.md` re-derives much of the same content.

**Recommendation:** close PR #513 and (optionally) open a small PR adding a top-level link in README to those two docs if discoverability is the concern.

---

## 5. Prioritized Roadmap (next 2 weeks)

### Priority 0 — Unblock launch
| Item | Owner | Notes |
|---|---|---|
| Production `.env.prod` points at prod marketplace (#509) | infra/Steve | Not code |
| Land #394 health-aware startup (PR review feedback addressed 2026-04-28) | original author | Branch ready, needs review→merge |
| Land #508 Tailscale fix | reviewer | Already open |

### Priority 1 — Real gaps with small surface area
| Item | Tracking | Owner |
|---|---|---|
| #453 clear tunnel token on desktop reset/uninstall | new sub-branch `fix/453-clear-tunnel-token-on-reset` | this session (task #4) |
| #491 warn + backup prompt when saving env vars | new sub-branch | unassigned |
| #494 redesign device registration page (two-path UI) | new sub-branch | UX-led |

### Priority 2 — Stalled-but-substantial branches needing rescue or retire
| Branch | Decision needed |
|---|---|
| `feat/app-explorer-flywheel` (#475) | resume or close |
| `feat/e2e-platform-test-app` (#350) | resume or close |
| `feat/dag-pr04..05` (#418) | rebase or supersede |
| `feat/130-companion-agent-phase1` | rescue or move to a dedicated repo |
| `feat/multi-arch-container` | merge if green; arm64 is a launch item |

### Priority 3 — Multi-week features (need scoping spike, not coding)
- #469 ActivityPub federation
- #468 Hub-managed SMTP
- #472 Entri custom domain epic (already has flow via #231)
- #427 / #426 / #425 / #424 / #423 / #422 / #421 / #420 / #419 — refactor authority epics (under #418)

### Priority 4 — Ops / not engineering
- #511 manual QA all apps (tooling exists in `scripts/`)
- #510 squash git history — defer until launch
- #443 marketplace hardening (manual cataloguing)

---

## 6. Implementation Plan (this session)

Single sub-branch this session — staying narrow rather than fake-implementing already-done items:

| Sub-branch | Issue | Surface | Status |
|---|---|---|---|
| `fix/453-clear-tunnel-token-on-reset` | #453 | `packages/desktop/src-tauri/src/{tray.rs,hub_manager.rs}` + new `factory_reset` Tauri command | Pending — task #4 |

For follow-up PRs (out of session):

| Sub-branch | Issue | Notes |
|---|---|---|
| `chore/triage-stale-branches` | — | Open PR or delete for the ~35 stale branches; mechanical |
| `fix/491-env-save-backup-warn` | #491 | Frontend confirm dialog + backup pre-step |
| `feat/494-registration-redesign` | #494 | Needs design input first |
| `chore/branch-graveyard` | — | Archive branches not touched in 60+ days |

---

## 7. Testing Gaps

| Area | Coverage today | Gap |
|---|---|---|
| Backend unit | Vitest across modules, `app-lifecycle/commands/__tests__` reasonable | Gaps in `cloudflare/`, `registration/` edge paths |
| Backend integration | `vitest.integration.config.mts` exists | Run cadence in CI unclear |
| E2E (Playwright) | `e2e/` directory, ~16 specs | Hub↔Portal cross-domain registration uncovered (#438) |
| Desktop (Tauri) | `packages/desktop/TESTING.md` | No automated UI test of tray actions; uninstall/factory-reset flow has no test |
| Fleet QA | `scripts/qa-*.ts`, manual SSH fan-out | Promote to in-app dashboard (#511 implies) |
| Multi-arch builds | `feat/multi-arch-container` branch, not merged | ARM64 unverified in CI on `dev` |

---

## 8. Open Questions

1. **PR #513** — close, or rebase onto `dev` and reposition as an executive summary on top of existing `docs/`?
2. **Stale-branch policy** — is there an owner who can authorize deletion of 60+ day untouched branches, or should they go to a `archive/` namespace?
3. **#434 third var (`HUB_PORTAL_JWT`)** — is JWT issuance from Portal on any near-term roadmap? If not, comment-and-close on the issue.
4. **#453 implementation surface** — preferred trigger: in-app tray "Factory Reset", a CLI subcommand, or a Portal-initiated "wipe this device"? Different blast radius.

---

## 9. References

- Existing internal docs: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/PLATFORM_ARCHITECTURE.md](docs/PLATFORM_ARCHITECTURE.md), [docs/FLYWHEEL.md](docs/FLYWHEEL.md), [docs/private-vpn.md](docs/private-vpn.md)
- Fleet ops: [scripts/FLEET_QA.md](scripts/FLEET_QA.md)
- Sibling repos: [CI-App-Store](https://github.com/companionintelligence/CI-App-Store), CI-Portal, CI-Launcher
