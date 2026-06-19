# Legacy Runtipi migration scripts

These shell scripts remain for **historical in-place upgrades** from the Runtipi-era CLI (`runtipi-cli`). New installs should use `cihub` / `pnpm run dev` / the desktop app.

| Script | Purpose |
|--------|---------|
| `update-2.0.0-to-3.0.0.sh` | Runtipi 2.x → 3.x migration |
| `update-3.0.0-to-4.0.0.sh` | Runtipi 3.x → 4.x migration |
| `temp-update-3.0.0-to-4.0.0-beta.sh` | Beta migration path (if present) |
| `migrate-to-named-volumes.sh` | Volume layout migration |
| `unsafe-cleanup.sh`, `nuke.sh` | Destructive legacy cleanup — use `cihub uninstall` instead |

`scripts/hub-cleanup-lib.ts` still targets Docker project/volume names `runtipi` / `runtipi_*` so uninstall can remove leftovers from upgraded appliances.

Do not delete these without confirming no active appliances depend on them.
