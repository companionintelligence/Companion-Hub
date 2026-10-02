import type Dockerode from 'dockerode';
import type { AppUrn } from '@ci-hub/common/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import YAML from 'yaml';
import { hubNetworkName } from '@/common/constants';
import type { ConfigurationService } from '@/core/config/configuration.service';
import type { FilesystemService } from '@/core/filesystem/filesystem.service';
import type { LoggerService } from '@/core/logger/logger.service';
import { APP_STARTING_MIDDLEWARE } from '../builders/traefik-labels.builder';
import { TraefikConfigService } from '../traefik-config.service';

const written = new Map<string, string>();
vi.mock('@/common/helpers/bind-mount-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/common/helpers/bind-mount-helpers')>()),
  writeHealableTextFile: vi.fn(async (filePath: string, content: string) => {
    written.set(filePath, content);
  }),
}));

const DYNAMIC_DIR = '/data/state/traefik/dynamic';

/**
 * Which routers the Hub writes for Traefik's file provider end with the app-starting page
 * (CI-Hub#1764): every app route, and never the Hub's own.
 */
describe('TraefikConfigService — the app-starting page', () => {
  let docker: ReturnType<typeof mock<Dockerode>>;
  let service: TraefikConfigService;

  beforeEach(() => {
    written.clear();
    const config = mock<ConfigurationService>();
    config.getConfig.mockReturnValue({ directories: { dataDir: '/data' } } as never);
    const filesystem = mock<FilesystemService>();
    filesystem.pathExists.mockResolvedValue(false);
    filesystem.readTextFile.mockImplementation(async (filePath: string) => written.get(filePath) ?? null);
    docker = mock<Dockerode>();
    service = new TraefikConfigService(mock<LoggerService>(), config, filesystem, docker);
  });

  const parsed = (file: string) => YAML.parse(written.get(`${DYNAMIC_DIR}/${file}`) ?? 'null');

  it('ends every port-expose route with it', async () => {
    await service.syncPortExposeRoutes([
      { appUrn: 'my-service:_user' as AppUrn, traefikHost: 'my-service-hub1-acme.ci.lan', upstreamPort: 8123 },
      { appUrn: 'other:_user' as AppUrn, traefikHost: 'other-hub1-acme.ci.lan', upstreamPort: 9000 },
    ]);

    const { routers } = parsed('port-expose.yml').http;
    expect(routers['my-service-_user'].middlewares).toEqual([APP_STARTING_MIDDLEWARE]);
    expect(routers['other-_user'].middlewares).toEqual([APP_STARTING_MIDDLEWARE]);
  });

  it("never adds it to the Hub's own public route", async () => {
    await service.writeHubRoute('hub1-acme', 'ci0.pw');

    const hub = parsed('hub.yml');
    expect(hub.http.routers['hub-public']).not.toHaveProperty('middlewares');
    expect(written.get(`${DYNAMIC_DIR}/hub.yml`)).not.toContain('ci-hub-app-starting');
  });

  it('carries an app container’s chain into apps.yml, and skips the Hub’s container', async () => {
    const containers: Record<string, { Name: string; Labels: Record<string, string> }> = {
      app: {
        Name: '/nginx-store-id-nginx-1',
        Labels: {
          'traefik.enable': 'true',
          'traefik.http.routers.nginx-store-id-insecure.rule': 'Host(`nginx-hub1-acme.ci.lan`)',
          'traefik.http.routers.nginx-store-id-insecure.entrypoints': 'web',
          'traefik.http.routers.nginx-store-id-insecure.service': 'nginx-store-id',
          'traefik.http.routers.nginx-store-id-insecure.middlewares': 'ci-hub-edge-headers@file,ci-hub@file,ci-hub-app-starting@file',
          'traefik.http.services.nginx-store-id.loadbalancer.server.port': '80',
        },
      },
      hub: {
        Name: '/ci-hub',
        Labels: {
          'traefik.enable': 'true',
          'traefik.http.routers.ci-hub.rule': 'Host(`ci-hub.local`)',
          'traefik.http.routers.ci-hub.entrypoints': 'web',
          'traefik.http.routers.ci-hub.service': 'ci-hub',
          'traefik.http.services.ci-hub.loadbalancer.server.port': '5002',
        },
      },
    };
    docker.listContainers.mockResolvedValue(Object.keys(containers).map((Id) => ({ Id })) as never);
    docker.getContainer.mockImplementation(
      (id: string) =>
        ({
          inspect: async () => ({
            Name: containers[id]?.Name,
            Config: { Labels: containers[id]?.Labels },
            NetworkSettings: { Networks: { [hubNetworkName()]: { IPAddress: '172.30.0.9' } } },
          }),
        }) as never,
    );

    await service.generateTraefikConfig();

    const { routers } = parsed('apps.yml').http;
    expect(routers['nginx-store-id-insecure'].middlewares).toEqual(['ci-hub-edge-headers@file', 'ci-hub@file', 'ci-hub-app-starting@file']);
    expect(routers).not.toHaveProperty('ci-hub');
  });
});
