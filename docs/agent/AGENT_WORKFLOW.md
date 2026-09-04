# Agent workflow

> **Purpose:** Standard session flow for feature work, bug fixes, and refactoring in Hub.
> **Scope:** All coding-agent sessions except marketplace QA flywheel (see FLYWHEEL.md).
> **Tag in sessions:** `@docs/agent/AGENT_WORKFLOW.md`
> **Queue:** [TODO.md](../../TODO.md)
> **Router:** [AGENTS.md](../../AGENTS.md)
> **Last updated:** 2026-07-12
> **Related:** END_OF_SHIFT.md, AGENT_REVIEW.md, docs/system/

---

## Session phases

### 1. Research

- If this is a new session, read the [AGENTS.md](../../AGENTS.md) router.
- Pick a task from [TODO.md](../../TODO.md) or accept an explicit user request.
- Read the relevant [docs/system/](../system/) document for the area you plan to change.
- Run `bin/agent-review --phase research --persona maintainability` for non-trivial changes.

### 2. Plan

- Outline files to touch and tests to add/update.
- For multi-package changes, note backend + frontend + desktop boundaries.
- Run `bin/agent-review --phase plan` with a different model than research (see AGENT_REVIEW.md).

### 3. Implement

- Match existing conventions in [CODING_CONVENTIONS.md](CODING_CONVENTIONS.md).
- Write or update tests alongside code — see [TESTING.md](TESTING.md).
- **Run the app** while implementing (mandatory):

```bash
# Source dev (most feature work)
pnpm run local

# Desktop / Tauri changes
pnpm run local:desktop

# Appliance stack parity
pnpm run dev
```

- Fix issues you find before moving on — do not hand broken UI or failing health checks to the user.
- Scoped package checks during iteration:

```bash
cd packages/frontend && pnpm test -- path/to/test.tsx
cd packages/backend && pnpm test -- path/to/test.ts
cd packages/desktop/src-tauri && cargo test relevant_test
```

### 4. Test

- Unit: `pnpm test` (turbo + CLI tests).
- Integration (if backend/DB touched): `pnpm run test:integration`.
- E2E (if UI flows touched): `pnpm run test:e2e:ci` or targeted spec.
- Visual (if UI layout touched): `pnpm run test:visual`.
- Benchmark gate (if perf-sensitive): `pnpm run benchmark:gate`.

### 5. Review

At wrap-up, request a cross-agent review from a model other than the implementation model:

```bash
bin/agent-review --phase wrap --persona security
bin/agent-review --phase wrap --persona code-quality
```

See [AGENT_REVIEW.md](AGENT_REVIEW.md) and [REVIEW_PERSONAS.md](REVIEW_PERSONAS.md).

### 6. Document

- Update [docs/system/](../system/) docs if you changed that system.
- Copy [SESSION_WORKSHEET.template.md](SESSION_WORKSHEET.template.md) → `docs/agent/sessions/YYYY-MM-DD-<slug>.md` and fill it in.
- Copy [SESSION_FEEDBACK.template.md](SESSION_FEEDBACK.template.md) → same session folder.
- Append a one-line summary to [WORKFLOW_FEEDBACK.md](WORKFLOW_FEEDBACK.md).

### 7. Validate (end of shift)

Run the full gate:

```bash
bin/agent-validate-shift
# or: pnpm run agent:validate
```

See [END_OF_SHIFT.md](END_OF_SHIFT.md) for the full checklist.

### 8. Ship

- Commit worksheet + feedback with your code changes.
- After merge, tag: `git tag agent-session/<worksheet-slug>`

---

## Autonomous and night-shift mode

For unattended work:

1. Load `.cursor/skills/agent-loop/SKILL.md`.
2. Take the top item from `TODO.md` → `## In Progress`.
3. Run phases 1–7 without user prompts.
4. Move task to done in TODO.md or leave notes in `## Blocked`.
5. Run `bin/agent-sweep` before final validate.

---

## What not to do

- Do not import from `agent/` into Hub packages (dev-only, separate lockfile).
- Do not use FLYWHEEL.md for general feature work — it is marketplace QA only.
- Do not skip running the app for UI or API changes.
- Do not use non-null assertions (`!`) or patterns flagged in CODING_CONVENTIONS.md.
