---
name: visual-regression
description: Capture, compare, and update CI-Hub visual regression baselines. Use when UI layout changes.
---

# Visual Regression — CI-Hub

## Paths

- Specs: `e2e/visual/`
- Baselines: `e2e/screenshots/baselines/` (tracked in git)
- Actual/diff: `e2e/screenshots/actual/`, `diff/` (gitignored)
- Helper: `e2e/helpers/screenshot.ts` (pixelmatch)

## Update baselines (intentional UI change)

```bash
UPDATE_VISUAL_BASELINES=1 pnpm run test:visual
git add e2e/screenshots/baselines/
```

## Compare (CI / pre-PR)

```bash
pnpm run test:visual
```

On failure, inspect `e2e/screenshots/diff/<name>.png`.

## Agent workflow

1. If UI change is correct → update baselines with `UPDATE_VISUAL_BASELINES=1`
2. If regression is a bug → fix code, re-run without update
3. Document baseline updates in session worksheet

## Thresholds

Default threshold in `screenshot.ts` compare: 5% mismatched pixels. Visual specs may pass stricter per-test thresholds.

See [docs/agent/TESTING.md](../../docs/agent/TESTING.md).
