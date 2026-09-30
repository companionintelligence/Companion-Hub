/**
 * Desktop app releases on the download servers. The Hub looks them up for a browser, and the
 * frontend checks what it gets back, so both use these rules for the server, the installer, and
 * the URLs they accept.
 */

/** Only a `production` build reads the production download server; every other build reads the dev one. */
export function desktopReleaseCdn(environment: string | undefined): { base: string; host: string } {
  const isProduction = environment === 'production';
  return {
    base: isProduction ? 'https://dl.ci.computer' : 'https://dl-dev.ci.computer',
    host: isProduction ? 'dl.ci.computer' : 'dl-dev.ci.computer',
  };
}

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

/** Whether `url` is an HTTPS download from `host` with no `..` in its path. */
export function isTrustedDownloadUrlForHost(url: string, host: string): boolean {
  try {
    if (pathHasParentTraversal(url)) return false;
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === host;
  } catch {
    return false;
  }
}

interface PlatformArtifact {
  url: string;
  size: number;
}

/** `v<version>/manifest.json` on a download server. */
export interface DesktopReleaseManifest {
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

/** Manifest platform key — must stay aligned with desktop-release.yml and updater.rs. */
export function platformManifestKey(platform: string, osArch: string): string | null {
  const archSuffix = osArch === 'aarch64' ? 'aarch64' : 'x86_64';
  if (platform === 'macos') return `darwin-${archSuffix}`;
  if (platform === 'windows') return `windows-${archSuffix}`;
  if (platform === 'linux') return `linux-${archSuffix}`;
  return null;
}

function artifactUrlForPlatform(platform: string, artifacts: DesktopReleaseManifest['platforms'][string]): string | null {
  if (platform === 'macos') return artifacts.dmg?.url ?? null;
  if (platform === 'windows') return artifacts.exe?.url ?? artifacts.msi?.url ?? null;
  if (platform === 'linux') {
    return artifacts.appimage?.url ?? artifacts.deb?.url ?? artifacts.rpm?.url ?? null;
  }
  return null;
}

/** The installer this release lists for the platform and architecture, or null when it lists none. */
export function desktopInstallerUrl(manifest: DesktopReleaseManifest, platform: string, osArch: string): string | null {
  const platformKey = platformManifestKey(platform, osArch);
  if (!platformKey) return null;

  const p = manifest.platforms[platformKey];
  if (!p) return null;

  return artifactUrlForPlatform(platform, p);
}
