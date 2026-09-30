import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import * as semver from 'semver';
import { type DesktopReleaseManifest, desktopInstallerUrl, desktopReleaseCdn, isTrustedDownloadUrlForHost } from '@ci-hub/common/types';
import { LoggerService } from '@/core/logger/logger.service';
import type { DesktopReleaseDto, DesktopReleaseQueryDto } from './dto/desktop-release.dto';

/**
 * Per read. A first read far from the download servers' CDN can take over 1.5 s, so the registry's
 * tighter bound would often hide the download; this still keeps a slow server from holding up Settings.
 */
export const DESKTOP_RELEASE_READ_TIMEOUT_MS = 5_000;
/** Reuse a release for a few minutes, so reopening Settings does not ask the download server again. */
const RELEASE_CACHE_TTL_MS = 5 * 60 * 1000;
/** Ask again sooner after a failed read, so a short outage does not hide the download for long. */
const RELEASE_RETRY_AFTER_MS = 30 * 1000;

/** This Hub's own release channel: compose sets `CI_HUB_ENVIRONMENT`, `production` unless told otherwise. */
function isProductionHub(): boolean {
  return process.env.CI_HUB_ENVIRONMENT === 'production';
}

type CachedRelease = {
  version: string | null;
  manifest: DesktopReleaseManifest | null;
  expiresAt: number;
};

/**
 * Reads the newest desktop app release for the Settings page. A browser cannot read the download
 * servers itself, because they send no CORS headers; the desktop app reads them natively instead.
 */
@Injectable()
export class DesktopReleaseService {
  private readonly releases = new Map<string, CachedRelease>();
  /** The read in progress for each server, so Settings open in several tabs asks the server once. */
  private readonly pendingReads = new Map<string, Promise<CachedRelease>>();

  constructor(
    private readonly httpService: HttpService,
    private readonly logger: LoggerService,
  ) {}

  async getDesktopRelease(query: DesktopReleaseQueryDto): Promise<DesktopReleaseDto> {
    // A production Hub offers only production releases, whatever the page says it was built as. A page
    // built without its environment asks for the dev server, and would be offered a dev build; the
    // production link fails its own trust check instead, so it shows no download.
    const cdn = desktopReleaseCdn(isProductionHub() ? 'production' : query.environment);
    const { version, manifest } = await this.getRelease(cdn.base);
    const url = manifest && query.platform ? desktopInstallerUrl(manifest, query.platform, query.arch ?? 'x86_64') : null;

    return {
      latestVersion: version,
      downloadUrl: url && isTrustedDownloadUrlForHost(url, cdn.host) ? url : null,
    };
  }

  private async getRelease(base: string): Promise<CachedRelease> {
    const cached = this.releases.get(base);
    if (cached && cached.expiresAt > Date.now()) {
      return cached;
    }

    let pending = this.pendingReads.get(base);
    if (!pending) {
      // fetchRelease settles every failure into a short-lived entry, so this never rejects.
      pending = this.fetchRelease(base)
        .then((release) => {
          this.releases.set(base, release);
          return release;
        })
        .finally(() => this.pendingReads.delete(base));
      this.pendingReads.set(base, pending);
    }
    return pending;
  }

  private async fetchRelease(base: string): Promise<CachedRelease> {
    const failed = (version: string | null): CachedRelease => ({ version, manifest: null, expiresAt: Date.now() + RELEASE_RETRY_AFTER_MS });

    let version: string | null;
    try {
      const latest = await this.getJson<{ version?: unknown }>(`${base}/latest.json`);
      version = typeof latest?.version === 'string' ? semver.valid(latest.version.replace(/^v/, '')) : null;
    } catch (error) {
      this.logger.debug(`Desktop release feed unavailable at ${base}: ${error instanceof Error ? error.message : String(error)}`);
      return failed(null);
    }
    if (!version) {
      return failed(null);
    }

    try {
      const manifest = await this.getJson<DesktopReleaseManifest>(`${base}/v${version}/manifest.json`);
      if (!manifest?.platforms || typeof manifest.platforms !== 'object') {
        return failed(version);
      }
      return { version, manifest, expiresAt: Date.now() + RELEASE_CACHE_TTL_MS };
    } catch (error) {
      this.logger.debug(`Desktop release manifest for v${version} unavailable at ${base}: ${error instanceof Error ? error.message : String(error)}`);
      return failed(version);
    }
  }

  private async getJson<T>(url: string): Promise<T | null> {
    // No redirects: the Hub reads only the two download servers, whatever they answer.
    const { data } = await firstValueFrom(this.httpService.get<T>(url, { timeout: DESKTOP_RELEASE_READ_TIMEOUT_MS, maxRedirects: 0 }));
    return data ?? null;
  }
}
