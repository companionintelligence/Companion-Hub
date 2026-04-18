# Release Architecture

This is the operator-facing release map for CI-Hub. It replaces the older `CI-CD-PIPELINE.md` narrative with the current release topology: what triggers each workflow, which artifacts it produces, which environments it affects, and who is expected to act.

## Release surfaces

CI-Hub currently has two release surfaces:

1. **Hub container releases** for the self-hosted product runtime.
2. **Companion Hub Desktop releases** for the native Tauri shell.

## Environment flow

| Branch or trigger | Primary workflow | Result |
| --- | --- | --- |
| Pull request | `Hub CI`, `Integration Tests`, `PR Compliance` | Validates code before merge |
| Push to `dev` | `Build and Publish Hub Container` | Publishes `ghcr.io/...:dev`, updates dev environment |
| Push to `staging` | `Tag Staging Release` | Computes and pushes the next semver tag |
| Push tag `v*` | `Publish Hub Release` | Builds release images, creates GitHub release, runs e2e |
| Scheduled/manual nightly | `Nightly Release` | Publishes nightly container artifacts |
| Manual dispatch | `Desktop Release` | Builds desktop installers and publishes a desktop release |

## Workflow map

| Workflow | File | Trigger | Main artifacts | Operator responsibility |
| --- | --- | --- | --- | --- |
| Hub CI | `.github/workflows/ci.yml` | PRs, pushes to `dev` | lint/type/test status | Keep the base branch healthy |
| Integration Tests | `.github/workflows/integration-tests.yml` | PRs, pushes to `dev`, reusable calls | integration test status | Investigate backend/runtime regressions |
| PR Compliance | `.github/workflows/pr-compliance.yml` | PR open/edit/sync | policy status | Keep PRs linked to issues |
| Build and Publish Hub Container | `.github/workflows/build-container.yml` | pushes to `dev`/`staging`/`main`, manual, reusable | multi-arch GHCR images; optional portal registry copies; Cloudflare Containers deploy | Maintain environment secrets and approve protected production deploys |
| Tag Staging Release | `.github/workflows/semver-tag.yml` | push to `staging`, manual | git tag `vX.Y.Z` | Promote vetted staging commits into a release tag |
| Publish Hub Release | `.github/workflows/release.yml` | semantic version tags | release GHCR images, `latest.json`, GitHub release, e2e gate | Treat the pushed tag as the source of truth for a Hub release |
| Nightly Release | `.github/workflows/nightly-release.yml` | scheduled/manual | nightly container images | Keep a rolling pre-release build available |
| Desktop Build | `.github/workflows/desktop-build.yml` | manual, selected `dev` pushes | test/build desktop installers | Validate desktop packaging changes |
| Desktop Release | `.github/workflows/desktop-release.yml` | manual | signed desktop installers, GitHub release, optional R2 upload | Coordinate signing credentials and public desktop distribution |
| Fleet E2E Tests | `.github/workflows/e2e-fleet.yml` | scheduled/manual | fleet test reports | Validate field-like environments |
| App Catalog Fleet Tests | `.github/workflows/app-catalog-fleet.yml` | manual | catalog QA reports | Validate marketplace app breadth |

## Hub container release sequence

### 1. Validate on pull requests

PRs are expected to pass:

- `Hub CI`
- `Integration Tests`
- `PR Compliance`

These workflows are the merge gate for normal code changes.

### 2. Publish dev builds from `dev`

A push to `dev` runs `Build and Publish Hub Container`, which:

- builds a multi-arch container image
- pushes the `dev` tag to GHCR
- optionally copies the image into the portal registry
- deploys the matching Cloudflare Containers environment

### 3. Promote from `staging` into a semver tag

A push to `staging` runs `Tag Staging Release`.

That workflow:

- inspects commits since the last semver tag
- chooses a patch/minor/major bump
- updates `package.json`
- creates and pushes a new `vX.Y.Z` tag

### 4. Build and publish the tagged release

Pushing a semver tag triggers `Publish Hub Release`, which:

- classifies the tag as `alpha`, `beta`, or stable `release`
- reruns unit and integration coverage
- builds and pushes release-tagged multi-arch images
- writes `latest.json`
- creates the GitHub release
- runs e2e verification against the tagged build
- removes the prerelease flag for stable releases after e2e passes

## Desktop release sequence

Desktop releases are intentionally separate from Hub container releases.

`Desktop Release` is manually dispatched and is responsible for:

- building the Tauri desktop app for the selected targets
- applying signing/notarization where credentials are available
- publishing installers to GitHub Releases
- optionally uploading public production artifacts to R2

For signing prerequisites and secrets, see [DESKTOP-RELEASE-SIGNING.md](./DESKTOP-RELEASE-SIGNING.md).

## Artifact map

| Artifact | Produced by | Notes |
| --- | --- | --- |
| `ghcr.io/companionintelligence/ci-hub:dev` | Build and Publish Hub Container | dev branch output |
| `ghcr.io/companionintelligence/ci-hub:staging` | Build and Publish Hub Container | staging branch output |
| `ghcr.io/companionintelligence/ci-hub:latest` | Build and Publish Hub Container / Publish Hub Release | production channel |
| `ghcr.io/companionintelligence/ci-hub:vX.Y.Z` | Publish Hub Release | immutable semver release |
| `latest.json` | Publish Hub Release | release metadata for clients and automation |
| desktop installers (`.dmg`, `.msi`, `.exe`, `.deb`, `.rpm`, `.AppImage`) | Desktop Build / Desktop Release | desktop-only distribution surface |

## Operator checklist

- Keep `dev`, `staging`, and `production` GitHub environments configured.
- Maintain Cloudflare deploy secrets for container publishing.
- Maintain portal registry credentials if portal mirroring is expected.
- Keep desktop signing credentials scoped to the desktop release workflow.
- Use the workflow names above when discussing release state so docs and the Actions UI stay aligned.
