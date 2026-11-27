import https from 'node:https';
import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import axios, { type AxiosResponse } from 'axios';
import { firstValueFrom, type Observable } from 'rxjs';
import { HUB_STACK_REGISTRY_REPO } from '@/common/constants';
import { describeNetworkError } from '@/common/helpers/network-error';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { MarketplaceWhoIsService } from '@/core/portal/marketplace-whois.service';
import * as semver from 'semver';

/** How long successful tag lists are reused (avoids hammering Companion Portal on every UI version check). */
const TAGS_CACHE_TTL_MS = 10 * 60 * 1000;
/**
 * How long a failed read is kept before the next caller asks again. Short, because until a read works
 * the Hub can't say whether an update exists. Long enough that page loads don't ask a registry that
 * turns this Hub away every time.
 */
const FAILURE_RETRY_AFTER_MS = 60 * 1000;
const HUB_RELEASE_FEED_URL = 'https://dl.ci.computer/latest.json';
/**
 * One attempt at one read: name lookup, connect, TLS and the body. With 1.6 s added to every packet
 * the release feed took 6.7 s to read. 1.5 s, the limit this replaced, failed from 0.4 s per packet,
 * and on some links failed about half the reads with no delay added at all.
 */
export const REGISTRY_HTTP_TIMEOUT_MS = 10_000;
/**
 * A whole release lookup, retries included. Check for updates in Settings waits for it, so it ends:
 * the tag list and the feed are read at the same time and every attempt stops at this deadline. It
 * leaves a second attempt about 10 s when the first used all of its time.
 */
export const RELEASE_LOOKUP_BUDGET_MS = 20_000;
/**
 * How long each of a host's addresses gets to accept the connection on these reads. The Hub's own
 * default is 2 s (`CONNECT_ATTEMPT_TIMEOUT_MS`). With 1.6 s added to every packet, one resent SYN
 * (Linux resends after 1 s) outlasts that, and the feed read failed with ETIMEDOUT on every address
 * in about 4 s. Only these reads, which have 10 s each, wait longer; nothing else in the Hub changes.
 */
export const RELEASE_CONNECT_ATTEMPT_TIMEOUT_MS = 5_000;
/** Time an attempt needs left before it is started. Less than this can't finish on a link that needs the longer limit. */
const MIN_ATTEMPT_MS = 2_000;
const RETRY_DELAY_MS = 500;

/**
 * Releases newer than the running one. `error` says why they could not be looked up, and the empty
 * list then means "unknown", not "up to date".
 */
export type ReleaseLookup = { tags: string[]; error: string | null };

type TagsRead = { tags: string[]; error: string | null };
type FeedRead = { version: string | null; error: string | null };

/** An attempt that wasn't started, because the lookup's deadline was too close. Not retried. */
class OutOfTimeError extends Error {
  constructor() {
    super('the release lookup ran out of time');
  }
}

type LatestHubReleaseFeed = {
  version?: string;
};

type CachedRegistryToken = {
  token: string;
  expiresAt: number;
};

@Injectable()
export class RegistryService {
  private readonly tagsCache = new Map<string, TagsRead & { expiresAt: number }>();
  private latestHubVersionCache: (FeedRead & { expiresAt: number }) | null = null;
  /** The feed read under way, so a page load and Check for updates that overlap share one read. */
  private feedInFlight: Promise<FeedRead> | null = null;
  private registryTokenCache: CachedRegistryToken | null = null;
  private readonly httpsAgent = new https.Agent({ keepAlive: true, autoSelectFamilyAttemptTimeout: RELEASE_CONNECT_ATTEMPT_TIMEOUT_MS });

  constructor(
    private readonly httpService: HttpService,
    private readonly configuration: ConfigurationService,
    private readonly logger: LoggerService,
    private readonly whois: MarketplaceWhoIsService,
  ) {}

  public async getLatestVersion(repository: string) {
    const { tags } = await this.getTags(repository, Date.now() + RELEASE_LOOKUP_BUDGET_MS);
    return tags[0] || '0.0.0';
  }

  public async getTagsSince(repository: string, currentVersion: string) {
    if (!semver.valid(currentVersion)) {
      return [];
    }
    const { tags } = await this.getTags(repository, Date.now() + RELEASE_LOOKUP_BUDGET_MS);
    return tags.filter((tag) => semver.gt(tag, currentVersion));
  }

