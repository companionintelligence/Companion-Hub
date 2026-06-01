#!/usr/bin/env tsx
/**
 * Capture screenshots of CI-Portal (the cloud control plane) and assemble
 * them into an animated GIF for use in the CI-Hub README.
 *
 * Output:
 *   docs/ci-portal/01-signin.png
 *   docs/ci-portal/02-signup.png
 *   docs/ci-portal/03-home.png
 *   docs/ci-portal/04-store.png
 *   docs/ci-portal/05-add-device.png
 *   docs/ci-portal/ci-portal.gif
 *
 * Approach:
 *   1. Boot the CI-Portal frontend dev server against a fake backend URL.
 *   2. Use Playwright with route mocking — no real backend needed.
 *   3. Navigate through: sign-in → sign-up → home (with devices) → store → add-device.
 *   4. Use ImageMagick to assemble the PNGs into an animated GIF.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page, type Route } from '@playwright/test';

const PORTAL_ROOT = resolve(__dirname, '../../CI-Portal');
const HUB_ROOT = resolve(__dirname, '..');
const SHOTS_DIR = join(HUB_ROOT, 'docs', 'ci-portal');
const OUTPUT_GIF = join(SHOTS_DIR, 'ci-portal.gif');

const PORTAL_FRONTEND_PORT = 9092;
const MOCK_BACKEND_PORT = 9999;
const PORTAL_URL = `http://localhost:${PORTAL_FRONTEND_PORT}`;

const VIEWPORT = { width: 1280, height: 800 };

// ─── Mock data ────────────────────────────────────────────────────────────────

const sessionMock = {
  user: {
    id: 'user-demo',
    email: 'demo@ci.computer',
    name: 'Demo User',
    emailVerified: true,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  },
  session: {
    id: 'session-demo',
    userId: 'user-demo',
    token: 'demo-token',
    expiresAt: '2099-01-01T00:00:00.000Z',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  },
};

const orgsMock = [
  {
    id: 'org-1',
    name: 'Companion HQ',
    slug: 'companion-hq',
    logo: null,
    role: 'owner',
    memberCount: 3,
  },
];

const devicesMock = [
  {
    id: 'dev-1',
    deviceId: 'companion-hub-home',
    name: 'Home Hub',
    displayName: 'Home Hub',
    description: 'Living room NUC',
    slug: 'home-hub',
    status: 'online',
    lastSeen: new Date().toISOString(),
    subdomain: 'home-hub.ci.computer',
    apps: [
      { id: 'app-1', appId: 'nextcloud', slug: 'nextcloud', name: 'Nextcloud', status: 'running', url: 'https://nextcloud.home-hub.ci.computer' },
      { id: 'app-2', appId: 'jellyfin', slug: 'jellyfin', name: 'Jellyfin', status: 'running', url: 'https://jellyfin.home-hub.ci.computer' },
      { id: 'app-3', appId: 'immich', slug: 'immich', name: 'Immich', status: 'running', url: 'https://immich.home-hub.ci.computer' },
    ],
  },
  {
    id: 'dev-2',
    deviceId: 'companion-hub-office',
    name: 'Office Hub',
    displayName: 'Office Hub',
    description: 'Workstation',
    slug: 'office-hub',
    status: 'online',
    lastSeen: new Date().toISOString(),
    subdomain: 'office-hub.ci.computer',
    apps: [
      {
        id: 'app-4',
        appId: 'vaultwarden',
        slug: 'vaultwarden',
        name: 'Vaultwarden',
        status: 'running',
        url: 'https://vaultwarden.office-hub.ci.computer',
      },
      { id: 'app-5', appId: 'n8n', slug: 'n8n', name: 'n8n', status: 'running', url: 'https://n8n.office-hub.ci.computer' },
    ],
  },
];

const storeAppsMock = [
  {
    id: 'nextcloud',
    title: 'Nextcloud',
    description: 'The self-hosted productivity platform that keeps you in control.',
    shortDescription: 'Self-hosted files, calendar, contacts',
    priceModel: 'free',
    price: null,
    tags: ['productivity', 'files', 'collaboration'],
    status: 'published',
    icon: null,
    developer: { id: 'dev-nc', name: 'Nextcloud GmbH', logo: null, slug: 'nextcloud' },
    rating: { average: 4.8, count: 312 },
    versions: [{ version: '28.0.0' }],
  },
  {
    id: 'jellyfin',
    title: 'Jellyfin',
    description: 'The Free Software Media System — stream your media anywhere.',
    shortDescription: 'Free & open-source media server',
    priceModel: 'free',
    price: null,
    tags: ['media', 'streaming', 'video'],
    status: 'published',
    icon: null,
    developer: { id: 'dev-jf', name: 'Jellyfin Project', logo: null, slug: 'jellyfin' },
    rating: { average: 4.7, count: 228 },
    versions: [{ version: '10.9.0' }],
  },
  {
    id: 'immich',
    title: 'Immich',
    description: 'Self-hosted photo and video backup solution directly from your mobile phone.',
    shortDescription: 'Self-hosted Google Photos alternative',
    priceModel: 'free',
    price: null,
    tags: ['photos', 'backup', 'mobile'],
    status: 'published',
    icon: null,
    developer: { id: 'dev-im', name: 'Immich Team', logo: null, slug: 'immich' },
    rating: { average: 4.9, count: 445 },
    versions: [{ version: '1.105.0' }],
  },
  {
    id: 'vaultwarden',
    title: 'Vaultwarden',
    description: 'Unofficial Bitwarden compatible server written in Rust.',
    shortDescription: 'Self-hosted password manager',
    priceModel: 'free',
    price: null,
    tags: ['security', 'passwords', 'privacy'],
    status: 'published',
    icon: null,
    developer: { id: 'dev-vw', name: 'Vaultwarden', logo: null, slug: 'vaultwarden' },
    rating: { average: 4.8, count: 389 },
    versions: [{ version: '1.31.0' }],
  },
  {
    id: 'n8n',
    title: 'n8n',
    description: 'Workflow automation tool with a fair-code license.',
    shortDescription: 'Visual workflow automation',
    priceModel: 'free',
    price: null,
    tags: ['automation', 'workflow', 'integration'],
    status: 'published',
    icon: null,
    developer: { id: 'dev-n8n', name: 'n8n GmbH', logo: null, slug: 'n8n' },
    rating: { average: 4.6, count: 183 },
    versions: [{ version: '1.41.0' }],
  },
  {
    id: 'mattermost',
    title: 'Mattermost',
    description: 'Open source platform for secure collaboration across the entire software development lifecycle.',
    shortDescription: 'Self-hosted team messaging',
    priceModel: 'free',
    price: null,
    tags: ['communication', 'chat', 'team'],
    status: 'published',
    icon: null,
    developer: { id: 'dev-mm', name: 'Mattermost Inc.', logo: null, slug: 'mattermost' },
    rating: { average: 4.5, count: 156 },
    versions: [{ version: '9.8.0' }],
  },
];

const alternativesMock = {
  utilities: [
    {
      proprietary: [{ name: 'Google Drive', icon: '', url: null }],
      alternatives: [{ name: 'Nextcloud', icon: '', url: '', appSlug: 'nextcloud' }],
    },
  ],
  media: [
    {
      proprietary: [{ name: 'Plex', icon: '', url: null }],
      alternatives: [{ name: 'Jellyfin', icon: '', url: '', appSlug: 'jellyfin' }],
    },
  ],
  photography: [
    {
      proprietary: [{ name: 'Google Photos', icon: '', url: null }],
      alternatives: [{ name: 'Immich', icon: '', url: '', appSlug: 'immich' }],
    },
  ],
  security: [
    {
      proprietary: [{ name: 'LastPass', icon: '', url: null }],
      alternatives: [{ name: 'Vaultwarden', icon: '', url: '', appSlug: 'vaultwarden' }],
    },
  ],
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/** Mock backend URL pattern (set via VITE_BACKEND_API_BASE_URL when launching frontend). */
const MOCK_RE = new RegExp(`http://localhost:${MOCK_BACKEND_PORT}/`);

