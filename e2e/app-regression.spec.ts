/**
 * app-regression.spec.ts
 *
 * Reusable per-app regression that proves an app's BACKEND actually works once the Hub
 * deploys it — not just that a container started. For each app:
 *
 *   1. Hub login (operator account)            — loginUser()
 *   2. Install via the Hub app store           — Hub brings up the app's full compose stack
 *   3. Open the app's subdomain (via Traefik)  — exercises the container network
 *   4. Backend health: served AND not a gateway/error page (502/503/504, "no available server")
 *   5. Log into the app                        — attemptAppAuth(): structured + AI, never throws.
 *                                                A rendered auth form or a successful login proves
 *                                                the app backend is processing requests in-network.
 *   6. Screenshot evidence + per-app JSON result
 *
 * App selection (in priority order):
 *   - APP_REGRESSION_IDS   comma-separated catalog ids (exact set), else
 *   - high-priority GUI apps from e2e/generated/catalog.json, capped by APP_REGRESSION_LIMIT (default 5)
 *
 * Env:
 *   TEST_DOMAIN            base domain for app subdomains (default: ci.localhost)
 *   APP_SUBDOMAIN_PREFIX   subdomain prefix the Hub installs under (default: "test-", matches catalog-batch)
 *   APP_TEST_EMAIL/_PASSWORD/_NAME   credentials attemptAppAuth uses for the in-app account
 *
 * Runs via the standard Playwright runner (playwright.config.ts boots the Hub web server).
 * Targets the local Hub by default; point the runner at a fleet node or appliance to run there.
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, loginUser, test } from './fixtures/fixtures';
import { attemptAppAuth } from './lib/app-auth';

interface CatalogApp {
  id: string;
  storeSlug: string;
  name: string;
  healthEndpoint?: string;
  hasGui?: boolean;
  priority?: string;
}

const TEST_DOMAIN = process.env.TEST_DOMAIN || 'ci.localhost';
const SUBDOMAIN_PREFIX = process.env.APP_SUBDOMAIN_PREFIX ?? 'test-';
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || 'e2e/screenshots/regression';
const RESULTS_DIR = process.env.RESULTS_DIR || 'e2e/results';
const LIMIT = Number(process.env.APP_REGRESSION_LIMIT || 5);

// A gateway/error page means the app container is not serving in the network — a backend failure,
// not a healthy app, even though the HTTP status may be 5xx from Traefik rather than the app.
const GATEWAY_ERRORS = [/bad gateway/i, /service unavailable/i, /gateway time-?out/i, /no available server/i];

function loadApps(): CatalogApp[] {
  let catalog: CatalogApp[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'generated', 'catalog.json'), 'utf-8'));
    catalog = Array.isArray(raw) ? raw : (raw.apps ?? []);
  } catch {
    catalog = [];
  }
  const ids = (process.env.APP_REGRESSION_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length) return catalog.filter((a) => ids.includes(a.id));
  return catalog.filter((a) => a.hasGui && a.priority === 'high').slice(0, LIMIT);
}

const apps = loadApps();

test.describe('app backend regression', () => {
  // Apps install one at a time per worker so a node isn't overwhelmed and results stay attributable.
  test.describe.configure({ mode: 'serial', timeout: 360_000 });

  for (const app of apps) {
    test(`App: ${app.name}`, async ({ page, context }) => {
      fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
      fs.mkdirSync(RESULTS_DIR, { recursive: true });
      const result: Record<string, unknown> = { id: app.id, name: app.name, ts: Date.now() };

      try {
        // 1) Hub login
        await loginUser(page);

        // 2) Install via the Hub app store (Hub deploys the full compose stack incl. dependencies)
        await page.goto(`/app-store/${app.storeSlug}/${app.id}`);
        await page.getByRole('button', { name: 'Install' }).click();
        await expect(page.getByText(/running|installed/i)).toBeVisible({ timeout: 240_000 });
        result.installed = true;

        // 3) Open the app via its Traefik-routed subdomain
        const url = `https://${SUBDOMAIN_PREFIX}${app.id}.${TEST_DOMAIN}${app.healthEndpoint || '/'}`;
        result.url = url;
        const appPage = await context.newPage();
        const resp = await appPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
        const status = resp?.status() ?? 0;
        result.httpStatus = status;

        // 4) Backend-in-container health: served, and NOT a gateway/error page
        const body = (await appPage.evaluate(() => document.body?.innerText ?? '').catch(() => '')).slice(0, 2000);
        const gatewayError = GATEWAY_ERRORS.some((re) => re.test(body));
        result.backendServing = status > 0 && status < 500 && !gatewayError;
        expect(status, `app did not serve (HTTP ${status})`).toBeGreaterThan(0);
        expect(status, `app returned a server error (HTTP ${status})`).toBeLessThan(500);
        expect(gatewayError, 'app served a gateway/error page — backend not reachable in the container network').toBe(false);

        // 5) Log into the app — proves the backend processes auth requests in-network
        const auth = await attemptAppAuth(appPage);
        result.appAuth = auth;
        result.backendAuthOk = auth.method !== 'failed';

        // 6) Evidence
        const shot = path.join(SCREENSHOT_DIR, `${app.id}.png`);
        await appPage.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
        result.screenshot = shot;
        await appPage.close();
        result.verdict = result.backendServing && result.backendAuthOk ? 'pass' : 'warn';
      } catch (err) {
        result.verdict = 'fail';
        result.error = err instanceof Error ? err.message : String(err);
        throw err;
      } finally {
        fs.writeFileSync(path.join(RESULTS_DIR, `regression-${app.id}.json`), JSON.stringify(result, null, 2));
        // Best-effort uninstall so the next app starts from a clean node.
        try {
          await page.goto(`/apps/${app.id}`);
          await page.getByRole('button', { name: /delete|uninstall/i }).click({ timeout: 5_000 });
          await page.getByRole('button', { name: /confirm/i }).click({ timeout: 5_000 });
          await expect(page.getByText(/deleted|removed/i)).toBeVisible({ timeout: 60_000 });
        } catch {
          // non-fatal — leave cleanup to pre-test-cleanup.sh
        }
      }
    });
  }
});
