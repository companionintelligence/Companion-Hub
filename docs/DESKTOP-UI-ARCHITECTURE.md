# Desktop UI Architecture — One Hub, One UI

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

## Status

Implemented on `dev` — desktop release uses bootstrap + stack UI; see CI rules below.

## Problem

Companion Hub ships **two independent frontends** from the same release:

| Artifact | Built by | Served from | Updates via |
|----------|----------|-------------|-------------|
| Container UI | `build-container.yml` | `ci-os-hub` → `:5002` | Stack pull / auto-update |
| Desktop UI | `desktop-release.yml` (per-OS) | Embedded in Tauri binary | Full desktop reinstall |

Both can report the same version while showing different UI. Update checks validate separate channels.

## Decision

**The container is the single source of truth for product UI.** The desktop binary is a native host shell only.

```
┌──────────────────────────────────────────────────────────┐
│  Native shell (Tauri)                                    │
│  • Window, tray, Docker lifecycle, host installs         │
│  • Bootstrap splash (embedded, minimal static assets)    │
│  • Shell binary updater (rare)                           │
└───────────────────────┬──────────────────────────────────┘
                        │ stack healthy
                        ▼
┌──────────────────────────────────────────────────────────┐
│  Hub stack (Docker)                                      │
│  • API + full SPA at http://127.0.0.1:${API_PORT}        │
│  • Same UI in browser and desktop WebView                  │
└──────────────────────────────────────────────────────────┘
```

## Runtime modes

Frontend code uses explicit modes (`hub-runtime-mode.ts`), not URL-origin inference alone:

| Mode | Origin | Auth | When |
|------|--------|------|------|
| `browser` | `:5002` / public URL | cookies | Browser |
| `desktop-same-origin` | `http://127.0.0.1:PORT` in Tauri | cookies | Release desktop (target) |
| `desktop-embedded` | `tauri://` | `X-CI-Hub-Session` header | Bootstrap splash; legacy fallback |
| `mobile-remote` | `tauri://` | header + HTTP plugin | iOS app |

## Version & updates

- **One version** — always the running stack version from the API.
- **Primary update** — stack pull (Settings → Update Hub). Updates UI automatically.
- **Shell update** — separate, rare; only when the Tauri/Rust layer changed.

## CI rules

1. Build full frontend **once** per release tag inside the container image (`build-container.yml` / `Dockerfile`). Desktop and browser CI do not rebuild the SPA.
2. Desktop release embeds **bootstrap only** (not `packages/frontend/dist/client`). `desktop-release.yml` and `desktop-build.yml` follow this.
3. Production: `desktop CI_HUB_BUILD_VERSION == container image tag` (enforced by `desktop-release.yml` → `build-container` with matching `tag` input).

## Bootstrap

Release desktop loads a minimal embedded splash, polls stack health via Tauri invoke, then navigates to `http://127.0.0.1:${API_PORT}/`. Cold-start UX (Docker missing, stack starting) lives in bootstrap + native commands — not in the container SPA.

## Out of scope

- Mobile app (remote-hub thin client — unchanged).
- Loading tailnet/public URLs in desktop WebView (browser only).

## References

- `packages/desktop/bootstrap/` — release bootstrap splash
- `packages/frontend/src/lib/hub-runtime-mode.ts` — runtime mode detection
- `packages/frontend/src/lib/desktop-stack-session.ts` — stack update pending + steady session flags
- `docs/DESKTOP-AUTO-UPDATE.md` — shell vs stack update mechanics
- `scripts/launch-tauri-desktop.ts` — stack-dev precedent (`devUrl: http://127.0.0.1:PORT`)
