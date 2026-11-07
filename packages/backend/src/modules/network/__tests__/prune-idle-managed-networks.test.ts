import type Dockerode from 'dockerode';
import { describe, expect, it, vi } from 'vitest';
import { pruneIdleManagedNetworks } from '../prune-idle-managed-networks';

function fakeDocker(networks: { Name: string; Id: string }[], containers: unknown[], removeImpl?: (id: string) => Promise<void>) {
  const removed: string[] = [];
  const docker = {
    listNetworks: vi.fn().mockResolvedValue(networks),
    listContainers: vi.fn().mockResolvedValue(containers),
    getNetwork: vi.fn((id: string) => ({
      remove: async () => {
        if (removeImpl) {
          await removeImpl(id);
        }
        removed.push(id);
      },
    })),
  };
  return { docker: docker as unknown as Dockerode, raw: docker, removed };
}

const stopped = (network: string, id?: string) => ({ State: 'exited', NetworkSettings: { Networks: { [network]: { NetworkID: id ?? '' } } } });

describe('pruneIdleManagedNetworks', () => {
  it('asks Docker only for networks carrying the managed label, and for stopped containers too', async () => {
    const { docker, raw } = fakeDocker([{ Name: 'a_network', Id: 'a' }], []);
    await pruneIdleManagedNetworks(docker, 'ci-hub.managed');
    expect(raw.listNetworks).toHaveBeenCalledWith({ filters: { label: ['ci-hub.managed=true'] } });
    expect(raw.listContainers).toHaveBeenCalledWith({ all: true });
  });

  it('keeps a network whose only containers are stopped, which a Docker prune would delete (#2313)', async () => {
    const { docker, removed } = fakeDocker(
      [
        { Name: 'excalidraw_ci-marketplace_network', Id: 'n1' },
        { Name: 'uptime-kuma_ci-marketplace_network', Id: 'n2' },
      ],
      [stopped('excalidraw_ci-marketplace_network'), stopped('renamed-elsewhere', 'n2')],
    );
    expect(await pruneIdleManagedNetworks(docker, 'ci-hub.managed')).toEqual([]);
    expect(removed).toEqual([]);
  });

  it('removes a managed network no container names', async () => {
    const { docker, removed } = fakeDocker(
      [
        { Name: 'gone_ci-marketplace_network', Id: 'n1' },
        { Name: 'kept_ci-marketplace_network', Id: 'n2' },
      ],
      [{ State: 'running', NetworkSettings: { Networks: { 'kept_ci-marketplace_network': { NetworkID: 'n2' } } } }],
    );
    expect(await pruneIdleManagedNetworks(docker, 'ci-hub.managed')).toEqual(['gone_ci-marketplace_network']);
    expect(removed).toEqual(['n1']);
  });

  it('treats "in use" and "not found" on removal as a race, not a failure', async () => {
    const { docker } = fakeDocker(
      [
        { Name: 'raced', Id: 'n1' },
        { Name: 'vanished', Id: 'n2' },
      ],
      [],
      async (id) => {
        throw new Error(id === 'n1' ? 'error while removing network: network raced has active endpoints' : 'network n2 not found');
      },
    );
    await expect(pruneIdleManagedNetworks(docker, 'ci-hub.managed')).resolves.toEqual([]);
  });

  it('lets any other removal error reach the caller', async () => {
    const { docker } = fakeDocker([{ Name: 'n', Id: 'n1' }], [], async () => {
      throw new Error('connect EACCES /var/run/docker.sock');
    });
    await expect(pruneIdleManagedNetworks(docker, 'ci-hub.managed')).rejects.toThrow('EACCES');
  });
});
