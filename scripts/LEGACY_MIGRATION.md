# Legacy migration scripts

These shell scripts remain for **historical in-place upgrades** from the Runtipi-era CLI layout (`runtipi-cli` / older volume names). New installs should use `cihub` / `pnpm run dev` / the desktop app.

Runtime code accepts the legacy `RUNTIPI_*` / `TIPI_*` environment aliases and the `runtipi` Docker project and `runtipi_*` volume names, so upgraded appliances read their existing config and uninstall cleanly. CI-OS still writes `RUNTIPI_*` today (`CI-OS/core/lib/ci-hub.sh`). Do not reintroduce private Tailscale inventories or operator PII into the tip (companionintelligence/CI-Hub#1210).

> **Careful with the `RUNCIHUB_*` / `runcihub` spellings, and with `CIHUB_DATA_DIR` /
> `CIHUB_APP_DIR` / `CIHUB_APP_DATA_DIR`.** They are not a real earlier generation of names —
> nothing was ever shipped or installed under them. #1143 (`c88a83580`) renamed "Runtipi" to
> "CIHub" by substring and rewrote the *legacy aliases* along with everything else, turning
> `RUNTIPI_` into `RUNCIHUB_` and `TIPI_` into `CIHUB_`. Because a legacy alias exists precisely
> to match what old installs already set, renaming it pointed every compat path at a variable
> nothing sets. Four sites broke this way and were fixed on 2026-09-21: the backend's
> `LEGACY_ENV_MAP`, `resolveDataDir` in `packages/backend/src/common/constants.ts`, the
> `{{RUNTIPI_APP_ID}}` label substitution in `service.builder.ts`, and the project/volume names
> in `hub-cleanup-lib.ts`. The `RUNCIHUB_*` spellings are still accepted because they shipped in
> releases from v0.2.60 and cost nothing to keep — but when adding a compatibility alias, the
> name that matters is the `RUNTIPI_*` / `TIPI_*` one. Do not "tidy up" by dropping it.
>
> **This does not apply to every `CIHUB_*` variable.** `CIHUB_POSTGRES_PASSWORD`,
> `CIHUB_CLAIM_EMAIL`, `CIHUB_BUILD_VERSION` and `CIHUB_BUILD_REVISION` are current,
> deliberately chosen names introduced after the rename — they are read throughout the CLI and
> documented in [`docs/CLI.md`](../docs/CLI.md). Leave them alone.

| Script | Purpose |
|--------|---------|
| `update-2.0.0-to-3.0.0.sh` | Older Hub 2.x → 3.x migration |
| `update-3.0.0-to-4.0.0.sh` | Older Hub 3.x → 4.x migration |
| `temp-update-3.0.0-to-4.0.0-beta.sh` | Beta migration path (if present) |
| `migrate-to-named-volumes.sh` | Volume layout migration |
| `unsafe-cleanup.sh`, `nuke.sh` | Destructive legacy cleanup — use `cihub uninstall` instead |

`scripts/hub-cleanup-lib.ts` targets the Docker project names in its exported `HUB_STACK_PROJECT_NAMES` (`ci-os-hub`, `ci-hub`, `runtipi`, `runcihub`) and the `runtipi_*` / `runcihub_*` volume prefixes, so uninstall removes leftovers from upgraded appliances. A compose project name is fixed when the stack is created and cannot be renamed in place, which is why the old names stay in that list.

Do not delete these without confirming no active appliances depend on them.
