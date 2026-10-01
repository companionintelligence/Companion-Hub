import { HttpService } from '@nestjs/axios';
import { Test } from '@nestjs/testing';
import { AxiosError } from 'axios';
import { of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { LoggerService } from '@/core/logger/logger.service';
import { DESKTOP_RELEASE_READ_TIMEOUT_MS, DesktopReleaseService } from '../desktop-release.service';

const PROD = 'https://dl.ci.computer';
const DEV = 'https://dl-dev.ci.computer';
const READ_OPTIONS = { timeout: DESKTOP_RELEASE_READ_TIMEOUT_MS, maxRedirects: 0 };

const ok = (data: unknown) => of({ data, status: 200, statusText: 'OK', headers: {}, config: {} } as any);

/** The shape `desktop-release.yml` publishes, trimmed to three platforms. */
function manifestFor(base: string, version: string) {
  const at = (path: string) => ({ url: `${base}/v${version}/${path}`, size: 1, sha256: 'abc' });
  return {
    version,
    date: '2026-09-29T07:38:49Z',
    platforms: {
      'darwin-aarch64': { dmg: at(`macos/arm/Companion%20Hub_${version}_aarch64.dmg`) },
      'windows-x86_64': {
        msi: at(`windows/x64/Companion%20Hub_${version}_x64_en-US.msi`),
        exe: at(`windows/x64/Companion%20Hub_${version}_x64-setup.exe`),
      },
      'linux-aarch64': {
        deb: at(`linux/deb/arm/Companion%20Hub_${version}_arm64.deb`),
        rpm: at(`linux/rpm/arm/Companion%20Hub-${version}-1.aarch64.rpm`),
      },
    },
  };
}

describe('DesktopReleaseService', () => {
  let service: DesktopReleaseService;
  let httpService: MockProxy<HttpService>;

  /** Serves `latest.json` and its manifest for each download server; any other read fails. */
  const serve = (feeds: Record<string, { version: string; manifest?: unknown }>) => {
    httpService.get.mockImplementation((url: string) => {
      for (const [base, feed] of Object.entries(feeds)) {
        if (url === `${base}/latest.json`) return ok({ version: `v${feed.version}`, date: '2026-09-29T07:38:49Z' });
        if (url === `${base}/v${feed.version}/manifest.json`) return ok(feed.manifest ?? manifestFor(base, feed.version));
      }
      return throwError(() => new Error(`unexpected read: ${url}`));
    });
  };
  const readUrls = () => httpService.get.mock.calls.map(([url]) => url);

  beforeEach(async () => {
    httpService = mock<HttpService>();
    const moduleRef = await Test.createTestingModule({
      providers: [
        DesktopReleaseService,
        { provide: HttpService, useValue: httpService },
        { provide: LoggerService, useValue: mock<LoggerService>() },
      ],
    }).compile();

    service = moduleRef.get(DesktopReleaseService);
    // A Hub that isn't production: the page's environment picks the server.
    vi.stubEnv('CI_HUB_ENVIRONMENT', 'development');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  // A release image whose page was built without its environment asks for the dev server.
  it('reads only the production server on a production Hub, whatever the page asks for', async () => {
    vi.stubEnv('CI_HUB_ENVIRONMENT', 'production');
    serve({ [PROD]: { version: '0.2.77' }, [DEV]: { version: '0.2.61' } });

    for (const environment of ['development', '', undefined]) {
      await expect(service.getDesktopRelease({ environment, platform: 'macos', arch: 'aarch64' })).resolves.toEqual({
        latestVersion: '0.2.77',
        downloadUrl: `${PROD}/v0.2.77/macos/arm/Companion%20Hub_0.2.77_aarch64.dmg`,
      });
    }
    expect(readUrls().every((url) => url.startsWith(`${PROD}/`))).toBe(true);
  });

  it('reads dl.ci.computer for a production page and returns its installer', async () => {
    serve({ [PROD]: { version: '0.2.77' } });

    await expect(service.getDesktopRelease({ environment: 'production', platform: 'macos', arch: 'aarch64' })).resolves.toEqual({
      latestVersion: '0.2.77',
      downloadUrl: `${PROD}/v0.2.77/macos/arm/Companion%20Hub_0.2.77_aarch64.dmg`,
    });
    expect(httpService.get.mock.calls).toEqual([
      [`${PROD}/latest.json`, READ_OPTIONS],
      [`${PROD}/v0.2.77/manifest.json`, READ_OPTIONS],
    ]);
  });

  it.each(['dev', undefined, '', 'https://evil.example.com', 'dl.ci.computer'])(
    'reads only dl-dev.ci.computer for environment %j',
    async (environment) => {
      serve({ [DEV]: { version: '0.2.61' } });

      await expect(service.getDesktopRelease({ environment, platform: 'linux', arch: 'aarch64' })).resolves.toEqual({
        latestVersion: '0.2.61',
        downloadUrl: `${DEV}/v0.2.61/linux/deb/arm/Companion%20Hub_0.2.61_arm64.deb`,
      });
      expect(readUrls()).toEqual([`${DEV}/latest.json`, `${DEV}/v0.2.61/manifest.json`]);
    },
  );

  it('picks the installer for the platform and architecture', async () => {
    serve({ [PROD]: { version: '0.2.77' } });

    const release = (platform?: 'linux' | 'macos' | 'windows', arch?: 'x86_64' | 'aarch64') =>
      service.getDesktopRelease({ environment: 'production', platform, arch });

    await expect(release('windows', 'x86_64')).resolves.toEqual({
      latestVersion: '0.2.77',
      downloadUrl: `${PROD}/v0.2.77/windows/x64/Companion%20Hub_0.2.77_x64-setup.exe`,
    });
    await expect(release('windows')).resolves.toEqual({
      latestVersion: '0.2.77',
      downloadUrl: `${PROD}/v0.2.77/windows/x64/Companion%20Hub_0.2.77_x64-setup.exe`,
    });
    // This test release has no Intel Mac build, and no platform means no installer to pick.
    await expect(release('macos', 'x86_64')).resolves.toEqual({ latestVersion: '0.2.77', downloadUrl: null });
    await expect(release()).resolves.toEqual({ latestVersion: '0.2.77', downloadUrl: null });
  });

  it('drops an installer that is not a plain download from the server it read', async () => {
    const manifest = manifestFor(PROD, '0.2.77');
    manifest.platforms['darwin-aarch64'].dmg.url = 'https://evil.example.com/Companion%20Hub.dmg';
    manifest.platforms['windows-x86_64'].exe.url = `${PROD}/v0.2.77/%2e%2e/evil.exe`;
    serve({ [PROD]: { version: '0.2.77', manifest } });

    await expect(service.getDesktopRelease({ environment: 'production', platform: 'macos', arch: 'aarch64' })).resolves.toEqual({
      latestVersion: '0.2.77',
      downloadUrl: null,
    });
    await expect(service.getDesktopRelease({ environment: 'production', platform: 'windows', arch: 'x86_64' })).resolves.toEqual({
      latestVersion: '0.2.77',
      downloadUrl: null,
    });
  });

  it.each([
    ['times out', () => throwError(() => new AxiosError(`timeout of ${DESKTOP_RELEASE_READ_TIMEOUT_MS}ms exceeded`, 'ECONNABORTED'))],
    ['answers 404', () => throwError(() => new AxiosError('Request failed with status code 404', 'ERR_BAD_REQUEST'))],
    ['lists no valid version', () => ok({ version: 'latest' })],
    ['answers with something other than JSON', () => ok('<html>Not here</html>')],
  ])('returns nulls when latest.json %s', async (_case, answer) => {
    httpService.get.mockImplementation(answer);

    await expect(service.getDesktopRelease({ environment: 'production', platform: 'linux', arch: 'x86_64' })).resolves.toEqual({
      latestVersion: null,
      downloadUrl: null,
    });
    expect(readUrls()).toEqual([`${PROD}/latest.json`]);
  });

  it.each([
    ['cannot be read', () => throwError(() => new AxiosError('Request failed with status code 404', 'ERR_BAD_REQUEST'))],
    ['lists no platforms', () => ok({ version: '0.2.77' })],
  ])('returns the version without an installer when the manifest %s', async (_case, manifestAnswer) => {
    httpService.get.mockImplementation((url: string) => (url.endsWith('/latest.json') ? ok({ version: 'v0.2.77' }) : manifestAnswer()));

    await expect(service.getDesktopRelease({ environment: 'production', platform: 'macos', arch: 'aarch64' })).resolves.toEqual({
      latestVersion: '0.2.77',
      downloadUrl: null,
    });
  });

  it('reuses a release for five minutes, for every platform', async () => {
    vi.useFakeTimers();
    serve({ [PROD]: { version: '0.2.77' } });

    await service.getDesktopRelease({ environment: 'production', platform: 'macos', arch: 'aarch64' });
    vi.advanceTimersByTime(5 * 60 * 1000 - 1);
    await expect(service.getDesktopRelease({ environment: 'production', platform: 'windows', arch: 'x86_64' })).resolves.toEqual({
      latestVersion: '0.2.77',
      downloadUrl: `${PROD}/v0.2.77/windows/x64/Companion%20Hub_0.2.77_x64-setup.exe`,
    });
    expect(httpService.get).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(1);
    await service.getDesktopRelease({ environment: 'production', platform: 'macos', arch: 'aarch64' });
    expect(httpService.get).toHaveBeenCalledTimes(4);
  });

  it('asks again after 30 seconds when a read failed', async () => {
    vi.useFakeTimers();
    httpService.get.mockReturnValue(throwError(() => new AxiosError('getaddrinfo ENOTFOUND dl.ci.computer', 'ENOTFOUND')));

    await service.getDesktopRelease({ environment: 'production', platform: 'macos', arch: 'aarch64' });
    vi.advanceTimersByTime(30 * 1000 - 1);
    await service.getDesktopRelease({ environment: 'production', platform: 'macos', arch: 'aarch64' });
    expect(httpService.get).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    serve({ [PROD]: { version: '0.2.77' } });
    await expect(service.getDesktopRelease({ environment: 'production', platform: 'macos', arch: 'aarch64' })).resolves.toEqual({
      latestVersion: '0.2.77',
      downloadUrl: `${PROD}/v0.2.77/macos/arm/Companion%20Hub_0.2.77_aarch64.dmg`,
    });
  });

  it('reads the server once for requests that arrive while a read is in progress', async () => {
    serve({ [PROD]: { version: '0.2.77' } });

    const [mac, windows] = await Promise.all([
      service.getDesktopRelease({ environment: 'production', platform: 'macos', arch: 'aarch64' }),
      service.getDesktopRelease({ environment: 'production', platform: 'windows', arch: 'x86_64' }),
    ]);

    expect(mac.downloadUrl).toBe(`${PROD}/v0.2.77/macos/arm/Companion%20Hub_0.2.77_aarch64.dmg`);
    expect(windows.downloadUrl).toBe(`${PROD}/v0.2.77/windows/x64/Companion%20Hub_0.2.77_x64-setup.exe`);
    expect(readUrls()).toEqual([`${PROD}/latest.json`, `${PROD}/v0.2.77/manifest.json`]);
  });

  it('keeps the two download servers apart', async () => {
    serve({ [PROD]: { version: '0.2.77' }, [DEV]: { version: '0.2.61' } });

    await expect(service.getDesktopRelease({ environment: 'production' })).resolves.toEqual({ latestVersion: '0.2.77', downloadUrl: null });
    await expect(service.getDesktopRelease({ environment: 'dev' })).resolves.toEqual({ latestVersion: '0.2.61', downloadUrl: null });
    await expect(service.getDesktopRelease({ environment: 'production' })).resolves.toEqual({ latestVersion: '0.2.77', downloadUrl: null });
    expect(readUrls()).toEqual([`${PROD}/latest.json`, `${PROD}/v0.2.77/manifest.json`, `${DEV}/latest.json`, `${DEV}/v0.2.61/manifest.json`]);
  });
});
