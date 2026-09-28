# Session Worksheet: voice-pe-audio-routes

## Meta

| Field | Value |
|-------|-------|
| **Slug** | `voice-pe-audio-routes` |
| **Date** | 2026-09-28 |
| **Agent** | Claude Code |
| **Model** | Claude |
| **Task** | User request: connect CI-Home-Assistant-Voice-PE to Companion Hub |

---

## Goal

Let the Home Assistant voice stack (CI-Home-Assistant-Voice-PE) and any other
OpenAI client use the Hub's speech engines. `POST /api/inference/v1/audio/transcriptions`
parsed no multipart body, so it forwarded `{}` to Lemonade or the cloud provider
and every OpenAI-shaped upload failed. `POST /api/inference/v1/audio/speech`
labelled every response `audio/mpeg`, even when the client asked for WAV.

---

## Steps taken

1. Traced the audio routes from `inference.controller.ts` through `InferenceRouterService.routeStt/routeTts` and `CloudFallbackService.proxyStt`.
2. Added `audio-proxy.util.ts`: rebuilds the multer upload as a spec `FormData` (file plus the OpenAI transcription fields) and maps `response_format` to a content type.
3. Transcription route: `FileInterceptor('file')` with a 25 MB limit, OpenAI-shaped 400 when the file is missing. Guards still run before the upload is read.
4. Speech route: content type follows `response_format`.
5. Unit tests for the helper; updated the limitation note in `docs/editor-inference.md`.

---

## Decisions

| Decision | Rationale |
|----------|-----------|
| Forward only `model`, `language`, `prompt`, `response_format`, `temperature` | The OpenAI transcription fields engines understand; anything else stays out of the upstream request |
| 25 MB upload cap | OpenAI's own limit; keeps a stray upload from filling memory (multer memory storage) |
| Pure helper module, no Nest imports | Testable without the Nest harness; matches `model-availability.util.ts` |

---

## Files touched

- `packages/backend/src/modules/inference/audio-proxy.util.ts` (new)
- `packages/backend/src/modules/inference/__tests__/audio-proxy.util.test.ts` (new)
- `packages/backend/src/modules/inference/inference.controller.ts`
- `docs/editor-inference.md`

---

## Tests run

- [x] `vitest run src/modules/inference/__tests__/audio-proxy.util.test.ts` (6 passed)
- [x] `biome check packages/backend/src/modules/inference/` (no new findings; 3 pre-existing warnings in untouched files)
- [ ] `pnpm run lint:ci`, `pnpm run tsc`, `pnpm test`: not run. `pnpm install` could not fetch the `systeminformation` fork from codeload.github.com in the cloud session (egress policy). Run `ci-local run --repo CI-Hub` before merge.
- [ ] App run (`pnpm run local`), `bin/agent-validate-shift`: same blocker

---

## Open items / handoff

- Verify with the Hub running and Lemonade serving `whisper-base`:
  `curl -F file=@turn.wav -F model=whisper-base http://localhost:5002/api/inference/v1/audio/transcriptions`
- `docs/agent/TEST_INVENTORY.md` is stale beyond this change (about 100 missing entries); regenerate with `pnpm run agent:test-inventory` in a separate PR.
- Companion PR: companionintelligence/CI-Home-Assistant-Voice-PE#8 points its ci-server at `http://ci-hub:5002/api/inference` for STT/TTS under Hub.

---

## Reviews run

| Phase | Persona | Model | Notes |
|-------|---------|-------|-------|
| impl | self-review | Claude | Guard runs before `FileInterceptor`, so unauthenticated uploads are refused before buffering |
