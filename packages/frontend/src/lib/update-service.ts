import semver from 'semver';
import { openExternal } from '@/lib/helpers/open-external';

const UPDATE_CHECK_URL = 'https://dl.ci.computer/latest.json';
const MANIFEST_URL = (version: string) => `https://dl.ci.computer/v${version.replace(/^v/, '')}/manifest.json`;
const POLL_INTERVAL_MS = 4 * 60 * 60 * 1000;
const DISMISSED_KEY = 'ci-hub-update-dismissed-version';
const TOAST_SHOWN_KEY = 'ci-hub-update-toast-shown';
const ALLOWED_DOWNLOAD_HOST = 'dl.ci.computer';
const HOST_UPDATE_URL = 'http://127.0.0.1:17400/update';

function decodePathSegment(segment: string): string | null {
  try {
    let decoded = segment;
    for (let i = 0; i < 3; i++) {
      const next = decodeURIComponent(decoded.replace(/\+/g, ' '));
      if (next === decoded) break;
      decoded = next;
    }
    return decoded;
  } catch {
    return null;
  }
}

/** Inspect raw path segments before URL normalization (which resolves %2e%2e → ..). */
function pathHasParentTraversal(url: string): boolean {
  const match = url.match(/^https?:\/\/[^/?#]+(\/[^?#]*)?/i);
  if (!match?.[1]) return false;

  return match[1]
    .split('/')
    .filter(Boolean)
    .some((segment) => {
      const decoded = decodePathSegment(segment);
      if (decoded === null) return true;
      return decoded.split('/').some((part) => part === '..');
    });
}

export function isTrustedDownloadUrl(url: string): boolean {
  try {
    if (pathHasParentTraversal(url)) return false;
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === ALLOWED_DOWNLOAD_HOST;
  } catch {
    return false;
  }
}

interface LatestJson {
  version: string;
}

interface PlatformArtifact {
  url: string;
  size: number;
}

interface ManifestJson {
  version: string;
  platforms: Record<
    string,
    {
      dmg?: PlatformArtifact;
      msi?: PlatformArtifact;
      exe?: PlatformArtifact;
      deb?: PlatformArtifact;
      rpm?: PlatformArtifact;
      appimage?: PlatformArtifact;
    }
  >;
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

/** Manifest platform key — must stay aligned with desktop-release.yml and updater.rs. */
export function platformManifestKey(platform: string, osArch: string): string | null {
  const archSuffix = osArch === 'aarch64' ? 'aarch64' : 'x86_64';
  if (platform === 'macos') return `darwin-${archSuffix}`;
  if (platform === 'windows') return `windows-${archSuffix}`;
  if (platform === 'linux') return `linux-${archSuffix}`;
  return null;
}

function artifactUrlForPlatform(platform: string, artifacts: ManifestJson['platforms'][string]): string | null {
  if (platform === 'macos') return artifacts.dmg?.url ?? null;
  if (platform === 'windows') return artifacts.exe?.url ?? artifacts.msi?.url ?? null;
  if (platform === 'linux') {
    return artifacts.appimage?.url ?? artifacts.deb?.url ?? artifacts.rpm?.url ?? null;
  }
  return null;
}

function getDownloadUrl(manifest: ManifestJson, platform: string, osArch: string): string | null {
  const platformKey = platformManifestKey(platform, osArch);
  if (!platformKey) return null;

  const p = manifest.platforms[platformKey];
  if (!p) return null;

  return artifactUrlForPlatform(platform, p);
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

export async function getDesktopPlatform(): Promise<DesktopPlatform | null> {
  if (!isTauri()) return null;

  try {
    const { platform } = await import('@tauri-apps/plugin-os');
    const value = await platform();
    if (value === 'linux' || value === 'macos' || value === 'windows') {
      return value;
    }
  } catch {
    return null;
  }

  return null;
}

export function requiresManualDesktopUpdate(platform: DesktopPlatform | null): boolean {
  return platform === 'linux';
}

export async function checkForUpdates(fallbackCurrentVersion?: string): Promise<UpdateInfo | null> {
  const currentVersion = fallbackCurrentVersion ?? (await getCurrentVersion()) ?? null;
  if (!currentVersion || !semver.valid(currentVersion)) return null;

  try {
    const desktopPlatform = await getDesktopPlatform();
    if (isTauri()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        // Desktop update metadata is fetched natively because the production CDN does not
        // expose CORS headers for renderer-side fetches from the Tauri webview.
        const nativeInfo = await invoke<NativeDesktopUpdateInfo>('check_desktop_update_command');
        const nativeCurrentVersion = nativeInfo.currentVersion.replace(/^v/, '');
        const latestVersion = nativeInfo.latestVersion.replace(/^v/, '');
        if (!semver.valid(nativeCurrentVersion) || !semver.valid(latestVersion)) {
          return null;
        }

        let downloadUrl = nativeInfo.downloadUrl ?? '';
        if (downloadUrl && !isTrustedDownloadUrl(downloadUrl)) {
          downloadUrl = '';
        }

        return {
          currentVersion: nativeCurrentVersion,
          latestVersion,
          downloadUrl,
          updateAvailable: nativeInfo.updateAvailable,
          platform: desktopPlatform,
          manualDownload: requiresManualDesktopUpdate(desktopPlatform),
        };
      } catch {
        // Fall back to the fetch path for tests and nonstandard dev environments.
      }
    }

    const latestRes = await fetch(UPDATE_CHECK_URL, { cache: 'no-store' });
    if (!latestRes.ok) return null;

    const latest = (await latestRes.json()) as LatestJson;
    const latestVersion = latest.version.replace(/^v/, '');

    if (!semver.valid(latestVersion) || !semver.valid(currentVersion)) {
      return null;
    }

    const updateAvailable = semver.gt(latestVersion, currentVersion);
    if (!updateAvailable) {
      return {
        currentVersion,
        latestVersion,
        downloadUrl: '',
        updateAvailable: false,
        platform: desktopPlatform,
        manualDownload: requiresManualDesktopUpdate(desktopPlatform),
      };
    }

    const manifestRes = await fetch(MANIFEST_URL(latestVersion), { cache: 'no-store' });
    if (!manifestRes.ok) return null;

    const manifest = (await manifestRes.json()) as ManifestJson;

    let downloadUrl = '';
    if (desktopPlatform) {
      const { platform, arch } = await import('@tauri-apps/plugin-os');
      const [osPlatform, osArch] = await Promise.all([platform(), arch()]);
      downloadUrl = getDownloadUrl(manifest, osPlatform, osArch) ?? '';
    }

    if (downloadUrl && !isTrustedDownloadUrl(downloadUrl)) {
      downloadUrl = '';
    }

    return {
      currentVersion,
      latestVersion,
      downloadUrl,
      updateAvailable: true,
      platform: desktopPlatform,
      manualDownload: requiresManualDesktopUpdate(desktopPlatform),
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
}

export async function performUpdate(info: UpdateInfo): Promise<UpdateActionResult> {
  if (isTauri()) {
    try {
      if (info.manualDownload) {
        if (!info.downloadUrl || !isTrustedDownloadUrl(info.downloadUrl)) {
          return { ok: false, messageKey: 'SETTINGS_ACTIONS_UPDATE_NO_DOWNLOAD_URL' };
        }

        await openExternal(info.downloadUrl);
        return {
          ok: true,
          messageKey: 'SETTINGS_ACTIONS_DOWNLOAD_INSTALLER_OPENED',
          defaultMessage: 'Installer download opened in your browser.',
        };
      }

      const { invoke } = await import('@tauri-apps/api/core');
      if (info.downloadUrl) {
        await invoke('perform_desktop_update_command', { downloadUrl: info.downloadUrl });
        return { ok: true, messageKey: 'SETTINGS_ACTIONS_UPDATE_DESKTOP_STARTED' };
      }
      const desktopInfo = (await invoke('check_desktop_update_command')) as UpdateInfo & {
        downloadUrl?: string;
      };
      const url = desktopInfo.downloadUrl ?? info.downloadUrl;
      if (url) {
        await invoke('perform_desktop_update_command', { downloadUrl: url });
        return { ok: true, messageKey: 'SETTINGS_ACTIONS_UPDATE_DESKTOP_STARTED' };
      }
      return { ok: false, messageKey: 'SETTINGS_ACTIONS_UPDATE_NO_DOWNLOAD_URL' };
    } catch {
      return {
        ok: false,
        messageKey: info.manualDownload ? 'SETTINGS_ACTIONS_DOWNLOAD_INSTALLER_FAILED' : 'SETTINGS_ACTIONS_UPDATE_FAILED',
        defaultMessage: info.manualDownload ? 'Could not open the installer download.' : undefined,
      };
    }
  }

  try {
    const { apiFetch } = await import('@/lib/api-fetch');
    const tokenRes = await apiFetch('/api/system/update/host-listener-token', { credentials: 'include' });
    if (!tokenRes.ok) {
      return { ok: false, messageKey: 'SETTINGS_ACTIONS_UPDATE_HOST_UNAVAILABLE' };
    }
    const { token } = (await tokenRes.json()) as { token?: string };
    if (!token) {
      return { ok: false, messageKey: 'SETTINGS_ACTIONS_UPDATE_HOST_UNAVAILABLE' };
    }

    const res = await fetch(HOST_UPDATE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      return { ok: true, messageKey: 'SETTINGS_ACTIONS_UPDATE_HOST_STARTED' };
    }
    return { ok: false, messageKey: 'SETTINGS_ACTIONS_UPDATE_HOST_UNAVAILABLE' };
  } catch {
    return { ok: false, messageKey: 'SETTINGS_ACTIONS_UPDATE_HOST_UNREACHABLE' };
  }
}

/** Stack-only update via backend API (browser / in-container fallback). */
export async function performStackUpdate(targetVersion?: string): Promise<UpdateActionResult> {
  try {
    const { apiFetch } = await import('@/lib/api-fetch');
    const res = await apiFetch('/api/system/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ targetVersion }),
    });
    if (res.ok) {
      return { ok: true, messageKey: 'SETTINGS_ACTIONS_UPDATE_RESTARTING' };
    }
    return { ok: false, messageKey: 'SETTINGS_ACTIONS_UPDATE_FAILED' };
  } catch {
    return { ok: false, messageKey: 'SETTINGS_ACTIONS_UPDATE_REQUEST_FAILED' };
  }
}
