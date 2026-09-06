# Contributing to Companion Hub

This guide covers conventions for issues and pull requests.

## Contents

- [Setup](#setup)
- [Writing style](#writing-style)
- [Code structure](#code-structure)
- [AI agents](#ai-agents)
- [Screenshot requirements](#screenshot-requirements)
- [Issue templates](#issue-templates)
- [Pull requests](#pull-requests)

## Setup

See [`docs/DEVELOPMENT_SETUP.md`](docs/DEVELOPMENT_SETUP.md). It covers the prerequisites, the two
installs that fail without them (`pnpm install` needs `NODE_AUTH_TOKEN`; `cargo test` needs the GTK
and WebKit headers), and the known-good test baselines to compare against.

Automatic CI triggers are gated, so run `pnpm run check:pr` locally before requesting review —
nothing runs it for you on push. See [`docs/CI.md`](docs/CI.md).

## Writing style

English docs and human-facing comments follow the [Google developer documentation style guide](https://developers.google.com/style). See [`docs/writing-style.md`](docs/writing-style.md) and the doc map in [`docs/README.md`](docs/README.md).

## Code structure

### No barrel files

Biome's `noBarrelFile` and `noReExportAll` are warnings, and `lint:ci` runs `--error-on-warnings`, so
an `index.ts` that only re-exports fails CI. Import from the module that owns the symbol.

### One concern per file

When a file grows past roughly 300 lines, or starts serving two audiences, split it along the seam
rather than adding another section. The patterns already in the tree:

| Area | Pattern |
|---|---|
| `cihub` CLI | One `scripts/lib/cli-<concern>.ts` per command group; `scripts/lib/cli-dispatch.ts` routes argv to the module that owns each handler |
| Backend modules | `<name>.module.ts`, `.controller.ts`, `.service.ts`, with focused sibling services split out rather than growing one class |
| Backend helpers | `<domain>.helpers.ts` or `<domain>.util.ts`, tested from `__tests__/` |
| Lifecycle commands | One file per command under `app-lifecycle/commands/`, with shared steps as free functions the base class delegates to |
| Adapters | One file per implementation plus a shared interface, as in `inference/backends/` |

### Splitting a base class

Prefer free functions with explicit dependency parameters over mixins or deeper inheritance. Keep a
thin wrapper method on the class when subclasses call it as `this.<name>()` or tests spy on it —
moving such a member off the prototype silently breaks instance dispatch. Where an extracted function
needs to call back into the class, pass the callback in rather than importing the sibling directly,
so a subclass override or a test spy still wins.

### Tests

Tests live in a sibling `__tests__/` directory as `<subject>.test.ts`. A test must fail when the
behavior it names is broken — asserting only that a mock received the argument you just passed it is
worse than no test, because it reads as coverage. Run [`/test-audit`](.claude/skills/test-audit)
before a large refactor.

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
