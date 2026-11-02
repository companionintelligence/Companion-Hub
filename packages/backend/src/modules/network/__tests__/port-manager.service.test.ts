import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PortManagerService } from '../port-manager.service';
import type { PortAllocationRepository } from '../port-allocation.repository';
import type { LoggerService } from '@/core/logger/logger.service';
import type { AppUrn } from '@ci-hub/common/types';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as LoggerService;

const createMockRepo = () => {
  const allocations: Array<{
    id: number;
    appUrn: string;
    hostPort: number;
    containerPort: number;
    protocol: string;
    label: string;
    createdAt: string;
  }> = [];
  let nextId = 1;

  return {
    create: vi.fn(async (data: { appUrn: string; hostPort: number; containerPort: number; protocol: string; label: string }) => {
      const alloc = { ...data, id: nextId++, createdAt: new Date().toISOString() };
      allocations.push(alloc);
      return alloc;
    }),
    getByAppUrn: vi.fn(async (appUrn: string) => allocations.filter((a) => a.appUrn === appUrn)),
    getByHostPort: vi.fn(async (port: number, protocol: string) => allocations.find((a) => a.hostPort === port && a.protocol === protocol)),
    getAllHostPorts: vi.fn(async (protocol: string) => allocations.filter((a) => a.protocol === protocol).map((a) => a.hostPort)),
    getAll: vi.fn(async () => [...allocations]),
    deleteByAppUrn: vi.fn(async (appUrn: string) => {
      const before = allocations.length;
      const toRemove = allocations.filter((a) => a.appUrn === appUrn);
      for (const r of toRemove) {
        allocations.splice(allocations.indexOf(r), 1);
      }
      return before - allocations.length;
    }),
    updateHostPort: vi.fn(async (id: number, hostPort: number) => {
      const allocation = allocations.find((a) => a.id === id);
      if (allocation) {
        allocation.hostPort = hostPort;
      }
    }),
    deleteByHostPort: vi.fn(async (port: number, protocol: string) => {
      const index = allocations.findIndex((a) => a.hostPort === port && a.protocol === protocol);
      if (index !== -1) {
        allocations.splice(index, 1);
      }
    }),
    _allocations: allocations,
  } as unknown as PortAllocationRepository & { _allocations: typeof allocations };
};

