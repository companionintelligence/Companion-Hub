import { describe, expect, it } from 'vitest';
import { TraefikLabelsBuilder } from '../traefik-labels.builder';

const base = {
  internalPort: 12002,
  appId: 'ci-import-tools',
  storeId: 'ci-marketplace',
  cloudflareOriginHostname: 'ci-import-tools-core-2.ci.lan',
  exposureMode: 'cloudflare' as const,
};

const build = (overrides: Partial<ConstructorParameters<typeof TraefikLabelsBuilder>[0]> = {}) =>
  new TraefikLabelsBuilder({ ...base, ...overrides }).addCloudflareLabels().build();

describe('TraefikLabelsBuilder — forward-auth middleware', () => {
  it('attaches the middleware to the plain-HTTP router as well as the TLS one', () => {
    const labels = build({ enableAuth: true });

    // The `web` entrypoint is the one the Cloudflare tunnel connects to. Leaving it unguarded
    // let every remote request reach the app unauthenticated while the TLS entrypoint — the
    // one an operator would curl from the appliance — looked correctly gated.
    expect(labels['traefik.http.routers.ci-import-tools-ci-marketplace-insecure.middlewares']).toBe('ci-hub@docker');
    expect(labels['traefik.http.routers.ci-import-tools-ci-marketplace.middlewares']).toBe('ci-hub@docker');
  });

  it('guards every router it creates, so no entrypoint is left open', () => {
    const labels = build({ enableAuth: true });

    // Enumerated rather than asserted individually: a future router added to addCloudflareLabels
    // without a middleware would silently reopen the hole this test exists to close.
    const routers = new Set(
      Object.keys(labels)
        .map((key) => /^traefik\.http\.routers\.([^.]+)\./.exec(key)?.[1])
        .filter((name): name is string => Boolean(name)),
    );
    for (const router of routers) {
      expect(labels[`traefik.http.routers.${router}.middlewares`], `router ${router} is unguarded`).toBe('ci-hub@docker');
    }
  });

  it('attaches no middleware to either router when auth is disabled', () => {
    const labels = build({ enableAuth: false });

    expect(labels['traefik.http.routers.ci-import-tools-ci-marketplace.middlewares']).toBeUndefined();
    expect(labels['traefik.http.routers.ci-import-tools-ci-marketplace-insecure.middlewares']).toBeUndefined();
  });

  it('creates no routers at all outside cloudflare exposure', () => {
    const labels = new TraefikLabelsBuilder({ ...base, exposureMode: 'local', enableAuth: true }).addCloudflareLabels().build();

    expect(Object.keys(labels).some((key) => key.startsWith('traefik.http.routers.'))).toBe(false);
  });
});
