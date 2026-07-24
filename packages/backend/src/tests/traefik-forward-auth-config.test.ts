import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// The shared test setup mocks `fs`; these assertions are ABOUT the real files on disk.
const { readFileSync } = await vi.importActual<typeof import('node:fs')>('node:fs');
import { FORWARD_AUTH_SIGNATURE_HEADER, FORWARD_AUTH_TIMESTAMP_HEADER, FORWARD_AUTH_USER_HEADER } from '@/modules/auth/utils/forward-auth-signing';

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

const EXPECTED_HEADERS = [FORWARD_AUTH_USER_HEADER, FORWARD_AUTH_TIMESTAMP_HEADER, FORWARD_AUTH_SIGNATURE_HEADER];

/** The compose label form: a single comma-separated string. */
const COMPOSE_COPIES = ['docker-compose.prod.yml', 'packages/desktop/src-tauri/resources/docker-compose.prod.yml'];

describe('traefik ci-hub forward-auth middleware config', () => {
  it.each(COMPOSE_COPIES)('%s forwards all three signed identity headers', (relativePath) => {
    const content = readFileSync(path.join(REPO_ROOT, relativePath), 'utf-8');
    const match = content.match(/forwardauth\.authResponseHeaders:\s*"([^"]+)"/);
    expect(match, `authResponseHeaders label missing in ${relativePath}`).toBeTruthy();
    const headers = (match?.[1] ?? '').split(',').map((header) => header.trim());
    expect(headers).toEqual(EXPECTED_HEADERS);
  });

  it('backend traefik dynamic.yml forwards all three signed identity headers', () => {
    const content = readFileSync(path.join(REPO_ROOT, 'packages/backend/assets/traefik/dynamic/dynamic.yml'), 'utf-8');
    const section = content.match(/authResponseHeaders:\n((?:\s+-\s+"[^"]+"\n)+)/);
    expect(section, 'authResponseHeaders list missing in dynamic.yml').toBeTruthy();
    const headers = [...(section?.[1] ?? '').matchAll(/-\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(headers).toEqual(EXPECTED_HEADERS);
  });
});
