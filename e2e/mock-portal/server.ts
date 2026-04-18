/**
 * Lightweight scenario-configurable mock portal server for e2e tests.
 *
 * Replaces https://portal.companionintelligence.com so CI doesn't hit the
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

import http from 'node:http';
import { buildRoutes, type PortalScenario, PORTAL_SCENARIOS } from './scenarios.js';

const PORT = Number.parseInt(process.env.MOCK_PORTAL_PORT || '4444', 10);

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

  const routes = buildRoutes(currentScenario);
  const key = `${req.method} ${pathname}`;
  const handler = routes[key] || routes[`${req.method} ${pathname}/`];
  const result = handler ? handler(url) : { body: { error: 'Not found' }, status: 404 };

  res.writeHead(result.status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result.body));
});

server.listen(PORT, () => {
  // biome-ignore lint/suspicious/noConsole: startup log for CI visibility
  console.log(`Mock portal listening on http://localhost:${PORT} (scenario: ${currentScenario})`);
});
