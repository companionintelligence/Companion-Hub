import { Test, TestingModule } from '@nestjs/testing';
import { CloudflareClientService } from '../cloudflare-client.service';
import { APP_DIR, DATA_DIR } from '@/common/constants';
import { ConfigurationService } from '@/core/config/configuration.service';
import { ModuleRef } from '@nestjs/core';
import { DockerService } from '@/modules/docker/docker.service';
import { DockerReadFacade } from '@/modules/docker/docker-read.facade';
import axios from 'axios';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import path from 'node:path';
import { PortalClientService } from '@/core/portal/portal-client.service';
import { mock, MockProxy } from 'vitest-mock-extended';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('axios');
vi.mock('node:fs/promises');
vi.mock('@/common/helpers/bind-mount-helpers', () => ({
  writeHealableTextFile: vi.fn(async (filePath: string, content: string) => {
    const fs = await import('node:fs/promises');
    await fs.writeFile(filePath, content, { mode: 0o644 });
  }),
  ensureWritableFile: vi.fn(async () => undefined),
  readTextFileIfExists: vi.fn(() => null),
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
  };
});

describe('CloudflareClientService', () => {
  let service: CloudflareClientService;
  let configService: MockProxy<ConfigurationService>;
  let moduleRef: MockProxy<ModuleRef>;
  let dockerService: MockProxy<DockerService>;
  let portalClient: MockProxy<PortalClientService>;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalLocal = process.env.LOCAL;

  // Axios mock
  const mockedAxios = vi.mocked(axios);
  const mockAxiosInstance = {
    post: vi.fn(),
    get: vi.fn(),
  } as any;

  beforeEach(async () => {
    configService = mock<ConfigurationService>();
    moduleRef = mock<ModuleRef>();
    dockerService = mock<DockerService>();
    portalClient = mock<PortalClientService>();
    portalClient.getDeviceAuthHeaders.mockReturnValue({ Authorization: 'Bearer api-key', 'x-device-key': 'api-key' });
    portalClient.postTunnelState.mockResolvedValue({ success: true, failed: [], synced: 1 });

    configService.get.mockImplementation((key) => {
      if (key === 'ciCloudUrl') return 'http://api.cloud';
      if (key === 'ciHubApiKey') return 'api-key';
      return null;
    });

    moduleRef.get.mockReturnValue(dockerService);
    (mockedAxios.create as any).mockReturnValue(mockAxiosInstance);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CloudflareClientService,
        { provide: ConfigurationService, useValue: configService },
        { provide: ModuleRef, useValue: moduleRef },
        { provide: PortalClientService, useValue: portalClient },
      ],
    }).compile();

    service = module.get<CloudflareClientService>(CloudflareClientService);
  });

  afterEach(() => {
    vi.clearAllMocks();

    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }

    if (originalLocal === undefined) {
      delete process.env.LOCAL;
    } else {
      process.env.LOCAL = originalLocal;
    }
  });

  describe('initializeTunnel', () => {
    it('should use the mounted runtime compose file when available', async () => {
      vi.mocked(fsSync.existsSync).mockReturnValue(true);

      const result = await service.initializeTunnel('org-id', { tunnelId: 'tun-id', token: 'tok' });

      expect(fs.writeFile).toHaveBeenCalledWith(expect.stringContaining(path.join('tunnel', 'token')), 'tok', { mode: 0o644 });
      expect(fsSync.existsSync).toHaveBeenCalledWith(path.join(DATA_DIR, 'docker-compose.yml'));
      expect(dockerService.ensureContainerRunning).toHaveBeenCalledWith('cloudflared', {
        composeFile: path.join(DATA_DIR, 'docker-compose.yml'),
        profile: 'cloudflare',
      });
      expect(result).toEqual({ tunnelId: 'tun-id', token: 'tok' });
    });

    it('should fall back to the source prod compose file when the mounted runtime compose file is unavailable', async () => {
      vi.mocked(fsSync.existsSync).mockReturnValue(false);

      await service.initializeTunnel('org-id', { tunnelId: 'tun-id', token: 'tok' });

      expect(dockerService.ensureContainerRunning).toHaveBeenCalledWith('cloudflared', {
        composeFile: path.join(APP_DIR, 'docker-compose.prod.yml'),
        profile: 'cloudflare',
      });
    });

    it('should use the local compose file when in dev mode and no mounted compose file is present', async () => {
      process.env.NODE_ENV = 'development';
      vi.mocked(fsSync.existsSync).mockReturnValue(false);

      await service.initializeTunnel('org-id', { tunnelId: 'tun-id', token: 'tok' });

      expect(dockerService.ensureContainerRunning).toHaveBeenCalledWith('cloudflared', {
        composeFile: path.join(APP_DIR, 'docker-compose.local.yml'),
        profile: 'cloudflare',
      });
    });

    it('should fail if no credentials', async () => {
      const result = await service.initializeTunnel('org-id', { tunnelId: '', token: '' });
      expect(result).toBeNull();
    });

    it('should skip cloudflared container start in local/E2E mode (ci.localhost)', async () => {
      configService.get.mockImplementation((key) => {
        if (key === 'ciCloudUrl') return 'http://api.cloud';
        if (key === 'ciHubApiKey') return 'api-key';
        if (key === 'domain') return 'ci.localhost';
        return null;
      });

      const result = await service.initializeTunnel('org-id', { tunnelId: 'tun-id', token: 'tok' });

      // Token file should still be written
      expect(fs.writeFile).toHaveBeenCalledWith(expect.stringContaining(path.join('tunnel', 'token')), 'tok', { mode: 0o644 });
      // Docker container should NOT be started
      expect(dockerService.ensureContainerRunning).not.toHaveBeenCalled();
      // Should still return credentials
      expect(result).toEqual({ tunnelId: 'tun-id', token: 'tok' });
    });
  });

  describe('syncState', () => {
    it('should post apps to cloud', async () => {
      portalClient.postTunnelState.mockResolvedValue({ success: true });

      const result = await service.syncState('org-id', [], 'tun-id');

      expect(result).toEqual({ ok: true, failed: [], failures: [], synced: 0 });
      expect(portalClient.postTunnelState).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-id', tunnelId: 'tun-id' }));
    });

    it('should surface apps CI-Cloud could not create a DNS record for', async () => {
      portalClient.postTunnelState.mockResolvedValue({ success: true, failed: ['anything-llm'], synced: 1 });

      const result = await service.syncState('org-id', [], 'tun-id');

      // No `failures` from an older Companion Portal: `failed` still tells us which apps
      // broke, and callers fall back to generic messaging.
      expect(result).toEqual({ ok: true, failed: ['anything-llm'], failures: [], synced: 1 });
    });

    it('should pass through the per-app failure class when CI-Cloud reports one', async () => {
      const failures = [
        {
          app: 'anything-llm',
          hostname: 'anything-llm-laptop-cid.companionintelligence.com',
          reason: 'conflict' as const,
          message: 'already in use by another tunnel',
        },
      ];
      portalClient.postTunnelState.mockResolvedValue({ success: true, failed: ['anything-llm'], failures, synced: 1 });

      const result = await service.syncState('org-id', [], 'tun-id');

      expect(result).toEqual({ ok: true, failed: ['anything-llm'], failures, synced: 1 });
    });

    it('should drop malformed failure entries instead of failing the whole sync', async () => {
      // A junk entry used to throw on `failure.app` while building the log line. That
      // throw is caught by syncState's own catch, which reports ok: false — so one bad
      // element turned a PARTIAL sync into a hard failure and made the UI toast every
      // exposed app rather than the one that actually broke.
      portalClient.postTunnelState.mockResolvedValue({
        success: true,
        failed: ['anything-llm', null, 42],
        failures: [null, 'not-an-object', { reason: 'conflict' }, { app: 'anything-llm', reason: 'conflict', message: 'taken' }],
        synced: 1,
      } as any);

      const result = await service.syncState('org-id', [], 'tun-id');

      // Still a partial success, and only the well-formed entries survive.
      expect(result.ok).toBe(true);
      expect(result.failed).toEqual(['anything-llm']);
      expect(result.failures).toEqual([{ app: 'anything-llm', reason: 'conflict', message: 'taken' }]);
    });

    it('should name every failed app in the log, even those with no structured failure', async () => {
      // `failures` need not cover every failed app. Building the log line from it named
      // fewer apps than the count in the same sentence, and the ones it dropped were the
      // ones with no other detail to find them by.
      // The logger is private; reach it through a structural cast rather than a computed
      // key, which `lint:fix` would rewrite into an illegal dot access on a private field.
      const loggerRef = (service as unknown as { logger: { warn: (message: string) => void } }).logger;
      const warn = vi.spyOn(loggerRef, 'warn');

      portalClient.postTunnelState.mockResolvedValue({
        success: true,
        failed: ['anything-llm', 'docmost'],
        failures: [{ app: 'anything-llm', reason: 'conflict', message: 'taken' }],
        synced: 0,
      } as any);

      await service.syncState('org-id', [], 'tun-id');

      const message = warn.mock.calls.map(([line]) => String(line)).join('\n');

      expect(message).toContain('2 app(s)');
      expect(message).toContain('anything-llm (conflict: taken)');
      // Present despite having no entry in `failures` — and not rendered as `undefined`.
      expect(message).toContain('docmost');
      expect(message).not.toContain('undefined');
    });

    it('should surface the custom domains CI-Cloud reports as wired', async () => {
      portalClient.postTunnelState.mockResolvedValue({
        success: true,
        synced: 1,
        customDomains: [{ id: 'cd_1', domain: 'Comfy.Acme.com', targetHostname: 'ComfyUI-Hub-Acme.example.com' }],
      } as any);

      const result = await service.syncState('org-id', [], 'tun-id');

      expect(result.customDomains).toEqual([{ id: 'cd_1', domain: 'comfy.acme.com', targetHostname: 'comfyui-hub-acme.example.com' }]);
    });

    it('should leave customDomains undefined when CI-Cloud predates the field', async () => {
      // NOT an empty array: an older Portal saying nothing must not be read as
      // "this device has none", which downstream treats as an instruction to
      // unbind every app currently serving on a custom hostname.
      portalClient.postTunnelState.mockResolvedValue({ success: true, synced: 1 });

      const result = await service.syncState('org-id', [], 'tun-id');

      expect(result.ok).toBe(true);
      expect(result.customDomains).toBeUndefined();
    });

    it('should report an empty array as an empty array', async () => {
      portalClient.postTunnelState.mockResolvedValue({ success: true, synced: 1, customDomains: [] } as any);

      const result = await service.syncState('org-id', [], 'tun-id');

      expect(result.customDomains).toEqual([]);
    });

    it('should drop malformed custom-domain entries without failing the sync', async () => {
      const loggerRef = (service as unknown as { logger: { warn: (message: string) => void } }).logger;
      const warn = vi.spyOn(loggerRef, 'warn');

      portalClient.postTunnelState.mockResolvedValue({
        success: true,
        synced: 1,
        customDomains: [
          null,
          { id: 'cd_1', domain: 'no-target.acme.com' },
          { id: 'cd_2', domain: 'good.acme.com', targetHostname: 'app-hub-acme.example.com' },
        ],
      } as any);

      const result = await service.syncState('org-id', [], 'tun-id');

      expect(result.ok).toBe(true);
      expect(result.customDomains).toEqual([{ id: 'cd_2', domain: 'good.acme.com', targetHostname: 'app-hub-acme.example.com' }]);
      expect(warn.mock.calls.map(([line]) => String(line)).join('\n')).toContain('Dropped 2 malformed custom-domain');
    });

    it('should not report custom domains from a failed sync', async () => {
      // A sync that did not complete delivered nothing, and an empty array here
      // would unbind every app on the next reconcile.
      portalClient.postTunnelState.mockRejectedValue(new Error('Network Error'));

      const result = await service.syncState('org-id', [], 'tun-id');

      expect(result.ok).toBe(false);
      expect(result.customDomains).toBeUndefined();
    });

    it('should fail if no tunnelId', async () => {
      const result = await service.syncState('org-id', []);
      expect(result).toMatchObject({
        ok: false,
        failed: [],
        failures: [],
        synced: 0,
        errorMessage: 'Tunnel not initialized',
      });
    });

    it('should handle axios error with cause details', async () => {
      portalClient.postTunnelState.mockRejectedValue(new Error('Network Error'));
      const result = await service.syncState('org-id', [], 'tun-id');
      expect(result).toMatchObject({
        ok: false,
        failed: [],
        failures: [],
        synced: 0,
        errorMessage: 'Network Error',
      });
    });
  });

  describe('fetchAvailableDomains', () => {
    it('should normalize numeric domain ids to strings', async () => {
      mockAxiosInstance.get.mockResolvedValue({
        data: {
          domains: [
            { id: 1, domain: 'example.com', isDefault: true, scope: 'org' },
            { id: '2', domain: 'ci.computer', isDefault: false },
          ],
        },
      });

      const result = await service.fetchAvailableDomains();

      expect(result).toEqual({
        domains: [
          { id: '1', domain: 'example.com', isDefault: true, scope: 'org' },
          { id: '2', domain: 'ci.computer', isDefault: false },
        ],
      });
    });

    it('should retry cloudflare/domains when domains endpoint returns 404', async () => {
      mockAxiosInstance.get.mockRejectedValueOnce({ response: { status: 404 } }).mockResolvedValueOnce({
        data: {
          domains: [{ id: '1', domain: 'example.com', isDefault: true }],
        },
      });

      const result = await service.fetchAvailableDomains();

      expect(mockAxiosInstance.get).toHaveBeenNthCalledWith(1, 'domains', expect.anything());
      expect(mockAxiosInstance.get).toHaveBeenNthCalledWith(2, 'cloudflare/domains', expect.anything());
      expect(result).toEqual({
        domains: [{ id: '1', domain: 'example.com', isDefault: true }],
      });
    });
  });

  describe('checkDnsAvailability', () => {
    it('should return delegated availability result when CI-Cloud responds with expected shape', async () => {
      mockAxiosInstance.get.mockResolvedValue({
        data: {
          available: true,
          message: 'ok',
        },
      });

      const result = await service.checkDnsAvailability('test-subdomain', 'example.com');

      expect(mockAxiosInstance.get).toHaveBeenCalledWith(
        'cloudflare/check-dns-availability',
        expect.objectContaining({
          params: {
            subdomain: 'test-subdomain',
            domain: 'example.com',
          },
        }),
      );
      expect(result).toEqual({ available: true, message: 'ok' });
    });

    it('should fail open when CI-Cloud availability check times out before a response', async () => {
      mockAxiosInstance.get.mockRejectedValue({
        code: 'ETIMEDOUT',
        isAxiosError: true,
      });
      mockedAxios.isAxiosError.mockReturnValue(true);

      const result = await service.checkDnsAvailability('test-subdomain', 'example.com');

      expect(result).toEqual({
        available: true,
        message: 'Unable to verify DNS availability right now. Please try again.',
      });
    });

    it('should preserve explicit CI-Cloud unavailability responses', async () => {
      mockAxiosInstance.get.mockRejectedValue({
        response: {
          data: {
            message: 'CI-Cloud unavailable',
          },
        },
      });

      const result = await service.checkDnsAvailability('test-subdomain', 'example.com');

      expect(result).toEqual({ available: false, message: 'CI-Cloud unavailable' });
    });
  });

  describe('fetchOrganizationCustomDomains', () => {
    const listing = (overrides: Record<string, unknown> = {}) => ({
      id: 'cd_1',
      domain: 'comfy.acme.com',
      state: 'parked',
      bindable: true,
      targetHostname: null,
      boundAppSlug: null,
      boundElsewhere: false,
      ...overrides,
    });

    it('returns the organization listing', async () => {
      portalClient.fetchDeviceCustomDomains.mockResolvedValue({ status: 200, data: { domains: [listing()] } });

      await expect(service.fetchOrganizationCustomDomains()).resolves.toEqual([
        expect.objectContaining({ id: 'cd_1', domain: 'comfy.acme.com', bindable: true }),
      ]);
    });

    it('reports a CI-Cloud without the route as unanswered, not as none', async () => {
      /*
       * This is not `[]`. A Hub talking to an older Portal is a supported deployment,
       * and the install dialog owes it a different sentence than an organization
       * that genuinely owns no domains — offering "you have none, add one" for a
       * question that was never answered is the failure this feature fixes.
       */
      portalClient.fetchDeviceCustomDomains.mockResolvedValue({ status: 404, data: {} });

      await expect(service.fetchOrganizationCustomDomains()).resolves.toBeUndefined();
    });

    it('reports an error status as unanswered', async () => {
      portalClient.fetchDeviceCustomDomains.mockResolvedValue({ status: 503, data: {} });

      await expect(service.fetchOrganizationCustomDomains()).resolves.toBeUndefined();
    });

    it('reports an unreadable payload as unanswered', async () => {
      portalClient.fetchDeviceCustomDomains.mockResolvedValue({ status: 200, data: { domains: 'nope' } });

      await expect(service.fetchOrganizationCustomDomains()).resolves.toBeUndefined();
    });

    it('survives a transport failure', async () => {
      portalClient.fetchDeviceCustomDomains.mockRejectedValue(new Error('socket hang up'));

      await expect(service.fetchOrganizationCustomDomains()).resolves.toBeUndefined();
    });

    it('drops a malformed entry without losing the rest', async () => {
      portalClient.fetchDeviceCustomDomains.mockResolvedValue({
        status: 200,
        data: { domains: [listing({ domain: 'not a hostname' }), listing({ id: 'cd_2', domain: 'ok.acme.com' })] },
      });

      const domains = await service.fetchOrganizationCustomDomains();

      expect(domains?.map((entry) => entry.domain)).toEqual(['ok.acme.com']);
    });
  });

  describe('bindCustomDomain', () => {
    it('reports the hostname CI-Cloud composed', async () => {
      portalClient.postDeviceCustomDomainBind.mockResolvedValue({
        status: 200,
        data: { id: 'cd_1', domain: 'comfy.acme.com', targetHostname: 'comfyui-core2-acme.example.com' },
      });

      await expect(service.bindCustomDomain('cd_1', 'comfyui')).resolves.toEqual({
        ok: true,
        targetHostname: 'comfyui-core2-acme.example.com',
      });
    });

    it('carries the refusal code through so the caller can tell retry from give up', async () => {
      // `APPLICATION_NOT_FOUND` clears itself once the app registers;
      // `DOMAIN_NOT_FOUND` never will. Collapsing both into "failed" means either
      // retrying forever or discarding a live choice.
      portalClient.postDeviceCustomDomainBind.mockResolvedValue({
        status: 404,
        data: { code: 'APPLICATION_NOT_FOUND', error: 'That application is not installed on this device yet' },
      });

      await expect(service.bindCustomDomain('cd_1', 'comfyui')).resolves.toEqual({
        ok: false,
        status: 404,
        code: 'APPLICATION_NOT_FOUND',
        message: 'That application is not installed on this device yet',
      });
    });

    it('reports a bodiless refusal by its status', async () => {
      portalClient.postDeviceCustomDomainBind.mockResolvedValue({ status: 502, data: {} });

      await expect(service.bindCustomDomain('cd_1', 'comfyui')).resolves.toMatchObject({
        ok: false,
        status: 502,
        message: 'CI-Cloud answered 502',
      });
    });

    it('survives a transport failure', async () => {
      portalClient.postDeviceCustomDomainBind.mockRejectedValue(new Error('socket hang up'));

      await expect(service.bindCustomDomain('cd_1', 'comfyui')).resolves.toMatchObject({ ok: false, message: 'socket hang up' });
    });
  });

  describe('loadTunnelTokenFromDisk', () => {
    it('logs only when the in-memory token changes', async () => {
      const logSpy = vi.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
      vi.mocked(fs.readFile).mockResolvedValue('tunnel-token-value\n');

      await expect(service.loadTunnelTokenFromDisk('tunnel-1')).resolves.toBe(true);
      await expect(service.loadTunnelTokenFromDisk('tunnel-1')).resolves.toBe(true);

      expect(service.getTunnelToken()).toBe('tunnel-token-value');
      expect(logSpy.mock.calls.filter(([message]) => String(message).includes('Loaded tunnel token from disk'))).toHaveLength(1);
    });
  });

  describe('stopTunnel', () => {
    beforeEach(async () => {
      vi.mocked(fs.readFile).mockResolvedValue('tunnel-token-value\n');
      await service.loadTunnelTokenFromDisk('tunnel-1');
      vi.spyOn(service as any, 'runsInsideHubContainer').mockReturnValue(true);
    });

    describe('from a source checkout sharing Docker with another Hub', () => {
      let dockerReadFacade: MockProxy<DockerReadFacade>;
      const composeDir = () => path.dirname((service as any).getComposeFile() as string);

      beforeEach(() => {
        dockerReadFacade = mock<DockerReadFacade>();
        moduleRef.get.mockImplementation(((token: unknown) => (token === DockerReadFacade ? dockerReadFacade : dockerService)) as any);
        vi.spyOn(service as any, 'runsInsideHubContainer').mockReturnValue(false);
        dockerService.removeContainer.mockResolvedValue(true);
      });

      it("leaves another Hub's cloudflared running and reports the stop as done", async () => {
        // The reported case: a local backend paired to a Portal whose domain replaced ci.localhost,
        // on a machine whose installed Hub runs its connector from its own data folder.
        configService.get.mockImplementation((key) => (key === 'domain' ? 'companionintelligence.com' : null));
        dockerReadFacade.readContainerLabel.mockResolvedValue({ found: true, value: '/home/someone/.local/share/companion-hub' });

        await expect(service.stopTunnel()).resolves.toBe(true);

        expect(dockerReadFacade.readContainerLabel).toHaveBeenCalledWith('cloudflared', 'com.docker.compose.project.working_dir');
        expect(dockerService.removeContainer).not.toHaveBeenCalled();
        expect(service.getTunnelToken()).toBeNull();
      });

      it('removes the cloudflared container Compose started from this checkout', async () => {
        dockerReadFacade.readContainerLabel.mockResolvedValue({ found: true, value: composeDir() });

        await expect(service.stopTunnel()).resolves.toBe(true);

        expect(dockerService.removeContainer).toHaveBeenCalledWith('cloudflared');
      });

      it('leaves a cloudflared container that Compose did not start alone', async () => {
        dockerReadFacade.readContainerLabel.mockResolvedValue({ found: true, value: null });

        await expect(service.stopTunnel()).resolves.toBe(true);

        expect(dockerService.removeContainer).not.toHaveBeenCalled();
      });

      it('has nothing to remove when there is no cloudflared container', async () => {
        dockerReadFacade.readContainerLabel.mockResolvedValue({ found: false });

        await expect(service.stopTunnel()).resolves.toBe(true);

        expect(dockerService.removeContainer).toHaveBeenCalledWith('cloudflared');
      });

      it('reports a stop it could not check, so the caller tries again', async () => {
        dockerReadFacade.readContainerLabel.mockResolvedValue(null);

        await expect(service.stopTunnel()).resolves.toBe(false);

        expect(dockerService.removeContainer).not.toHaveBeenCalled();
      });
    });

    it('forgets the tunnel credentials and removes the cloudflared container', async () => {
      dockerService.removeContainer.mockResolvedValue(true);

      await expect(service.stopTunnel()).resolves.toBe(true);

      expect(service.getTunnelToken()).toBeNull();
      expect(service.getTunnelId()).toBeNull();
      expect(dockerService.removeContainer).toHaveBeenCalledWith('cloudflared');
    });

    it('reports a container it could not remove, after forgetting the credentials', async () => {
      dockerService.removeContainer.mockResolvedValue(false);

      await expect(service.stopTunnel()).resolves.toBe(false);

      expect(service.getTunnelToken()).toBeNull();
    });

    it('leaves Docker alone in local/E2E mode (ci.localhost)', async () => {
      configService.get.mockImplementation((key) => (key === 'domain' ? 'ci.localhost' : null));

      await expect(service.stopTunnel()).resolves.toBe(true);

      expect(service.getTunnelToken()).toBeNull();
      expect(dockerService.removeContainer).not.toHaveBeenCalled();
    });

    it('does not start cloudflared again once stopped', async () => {
      dockerService.removeContainer.mockResolvedValue(true);
      await service.stopTunnel();

      await expect(service.ensureCloudflaredRunning()).resolves.toBe(false);

      expect(dockerService.ensureContainerRunning).not.toHaveBeenCalled();
      expect(dockerService.restartContainer).not.toHaveBeenCalled();
    });
  });
});
