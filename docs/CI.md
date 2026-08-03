# Running CI for this repo

Automatic workflow triggers in this repository are **gated**: pushing does not
start a GitHub-hosted run any more. Checks run on local hardware, and the
workflows that remain are started deliberately.

Why: GitHub Actions was costing the org $563/month, almost all of it hosted
compute for checks that run just as well on hardware we already own.

Starting a gated workflow needs the [`gh` CLI](https://cli.github.com) and push
access. `--ref` matters - the workflow file is read from that branch, so a
workflow that only exists on your feature branch must be dispatched against it.

Full cross-repo runbook: `CI-Local-CICD/RUNBOOK.md` (regenerate with
`ci-local docs`). This file is generated - do not hand-edit.

---

Default branch: `dev`

### Test locally

```bash
ci-local run --repo CI-Hub
```

Equivalent to:

```bash
pnpm install --frozen-lockfile
pnpm run lint
pnpm run tsc
pnpm run test
pnpm run build
```

### Run a check workflow on GitHub

**Agent Gates** — `agent-gates.yml`

```bash
gh workflow run agent-gates.yml --repo companionintelligence/CI-Hub --ref dev
```

**App Catalog Fleet Tests** — `app-catalog-fleet.yml`

```bash
gh workflow run app-catalog-fleet.yml --repo companionintelligence/CI-Hub --ref dev -f mode=full -f batch=0 -f server=core-1
```

Required inputs: `mode` (Test mode)

**Build and Push Container** — `build-container.yml`

```bash
gh workflow run build-container.yml --repo companionintelligence/CI-Hub --ref dev -f environment=<choice> -f tag=<string>
```

Required inputs: `environment` (Environment to deploy to)

**Hub CI** — `ci.yml`

```bash
gh workflow run ci.yml --repo companionintelligence/CI-Hub --ref dev
```

**CodeQL - Code Quality** — `codeql.yml`

```bash
gh workflow run codeql.yml --repo companionintelligence/CI-Hub --ref dev
```

**Dependency Review** — `dependency-review.yml`

```bash
gh workflow run dependency-review.yml --repo companionintelligence/CI-Hub --ref dev
```

**Desktop Build** — `desktop-build.yml`

```bash
gh workflow run desktop-build.yml --repo companionintelligence/CI-Hub --ref dev
```

**Desktop Tests** — `desktop-tests.yml`

```bash
gh workflow run desktop-tests.yml --repo companionintelligence/CI-Hub --ref dev
```

**E2E Extended** — `e2e-extended.yml`

```bash
gh workflow run e2e-extended.yml --repo companionintelligence/CI-Hub --ref dev
```

**Fleet E2E Tests** — `e2e-fleet.yml`

```bash
gh workflow run e2e-fleet.yml --repo companionintelligence/CI-Hub --ref dev -f server=core-6 -f test_suite=all
```

Required inputs: `server` (Target server), `test_suite` (Test suite to run)

**E2E MCP** — `e2e-mcp.yml`

```bash
gh workflow run e2e-mcp.yml --repo companionintelligence/CI-Hub --ref dev
```

**E2E Platform Tests** — `e2e-platform.yml`

```bash
gh workflow run e2e-platform.yml --repo companionintelligence/CI-Hub --ref dev
```

**E2E Tests** — `e2e.yml`

```bash
gh workflow run e2e.yml --repo companionintelligence/CI-Hub --ref dev
```

**Integraton tests** — `integration-tests.yml`

```bash
gh workflow run integration-tests.yml --repo companionintelligence/CI-Hub --ref dev
```

**PR Compliance** — `pr-compliance.yml`

```bash
gh workflow run pr-compliance.yml --repo companionintelligence/CI-Hub --ref dev
```

**Secret Scan** — `secret-scan.yml`

```bash
gh workflow run secret-scan.yml --repo companionintelligence/CI-Hub --ref dev
```

### Cut a release

**Desktop Release** — `desktop-release.yml`

```bash
gh workflow run desktop-release.yml --repo companionintelligence/CI-Hub --ref dev -f tag=<string> -f prerelease=true -f environment=dev -f platforms=all
```

Required inputs: `tag` (Release tag (e.g. v0.2.27))

**Nightly Release** — `nightly-release.yml`

```bash
gh workflow run nightly-release.yml --repo companionintelligence/CI-Hub --ref dev
```

**Publish package managers** — `publish-package-managers.yml`

```bash
gh workflow run publish-package-managers.yml --repo companionintelligence/CI-Hub --ref dev -f tag=<string>
```

Required inputs: `tag` (Release tag (e.g. v0.2.28))

**Auto Semver Tag** — `semver-tag.yml`

```bash
gh workflow run semver-tag.yml --repo companionintelligence/CI-Hub --ref dev -f bump=<string>
```
