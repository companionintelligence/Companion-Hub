# Release Readiness Matrix

This document defines the required verification gates for CI-Hub release surfaces. A release is only considered ready when every applicable gate is green.

Part of issue [#397](https://github.com/companionintelligence/CI-Hub/issues/397). See [RELEASE-ARCHITECTURE.md](./RELEASE-ARCHITECTURE.md) for the overall workflow topology.

## Gate overview

| Gate | Enforced by | Blocks |
| --- | --- | --- |
| Lint, docs, type-check, unit tests | `Hub CI` (`ci.yml`) | Pull requests, tagged releases, desktop release builds |
| Backend integration tests | `Integration Tests` (`integration-tests.yml`) | Pull requests, tagged releases |
| Launch-critical E2E verification | `E2E Tests` (`e2e.yml`) | Pull requests, tagged releases, nightly images, desktop release builds |
| PR issue traceability | `PR Compliance` (`pr-compliance.yml`) | Pull request review flow |

## Launch-critical E2E matrix

The reusable `e2e.yml` workflow runs the Playwright suite in `e2e/`. These active suites are now the required launch-readiness gate.

### Hub state verification (`e2e/launch-path.spec.ts`)

| State | What it proves |
| --- | --- |
| Fresh Unregistered | A brand-new Hub reports healthy services, exposes a device ID, and gates the UI behind registration |
| Locally Ready | A registered Hub serves health and data status, shows login, and loads dashboard + app store after auth |
| Publicly Delayed | Local recovery remains usable while public routing is still propagating |
| Degraded | Local login and health remain available while portal APIs degrade |

### Scenario verification (`e2e/launch-path.spec.ts`)

| Scenario | What it proves |
| --- | --- |
| First Install Path | First visit reaches account registration and the first-user flow completes |
| App Lifecycle Reconciliation | Stuck lifecycle state is surfaced without breaking dashboard access |
| Multi-Store | Multiple stores are seeded and rendered consistently |

### Additional required suites (`e2e/*.spec.ts`)

| Suite | File | Coverage area |
| --- | --- | --- |
| Authentication | `auth.spec.ts` | Account registration and login flow |
| First-Time User Experience | `ftue.spec.ts` | First-run registration handoff and onboarding redirect |
| Dashboard | `dashboard.spec.ts` | Authenticated dashboard rendering and key metrics |
| App Store Browsing | `app-store-browsing.spec.ts` | Store UI, search, and category browsing |
| Store Entry & Search | `apps.spec.ts` | Primary app-store navigation and search affordances |
| App Lifecycle | `app-lifecycle.spec.ts` | Seeded reconciliation baseline for apps stuck mid-lifecycle |
| Settings | `settings.spec.ts` | Settings tabs and security configuration surface |
| Navigation | `navigation.spec.ts` | Primary navigation and logout path |
| Error States | `error-states.spec.ts` | Auth validation and degraded-login error feedback |
| Health API | `health-api.spec.ts` | Backend health and data-health endpoints |
| Dev Mode | `dev-mode.spec.ts` | Multi-store configuration visibility |
| Multi-Store Context | `multi-store-context.spec.ts` | Store-specific routing and context preservation |

## Release surface → gate mapping

### Pull requests

- `Hub CI` (`ci.yml`)
- `Integration Tests` (`integration-tests.yml`)
- `E2E Tests` (`e2e.yml`)
- `PR Compliance` (`pr-compliance.yml`)

These are the reviewable readiness signals before merge. `E2E Tests` now runs directly on pull requests instead of only as a downstream release-time check.

### Hub container release (`release.yml`, triggered by `v*` tags)

```text
determine-release-type
  ├── unit-tests (ci.yml)          ─┐
  ├── integration-tests             │
  └── e2e-gate (e2e.yml)           ─┘ all must pass before build-images
               │
          build-images
               │
          publish-release
               │
          promote (stable only)
```

### Nightly release (`nightly-release.yml`, scheduled/manual)

```text
e2e-gate (e2e.yml)
      │
 build-images
      │
 update-manifest
```

### Desktop release (`desktop-release.yml`, manual dispatch)

```text
unit-tests (ci.yml)    ─┐
e2e-tests (e2e.yml)    ─┘ both must pass before build-container
         │
   build-container
         │
       build
         │
      release
```

## Deferred verification

Some infrastructure-heavy suites still live under `e2e/future/` and remain excluded from the required CI gate by `playwright.config.ts`:

- `future/app-store-lifecycle.spec.ts`
- `future/cloud-account.spec.ts`
- `future/cloudflare.spec.ts`
- `future/tailscale.spec.ts`

These stay transparent and auditable here: they are not part of the required GitHub-hosted gate yet, and they continue to belong to fleet/manual infrastructure runs until the underlying environments are available in CI.

## Local verification

Run the same categories locally before pushing a release-gating change:

```bash
pnpm run docs:check
pnpm run check:all
pnpm run test:integration
pnpm run test:e2e
```
