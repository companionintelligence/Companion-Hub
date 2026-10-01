import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// The shared test setup mocks `fs`; these assertions are ABOUT the real files on disk.
const { readFileSync } = await vi.importActual<typeof import('node:fs')>('node:fs');
import {
  FORWARD_AUTH_SIGNATURE_HEADER,
  FORWARD_AUTH_TIMESTAMP_HEADER,
  FORWARD_AUTH_USER_HEADER,
  FORWARD_AUTH_USER_ID_HEADER,
  FORWARD_AUTH_USER_ID_SIGNATURE_HEADER,
  FORWARD_AUTH_USER_ISSUER_HEADER,
} from '@/modules/auth/utils/forward-auth-signing';
import { EDGE_HEADERS_MIDDLEWARE } from '@/modules/docker/builders/traefik-labels.builder';
import YAML from 'yaml';

/**
 * Lock-step guard for the Traefik `ci-hub` forward-auth middleware config (CI-Engineering#74).
 *
 * Traefik copies ONLY the headers listed in `authResponseHeaders` from the Hub's
 * `/api/auth/traefik` response onto the forwarded request. The Hub signs the identity with
 * three headers (user + timestamp + signature); a copy of this config that lists fewer drops
 * the signature and every in-app verifier fails closed with `missing_headers` — silently, and
 * only in deployments using that copy. These assertions pin every shipped copy to the full set.
 */
const REPO_ROOT = path.join(__dirname, '../../../..');

// The stable-id trio too: a copy that drops it silently turns every app's rename-proof link back
// into a username lookup, and lets a visitor's own unsigned copy through to the app.
const EXPECTED_HEADERS = [
  FORWARD_AUTH_USER_HEADER,
  FORWARD_AUTH_TIMESTAMP_HEADER,
  FORWARD_AUTH_SIGNATURE_HEADER,
  FORWARD_AUTH_USER_ISSUER_HEADER,
  FORWARD_AUTH_USER_ID_HEADER,
  FORWARD_AUTH_USER_ID_SIGNATURE_HEADER,
];

/** The compose label form: a single comma-separated string. */
const COMPOSE_COPIES = ['docker-compose.prod.yml', 'packages/desktop/src-tauri/resources/docker-compose.prod.yml'];

describe('traefik ci-hub forward-auth middleware config', () => {
  it.each(COMPOSE_COPIES)('%s forwards every signed identity header', (relativePath) => {
    const content = readFileSync(path.join(REPO_ROOT, relativePath), 'utf-8');
    const match = content.match(/forwardauth\.authResponseHeaders:\s*"([^"]+)"/);
    expect(match, `authResponseHeaders label missing in ${relativePath}`).toBeTruthy();
    const headers = (match?.[1] ?? '').split(',').map((header) => header.trim());
    expect(headers).toEqual(EXPECTED_HEADERS);
  });

  /*
   * The entry points trust cloudflared's forwarded headers (traefik.yml `trustedIPs`), and Cloudflare
   * passes a visitor's own X-Forwarded-Uri / -Method / -Host through. With `trustForwardHeader: true`
   * forward auth would take those instead of the request the router matched: a visitor could name
   * Memory's public path while asking for another, and pass the Memory-only exemption.
   */
  it.each(COMPOSE_COPIES)('%s decides forward auth from the matched request, not forwarded headers', (relativePath) => {
    const content = readFileSync(path.join(REPO_ROOT, relativePath), 'utf-8');
    expect(content).toMatch(/forwardauth\.trustForwardHeader:\s*"false"/);
    expect(content).not.toMatch(/trustForwardHeader:\s*"?true/);
  });

  /*
   * `maxResponseBodySize` is what keeps Traefik from buffering an unbounded reply from the auth
   * server. It only exists from Traefik 3.6.9, so the pin has to be at least that or Traefik refuses
   * the label and the middleware, and with it every protected app, stops loading.
   */
  it.each(COMPOSE_COPIES)('%s bounds the forward-auth reply on a Traefik that supports it', (relativePath) => {
    const content = readFileSync(path.join(REPO_ROOT, relativePath), 'utf-8');
    expect(content).toMatch(/forwardauth\.maxResponseBodySize:\s*"16384"/);

    const version = content.match(/image:\s*traefik:v(\d+)\.(\d+)\.(\d+)/);
    expect(version, `traefik image pin missing in ${relativePath}`).toBeTruthy();
    const [major, minor, patch] = (version ?? []).slice(1).map(Number) as [number, number, number];
    expect(major * 1_000_000 + minor * 1_000 + patch).toBeGreaterThanOrEqual(3_006_009);
  });

  /*
   * The labels ship in the same compose file as the image pin, so they are never ahead of the Traefik that
   * reads them. dynamic.yml is written by the Hub and the CLI on their own schedule and can sit beside an
   * older Traefik, which rejects a field it does not know and discards the whole file.
   */
  it('backend traefik dynamic.yml does not use a field only a newer Traefik knows', () => {
    const dynamic = YAML.parse(readFileSync(path.join(REPO_ROOT, 'packages/backend/assets/traefik/dynamic/dynamic.yml'), 'utf-8'));
    expect(dynamic.http.middlewares['ci-hub'].forwardAuth).not.toHaveProperty('maxResponseBodySize');
  });

  it('backend traefik dynamic.yml decides forward auth from the matched request, and strips visitor-set headers on tunnel routes', () => {
    const dynamic = YAML.parse(readFileSync(path.join(REPO_ROOT, 'packages/backend/assets/traefik/dynamic/dynamic.yml'), 'utf-8'));
    expect(dynamic.http.middlewares['ci-hub'].forwardAuth.trustForwardHeader).toBe(false);

    // The name the label builder puts first on every tunnel route must exist, or Traefik disables the route.
    const [name, provider] = EDGE_HEADERS_MIDDLEWARE.split('@');
    expect(provider).toBe('file');
    const stripped = dynamic.http.middlewares[name as string].headers.customRequestHeaders;
    // Traefik keeps these from a trusted peer and fills them only when empty; nothing upstream sets them.
    for (const header of ['X-Real-Ip', 'X-Forwarded-Prefix', 'X-Forwarded-Uri', 'X-Forwarded-Method', 'X-Forwarded-Tls-Client-Cert']) {
      expect(stripped[header], header).toBe('');
    }
    // Cloudflare rewrites these two, and the Hub and apps rely on them, so they must survive.
    expect(stripped).not.toHaveProperty('X-Forwarded-For');
    expect(stripped).not.toHaveProperty('X-Forwarded-Proto');
  });

  it('backend traefik dynamic.yml forwards every signed identity header', () => {
    const content = readFileSync(path.join(REPO_ROOT, 'packages/backend/assets/traefik/dynamic/dynamic.yml'), 'utf-8');
    const section = content.match(/authResponseHeaders:\n((?:\s+-\s+"[^"]+"\n)+)/);
    expect(section, 'authResponseHeaders list missing in dynamic.yml').toBeTruthy();
    const headers = [...(section?.[1] ?? '').matchAll(/-\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(headers).toEqual(EXPECTED_HEADERS);
  });
});
