import { describe, expect, it, vi } from 'vitest';
import type { AppUrn } from '@ci-hub/common/types';
import {
  allocateCustomAppHostPort,
  customAppMainPortAvoids,
  ensureCustomAppHostPort,
  hubHostPorts,
  mappedHostPorts,
  parsePort,
} from '../custom-app-host-port';

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
  releaseAll: vi.fn(async (_appUrn: AppUrn) => (mainPort === null ? 0 : 1)),
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

  it('keeps a new host port off the ports it is told to avoid', async () => {
    const portManager = portManagerGiving(10004);

    await ensureCustomAppHostPort(portManager, appsRepositoryWith({}), APP_URN, 8443, new Set([8443]));

    expect(portManager.allocatePorts).toHaveBeenCalledWith(APP_URN, [{ containerPort: 8443, label: 'main', preferredHostPort: undefined }]);
  });

  // The boot backfill records a row's port as its main allocation, and a settings save had copied the internal port there.
  it('gives back a main port it already holds when that is one to avoid, and allocates another', async () => {
    const portManager = portManagerGiving(10005, 80);
    const appsRepository = appsRepositoryWith({ port: 80 });

    await expect(ensureCustomAppHostPort(portManager, appsRepository, APP_URN, 80, new Set([80, 443, 8080]))).resolves.toBe(10005);
    expect(portManager.releaseAll).toHaveBeenCalledWith(APP_URN);
    expect(appsRepository.updateAppById).toHaveBeenCalledWith(4, { config: { port: 10005 }, port: 10005 });
  });

  it('writes nothing when the row already carries the port', async () => {
    const portManager = portManagerGiving(10006, 15000);
    const appsRepository = {
      getAppByUrn: vi.fn(async () => ({ id: 4, port: 15000, config: { port: 15000 } }) as never),
      updateAppById: vi.fn(async () => undefined as never),
    };

    await ensureCustomAppHostPort(portManager, appsRepository, APP_URN, 80);

    expect(appsRepository.updateAppById).not.toHaveBeenCalled();
  });
});

describe('customAppMainPortAvoids', () => {
  const publishing = (rows: Array<{ appName: string; appStoreSlug: string }>) => ({ getAppsByPort: vi.fn(async () => rows as never) });

  it("adds the app's own TCP mappings and an internal port another app's row publishes to the Hub's web ports", async () => {
    const avoid = await customAppMainPortAvoids(
      publishing([{ appName: 'jellyfin', appStoreSlug: '_user' }]),
      APP_URN,
      [
        { hostPort: 9100, protocol: 'tcp' },
        { hostPort: 5353, protocol: 'udp' },
      ],
      8096,
      new Set([80]),
    );

    expect(avoid).toEqual(new Set([80, 9100, 8096]));
  });

  it("does not count the app's own row as another app publishing its internal port", async () => {
    const avoid = await customAppMainPortAvoids(publishing([{ appName: 'my-nginx', appStoreSlug: '_user' }]), APP_URN, [], 8081, new Set());

    expect(avoid.has(8081)).toBe(false);
  });
});

describe('parsePort and mappedHostPorts', () => {
  it.each([
    [8080, 8080],
    ['8080', 8080],
    [' 3000 ', 3000],
    ['${APP_PORT}', undefined],
    ['8000-8010', undefined],
    [0, undefined],
    [80.5, undefined],
    [70000, undefined],
    [undefined, undefined],
  ])('reads %j as %j', (input, expected) => {
    expect(parsePort(input)).toBe(expected);
  });

  it('publishes a mapping on TCP unless it is UDP only, and skips one it cannot read', () => {
    expect(
      mappedHostPorts([
        { addPorts: [{ hostPort: '9100' }, { hostPort: 53, udp: true }, { hostPort: 5000, tcp: true, udp: true }, { hostPort: '${PORT}' }, null] },
        null,
        {},
      ]),
    ).toEqual([
      { hostPort: 9100, protocol: 'tcp' },
      { hostPort: 53, protocol: 'udp' },
      { hostPort: 5000, protocol: 'tcp' },
      { hostPort: 5000, protocol: 'udp' },
    ]);
    expect(mappedHostPorts(undefined)).toEqual([]);
  });
});

describe('hubHostPorts', () => {
  it("is Traefik's default host ports and the Hub's API, database and queue ports when the env file names none", () => {
    expect(hubHostPorts(undefined, {})).toEqual(new Set([80, 443, 8080, 5002, 6543, 5001]));
  });

  it('follows the ports the desktop app wrote to the env file, and keeps the web port settings', () => {
    expect(hubHostPorts({ port: 8000, sslPort: 8001 }, { HTTP_PORT: '8880', HTTPS_PORT: ' 8443 ', TRAEFIK_DASHBOARD_PORT: 'not-a-port' })).toEqual(
      new Set([8880, 8443, 8080, 5002, 6543, 5001, 8000, 8001]),
    );
  });
});