describe('PortManagerService', () => {
  let service: PortManagerService;
  let repo: ReturnType<typeof createMockRepo>;

  beforeEach(() => {
    repo = createMockRepo();
    service = new PortManagerService(repo, mockLogger);
  });

  it('should allocate a port with preferred host port when available', async () => {
    const allocations = await service.allocatePorts('testapp:store' as AppUrn, [{ containerPort: 8080, label: 'main', preferredHostPort: 15000 }]);

    expect(allocations).toHaveLength(1);
    expect(allocations[0]?.hostPort).toBe(15000);
    expect(allocations[0]?.containerPort).toBe(8080);
    expect(allocations[0]?.label).toBe('main');
    expect(allocations[0]?.protocol).toBe('tcp');
  });

  it('should allocate multiple ports for multi-port apps', async () => {
    const allocations = await service.allocatePorts('multiport:store' as AppUrn, [
      { containerPort: 8080, label: 'main', preferredHostPort: 15000 },
      { containerPort: 9443, label: 'https', preferredHostPort: 15001 },
      { containerPort: 51820, label: 'wireguard', protocol: 'udp', preferredHostPort: 51820 },
    ]);

    expect(allocations).toHaveLength(3);
    expect(allocations.map((a) => a.label)).toEqual(['main', 'https', 'wireguard']);
    expect(allocations[2]?.protocol).toBe('udp');
  });

  it('should release all ports for an app', async () => {
    await service.allocatePorts('testapp:store' as AppUrn, [
      { containerPort: 8080, label: 'main', preferredHostPort: 15000 },
      { containerPort: 9090, label: 'admin', preferredHostPort: 15001 },
    ]);

    const released = await service.releaseAll('testapp:store' as AppUrn);
    expect(released).toBe(2);

    const remaining = await service.getAppPorts('testapp:store' as AppUrn);
    expect(remaining).toHaveLength(0);
  });

  it('should get the main port for an app', async () => {
    await service.allocatePorts('testapp:store' as AppUrn, [
      { containerPort: 8080, label: 'main', preferredHostPort: 15000 },
      { containerPort: 9090, label: 'admin', preferredHostPort: 15001 },
    ]);

    const mainPort = await service.getMainPort('testapp:store' as AppUrn);
    expect(mainPort).toBe(15000);
  });

  it('should return null main port when no main allocation exists', async () => {
    const mainPort = await service.getMainPort('nonexistent:store' as AppUrn);
    expect(mainPort).toBeNull();
  });

  it('should reject reserved ports', async () => {
    const available = await service.isPortAvailable(5432);
    expect(available).toBe(false);
  });

  it('should reject already-allocated ports', async () => {
    await service.allocatePorts('testapp:store' as AppUrn, [{ containerPort: 8080, label: 'main', preferredHostPort: 15000 }]);

    const available = await service.isPortAvailable(15000);
    expect(available).toBe(false);
  });

  it('should handle migration of existing apps', async () => {
    await service.migrateExistingApp('legacy:store' as AppUrn, 8080, 8080);

    const ports = await service.getAppPorts('legacy:store' as AppUrn);
    expect(ports).toHaveLength(1);
    expect(ports[0]?.label).toBe('main');
    expect(ports[0]?.hostPort).toBe(8080);
  });

  it('should not duplicate migration for already-migrated apps', async () => {
    await service.migrateExistingApp('legacy:store' as AppUrn, 8080, 8080);
    await service.migrateExistingApp('legacy:store' as AppUrn, 8080, 8080);

    const ports = await service.getAppPorts('legacy:store' as AppUrn);
    expect(ports).toHaveLength(1);
  });

  it('should retry on unique constraint violation during allocation', async () => {
    let callCount = 0;
    const origCreate = repo.create;
    repo.create = vi.fn(async (data) => {
      callCount++;
      if (callCount === 1) {
        throw new Error('duplicate key value violates unique constraint "port_protocol_idx"');
      }
      return origCreate(data);
    }) as typeof repo.create;

    const allocations = await service.allocatePorts('retry-app:store' as AppUrn, [{ containerPort: 8080, label: 'main', preferredHostPort: 15000 }]);

    expect(allocations).toHaveLength(1);
    expect(callCount).toBe(2); // First failed, second succeeded
  });

  describe('setMainPort', () => {
    const app = 'port-test:_user' as AppUrn;
    const other = 'holder:_user' as AppUrn;

    it('records a port set by hand on the allocation the app has, so the old one is free again', async () => {
      await service.migrateExistingApp(app, 10000, 80);

      await expect(service.setMainPort(app, 18558)).resolves.toBe(true);

      expect(await service.getMainPort(app)).toBe(18558);
      expect(repo._allocations).toEqual([expect.objectContaining({ appUrn: app, hostPort: 18558, containerPort: 80, label: 'main' })]);
    });

    it('never takes a port another app holds: it answers false and leaves both apps alone', async () => {
      await service.migrateExistingApp(app, 10000, 80);
      await service.migrateExistingApp(other, 10001, 80);

      await expect(service.setMainPort(app, 10001)).resolves.toBe(false);

      expect(await service.getMainPort(app)).toBe(10000);
      expect(await service.getMainPort(other)).toBe(10001);
      expect(repo.updateHostPort).not.toHaveBeenCalled();
    });

    it('answers false when another app takes the port between the check and the write', async () => {
      await service.migrateExistingApp(app, 10000, 80);
      repo.updateHostPort.mockRejectedValueOnce(Object.assign(new Error('Failed query'), { cause: { code: '23505' } }));

      await expect(service.setMainPort(app, 18558)).resolves.toBe(false);
    });

    it('lets any other database failure through', async () => {
      await service.migrateExistingApp(app, 10000, 80);
      repo.updateHostPort.mockRejectedValueOnce(new Error('connection lost'));

      await expect(service.setMainPort(app, 18558)).rejects.toThrow('connection lost');
    });

    it('has nothing to do for an app on that port already, or with no main allocation', async () => {
      await service.migrateExistingApp(app, 10000, 80);

      await expect(service.setMainPort(app, 10000)).resolves.toBe(true);
      await expect(service.setMainPort('no-port:_user' as AppUrn, 18558)).resolves.toBe(true);

      expect(repo.updateHostPort).not.toHaveBeenCalled();
      expect(repo.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('getPortHolder', () => {
    it('names the allocation that holds a port but nothing for a free one', async () => {
      await service.migrateExistingApp('holder:_user' as AppUrn, 10001, 80);

      expect(await service.getPortHolder(10001)).toEqual(expect.objectContaining({ appUrn: 'holder:_user' }));
      expect(await service.getPortHolder(10002)).toBeUndefined();
    });
  });

  describe('moveMainPort', () => {
    it('gives the main port a new host port, skipping the refused one and every port in avoid', async () => {
      const appUrn = 'openclaw:store' as AppUrn;
      await service.allocatePorts(appUrn, [
        { containerPort: 18789, label: 'main', preferredHostPort: 18789 },
        { containerPort: 9090, label: 'admin', preferredHostPort: 15001 },
      ]);

      const moved = await service.moveMainPort(appUrn, new Set([10000, 10001]));

      expect(moved).toMatchObject({ appUrn, containerPort: 18789, protocol: 'tcp', label: 'main' });
      expect([18789, 10000, 10001]).not.toContain(moved?.hostPort);
      expect(await service.getMainPort(appUrn)).toBe(moved?.hostPort);
      // The other allocation stays where it was.
      expect((await service.getAppPorts(appUrn)).map((a) => [a.label, a.hostPort]).sort()).toEqual(
        [
          ['admin', 15001],
          ['main', moved?.hostPort],
        ].sort(),
      );
    });

    it('keeps the main port it had when no new port can be allocated', async () => {
      const appUrn = 'openclaw:store' as AppUrn;
      const [main] = await service.allocatePorts(appUrn, [{ containerPort: 18789, label: 'main', preferredHostPort: 18789 }]);
      vi.mocked(repo.create).mockRejectedValueOnce(new Error('database unavailable'));

      await expect(service.moveMainPort(appUrn, new Set())).rejects.toThrow('database unavailable');

      expect(await service.getMainPort(appUrn)).toBe(main?.hostPort);
    });

    it('returns null and allocates nothing for an app with no main allocation', async () => {
      const moved = await service.moveMainPort('nothing:store' as AppUrn, new Set());

      expect(moved).toBeNull();
      expect(repo.create).not.toHaveBeenCalled();
    });
  });
});