  /**
   * Resolve newer tags and fall back to the public release feed for the Hub stack.
   * This keeps update checks working when OCI tags are digest-only (latest/dev/sha256).
   *
   * A newer release in the tag list still wins, and the feed answers only when the list has none. The
   * feed is read at the same time as the list rather than after it: on a slow link the Portal's two
   * reads (token, then list) would otherwise use up the time the feed needs.
   */
  public async getTagsSinceWithHubFallback(repository: string, currentVersion: string): Promise<ReleaseLookup> {
    if (!semver.valid(currentVersion)) {
      return { tags: [], error: null };
    }

    const deadline = Date.now() + RELEASE_LOOKUP_BUDGET_MS;
    const feed = repository === HUB_STACK_REGISTRY_REPO ? this.getLatestHubVersionFromFeed(deadline) : null;
    const listed = await this.getTags(repository, deadline);
    const tagsSince = listed.tags.filter((tag) => semver.gt(tag, currentVersion));
    if (tagsSince.length > 0) {
      return { tags: tagsSince, error: null };
    }

    if (feed === null) {
      return { tags: [], error: listed.error };
    }

    const latestFromFeed = await feed;
    if (latestFromFeed.version === null) {
      // Unknown even when the tag list named older releases. The feed is asked because the list can lag
      // it: a Hub on 0.3.14 got nothing newer from the list while the feed had 0.3.16.
      const feedError = latestFromFeed.error ?? 'The Hub release feed named no version';
      return { tags: [], error: listed.error ? `${listed.error}; ${feedError}` : feedError };
    }
    return { tags: semver.gt(latestFromFeed.version, currentVersion) ? [latestFromFeed.version] : [], error: null };
  }

  private getLatestHubVersionFromFeed(deadline: number): Promise<FeedRead> {
    if (this.latestHubVersionCache && this.latestHubVersionCache.expiresAt > Date.now()) {
      const { version, error } = this.latestHubVersionCache;
      return Promise.resolve({ version, error });
    }
    if (this.feedInFlight) {
      return this.feedInFlight;
    }

    this.feedInFlight = this.readHubReleaseFeed(deadline).finally(() => {
      this.feedInFlight = null;
    });
    return this.feedInFlight;
  }

  private async readHubReleaseFeed(deadline: number): Promise<FeedRead> {
    try {
      const { data } = await this.withOneRetry((attempt) => this.httpService.get(HUB_RELEASE_FEED_URL, attempt), deadline);
      const payload = data as LatestHubReleaseFeed;
      const cleaned = semver.clean(payload?.version ?? '') ?? null;

      if (!cleaned) {
        const read: FeedRead = { version: null, error: 'The Hub release feed named no version' };
        this.latestHubVersionCache = { ...read, expiresAt: Date.now() + FAILURE_RETRY_AFTER_MS };
        this.logger.warn(`${read.error} at ${HUB_RELEASE_FEED_URL}`);
        return read;
      }

      this.latestHubVersionCache = { version: cleaned, error: null, expiresAt: Date.now() + TAGS_CACHE_TTL_MS };
      return { version: cleaned, error: null };
    } catch (error) {
      const read: FeedRead = { version: null, error: `Could not read the Hub release feed: ${describeNetworkError(error)}` };
      this.latestHubVersionCache = { ...read, expiresAt: Date.now() + FAILURE_RETRY_AFTER_MS };
      this.logger.warn(`${read.error} (${HUB_RELEASE_FEED_URL})`);
      return read;
    }
  }

