# Screen captures

Every PNG in this directory is **generated**. Do not hand-edit or hand-replace them.

```bash
pnpm run docs:screens
```

- Generator: [`e2e/screens/capture-screens.spec.ts`](../../../e2e/screens/capture-screens.spec.ts)
- Config: [`playwright.screens.config.ts`](../../../playwright.screens.config.ts)
- Naming: `<screen>-<theme>[-mobile].png` — themes are `dark` and `light`, mobile is 390×844, desktop is 1440×900
- Screen names match the inventory in [`docs/system/ui-screens.md`](../../system/ui-screens.md)

The script drives the seeded E2E stack (mock Portal, a seeded operator, no installed apps), so these images
contain **no real operator data** — no account address, no tailnet hostname, no API key. That is deliberate: the
tip-scrub policy in [`docs/README.md`](../../README.md) forbids committing any of those, and the Security, Network
and MCP screens all print them on a real appliance.

## Why this README exists

The two screenshot pipelines that came before this one — `scripts/build-ftue-gif.ts` and
`scripts/capture-ci-portal-screenshots.ts` — were deleted as collateral in an unrelated feature PR. Their output
(`docs/ftue.gif`, `docs/ci-portal/*`) stayed committed for months, stale and referenced by no document, so nothing
ever failed and nobody noticed; it has since been removed. Naming the generator next to its output is the cheapest
guard against that happening a third time.

## What is not here, and why

`capture-screens.spec.ts` carries a `SKIPPED` map listing every screen no fixture can currently reach, with the
reason, and prints it at the end of each run. The largest group needs a **running installed app** — which needs
real Docker, a `CI-Marketplace` checkout, Traefik and wildcard DNS. An "installed app" fixture would unlock app
details, app update, custom app details and custom app edit in one go; it is the single highest-leverage addition
to UI coverage.

The spec also fails if the number of PNGs **written by that run** is not exactly what the screen lists imply.
It counts what it wrote, not what is in the directory — the directory always holds the last committed set, so a
directory count could never fall. A silent shortfall would otherwise read as full coverage. Any PNG in the directory
that the run did not write is named in the report, so a renamed screen's old capture does not linger unnoticed.

`pnpm run docs:screens` starts the `db` and `queue` containers from `e2e/docker-compose.e2e.yml` and leaves them
running, as `test:e2e` does. Stop them with `docker compose -f e2e/docker-compose.e2e.yml stop db queue`.
