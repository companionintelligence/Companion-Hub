import { describe, expect, it } from 'vitest';
import { buildAgentApp, exposureModeLabel, resolveExposureMode, type StoreAppLite } from './agent-onboarding';

const storeApps: StoreAppLite[] = [
  { id: 'ci-openclaw', name: 'OpenClaw', urn: 'urn:store:ci-openclaw' },
  { id: 'ci-hermes', name: 'Hermes', urn: 'urn:store:ci-hermes' },
  { id: 'immich', name: 'Immich', urn: 'urn:store:immich' },
];

describe('buildAgentApp', () => {
  it('resolves openclaw to its store app (name + urn)', () => {
    const app = buildAgentApp('openclaw', storeApps);
    expect(app).toMatchObject({
      appSlug: 'ci-openclaw',
      name: 'OpenClaw',
      urn: 'urn:store:ci-openclaw',
      icon: '/agents/openclaw.png',
      localSubdomain: 'ci-openclaw',
      category: 'ai',
    });
  });

  it('maps hermes framework to the ci-hermes store slug', () => {
    const app = buildAgentApp('hermes', storeApps);
    expect(app).toMatchObject({ appSlug: 'ci-hermes', name: 'Hermes', urn: 'urn:store:ci-hermes' });
  });

  it('leaves urn undefined and uses a fallback name when the agent app is not in the store', () => {
    const app = buildAgentApp('openclaw', []);
    expect(app.urn).toBeUndefined();
    expect(app.name).toBe('OpenClaw');
    expect(app.appSlug).toBe('ci-openclaw');
  });
});

describe('resolveExposureMode', () => {
  const cases: Array<{
    chosen: Parameters<typeof resolveExposureMode>[0];
    avail: { cloudflareAvailable: boolean; tailscaleAvailable: boolean };
    expected: ReturnType<typeof resolveExposureMode>;
  }> = [
    // tailscale chosen
    { chosen: 'tailscale', avail: { cloudflareAvailable: false, tailscaleAvailable: true }, expected: 'tailscale' },
    { chosen: 'tailscale', avail: { cloudflareAvailable: true, tailscaleAvailable: false }, expected: 'cloudflare' },
    { chosen: 'tailscale', avail: { cloudflareAvailable: false, tailscaleAvailable: false }, expected: 'local' },
    // cloudflare chosen
    { chosen: 'cloudflare', avail: { cloudflareAvailable: true, tailscaleAvailable: false }, expected: 'cloudflare' },
    { chosen: 'cloudflare', avail: { cloudflareAvailable: false, tailscaleAvailable: true }, expected: 'tailscale' },
    { chosen: 'cloudflare', avail: { cloudflareAvailable: false, tailscaleAvailable: false }, expected: 'local' },
    // explicit local is respected
    { chosen: 'local', avail: { cloudflareAvailable: true, tailscaleAvailable: true }, expected: 'local' },
    // undefined (AI skipped) uses whatever remote transport is available
    { chosen: undefined, avail: { cloudflareAvailable: true, tailscaleAvailable: false }, expected: 'cloudflare' },
    { chosen: undefined, avail: { cloudflareAvailable: false, tailscaleAvailable: true }, expected: 'tailscale' },
    { chosen: undefined, avail: { cloudflareAvailable: false, tailscaleAvailable: false }, expected: 'local' },
  ];

  for (const { chosen, avail, expected } of cases) {
    it(`chosen=${chosen ?? 'undefined'} cf=${avail.cloudflareAvailable} ts=${avail.tailscaleAvailable} -> ${expected}`, () => {
      expect(resolveExposureMode(chosen, avail)).toBe(expected);
    });
  }
});

describe('exposureModeLabel', () => {
  it('labels each mode', () => {
    expect(exposureModeLabel('tailscale')).toMatch(/Private VPN/);
    expect(exposureModeLabel('cloudflare')).toMatch(/Web/);
    expect(exposureModeLabel('local')).toMatch(/device/);
  });
});
