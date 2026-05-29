#!/usr/bin/env tsx
/**
 * Capture screenshots of every FTUE (onboarding) step and assemble them into a GIF.
 *
 * Output: docs/ftue.gif
 *
 * Approach:
 *   1. Boot the frontend dev server.
 *   2. Use Playwright with route mocking — no backend, no database.
 *   3. Visit /onboarding, walk through each step, screenshot it.
 *   4. Use ImageMagick to assemble the PNGs into an animated GIF.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page, type Route } from '@playwright/test';

const ROOT = resolve(__dirname, '..');
const SHOTS_DIR = join(ROOT, 'docs', 'ftue-screenshots');
const OUTPUT_GIF = join(ROOT, 'docs', 'ftue.gif');
const FRONTEND_PORT = 9091;
const FRONTEND_URL = `http://localhost:${FRONTEND_PORT}`;
const VIEWPORT = { width: 960, height: 720 };

// ─── Mocks ────────────────────────────────────────────────────────────────

const enTranslations = JSON.parse(readFileSync(join(ROOT, 'packages/backend/src/modules/i18n/translations/en.json'), 'utf8'));

const userContextMock = {
  allowAutoThemes: true,
  allowErrorMonitoring: false,
  isConfigured: true,
  isGuestDashboardEnabled: false,
  isLoggedIn: true,
  isPasswordResetDisabled: true,
  localDomain: 'ci.lan',
  domain: 'demo.ci.computer',
  sslPort: 443,
  themeBase: 'gray',
  themeColor: 'blue',
  version: { body: '', current: '1.0.0', latest: '1.0.0', releases: [] },
};

const storeApps = [
  { id: 'nextcloud', name: 'Nextcloud', short_desc: 'Self-hosted productivity', urn: 'urn:app:nextcloud' },
  { id: 'jellyfin', name: 'Jellyfin', short_desc: 'Media server', urn: 'urn:app:jellyfin' },
  { id: 'immich', name: 'Immich', short_desc: 'Self-hosted photos', urn: 'urn:app:immich' },
  { id: 'vaultwarden', name: 'Vaultwarden', short_desc: 'Password manager', urn: 'urn:app:vaultwarden' },
  { id: 'mattermost', name: 'Mattermost', short_desc: 'Team chat', urn: 'urn:app:mattermost' },
  { id: 'n8n', name: 'n8n', short_desc: 'Workflow automation', urn: 'urn:app:n8n' },
].map((a) => ({
  ...a,
  available: true,
  categories: ['featured'],
  created_at: 1700000000,
  deprecated: false,
  supported_architectures: ['amd64', 'arm64'],
}));

const appContextMock = {
  apps: storeApps,
  updatesAvailable: 0,
  isProduction: false,
  cloudflareAvailable: false,
  tailscaleAvailable: true,
  user: {
    hasCompletedOnboarding: false,
    id: 1,
    locale: 'en',
    operator: true,
    totpEnabled: false,
    username: 'demo@ci.local',
    advancedMode: false,
  },
  userSettings: {
    advancedSettings: false,
    allowAutoThemes: true,
    allowErrorMonitoring: false,
    appDataPath: '/data',
    appsRepoUrl: '',
    demoMode: true,
    disablePasswordReset: true,
    dnsIp: '',
    domain: 'demo.ci.computer',
    eventsTimeout: 30,
  },
  version: { body: '', current: '1.0.0', latest: '1.0.0', releases: [] },
};

const detectServicesMock = {
  services: [
    { name: 'plex-server', image: 'plexinc/pms-docker:latest', status: 'running' },
    { name: 'bitwarden', image: 'bitwarden/server:latest', status: 'running' },
    { name: 'portainer', image: 'portainer/portainer-ce:latest', status: 'running' },
    { name: 'gitlab', image: 'gitlab/gitlab-ce:latest', status: 'running' },
  ],
};

const alternativesMock = {
  utilities: [
    {
      proprietary: [{ name: 'Dropbox', icon: '', url: null }],
      alternatives: [{ name: 'Nextcloud', icon: 'https://nextcloud.com/favicon.ico', url: '', appSlug: 'nextcloud' }],
    },
  ],
  media: [
    {
      proprietary: [{ name: 'Plex', icon: '', url: null }],
      alternatives: [{ name: 'Jellyfin', icon: 'https://jellyfin.org/favicon.ico', url: '', appSlug: 'jellyfin' }],
    },
  ],
  photography: [
    {
      proprietary: [{ name: 'Google Photos', icon: '', url: null }],
      alternatives: [{ name: 'Immich', icon: 'https://immich.app/img/immich-logo-stacked-light.svg', url: '', appSlug: 'immich' }],
    },
  ],
  security: [
    {
      proprietary: [{ name: '1Password', icon: '', url: null }],
      alternatives: [
        {
          name: 'Vaultwarden',
          icon: 'https://github.com/dani-garcia/vaultwarden/raw/main/resources/vaultwarden-icon.svg',
          url: '',
          appSlug: 'vaultwarden',
        },
      ],
    },
  ],
  social: [
    {
      proprietary: [{ name: 'Slack', icon: '', url: null }],
      alternatives: [{ name: 'Mattermost', icon: 'https://mattermost.com/favicon.ico', url: '', appSlug: 'mattermost' }],
    },
  ],
  automation: [
    {
      proprietary: [{ name: 'Zapier', icon: '', url: null }],
      alternatives: [{ name: 'n8n', icon: 'https://n8n.io/favicon.ico', url: '', appSlug: 'n8n' }],
    },
  ],
};

const hardwareProfileMock = {
  hardware: {
    gpu: {
      available: true,
      vendor: 'apple' as const,
      model: 'Apple M2 Pro',
      vramMb: 16384,
      unifiedMemory: true,
      driverVersion: 'metal-3',
      runtimeAvailable: true,
    },
    npu: { available: true, model: 'Apple Neural Engine' },
    ram: { totalMb: 32768, availableMb: 18432 },
    cpu: { arch: 'arm64' as const, cores: 12, model: 'Apple M2 Pro' },
    effectiveInferenceMemoryMb: 16384,
    tier: 'high' as const,
  },
  tier: 'high' as const,
  recommendedModels: [
    {
      id: 'llama3.1:8b',
      backend: 'ollama' as const,
      backendModelId: 'llama3.1:8b',
      modality: 'llm' as const,
      purpose: 'general' as const,
      displayName: 'Llama 3.1 8B',
      description: 'Balanced general-purpose model — great default for chat and reasoning.',
      requirements: {
        minVramMb: 6000,
        recommendedVramMb: 8000,
        minRamMb: 8000,
        diskMb: 5000,
        gpuVendors: ['nvidia', 'amd', 'apple', 'cpu'] as ('nvidia' | 'amd' | 'intel' | 'apple' | 'cpu')[],
        npuRequired: false,
        minTier: 'medium' as const,
      },
      runtime: {
        contextWindow: 128000,
        maxTokens: 4096,
        reasoning: false,
        input: ['text'] as ('text' | 'image' | 'audio')[],
        quantization: 'q4_k_m',
        pinnedByDefault: true,
        memoryFootprintMb: 6000,
      },
      tiers: { high: 'recommended' as const, medium: 'recommended' as const, low: 'available' as const, cpuOnly: 'not-recommended' as const },
    },
    {
      id: 'qwen2.5-coder:7b',
      backend: 'ollama' as const,
      backendModelId: 'qwen2.5-coder:7b',
      modality: 'llm' as const,
      purpose: 'coding' as const,
      displayName: 'Qwen 2.5 Coder 7B',
      description: 'Specialized for code generation, refactoring, and explanations.',
      requirements: {
        minVramMb: 5000,
        recommendedVramMb: 7000,
        minRamMb: 8000,
        diskMb: 4500,
        gpuVendors: ['nvidia', 'amd', 'apple', 'cpu'] as ('nvidia' | 'amd' | 'intel' | 'apple' | 'cpu')[],
        npuRequired: false,
        minTier: 'medium' as const,
      },
      runtime: {
        contextWindow: 32000,
        maxTokens: 4096,
        reasoning: false,
        input: ['text'] as ('text' | 'image' | 'audio')[],
        quantization: 'q4_k_m',
        pinnedByDefault: false,
        memoryFootprintMb: 5000,
      },
      tiers: { high: 'recommended' as const, medium: 'available' as const, low: 'available' as const, cpuOnly: 'not-recommended' as const },
    },
  ],
  availableModels: [],
  memoryBudget: {
    totalVramMb: 16384,
    totalRamMb: 32768,
    systemReservedRamMb: 4096,
    dockerOverheadMb: 2048,
    appContainerBudgetMb: 8192,
    modelBudgetVramMb: 12000,
    modelBudgetRamMb: 16000,
    modelUsedVramMb: 0,
    modelUsedRamMb: 0,
    pinnedVramMb: 0,
    pinnedRamMb: 0,
  },
  backends: {
    recommended: 'ollama' as const,
    available: [
      { type: 'ollama' as const, running: true, healthy: true },
      { type: 'vllm' as const, running: false, healthy: false },
      { type: 'lemonade' as const, running: false, healthy: false },
    ],
  },
  resourceEstimate: { totalDiskMb: 9500, totalMemoryMb: 11000, availableMemoryMb: 16000 },
};
hardwareProfileMock.availableModels = hardwareProfileMock.recommendedModels;

const tailscaleStatusMock = {
  installed: true,
  connected: false,
  ip: null as string | null,
  hostname: null as string | null,
  backendState: 'NeedsLogin',
};

const systemLoadMock = {
  cpu: { usage: 14, cores: 12 },
  memory: { used: 16384, total: 32768 },
  disk: { used: 200_000_000_000, total: 1_000_000_000_000 },
  uptime: 86400,
};

const inferencePreferencesMock = { preferredBackend: 'ollama' };

const registrationStatusMock = {
  phase: 'locally_ready',
  degradedReasons: [],
  registered: true,
};

const ollamaStatusMock = {
  installed: true,
  version: '0.4.5',
  installPath: '/usr/local/bin/ollama',
  needsInstall: false,
  running: true,
  ready: true,
  endpointUrl: 'http://localhost:11434',
};

// ─── Helpers ──────────────────────────────────────────────────────────────

function jsonResponse(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function setupRoutes(page: Page) {
  // Block external assets so the page doesn't wait on the network. Define first so
  // the order does not let it shadow more-specific localhost routes below.
  await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1|192\.168\.|100\.)/, (route) => route.abort());

  // Single matcher handles every API call so we can route by exact pathname.
  await page.route(/\/api\//, async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const matchI18n = path.match(/^\/api\/i18n\/locales\/[^/]+\/[^/]+\.json$/);

    if (matchI18n) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(enTranslations) });
    }

    switch (path) {
      case '/api/user-context':
        return jsonResponse(route, userContextMock);
      case '/api/app-context':
        return jsonResponse(route, appContextMock);
      case '/api/system-load':
        return jsonResponse(route, systemLoadMock);
      case '/api/registration/status':
        return jsonResponse(route, registrationStatusMock);
      case '/api/system/detect-services':
        return jsonResponse(route, detectServicesMock);
      case '/api/store/alternatives':
        return jsonResponse(route, alternativesMock);
      case '/api/inference/onboarding-profile':
        return jsonResponse(route, hardwareProfileMock);
      case '/api/inference/preferences':
        return jsonResponse(route, inferencePreferencesMock);
      case '/api/inference/hardware/rescan':
        return jsonResponse(route, { ok: true });
      case '/api/inference/ollama/status':
        return jsonResponse(route, ollamaStatusMock);
      case '/api/inference/ollama/install':
        return jsonResponse(route, { success: true, message: 'Installed' });
      case '/api/tailscale/status':
        return jsonResponse(route, tailscaleStatusMock);
      case '/api/tailscale/auth/start':
        return jsonResponse(route, { success: true, authUrl: 'https://login.tailscale.com/a/demo' });
      case '/api/complete-onboarding':
        return jsonResponse(route, { ok: true });
      default:
        return jsonResponse(route, {});
    }
  });
}

async function waitFor(url: string, timeoutMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 200 || res.status === 404) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function snapshot(page: Page, name: string) {
  // Allow animations to settle
  await page.waitForTimeout(600);
  const out = join(SHOTS_DIR, `${name}.png`);
  await page.screenshot({ path: out, fullPage: false });
  console.log(`  • screenshot saved: ${out}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function captureScreenshots() {
  if (existsSync(SHOTS_DIR)) rmSync(SHOTS_DIR, { recursive: true, force: true });
  mkdirSync(SHOTS_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    colorScheme: 'light',
  });
  const page = await context.newPage();
  await setupRoutes(page);

  console.log('Loading onboarding page…');
  // First load may trigger Vite dep optimization → multiple reloads.
  // Warm up by visiting once and waiting, then reload so the prebundle is in place.
  await page.goto(`${FRONTEND_URL}/onboarding`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  await page.goto(`${FRONTEND_URL}/onboarding`, { waitUntil: 'domcontentloaded' });
  // Best-effort wait — Vite HMR can keep this in flight forever in dev.
  await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => undefined);
  await page.waitForTimeout(1500);

  // ── 1. Start up (Welcome)
  await page.getByRole('heading', { name: 'Welcome to Companion Hub' }).waitFor({ timeout: 30_000 });
  await snapshot(page, '01-start-up');

  await page.getByRole('button', { name: 'Continue to AI Setup' }).click();

  // ── 2. AI Setup
  await page.locator('[data-testid="ai-setup-step"]').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(600);
  await snapshot(page, '02-ai-setup');

  await page.locator('[data-testid="ai-continue-btn"]').click();

  // ── 3a. Local Apps — Recommendations sub-step
  await page.getByRole('heading', { name: 'Recommended Apps' }).waitFor();
  await page.waitForTimeout(600); // let the list render
  // Recommendation cards are the buttons that show "Replaces <product>"; selecting by that text is
  // robust to styling changes in the redesigned wizard.
  const cards = page.getByRole('button').filter({ hasText: 'Replaces' });
  const count = Math.min(await cards.count(), 4);
  for (let i = 0; i < count; i++) {
    await cards.nth(i).click();
  }
  await snapshot(page, '03-local-apps-discover');

  await page.getByRole('button', { name: /Continue with \d+ app/ }).click();

  // ── 3b. Local Apps — Review sub-step
  await page.getByRole('heading', { name: 'Review Your Selection' }).waitFor();
  await page.waitForTimeout(400);
  await snapshot(page, '04-local-apps-review');

  await page.getByRole('button', { name: 'Continue to Install' }).click();

  // ── 4. Confirm & Download (Install)
  await page.waitForTimeout(1500);
  await snapshot(page, '05-confirm-download');

  // ── 5. VPN Setup — InstallStep finishes when the continue button shows.
  // Click it (waits up to 30s for the install loop to converge).
  // The button may not appear if installs fail under mocks; fall through either way.
  await page
    .locator('[data-testid="install-continue-btn"]')
    .waitFor({ timeout: 30_000 })
    .catch(() => undefined);
  await page
    .locator('[data-testid="install-continue-btn"]')
    .click()
    .catch(() => undefined);
  await page.getByRole('heading', { name: 'Set Up Private VPN' }).waitFor({ timeout: 15_000 });
  await page.waitForTimeout(400);
  await snapshot(page, '06-vpn-setup');

  // ── 6. Done — last stepper trigger is always clickable as a skip-to-end shortcut.
  // Trigger may already be active; ignore click failures.
  await page
    .locator('button:has(span:has-text("Done"))')
    .first()
    .click()
    .catch(() => undefined);
  await page.locator('[data-testid="complete-heading"]').waitFor({ timeout: 10_000 });
  await page.waitForTimeout(400);
  await snapshot(page, '07-done');

  await browser.close();
}

async function buildGif() {
  console.log('Assembling GIF…');
  // ImageMagick: ordered glob, 1.6s per frame, hold the last frame longer.
  const frames = [
    '01-start-up.png',
    '02-ai-setup.png',
    '03-local-apps-discover.png',
    '04-local-apps-review.png',
    '05-confirm-download.png',
    '06-vpn-setup.png',
    '07-done.png',
  ].map((f) => join(SHOTS_DIR, f));

  for (const f of frames) {
    if (!existsSync(f)) throw new Error(`Missing frame: ${f}`);
  }

  // Use ImageMagick `magick` to build the GIF.
  // 160 = 1.6s between frames; last frame held 320 = 3.2s.
  const args: string[] = ['-loop', '0'];
  for (let i = 0; i < frames.length; i++) {
    const isLast = i === frames.length - 1;
    args.push('-delay', isLast ? '320' : '160');
    args.push(frames[i]);
  }
  args.push('-resize', '960x720');
  args.push('-layers', 'Optimize');
  args.push(OUTPUT_GIF);

  const proc = spawn('magick', args, { stdio: 'inherit' });
  await new Promise<void>((resolveExit, reject) => {
    proc.on('exit', (code) => (code === 0 ? resolveExit() : reject(new Error(`magick exited ${code}`))));
    proc.on('error', reject);
  });

  console.log(`GIF written → ${OUTPUT_GIF}`);
}

async function startFrontend(): Promise<ChildProcess> {
  console.log('Starting frontend dev server…');
  const proc = spawn('pnpm', ['--filter', 'frontend', 'dev'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(FRONTEND_PORT),
      BROWSER: 'none', // prevent the dev server from opening a real browser
      CI: 'true', // also suppresses some dev-server interactivity
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout?.on('data', (d) => process.stdout.write(`[fe] ${d}`));
  proc.stderr?.on('data', (d) => process.stderr.write(`[fe!] ${d}`));
  await waitFor(`${FRONTEND_URL}/onboarding`, 120_000);
  console.log('Frontend ready.');
  return proc;
}

async function main() {
  let feProc: ChildProcess | undefined;
  try {
    feProc = await startFrontend();
    await captureScreenshots();
    await buildGif();
  } finally {
    if (feProc && !feProc.killed) {
      feProc.kill('SIGINT');
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
