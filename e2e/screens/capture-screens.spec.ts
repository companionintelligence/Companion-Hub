/**
 * Documentation screenshot capture.
 *
 * Walks every screen the seeded E2E stack can reach and writes a PNG per
 * (screen × theme) into `docs/images/screens/`. These are DOC assets, not visual
 * baselines — they are meant to be looked at by a human, so nothing is masked and
 * full-page capture is on. Visual-regression baselines live in
 * `e2e/screenshots/baselines/` and are produced by `e2e/visual/`.
 *
 * Deliberately excluded from the default lane (`playwright.config.ts` testIgnore)
 * because it writes into the repo. Run it on purpose:
 *
 *   pnpm run docs:screens
 *
 * Screens this stack CANNOT reach are listed in SKIPPED below and reported at the
 * end of the run, so a shrinking inventory is visible rather than silent.
 */

import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { createTestUser, expect, loginUser, test } from '../fixtures/fixtures';

const OUT_DIR = join(process.cwd(), 'docs/images/screens');
const THEMES = ['dark', 'light'] as const;
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

/** Authenticated screens reachable with only a seeded operator — no installed apps, no Docker. */
const AUTHENTICATED = [
  { name: 'dashboard', path: '/home', settle: 'Disk space' },
  { name: 'app-store', path: '/store', settle: 'Check for Updates' },
  { name: 'settings-general', path: '/settings?tab=settings', settle: null },
  { name: 'settings-security', path: '/settings?tab=security', settle: null },
  { name: 'settings-app-stores', path: '/settings?tab=appstores', settle: null },
  { name: 'settings-network', path: '/settings?tab=network', settle: null },
  { name: 'settings-ai', path: '/settings?tab=ai', settle: null },
  { name: 'settings-mcp', path: '/settings?tab=mcp', settle: null },
  { name: 'settings-system', path: '/settings?tab=system', settle: null },
  { name: 'settings-logs', path: '/settings?tab=logs', settle: null },
  { name: 'resource-monitor', path: '/resource-monitor', settle: null },
  { name: 'custom-app-create', path: '/apps/create', settle: null },
  { name: 'port-expose-create', path: '/apps/expose', settle: null },
  { name: 'not-found', path: '/no-such-page', settle: null },
] as const;

/**
 * Screens no fixture can currently reach, and why. Reported at the end of the run.
 * Shrinking this list is the point of an "installed app" fixture — see
 * docs/system/ui-screens.md.
 */
const SKIPPED: Record<string, string> = {
  'app-details': 'needs a running installed app (Docker + CI-Marketplace + Traefik)',
  'app-update': 'needs an installed app with an available update',
  'custom-app-details': 'needs a created custom app',
  'custom-app-edit': 'needs a created custom app',
  'device-registration': 'needs an unregistered Hub; see e2e/launch-path.spec.ts hub states',
  onboarding: 'needs a user with hasCompletedOnboarding false; the fixture seeds it true',
  'restore-apps': 'needs a registration-state drift',
  'memory-connect-finishing': 'needs a CI Memory OAuth callback in flight',
  connect: 'phone-only route; the default lane runs desktop Chromium',
  'guest-dashboard': 'needs GUEST_DASHBOARD=true in the backend env',
  'hub-status-startup': 'desktop Tauri shell only; not served by the web frontend',
};

const applyTheme = async (page: Page, theme: string) => {
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
    },
    ['vite-ui-theme', theme],
  );
};

/**
 * NOT `networkidle`. The Hub polls: the system inspector every 5s, the resource monitor and pool
 * panels continuously, and the Logs tab holds an open log stream. On those screens the network is
 * never idle, so waiting for it hangs until the test times out with nothing written.
 */
const settle = async (page: Page, marker: string | null) => {
  await page.waitForLoadState('domcontentloaded');
  if (marker) {
    await expect(page.getByText(marker).first()).toBeVisible({ timeout: 30000 });
  }
  await page.evaluate(() => document.fonts.ready);
  // Let the entry animation finish and first data paint land.
  await page.waitForTimeout(1500);
};

