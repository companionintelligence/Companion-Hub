import { describe, expect, it, vi } from 'vitest';
import type { AppUrn } from '@ci-hub/common/types';
import { allocateCustomAppHostPort, ensureCustomAppHostPort } from '../custom-app-host-port';

const APP_URN = 'my-nginx:_user' as AppUrn;

/** A port manager that hands out `hostPort` for whatever it is asked, and records what it was asked. */
const portManagerGiving = (hostPort: number, mainPort: number | null = null) => ({
  allocatePorts: vi.fn(async (_appUrn: AppUrn, requests: Array<{ containerPort: number; label: string; preferredHostPort?: number }>) =>
    requests.map((request, index) => ({
      id: index + 1,
      appUrn: APP_URN,
      hostPort,
      containerPort: request.containerPort,
      protocol: 'tcp' as const,
      label: request.label,
      createdAt: '2026-10-10T00:00:00.000Z',
    })),
  ),
  getMainPort: vi.fn(async (_appUrn: AppUrn) => mainPort),
});

describe('allocateCustomAppHostPort', () => {
  it('asks the port manager for the internal port first, keeps it as the container port, and returns the host port it gives', async () => {
    const portManager = portManagerGiving(10000);

    await expect(allocateCustomAppHostPort(portManager, APP_URN, 80)).resolves.toBe(10000);
    expect(portManager.allocatePorts).toHaveBeenCalledWith(APP_URN, [{ containerPort: 80, label: 'main', preferredHostPort: 80 }]);
  });

  it('does not ask for a host port the app already maps itself in Port Mappings', async () => {
    const portManager = portManagerGiving(10001);

    await allocateCustomAppHostPort(portManager, APP_URN, 18080, new Set([18080]));

    expect(portManager.allocatePorts).toHaveBeenCalledWith(APP_URN, [{ containerPort: 18080, label: 'main', preferredHostPort: undefined }]);
  });
});

describe('ensureCustomAppHostPort', () => {
  const appsRepositoryWith = (config: Record<string, unknown>) => ({
    getAppByUrn: vi.fn(async () => ({ id: 4, config }) as never),
    updateAppById: vi.fn(async () => undefined as never),
  });

  it('allocates a host port for a custom app that has none, and writes it to the row with the rest of its config', async () => {
    const portManager = portManagerGiving(10002);
    const appsRepository = appsRepositoryWith({ exposureMode: 'local' });

    await expect(ensureCustomAppHostPort(portManager, appsRepository, APP_URN, 80)).resolves.toBe(10002);
    expect(portManager.allocatePorts).toHaveBeenCalledWith(APP_URN, [{ containerPort: 80, label: 'main', preferredHostPort: 80 }]);
    expect(appsRepository.updateAppById).toHaveBeenCalledWith(4, { config: { exposureMode: 'local', port: 10002 }, port: 10002 });
  });

  it('reuses a main port the app was already given rather than allocating a second one', async () => {
    const portManager = portManagerGiving(10003, 15000);
    const appsRepository = appsRepositoryWith({});

    await expect(ensureCustomAppHostPort(portManager, appsRepository, APP_URN, 80)).resolves.toBe(15000);
    expect(portManager.allocatePorts).not.toHaveBeenCalled();
    expect(appsRepository.updateAppById).toHaveBeenCalledWith(4, { config: { port: 15000 }, port: 15000 });
  });
});
