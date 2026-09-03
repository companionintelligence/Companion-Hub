# Frontend package

React Router SPA for Companion Hub. Operators manage marketplace apps, onboarding, settings, and device connectivity from this UI.

## Stack

- React 19 + TypeScript
- React Router 7
- Vite
- Biome (lint/format)
- Vitest + Testing Library

## Commands

From the repo root:

```bash
pnpm install
pnpm --filter @ci-hub/frontend dev
pnpm --filter @ci-hub/frontend test
pnpm --filter @ci-hub/frontend typecheck
```

## Docs

- Living notes: [`docs/system/frontend.md`](../../docs/system/frontend.md)
- UI tokens and patterns: [`docs/UI-STYLE-GUIDE.md`](../../docs/UI-STYLE-GUIDE.md)
- Doc map and writing style: [`docs/README.md`](../../docs/README.md)