async function setupRoutes(page: Page, opts: { authenticated: boolean }) {
  // Block external assets so nothing hangs on the network
  await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (r) => r.abort());

  await page.route(MOCK_RE, async (route) => {
    const { pathname, searchParams } = new URL(route.request().url());

    // Better-auth session
    if (pathname === '/api/auth/get-session') {
      return json(route, opts.authenticated ? sessionMock : null);
    }

    // Better-auth organization list (plugin endpoint)
    if (pathname.includes('/organization/list')) {
      return json(route, opts.authenticated ? orgsMock : []);
    }

    // Better-auth sign-in/sign-up/passkey — return success
    if (pathname.startsWith('/api/auth/')) {
      return json(route, { status: 200 });
    }

    // Devices list
    if (pathname === '/api/devices') {
      const orgId = searchParams.get('organizationId');
      return json(route, { devices: orgId ? devicesMock : [] });
    }

    // Store alternatives
    if (pathname === '/api/store/alternatives') {
      return json(route, alternativesMock);
    }

    // Store apps list
    if (pathname === '/api/store') {
      return json(route, storeAppsMock);
    }

    // Health check
    if (pathname === '/api/health') {
      return route.fulfill({ status: 200, body: 'OK' });
    }

    // Default fallback
    return json(route, {});
  });
}

