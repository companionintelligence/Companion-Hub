# Companion Intelligence — Canonical UI Style Guide

>
> **Repo:** CI-Hub · **Surface:** `packages/frontend` (React web + Tauri desktop)
> **Last audited:** 2026-06-13

This document has three parts:

- **Part I — Canonical design system** is the shared, org-wide source of truth. It is
  **identical, byte-for-byte, in every repo** that ships a CI surface
  (`CI-Hub/docs/UI-STYLE-GUIDE.md`, `CI-Portal/docs/UI-STYLE-GUIDE.md`,
  `CI-Marketplace/docs/UI-STYLE-GUIDE.md`). Changes to Part I must be mirrored to all three.
- **Part II — This repo (CI-Hub)** documents how this repo implements the canon, where the
  files live, and any sanctioned local extensions.
- **Part III — Drift & remediation (CI-Hub)** is the actionable list of where this repo
  currently diverges from canon, with recommended fixes.

---

# Part I — Canonical design system (shared)

> Identical across CI-Hub, CI-Portal, and CI-Marketplace. Do not edit one copy in isolation.

## 1. Principles

1. **One brand, one token set.** Every CI surface is themed from a single set of
   shadcn-compatible CSS variables. The brand color is **Companion Intelligence teal**, applied
   through `--primary`. Surfaces are neutral; teal is the accent that carries identity.
2. **Tailwind v4, CSS-first.** Tokens live in CSS (`@theme` + `:root`/`.dark`), not in JS.
   The Tailwind config only extends font, font-size, and a couple of transitions.
3. **shadcn/ui conventions.** Components are built on accessible primitives, composed with
   `class-variance-authority` (cva) and merged with `cn()` (`clsx` + `tailwind-merge`).
4. **Light & dark are first-class.** Theme is a `.dark` / `.light` class on `<html>`. Every
   token is defined for both modes. Never hard-code a hex in a component when a token exists.
5. **Minimal token surface.** The canonical palette is the standard shadcn token set plus the
   CI teal primary — nothing more. Repos may add **documented local extensions**, but those are
   not canon and must not leak into shared components.

## 2. Tech stack (canonical baseline)

| Concern           | Canonical choice                                    |
| ----------------- | --------------------------------------------------- |
| Framework         | React 19                                            |
| Styling           | Tailwind CSS v4 (CSS-first `@theme`)                |
| Component pattern | shadcn/ui (cva + `cn`)                              |
| Primitives        | Accessible headless primitives (Radix UI / Base UI) |
| Icons             | `lucide-react`                                      |
| Font              | Montserrat (200, 400, 500, 600, 700)                |
| Class merge       | `clsx` + `tailwind-merge` via `cn()`                |
| Toasts            | `sonner`                                            |

## 3. Color tokens

Tokens are declared as CSS custom properties and exposed to Tailwind via `@theme inline`
(`--color-*: var(--*)`). Components reference the **semantic** names (`bg-primary`,
`text-muted-foreground`, `border-border`), never raw values.

`--primary` is **CI teal**. This is the single most important token in the system and the one
most likely to drift — guard it.

### 3.1 Light mode (`:root`)

| Token                      | Value         | Role                          |
| -------------------------- | ------------- | ----------------------------- |
| `--background`             | `#f3f3f3`     | App background                |
| `--foreground`             | `#010f16`     | Body text                     |
| `--card`                   | `#f7f7f9`     | Card surface                  |
| `--card-foreground`        | `#041620`     | Card text                     |
| `--popover`                | `#ffffff`     | Popover surface               |
| `--popover-foreground`     | `#041620`     | Popover text                  |
| **`--primary`**            | **`#0f717a`** | **CI teal — primary actions** |
| `--primary-foreground`     | `#f8fafc`     | Text on primary               |
| `--secondary`              | `#f1f5f9`     | Secondary surface             |
| `--secondary-foreground`   | `#0a222e`     | Text on secondary             |
| `--muted`                  | `#f1f5f9`     | Muted surface                 |
| `--muted-foreground`       | `#62748e`     | Muted text                    |
| `--accent`                 | `#f1f5f9`     | Hover/accent surface          |
| `--accent-foreground`      | `#0a222e`     | Text on accent                |
| `--destructive`            | `#ee3533`     | Danger                        |
| `--destructive-foreground` | `#f8fafc`     | Text on danger                |
| `--border`                 | `#e2e8f0`     | Borders                       |
| `--input`                  | `#e2e8f0`     | Input borders                 |
| `--ring`                   | `#90a1b9`     | Focus ring                    |
| `--chart-1..5`             | see appendix  | Data viz                      |
| `--sidebar*`               | see appendix  | Sidebar surfaces              |

