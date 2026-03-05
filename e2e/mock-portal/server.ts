/**
 * Lightweight mock portal server for e2e tests.
 *
 * Replaces https://portal.companionintelligence.com so CI doesn't hit the
 * real portal (which returns 403 due to Cloudflare Bot Fight Mode).
 *
 * Usage: bun run e2e/mock-portal/server.ts
 * Listens on port 4444.
 */

const PORT = 4444;

const routes: Record<string, (url: URL) => Response> = {
  // Docker registry v2 ping
  'GET /v2/': () => json({}),

  // Registry tag list
  'GET /v2/ci-os-hub/tags/list': () => json({ name: 'ci-os-hub', tags: ['1.0.0'] }),

  // Store metadata (app store list)
  'GET /api/store': () => json([]),

  // Device registration status
  'GET /api/devices/registration-status': () => json({ registered: false }),

  // Device register (POST)
  'POST /api/devices/register': () => json({ success: true, device_id: 'test-device' }),
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const key = `${req.method} ${path}`;

    // Try exact match first, then try with trailing slash variants
    const handler = routes[key] || routes[`${req.method} ${path}/`];
    if (handler) {
      return handler(url);
    }

    // 404 for anything else
    return json({ error: 'Not found' }, 404);
  },
});

// biome-ignore lint/suspicious/noConsole: startup log
console.log(`Mock portal listening on http://localhost:${PORT}`);
