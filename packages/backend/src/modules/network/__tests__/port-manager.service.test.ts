import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PortManagerService } from '../port-manager.service';
import type { PortAllocationRepository } from '../port-allocation.repository';
import type { AppsRepository } from '@/modules/apps/apps.repository';
import type { LoggerService } from '@/core/logger/logger.service';
import type { AppUrn } from '@runtipi/common/types';

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
    deleteByHostPort: vi.fn(),
    _allocations: allocations,
  } as unknown as PortAllocationRepository & { _allocations: typeof allocations };
};

const mockAppsRepo = {} as unknown as AppsRepository;

describe('PortManagerService', () => {
  let service: PortManagerService;
  let repo: ReturnType<typeof createMockRepo>;

  beforeEach(() => {
    repo = createMockRepo();
    service = new PortManagerService(repo, mockAppsRepo, mockLogger);
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
});
