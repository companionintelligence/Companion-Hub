# Session Worksheet

## Meta

| Field     | Value                                                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Slug**  | agent-store-portability                                                                                                         |
| **Date**  | 2026-10-30                                                                                                                      |
| **Agent** | Codex                                                                                                                           |
| **Model** | GPT-6                                                                                                                           |
| **Task**  | Compare store A and store B agent packaging with CI-OpenClaw/CI-Hermes; update Companion-Hub and Marketplace from the findings. |

## Goal

Capture portable packaging and trust-boundary rules for agent apps, correct the Hermes sender-access default, synchronize the OpenClaw Hub bootstrap with the Marketplace payload, and prevent a store A-only OpenClaw proxy from being promoted as Hub-compatible.

## Steps taken

1. Inspected current Hub and Marketplace branches in isolated worktrees and reviewed CI-native and upstream OpenClaw/Hermes manifests.
2. Compared current store A OpenClaw/Hermes wrappers with store B OpenClaw/Hermes chart manifests and runtime templates.
3. Updated the generic Hermes sender policy, Marketplace docs, CI app descriptions, and OpenClaw bootstrap payload; quarantined the incompatible store A-wrapped OpenClaw listing.
4. Added Companion-Hub portability guidance and indexed it in the agent documentation.

## Decisions

| Decision                                                                          | Rationale                                                                                                                                       |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Quarantine the store A OpenClaw listing in dev                                    | Its pinned startup wrapper replaces the Hub-generated token with store A trusted-proxy auth and expects store A identity headers.               |
| Default Hermes all-sender access off                                              | The upstream Compose previously set GATEWAY_ALLOW_ALL_USERS=true; store B documents a deny-by-default allowlist posture.                        |
| Keep the official Hermes dashboard password and avoid default whole-host Hub auth | Hermes may serve webhooks and OAuth callbacks; callback compatibility needs runtime verification before gating the whole hostname.              |
| Sync the Hub OpenClaw bootstrap into the Marketplace payload                      | The Marketplace payload takes precedence during install, and its former copy lacked active-backend, context-window, and cloud-provider support. |

## Files touched

- AGENTS.md
- docs/system/README.md
- docs/system/marketplace-app-portability.md
- docs/agent/WORKFLOW_FEEDBACK.md
- docs/agent/sessions/2026-10-30-agent-store-portability.md
- docs/agent/sessions/2026-10-30-agent-store-portability-feedback.md

## Tests run

- [ ] pnpm run lint:ci
- [ ] pnpm run tsc
- [ ] pnpm test
- [ ] App run (pnpm run local / local:desktop)
- [ ] bin/agent-validate-shift

No runtime or test suite was run for this documentation/configuration change. Marketplace JSON parsing and diff whitespace checks passed.

## Open items / handoff

Replace the quarantined store A OpenClaw wrapper with a Hub-owned adapter or an upstream OpenClaw image. Remove legacy UI auth compatibility settings only with that image change. Runtime-verify local access, Hub Web exposure, pairing, gateway token auth, and provider setup before restoring the listing. Verify Hermes webhook/OAuth callback routing before enabling whole-host Hub authentication.

## Reviews run

| Phase | Persona | Model | Notes |
| ----- | ------- | ----- | ----- |
|       |         |       |       |
