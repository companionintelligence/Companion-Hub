# Store experience alignment

## Meta

| Field | Value |
|-------|-------|
| **Slug** | `store-experience-alignment` |
| **Date** | 2026-10-29 |
| **Agent** | Codex |
| **Model** | GPT-6 |
| **Task** | Align CI-Hub and CI-Portal app store pages per the user request |

## Goal

Align Hub catalog cards and categories with Portal, make Portal's featured store use Hub's four shelves, reconcile app detail data and disclosures, and add Portal's changelog and organization library to Hub.

## Steps taken

1. Fetched both repositories' `main` branches and created task branches from their latest revisions.
2. Added Portal-backed card/detail metadata and Hub API routes for app details, reviews, changelog, and device-scoped entitlements.
3. Added the Hub What's New and Library views, host-access disclosure, ratings/reviews, and matching card trust badges.
4. Added Portal's Companion Intelligence shelf and matched its section order and labels to Hub.

## Decisions

| Decision | Rationale |
|----------|-----------|
| Portal resolves the library organization from the device key | The Hub must not be able to select a different organization's paid entitlements. |
| Multiple device registrations return unavailable | Selecting or unioning organizations would risk exposing a different tenant's entitlements. |
| Reviews display in Hub as read-only | Portal's review write flow relies on Portal session and developer permissions; the Hub proxy exposes the public review data only. |

## Files touched

- Hub backend/common/frontend store files under `packages/backend`, `packages/common`, and `packages/frontend`
- Hub docs: `docs/system/frontend.md`, `docs/agent/sessions/2026-10-29-store-experience-alignment.md`, `docs/agent/sessions/2026-10-29-store-experience-alignment-feedback.md`, `docs/agent/WORKFLOW_FEEDBACK.md`, `TODO.md`
- Portal: `apps/web-app/src/routes/store/index.tsx`, `apps/hono-app/src/domains/applications/handlers/ListApps.ts`, `apps/hono-app/src/domains/store/handlers/ListDeviceAppEntitlements.ts`, `apps/hono-app/src/domains/store/services/ReviewService.ts`, `apps/hono-app/src/domains/store/index.ts`, `apps/hono-app/src/routes/api/devices.ts`

## Validation

- Hub: `pnpm run tsc`, changed-file Biome check, and `git diff --check` passed.
- Portal: web and Hono TypeScript checks, both package lints, and `git diff --check` passed.
- Tests were not run per the active instruction.
- `pnpm run local` started Hub at `localhost:5005` with a sample local environment; it reached device registration, not the store.

## Open items / handoff

- A side-by-side store screenshot was not delivered: the local preview is unregistered and only shows device setup. No device pairing or restore action was taken.
- CI-Hub and CI-Portal pull requests should be opened from the task branches after the independent review.

## Reviews run

| Phase | Persona | Model | Notes |
|-------|---------|-------|-------|
| Independent cross-repo review | Code reviewer | GPT-6.1 Sol | Found and fixed request transport/session, unknown-price display, listing ratings (including D1 parameter cap), and stale sidebar category URL issues; no remaining findings. No tests run. |
