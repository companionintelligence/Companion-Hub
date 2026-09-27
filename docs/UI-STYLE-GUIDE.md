# Companion Intelligence UI style guide

>
> **Repo:** CI-Hub · **Surface:** `packages/frontend` (React web + Tauri desktop)
> **Last audited:** 2026-06-13

This document has three parts:

- **Part I — Canonical design system** is the shared, org-wide source of truth and
  lives only in CI-Common (`styles/UI-STYLE-GUIDE.md`); this file links to it.
- **Part II — This repo (CI-Hub)** documents how this repo implements the canon, where the
  files live, and any sanctioned local extensions.
- **Part III — Drift & remediation (CI-Hub)** is the actionable list of where this repo
  currently diverges from canon, with recommended fixes.

---

# Part I — canonical design system (shared)

**Part I lives in CI-Common and nowhere else:**
[`CI-Common/styles/UI-STYLE-GUIDE.md`](https://github.com/companionintelligence/CI-Common/blob/main/styles/UI-STYLE-GUIDE.md).
The token values are `@companionintelligence/tokens` (`styles/tokens/src/tokens.json`,
the one hand-edited source). `packages/frontend/src/styles/globals.css` imports
`ci-tokens.css`, a byte-for-byte copy of that package's `globals.css` at the version
pinned in [`tools/ci-common/package.json`](../tools/ci-common/package.json). It is
committed so a clone builds without a GitHub Packages token, and it is never edited by
hand: a hand-kept copy is what drifted (this file said `--primary: #0f717a` for a month
after the canon moved to `#0a6358`). `pnpm run lint:canon` fails if the copy differs
from the pinned package; `brand:sync` rewrites it. See
[`tools/ci-common/README.md`](../tools/ci-common/README.md). How to consume every
part of the canon: [`CI-Common/CONSUMING.md`](https://github.com/companionintelligence/CI-Common/blob/main/CONSUMING.md).

# Part II — this repository (Hub)

**Surface:** `packages/frontend` — React 19 + React Router 7 + TanStack Query, bundled with Vite,
also packaged as a Tauri 2 desktop app.

### File map

| Concern                         | Path                                                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Global tokens & base layer      | `packages/frontend/src/styles/globals.css`                                                           |
| Canon token copy (do not edit)  | `packages/frontend/src/styles/ci-tokens.css`                                                         |
| Tailwind config                 | `packages/frontend/tailwind.config.ts`                                                               |
| App-shell CSS (tooltip, layout) | `packages/frontend/src/app.css`                                                                      |
| App grid layout                 | `packages/frontend/src/styles/app-grid.css`                                                          |
| `cn()` util                     | `packages/frontend/src/lib/utils.ts`                                                                 |
| UI primitives                   | `packages/frontend/src/components/ui/`                                                               |
| Button                          | `packages/frontend/src/components/ui/Button/Button.tsx`                                              |
| Theme provider                  | `packages/frontend/src/components/providers/theme/theme-provider.tsx`                                |
| Auto/seasonal theme             | `packages/frontend/src/components/providers/theme/auto-theme-provider.tsx`, `packages/frontend/src/lib/theme/theme.ts` |
| Theme-base selector             | `packages/frontend/src/modules/settings/components/theme-base-selector/`                             |
| Font load                       | `packages/frontend/src/root.tsx` (Google Fonts `links`)                                              |

### Conformance to canon

- ✅ Tokens are canon phthalo-mist (`--primary: #0a6358` / `#c5e8dc`), from a verified byte copy
  of `@companionintelligence/tokens/globals.css` (`src/styles/ci-tokens.css`) — never hand-edited.
- ✅ `cn()` is canonical (`twMerge(clsx(inputs))`).
- ✅ Radius, font, custom font-sizes, `.dark` theming, lucide sizing all match canon.
- ✅ Primitives via Radix UI; `glass-container` present.

### Sanctioned local extensions (Hub-only, not canon)

- **Extra Button variants:** `success` (green-600), `warning` (yellow-500), `info` (blue-500).
  These use raw Tailwind palette colors, not tokens. Acceptable as Hub semantics; **prefer
  token-based status colors** if these ever move toward canon.
- **Theme bases:** five selectable neutral palettes (`slate`, `gray`, `zinc`, `neutral`, `stone`)
  via `document.body.dataset.bsThemeBase`. Hub-specific personalization; not part of canon.
- **Seasonal auto-theme:** Christmas theme (Nov 1 – Dec 26), gated behind an `allowAutoThemes`
  flag. Hub-only.
- **Ambient background:** static radial teal gradient on `body` (light + dark) in `globals.css`.
- **Custom scrollbars** and `.no-scrollbar` utility in `globals.css`.
- **Default theme:** Hub follows the canonical default (`system`).

---

# Part III — drift and remediation (Hub)

Concrete deltas from Part I. Severity: 🔴 fix · 🟡 align when convenient · ⚪ informational.

| #   | Severity | Drift                                                                                                                                                                                      | Recommended action                                                                                                                                                                                                          |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H-1 | ✅       | **Resolved:** toasts use `sonner` through `components/ui/Toaster/Toaster.tsx`, the same themed Toaster as the Portal and `@companionintelligence/ui`. | Keep the three copies in step until the Hub consumes `@companionintelligence/ui`. |
| H-2 | 🟡       | **No `badge.tsx`.** Canon includes Badge; Portal already has it.                                                                                                                           | Port Portal's `badge.tsx` (4 variants) into `src/components/ui/` so badges are consistent.                                                                                                                                  |
| H-3 | ⚪       | **Button has non-canon variants** `success`/`warning`/`info` using raw `green/yellow/blue` Tailwind colors.                                                                                | Keep as documented Hub extension. If promoted to canon later, back them with tokens (`--success`, `--warning`, `--info`).                                                                                                   |
| H-4 | ⚪       | **No `components.json`** — UI was hand-rolled, not generated by the shadcn CLI. Component folder casing is `ui/Button/Button.tsx` (PascalCase) vs the canonical lowercase `ui/button.tsx`. | Optional: add a `components.json` and normalize file casing to lowercase to match shadcn/Portal and ease future `npx shadcn add`.                                                                                           |
| H-5 | ⚪       | **Token source notation:** `globals.css` authors the shadcn token set in `oklch()` (canon); `--tblr-*` overrides remain hex. | No action. |
| H-6 | ⚪       | **Ambient background differs** from Portal (static gradient vs animated cursor-glow).                                                                                                      | Intentional per-surface; no action. Listed for awareness.                                                                                                                                                                   |
| H-7 | ⚪       | **Primitives are Radix-only**; Portal is adopting Base UI.                                                                                                                                 | Track org direction. No action until a shared `@ci/ui` package forces a choice.                                                                                                                                             |

> **Note:** the only behavioral convergence left to schedule is **H-2 (badge)**;
> **H-1 (sonner)** is done.

---

## Appendix

No copy-paste token block here on purpose — see Part I above: a copy of the canon
values is exactly what drifted in this file before (`--primary: #0f717a` long after
canon moved to `#0a6358`; the chart series, sidebar, and several other tokens had
drifted the same way). The live values are always
[`packages/frontend/src/styles/globals.css`](../packages/frontend/src/styles/globals.css)
— that file imports `ci-tokens.css` (the verified copy of
`@companionintelligence/tokens/globals.css`) and defines nothing of its own beyond the
Hub-only extensions in Part II, so it disagrees with canon only by lagging a version. For the values themselves, read
[`CI-Common/styles/colors.md`](https://github.com/companionintelligence/CI-Common/blob/main/styles/colors.md)
(generated from `tokens.json`, always current) rather than either file.

`cn()` (identical in every repo):

```ts
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```