async function waitFor(url: string, timeoutMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 200 || res.status === 404) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function snapshot(page: Page, name: string) {
  await page.waitForTimeout(700);
  const out = join(SHOTS_DIR, `${name}.png`);
  await page.screenshot({ path: out, fullPage: false });
  console.log(`  • ${out}`);
  return out;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function captureScreenshots() {
  const browser = await chromium.launch({ headless: true });

  try {
    // ── 1. Sign-in page ───────────────────────────────────────────────────────
    {
      const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: 'dark' });
      const page = await ctx.newPage();
      await setupRoutes(page, { authenticated: false });
      await page.goto(`${PORTAL_URL}/login`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(1200);
      await snapshot(page, '01-signin');

      // ── 2. Sign-up mode ───────────────────────────────────────────────────
      // Look for the "Create account" / "Sign up" toggle link and click it
      const signupToggle = page.locator('text=Create account').first();
      const signupAlt = page.locator('text=Sign up').first();
      try {
        if (await signupToggle.isVisible({ timeout: 2000 })) {
          await signupToggle.click();
        } else if (await signupAlt.isVisible({ timeout: 2000 })) {
          await signupAlt.click();
        }
      } catch {
        // toggle not found — already on signup or page uses different label
      }
      await page.waitForTimeout(800);
      await snapshot(page, '02-signup');
      await ctx.close();
    }

    // ── 3. Home page (authenticated) ──────────────────────────────────────────
    {
      const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: 'dark' });
      const page = await ctx.newPage();
      await setupRoutes(page, { authenticated: true });
      // Pre-set the active org in localStorage so OrgProvider resolves immediately
      await page.addInitScript(() => {
        localStorage.setItem('ci-active-org-id', 'org-1');
      });
      await page.goto(`${PORTAL_URL}/home`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(1500);
      await snapshot(page, '03-home');

      // ── 4. Add-device dialog ──────────────────────────────────────────────
      try {
        const addBtn = page.getByRole('button', { name: /add device|add hub|new device/i }).first();
        if (await addBtn.isVisible({ timeout: 3000 })) {
          await addBtn.click();
          await page.waitForTimeout(800);
          await snapshot(page, '05-add-device');
        } else {
          console.log('  • add-device button not visible, skipping dialog shot');
          await snapshot(page, '05-add-device');
        }
      } catch {
        await snapshot(page, '05-add-device');
      }
      await ctx.close();
    }

    // ── 5. App store ──────────────────────────────────────────────────────────
    {
      const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: 'dark' });
      const page = await ctx.newPage();
      await setupRoutes(page, { authenticated: false });
      await page.goto(`${PORTAL_URL}/store`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(1200);
      await snapshot(page, '04-store');
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
}

async function buildGif() {
  console.log('Assembling GIF…');

  const frames = ['01-signin.png', '03-home.png', '04-store.png', '05-add-device.png'].map((f) => join(SHOTS_DIR, f));

  for (const f of frames) {
    if (!existsSync(f)) {
      console.warn(`  ⚠ missing frame: ${f}, skipping GIF build`);
      return;
    }
  }

  const args: string[] = ['-loop', '0'];
  for (let i = 0; i < frames.length; i++) {
    const isLast = i === frames.length - 1;
    args.push('-delay', isLast ? '320' : '200');
    args.push(frames[i]);
  }
  args.push('-resize', '1280x800');
  args.push('-layers', 'Optimize');
  args.push(OUTPUT_GIF);

  const proc = spawn('magick', args, { stdio: 'inherit' });
  await new Promise<void>((res, rej) => {
    proc.on('exit', (code) => (code === 0 ? res() : rej(new Error(`magick exited ${code}`))));
    proc.on('error', rej);
  });
  console.log(`GIF → ${OUTPUT_GIF}`);
}

async function startPortalFrontend(): Promise<ChildProcess> {
  console.log('Starting CI-Portal frontend dev server…');
  const webAppDir = join(PORTAL_ROOT, 'apps', 'web-app');
  const proc = spawn('node_modules/.bin/vite', ['--port', String(PORTAL_FRONTEND_PORT), '--host', 'localhost'], {
    cwd: webAppDir,
    env: {
      ...process.env,
      VITE_BACKEND_API_BASE_URL: `http://localhost:${MOCK_BACKEND_PORT}`,
      VITE_ENV: 'local',
      VITE_ANIMATED_BG: 'false',
      BROWSER: 'none',
      CI: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout?.on('data', (d: Buffer) => process.stdout.write(`[portal] ${d}`));
  proc.stderr?.on('data', (d: Buffer) => process.stderr.write(`[portal!] ${d}`));
  await waitFor(`${PORTAL_URL}/`, 120_000);
  console.log('CI-Portal frontend ready.');
  return proc;
}

async function main() {
  // Ensure output directory exists (keep existing files; we'll overwrite below)
  if (!existsSync(SHOTS_DIR)) {
    mkdirSync(SHOTS_DIR, { recursive: true });
  }

  // Remove old screenshots so stale ones don't linger
  for (const name of ['01-signin', '02-signup', '03-home', '04-store', '05-add-device']) {
    const p = join(SHOTS_DIR, `${name}.png`);
    if (existsSync(p)) rmSync(p);
  }

  // Ensure playwright chromium is available
  let feProc: ChildProcess | undefined;
  try {
    feProc = await startPortalFrontend();
    await captureScreenshots();
    await buildGif();
  } finally {
    if (feProc && !feProc.killed) feProc.kill('SIGINT');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