### 3.2 Dark mode (`.dark`)

| Token                    | Value         | Role                             |
| ------------------------ | ------------- | -------------------------------- |
| `--background`           | `#041620`     | Deep teal-navy shell             |
| `--foreground`           | `#88a29e`     | Body text (neutral grey-teal)    |
| `--card`                 | `#0a222e`     | Card surface                     |
| `--popover`              | `#0a222e`     | Popover surface                  |
| **`--primary`**          | **`#abd4d8`** | **Light teal — primary actions** |
| `--primary-foreground`   | `#041620`     | Text on primary                  |
| `--secondary`            | `#0a222e`     | Secondary surface                |
| `--secondary-foreground` | `#f5f8fa`     | Text on secondary                |
| `--muted`                | `#0a222e`     | Muted surface                    |
| `--muted-foreground`     | `#8f98a3`     | Muted text                       |
| `--accent`               | `#2c676d`     | Accent surface (teal)            |
| `--accent-foreground`    | `#f5f8fa`     | Text on accent                   |
| `--destructive`          | `#ef7070`     | Danger                           |
| `--border`               | `#2c676d`     | Borders (muted teal)             |
| `--input`                | `#6992a2`     | Input borders                    |
| `--ring`                 | `#58ebbf`     | Focus ring (mint)                |

Full values, including `--chart-*` and `--sidebar-*`, are in the **Appendix** as a copy-pasteable **hex reference** token block (source `globals.css` authors in `oklch()`).

### 3.3 Color notation

This document expresses the palette in **hex** (`#rrggbb`) as a stable, tool-universal reference —
every contrast checker and design tool reads it natively. **Source `globals.css` authors tokens in
`oklch()`**, to stay aligned with the shadcn registry and keep wide-gamut range and perceptual
editing ergonomics; for in-gamut colors the two are equivalent. When adding or editing a token,
update both: `oklch()` in source, its hex equivalent here. Never introduce a third notation (HSL,
named colors).

### 3.4 Accessibility & contrast

Contrast is a property of a **pairing** — text or a graphic against the _specific_ surface it
sits on — not of a token in isolation. Verify the pairing. **WCAG 2.1 AA is the pass/fail gate:**

- **Normal text** (< 24px, or < 18.66px bold): **≥ 4.5:1**.
- **Large text** (≥ 24px, or ≥ 18.66px / 14pt bold): **≥ 3:1**.
- **Focus indicators and UI components / graphical objects** (WCAG 2.4.11 & 1.4.11): **≥ 3:1**
  against adjacent colors.

Treat **AAA (7:1)** as an aspiration for sustained body copy where it comes for free; AA is the
line that must not be crossed. Fix contrast **at the token layer** — adjust the semantic token once
and every component inherits it — never per-component.

**Two nuances to bake in:**

1. **Borders.** Purely **decorative** borders and dividers are _exempt_ from the 3:1 rule. But a
   border that is the **only** indicator of a control — an input outline, a selected/active state —
   must meet **3:1**, and so must the **focus ring** against whatever background it appears over.
   (So `--border` may sit below 3:1, but `--input`, selected states, and `--ring` may not, in the
   contexts where they carry meaning.)
2. **Dark mode.** WCAG 2.1's relative-luminance math can **mis-rank perceived contrast** on dark
   surfaces. Tune dark-mode pairings by eye and cross-check against **APCA** (the WCAG 3 draft
   contrast model), but keep **WCAG 2.1 AA as the compliance gate**.

## 4. Typography

- **Family:** `Montserrat, system-ui, sans-serif` (token `--font-sans`, Tailwind `font-sans`).
- **Weights:** 200, 400, 500, 600, 700. Load exactly these via Google Fonts.
- **Custom sizes** (Tailwind `fontSize` extension): `xxs` = `0.625rem` (10px), `tiny` = `0.5rem` (8px).
  Use only for micro-labels/badges.
- Use Tailwind's default type scale (`text-sm`, `text-base`, …) for everything else. Body copy is `text-sm`/`text-base`.
- Long-form markdown uses `@tailwindcss/typography` (`prose`).

## 5. Radius & elevation

