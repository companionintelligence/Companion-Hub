# Compatibility Notes

This repository uses **Companion Hub** / **CI-Hub** as the current product and repository naming. Some legacy identifiers still exist because published artifacts, runtime compatibility, or migration paths still depend on them.

## Current names vs compatibility-only names

| Current name | Compatibility-only name | Where it still appears | Why it still exists |
| --- | --- | --- | --- |
| Companion Hub / CI-Hub | `ci-os-hub` | container names, image tags, some workflow/runtime internals | existing deployment and registry surfaces still consume those identifiers |
| `companionintelligence/CI-Hub` | `companionintelligence/CI-OS-Hub` | historical links and redirects | older URLs may still redirect, but new docs should use `CI-Hub` |
| `@ci-hub/common` | `@runtipi/common` | older package references | legacy naming should be treated as stale documentation, not the current package name |
| Companion Hub installer flow | `runtipi-cli` | install/update scripts and release assets | the dedicated CI CLI has not shipped yet, so the published compatibility binary name remains in use |
| Companion Hub runtime directory | `runtipi/` | installer-created working directory | kept to avoid breaking the existing CLI/update path until the CLI rename is complete |

## Rules for new documentation and UX copy

- Prefer **Companion Hub** for product copy.
- Prefer **CI-Hub** for repository references.
- Treat legacy names as compatibility surfaces that should be called out explicitly, not used as the default story.
- If a legacy name is still required, explain why nearby or link back to this document.

## Related docs

- [README](../README.md)
- [Developer Setup](./DEVELOPER-SETUP.md)
- [Release Architecture](./RELEASE-ARCHITECTURE.md)
