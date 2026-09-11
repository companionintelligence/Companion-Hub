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
the one hand-edited source), which `packages/frontend/src/styles/globals.css` imports.
This repo does not carry a copy: a copy is what drifted (this file said `--primary:
#0f717a` for a month after the canon moved to `#0a6358`). How to consume every
part of the canon: [`CI-Common/CONSUMING.md`](https://github.com/companionintelligence/CI-Common/blob/main/CONSUMING.md).

# Part II — this repository (Hub)

**Surface:** `packages/frontend` — React 19 + React Router 7 + TanStack Query, bundled with Vite,
also packaged as a Tauri 2 desktop app.

### File map

| Concern                         | Path                                                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Global tokens & base layer      | `packages/frontend/src/styles/globals.css`                                                           |
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

- ✅ Tokens are the teal-primary shadcn set (`--primary: #0f717a` / `#abd4d8`). **CI-Hub is the
  reference implementation of the canonical palette.**
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
| H-1 | 🟡       | **Toasts use `react-hot-toast`**, canon is `sonner`. `<Toaster position="bottom-center" />` in `root.tsx`.                                                                                 | Plan a migration to `sonner` for cross-surface consistency. Non-urgent; wrap in a shared `toast` helper first to make the swap mechanical.                                                                                  |
| H-2 | 🟡       | **No `badge.tsx`.** Canon includes Badge; Portal already has it.                                                                                                                           | Port Portal's `badge.tsx` (4 variants) into `src/components/ui/` so badges are consistent.                                                                                                                                  |
| H-3 | ⚪       | **Button has non-canon variants** `success`/`warning`/`info` using raw `green/yellow/blue` Tailwind colors.                                                                                | Keep as documented Hub extension. If promoted to canon later, back them with tokens (`--success`, `--warning`, `--info`).                                                                                                   |
| H-4 | ⚪       | **No `components.json`** — UI was hand-rolled, not generated by the shadcn CLI. Component folder casing is `ui/Button/Button.tsx` (PascalCase) vs the canonical lowercase `ui/button.tsx`. | Optional: add a `components.json` and normalize file casing to lowercase to match shadcn/Portal and ease future `npx shadcn add`.                                                                                           |
| H-5 | ⚪       | **Token source notation:** `globals.css` authors the shadcn token set in `oklch()` (canon); `--tblr-*` overrides remain hex. | No action. |
| H-6 | ⚪       | **Ambient background differs** from Portal (static gradient vs animated cursor-glow).                                                                                                      | Intentional per-surface; no action. Listed for awareness.                                                                                                                                                                   |
| H-7 | ⚪       | **Primitives are Radix-only**; Portal is adopting Base UI.                                                                                                                                 | Track org direction. No action until a shared `@ci/ui` package forces a choice.                                                                                                                                             |

> **Note:** CI-Hub is the closest repo to canon (it _is_ the palette source of truth). The only
> behavioral convergence worth scheduling is **H-1 (sonner)** and **H-2 (badge)**.

---

## Appendix — Canonical token block (copy-paste)

Reference `globals.css` token definitions (CI-Hub is the source of truth for these values):

```css
:root {
  --radius: 0.625rem;
  --background: #f3f3f3;
  --foreground: #010f16;
  --card: #f7f7f9;
  --card-foreground: #041620;
  --popover: #ffffff;
  --popover-foreground: #041620;
  --primary: #0f717a; /* CI teal */
  --primary-foreground: #f8fafc;
  --secondary: #f1f5f9;
  --secondary-foreground: #0a222e;
  --muted: #f1f5f9;
  --muted-foreground: #62748e;
  --accent: #f1f5f9;
  --accent-foreground: #0a222e;
  --destructive: #ee3533;
  --destructive-foreground: #f8fafc;
  --border: #e2e8f0;
  --input: #e2e8f0;
  --ring: #90a1b9;
  --chart-1: #f54900;
  --chart-2: #009689;
  --chart-3: #104e64;
  --chart-4: #ffb900;
  --chart-5: #fe9a00;
  --sidebar: #f8fafc;
  --sidebar-foreground: #020618;
  --sidebar-primary: #0f172b;
  --sidebar-primary-foreground: #f8fafc;
  --sidebar-accent: #f1f5f9;
  --sidebar-accent-foreground: #0a222e;
  --sidebar-border: #e2e8f0;
  --sidebar-ring: #70a6af;
}

.dark {
  --background: #041620;
  --foreground: #88a29e;
  --card: #0a222e;
  --card-foreground: #88a29e;
  --popover: #0a222e;
  --popover-foreground: #88a29e;
  --primary: #abd4d8; /* CI teal (dark) */
  --primary-foreground: #041620;
  --secondary: #0a222e;
  --secondary-foreground: #f5f8fa;
  --muted: #0a222e;
  --muted-foreground: #8f98a3;
  --accent: #2c676d;
  --accent-foreground: #f5f8fa;
  --destructive: #ef7070;
  --destructive-foreground: #f5f8fa;
  --border: #2c676d;
  --input: #6992a2;
  --ring: #58ebbf;
  --chart-1: #58ebbf;
  --chart-2: #409b9b;
  --chart-3: #079d99;
  --chart-4: #70a6af;
  --chart-5: #2c676d;
  --sidebar: #041620;
  --sidebar-foreground: #f5f8fa;
  --sidebar-primary: #abd4d8;
  --sidebar-primary-foreground: #041620;
  --sidebar-accent: #1d293d;
  --sidebar-accent-foreground: #f5f8fa;
  --sidebar-border: #2c676d;
  --sidebar-ring: #58ebbf;
}
```

`cn()` (identical in every repo):

```ts
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```