  /**
   * One read, tried a second time when it got no answer (no connection, no reply in time) or a server
   * error. Each attempt gets {@link REGISTRY_HTTP_TIMEOUT_MS}, cut short at the lookup's deadline, and
   * one that would have less than {@link MIN_ATTEMPT_MS} isn't started. A 4xx answer isn't retried.
   * Every attempt connects through the agent with {@link RELEASE_CONNECT_ATTEMPT_TIMEOUT_MS}.
   *
   * axios's `timeout` in Node is reset by every packet, so a body that trickles in outlives it. The
   * signal ends the attempt at its limit however the bytes arrive.
   */
  private async withOneRetry<T>(
    send: (attempt: { timeout: number; signal: AbortSignal; httpsAgent: https.Agent }) => Observable<AxiosResponse<T>>,
    deadline: number,
  ): Promise<AxiosResponse<T>> {
    const tryOnce = async () => {
      const timeout = Math.min(REGISTRY_HTTP_TIMEOUT_MS, deadline - Date.now());
      if (timeout < MIN_ATTEMPT_MS) {
        throw new OutOfTimeError();
      }
      const limit = new AbortController();
      const timer = setTimeout(() => limit.abort(), timeout);
      try {
        return await firstValueFrom(send({ timeout, signal: limit.signal, httpsAgent: this.httpsAgent }));
      } catch (error) {
        if (limit.signal.aborted && axios.isCancel(error)) {
          throw new Error(`no complete answer within ${timeout} ms`);
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    };

    try {
      return await tryOnce();
    } catch (error) {
      if (!worthRetrying(error) || deadline - Date.now() - RETRY_DELAY_MS < MIN_ATTEMPT_MS) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    return tryOnce();
  }

  private jwtExpiryMs(token: string): number | null {
    const payload = token.split('.')[1];
    if (!payload) {
      return null;
    }

    try {
      const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown };
      return typeof json.exp === 'number' ? json.exp * 1000 : null;
    } catch {
      return null;
    }
  }

  /**
   * Mint a pull-only Portal registry JWT from the paired device key.
   *
   * Unpaired Hubs have no `ciHubApiKey`, so this returns null and callers fall
   * back to an empty tag list (and `dl.ci.computer` for the Hub stack). That
   * looks like a slow or empty catalog, not a pairing error — pair first
   * (CI-Portal#634).
   *
   * The body names this Hub's organization, as the other paid app requests do. Portal only reads the
   * name alongside an `appId`. This asks for none: the answer is the listing token for the Hub stack,
   * which names the device and no organization. So the cache isn't keyed on organization: the same
   * token holds in any of them. A caller that asks for an app's token one day needs its own key.
   */
  private async getDeviceRegistryToken(base: string, deadline: number): Promise<{ token: string | null; error: string | null }> {
    const deviceKey = this.configuration.get('ciHubApiKey');
    if (!deviceKey) {
      return { token: null, error: null };
    }

    const now = Date.now();
    if (this.registryTokenCache && this.registryTokenCache.expiresAt > now) {
      return { token: this.registryTokenCache.token, error: null };
    }

    const organizationId = await this.whois.deviceOrganizationId();

    try {
      const { data } = await this.withOneRetry(
        (attempt) =>
          this.httpService.post(`${base}/api/devices/registry-token`, organizationId ? { organizationId } : {}, {
            ...attempt,
            headers: { 'x-device-key': deviceKey, 'Content-Type': 'application/json' },
          }),
        deadline,
      );
      const token = typeof (data as { token?: unknown })?.token === 'string' ? (data as { token: string }).token : null;
      if (!token) {
        return { token: null, error: 'Companion Portal sent no registry token' };
      }

      const expiry = this.jwtExpiryMs(token);
      this.registryTokenCache = {
        token,
        expiresAt: expiry ? expiry - 60_000 : now + TAGS_CACHE_TTL_MS,
      };
      return { token, error: null };
    } catch (error) {
      this.registryTokenCache = null;
      const reason = describeNetworkError(error);
      this.logger.debug(`Failed to mint Portal registry token: ${reason}`);
      return { token: null, error: `Could not get a registry token from Companion Portal: ${reason}` };
    }
  }

  private async getTags(repository: string, deadline: number): Promise<TagsRead> {
    const registryUrl = this.configuration.get('ciCloudUrl');
    if (!registryUrl) {
      throw new Error('ciCloudUrl is not configured');
    }

    const base = registryUrl.trim().replace(/\/$/, '');
    const cacheKey = `${base}::${repository}`;
    const cached = this.tagsCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return { tags: cached.tags, error: cached.error };
    }

    const headers: Record<string, string> = {};
    if (repository === HUB_STACK_REGISTRY_REPO) {
      const { token, error } = await this.getDeviceRegistryToken(base, deadline);
      if (!token) {
        this.tagsCache.set(cacheKey, { tags: [], error, expiresAt: Date.now() + FAILURE_RETRY_AFTER_MS });
        return { tags: [], error };
      }
      headers.Authorization = `Bearer ${token}`;
    }

    try {
      const { data } = await this.withOneRetry(
        (attempt) =>
          this.httpService.get(`${base}/v2/${repository}/tags/list`, {
            ...attempt,
            ...(Object.keys(headers).length > 0 ? { headers } : {}),
          }),
        deadline,
      );

      const tags = (data.tags || []) as string[];

      const validTags = tags.filter((tag) => semver.valid(tag));
      const sorted = validTags.sort((a, b) => semver.rcompare(a, b));
      this.tagsCache.set(cacheKey, { tags: sorted, error: null, expiresAt: Date.now() + TAGS_CACHE_TTL_MS });
      return { tags: sorted, error: null };
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 401) {
        this.registryTokenCache = null;
      }
      const reason = describeNetworkError(error);
      const read: TagsRead = { tags: [], error: `Could not read the tag list of ${repository}: ${reason}` };
      this.tagsCache.set(cacheKey, { ...read, expiresAt: Date.now() + FAILURE_RETRY_AFTER_MS });

      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 401 || status === 403 || status === 404) {
          this.logger.debug(
            `OCI tags list not available for ${repository} at CI Cloud (HTTP ${status}). Hub updates may not show latest image until registry access works.`,
          );
        } else {
          this.logger.warn(`Failed to get OCI tags for ${repository}: ${reason}${status ? ` (HTTP ${status})` : ''}`);
        }
      } else {
        this.logger.warn(`Failed to get OCI tags for ${repository}: ${reason}`);
      }
      return read;
    }
  }
}

/** No answer at all (no connection, nothing back in time) or a server that failed: worth one more try. */
function worthRetrying(error: unknown): boolean {
  if (!axios.isAxiosError(error)) {
    return !(error instanceof OutOfTimeError);
  }
  const status = error.response?.status;
  return status === undefined || status >= 500 || status === 429;
}
