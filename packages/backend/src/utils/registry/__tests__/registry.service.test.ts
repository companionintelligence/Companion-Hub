import https from 'node:https';
import {
  RegistryService,
  REGISTRY_HTTP_TIMEOUT_MS,
  RELEASE_CONNECT_ATTEMPT_TIMEOUT_MS,
  RELEASE_LOOKUP_BUDGET_MS,
} from '@/utils/registry/registry.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { MarketplaceWhoIsService } from '@/core/portal/marketplace-whois.service';
import { HttpService } from '@nestjs/axios';
import { Test } from '@nestjs/testing';
import { AxiosError, type AxiosResponse, CanceledError } from 'axios';
import { Observable, of, Subject, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';

const PORTAL = 'https://portal.ci.computer';
const FEED = 'https://dl.ci.computer/latest.json';
const DEVICE_KEY = 'device-api-key';
const PULL_TOKEN = `e30.${Buffer.from(JSON.stringify({ exp: 4_000_000_000 })).toString('base64url')}.sig`;

const ok = (data: unknown) => of({ data, status: 200, statusText: 'OK', headers: {}, config: {} } as any);
const answer = (data: unknown) => ({ data, status: 200, statusText: 'OK', headers: {}, config: {} }) as AxiosResponse;
/** What axios throws when an attempt got nothing back in time. */
const timedOut = (ms = REGISTRY_HTTP_TIMEOUT_MS) => throwError(() => new AxiosError(`timeout of ${ms}ms exceeded`, 'ECONNABORTED'));
const httpStatus = (status: number) =>
  throwError(() => new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_REQUEST', undefined, undefined, { status } as AxiosResponse));
/** The timeout each request to `url` was sent with, in order. */
const timeoutsFor = (calls: unknown[][], url: string) =>
  calls.filter(([called]) => called === url).map((call) => (call.at(-1) as { timeout: number }).timeout);

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
        expect.objectContaining({
          timeout: REGISTRY_HTTP_TIMEOUT_MS,
          signal: expect.any(AbortSignal),
          httpsAgent: expect.any(https.Agent),
          headers: { 'x-device-key': DEVICE_KEY, 'Content-Type': 'application/json' },
        }),
      );
      expect(httpService.get).toHaveBeenCalledWith(`${PORTAL}/v2/ci-hub/tags/list`, {
        timeout: REGISTRY_HTTP_TIMEOUT_MS,
        signal: expect.any(AbortSignal),
        httpsAgent: expect.any(https.Agent),
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

      expect(result).toEqual({ tags: ['1.2.0'], error: null });
      expect(httpService.get).not.toHaveBeenCalledWith(`${PORTAL}/v2/ci-hub/tags/list`, expect.anything());
      expect(httpService.get).toHaveBeenCalledWith('https://dl.ci.computer/latest.json', {
        timeout: REGISTRY_HTTP_TIMEOUT_MS,
        signal: expect.any(AbortSignal),
        httpsAgent: expect.any(https.Agent),
      });
    });

    it('returns [] for non-hub repos without calling the release feed', async () => {
      mockConfig({ ciHubApiKey: null });
      httpService.get.mockReturnValue(ok({ tags: [] }));
      httpService.get.mockClear();

      const result = await registryService.getTagsSinceWithHubFallback('custom-repo', '1.0.0');

      expect(result).toEqual({ tags: [], error: null });
      expect(httpService.get).toHaveBeenCalledTimes(1);
      expect(httpService.get).toHaveBeenCalledWith(`${PORTAL}/v2/custom-repo/tags/list`, {
        timeout: REGISTRY_HTTP_TIMEOUT_MS,
        signal: expect.any(AbortSignal),
        httpsAgent: expect.any(https.Agent),
      });
      expect(httpService.get.mock.calls.some(([url]) => url === 'https://dl.ci.computer/latest.json')).toBe(false);
    });

    it('reports a feed with an invalid version as unknown', async () => {
      mockConfig({ ciHubApiKey: null });
      httpService.get.mockImplementation((url: string) => {
        if (url === 'https://dl.ci.computer/latest.json') {
          return ok({ version: 'not-a-version' });
        }
        throw new Error(`unexpected url: ${url}`);
      });

      const result = await registryService.getTagsSinceWithHubFallback('ci-hub', '1.0.0');

      expect(result).toEqual({ tags: [], error: 'The Hub release feed named no version' });
    });

    it('reports a feed with no version as unknown', async () => {
      mockConfig({ ciHubApiKey: null });
      httpService.get.mockImplementation((url: string) => {
        if (url === 'https://dl.ci.computer/latest.json') {
          return ok({});
        }
        throw new Error(`unexpected url: ${url}`);
      });

      const result = await registryService.getTagsSinceWithHubFallback('ci-hub', '1.0.0');

      expect(result).toEqual({ tags: [], error: 'The Hub release feed named no version' });
    });
  });

  // A Hub on 0.3.14 said it was on the latest version while 0.3.16 was out: its release feed read had
  // 1.5 s for the name lookup, connect, TLS and body, and a failed read was cached as "no release" for
  // five minutes (#2622).
  describe('release lookup on a slow or flaky link', () => {
    const feedOnly = (...answers: Array<ReturnType<typeof ok>>) => {
      mockConfig({ ciHubApiKey: null });
      let call = 0;
      httpService.get.mockImplementation((url: string) => {
        if (url !== FEED) throw new Error(`unexpected url: ${url}`);
        const next = answers[Math.min(call, answers.length - 1)];
        call += 1;
        return next as never;
      });
    };

    it('gives each read long enough for a link that adds 1.6 s to every packet', async () => {
      feedOnly(ok({ version: 'v0.3.16' }));

      await expect(registryService.getTagsSinceWithHubFallback('ci-hub', '0.3.14')).resolves.toEqual({ tags: ['0.3.16'], error: null });

      // The whole read took 6.7 s with curl at that delay.
      expect(timeoutsFor(httpService.get.mock.calls, FEED)).toEqual([REGISTRY_HTTP_TIMEOUT_MS]);
      expect(REGISTRY_HTTP_TIMEOUT_MS).toBeGreaterThanOrEqual(7_000);
    });

    // With 1.6 s added to every packet, one resent SYN outlasted the Hub's 2 s per address and the feed
    // read failed with ETIMEDOUT on every address.
    it('gives each address longer than the Hub-wide 2 s to accept the connection', async () => {
      mockConfig({ ciHubApiKey: DEVICE_KEY });
      httpService.post.mockReturnValue(ok({ token: PULL_TOKEN }));
      httpService.get.mockImplementation((url: string) => (url === FEED ? ok({ version: 'v0.3.16' }) : ok({ tags: [] })));

      await registryService.getTagsSinceWithHubFallback('ci-hub', '0.3.14');

      const agents = [...httpService.get.mock.calls, ...httpService.post.mock.calls].map(
        (call) => (call.at(-1) as { httpsAgent?: https.Agent }).httpsAgent,
      );
      expect(agents).toHaveLength(3);
      for (const agent of agents) {
        expect(agent).toBeInstanceOf(https.Agent);
        expect((agent?.options ?? {}) as { autoSelectFamilyAttemptTimeout?: number }).toMatchObject({
          autoSelectFamilyAttemptTimeout: RELEASE_CONNECT_ATTEMPT_TIMEOUT_MS,
        });
      }
      expect(RELEASE_CONNECT_ATTEMPT_TIMEOUT_MS).toBeGreaterThanOrEqual(2_600);
    });

    it('reads the feed once more after a read that got no answer', async () => {
      vi.useFakeTimers();
      feedOnly(timedOut(), ok({ version: 'v0.3.16' }));

      const pending = registryService.getTagsSinceWithHubFallback('ci-hub', '0.3.14');
      await vi.advanceTimersByTimeAsync(500);

      await expect(pending).resolves.toEqual({ tags: ['0.3.16'], error: null });
      expect(timeoutsFor(httpService.get.mock.calls, FEED)).toHaveLength(2);
    });

    it('does not read again after an answer that refused it', async () => {
      feedOnly(httpStatus(404), ok({ version: 'v0.3.16' }));

      const result = await registryService.getTagsSinceWithHubFallback('ci-hub', '0.3.14');

      expect(result).toEqual({ tags: [], error: 'Could not read the Hub release feed: Request failed with status code 404 (ERR_BAD_REQUEST)' });
      expect(timeoutsFor(httpService.get.mock.calls, FEED)).toHaveLength(1);
    });

    it('reports a feed it could not read as unknown, not as no newer release', async () => {
      vi.useFakeTimers();
      feedOnly(timedOut());

      const pending = registryService.getTagsSinceWithHubFallback('ci-hub', '0.3.14');
      await vi.advanceTimersByTimeAsync(500);

      await expect(pending).resolves.toEqual({
        tags: [],
        error: `Could not read the Hub release feed: timeout of ${REGISTRY_HTTP_TIMEOUT_MS}ms exceeded (ECONNABORTED)`,
      });
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Could not read the Hub release feed'));
    });

    it('reads the feed again a minute after a failed read', async () => {
      vi.useFakeTimers();
      feedOnly(timedOut(), timedOut(), ok({ version: 'v0.3.16' }));

      const first = registryService.getTagsSinceWithHubFallback('ci-hub', '0.3.14');
      await vi.advanceTimersByTimeAsync(500);
      expect((await first).error).not.toBeNull();

      // Still the failed read: no new request within the minute.
      await vi.advanceTimersByTimeAsync(30_000);
      expect((await registryService.getTagsSinceWithHubFallback('ci-hub', '0.3.14')).error).not.toBeNull();
      expect(timeoutsFor(httpService.get.mock.calls, FEED)).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(31_000);
      await expect(registryService.getTagsSinceWithHubFallback('ci-hub', '0.3.14')).resolves.toEqual({ tags: ['0.3.16'], error: null });
    });

    it('gives the second attempt only the time the lookup has left', async () => {
      vi.useFakeTimers();
      mockConfig({ ciHubApiKey: null });
      httpService.get
        .mockImplementationOnce(() => {
          // An attempt that ran 14 s before it failed.
          vi.setSystemTime(Date.now() + 14_000);
          return throwError(() => new AxiosError('socket hang up', 'ECONNRESET'));
        })
        .mockImplementationOnce(() => ok({ version: 'v0.3.16' }));

      const pending = registryService.getTagsSinceWithHubFallback('ci-hub', '0.3.14');
      await vi.advanceTimersByTimeAsync(500);

      await expect(pending).resolves.toEqual({ tags: ['0.3.16'], error: null });
      expect(timeoutsFor(httpService.get.mock.calls, FEED)).toEqual([REGISTRY_HTTP_TIMEOUT_MS, RELEASE_LOOKUP_BUDGET_MS - 14_000 - 500]);
    });

    it('starts no second attempt it could not finish before the lookup ends', async () => {
      vi.useFakeTimers();
      mockConfig({ ciHubApiKey: null });
      httpService.get.mockImplementation(() => {
        vi.setSystemTime(Date.now() + RELEASE_LOOKUP_BUDGET_MS - 2_000);
        return throwError(() => new AxiosError('socket hang up', 'ECONNRESET'));
      });

      const result = await registryService.getTagsSinceWithHubFallback('ci-hub', '0.3.14');

      expect(result.error).toBe('Could not read the Hub release feed: socket hang up (ECONNRESET)');
      expect(httpService.get).toHaveBeenCalledTimes(1);
    });

    it('reads the feed while the Portal is still answering for the tag list', async () => {
      mockConfig({ ciHubApiKey: DEVICE_KEY });
      const token = new Subject<AxiosResponse>();
      httpService.post.mockReturnValue(token as never);
      httpService.get.mockImplementation((url: string) => (url === FEED ? ok({ version: 'v0.3.16' }) : ok({ tags: ['sha256-abc', 'latest'] })));

      const pending = registryService.getTagsSinceWithHubFallback('ci-hub', '0.3.14');
      await vi.waitFor(() => expect(httpService.get).toHaveBeenCalledWith(FEED, expect.anything()));
      expect(httpService.get).not.toHaveBeenCalledWith(`${PORTAL}/v2/ci-hub/tags/list`, expect.anything());

      token.next(answer({ token: PULL_TOKEN }));
      token.complete();

      await expect(pending).resolves.toEqual({ tags: ['0.3.16'], error: null });
      expect(httpService.get).toHaveBeenCalledWith(`${PORTAL}/v2/ci-hub/tags/list`, expect.anything());
    });

    it('still takes a newer release from the tag list over the feed', async () => {
      mockPairedHub();
      httpService.get.mockImplementation((url: string) => (url === FEED ? ok({ version: 'v0.3.16' }) : ok({ tags: ['0.3.17', '0.3.16', '0.3.14'] })));

      await expect(registryService.getTagsSinceWithHubFallback('ci-hub', '0.3.14')).resolves.toEqual({ tags: ['0.3.17', '0.3.16'], error: null });
    });

    it('finds the release in the feed when the Portal could not be reached', async () => {
      vi.useFakeTimers();
      mockConfig({ ciHubApiKey: DEVICE_KEY });
      httpService.post.mockReturnValue(throwError(() => new AxiosError('connect ECONNREFUSED', 'ECONNREFUSED')));
      httpService.get.mockImplementation((url: string) => (url === FEED ? ok({ version: 'v0.3.16' }) : timedOut()));

      const pending = registryService.getTagsSinceWithHubFallback('ci-hub', '0.3.14');
      await vi.advanceTimersByTimeAsync(500);

      await expect(pending).resolves.toEqual({ tags: ['0.3.16'], error: null });
    });

    it('does not take a tag list with nothing newer as the answer when the feed could not be read', async () => {
      mockPairedHub();
      httpService.get.mockImplementation((url: string) => (url === FEED ? httpStatus(404) : ok({ tags: ['0.3.14', '0.3.12'] })));

      await expect(registryService.getTagsSinceWithHubFallback('ci-hub', '0.3.14')).resolves.toEqual({
        tags: [],
        error: 'Could not read the Hub release feed: Request failed with status code 404 (ERR_BAD_REQUEST)',
      });
    });

    it('names both failed reads when neither the tag list nor the feed could be read', async () => {
      mockPairedHub();
      httpService.get.mockImplementation((url: string) => httpStatus(url === FEED ? 404 : 403));

      const { error } = await registryService.getTagsSinceWithHubFallback('ci-hub', '0.3.14');

      expect(error).toContain('Could not read the tag list of ci-hub');
      expect(error).toContain('Could not read the Hub release feed');
    });

    it('ends an attempt whose answer trickles in past its limit', async () => {
      vi.useFakeTimers();
      mockConfig({ ciHubApiKey: null });
      // Sent like axios: the request only ends when its signal aborts.
      httpService.get.mockImplementation((url: string, config?: { signal?: AbortSignal }) => {
        if (url !== FEED) return ok({ tags: [] });
        return new Observable<AxiosResponse>((subscriber) => {
          config?.signal?.addEventListener('abort', () => subscriber.error(new CanceledError()));
        }) as never;
      });

      const pending = registryService.getTagsSinceWithHubFallback('ci-hub', '0.3.14');
      await vi.advanceTimersByTimeAsync(RELEASE_LOOKUP_BUDGET_MS);

      // The first attempt ends at its 10 s limit, the second at the lookup's deadline.
      const { error } = await pending;
      expect(timeoutsFor(httpService.get.mock.calls, FEED)).toEqual([
        REGISTRY_HTTP_TIMEOUT_MS,
        RELEASE_LOOKUP_BUDGET_MS - REGISTRY_HTTP_TIMEOUT_MS - 500,
      ]);
      expect(error).toBe(
        `Could not read the Hub release feed: no complete answer within ${RELEASE_LOOKUP_BUDGET_MS - REGISTRY_HTTP_TIMEOUT_MS - 500} ms`,
      );
    });

    it('shares one feed read between lookups that overlap', async () => {
      mockConfig({ ciHubApiKey: null });
      const feed = new Subject<AxiosResponse>();
      httpService.get.mockReturnValue(feed as never);

      const pageLoad = registryService.getTagsSinceWithHubFallback('ci-hub', '0.3.14');
      const checkForUpdates = registryService.getTagsSinceWithHubFallback('ci-hub', '0.3.14');
      await vi.waitFor(() => expect(httpService.get).toHaveBeenCalled());
      feed.next(answer({ version: 'v0.3.16' }));
      feed.complete();

      await expect(Promise.all([pageLoad, checkForUpdates])).resolves.toEqual([
        { tags: ['0.3.16'], error: null },
        { tags: ['0.3.16'], error: null },
      ]);
      expect(httpService.get).toHaveBeenCalledTimes(1);
    });
  });
});
