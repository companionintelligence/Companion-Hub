import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type { LoggerService } from '@/core/logger/logger.service';
import type { AppFilesManager } from '@/modules/apps/app-files-manager';
import type { AppsRepository } from '@/modules/apps/apps.repository';
import { EnvUtils } from '@/modules/env/env.utils';
import type { ProxyTrustService, ProxyTrustSnapshot } from '@/modules/network/proxy-trust.service';
import type { AppUrn } from '@ci-hub/common/types';
import type { AppLifecycleService } from '../app-lifecycle.service';
import { TrustedProxyRefreshService } from '../trusted-proxy-refresh.service';

const MEMORY = 'ci-memory:ci-marketplace' as AppUrn;
const N8N = 'n8n:ci-marketplace' as AppUrn;
const EDGE = '10.128.0.3/32,10.128.0.4/32';

/*
 * Each app is handed Traefik's Docker-assigned address on the Hub network as a trusted proxy. When
 * Traefik moves, Docker gives the old address to the next container that asks, and an app still
 * trusting it (Memory's gateway `set_real_ip_from`) would believe whatever client address that
 * container claims. Measured on beta-max: a recreated container took a just-freed address at once.
 */
describe('TrustedProxyRefreshService', () => {
  let apps: MockProxy<AppsRepository>;
  let files: MockProxy<AppFilesManager>;
  let lifecycle: MockProxy<AppLifecycleService>;
  let envs: Record<string, string>;
  let composes: Record<string, string>;
  let service: TrustedProxyRefreshService;
  let listener: ((snapshot: ProxyTrustSnapshot) => void) | undefined;

  const row = (urn: AppUrn, status: string) => {
    const [appName, appStoreSlug] = urn.split(':');
    return { appName, appStoreSlug, status } as never;
  };
  const moved: ProxyTrustSnapshot = { cidrs: ['10.128.0.3/32', '10.128.0.4/32', '172.18.0.9/32'], traefikResolved: true };

  beforeEach(() => {
    vi.stubEnv('HUB_EDGE_CLOUDFLARED_IP', '');
    vi.stubEnv('HUB_EDGE_TAILSCALE_IP', '');
    envs = {
      [MEMORY]: `APP_PORT=8080\nHUB_TRUSTED_PROXY_CIDRS=${EDGE},172.18.0.5/32`,
      [N8N]: `APP_PORT=5678\nHUB_TRUSTED_PROXY_CIDRS=${EDGE},172.18.0.5/32`,
    };
    composes = {
      [MEMORY]: 'services:\n  gateway:\n    environment:\n      TRUSTED_PROXY_CIDRS: ${HUB_TRUSTED_PROXY_CIDRS:-}\n',
      [N8N]: 'services:\n  n8n:\n    image: n8n\n',
    };

    apps = mock<AppsRepository>();
    apps.getApps.mockResolvedValue([row(MEMORY, 'running'), row(N8N, 'running')]);
    files = mock<AppFilesManager>();
    files.getAppEnv.mockImplementation(async (urn) => ({ path: `/app-data/${urn}/app.env`, content: envs[urn] ?? '' }));
    files.getDockerComposeYaml.mockImplementation(async (urn) => ({ path: `/apps/${urn}/docker-compose.yml`, content: composes[urn] ?? null }));
    lifecycle = mock<AppLifecycleService>();
    lifecycle.restartApp.mockResolvedValue({ requestId: 'r' });
    const proxyTrust = mock<ProxyTrustService>();
    proxyTrust.onResolved.mockImplementation((fn) => {
      listener = fn;
      return () => {
        listener = undefined;
      };
    });

    service = new TrustedProxyRefreshService(mock<LoggerService>(), proxyTrust, apps, files, new EnvUtils(), lifecycle);
    service.onModuleInit();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('restarts a running app that reads the value and still trusts the address Traefik left, and nothing else', async () => {
    await expect(service.refresh(moved)).resolves.toEqual([MEMORY]);

    expect(lifecycle.restartApp).toHaveBeenCalledTimes(1);
    expect(lifecycle.restartApp).toHaveBeenCalledWith({ appUrn: MEMORY, skipPull: true, actor: { kind: 'system', reason: 'trusted-proxy-refresh' } });
  });

  it('is driven by every read of the hops', async () => {
    listener?.(moved);
    await vi.waitFor(() => expect(lifecycle.restartApp).toHaveBeenCalledTimes(1));

    service.onModuleDestroy();
    expect(listener).toBeUndefined();
  });

  it('changes nothing on a read that did not find Traefik, so a recreate in progress restarts no app', async () => {
    await expect(service.refresh({ cidrs: ['10.128.0.3/32', '10.128.0.4/32'], traefikResolved: false })).resolves.toEqual([]);
    expect(files.getAppEnv).not.toHaveBeenCalled();
  });

  it('leaves an app that trusts nothing stale: the current set, fewer hops, or no list at all', async () => {
    envs[MEMORY] = `HUB_TRUSTED_PROXY_CIDRS=${EDGE},172.18.0.9/32`;
    await expect(service.refresh(moved)).resolves.toEqual([]);

    // Narrower than it could be, not unsafe.
    envs[MEMORY] = 'HUB_TRUSTED_PROXY_CIDRS=172.18.0.9/32';
    await expect(service.refresh({ ...moved, cidrs: [...moved.cidrs, '172.18.0.10/32'] })).resolves.toEqual([]);

    envs[MEMORY] = 'APP_PORT=8080';
    await expect(service.refresh({ ...moved, cidrs: ['172.18.0.11/32'] })).resolves.toEqual([]);

    expect(lifecycle.restartApp).not.toHaveBeenCalled();
  });

  it('never counts the fixed edge hops as stale, since nothing else can be given their addresses', async () => {
    envs[MEMORY] = `HUB_TRUSTED_PROXY_CIDRS=${EDGE},172.18.0.9/32`;

    await expect(service.refresh({ cidrs: ['172.18.0.9/32'], traefikResolved: true })).resolves.toEqual([]);
  });

  it('leaves a stopped app to pick the set up when it starts', async () => {
    apps.getApps.mockResolvedValue([row(MEMORY, 'stopped')]);

    await expect(service.refresh(moved)).resolves.toEqual([]);
  });

  it('does not restart the same app twice for the same move, but follows Traefik moving back', async () => {
    await service.refresh(moved);
    // The restart is queued; the env still reads stale until it runs.
    await service.refresh({ ...moved, cidrs: [...moved.cidrs] });
    expect(lifecycle.restartApp).toHaveBeenCalledTimes(1);

    // Regenerated onto .9, then Traefik goes back to .5.
    envs[MEMORY] = `HUB_TRUSTED_PROXY_CIDRS=${EDGE},172.18.0.9/32`;
    await expect(service.refresh({ cidrs: ['10.128.0.3/32', '10.128.0.4/32', '172.18.0.5/32'], traefikResolved: true })).resolves.toEqual([MEMORY]);
    expect(lifecycle.restartApp).toHaveBeenCalledTimes(2);
  });

  it('retries on the next read when the restart could not be queued', async () => {
    lifecycle.restartApp.mockRejectedValueOnce(new Error('queue unavailable'));

    await expect(service.refresh(moved)).resolves.toEqual([]);
    await expect(service.refresh(moved)).resolves.toEqual([MEMORY]);
    expect(lifecycle.restartApp).toHaveBeenCalledTimes(2);
  });
});
