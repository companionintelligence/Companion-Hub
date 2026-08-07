/**
 * Lightweight scenario-configurable mock portal server for e2e tests.
 *
 * Replaces https://hub.companionintelligence.com so CI doesn't hit the
 * real portal (which returns 403 due to Cloudflare Bot Fight Mode).
 *
 * Scenarios are controlled via the MOCK_PORTAL_SCENARIO env var or the
 * POST /___control endpoint. Supported scenarios:
 *   - registered (default): Hub is registered and fully functional
 *   - unregistered: Hub has no registration; portal rejects status checks
 *   - delayed: Registration exists but public domain is not yet propagated
 *   - degraded: Portal returns 500 errors for most endpoints
 *
 * Usage: pnpm exec tsx e2e/mock-portal/server.ts
 * Listens on port 4444.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { buildRoutes, type PortalScenario, PORTAL_SCENARIOS } from './scenarios.js';

const PORT = Number.parseInt(process.env.MOCK_PORTAL_PORT || '4444', 10);

/**
 * `GET /store/:slug/install` — the install bundle.
 *
 * `ReposHelpers.downloadAppFiles` fetches this for every `ci_cloud_api` store
 * before an install, and the Hub force-sets `ci-marketplace` to that type on
 * boot (`app-store.service.ts:150`). Without this route the mock portal answers
 * 404, `installApp` fails with "Failed to fetch app files: 404", and NO app can
 * ever genuinely install on the e2e/video stage — which is exactly why
 * `running-app` sat unfilmable (video/README.md § "Shots that cannot be filmed
 * yet") and why `/resource-monitor` was cut from the storyboard.
 *
 * The bundle is not fabricated. Production's `GetInstallBundle`
 * (CI-Portal `apps/hono-app/src/domains/store/handlers/GetInstallBundle.ts:54`)
 * answers with `{ files: { 'config.json', 'docker-compose.json', … } }`, and the
 * Portal's own catalog is ingested from CI-Marketplace. This serves those same
 * two files straight off the CI-Marketplace checkout that `start-backend.sh`
 * already symlinks into the Hub's store — so the Hub installs the real app's
 * real compose, and everything downstream (compose generation, `docker compose
 * up`, container health, the status pill) is the untouched product.
 *
 * Reads the checkout at request time rather than caching, so editing the
 * marketplace copy between passes is picked up without a restart.
 */
const MARKETPLACE_DIR = process.env.CI_MARKETPLACE_DIR || path.join(process.cwd(), '..', 'CI-Marketplace');

function installBundle(slug: string): { status: number; body: unknown } {
  // Reject anything that could climb out of the apps directory.
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) return { status: 404, body: { error: 'App not found' } };

  const appDir = path.join(MARKETPLACE_DIR, 'apps', slug);
  const files: Record<string, string> = {};

  for (const name of ['config.json', 'docker-compose.json']) {
    try {
      files[name] = fs.readFileSync(path.join(appDir, name), 'utf8');
    } catch {
      // config.json is required; a missing compose is a real (publishable) state.
      if (name === 'config.json') return { status: 404, body: { error: 'App not found' } };
    }
  }

  return { status: 200, body: { files } };
}

let currentScenario: PortalScenario = (process.env.MOCK_PORTAL_SCENARIO as PortalScenario) || 'registered';

if (!PORTAL_SCENARIOS.includes(currentScenario)) {
  currentScenario = 'registered';
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  // Control endpoint — switch scenario at runtime
  if (req.method === 'POST' && pathname === '/___control') {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body) as { scenario?: string };
        const requested = parsed.scenario as PortalScenario;
        if (requested && PORTAL_SCENARIOS.includes(requested)) {
          currentScenario = requested;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ scenario: currentScenario }));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid scenario', valid: PORTAL_SCENARIOS }));
        }
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // Status endpoint — report current scenario
  if (req.method === 'GET' && pathname === '/___control') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ scenario: currentScenario }));
    return;
  }

  // Dynamic route — the exact-match table below cannot express `:slug`. The Hub
  // registers the cloud store at `${CI_CLOUD_URL}/api` (app-store.service.ts:128)
  // and downloadAppFiles appends `/store/<slug>/install`, so the path that
  // actually arrives is `/api/store/<slug>/install`.
  const installMatch = pathname.match(/^\/api\/store\/([^/]+)\/install$/);
  if (req.method === 'GET' && installMatch) {
    const result = installBundle(decodeURIComponent(installMatch[1] as string));
    res.writeHead(result.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result.body));
    return;
  }

  const routes = buildRoutes(currentScenario);
  const key = `${req.method} ${pathname}`;
  const handler = routes[key] || routes[`${req.method} ${pathname}/`];

  const respond = (body?: unknown) => {
    const result = handler ? handler(url, body) : { body: { error: 'Not found' }, status: 404 };
    res.writeHead(result.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result.body));
  };

  // Credential-checking routes (sign-in) need the payload, so buffer it for any
  // method that carries one. GETs skip the read and answer immediately.
  if (req.method === 'GET' || req.method === 'HEAD') {
    respond();
    return;
  }

  let raw = '';
  req.on('data', (chunk: Buffer) => {
    raw += chunk.toString();
  });
  req.on('end', () => {
    let parsed: unknown;
    try {
      parsed = raw ? JSON.parse(raw) : undefined;
    } catch {
      parsed = undefined;
    }
    respond(parsed);
  });
});

server.listen(PORT, () => {
  // biome-ignore lint/suspicious/noConsole: startup log for CI visibility
  console.log(`Mock portal listening on http://localhost:${PORT} (scenario: ${currentScenario})`);
});
