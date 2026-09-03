# Run CI for this repository

Automatic workflow triggers in this repository are **gated**. A push no longer
starts a GitHub-hosted run. Run checks on local hardware, and start the remaining
workflows manually.

GitHub Actions previously cost the organization $563 per month, mostly for
hosted checks that can run on existing hardware.

To start a gated workflow, you need the [`gh` CLI](https://cli.github.com) and
push access. Set `--ref` because GitHub reads the workflow file from that branch.
If a workflow exists only on your feature branch, dispatch it against that branch.

Full cross-repo runbook: `CI-Local-CICD/RUNBOOK.md` (regenerate with
`ci-local docs`). This file is generated. Don't edit it directly.

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

**Agent gates** — `agent-gates.yml`

```bash
gh workflow run agent-gates.yml --repo companionintelligence/CI-Hub --ref dev
```

**Build and push container** — `build-container.yml`

```bash
gh workflow run build-container.yml --repo companionintelligence/CI-Hub --ref dev -f environment=<choice> -f tag=<string>
```

Required input: `environment` (deployment environment)

**Hub CI** — `ci.yml`

```bash
gh workflow run ci.yml --repo companionintelligence/CI-Hub --ref dev
```

**CodeQL code quality** — `codeql.yml`

```bash
gh workflow run codeql.yml --repo companionintelligence/CI-Hub --ref dev
```

**Dependency review** — `dependency-review.yml`

```bash
gh workflow run dependency-review.yml --repo companionintelligence/CI-Hub --ref dev
```

**Desktop build** — `desktop-build.yml`

```bash
gh workflow run desktop-build.yml --repo companionintelligence/CI-Hub --ref dev
```

**Desktop tests** — `desktop-tests.yml`

```bash
gh workflow run desktop-tests.yml --repo companionintelligence/CI-Hub --ref dev
```

**E2E extended** — `e2e-extended.yml`

```bash
gh workflow run e2e-extended.yml --repo companionintelligence/CI-Hub --ref dev
```

**E2E MCP** — `e2e-mcp.yml`

```bash
gh workflow run e2e-mcp.yml --repo companionintelligence/CI-Hub --ref dev
```

**E2E platform tests** — `e2e-platform.yml`

```bash
gh workflow run e2e-platform.yml --repo companionintelligence/CI-Hub --ref dev
```

**E2E tests** — `e2e.yml`

```bash
gh workflow run e2e.yml --repo companionintelligence/CI-Hub --ref dev
```

**Integration tests** — `integration-tests.yml`

```bash
gh workflow run integration-tests.yml --repo companionintelligence/CI-Hub --ref dev
```

**PR compliance** — `pr-compliance.yml`

```bash
gh workflow run pr-compliance.yml --repo companionintelligence/CI-Hub --ref dev
```

**Secret scan** — `secret-scan.yml`

```bash
gh workflow run secret-scan.yml --repo companionintelligence/CI-Hub --ref dev
```

### Cut a release

**Desktop release** — `desktop-release.yml`

```bash
gh workflow run desktop-release.yml --repo companionintelligence/CI-Hub --ref dev -f tag=<string> -f prerelease=true -f environment=dev -f platforms=all
```

Required input: `tag` (release tag, for example `v0.2.27`)

**Nightly release** — `nightly-release.yml`

```bash
gh workflow run nightly-release.yml --repo companionintelligence/CI-Hub --ref dev
```

**Publish package managers** — `publish-package-managers.yml`

```bash
gh workflow run publish-package-managers.yml --repo companionintelligence/CI-Hub --ref dev -f tag=<string>
```

Required input: `tag` (release tag, for example `v0.2.28`)

**Automatic semantic-version tag** — `semver-tag.yml`

```bash
gh workflow run semver-tag.yml --repo companionintelligence/CI-Hub --ref dev -f bump=<string>
```
