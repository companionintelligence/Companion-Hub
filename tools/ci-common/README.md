# CI-Common tooling (maintainers only)

You do not need this directory to install, build, test, or run the Hub. `pnpm install` at the repo
root needs no registry token.

The Hub's brand files are copies of three packages from the private CI-Common repository:

| Package | What the Hub uses | Where the copy lives |
|---|---|---|
| `@companionintelligence/tokens` | `src/globals.css` — the design-token layer | `packages/frontend/src/styles/ci-tokens.css` |
| `@companionintelligence/assets` | 8 logo and icon files; `logos/app-icon-source.png` for `tauri icon` | `packages/frontend/public/` (the icon source is not copied) |
| `@companionintelligence/config` | the `ci-lint-canon` bin | — |

CI-Common publishes them to GitHub Packages, whose npm registry requires a token even to read. So
they live here, in a separate pnpm root that the workspace never installs, and only the commands
that check or refresh the copies need them.

## Install

You need read access to CI-Common's packages: a GitHub token with the `read:packages` scope.

```bash
NODE_AUTH_TOKEN="$(gh auth token)" pnpm run ci-common:install
```

If `gh auth token` lacks the scope, run `gh auth refresh -s read:packages` first.

## Commands that need it

| Command | What it does |
|---|---|
| `pnpm run lint:canon` | Fails if a committed copy differs from the pinned package, or if any `--primary` drifts off the canon |
| `pnpm --filter frontend brand:sync` | Rewrites every committed copy from the pinned packages |
| `pnpm --filter desktop icons`, `pnpm --filter mobile icons` | Regenerates the Tauri icon sets from `app-icon-source.png` |

`brand:sync` and `brand:check` also take `--from <CI-Common checkout>` to compare against a local
clone instead of the installed packages.

## Updating the brand

1. Bump the version in [`package.json`](package.json), then run
   `NODE_AUTH_TOKEN="$(gh auth token)" pnpm --dir tools/ci-common install` to update the lockfile.
2. Run `pnpm --filter frontend brand:sync`.
3. Commit `package.json`, `pnpm-lock.yaml`, and the rewritten copies together.

Never edit a copy by hand. A hand-kept copy is what drifted before; see
[`docs/UI-STYLE-GUIDE.md`](../../docs/UI-STYLE-GUIDE.md).
