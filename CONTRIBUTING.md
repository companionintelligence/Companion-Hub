# Contributing to CI-Hub

Thank you for contributing to CI-Hub! This guide covers the conventions and requirements you should follow when submitting issues and pull requests.

## Table of Contents

- [AI Agents](#ai-agents)
- [Screenshot Requirements](#screenshot-requirements)
- [Issue Templates](#issue-templates)
- [Pull Requests](#pull-requests)

---

## AI Agents

If you are a coding agent working in this repo, read **[AGENTS.md](AGENTS.md)** first, then tag **[docs/agent/AGENT_WORKFLOW.md](docs/agent/AGENT_WORKFLOW.md)** in your session.

### Session worksheet

Commit a filled **[SESSION_WORKSHEET.template.md](docs/agent/SESSION_WORKSHEET.template.md)** to `docs/agent/sessions/` with your changes. After merge, tag: `agent-session/<worksheet-slug>`.

### Validation

Run **`bin/agent-validate-shift`** (or `pnpm run agent:validate`) before marking agent work done. See [docs/agent/END_OF_SHIFT.md](docs/agent/END_OF_SHIFT.md).

---

## Screenshot Requirements

To improve cross-team visibility, speed up reviews, and support marketing and documentation efforts, **screenshots must be included in tickets as part of the acceptance criteria** for all UI/UX work.

### When screenshots are required

| Change type | Requirement |
|---|---|
| UI/UX change | **Required** — include before/after screenshots |
| New UI feature | **Required** — include screenshots of key screens |
| Bug with visible symptom | **Required** — include a screenshot showing the issue |
| Backend-only change | Optional |
| Documentation-only change | Optional |

### Where to upload screenshots

Upload screenshots to the shared team Google Drive folder:

> **[CI-Hub Screenshots — Google Drive](https://drive.google.com/drive/folders/ci-hub-screenshots)**

Organize files by issue number or feature name, for example:

```
ci-hub-screenshots/
  issue-123-login-redesign/
    before.png
    after.png
  issue-456-dashboard-widget/
    home-screen.png
    widget-expanded.png
```

You may also attach screenshots directly to the GitHub issue or pull request.

### Taking screenshots with Playwright

For automated or reproducible screenshots of UI flows, use Playwright:

```ts
// In your Playwright test or script
await page.screenshot({ path: 'screenshots/my-feature.png', fullPage: true });
```

Run Playwright tests with:

```bash
pnpm run test:e2e
```

See the [e2e test directory](packages/e2e/) for examples of existing screenshot usage.

### Screenshot checklist for pull requests

Before marking a PR as ready for review, confirm:

- [ ] Screenshots attached or linked for all UI/UX changes
- [ ] Before/after screenshots provided for changes to existing UI
- [ ] Screenshots uploaded to the [shared Google Drive folder](https://drive.google.com/drive/folders/ci-hub-screenshots) when relevant to marketing or documentation

---

## Issue Templates

When opening a bug report or feature request, use the provided issue templates. They include a **Screenshots** section that clarifies what is required for each type of ticket.

---

## Pull Requests

- Reference the related issue number in the PR description (e.g. `Closes #123`).
- Keep changes focused — one logical change per PR.
- Ensure the CI checks pass before requesting review.
