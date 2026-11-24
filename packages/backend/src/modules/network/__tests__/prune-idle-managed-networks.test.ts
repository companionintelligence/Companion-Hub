import type Dockerode from 'dockerode';
import { describe, expect, it, vi } from 'vitest';
import { pruneIdleManagedNetworks } from '../prune-idle-managed-networks';

const LABEL = 'ci-hub.managed';

const managed = (Name: string, Id: string) => ({ Name, Id, Labels: { [LABEL]: 'true' } });

function fakeDocker(
  networks: { Name: string; Id: string; Labels?: Record<string, string> }[],
  containers: unknown[],
  removeImpl?: (id: string) => Promise<void>,
) {
  const removed: string[] = [];
  const docker = {
    listNetworks: vi.fn().mockResolvedValue(networks),
    // Ignores filters, like an engine that does not support them: the code under test must not trust them.
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
  it('asks Docker for networks carrying the managed label and for stopped containers too', async () => {
    const { docker, raw } = fakeDocker([managed('a_network', 'a')], []);
    await pruneIdleManagedNetworks(docker, LABEL);
    expect(raw.listNetworks).toHaveBeenCalledWith({ filters: { label: ['ci-hub.managed=true'] } });
    expect(raw.listContainers).toHaveBeenCalledWith({ all: true });
  });

  it('keeps a network whose only containers are stopped, which a Docker prune would delete (#2313)', async () => {
    const { docker, removed } = fakeDocker(
      [managed('excalidraw_ci-marketplace_network', 'n1'), managed('uptime-kuma_ci-marketplace_network', 'n2')],
      [stopped('excalidraw_ci-marketplace_network'), stopped('renamed-elsewhere', 'n2')],
    );
    expect(await pruneIdleManagedNetworks(docker, LABEL)).toEqual({ removed: [], failed: [] });
    expect(removed).toEqual([]);
  });

  it('removes a managed network no container names', async () => {
    const { docker, removed } = fakeDocker(
      [managed('gone_ci-marketplace_network', 'n1'), managed('kept_ci-marketplace_network', 'n2')],
      [{ State: 'running', NetworkSettings: { Networks: { 'kept_ci-marketplace_network': { NetworkID: 'n2' } } } }],
    );
    expect(await pruneIdleManagedNetworks(docker, LABEL)).toEqual({ removed: ['gone_ci-marketplace_network'], failed: [] });
    expect(removed).toEqual(['n1']);
  });

  it('keeps a network a container was created on after the first list', async () => {
    const { docker, raw, removed } = fakeDocker([managed('booting_ci-marketplace_network', 'n1')], []);
    raw.listContainers
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ State: 'created', NetworkSettings: { Networks: { 'booting_ci-marketplace_network': { NetworkID: '' } } } }]);

    expect(await pruneIdleManagedNetworks(docker, LABEL)).toEqual({ removed: [], failed: [] });
    expect(raw.listContainers).toHaveBeenLastCalledWith({ all: true, filters: { network: ['booting_ci-marketplace_network', 'n1'] } });
    expect(removed).toEqual([]);
  });

  it('leaves a network without the label alone when the engine ignores the filter', async () => {
    const { docker, raw, removed } = fakeDocker(
      [
        { Name: 'someone-elses_default', Id: 'n1', Labels: {} },
        { Name: 'bridge', Id: 'n2' },
      ],
      [],
    );
    expect(await pruneIdleManagedNetworks(docker, LABEL)).toEqual({ removed: [], failed: [] });
    expect(raw.listContainers).not.toHaveBeenCalled();
    expect(removed).toEqual([]);
  });

  it('treats "in use" and "not found" on removal as a race', async () => {
    const { docker } = fakeDocker([managed('raced', 'n1'), managed('vanished', 'n2')], [], async (id) => {
      throw new Error(id === 'n1' ? 'error while removing network: network raced has active endpoints' : 'network n2 not found');
    });
    await expect(pruneIdleManagedNetworks(docker, LABEL)).resolves.toEqual({ removed: [], failed: [] });
  });

  it('reports any other removal error and still tries the remaining networks', async () => {
    const { docker, removed } = fakeDocker([managed('stuck', 'n1'), managed('gone', 'n2')], [], async (id) => {
      if (id === 'n1') {
        throw new Error('(HTTP code 500) server error - iptables failed');
      }
    });
    expect(await pruneIdleManagedNetworks(docker, LABEL)).toEqual({
      removed: ['gone'],
      failed: [{ networkName: 'stuck', message: '(HTTP code 500) server error - iptables failed' }],
    });
    expect(removed).toEqual(['n2']);
  });
});
