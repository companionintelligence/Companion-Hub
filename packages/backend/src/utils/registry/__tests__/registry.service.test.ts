import { RegistryService, REGISTRY_HTTP_TIMEOUT_MS } from '@/utils/registry/registry.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { MarketplaceWhoIsService } from '@/core/portal/marketplace-whois.service';
import { HttpService } from '@nestjs/axios';
import { Test } from '@nestjs/testing';
import { of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';

const PORTAL = 'https://portal.ci.computer';
const DEVICE_KEY = 'device-api-key';
const PULL_TOKEN = `e30.${Buffer.from(JSON.stringify({ exp: 4_000_000_000 })).toString('base64url')}.sig`;

const ok = (data: unknown) => of({ data, status: 200, statusText: 'OK', headers: {}, config: {} } as any);

describe('RegistryService', () => {
  let registryService: RegistryService;
  let httpService = mock<HttpService>();
  let configurationService = mock<ConfigurationService>();
  let logger = mock<LoggerService>();
  let whois = mock<MarketplaceWhoIsService>();

  const mockConfig = (overrides: { ciCloudUrl?: string; ciHubApiKey?: string | null } = {}) => {
    configurationService.get.mockImplementation((key: string) => {
      if (key === 'ciCloudUrl') return overrides.ciCloudUrl ?? PORTAL;
      if (key === 'ciHubApiKey') return overrides.ciHubApiKey ?? null;
      return undefined;
    });
  };

  const mockPairedHub = () => {
    mockConfig({ ciHubApiKey: DEVICE_KEY });
    httpService.post.mockReturnValue(ok({ token: PULL_TOKEN }));
  };

  beforeEach(async () => {
    whois = mock<MarketplaceWhoIsService>();
    whois.deviceOrganizationId.mockResolvedValue(null);
    logger = mock<LoggerService>();

    const moduleRef = await Test.createTestingModule({
      providers: [RegistryService, { provide: MarketplaceWhoIsService, useValue: whois }, { provide: LoggerService, useValue: logger }],
    })
      .useMocker(mock)
      .compile();

    registryService = moduleRef.get(RegistryService);
    httpService = moduleRef.get(HttpService);
    configurationService = moduleRef.get(ConfigurationService);
    httpService.get.mockReset();
    httpService.post.mockReset();
    configurationService.get.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('getTags / getTagsSince', () => {
    it('should throw if CI_CLOUD_URL is not configured', async () => {
      mockConfig({ ciCloudUrl: '' });

      await expect(registryService.getTagsSince('ci-hub', '1.0.0')).rejects.toThrow('ciCloudUrl is not configured');
    });

    it('should return tags newer than current version sorted descending', async () => {
      mockPairedHub();
      httpService.get.mockReturnValue(ok({ tags: ['1.0.0', '1.1.0', '1.2.0', '0.9.0'] }));

      const result = await registryService.getTagsSince('ci-hub', '1.0.0');

      expect(result).toEqual(['1.2.0', '1.1.0']);
      expect(httpService.post).toHaveBeenCalledWith(
        `${PORTAL}/api/devices/registry-token`,
        {},
        {
          timeout: REGISTRY_HTTP_TIMEOUT_MS,
          headers: { 'x-device-key': DEVICE_KEY, 'Content-Type': 'application/json' },
        },
      );
      expect(httpService.get).toHaveBeenCalledWith(`${PORTAL}/v2/ci-hub/tags/list`, {
        timeout: REGISTRY_HTTP_TIMEOUT_MS,
        headers: { Authorization: `Bearer ${PULL_TOKEN}` },
      });
    });

    it("names this Hub's organization in the body of the token request", async () => {
      whois.deviceOrganizationId.mockResolvedValue('org-of-this-hub');
      mockPairedHub();
      httpService.get.mockReturnValue(ok({ tags: ['1.1.0'] }));

      await registryService.getLatestVersion('ci-hub');

      expect(httpService.post).toHaveBeenCalledWith(`${PORTAL}/api/devices/registry-token`, { organizationId: 'org-of-this-hub' }, expect.anything());
    });

    it('keeps the token when the organization changes, since the Hub stack listing token names none', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-24T00:00:00Z'));
      whois.deviceOrganizationId.mockResolvedValue('org-one');
      mockPairedHub();
      httpService.get.mockReturnValue(ok({ tags: ['1.1.0'] }));

      await registryService.getLatestVersion('ci-hub');
      whois.deviceOrganizationId.mockResolvedValue('org-two');
      vi.advanceTimersByTime(11 * 60 * 1000);
      await registryService.getLatestVersion('ci-hub');

      expect(httpService.post).toHaveBeenCalledTimes(1);
    });

    it('reuses a minted Bearer after the tags cache expires', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-24T00:00:00Z'));
      mockPairedHub();
      httpService.get.mockReturnValue(ok({ tags: ['1.1.0'] }));

      await registryService.getLatestVersion('ci-hub');
      vi.advanceTimersByTime(11 * 60 * 1000);
      await registryService.getLatestVersion('ci-hub');

      expect(httpService.post).toHaveBeenCalledTimes(1);
      expect(httpService.get).toHaveBeenCalledTimes(2);
    });

    it('should return empty array when no newer tags exist', async () => {
      mockPairedHub();
      httpService.get.mockReturnValue(ok({ tags: ['1.0.0', '0.9.0'] }));

      const result = await registryService.getTagsSince('ci-hub', '1.0.0');

      expect(result).toEqual([]);
    });

    it('should filter out invalid semver tags', async () => {
      mockPairedHub();
      httpService.get.mockReturnValue(ok({ tags: ['latest', 'dev', '1.1.0', 'abc', '1.2.0'] }));

      const result = await registryService.getTagsSince('ci-hub', '1.0.0');

      expect(result).toEqual(['1.2.0', '1.1.0']);
    });

    it('should return empty array when currentVersion is not valid semver', async () => {
      const callsBefore = httpService.get.mock.calls.length;
      const result = await registryService.getTagsSince('ci-hub', 'e2e');

      expect(result).toEqual([]);
      expect(httpService.get.mock.calls.length).toBe(callsBefore);
    });

    it('should return empty array on network error', async () => {
      mockPairedHub();
      httpService.get.mockReturnValue(throwError(() => new Error('Network error')));

      const result = await registryService.getTagsSince('ci-hub', '1.0.0');

      expect(result).toEqual([]);
    });

    it('skips the Hub stack listing when unpaired', async () => {
      mockConfig({ ciHubApiKey: null });

      const result = await registryService.getTagsSince('ci-hub', '1.0.0');

      expect(result).toEqual([]);
      expect(httpService.post).not.toHaveBeenCalled();
      expect(httpService.get).not.toHaveBeenCalled();
    });
  });

  describe('getLatestVersion', () => {
    it('should return the latest semver tag', async () => {
      mockPairedHub();
      httpService.get.mockReturnValue(ok({ tags: ['1.0.0', '2.0.0', '1.5.0'] }));

      const result = await registryService.getLatestVersion('ci-hub');

      expect(result).toBe('2.0.0');
    });

    it('should return 0.0.0 when no tags exist', async () => {
      mockPairedHub();
      httpService.get.mockReturnValue(ok({ tags: [] }));

      const result = await registryService.getLatestVersion('ci-hub');

      expect(result).toBe('0.0.0');
    });
  });

  describe('getTagsSinceWithHubFallback', () => {
    it('uses the release feed for hub repo when unpaired', async () => {
      mockConfig({ ciHubApiKey: null });
      httpService.get.mockImplementation((url: string) => {
        if (url === 'https://dl.ci.computer/latest.json') {
          return ok({ version: 'v1.2.0' });
        }
        throw new Error(`unexpected url: ${url}`);
      });

      const result = await registryService.getTagsSinceWithHubFallback('ci-hub', '1.0.0');

      expect(result).toEqual(['1.2.0']);
      expect(httpService.get).not.toHaveBeenCalledWith(`${PORTAL}/v2/ci-hub/tags/list`, expect.anything());
      expect(httpService.get).toHaveBeenCalledWith('https://dl.ci.computer/latest.json', { timeout: REGISTRY_HTTP_TIMEOUT_MS });
    });

    it('returns [] for non-hub repos without calling the release feed', async () => {
      mockConfig({ ciHubApiKey: null });
      httpService.get.mockReturnValue(ok({ tags: [] }));
      httpService.get.mockClear();

      const result = await registryService.getTagsSinceWithHubFallback('custom-repo', '1.0.0');

      expect(result).toEqual([]);
      expect(httpService.get).toHaveBeenCalledTimes(1);
      expect(httpService.get).toHaveBeenCalledWith(`${PORTAL}/v2/custom-repo/tags/list`, { timeout: REGISTRY_HTTP_TIMEOUT_MS });
      expect(httpService.get.mock.calls.some(([url]) => url === 'https://dl.ci.computer/latest.json')).toBe(false);
    });

    it('returns [] when feed version is invalid', async () => {
      mockConfig({ ciHubApiKey: null });
      httpService.get.mockImplementation((url: string) => {
        if (url === 'https://dl.ci.computer/latest.json') {
          return ok({ version: 'not-a-version' });
        }
        throw new Error(`unexpected url: ${url}`);
      });

      const result = await registryService.getTagsSinceWithHubFallback('ci-hub', '1.0.0');

      expect(result).toEqual([]);
    });

    it('returns [] when feed version is missing', async () => {
      mockConfig({ ciHubApiKey: null });
      httpService.get.mockImplementation((url: string) => {
        if (url === 'https://dl.ci.computer/latest.json') {
          return ok({});
        }
        throw new Error(`unexpected url: ${url}`);
      });

      const result = await registryService.getTagsSinceWithHubFallback('ci-hub', '1.0.0');

      expect(result).toEqual([]);
    });
  });
});
