import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DockerReadFacade } from '../docker-read.facade';

describe('DockerReadFacade.runningContainerAddressesForApps', () => {
  let listContainers: ReturnType<typeof vi.fn>;
  let facade: DockerReadFacade;

  const container = (appUrn: string, networks: Record<string, string>, legacyLabel = false) => ({
    Id: `${appUrn}-${Object.values(networks).join('-')}`,
    Labels: legacyLabel ? { 'ci-os-hub.managed': 'true', 'ci-os-hub.appurn': appUrn } : { 'ci-hub.managed': 'true', 'ci-hub.appurn': appUrn },
    NetworkSettings: { Networks: Object.fromEntries(Object.entries(networks).map(([name, ip]) => [name, { IPAddress: ip }])) },
  });

  beforeEach(() => {
    listContainers = vi.fn();
    facade = new DockerReadFacade({ warn: vi.fn(), debug: vi.fn() } as never, { listContainers } as never);
  });

  // A name is any store's to choose; the store half of the URN is the Hub's record of provenance.
  it('collects every network address of running containers of exactly the named URNs, either label set, and no other store', async () => {
    listContainers.mockResolvedValue([
      container('ci-openclaw:ci-marketplace', { 'ci-hub_network': '172.19.0.9', 'ci-openclaw_ci-marketplace_network': '10.128.12.3' }),
      container('openclaw:ci-marketplace', { 'ci-hub_network': '172.19.0.14' }, true),
      container('openclaw:someones-store', { 'openclaw_someones-store_network': '10.128.20.2' }),
      container('ci-memory:ci-marketplace', { 'ci-hub_network': '172.19.0.5' }),
      container('ci-hermes:ci-marketplace', { 'ci-hub_network': '172.19.0.6' }),
    ]);

    const addresses = await facade.runningContainerAddressesForApps(['openclaw:ci-marketplace', 'ci-openclaw:ci-marketplace']);

    expect([...addresses].sort()).toEqual(['10.128.12.3', '172.19.0.14', '172.19.0.9']);
  });

  it('asks Docker for RUNNING managed containers only', async () => {
    listContainers.mockResolvedValue([]);

    await facade.runningContainerAddressesForApps(['openclaw:ci-marketplace']);

    for (const call of listContainers.mock.calls) {
      expect(call[0]).toMatchObject({ all: false });
      expect(String(call[0].filters.label[0])).toMatch(/managed=true$/);
    }
  });

  it('answers empty for no names without touching Docker', async () => {
    await expect(facade.runningContainerAddressesForApps([])).resolves.toEqual(new Set());
    expect(listContainers).not.toHaveBeenCalled();
  });

  it('answers empty when Docker fails, so the guard refuses rather than falls open', async () => {
    listContainers.mockRejectedValue(new Error('socket EACCES'));

    await expect(facade.runningContainerAddressesForApps(['openclaw:ci-marketplace'])).resolves.toEqual(new Set());
  });
});
