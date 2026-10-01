import semver from 'semver';
import { type DesktopReleaseManifest, desktopInstallerUrl, desktopReleaseCdn, isTrustedDownloadUrlForHost } from '@ci-hub/common/types';
import { openExternal } from '@/lib/helpers/open-external';
import { isMobileUserAgent } from '@/lib/mobile-connection';

function updateCdnConfig() {
  return desktopReleaseCdn(import.meta.env.CI_HUB_ENVIRONMENT);
}

const POLL_INTERVAL_MS = 4 * 60 * 60 * 1000;
const DISMISSED_KEY = 'ci-hub-update-dismissed-version';
const TOAST_SHOWN_KEY = 'ci-hub-update-toast-shown';

export function isTrustedDownloadUrl(url: string): boolean {
  return isTrustedDownloadUrlForHost(url, updateCdnConfig().host);
}

interface LatestJson {
  version: string;
}

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  downloadUrl: string;
  updateAvailable: boolean;
  platform: DesktopPlatform | null;
  manualDownload: boolean;
}

interface NativeDesktopUpdateInfo {
  currentVersion: string;
  latestVersion: string;
  downloadUrl: string;
  updateAvailable: boolean;
}

export type DesktopPlatform = 'linux' | 'macos' | 'windows';

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function getCurrentVersion(): Promise<string | null> {
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const version = await invoke<string>('get_desktop_release_version_command');
      return version.trim().replace(/^v/, '');
    } catch {
      return null;
    }
  }
  return null;
}

export async function getInstalledDesktopVersion(): Promise<string | null> {
  return getCurrentVersion();
}

/** Whether an update installed another desktop app version while this one was open. */
export interface DesktopRestartState {
  runningVersion: string;
  /** The version on disk, when the new program said which. */
  installedVersion: string | null;
  restartRequired: boolean;
}

/** `null` outside the desktop app, and from desktop apps too old to tell. */
export async function getDesktopRestartState(): Promise<DesktopRestartState | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const state = await invoke<DesktopRestartState>('get_desktop_restart_state_command');
    return {
      runningVersion: state.runningVersion,
      installedVersion: state.installedVersion ?? null,
      restartRequired: Boolean(state.restartRequired),
    };
  } catch {
    return null;
  }
}

/**
 * Restarts the desktop app onto the version an update installed. The app exits while this is in
 * flight, so a resolved call only means the app took the request; `false` means it refused or
 * could not restart.
 */
export async function restartDesktopApp(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('restart_desktop_app_command');
    return true;
  } catch {
    return false;
  }
}

export function detectBrowserPlatform(): DesktopPlatform {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent.toLowerCase();
  if (ua.includes('win')) return 'windows';
  if (ua.includes('mac')) return 'macos';
  return 'linux';
}

export function detectBrowserArch(): string {
  if (typeof navigator === 'undefined') return 'x86_64';
  const ua = navigator.userAgent.toLowerCase();
  const uad = (navigator as unknown as { userAgentData?: { architecture?: string } }).userAgentData;
  if (uad?.architecture === 'arm' || /arm64|aarch64/.test(ua)) return 'aarch64';
  // Safari on Apple Silicon still reports MacIntel; prefer arm for macOS downloads.
  if (detectBrowserPlatform() === 'macos') return 'aarch64';
  return 'x86_64';
}

export async function getDesktopPlatform(): Promise<DesktopPlatform | null> {
  if (isTauri()) {
    try {
      const { platform } = await import('@tauri-apps/plugin-os');
      const value = await platform();
      if (value === 'linux' || value === 'macos' || value === 'windows') {
        return value;
      }
    } catch {
      // Fall through to user-agent detection.
    }
  }

  if (typeof navigator === 'undefined') return null;
  return detectBrowserPlatform();
}

/**
 * The CPU a Chromium browser reports through client hints, or null. Its user agent says "Intel Mac" on
 * Apple silicon too, so this is how a page tells the two Macs apart. Safari and Firefox don't report it.
 */
