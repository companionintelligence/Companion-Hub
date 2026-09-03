# Legacy CIHub migration scripts

> Companion Hub was renamed through Tipi → Runtipi → CIHub / RunCIHub → CI-Hub.
> Runtime code still accepts `RUNCIHUB_*` env aliases and `runcihub` Docker project
> names so upgraded appliances uninstall cleanly. Git history that contained Tipi-era
> and fleet material is being squashed before public release
> (companionintelligence/CI-Hub#1210) — do not reintroduce Tipi strings or private
> Tailscale inventories into the tip.

These shell scripts remain for **historical in-place upgrades** from the CIHub-era CLI (`runcihub-cli`). New installs should use `cihub` / `pnpm run dev` / the desktop app.

| Script | Purpose |
|--------|---------|
| `update-2.0.0-to-3.0.0.sh` | CIHub 2.x → 3.x migration |
| `update-3.0.0-to-4.0.0.sh` | CIHub 3.x → 4.x migration |
| `temp-update-3.0.0-to-4.0.0-beta.sh` | Beta migration path (if present) |
| `migrate-to-named-volumes.sh` | Volume layout migration |
| `unsafe-cleanup.sh`, `nuke.sh` | Destructive legacy cleanup — use `cihub uninstall` instead |

`scripts/hub-cleanup-lib.ts` still targets Docker project/volume names `runcihub` / `runcihub_*` so uninstall can remove leftovers from upgraded appliances.

Do not delete these without confirming no active appliances depend on them.
