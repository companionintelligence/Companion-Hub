/**
 * Lightweight mock portal server for e2e tests.
 *
 * Replaces https://portal.companionintelligence.com so CI doesn't hit the
 * real portal (which returns 403 due to Cloudflare Bot Fight Mode).
 *
 * Usage: pnpm exec tsx e2e/mock-portal/server.ts
 * Listens on port 4444.
 */

import http from 'node:http';

const PORT = 4444;

const routes: Record<string, (url: URL) => { body: unknown; status: number }> = {
  'GET /v2/': () => ({ body: {}, status: 200 }),
  'GET /v2/ci-os-hub/tags/list': () => ({ body: { name: 'ci-os-hub', tags: ['1.0.0'] }, status: 200 }),
  'GET /api/store': () => ({ body: [], status: 200 }),
  'GET /api/devices/registration-status': () => ({ body: { registered: true }, status: 200 }),
  'POST /api/devices/register': () => ({ body: { success: true, device_id: 'test-device' }, status: 200 }),
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const key = `${req.method} ${path}`;

  const handler = routes[key] || routes[`${req.method} ${path}/`];
  const result = handler ? handler(url) : { body: { error: 'Not found' }, status: 404 };

  res.writeHead(result.status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result.body));
});

server.listen(PORT, () => {
  // biome-ignore lint/suspicious/noConsole: startup log for CI visibility
  console.log(`Mock portal listening on http://localhost:${PORT}`);
});
