import type { AppUrn } from '@ci-hub/common/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DockerReadFacade } from '../docker-read.facade';

describe('DockerReadFacade.getRoutedContainerNames', () => {
  const appUrn = 'test-app:test-store' as AppUrn;
  let listContainers: ReturnType<typeof vi.fn>;
  let facade: DockerReadFacade;

  const web = {
    Id: 'web-id',
    Names: ['/test-app_test-store-web-1'],
    State: 'running',
    Labels: { 'traefik.enable': 'true' },
    HostConfig: { NetworkMode: 'bridge' },
  };
  const db = { Id: 'db-id', Names: ['/test-app_test-store-db-1'], State: 'running', Labels: {}, HostConfig: { NetworkMode: 'bridge' } };
  const sidecar = {
    Id: 'sidecar-id',
    Names: ['/test-app_test-store-sidecar-1'],
    State: 'running',
    Labels: {},
    HostConfig: { NetworkMode: 'container:web-id' },
  };

  beforeEach(() => {
    listContainers = vi.fn().mockResolvedValue([sidecar, db, web]);
    facade = new DockerReadFacade({ warn: vi.fn(), debug: vi.fn() } as never, { listContainers } as never);
  });

  it('returns the routed container then a sibling on its network namespace and leaves the rest out', async () => {
    await expect(facade.getRoutedContainerNames(appUrn)).resolves.toEqual(['test-app_test-store-web-1', 'test-app_test-store-sidecar-1']);
  });

  it('names a routed container once when it also shares another routed container network', async () => {
    listContainers.mockResolvedValue([web, { ...sidecar, Labels: { 'traefik.enable': 'true' } }]);

    await expect(facade.getRoutedContainerNames(appUrn)).resolves.toEqual(['test-app_test-store-web-1', 'test-app_test-store-sidecar-1']);
  });

  it('counts stopped containers', async () => {
    listContainers.mockResolvedValue([{ ...web, State: 'exited' }, db]);

    await expect(facade.getRoutedContainerNames(appUrn)).resolves.toEqual(['test-app_test-store-web-1']);
    expect(listContainers.mock.calls[0]?.[0]).toMatchObject({ all: true });
  });

  // A listing's other services get `traefik.enable` for routes of their own. They don't carry the web route.
  it("leaves out a routed container without the app's own service when another one has it", async () => {
    const service = 'traefik.http.services.test-app-test-store.loadbalancer.server.port';
    listContainers.mockResolvedValue([
      { ...db, Labels: { 'traefik.enable': 'true', 'traefik.http.routers.test-app-test-store-s3.rule': 'Host(`s3`)' } },
      { ...web, Labels: { 'traefik.enable': 'true', [service]: '80' } },
    ]);

    await expect(facade.getRoutedContainerNames(appUrn)).resolves.toEqual(['test-app_test-store-web-1']);
  });

  it('downOnly leaves out a running routed container and its sibling', async () => {
    await expect(facade.getRoutedContainerNames(appUrn, { downOnly: true })).resolves.toEqual([]);
  });

  it('downOnly returns a routed container that is down, with its running sibling', async () => {
    listContainers.mockResolvedValue([sidecar, db, { ...web, State: 'exited' }]);

    await expect(facade.getRoutedContainerNames(appUrn, { downOnly: true })).resolves.toEqual([
      'test-app_test-store-web-1',
      'test-app_test-store-sidecar-1',
    ]);
  });
});
