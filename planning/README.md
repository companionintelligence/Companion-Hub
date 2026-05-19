# CI-Hub Planning Documents

Living planning docs for the open epics. Each doc decomposes an epic into concrete workstreams with file paths, sequencing diagrams, risks, acceptance criteria, and rough estimates. They sit alongside the issue tracker rather than replacing it.

## Index

| Doc | Epic | Status | Est. wall-clock |
|---|---|---|---|
| [epic-386-hardening-ftue.md](epic-386-hardening-ftue.md) | [#386](https://github.com/companionintelligence/CI-Hub/issues/386) — Hardening, FTUE & production-readiness | **~88% done**, 1 child issue ([#394](https://github.com/companionintelligence/CI-Hub/issues/394)) open | 3–5 days |
| [epic-418-truth-contract-refactor.md](epic-418-truth-contract-refactor.md) | [#418](https://github.com/companionintelligence/CI-Hub/issues/418) — Post-hardening truth-contract refactor | 0% done, 9 child issues open | 6–8 weeks solo / 3–4 weeks with 2 engineers |
| [epic-472-custom-domains-entri.md](epic-472-custom-domains-entri.md) | [#472](https://github.com/companionintelligence/CI-Hub/issues/472) — Custom domains via Entri (Connect / Monitor / Sell) | No code yet, full spec in epic body | Phase 1: ~6 weeks wall-clock (most of it in CI-Portal); Phase 2: +2 weeks |

## How to use these docs

- **Before starting work on an epic:** read the planning doc and verify the "Open questions" section is resolved. Add a note in the issue if any answers have changed.
- **When opening a PR for an epic's sub-issue:** cite the planning doc's workstream item so reviewers can hold the line on scope.
- **When updating estimates or finding stale info:** edit the doc in place. PR title should be `docs(planning): <epic>: <what changed>`.
- **When an epic closes:** archive its doc by moving to `planning/archive/`. Don't delete — historical context for the next refactor.

## Inter-epic dependencies

```
#386 (almost done)  ──►  #418 (foundation contracts depend on truthful state from #386)
                          │
                          │ (PR-02 readiness/health contract from #418)
                          ▼
                         #472 (Entri custom domains benefits from canonical readiness contract,
                               but does not strictly require it)
```

Recommended order:
1. **Close #386** first — it's nearly done and unblocks #418's foundation.
2. **Land #418 PR-01 + PR-02** in parallel with starting #472 Phase 1 (Portal-side work is on a different repo and can run independently).
3. **#418 PR-03..PR-09** can run alongside #472 implementation; only conflict surface is the readiness/health UI, called out in both docs.

## Related top-level docs

- [`../planning.md`](../planning.md) (if present) — gap analysis across all open PRs/branches/issues, not epic-scoped (added by [PR #514](https://github.com/companionintelligence/CI-Hub/pull/514))
- [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) — system architecture
- [`../docs/PLATFORM_ARCHITECTURE.md`](../docs/PLATFORM_ARCHITECTURE.md) — how Hub, Portal, App Store fit together
