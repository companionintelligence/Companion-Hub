# Performance profiling

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

The script measures install time, health check latency, memory, CPU, and disk use. It writes results to `e2e/results/benchmarks/`.

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

Multi-node fleet profiling is private ops (not in this tree). See companionintelligence/CI-Engineering#211.

## When agents must run benchmarks

- Backend query or caching changes → benchmark affected hot paths
- Docker lifecycle changes → benchmark install/health metrics
- Before merging perf-sensitive PRs → `pnpm run benchmark:gate` must pass

Regression threshold: 15% worse than baseline (see `scripts/agent/benchmark-gate.ts`).
