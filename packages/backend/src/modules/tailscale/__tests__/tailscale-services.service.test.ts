import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppUrn } from '@ci-hub/common/types';

const storeDir = '/data/ts-services-svc';

vi.mock('../tailscale-services.store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tailscale-services.store')>();
  const store = new actual.TailscaleServicesStore('/data/ts-services-svc/oauth.json', '/data/ts-services-svc/services.json');
  return { ...actual, tailscaleServicesStore: store };
});

import { TailscaleApiError } from '../tailscale-admin-api.service';
import { TailscaleServicesService } from '../tailscale-services.service';
import { tailscaleServicesStore } from '../tailscale-services.store';

const MEMORY = 'memory:official' as AppUrn;
const WEBUI = 'open-webui:official' as AppUrn;

function taggedNode(overrides: Record<string, unknown> = {}) {
  return {
    installed: true,
    connected: true,
    version: '1.98.3',
    hostname: 'hub-tailscale',
    nodeFqdn: 'hub-tailscale.tail123.ts.net',
    tailnet: 'tail123.ts.net',
    ip: '100.64.0.9',
    supportsServices: true,
    httpsAvailable: true,
    backendState: 'Running',
    authUrl: null,
    tags: ['tag:ci-hub'],
    stableNodeId: 'nNODE1CNTRL',
    ...overrides,
  };
}

function makeService() {
  const tailscale = {
    getServicesNodeStatus: vi.fn().mockResolvedValue(taggedNode()),
    getServicesUpstream: vi.fn().mockReturnValue('http://10.128.0.2:80'),
    getServicesNodeServeConfig: vi.fn().mockResolvedValue(new Map()),
    serveService: vi.fn().mockResolvedValue(undefined),
    clearServiceOnServicesNode: vi.fn().mockResolvedValue(undefined),
    joinServicesNodeTagged: vi.fn().mockResolvedValue(undefined),
    waitForServicesNode: vi.fn().mockResolvedValue(undefined),
  };
  const adminApi = {
    getAccessToken: vi.fn().mockResolvedValue('token'),
    forgetTokens: vi.fn(),
    getService: vi.fn().mockResolvedValue(null),
    putService: vi.fn().mockImplementation(async (service) => service),
    deleteService: vi.fn().mockResolvedValue(undefined),
    listServiceHosts: vi.fn().mockResolvedValue([]),
    approveServiceHost: vi.fn().mockResolvedValue(undefined),
  };
  const docker = { ensureContainerRunning: vi.fn().mockResolvedValue(undefined) };
  const moduleRef = { get: vi.fn().mockReturnValue(docker) };
  const service = new TailscaleServicesService(tailscale as any, adminApi as any, moduleRef as any);
  return { service, tailscale, adminApi, docker };
}

async function marker() {
  return `Managed by CI-Hub (${await tailscaleServicesStore.installId()})`;
}

