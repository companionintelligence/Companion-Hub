import type Dockerode from 'dockerode';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import YAML from 'yaml';
import type { ConfigurationService } from '@/core/config/configuration.service';
import type { FilesystemService } from '@/core/filesystem/filesystem.service';
import type { LoggerService } from '@/core/logger/logger.service';
import type { AppsRepository } from '@/modules/apps/apps.repository';
import { APP_STARTING_MIDDLEWARE } from '../builders/traefik-labels.builder';
import { TraefikConfigService } from '../traefik-config.service';

const written = new Map<string, string>();
const writeHealableTextFile = vi.fn(async (filePath: string, content: string) => {
  written.set(filePath, content);
});
vi.mock('@/common/helpers/bind-mount-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/common/helpers/bind-mount-helpers')>()),
  writeHealableTextFile: (filePath: string, content: string) => writeHealableTextFile(filePath, content),
}));

const FILE = '/data/state/traefik/dynamic/tailscale-services.yml';

/** The routes of Private VPN apps on their own Tailscale Service hostnames. */
describe('TraefikConfigService.syncTailscaleServiceRoutes', () => {
  let service: TraefikConfigService;
  let filesystem: ReturnType<typeof mock<FilesystemService>>;

  beforeEach(() => {
    written.clear();
    writeHealableTextFile.mockClear();
    const config = mock<ConfigurationService>();
    config.getConfig.mockReturnValue({ directories: { dataDir: '/data' } } as never);
    filesystem = mock<FilesystemService>();
    filesystem.pathExists.mockImplementation(async (filePath: string) => written.has(filePath));
    filesystem.readTextFile.mockImplementation(async (filePath: string) => written.get(filePath) ?? null);
    filesystem.removeFile.mockImplementation(async (filePath: string) => {
      written.delete(filePath);
    });
    service = new TraefikConfigService(mock<LoggerService>(), config, filesystem, mock<Dockerode>(), mock<AppsRepository>());
  });

  const parsed = () => YAML.parse(written.get(FILE) ?? 'null');

  it('routes the Service hostname to the app with the Hub login first', async () => {
    await service.syncTailscaleServiceRoutes([
      { appUrn: 'memory:official', host: 'memory.tail123.ts.net', upstreamUrl: 'http://10.128.11.2:3000', requireLogin: true, publicPaths: [] },
    ]);

    const { routers, services } = parsed().http;
    expect(routers['memory-official-tailscale-service']).toEqual({
      rule: 'Host(`memory.tail123.ts.net`)',
      service: 'memory-official-tailscale-service',
      entryPoints: ['web'],
      middlewares: ['ci-hub@file', APP_STARTING_MIDDLEWARE],
    });
    expect(services['memory-official-tailscale-service']).toEqual({ loadBalancer: { servers: [{ url: 'http://10.128.11.2:3000' }] } });
  });

  it('opens only the operator’s public paths without the login, in a twin of the route', async () => {
    await service.syncTailscaleServiceRoutes([
      {
        appUrn: 'memory:official',
        host: 'memory.tail123.ts.net',
        upstreamUrl: 'http://10.128.11.2:3000',
        requireLogin: true,
        publicPaths: ['/hook/'],
      },
    ]);

    const twin = parsed().http.routers['memory-official-tailscale-service-public-paths'];
    expect(twin.rule).toBe('(Host(`memory.tail123.ts.net`)) && (Path(`/hook`) || PathPrefix(`/hook/`))');
    expect(twin.middlewares).toEqual([APP_STARTING_MIDDLEWARE]);
    expect(twin.service).toBe('memory-official-tailscale-service');
  });

  it('carries no login on an app whose operator switched it off, and no twin', async () => {
    await service.syncTailscaleServiceRoutes([
      {
        appUrn: 'tool:_user',
        host: 'tool.tail123.ts.net',
        upstreamUrl: 'http://host.docker.internal:8123',
        requireLogin: false,
        publicPaths: ['/x'],
      },
    ]);

    const { routers } = parsed().http;
    expect(routers['tool-_user-tailscale-service'].middlewares).toEqual([APP_STARTING_MIDDLEWARE]);
    expect(routers).not.toHaveProperty('tool-_user-tailscale-service-public-paths');
  });

  it('leaves an unchanged file alone, so Traefik does not reload every pass', async () => {
    const routes = [
      { appUrn: 'memory:official', host: 'memory.tail123.ts.net', upstreamUrl: 'http://10.128.11.2:3000', requireLogin: true, publicPaths: [] },
    ];
    await service.syncTailscaleServiceRoutes(routes);
    await service.syncTailscaleServiceRoutes(routes);

    expect(writeHealableTextFile).toHaveBeenCalledTimes(1);
  });

  it('removes the file once no app is on a Service', async () => {
    await service.syncTailscaleServiceRoutes([
      { appUrn: 'memory:official', host: 'memory.tail123.ts.net', upstreamUrl: 'http://10.128.11.2:3000', requireLogin: true, publicPaths: [] },
    ]);
    await service.syncTailscaleServiceRoutes([]);

    expect(written.has(FILE)).toBe(false);
  });
});