async function browserArchFromClientHints(): Promise<string | null> {
  if (typeof navigator === 'undefined') return null;
  const uad = (navigator as unknown as { userAgentData?: { getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }> } })
    .userAgentData;
  try {
    const hints = await uad?.getHighEntropyValues?.(['architecture']);
    if (hints?.architecture === 'arm') return 'aarch64';
    if (hints?.architecture === 'x86') return 'x86_64';
  } catch {
    // The browser refused the hint: the user agent decides.
  }
  return null;
}

export async function getDesktopArch(): Promise<string> {
  if (isTauri()) {
    try {
      const { arch } = await import('@tauri-apps/plugin-os');
      const value = await arch();
      if (value === 'aarch64' || value === 'arm') return 'aarch64';
      if (value) return 'x86_64';
    } catch {
      // Fall through to user-agent detection.
    }
  }

  return (await browserArchFromClientHints()) ?? detectBrowserArch();
}

/** Every platform downloads an installer; none replace the running binary in-place. */
export function requiresManualDesktopUpdate(_platform?: DesktopPlatform | null): boolean {
  return true;
}

export type ManualUpdateArtifactKind = 'deb' | 'rpm' | 'appimage' | 'dmg' | 'exe' | 'msi';

/** Installer format of a manual-download update, for tailored on-screen instructions. */
export function manualUpdateArtifactKind(downloadUrl: string): ManualUpdateArtifactKind | null {
  const path = (downloadUrl.split(/[?#]/)[0] ?? '').toLowerCase();
  if (path.endsWith('.deb')) return 'deb';
  if (path.endsWith('.rpm')) return 'rpm';
  if (path.endsWith('.appimage')) return 'appimage';
  if (path.endsWith('.dmg')) return 'dmg';
  if (path.endsWith('.msi')) return 'msi';
  if (path.endsWith('.exe')) return 'exe';
  return null;
}

/**
 * The name a browser saves a manual-download installer under: the URL's last path segment, decoded,
 * so `Companion%20Hub_0.2.78_amd64.deb` is `Companion Hub_0.2.78_amd64.deb`. `null` unless the name is
 * plain enough to paste between double quotes in a shell command: letters, digits, spaces, dots,
 * underscores, plus signs and hyphens only, so never a slash, a quote, `$` or a backtick.
 */
export function manualUpdateFileName(downloadUrl: string): string | null {
  const path = downloadUrl.split(/[?#]/)[0] ?? '';
  let name: string;
  try {
    name = decodeURIComponent(path.slice(path.lastIndexOf('/') + 1));
  } catch {
    return null;
  }
  // A name of dots alone is the folder itself or its parent, never a file.
  return /^[A-Za-z0-9 ._+-]+$/.test(name) && !/^\.+$/.test(name) ? name : null;
}

async function resolveInstallerFromCdn(
  platform: DesktopPlatform | null,
  osArch: string,
): Promise<{ latestVersion: string; downloadUrl: string } | null> {
  const { base } = updateCdnConfig();
  const latestRes = await fetch(`${base}/latest.json`, { cache: 'no-store' });
  if (!latestRes.ok) return null;

  const latest = (await latestRes.json()) as LatestJson;
  const latestVersion = latest.version.replace(/^v/, '');
  if (!semver.valid(latestVersion)) return null;

  const manifestRes = await fetch(`${base}/v${latestVersion}/manifest.json`, { cache: 'no-store' });
  if (!manifestRes.ok) return null;

  const manifest = (await manifestRes.json()) as DesktopReleaseManifest;
  let downloadUrl = platform ? (desktopInstallerUrl(manifest, platform, osArch) ?? '') : '';
  if (downloadUrl && !isTrustedDownloadUrl(downloadUrl)) {
    downloadUrl = '';
  }

  return { latestVersion, downloadUrl };
}

/**
 * A browser cannot read the download servers itself: they send no CORS headers. The Hub reads the
 * server this page was built for, and the URL it returns still has to pass this page's trust check.
 */
async function resolveInstallerFromHub(
  platform: DesktopPlatform | null,
  osArch: string,
): Promise<{ latestVersion: string; downloadUrl: string } | null> {
  // A phone or tablet cannot install the desktop app, and its user agent passes for macOS (iOS)
  // or Linux (Android), so it gets no installer and the Hub is not asked.
  if (isMobileUserAgent()) return null;

  const { getDesktopRelease } = await import('@/api-client/sdk.gen');
  const { unwrapSdkOrNull } = await import('@/lib/sdk-unwrap');
  // The Hub sends null for what it could not find; the generated type loses that because the spec
  // marks it with OpenAPI 3.0's `nullable`.
  const release: { latestVersion: string | null; downloadUrl: string | null } | null = await unwrapSdkOrNull(
    getDesktopRelease({
      query: {
        environment: import.meta.env.CI_HUB_ENVIRONMENT,
        platform: platform ?? undefined,
        arch: osArch === 'aarch64' ? 'aarch64' : 'x86_64',
      },
    }),
  );
  const latestVersion = release?.latestVersion?.replace(/^v/, '') ?? '';
  if (!semver.valid(latestVersion)) return null;

  const downloadUrl = release?.downloadUrl ?? '';
  return { latestVersion, downloadUrl: isTrustedDownloadUrl(downloadUrl) ? downloadUrl : '' };
}

export async function checkForUpdates(fallbackCurrentVersion?: string): Promise<UpdateInfo | null> {
  const currentVersion = (fallbackCurrentVersion ?? (await getCurrentVersion()) ?? '').replace(/^v/, '');
  const desktopPlatform = await getDesktopPlatform();
  const osArch = await getDesktopArch();

  try {
    if (isTauri()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        // Desktop update metadata is fetched natively because the production CDN does not
        // expose CORS headers for renderer-side fetches from the Tauri webview.
        const nativeInfo = await invoke<NativeDesktopUpdateInfo>('check_desktop_update_command');
        const nativeCurrentVersion = nativeInfo.currentVersion.replace(/^v/, '');
        const latestVersion = nativeInfo.latestVersion.replace(/^v/, '');
        if (!semver.valid(latestVersion)) {
          return null;
        }

        let downloadUrl = nativeInfo.downloadUrl ?? '';
        if (downloadUrl && !isTrustedDownloadUrl(downloadUrl)) {
          downloadUrl = '';
        }
        if (!downloadUrl) {
          try {
            const resolved = await resolveInstallerFromCdn(desktopPlatform, osArch);
            if (resolved?.downloadUrl) {
              downloadUrl = resolved.downloadUrl;
            }
          } catch {
            // CDN is best-effort when the native check omitted a URL.
          }
        }

        const resolvedCurrent = semver.valid(nativeCurrentVersion) ? nativeCurrentVersion : currentVersion;
        return {
          currentVersion: resolvedCurrent || latestVersion,
          latestVersion,
          downloadUrl,
          updateAvailable: Boolean(resolvedCurrent && semver.valid(resolvedCurrent) && semver.gt(latestVersion, resolvedCurrent)),
          platform: desktopPlatform,
          manualDownload: true,
        };
      } catch {
        // Fall back to the fetch path for tests and nonstandard dev environments.
      }
    }

    // Only a plain browser asks the Hub. The desktop and phone apps land here when their native check
    // fails and keep their direct read, so the phone app does not start offering desktop installers.
    const resolved = isTauri() ? await resolveInstallerFromCdn(desktopPlatform, osArch) : await resolveInstallerFromHub(desktopPlatform, osArch);
    if (!resolved) return null;

    const updateAvailable = Boolean(currentVersion && semver.valid(currentVersion) && semver.gt(resolved.latestVersion, currentVersion));
    return {
      currentVersion: currentVersion || resolved.latestVersion,
      latestVersion: resolved.latestVersion,
      downloadUrl: resolved.downloadUrl,
      updateAvailable,
      platform: desktopPlatform,
      manualDownload: true,
    };
  } catch {
    return null;
  }
}

export function isStackUpdateAvailable(current: string, latest: string): boolean {
  if (!semver.valid(current) || !semver.valid(latest)) return false;
  return semver.gt(latest, current);
}

/** Whether Settings should show an Update button (desktop manifest vs stack registry). */
export function isHubUpdateAvailable(desktop: boolean, desktopUpdate: UpdateInfo | null, currentVersion: string, latestVersion: string): boolean {
  if (desktop) {
    return !!desktopUpdate?.updateAvailable;
  }
  return isStackUpdateAvailable(currentVersion, latestVersion);
}

export function dismissVersion(version: string): void {
  localStorage.setItem(DISMISSED_KEY, version);
}

export function isVersionDismissed(version: string): boolean {
  return localStorage.getItem(DISMISSED_KEY) === version;
}

export function markToastShown(version: string): void {
  localStorage.setItem(TOAST_SHOWN_KEY, version);
}

export function wasToastShown(version: string): boolean {
  return localStorage.getItem(TOAST_SHOWN_KEY) === version;
}

export function getPollIntervalMs(): number {
  return POLL_INTERVAL_MS;
}

export interface UpdateActionResult {
  ok: boolean;
  messageKey: string;
  messageParams?: Record<string, string>;
  defaultMessage?: string;
  stack?: 'updating' | 'skipped' | 'failed';
  host?: 'started' | 'unavailable' | 'failed';
}

export async function fetchHostListenerStatus(): Promise<boolean | null> {
  try {
    const { getHostListenerStatus } = await import('@/api-client/sdk.gen');
    const { sdkResult } = await import('@/lib/sdk-unwrap');
    const result = await sdkResult(getHostListenerStatus());
    if (!result.ok) return null;
    return Boolean((result.data as { reachable?: boolean } | null)?.reachable);
  } catch {
    return null;
  }
}

export async function performUpdate(info: UpdateInfo): Promise<UpdateActionResult> {
  if (!info.downloadUrl || !isTrustedDownloadUrl(info.downloadUrl)) {
    return { ok: false, messageKey: 'SETTINGS_ACTIONS_UPDATE_NO_DOWNLOAD_URL' };
  }

  try {
    await openExternal(info.downloadUrl);
    return {
      ok: true,
      messageKey: 'SETTINGS_ACTIONS_DOWNLOAD_INSTALLER_OPENED',
      defaultMessage: 'Installer download opened in your browser.',
    };
  } catch {
    return {
      ok: false,
      messageKey: 'SETTINGS_ACTIONS_DOWNLOAD_INSTALLER_FAILED',
      defaultMessage: 'Could not open the installer download.',
    };
  }
}

/** Hub-driven update: stack pull, and host listener when the desktop app is running. */
export async function performStackUpdate(targetVersion?: string): Promise<UpdateActionResult> {
  try {
    const { performUpdate } = await import('@/api-client/sdk.gen');
    const { sdkResult } = await import('@/lib/sdk-unwrap');
    const result = await sdkResult(performUpdate({ body: { targetVersion } } as Parameters<typeof performUpdate>[0]));
    if (result.ok) {
      const data = (result.data ?? {}) as { stack?: UpdateActionResult['stack']; host?: UpdateActionResult['host'] };
      const host = data.host;
      const stack = data.stack;
      let messageKey = 'SETTINGS_ACTIONS_UPDATE_RESTARTING';
      if (host === 'started') {
        messageKey = 'SETTINGS_ACTIONS_UPDATE_HOST_STARTED';
      } else if (host === 'unavailable' || host === 'failed') {
        messageKey = 'SETTINGS_ACTIONS_UPDATE_STACK_HOST_UNAVAILABLE';
      }
      return { ok: true, messageKey, stack, host };
    }
    return { ok: false, messageKey: 'SETTINGS_ACTIONS_UPDATE_FAILED' };
  } catch {
    return { ok: false, messageKey: 'SETTINGS_ACTIONS_UPDATE_REQUEST_FAILED' };
  }
}