describe('TailscaleServicesService', () => {
  beforeEach(async () => {
    fs.rmSync(path.join(storeDir, 'services.json'), { force: true });
    fs.rmSync(path.join(storeDir, 'oauth.json'), { force: true });
    delete process.env.TAILSCALE_OAUTH_CLIENT_ID;
    delete process.env.TAILSCALE_OAUTH_CLIENT_SECRET;
    await tailscaleServicesStore.saveOAuthClient({ clientId: 'k1', clientSecret: 'tskey-client-s1', tag: 'tag:ci-hub' });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('sync', () => {
    it('defines, serves and approves a Service for a new app, then records its hostname', async () => {
      const { service, tailscale, adminApi } = makeService();

      const result = await service.sync([{ appUrn: MEMORY, label: 'memory' }], 'https://desk.tail123.ts.net');

      expect(result.ready).toBe(true);
      expect(adminApi.putService).toHaveBeenCalledWith({ name: 'svc:memory', comment: await marker(), ports: ['tcp:443'], tags: ['tag:ci-hub'] });
      expect(tailscale.serveService).toHaveBeenCalledWith('svc:memory', 'http://10.128.0.2:80');
      expect(adminApi.approveServiceHost).toHaveBeenCalledWith('svc:memory', 'nNODE1CNTRL');
      expect(result.published.get(MEMORY)).toEqual({ name: 'svc:memory', fqdn: 'memory.tail123.ts.net' });
      expect(tailscaleServicesStore.appForServiceHost('memory.tail123.ts.net')).toBe(MEMORY);
      expect(tailscaleServicesStore.hubOrigin()).toBe('https://desk.tail123.ts.net');
    });

    it("takes the name with the Hub's node after it when someone else owns the app's own", async () => {
      const { service, adminApi } = makeService();
      adminApi.getService.mockImplementation(async (name: string) => (name === 'svc:memory' ? { name, comment: 'someone else' } : null));

      const result = await service.sync([{ appUrn: MEMORY, label: 'memory' }], null);

      expect(adminApi.putService).toHaveBeenCalledWith(expect.objectContaining({ name: 'svc:memory-hub-tailscale' }));
      expect(result.published.get(MEMORY)?.fqdn).toBe('memory-hub-tailscale.tail123.ts.net');
    });

    it('leaves an app on its port when every name is taken', async () => {
      const { service, adminApi, tailscale } = makeService();
      adminApi.getService.mockImplementation(async (name: string) => ({ name, comment: 'someone else' }));

      const result = await service.sync([{ appUrn: MEMORY, label: 'memory' }], null);

      expect(result.published.size).toBe(0);
      expect(adminApi.putService).not.toHaveBeenCalled();
      expect(tailscale.serveService).not.toHaveBeenCalled();
    });

    it('rewrites nothing for a Service already defined, served and approved', async () => {
      const { service, adminApi, tailscale } = makeService();
      const ours = await marker();
      adminApi.getService.mockResolvedValue({ name: 'svc:memory', comment: ours, ports: ['tcp:443'], tags: ['tag:ci-hub'] });
      tailscale.getServicesNodeServeConfig.mockResolvedValue(
        new Map([['svc:memory', { Web: { 'memory.tail123.ts.net:443': { Handlers: { '/': { Proxy: 'http://10.128.0.2:80' } } } } }]]),
      );
      adminApi.listServiceHosts.mockResolvedValue([{ stableNodeID: 'nNODE1CNTRL', approvalLevel: 'approved:manual' }]);

      await service.sync([{ appUrn: MEMORY, label: 'memory' }], null);

      expect(adminApi.putService).not.toHaveBeenCalled();
      expect(tailscale.serveService).not.toHaveBeenCalled();
      expect(adminApi.approveServiceHost).not.toHaveBeenCalled();
    });

    it('removes the Service of an app that left, deleting only one this install defined', async () => {
      const { service, adminApi, tailscale } = makeService();
      await service.sync(
        [
          { appUrn: MEMORY, label: 'memory' },
          { appUrn: WEBUI, label: 'open-webui' },
        ],
        null,
      );
      const ours = await marker();
      adminApi.getService.mockImplementation(async (name: string) => ({ name, comment: ours, ports: ['tcp:443'], tags: ['tag:ci-hub'] }));

      const result = await service.sync([{ appUrn: MEMORY, label: 'memory' }], null);

      expect(tailscale.clearServiceOnServicesNode).toHaveBeenCalledWith('svc:open-webui');
      expect(adminApi.deleteService).toHaveBeenCalledWith('svc:open-webui');
      expect([...result.published.keys()]).toEqual([MEMORY]);
    });

    it('does not delete a Service someone else took over, but stops serving it', async () => {
      const { service, adminApi, tailscale } = makeService();
      await service.sync([{ appUrn: WEBUI, label: 'open-webui' }], null);
      adminApi.getService.mockResolvedValue({ name: 'svc:open-webui', comment: 'not ours' });

      await service.sync([], null);

      expect(tailscale.clearServiceOnServicesNode).toHaveBeenCalledWith('svc:open-webui');
      expect(adminApi.deleteService).not.toHaveBeenCalled();
    });

    it.each([
      ['an untagged node', { tags: [] }, 'node-not-tagged'],
      ['a signed-out node', { connected: false, backendState: 'NeedsLogin' }, 'node-signed-out'],
      ['a node older than 1.86', { version: '1.84.0' }, 'node-too-old'],
    ])('publishes and removes nothing on %s', async (_name, overrides, blocker) => {
      const { service, tailscale, adminApi } = makeService();
      await service.sync([{ appUrn: MEMORY, label: 'memory' }], null);
      vi.clearAllMocks();
      tailscale.getServicesNodeStatus.mockResolvedValue(taggedNode(overrides));

      const result = await service.sync([], null);

      expect(result).toEqual({ published: new Map(), ready: false });
      expect(tailscale.clearServiceOnServicesNode).not.toHaveBeenCalled();
      expect(adminApi.deleteService).not.toHaveBeenCalled();
      expect(tailscaleServicesStore.appForServiceHost('memory.tail123.ts.net')).toBe(MEMORY);
      expect((await service.status()).blocker).toBe(blocker);
    });

    it('is not ready without an OAuth client', async () => {
      await tailscaleServicesStore.forgetOAuthClient();
      const { service, tailscale } = makeService();

      expect(await service.sync([{ appUrn: MEMORY, label: 'memory' }], null)).toEqual({ published: new Map(), ready: false });
      expect(tailscale.getServicesNodeStatus).not.toHaveBeenCalled();
    });

    it('keeps the other apps when one fails', async () => {
      const { service, adminApi } = makeService();
      adminApi.putService.mockImplementation(async (svc: { name: string }) => {
        if (svc.name === 'svc:memory') throw new TailscaleApiError('Defining failed: 403', 403);
        return svc;
      });

      const result = await service.sync(
        [
          { appUrn: MEMORY, label: 'memory' },
          { appUrn: WEBUI, label: 'open-webui' },
        ],
        null,
      );

      expect([...result.published.keys()]).toEqual([WEBUI]);
    });
  });

  describe('setUp', () => {
    it('refuses a secret that is not an OAuth client secret, before saving anything', async () => {
      await tailscaleServicesStore.forgetOAuthClient();
      const { service, adminApi } = makeService();

      await expect(service.setUp({ clientId: 'k2', clientSecret: 'tskey-auth-xyz' })).rejects.toThrow(/tskey-client-/);
      expect(adminApi.getAccessToken).not.toHaveBeenCalled();
      expect(tailscaleServicesStore.readOAuthClient()).toBeNull();
    });

    it('refuses a tag that is not one', async () => {
      const { service } = makeService();

      await expect(service.setUp({ clientId: 'k2', clientSecret: 'tskey-client-x', tag: 'ci-hub' })).rejects.toThrow(/not a Tailscale tag/);
    });

    it('saves nothing when Tailscale refuses the client', async () => {
      await tailscaleServicesStore.forgetOAuthClient();
      const { service, adminApi } = makeService();
      adminApi.getAccessToken.mockRejectedValue(new TailscaleApiError('invalid_scope', 400));

      await expect(service.setUp({ clientId: 'k2', clientSecret: 'tskey-client-x' })).rejects.toThrow(/did not accept/);
      expect(tailscaleServicesStore.readOAuthClient()).toBeNull();
    });

    it('saves the client, starts the node and signs it in as the tag', async () => {
      await tailscaleServicesStore.forgetOAuthClient();
      const { service, tailscale, adminApi, docker } = makeService();
      tailscale.getServicesNodeStatus.mockResolvedValueOnce(taggedNode({ tags: [] })).mockResolvedValue(taggedNode({ tags: ['tag:hub-two'] }));

      const status = await service.setUp({ clientId: 'k2', clientSecret: 'tskey-client-x', tag: 'tag:hub-two' });

      expect(adminApi.getAccessToken).toHaveBeenCalledWith('services devices:core auth_keys', {
        clientId: 'k2',
        clientSecret: 'tskey-client-x',
        tag: 'tag:hub-two',
      });
      expect(docker.ensureContainerRunning).toHaveBeenCalledWith('hub-tailscale', expect.objectContaining({ profile: 'private-vpn' }));
      expect(tailscale.joinServicesNodeTagged).toHaveBeenCalledWith('tskey-client-x', 'tag:hub-two');
      expect(status.ready).toBe(true);
      expect(status.savedInHub).toBe(true);
    });

    it('does not sign in again a node that already carries the tag', async () => {
      const { service, tailscale } = makeService();

      await service.setUp({ clientId: 'k1', clientSecret: 'tskey-client-s1' });

      expect(tailscale.joinServicesNodeTagged).not.toHaveBeenCalled();
    });
  });

  it('turnOff removes every Service and forgets the client', async () => {
    const { service, tailscale, adminApi } = makeService();
    await service.sync([{ appUrn: MEMORY, label: 'memory' }], null);
    const ours = await marker();
    adminApi.getService.mockResolvedValue({ name: 'svc:memory', comment: ours });

    const status = await service.turnOff();

    expect(tailscale.clearServiceOnServicesNode).toHaveBeenCalledWith('svc:memory');
    expect(adminApi.deleteService).toHaveBeenCalledWith('svc:memory');
    expect(status.configured).toBe(false);
    expect(status.services).toEqual([]);
  });
});
