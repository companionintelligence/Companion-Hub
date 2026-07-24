# Performance Profiling — CI-Hub (Agents)

> **Purpose:** Commands and workflow for agents to profile Hub and app performance.
> **Scope:** Per-app benchmarks, benchmark gate, fleet QA profiling.
> **Gate:** `pnpm run benchmark:gate`
> **Baseline:** `e2e/results/benchmarks/baseline.json`
> **Router:** [AGENTS.md](../../AGENTS.md)
> **Last updated:** 2026-07-12
> **Related:** docs/system/e2e.md, scripts/benchmark-app.ts

---

## Per-app benchmark

```bash
pnpm exec tsx scripts/benchmark-app.ts <app-id>
```

Measures install time, health check latency, memory, CPU, and disk. Results under `e2e/results/benchmarks/`.

Copy latest results for gate comparison:

```bash
cp e2e/results/benchmarks/<app-id>-latest.json e2e/results/benchmarks/latest.json
pnpm run benchmark:gate
```

## Update baseline

After validating representative performance on `dev`:

```bash
cp e2e/results/benchmarks/latest.json e2e/results/benchmarks/baseline.json
git add e2e/results/benchmarks/baseline.json
```

## Fleet QA

For multi-node profiling across the fleet, see [scripts/FLEET_QA.md](../../scripts/FLEET_QA.md) and `.claude/skills/run-fleet-qa/`.

## When agents must run benchmarks

- Backend query or caching changes → benchmark affected hot paths
- Docker lifecycle changes → benchmark install/health metrics
- Before merging perf-sensitive PRs → `pnpm run benchmark:gate` must pass

Regression threshold: 15% worse than baseline (see `scripts/agent/benchmark-gate.ts`).