- **Base:** `--radius: 0.625rem` (10px).
- **Scale:** `--radius-sm = calc(--radius - 4px)` (6px), `--radius-md = calc(--radius - 2px)` (8px),
  `--radius-lg = --radius` (10px), `--radius-xl = calc(--radius + 4px)` (14px).
- **Default control radius** is `rounded-md` / `rounded-lg`. Pills use `rounded-full`.
- **Elevation** is conveyed with subtle Tailwind shadows (`shadow-sm`, `shadow`); avoid heavy drop shadows.
- A custom `transition-radius` (animating `border-radius`) is available from the Tailwind config.

## 6. Iconography

- Library: **`lucide-react`** only. Do not mix icon sets.
- Default inline size: **`size-4`** (16px). Use **`size-5`** for prominent/standalone interactive icons.
- Icons inherit `currentColor`; align with `mr-2` / `gap-*`, never absolute positioning except for
  the sun/moon theme-toggle crossfade pattern.

## 7. Components & variants

All interactive components are shadcn-style: a headless primitive + cva variants + `cn()`.

### 7.1 Button (canonical)

Base: `inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium`
with focus-visible ring and `disabled:opacity-50`.

**Canonical variants** (semantic-token driven):

| Variant       | Style                                                              |
| ------------- | ------------------------------------------------------------------ |
| `default`     | `bg-primary text-primary-foreground` (teal), hover `bg-primary/90` |
| `secondary`   | `bg-secondary text-secondary-foreground`, hover `/80`              |
| `outline`     | `border border-input bg-background`, hover `bg-accent`             |
| `ghost`       | hover `bg-accent text-accent-foreground`                           |
| `destructive` | `bg-destructive text-destructive-foreground` (solid), hover `/90`  |
| `link`        | `text-primary underline-offset-4 hover:underline`                  |

**Canonical sizes:** `default` (h-9, `px-4 py-2`), `sm` (h-8, `px-3 text-xs`), `lg` (h-10, `px-8`),
`icon` (`size-8`). Default variant/size: `default`/`default`.

Repos may add extra variants/sizes as **documented local extensions** (see Part II/III), but the
six variants and four sizes above must exist and behave as specified everywhere.

### 7.2 Badge (canonical)

`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium`, variants
`default` (bg-primary), `secondary`, `destructive`, `outline`.

### 7.3 Card, Input, Dialog, Dropdown, Tabs, Table, Tooltip, Skeleton, ScrollArea, Sheet, Separator, Alert, Avatar, Switch, Checkbox, Select

Standard shadcn primitives. Use the shared implementations; theme strictly through tokens.
`glass-container` is a shared CI utility surface and should look identical across repos.

### 7.4 Authoring rules

- Compose classes with `cn(...)`; never string-concat class names.
- Variants via `cva`; expose `VariantProps` typing.
- One component per folder/file; co-locate `*.test.tsx`.
- Reference tokens, not raw colors. A literal hex in a component is a bug unless it is a
  documented local extension token.

## 8. Theming

- **Mechanism:** class on `<html>` — `.dark` or `.light`. Tailwind dark variant is
  `@custom-variant dark (&:is(.dark *))`.
- **Provider:** a `ThemeProvider` storing the choice in `localStorage` under key **`vite-ui-theme`**,
  resolving `system` via `matchMedia('(prefers-color-scheme: dark)')`.
- **No-flash:** apply the stored theme class before React hydrates (inline head script or equivalent).
- **Canonical default:** `system`. (A surface may force a default; record it in Part II.)

## 9. Feedback (toasts)

- Canonical library: **`sonner`**, mounted once as `<Toaster />` near the app root, theme-synced
  to the active theme.
- Use `toast.success` / `toast.error` / `toast` for transient feedback; never `alert()`.

## 10. Motion

- Use `tailwindcss-animate` / `tw-animate-css` utilities and short, subtle transitions
  (`transition-colors`, `transition-all` ≤200ms).
- Respect `prefers-reduced-motion`; any ambient/background animation must be reduced-motion-safe
  and ideally opt-in.

## 11. Governance

- Part I is canon. Edit it in one repo, then copy the **entire Part I** verbatim into the other two
  in the same change set.
- A future shared package (e.g. `@ci/ui` / `@ci/tokens`) is the intended end state so the token
  block and primitives have a single physical source. Until then, this document is the contract.

---

# Part II — This repo (CI-Hub)

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

# Part III — Drift & remediation (CI-Hub)

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
