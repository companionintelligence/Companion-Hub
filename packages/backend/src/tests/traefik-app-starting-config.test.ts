import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';
import { APP_STARTING_PAGE_PATH } from '@/modules/apps/app-starting-page';
import { APP_STARTING_MIDDLEWARE } from '@/modules/docker/builders/traefik-labels.builder';

// The shared test setup mocks `fs`; these assertions are ABOUT the real files on disk.
const { readFileSync } = await vi.importActual<typeof import('node:fs')>('node:fs');

/**
 * Lock-step guard for the `ci-hub-app-starting` errors middleware (CI-Hub#1764), which every app
 * router ends with. Traefik disables a router whose middleware is missing or broken, so a mistake in
 * this definition would take every app offline rather than just lose the page.
 */
const REPO_ROOT = path.join(__dirname, '../../../..');
const DYNAMIC_YML = 'packages/backend/assets/traefik/dynamic/dynamic.yml';
const read = (relativePath: string) => readFileSync(path.join(REPO_ROOT, relativePath), 'utf-8');

/** Whether an errors middleware's `status` list catches `code`, read as Traefik reads it: codes, comma lists, inclusive ranges. */
const catches = (statuses: string[], code: number) =>
  statuses
    .flatMap((entry) => entry.split(','))
    .some((part) => {
      const [from = Number.NaN, to = from] = part.trim().split('-').map(Number);
      return code >= from && code <= to;
    });

describe('traefik ci-hub-app-starting middleware config', () => {
  const dynamic = YAML.parse(read(DYNAMIC_YML));
  const [name, provider] = APP_STARTING_MIDDLEWARE.split('@');

  it('is the file-provider middleware the routers name, catching 502 and 504', () => {
    expect(provider).toBe('file');
    const errors = dynamic.http.middlewares[name as string].errors;

    expect(errors.status).toEqual(['502', '504']);
    // No statusRewrites: the visitor, an API client or a health check must still see the failure.
    expect(errors).not.toHaveProperty('statusRewrites');
  });

  /*
   * An app's own 503 reaches its client untouched, body and headers: apps send it on purpose.
   * Companion Memory's PowerSync token endpoint answers 503 by design, and model servers answer
   * 503 while a model loads; an HTML page in place of those bodies would break their clients.
   */
  it('lets a 503 from the app through untouched', () => {
    const { status } = dynamic.http.middlewares[name as string].errors;

    expect(catches(status, 502)).toBe(true);
    expect(catches(status, 504)).toBe(true);
    expect(catches(status, 503)).toBe(false);
    // Nor any other error the app answers with itself.
    for (const code of [400, 401, 404, 429, 500, 501, 505, 599]) {
      expect(catches(status, code), String(code)).toBe(false);
    }
  });

  it('asks the Hub for the page at the path its controller serves, without the visitor’s URL', () => {
    const { query, service } = dynamic.http.middlewares[name as string].errors;

    expect(query).toBe(`${APP_STARTING_PAGE_PATH}?status={status}`);
    // `{url}` would put the visitor's full URL, tokens in its query string and all, on the Hub's
    // request line. The Host header already says which app it is.
    expect(query).not.toContain('{url}');
    expect(dynamic.http.services[service].loadBalancer.servers).toEqual([{ url: 'http://ci-hub:5002' }]);
  });

  it("passes the visitor's Host through, which is how the Hub knows the app", () => {
    const { service } = dynamic.http.middlewares[name as string].errors;

    expect(dynamic.http.services[service].loadBalancer.passHostHeader).toBe(true);
  });

  it('bounds how long a Hub that is down can hold an app’s error response', () => {
    const { service } = dynamic.http.middlewares[name as string].errors;
    const transport = dynamic.http.serversTransports[dynamic.http.services[service].loadBalancer.serversTransport];

    expect(transport.forwardingTimeouts).toEqual({ dialTimeout: '2s', responseHeaderTimeout: '5s' });
  });

  /*
   * Traefik's file provider reads every file as a Go template, comments included: any `{{` in it is a
   * template error, and Traefik then drops the WHOLE file, forward auth, the edge-header strip and this
   * page with it. Measured on traefik:v3.6.7. The desktop app and the CLI write the asset as shipped,
   * before the Hub has run, so the asset itself must have none (Companion-Hub#1832).
   */
  it('has no template braces as shipped', () => {
    expect(read(DYNAMIC_YML)).not.toContain('{{');
  });

  it("stays off the Hub's own routes", () => {
    for (const compose of ['docker-compose.prod.yml', 'packages/desktop/src-tauri/resources/docker-compose.prod.yml']) {
      expect(read(compose), compose).not.toContain(name as string);
    }
    // An entry-point default would land on every router, the Hub's included.
    const staticConfig = YAML.parse(read('packages/backend/assets/traefik/traefik.yml'));
    for (const [entryPoint, settings] of Object.entries(staticConfig.entryPoints as Record<string, { http?: { middlewares?: unknown } }>)) {
      expect(settings.http?.middlewares, entryPoint).toBeUndefined();
    }
  });
});
