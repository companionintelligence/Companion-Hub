import { useCallback, useEffect, useRef, useState } from 'react';
import semver from 'semver';

const UPDATE_CHECK_URL = 'https://dl.ci.computer/latest.json';
const MANIFEST_URL = (version: string) => `https://dl.ci.computer/v${version}/manifest.json`;
const POLL_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const DISMISSED_KEY = 'ci-hub-update-dismissed-version';

interface LatestJson {
  version: string;
}

interface PlatformArtifact {
  url: string;
  size: number;
}

interface ManifestJson {
  version: string;
  platforms: {
    [platform: string]: {
      dmg?: PlatformArtifact;
      msi?: PlatformArtifact;
      exe?: PlatformArtifact;
      deb?: PlatformArtifact;
      rpm?: PlatformArtifact;
      appimage?: PlatformArtifact;
    };
  };
}

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  downloadUrl: string;
}

export interface UseUpdateCheckerResult {
  update: UpdateInfo | null;
  dismiss: () => void;
}

function getDownloadUrl(manifest: ManifestJson, platform: string, osArch: string): string | null {
  // Map Tauri OS plugin values to manifest platform keys
  const platformKey = (() => {
    if (platform === 'macos') return osArch === 'aarch64' ? 'darwin-aarch64' : 'darwin-x86_64';
    if (platform === 'windows') return 'windows-x86_64';
    if (platform === 'linux') return osArch === 'aarch64' ? 'linux-aarch64' : 'linux-x86_64';
    return null;
  })();

  if (!platformKey) return null;

  const p = manifest.platforms[platformKey];
  if (!p) return null;

  // Prefer the most user-friendly format per platform
  if (platform === 'macos') return p.dmg?.url ?? null;
  if (platform === 'windows') return p.msi?.url ?? p.exe?.url ?? null;
  if (platform === 'linux') return p.appimage?.url ?? p.deb?.url ?? p.rpm?.url ?? null;

  return null;
}

export function useUpdateChecker(): UseUpdateCheckerResult {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const intervalRef = useRef<number | null>(null);

  const checkForUpdate = useCallback(async () => {
    if (!('__TAURI_INTERNALS__' in window)) return;

    try {
      const [{ getVersion }, { platform, arch }] = await Promise.all([import('@tauri-apps/api/app'), import('@tauri-apps/plugin-os')]);

      const [currentVersion, osPlatform, osArch] = await Promise.all([getVersion(), platform(), arch()]);

      const latestRes = await fetch(UPDATE_CHECK_URL, { cache: 'no-store' });
      if (!latestRes.ok) return;

      const latest = (await latestRes.json()) as LatestJson;
      // Strip leading "v" — semver.gt requires clean version strings
      const latestVersion = latest.version.replace(/^v/, '');

      if (!semver.valid(latestVersion) || !semver.gt(latestVersion, currentVersion)) return;

      // Already dismissed this specific version?
      const dismissed = localStorage.getItem(DISMISSED_KEY);
      if (dismissed === latestVersion) return;

      const manifestRes = await fetch(MANIFEST_URL(latestVersion), { cache: 'no-store' });
      if (!manifestRes.ok) return;

      const manifest = (await manifestRes.json()) as ManifestJson;
      const downloadUrl = getDownloadUrl(manifest, osPlatform, osArch);
      if (!downloadUrl) return;

      setUpdate({ currentVersion, latestVersion, downloadUrl });
    } catch {
      // Network errors during update check should never surface to the user
    }
  }, []);

  const dismiss = useCallback(() => {
    setUpdate((prev) => {
      if (prev) localStorage.setItem(DISMISSED_KEY, prev.latestVersion);
      return null;
    });
  }, []);

  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return;

    void checkForUpdate();

    intervalRef.current = window.setInterval(() => {
      void checkForUpdate();
    }, POLL_INTERVAL_MS);

    return () => {
      if (intervalRef.current !== null) {
        window.clearInterval(intervalRef.current);
      }
    };
  }, [checkForUpdate]);

  return { update, dismiss };
}
