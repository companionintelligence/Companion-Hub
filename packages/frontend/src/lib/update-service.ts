import semver from 'semver';

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
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function getDownloadUrl(manifest: ManifestJson, platform: string, osArch: string): string | null {
  const platformKey = (() => {
    if (platform === 'macos') return osArch === 'aarch64' ? 'darwin-aarch64' : 'darwin-x86_64';
    if (platform === 'windows') return osArch === 'aarch64' ? 'windows-aarch64' : 'windows-x86_64';
    if (platform === 'linux') return osArch === 'aarch64' ? 'linux-aarch64' : 'linux-x86_64';
    return null;
  })();

  if (!platformKey) return null;

  const p = manifest.platforms[platformKey];
  if (!p) return null;

  if (platform === 'macos') return p.dmg?.url ?? null;
  if (platform === 'windows') return p.exe?.url ?? p.msi?.url ?? null;
  if (platform === 'linux') return p.deb?.url ?? p.rpm?.url ?? p.appimage?.url ?? null;

  return null;
}

async function getCurrentVersion(): Promise<string | null> {
  if (isTauri()) {
    try {
      const { getVersion } = await import('@tauri-apps/api/app');
      return getVersion();
    } catch {
      return null;
    }
  }
  return null;
}

export async function checkForUpdates(fallbackCurrentVersion?: string): Promise<UpdateInfo | null> {
  const currentVersion = (await getCurrentVersion()) ?? fallbackCurrentVersion ?? null;
  if (!currentVersion || !semver.valid(currentVersion)) return null;

  try {
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
      };
    }

    const manifestRes = await fetch(MANIFEST_URL(latestVersion), { cache: 'no-store' });
    if (!manifestRes.ok) return null;

    const manifest = (await manifestRes.json()) as ManifestJson;

    let downloadUrl = '';
    if (isTauri()) {
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

export async function performUpdate(info: UpdateInfo): Promise<{ ok: boolean; message: string }> {
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      if (info.downloadUrl) {
        await invoke('perform_desktop_update_command', { downloadUrl: info.downloadUrl });
        return { ok: true, message: 'Update started. Companion Hub will restart shortly.' };
      }
      const desktopInfo = (await invoke('check_desktop_update_command')) as UpdateInfo & {
        downloadUrl?: string;
      };
      const url = desktopInfo.downloadUrl ?? info.downloadUrl;
      if (url) {
        await invoke('perform_desktop_update_command', { downloadUrl: url });
        return { ok: true, message: 'Update started. Companion Hub will restart shortly.' };
      }
      return { ok: false, message: 'No download URL available for this platform.' };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'Update failed' };
    }
  }

  try {
    const { apiFetch } = await import('@/lib/api-fetch');
    const tokenRes = await apiFetch('/api/system/update/host-listener-token', { credentials: 'include' });
    if (!tokenRes.ok) {
      return {
        ok: false,
        message: 'Host update listener unavailable. Run: companion-hub update',
      };
    }
    const { token } = (await tokenRes.json()) as { token?: string };
    if (!token) {
      return {
        ok: false,
        message: 'Host update listener unavailable. Run: companion-hub update',
      };
    }

    const res = await fetch(HOST_UPDATE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.text();
    if (res.ok) {
      return { ok: true, message: 'Update started on the host. The Hub will restart shortly.' };
    }
    return { ok: false, message: body || 'Host update listener unavailable. Run: companion-hub update' };
  } catch {
    return {
      ok: false,
      message: 'Could not reach the host updater. Run companion-hub update in a terminal on this machine.',
    };
  }
}

/** Stack-only update via backend API (browser / in-container fallback). */
export async function performStackUpdate(targetVersion?: string): Promise<{ ok: boolean; message: string }> {
  try {
    const { apiFetch } = await import('@/lib/api-fetch');
    const res = await apiFetch('/api/system/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ targetVersion }),
    });
    if (res.ok) {
      return { ok: true, message: 'Stack update initiated. This page will reload shortly.' };
    }
    return { ok: false, message: 'Stack update failed. Check logs for details.' };
  } catch {
    return { ok: false, message: 'Stack update request failed.' };
  }
}
