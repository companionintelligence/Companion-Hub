# Frontend System — CI-Hub

> **Purpose:** React SPA — dashboard, app store, settings, hub startup gate, real-time logs.
> **Scope:** `packages/frontend/` — React Router 7, TanStack Query, hub-status, API client.
> **Key paths:** `packages/frontend/src/components/hub-status/`, `packages/frontend/src/modules/`, `packages/frontend/src/lib/`
> **Commands:** `cd packages/frontend && pnpm test`, `pnpm run local` (root, port 5004/5005)
> **Owner persona:** code-quality + maintainability
> **Last updated:** 2026-07-12
> **Related:** docs/system/desktop.md, docs/system/e2e.md

---

## Layout

```
packages/frontend/
  src/modules/          Page-level features (dashboard, app-store, settings, …)
  src/components/       Shared UI (hub-status, layouts, providers)
  src/lib/              API fetch, tauri probes, session, theme
  src/api-client/       Generated OpenAPI client + TanStack Query hooks
  routes/               React Router route definitions
```

## Hub status gate

`packages/frontend/src/components/hub-status/hub-status.tsx` blocks the Tauri UI until the Hub API is healthy.

Key behaviors agents must preserve:

- API probe (`/api/health/live`) is the UI gate — not Docker container state alone
- `sessionStorage` steady-state across reloads
- User-initiated reload uses `revalidate()` instead of `window.location.reload()`
- Optional sidecars (Tailscale, cloudflared) must not block `all_ready` or regress UI to startup screen

Tests: `packages/frontend/src/components/hub-status/hub-status.test.tsx`

## API client

- Generated from backend OpenAPI: `pnpm run gen:api-client`
- Tauri release builds probe local ports via `packages/frontend/src/lib/tauri-hub-probe.ts`
- Session refresh: `packages/frontend/src/lib/hub-session-refresh.ts`

## Styling

- Tailwind CSS 4 + Radix UI primitives
- UI style guide: `docs/UI_STYLE_GUIDE.md`

## Testing

- Vitest + Testing Library
- Mock Tauri via `window.__TAURI_INTERNALS__.invoke`
- Mock `@/lib/tauri-hub-probe` with `vi.hoisted` when intercepting module imports

## Agent notes

- Biome forbids non-null assertions (`!`) — use explicit types
- Run scoped tests: `pnpm test -- src/path/to/file.test.tsx`
- Always run `pnpm run local` or `local:desktop` for UI changes