/**
 * Every file THIS run wrote. The report below counts this set, not the directory: the PNGs are
 * committed, so `readdirSync(OUT_DIR)` is always at least the last run's output and a count of it
 * could never fall — a walk that silently wrote nothing would still have "passed".
 */
const written = new Set<string>();

const shoot = async (page: Page, name: string, theme: string, suffix = '') => {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const file = `${name}-${theme}${suffix}.png`;
  await page.screenshot({ path: join(OUT_DIR, file), fullPage: true });
  written.add(file);
};

for (const theme of THEMES) {
  /**
   * `/register` FIRST and with no user seeded. Its clientLoader sends an already-configured Hub to
   * `/login`, so capturing it after `createTestUser()` silently produced a second copy of the login
   * page under the register name.
   */
  test(`capture register screen (${theme})`, async ({ page }) => {
    await applyTheme(page, theme);
    await page.setViewportSize(DESKTOP);

    await page.goto('/register');
    await settle(page, null);
    await shoot(page, 'register', theme);
  });

  test(`capture signed-out screens (${theme})`, async ({ page }) => {
    // /login redirects to /register until the Hub has an operator, so this one needs the user.
    await createTestUser();
    await applyTheme(page, theme);
    await page.setViewportSize(DESKTOP);

    for (const screen of [
      { name: 'login', path: '/login' },
      { name: 'reset-password', path: '/reset-password' },
    ]) {
      await page.goto(screen.path);
      await settle(page, null);
      await shoot(page, screen.name, theme);
    }
  });

  test(`capture authenticated screens (${theme})`, async ({ page }) => {
    await applyTheme(page, theme);
    await page.setViewportSize(DESKTOP);
    await loginUser(page);

    for (const screen of AUTHENTICATED) {
      await page.goto(screen.path);
      await settle(page, screen.settle);
      await shoot(page, screen.name, theme);
    }
  });
}

test('capture mobile-width screens (dark)', async ({ page }) => {
  await applyTheme(page, 'dark');
  await page.setViewportSize(MOBILE);
  await loginUser(page);

  // The screens where the narrow layout differs most: the header collapses to a hamburger, the
  // settings tab row becomes a scrolling strip, and the store sidebar becomes a pill row.
  for (const screen of [
    { name: 'dashboard', path: '/home', settle: 'Disk space' },
    { name: 'app-store', path: '/store', settle: null },
    { name: 'settings-network', path: '/settings?tab=network', settle: null },
    { name: 'resource-monitor', path: '/resource-monitor', settle: null },
  ]) {
    await page.goto(screen.path);
    await settle(page, screen.settle);
    await shoot(page, screen.name, 'dark', '-mobile');
  }
});

test('report what was captured and what could not be', async () => {
  // register + login + reset-password + AUTHENTICATED, per theme, plus 4 mobile.
  const expectedCount = (AUTHENTICATED.length + 3) * THEMES.length + 4;
  // Files in the directory that this run did not touch: a renamed screen leaves its old
  // capture behind, and nothing else would ever say so.
  const stale = existsSync(OUT_DIR) ? readdirSync(OUT_DIR).filter((f) => f.endsWith('.png') && !written.has(f)) : [];

  // biome-ignore lint/suspicious/noConsole: the coverage report IS this test's output
  console.log(`\n[capture-screens] wrote ${written.size} PNGs to docs/images/screens/`);
  if (stale.length > 0) {
    // biome-ignore lint/suspicious/noConsole: the coverage report IS this test's output
    console.log(`[capture-screens] ${stale.length} PNGs in the directory were NOT written by this run: ${stale.join(', ')}`);
  }
  // biome-ignore lint/suspicious/noConsole: the coverage report IS this test's output
  console.log(`[capture-screens] ${Object.keys(SKIPPED).length} screens have no fixture path:`);
  for (const [name, why] of Object.entries(SKIPPED)) {
    // biome-ignore lint/suspicious/noConsole: the coverage report IS this test's output
    console.log(`  - ${name}: ${why}`);
  }

  // Exact, and over what THIS run wrote. A silent drop would otherwise read as full
  // coverage, and a surplus means a screen list and this arithmetic have drifted apart.
  expect(written.size, `expected ${expectedCount} screenshots this run, wrote ${written.size}`).toBe(expectedCount);
});
