import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type { LoggerService } from '@/core/logger/logger.service';
import type { AppFilesManager } from '@/modules/apps/app-files-manager';
import type { AppsRepository } from '@/modules/apps/apps.repository';
import { EnvUtils } from '@/modules/env/env.utils';
import { traefikAddressOnAppSubnet } from '@/modules/network/app-network-addresses';
import type { ProxyTrustService, ProxyTrustSnapshot } from '@/modules/network/proxy-trust.service';
import type { AppUrn } from '@ci-hub/common/types';
import type { AppLifecycleService } from '../app-lifecycle.service';
import { TrustedProxyRefreshService } from '../trusted-proxy-refresh.service';

const MEMORY = 'ci-memory:ci-marketplace' as AppUrn;
const N8N = 'n8n:ci-marketplace' as AppUrn;
const EDGE = ['10.128.0.3/32', '10.128.0.4/32'];
const SUBNETS: Record<string, string> = { [MEMORY]: '10.128.12.0/24', [N8N]: '10.128.13.0/24' };

/*
 * Each app is told the edge hops and Traefik's fixed address on the app's own network. A running app
 * whose env still trusts something else — Traefik's Docker-assigned address on the shared Hub network
 * from before apps had networks of their own, which Docker gives to the next container that asks, or
 * the Traefik address of a subnet it no longer has — is restarted so its env is written again.
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
    return { appName, appStoreSlug, status, subnet: SUBNETS[urn] ?? null } as never;
  };
  const current = (urn: AppUrn) => [...EDGE, `${traefikAddressOnAppSubnet(SUBNETS[urn])}/32`].join(',');
  const read: ProxyTrustSnapshot = { cidrs: [...EDGE, '10.128.0.2/32', '172.18.0.9/32'], appEdgeCidrs: EDGE, traefikResolved: true };

  beforeEach(() => {
    vi.stubEnv('HUB_EDGE_CLOUDFLARED_IP', '');
    vi.stubEnv('HUB_EDGE_TAILSCALE_IP', '');
    // Both were written before apps had networks of their own: Traefik's address on the shared network.
    envs = {
      [MEMORY]: `APP_PORT=8080\nHUB_TRUSTED_PROXY_CIDRS=${EDGE.join(',')},172.18.0.5/32`,
      [N8N]: `APP_PORT=5678\nHUB_TRUSTED_PROXY_CIDRS=${EDGE.join(',')},172.18.0.5/32`,
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
    proxyTrust.appTrustedProxyCidrs.mockImplementation((subnet) => [...EDGE, ...(subnet ? [`${traefikAddressOnAppSubnet(subnet)}/32`] : [])]);

    service = new TrustedProxyRefreshService(mock<LoggerService>(), proxyTrust, apps, files, new EnvUtils(), lifecycle);
    service.onModuleInit();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('restarts a running app that reads the value and trusts an address outside its network, and nothing else', async () => {
    await expect(service.refresh(read)).resolves.toEqual([MEMORY]);

    expect(lifecycle.restartApp).toHaveBeenCalledTimes(1);
    expect(lifecycle.restartApp).toHaveBeenCalledWith({ appUrn: MEMORY, skipPull: true, actor: { kind: 'system', reason: 'trusted-proxy-refresh' } });
  });

  it('is driven by every read of the hops', async () => {
    listener?.(read);
    await vi.waitFor(() => expect(lifecycle.restartApp).toHaveBeenCalledTimes(1));

    service.onModuleDestroy();
    expect(listener).toBeUndefined();
  });

  it('changes nothing on a read that did not find Traefik, so a recreate in progress restarts no app', async () => {
    await expect(service.refresh({ ...read, traefikResolved: false })).resolves.toEqual([]);
    expect(files.getAppEnv).not.toHaveBeenCalled();
  });

  it('leaves an app that trusts nothing stale: its current set, fewer hops, or no list at all', async () => {
    envs[MEMORY] = `HUB_TRUSTED_PROXY_CIDRS=${current(MEMORY)}`;
    await expect(service.refresh(read)).resolves.toEqual([]);

    // Narrower than it could be, not unsafe.
    envs[MEMORY] = `HUB_TRUSTED_PROXY_CIDRS=${traefikAddressOnAppSubnet(SUBNETS[MEMORY])}/32`;
    await expect(service.refresh({ ...read, cidrs: [...read.cidrs, '172.18.0.10/32'] })).resolves.toEqual([]);

    envs[MEMORY] = 'APP_PORT=8080';
    await expect(service.refresh({ ...read, cidrs: ['172.18.0.11/32'] })).resolves.toEqual([]);

    expect(lifecycle.restartApp).not.toHaveBeenCalled();
  });

  it('counts the Traefik address of another subnet as stale', async () => {
    envs[MEMORY] = `HUB_TRUSTED_PROXY_CIDRS=${EDGE.join(',')},10.128.40.254/32`;

    await expect(service.refresh(read)).resolves.toEqual([MEMORY]);
  });

  it('never counts the fixed edge hops as stale, since nothing else can be given their addresses', async () => {
    envs[MEMORY] = `HUB_TRUSTED_PROXY_CIDRS=${current(MEMORY)}`;

    await expect(service.refresh({ cidrs: ['172.18.0.9/32'], appEdgeCidrs: [], traefikResolved: true })).resolves.toEqual([]);
  });

  it('leaves a stopped app to pick the set up when it starts', async () => {
    apps.getApps.mockResolvedValue([row(MEMORY, 'stopped')]);

    await expect(service.refresh(read)).resolves.toEqual([]);
  });

  it('does not restart the same app twice for the same stale list', async () => {
    await service.refresh(read);
    // The restart is queued; the env still reads stale until it runs.
    await service.refresh({ ...read, cidrs: [...read.cidrs, '172.18.0.12/32'] });
    expect(lifecycle.restartApp).toHaveBeenCalledTimes(1);
  });

  it('retries on the next read when the restart could not be queued', async () => {
    lifecycle.restartApp.mockRejectedValueOnce(new Error('queue unavailable'));

    await expect(service.refresh(read)).resolves.toEqual([]);
    await expect(service.refresh({ ...read, cidrs: [...read.cidrs, '172.18.0.13/32'] })).resolves.toEqual([MEMORY]);
    expect(lifecycle.restartApp).toHaveBeenCalledTimes(2);
  });
});
