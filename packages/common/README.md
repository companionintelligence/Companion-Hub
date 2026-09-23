# Common package

`@ci-hub/common` provides shared TypeScript types, Zod schemas, and helpers for Companion Hub.

> **Legacy names:** Use `@ci-hub/common` in current code. This package was published as
> **`@runtipi/common`** until 2025 — that is the name in the release history, and it is still a
> live dependency of CI-Docs and CI-Marketplace, so do not assume a `@runtipi/common` reference
> elsewhere in the org is stale.
>
> `CHANGELOG.md` entries say `@runcihub/common`. That name was never published: #1143
> (`c88a83580`) renamed "Runtipi" to "CIHub" by substring and rewrote those historical records
> along with the source, as its own commit body records. Released entries are left as-is rather
> than rewritten a second time; the file header explains the names.
>
> **The changesets setup here is inert.** `@changesets/cli` resolves `.changeset/` from the
> workspace root, and this repo has none — only `packages/common/.changeset/`, which the CLI
> never reads. `changeset status` fails with *"There is no .changeset folder"* from anywhere in
> the repo, and no script or workflow invokes it. That is why the pending changesets sat
> unconsumed from 2025-04-22 onward.
>
> Three of them, naming `@runcihub/common`, were **removed on 2026-09-21**. Reproduced in
> isolation (the folder moved to a repo root, as changesets expects), they fail a second way:
> *"Found changeset cool-dingos-give for package @runcihub/common which is not in the
> workspace"*. Renaming them to `@ci-hub/common` was the wrong fix — simulating it cuts a
> **1.1.0 whose release notes read "Initial release"**, for a package already at 1.0.0 whose
> changelog carries those same three entries five times over, from 0.3.0 to 0.8.0.
>
> `config.json`'s `baseBranch` was also corrected from `main` to `dev`, this repo's real default
> branch. If anyone revives this setup, move the folder to the repo root first — nothing here
> takes effect where it currently sits.
>
> The backend accepts the legacy `RUNTIPI_*` / `TIPI_*` environment aliases, and the
> `RUNCIHUB_*` / `CIHUB_*` spellings the same rename produced. See
> [`scripts/LEGACY_MIGRATION.md`](../../scripts/LEGACY_MIGRATION.md).
