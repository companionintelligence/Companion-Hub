# Contributing to Companion Hub

This guide covers conventions for issues and pull requests.

## Contents

- [Writing style](#writing-style)
- [AI agents](#ai-agents)
- [Screenshot requirements](#screenshot-requirements)
- [Issue templates](#issue-templates)
- [Pull requests](#pull-requests)

## Writing style

English docs and human-facing comments follow the [Google developer documentation style guide](https://developers.google.com/style). See [`docs/writing-style.md`](docs/writing-style.md) and the doc map in [`docs/README.md`](docs/README.md).

## AI agents

If you are a coding agent in this repo, read [`AGENTS.md`](AGENTS.md) first, then follow [`docs/agent/AGENT_WORKFLOW.md`](docs/agent/AGENT_WORKFLOW.md).

### Session worksheet

Commit a filled [`SESSION_WORKSHEET.template.md`](docs/agent/SESSION_WORKSHEET.template.md) under `docs/agent/sessions/` with your changes. After merge, tag `agent-session/<worksheet-slug>`.

### Validation

Run `bin/agent-validate-shift` (or `pnpm run agent:validate`) before marking agent work done. See [`docs/agent/END_OF_SHIFT.md`](docs/agent/END_OF_SHIFT.md).

## Screenshot requirements

For UI and UX work, include screenshots in the issue or pull request as part of acceptance criteria.

### When screenshots are required

| Change type | Requirement |
|---|---|
| UI/UX change | Required — before/after screenshots |
| New UI feature | Required — key screens |
| Bug with a visible symptom | Required — screenshot of the issue |
| Backend-only change | Optional |
| Documentation-only change | Optional |

### Where to put screenshots

Attach screenshots to the GitHub issue or pull request. That is the primary place reviewers look.

Organize filenames by issue number or feature name, for example:

```
issue-123-login-redesign-before.png
issue-123-login-redesign-after.png
```

### Taking screenshots with Playwright

```ts
await page.screenshot({ path: 'screenshots/my-feature.png', fullPage: true });
```

```bash
pnpm run test:e2e
```

See [`e2e/`](e2e/) for existing examples.

### Screenshot checklist for pull requests

Before marking a PR ready for review:

- [ ] Screenshots attached for all UI/UX changes
- [ ] Before/after screenshots for changes to existing UI

## Issue templates

Use the provided bug and feature templates. They include a Screenshots section that states what each ticket type needs.

## Pull requests

- Reference the related issue (`Closes #123`).
- Keep one logical change per PR.
- Ensure CI checks pass before requesting review.
